import { recordLeadDecisions } from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  LEAD_ASK_REPLIES_MAX,
  LEAD_DECISIONS_FILE,
  LEAD_DECISIONS_FILE_MAX_BYTES,
  LEAD_DENIAL_CONTINUES_MAX,
  isBudgetCapReason,
  parseLeadDecisions,
  parseSlaveAsk,
  readLeadProgress,
  sanitisePersonText,
  trimToFit,
  type RunId,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { integrationTargetFor } from '../goalBranch.js'
import { joinRunOutput } from '../runOutput.js'
import { releaseTaskAfterFailure, type TaskRelease } from '../taskRelease.js'
import { emailLocalPart, taskKeyFor } from '../tick.js'
import { commitUncommittedWork } from '../wipCommit.js'
import { gitIn } from '../worktree.js'
import { endLead, noteLead, noteLeadOnce, updateLeadProgress } from './record.js'
import { stopLead } from './stop.js'

const runInclude = { task: { include: { workspace: true } }, slave: { select: { id: true, person: { select: { name: true } } } } } as const
export type LeadRunRow = Prisma.SlaveRunGetPayload<{ include: typeof runInclude }>
export type LeadTaskRow = NonNullable<LeadRunRow['task']>

const firstLine = (text: string): string => (text.split('\n')[0] ?? '').slice(0, 300)

/**
 * C6: bounds the refused-calls list a continue note carries, so the note (and the instruction that
 * follows the list) fits a turn note whole; `progressJson` bounds the note again when it is stored.
 */
const DENIED_LIST_MAX_CHARS = 4_000

/** The newest `run.failed` reason a run recorded, or the empty string. */
async function failureReasonOf(runId: string): Promise<string> {
  const event = await prisma.executionEvent.findFirst({ where: { runId, type: 'run_failed' }, orderBy: { seq: 'desc' }, select: { payload: true } })
  const reason = (event?.payload as { readonly reason?: unknown } | undefined)?.reason
  return typeof reason === 'string' ? reason : ''
}

/**
 * C6: the calls the permission mode refused, as `Tool (id)`, when they are the whole of why the pump
 * failed the turn -- every id its `run.failed` reason names (`… tool call(s) were denied: a, b`) was
 * recorded as a `permission_mode` trip of this run (`<Tool> was denied by the permission mode
 * (<id>)`). Empty when the reason names no denial, or names one the mode did not refuse (a hook's
 * deny is not this).
 */
