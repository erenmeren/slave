import { ensureLeadSeats, goalEventWith, goalSpend, withDeliveryLock } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  LEAD_MIN_LEG_USD,
  afterConfirm,
  afterRound,
  err,
  parseSlaveVerification,
  proofCapUsd,
  readLeadProgress,
  renderVerificationRework,
  requirementItemsSchema,
  runCheckLeansOnSmoke,
  type LeadProgress,
  type ProofStep,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { writeSpawnExtras } from '@slave-of-ai/providers'
import { acceptInLock } from '../goal.js'
import { joinRunOutput } from '../runOutput.js'
import { failConcludedRun } from '../runs.js'
import { releaseClaim, removeVerificationWorktree, tamperedReason } from '../verification.js'
import { gitIn } from '../worktree.js'
import { noteLead, noteLeadOnce, progressJson } from './record.js'
import { stopLead, stopLeadInLock } from './stop.js'

/** What a lead-flow version's next proof run checks, who takes it and what it may spend. */
export type LeadProofScope =
  | { readonly kind: 'hold' }
  | { readonly kind: 'run'; readonly keys: readonly string[]; readonly confirmsRunId: string | null; readonly seatId: string | null; readonly capUsd: number | null }

/** The deliveries whose missing confirmer seat was already logged by this process. */
const seatlessSaid = new Set<string>()

/**
 * Lead-flow spec P3/P5 and B4 (plan A L6/L11): the next proof run of a lead-flow version. Failures
 * awaiting confirmation: the confirmer seat re-checks exactly those keys. Otherwise the verifier
 * checks `recheckKeys` (what failed before), or the whole set when that is empty. The run is capped
 * at whatever the goal has left, the reserve included; with nothing left no verification can be
 * paid, and the version stops saying the result is unproven (spec section 9).
 */
export async function leadProofScope(
  delivery: { readonly id: string; readonly workspaceId: string; readonly goalVersion: number; readonly leadProgress: unknown },
  budgetUsd: number | null,
): Promise<LeadProofScope> {
  const progress = readLeadProgress(delivery.leadProgress)
  const capUsd = proofCapUsd(budgetUsd, (await goalSpend(delivery.workspaceId, delivery.goalVersion)).totalUsd)
  if (capUsd === 'spent') {
    // Task 9 review: a failure awaiting its confirmation is the one verdict that stands -- named, so
    // the card does not read as though nothing was found.
    const pending = progress.confirm === null ? '' : `the first verifier failed ${progress.confirm.keys.join(', ')} and its confirmation could not be paid; `
    await stopLead(delivery.id, 'budget_spent', `${pending}nothing is left of the budget to pay a verification: the result is unproven`)
    return { kind: 'hold' }
  }
  if (progress.confirm !== null) {
    // Spec P3: the re-check is a SECOND independent session. Without the confirmer seat it is held,
    // never handed to the verifier that failed the keys (task 9 review); said once per version.
    const seats = await ensureLeadSeats(delivery.workspaceId)
    if (!seats.ok) {
      if (!seatlessSaid.has(delivery.id)) {
        seatlessSaid.add(delivery.id)
        console.error(`[lead] goal delivery ${delivery.id}: the confirmer seat could not be found or made (${seats.error.kind}); the confirmation waits`)
      }
      return { kind: 'hold' }
    }
    return { kind: 'run', keys: progress.confirm.keys, confirmsRunId: progress.confirm.runId, seatId: seats.value.confirmer, capUsd }
  }
  return { kind: 'run', keys: progress.recheckKeys, confirmsRunId: null, seatId: null, capUsd }
}

/** Thrown inside the lock when the run no longer holds the claim (a refusal in a transaction throws). */
class NotTheClaim extends Error {}

const firstLine = (text: string): string => (text.split('\n')[0] ?? '').slice(0, 200)

/**
 * Lead-flow spec P3-P5/P7 (plan A L11/L12): the conclusion of a `succeeded` verification run of a
 * lead-flow version. The reading is the existing gate's -- the tamper check, the verdict parsed for
 * exactly the keys the run was asked, the smoke-only RUN check refused, an unusable run released as
 * one run failure -- and the rows and `workspace.verified` are written as it writes them. What the
 * verdict MEANS is the lead flow's: `afterConfirm` for a confirmation run, `afterRound` otherwise,
 * carried out in the same locked write that releases the claim.
 */