async function permissionDenialsOf(runId: string, reason: string): Promise<readonly string[]> {
  const named = (/tool call\(s\) were denied: (.+)$/u.exec(reason)?.[1] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')
  if (named.length === 0) return []
  const trips = await prisma.executionEvent.findMany({
    where: { runId, type: 'guardrail_tripped', payload: { path: ['guardrail'], equals: 'permission_mode' } },
    select: { payload: true },
  })
  const toolOf = new Map<string, string>()
  for (const trip of trips) {
    const detail = (trip.payload as { readonly detail?: unknown }).detail
    const match = typeof detail === 'string' ? /^(\S+) was denied by the permission mode \((.+)\)$/u.exec(detail) : null
    if (match?.[1] !== undefined && match[2] !== undefined) toolOf.set(match[2], match[1])
  }
  return named.every((id) => toolOf.has(id)) ? named.map((id) => `${toolOf.get(id) ?? ''} (${id})`) : []
}

/** Everything a run said, as the log holds it. */
async function finalTextOf(runId: string): Promise<string> {
  const rows = await prisma.executionEvent.findMany({ where: { runId, type: 'run_output' }, orderBy: { seq: 'asc' }, select: { payload: true } })
  return joinRunOutput(rows.map((row) => row.payload))
}

/**
 * Lead-flow spec B1/B6/B8 (plan A L4/L5/L10): what a concluded lead turn means for its task. Never
 * `advance`: no workspace verify command, no ownership audit, no report block, no review.
 *
 * A succeeded turn that ended with a question is answered at once (twice at most per version);
 * otherwise its work is integrated ({@link settleLeadWork}) and the goal pass proves it. A failed
 * turn is read by WHY it failed -- the table in plan A Task 7 -- and the next turn continues the
 * same session unless the transcript is gone. Replay-safe: only the run holding the task's claim
 * concludes anything.
 */
export async function concludeLeadTurn(runId: RunId): Promise<void> {
  const run = await prisma.slaveRun.findUnique({ where: { id: runId }, include: runInclude })
  if (run === null || run.task === null || run.leadTurn === null) return
  const task = run.task
  if (task.activeRunId !== run.id) return
  if (run.status !== 'succeeded' && run.status !== 'failed') return
  const target = await integrationTargetFor(task.id)
  if (target === null) {
    // No goal version behind the task (a state the lead flow does not make): a failed turn is
    // released as any failed implementation run is, and a succeeded one is left to `settleLeadWork`,
    // which says so.
    if (run.status === 'failed') await releaseLeadTurn(task, run.id, { platform: run.failureClass === 'platform', deliveryId: null, detail: null })
    else await settleLeadWork(run, task)
    return
  }
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: target.deliveryId } })
  const progress = readLeadProgress(delivery.leadProgress)
  const at = { workspaceId: task.workspaceId, version: delivery.goalVersion, runId: run.id }

  if (run.status === 'failed') {
    const reason = await failureReasonOf(run.id)
    // The goal's own limit ended the lead and cancelled this turn: what is committed is judged.
    if (progress.leadEnded !== null) {
      await settleLeadWork(run, task)
      return
    }
    if (isBudgetCapReason(reason)) {
      if (progress.wrapUpSent) {
        await endLead(delivery.id, 'budget_spent', "the lead's share of the budget is spent")
        await settleLeadWork(run, task)
        return
      }
      // Spec B4: the four-fifths leg ended on its cap. Not a failure; the next turn is the wrap-up.
      await updateLeadProgress(delivery.id, (p) => ({ ...p, nextTurn: { kind: 'wrap_up', note: p.nextTurn?.note ?? '' } }))
      await releaseTaskAfterFailure(task, run.id, 'rework', { platform: true })
      return
    }
    // Spec B6: a resume that was spawned and never reached its session line has no transcript to
    // continue. Nothing is charged; `planLeadTurn` reads the same fact and starts a new session.
    if (run.leadResumed && run.sessionId === null && run.pid !== null) {
      await releaseTaskAfterFailure(task, run.id, 'rework', { platform: true })
      return
    }
    // C6: the turn failed only because the permission mode refused calls -- the work it did stands.
    // The lead goes on in the same session, told what was refused; no attempt, at most
    // `LEAD_DENIAL_CONTINUES_MAX` times per version. Past that it is charged below like any failure.
    // A `platform` failure (a provider refusal) is the platform's row below, whatever else it had
    // (task 7 review): it spends no continue and is waited out.
    const refused = run.failureClass === 'platform' ? [] : await permissionDenialsOf(run.id, reason)
    if (refused.length > 0 && progress.denialContinues < LEAD_DENIAL_CONTINUES_MAX) {
      // Task 7 review: the claim goes back first, uncharged and guarded -- a replay that lost it
      // writes nothing -- as the ask path does.
      const released = await prisma.task.updateMany({ where: { id: task.id, activeRunId: run.id }, data: { status: 'rework', activeRunId: null } })
      if (released.count === 0) return
      // The names came off the stream: defused before they reach the next prompt (task 7 review).
      const named = trimToFit(sanitisePersonText(refused.join(', ')), DENIED_LIST_MAX_CHARS)
      await updateLeadProgress(delivery.id, (p) => ({
        ...p,
        denialContinues: p.denialContinues + 1,
        nextTurn: { kind: 'continue', note: `The permission mode refused these calls in your last turn: ${named}. They will be refused again: do that work another way, and carry on with the goal.` },
      }))
      await noteLead({ ...at, kind: 'denied', detail: `the permission mode refused ${String(refused.length)} call(s) (${named}); the lead continues in the same session, told what was refused` })
      return
    }
    // Any other failure (an error result, a stall, a crash, a provider refusal): charged unless
    // `platform`; at the attempt cap the version stops `lead_failed`.
    await releaseLeadTurn(task, run.id, { platform: run.failureClass === 'platform', deliveryId: delivery.id, detail: reason === '' ? null : firstLine(reason) })
    if (run.providerError) {
      // Spec B7: a line for the report, not a card. The scheduler holds the task for the backoff.
      await noteLead({ ...at, kind: 'limit_wait', detail: `the provider refused the turn (${firstLine(reason)}); the goal waits and continues in the same session` })
    }
    return
  }

  // Spec R-6 (plan A L10): the lead asked a question although none is offered. Answered at once --
  // unless the lead was ended meanwhile (task 7 review): it gets no further turn, so what it
  // committed is settled and proved, and no reply is spent.
  if (progress.leadEnded === null && progress.askReplies < LEAD_ASK_REPLIES_MAX && parseSlaveAsk(await finalTextOf(run.id)).kind !== 'absent') {
    const released = await prisma.task.updateMany({ where: { id: task.id, activeRunId: run.id }, data: { status: 'rework', activeRunId: null } })
    if (released.count === 0) return
    await updateLeadProgress(delivery.id, (p) => ({ ...p, askReplies: p.askReplies + 1, nextTurn: { kind: 'answer', note: '' } }))
    await noteLead({ ...at, kind: 'ask_refused', detail: 'the lead asked a question; nobody answers in this flow, so it was told to decide it and record the decision' })
    return
  }
  await settleLeadWork(run, task)
}

/**
 * A lead turn that came to nothing goes back to `rework`, charged unless `platform`; at the attempt
 * cap the task is `failed` and said so (with `detail`, why the last turn failed). With `deliveryId`,
 * an exhausted task also stops the version `lead_failed`: a failed turn and a settle that could not
 * integrate both end the lead at its attempt cap.
 */
async function releaseLeadTurn(task: LeadTaskRow, runId: string, options: { readonly platform: boolean; readonly deliveryId: string | null; readonly detail: string | null }): Promise<TaskRelease> {
  const release = await releaseTaskAfterFailure(task, runId, 'rework', { platform: options.platform })
  if (!release.exhausted) return release
  const why = options.detail === null || options.detail === '' ? '' : `: ${options.detail}`
  await appendEvent({ type: 'task.failed', workspaceId: task.workspaceId, taskId: task.id, actor: 'system', payload: { reason: `the lead's turn failed after ${String(release.attempt)} attempt(s)${why}` } })
  if (options.deliveryId !== null) await stopLead(options.deliveryId, 'lead_failed', options.detail)
  return release
}

/** What {@link followLeadBranch} did with the work branch. */
type Followed =
  | { readonly kind: 'moved' | 'rewritten' | 'lost' }
  /** `update-ref` failed while the ref stayed where it was (a stale lock, a full disk): git's reason. */
  | { readonly kind: 'stuck'; readonly error: string }

/** The first line of what a failed git call said: its stderr, else the error's own message. */
function gitError(error: unknown): string {
  const stderr = typeof error === 'object' && error !== null ? (error as { readonly stderr?: unknown }).stderr : undefined
  const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : error instanceof Error ? error.message : String(error)
  return text.trim().split('\n')[0] ?? ''
}

/**
 * Task 6 review: moves the goal's work branch to the lead's tip, never throwing. The work branch is
 * the lead's own and the final full verification proves whatever tip is delivered, so a lead tip
 * that does not contain the work branch's tip (the lead amended, rebased or reset commits already
 * integrated) is followed too, and said (`rewritten`). The move is a compare-and-swap on the ref.
 * One that lost because the ref MOVED is retried once on the re-read tip, then given up (`lost`).
 * One that failed while the ref stayed put will fail the same way next time (`stuck`): the caller
 * charges it, so the task's attempt cap bounds it.
 */