export async function concludeLeadVerification(runId: string): Promise<void> {
  const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId }, include: { goalDelivery: { include: { workspace: true } } } })
  const delivery = run.goalDelivery
  if (delivery === null) return
  const workspace = delivery.workspace
  const set = await prisma.requirementSet.findUniqueOrThrow({ where: { workspaceId_goalVersion: { workspaceId: workspace.id, goalVersion: delivery.goalVersion } } })
  const requirements = requirementItemsSchema.parse(set.items)
  const allKeys = requirements.map((requirement) => requirement.key)
  const keys = run.verificationKeys.length === 0 ? allKeys : allKeys.filter((key) => run.verificationKeys.includes(key))
  const scope = keys.length < allKeys.length ? 'partial' : 'full'

  const tampered = await tamperedReason(run.worktreePath, run.verificationBaseline)
  const rows = await prisma.executionEvent.findMany({ where: { runId: run.id, type: 'run_output' }, orderBy: { seq: 'asc' }, select: { payload: true } })
  const read = tampered !== null ? err(tampered) : parseSlaveVerification(joinRunOutput(rows.map((row) => row.payload)), keys)
  const leaning = read.ok ? runCheckLeansOnSmoke(read.value) : null
  const parsed = leaning === null ? read : err(leaning)
  if (!parsed.ok) {
    if (await releaseClaim(delivery.id, run.id)) await failConcludedRun(run, workspace.id, `verification: ${parsed.error}`)
    await removeVerificationWorktree(workspace.repoPath, run.worktreePath)
    return
  }
  const items = parsed.value
  const tip = await gitIn(workspace.repoPath, 'rev-parse', delivery.integrationBranch)
  const textOf = new Map(requirements.map((requirement) => [requirement.key, requirement.text] as const))
  const outcome: { before: LeadProgress | null; step: ProofStep | null } = { before: null, step: null }

  try {
    await withDeliveryLock(delivery.id, async (tx) => {
      const now = await tx.goalDelivery.findUniqueOrThrow({ where: { id: delivery.id } })
      if (now.activeRunId !== run.id || now.status !== 'verifying') throw new NotTheClaim()
      await tx.verificationResult.createMany({
        data: items.map((item) => ({ workspaceId: workspace.id, goalDeliveryId: delivery.id, goalVersion: delivery.goalVersion, round: now.round, runId: run.id, key: item.key, status: item.status, check: item.check, output: item.output, reason: item.reason })),
        skipDuplicates: true,
      })
      if (!(await goalEventWith(tx, workspace.id, 'workspace_verified', { runId: run.id }))) {
        const failed = items.filter((item) => item.status === 'fail')
        await appendEvent({
          type: 'workspace.verified',
          workspaceId: workspace.id,
          runId: run.id,
          actor: 'system',
          payload: { version: delivery.goalVersion, round: now.round, runId: run.id, pass: items.filter((item) => item.status === 'pass').length, fail: failed.length, unverifiable: items.filter((item) => item.status === 'unverifiable').length, failedKeys: failed.map((item) => item.key).slice(0, 60) },
        })
      }

      const before = readLeadProgress(now.leadProgress)
      const step = run.confirmsRunId !== null ? afterConfirm({ items, progress: before }) : afterRound({ scope, items, progress: before, runId: run.id, tipMoved: run.verificationTip === null || run.verificationTip !== tip })
      outcome.before = before
      outcome.step = step
      const held = { id: delivery.id, status: 'verifying' as const, activeRunId: run.id }

      if (step.kind === 'accept') {
        await tx.goalDelivery.update({ where: { id: delivery.id }, data: { leadProgress: progressJson(step.progress), stopReason: 'proven' } })
        if (!(await acceptInLock(tx, delivery.id, { runId: run.id, verifiedCommit: tip }))) throw new NotTheClaim()
        return
      }
      if (step.kind === 'stop') {
        if (!(await stopLeadInLock(tx, delivery.id, step.reason, step.progress, null))) throw new NotTheClaim()
        return
      }
      if (step.kind === 'confirm') {
        // The same round goes on: the claim is given back with no run failure counted, and the next
        // goal pass dispatches the confirmer on the same commit.
        const moved = await tx.goalDelivery.updateMany({ where: held, data: { activeRunId: null, leadProgress: progressJson(step.progress) } })
        if (moved.count === 0) throw new NotTheClaim()
        return
      }
      if (step.kind === 'rework') {
        // Spec B8: the evidence is the FIRST verifier's -- its check, output and reason for each key
        // both sessions failed -- and it goes into the lead's own session as its next turn.
        const firstRunId = before.confirm?.runId ?? run.id
        const evidence = await tx.verificationResult.findMany({ where: { runId: firstRunId, key: { in: [...step.keys] } }, orderBy: { key: 'asc' } })
        const reason = renderVerificationRework(now.round, evidence.map((row) => ({ key: row.key, status: 'fail' as const, check: row.check, output: row.output, reason: row.reason, text: textOf.get(row.key) ?? '' })))
        const task = await tx.task.findFirst({ where: { workspaceId: workspace.id, workPackage: { goalVersion: delivery.goalVersion } }, select: { id: true, status: true, attempt: true } })
        if (task === null || task.status !== 'done') {
          if (!(await stopLeadInLock(tx, delivery.id, 'lead_failed', step.progress, "the lead's task cannot be sent back"))) throw new NotTheClaim()
          return
        }
        if (!(await goalEventWith(tx, workspace.id, 'task_rework', { verificationRound: now.round }, { taskId: task.id }))) {
          await appendEvent({ type: 'task.rework', workspaceId: workspace.id, taskId: task.id, actor: 'system', payload: { reason, attempt: task.attempt, verificationRound: now.round } })
        }
        const sent = await tx.task.updateMany({ where: { id: task.id, status: 'done' }, data: { status: 'rework', integratedAt: null, activeRunId: null, lastRejectionReason: reason } })
        if (sent.count === 0) {
          // The task left `done` since it was read: no rework is queued for a task that is not in rework.
          if (!(await stopLeadInLock(tx, delivery.id, 'lead_failed', step.progress, "the lead's task cannot be sent back"))) throw new NotTheClaim()
          return
        }
        const moved = await tx.goalDelivery.updateMany({ where: held, data: { status: 'integrating', activeRunId: null, leadProgress: progressJson({ ...step.progress, nextTurn: { kind: 'rework', note: reason } }) } })
        if (moved.count === 0) throw new NotTheClaim()
        return
      }
      // `verify_again`: back to `integrating`; the next pass verifies what the progress now says
      // (the whole set) on the current tip, in a new round.
      const moved = await tx.goalDelivery.updateMany({ where: held, data: { status: 'integrating', activeRunId: null, leadProgress: progressJson(step.progress) } })
      if (moved.count === 0) throw new NotTheClaim()
    })
  } catch (error) {
    if (!(error instanceof NotTheClaim)) throw error
    outcome.step = null
  }

  if (outcome.step !== null && outcome.before !== null) {
    const at = { workspaceId: workspace.id, version: delivery.goalVersion, runId: run.id }
    const before = outcome.before
    for (const key of outcome.step.progress.disputed.filter((one) => !before.disputed.includes(one))) {
      await noteLead({ ...at, kind: 'disputed', detail: `${key}: the first verifier said it fails and the second did not; it is not sent back to the lead` })
    }
    // A confirmer's `unverifiable` is a disagreement (disputed, above), not a key nobody could verify.
    for (const item of run.confirmsRunId === null ? items.filter((one) => one.status === 'unverifiable') : []) {
      await noteLeadOnce({ ...at, kind: 'unverifiable', detail: `${item.key} could not be verified: ${firstLine(item.reason)}` })
    }
  }
  await removeVerificationWorktree(workspace.repoPath, run.worktreePath)
}