async function followLeadBranch(repoPath: string, branch: string, tip: string, workTip: string): Promise<Followed> {
  let expected = workTip
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (expected === tip) return { kind: 'moved' }
    // Exit 1 is "not an ancestor"; any other failure reads the same way: the move is said.
    const contains = await gitIn(repoPath, 'merge-base', '--is-ancestor', expected, tip).then(
      () => true,
      () => false,
    )
    const failed = await gitIn(repoPath, 'update-ref', `refs/heads/${branch}`, tip, expected).then(
      () => null,
      (error: unknown) => gitError(error),
    )
    if (failed === null) return { kind: contains ? 'moved' : 'rewritten' }
    const reread = await gitIn(repoPath, 'rev-parse', `refs/heads/${branch}`).catch(() => null)
    if (reread === null || reread === expected) return { kind: 'stuck', error: failed }
    expected = reread
  }
  return { kind: 'lost' }
}

/**
 * Integrates what the lead committed and hands the version to proof: leftover work is committed
 * under the lead's identity, the goal's work branch is moved to the lead's branch tip
 * ({@link followLeadBranch}: a compare-and-swap; a lead that rewrote integrated commits is followed
 * and said), and the task is `done` and integrated -- which is what the goal pass waits for. Both
 * branches still at the commit the goal was cut at is "nothing was built": the version stops and no
 * proof starts. Never throws on what git says about the two branches: a throw here would leave the
 * task holding a finished run's claim, to be sent back and fail the same way, turn after turn.
 */
export async function settleLeadWork(run: LeadRunRow, task: LeadTaskRow): Promise<'settled' | 'nothing_built' | 'unreadable'> {
  const target = await integrationTargetFor(task.id)
  if (target === null || run.worktreePath === null || task.branch === null) {
    console.warn(`[lead] run ${run.id} has no ${target === null ? 'goal version' : run.worktreePath === null ? 'worktree' : 'branch'} recorded: not settling`)
    return 'unreadable'
  }
  const repoPath = task.workspace.repoPath
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: target.deliveryId } })

  const wip = await commitUncommittedWork({
    worktreePath: run.worktreePath,
    branch: task.branch,
    taskKey: taskKeyFor(task.id),
    identity: { name: run.slave.person.name, email: `${emailLocalPart({ id: run.slave.id, name: run.slave.person.name })}@slaveofai.local` },
  })
  if (wip.kind === 'committed') console.warn(`[lead] run ${run.id} left uncommitted work; committed it for the lead as ${wip.sha.slice(0, 12)}`)
  if (wip.kind === 'skipped' || wip.kind === 'failed') console.warn(`[lead] run ${run.id} left uncommitted work that could not be committed (${wip.kind}): ${wip.reason}`)

  const tip = await gitIn(repoPath, 'rev-parse', `refs/heads/${task.branch}`)
  const workTip = await gitIn(repoPath, 'rev-parse', `refs/heads/${target.branch}`)
  // Nothing built: the lead's branch AND the work branch are still at the cut. A later turn that
  // reset its branch to the cut while earlier work is on the work branch rewrote its branch instead.
  if (tip === delivery.baseCommit && workTip === delivery.baseCommit) {
    // Spec section 9: the claim goes back first, so nothing holds the task while the version waits.
    await prisma.task.updateMany({ where: { id: task.id, activeRunId: run.id }, data: { status: 'rework', activeRunId: null } })
    await stopLead(delivery.id, 'nothing_built', null)
    return 'nothing_built'
  }
  if (tip !== workTip) {
    const followed = await followLeadBranch(repoPath, target.branch, tip, workTip)
    if (followed.kind === 'stuck') {
      // The ref is where it was and git cannot move it: this turn is charged like a failed one, so
      // the attempt cap ends a fault that would otherwise cost a paid turn forever.
      console.warn(`[lead] run ${run.id}: the work branch ${target.branch} could not be moved to ${tip.slice(0, 12)}: ${followed.error}`)
      await noteLead({
        workspaceId: task.workspaceId,
        version: target.goalVersion,
        kind: 'turn',
        detail: `the work branch could not be moved to the lead's tip ${tip.slice(0, 12)} (${target.branch}): ${followed.error}`,
        runId: run.id,
      })
      await releaseLeadTurn(task, run.id, { platform: false, deliveryId: delivery.id, detail: `the work branch could not be moved: ${followed.error}` })
      return 'unreadable'
    }
    if (followed.kind === 'lost') {
      // The work branch kept moving under two compare-and-swaps: nothing is integrated, and the
      // turn is not the lead's fault -- the claim goes back with no attempt charged, as for a
      // platform failure, and the next turn settles again.
      console.warn(`[lead] run ${run.id}: the work branch ${target.branch} moved twice while it was being set to ${tip.slice(0, 12)}; released for another turn`)
      await releaseTaskAfterFailure(task, run.id, 'rework', { platform: true })
      return 'unreadable'
    }
    if (followed.kind === 'rewritten') {
      await noteLead({
        workspaceId: task.workspaceId,
        version: target.goalVersion,
        kind: 'branch_rewritten',
        detail: "the lead rewrote commits the work branch already had; the work branch now follows the lead's branch",
        runId: run.id,
      })
    }
  }

  await readDecisions(repoPath, tip, { workspaceId: task.workspaceId, version: delivery.goalVersion, runId: run.id })
  // Spec section 9: proof starts whether or not the lead reported.
  if (run.status !== 'succeeded') {
    await noteLead({ workspaceId: task.workspaceId, version: delivery.goalVersion, runId: run.id, kind: 'report_missing', detail: 'the lead was stopped before it could write its closing report' })
  } else if ((await finalTextOf(run.id)).trim() === '') {
    await noteLead({ workspaceId: task.workspaceId, version: delivery.goalVersion, runId: run.id, kind: 'report_missing', detail: 'the lead ended without a closing report' })
  }

  const done = await prisma.task.updateMany({
    where: { id: task.id, activeRunId: run.id },
    data: { status: 'done', integratedAt: new Date(), activeRunId: null, lastRejectionReason: null },
  })
  if (done.count === 0) return 'settled'
  await updateLeadProgress(delivery.id, (progress) => ({ ...progress, nextTurn: null }))
  await appendEvent({ type: 'task.done', workspaceId: task.workspaceId, taskId: task.id, actor: 'system', payload: { branch: task.branch } })
  return 'settled'
}