/**
 * Task 9 review (plan A L6, M(b)): a paused verification run of a lead-flow version that is resumed
 * on its own row (`executeResume`) is capped again at what the goal has left NOW -- a
 * `--max-budget-usd` counts from zero in every process, so the cap it started with would let it
 * spend its earlier share twice. What it spent before the pause is counted while its row has no
 * cost (the pump writes `costUsd` only at the end): the checkpoint's `cumulativeCostUsd`, as
 * `refreshLeadSpawn` counts a paused lead turn. With nothing left it gets the smallest leg and ends
 * on its cap at once. Nothing for any other run: a run of a project not in the lead flow keeps
 * what it was spawned with.
 */
export async function refreshLeadProofSpawn(runId: string, runDir: string): Promise<void> {
  const run = await prisma.slaveRun.findUnique({
    where: { id: runId },
    select: { kind: true, costUsd: true, checkpoint: { select: { cumulativeCostUsd: true } }, goalDelivery: { select: { workspaceId: true, goalVersion: true, workspace: { select: { flow: true, budgetUsd: true } } } } },
  })
  const delivery = run?.goalDelivery
  if (run == null || run.kind !== 'verification' || delivery == null || delivery.workspace.flow !== 'lead') return
  const pausedSpentUsd = run.costUsd === null ? (run.checkpoint?.cumulativeCostUsd ?? 0) : 0
  const capUsd = proofCapUsd(delivery.workspace.budgetUsd, (await goalSpend(delivery.workspaceId, delivery.goalVersion)).totalUsd + pausedSpentUsd)
  writeSpawnExtras(runDir, capUsd === null ? {} : { maxBudgetUsd: capUsd === 'spent' ? LEAD_MIN_LEG_USD : capUsd })
}