/**
 * Lead-flow spec B9 (plan A L18): the lead's decisions file at the commit just integrated, read
 * into decision records. Bounded before it is read (`cat-file -s`); a file that is missing, too
 * large or unreadable is one line for the report, said once, and stops nothing.
 */
async function readDecisions(repoPath: string, tip: string, at: { readonly workspaceId: string; readonly version: number; readonly runId: string }): Promise<void> {
  const object = `${tip}:${LEAD_DECISIONS_FILE}`
  let markdown: string
  try {
    const size = Number(await gitIn(repoPath, 'cat-file', '-s', object))
    if (!Number.isFinite(size) || size > LEAD_DECISIONS_FILE_MAX_BYTES) throw new Error(`it is ${String(size)} bytes`)
    markdown = await gitIn(repoPath, 'show', object)
  } catch {
    await noteLeadOnce({ ...at, kind: 'decisions_missing', detail: `${LEAD_DECISIONS_FILE} is missing or could not be read: the lead recorded no decision there` })
    return
  }
  const outcome = await recordLeadDecisions(at.workspaceId, at.version, parseLeadDecisions(markdown))
  if (outcome.written > 0) await noteLead({ ...at, kind: 'decisions_read', detail: `${String(outcome.written)} decision(s) recorded from ${LEAD_DECISIONS_FILE}` })
  if (outcome.refused > 0) await noteLeadOnce({ ...at, kind: 'decisions_read', detail: `${String(outcome.refused)} decision(s) of ${LEAD_DECISIONS_FILE} were not recorded: the version already holds as many as it may` })
}
