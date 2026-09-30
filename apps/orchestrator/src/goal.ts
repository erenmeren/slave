import { existsSync } from 'node:fs'
import { everyPackageIntegrated, expirePendingHandOffs, goalEventSaid, goalEventWith, settleGoalEvidence, withDeliveryLock } from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import { VERIFICATION_REASON_MAX_CHARS, VERIFICATION_RUN_RETRY_CAP, handMergeInstruction, type GuardrailKind } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { mergeOrAbort, primaryCheckoutReady } from './gitMerge.js'
import { integrationWorktreePath } from './goalBranch.js'
import { passedSmokeAtTip, settleStrandedSmoke, smokeErrorsInRound, startSmoke } from './smoke.js'
import type { TickDeps } from './tick.js'
import { dispatchVerification, lastVerificationFailure, settleStrandedClaim } from './verification.js'
import { gitIn } from './worktree.js'

/** What the tick lets the goal pass do. */
export interface GoalPassOptions {
  /** False while `decide()` says the workspace has no room for a new run (H9c `wait`): the pass
   *  still settles, concludes and merges, and starts no verification run. */
  readonly mayStartRuns: boolean
}

/**
 * The goal pass (Conductor Plans 4a and 4b, spec R9): once per ordinary tick, after the merge pass.
 * Moves each open goal version of the workspace on: once every package is on its integration
 * branch, a smoke check (skeleton spec S7; its conclusion is `applySmokeOutcome`'s) and then a
 * verification run check every requirement (Plan 4b; its conclusion -- accept, rework,
 * `needs_human` -- is `concludeVerification`'s); a claim nothing will conclude, a smoke's or a
 * verification run's, is settled here; an accepted version is merged into the base branch once.
 */
export async function runGoalPass(deps: TickDeps, options: GoalPassOptions): Promise<void> {
  const workspaceId = deps.workspaceId
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { autoMerge: true, repoPath: true, baseBranch: true } })
  // A hand merge confirmed from the CLI leaves the integration worktree behind (`packages/control`
  // does not know where worktrees live); it is spent once the branch is in the base branch.
  //
  // And a stamp with no `goal_merged` behind it (a crash between the two, or a row stamped before
  // this ordering existed) is announced and settled here, once: the event and the evidence are
  // what the person and the ranker read, and nothing else would ever write them.
  const merged = await prisma.goalDelivery.findMany({
    where: { workspaceId, mergedAt: { not: null } },
    select: { id: true, goalVersion: true, integrationBranch: true },
  })
  const announced = await mergedVersionsAnnounced(workspaceId)
  for (const delivery of merged) {
    if (!announced.has(delivery.goalVersion)) {
      // The commit that reached the base branch is not recorded anywhere a crash could not lose;
      // the integration tip is the one commit known to be in it (a fast-forward lands exactly it,
      // a hand merge contains it).
      //
      // Final wave M4: a branch somebody deleted since cannot name it. That row is left
      // unannounced (and said in the log) rather than thrown out of the pass: the open versions
      // below must still be reached.
      let commit: string
      try {
        commit = await gitIn(workspace.repoPath, 'rev-parse', delivery.integrationBranch)
      } catch (error) {
        console.warn(`[goal] cannot announce goal v${String(delivery.goalVersion)}'s merge: ${String(error)}`)
        continue
      }
      await withDeliveryLock(delivery.id, async (tx) =>
        announceOnce(tx, workspaceId, delivery.goalVersion, delivery.integrationBranch, workspace.baseBranch, commit, 'system'),
      )
    }
    await removeIntegrationWorktree(workspace.repoPath, delivery.goalVersion, workspaceId)
  }

  // Ruling F2 (spec S7, one event per attempt): an attempt whose claim was released while it ran --
  // an abandoned version, which no pass below visits -- and whose process then died is settled
  // here, so it still says how it ended. A live one is left to its owner, as a claimed one is.
  const unclaimed = await prisma.smokeAttempt.findMany({
    where: { workspaceId, status: 'running', goalDelivery: { activeSmokeId: null } },
    select: { id: true },
  })
  for (const attempt of unclaimed) {
    try {
      await settleStrandedSmoke(attempt.id)
    } catch (error) {
      console.error(`[goal] smoke attempt ${attempt.id} could not be settled on this pass:`, error)
    }
  }

  const open = await prisma.goalDelivery.findMany({
    where: {
      workspaceId,
      OR: [{ status: 'integrating' }, { status: 'verifying' }, { status: 'accepted', mergedAt: null, mergeError: null }],
    },
    orderBy: { goalVersion: 'asc' },
    select: { id: true },
  })
  for (const { id } of open) {
    // Fix round 1, M4: one version whose step throws must not stop the pass for the others.
    try {
      await advanceDelivery(deps, options, workspace, id)
    } catch (error) {
      console.error(`[goal] goal delivery ${id} could not be moved on this pass:`, error)
    }
  }
}

/** One open delivery's step of {@link runGoalPass}. */
async function advanceDelivery(
  deps: TickDeps,
  options: GoalPassOptions,
  workspace: { readonly autoMerge: boolean; readonly repoPath: string; readonly baseBranch: string },
  id: string,
): Promise<void> {
  const workspaceId = deps.workspaceId
  let delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id } })
  if (delivery.activeSmokeId !== null) {
    // Plan B D8: a smoke claim nothing will conclude is settled here; a live one is waited for.
    await settleStrandedSmoke(delivery.activeSmokeId)
    delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id } })
    if (delivery.activeSmokeId !== null) return
  }
  if (delivery.status === 'verifying' && delivery.activeRunId !== null) {
    // D3/D7 and ruling Q2: a claim whose run is over with nobody concluding it (a daemon that
    // died, a conclusion that crashed). Settled -- concluded or released -- and read again, so a
    // released round is dispatched again on this same pass.
    await settleStrandedClaim(delivery.activeRunId)
    delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id } })
  }
  if (delivery.status === 'verifying') {
    if (delivery.activeRunId !== null) return
    if (delivery.roundRunFailures >= VERIFICATION_RUN_RETRY_CAP) {
      // Plan B D3: a smoke the orchestrator could not run counts against the same cap as an
      // unusable verification, so the reason names whichever it was.
      const last = await lastVerificationFailure(delivery.id)
      const smoke = await smokeErrorsInRound(delivery.id, delivery.round)
      const cap = String(VERIFICATION_RUN_RETRY_CAP)
      const round = String(delivery.round)
      const reason =
        smoke.count === 0
          ? `the verifier could not produce a usable verification ${cap} times in round ${round}` + (last === null ? '' : `; the last: ${last.slice(0, 1000)}`)
          : `the round could not be run ${cap} times in round ${round}: ${String(smoke.count)} smoke check(s) could not be run; the last: ${(smoke.last ?? '').slice(0, 800)}` +
            (last === null ? '' : `; the last unusable verification: ${last.slice(0, 500)}`)
      await endInNeedsHuman(delivery.id, null, reason)
      return
    }
    // Task 5's rule: a round -- a new one or the same one again -- verifies the whole version,
    // so it waits for every package to be back on the branch.
    if (!(await everyPackageIntegrated(workspaceId, delivery.goalVersion))) return
    if (!options.mayStartRuns) return
    await smokeOrVerify(deps, workspace.repoPath, delivery)
    return
  }
  if (delivery.status === 'integrating') {
    if (!(await everyPackageIntegrated(workspaceId, delivery.goalVersion))) return
    if (!options.mayStartRuns) return
    // Plan 4b (spec R8/R9): integration is not acceptance. A round of verification is -- and
    // (skeleton spec S7) the round starts with a smoke check.
    await smokeOrVerify(deps, workspace.repoPath, delivery)
    return
  }
  if (delivery.status !== 'accepted' || delivery.mergedAt !== null || delivery.mergeError !== null) return
  // Final wave M4: a deleted integration branch can be neither merged nor waited on.
  if ((await integrationTipOrTrip(workspace.repoPath, delivery)) === null) return
  // Fix round 1, M2 (ruling V5): an accepted version whose branch moved since its verification is
  // verified again, whether or not this pass would merge it -- never handed to a person to merge.
  if (await withDeliveryLock(delivery.id, async (tx) => reopenIfMovedInLock(tx, delivery.id))) return
  if (workspace.autoMerge) {
    await mergeGoalIntoBase(delivery.id)
  } else {
    // Final wave I2: the version waits for the person, and so does every later version (D6) --
    // said once, the same trip as the other waits (ruling P7), or the wait is silent.
    await tripOnce(
      workspaceId,
      `goal v${String(delivery.goalVersion)} is accepted and autoMerge is off: ` +
        handMergeInstruction(delivery.integrationBranch, workspace.baseBranch, workspaceId, delivery.goalVersion, delivery.verifiedCommit),
    )
  }
}

/**
 * Skeleton spec S7 (plan B D5): the verification run follows a passing smoke check on the
 * integration branch's CURRENT tip. Without one, a smoke attempt starts instead (a new round from
 * `integrating`, the same round again from `verifying`), and a later pass verifies once it passed.
 * One that already passed on this tip -- a retry of an unchanged tree, or a verification that was
 * unusable -- is not run again. A version whose set was extracted before RUN existed
 * (`smokeRequired` false) is verified as it always was. A branch that is gone trips, once, instead.
 */
async function smokeOrVerify(
  deps: TickDeps,
  repoPath: string,
  delivery: { readonly id: string; readonly workspaceId: string; readonly goalVersion: number; readonly integrationBranch: string; readonly smokeRequired: boolean },
): Promise<void> {
  // Final review I1: a deleted integration branch is said once, here -- the smoke gate and the
  // verification both need its tip, and without the trip the version (and every later one, D6)
  // would sit in `integrating`/`verifying` with nothing to say why.
  if ((await integrationTipOrTrip(repoPath, delivery)) === null) return
  const smoked = delivery.smokeRequired ? await passedSmokeAtTip(repoPath, delivery) : null
  if (delivery.smokeRequired && smoked === null) {
    await startSmoke(delivery.id)
    return
  }
  // The smoked attempt travels with the dispatch: it verifies that SHA or nothing (spec S8).
  await dispatchVerification(deps, delivery.id, smoked)
}

/** The verdict a goal version is accepted on (plan 4b, ruling Q6): the verification run that
 *  passed every requirement, and the integration commit it checked. */
export interface AcceptedVerdict {
  readonly runId: string
  readonly verifiedCommit: string
}

/**
 * `verifying` -> `accepted`, once: under the delivery's lock, the event first (if a crash did not
 * already write it), then the guarded status move -- which also releases the verification run's
 * claim and records the verified commit (ruling Q6), in the one write, so no tick in between can
 * see a `verifying` version with no claim and verify an accepted one again. Only the run that
 * holds the claim can accept: a replay, or a release that won, finds nothing to move. Returns
 * whether this call moved it.
 */
export async function acceptGoal(deliveryId: string, verdict: AcceptedVerdict): Promise<boolean> {
  return withDeliveryLock(deliveryId, async (tx) => acceptInLock(tx, deliveryId, verdict))
}

/** {@link acceptGoal}'s body, for a caller already holding the delivery's lock (the verification
 *  conclusion) -- the lock is not re-entrant across transactions. */
export async function acceptInLock(tx: Prisma.TransactionClient, deliveryId: string, verdict: AcceptedVerdict): Promise<boolean> {
  const delivery = await tx.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId } })
  if (delivery.status !== 'verifying' || delivery.activeRunId !== verdict.runId) return false
  if (!(await goalEventSaid(tx, delivery.workspaceId, 'workspace_goal_accepted', delivery.goalVersion))) {
    await appendEvent({
      type: 'workspace.goal_accepted',
      workspaceId: delivery.workspaceId,
      actor: 'system',
      // Rounds since the person's last `retry-goal` (plan D9's window), which is what the cap
      // counted: a version accepted in its first round after a retry took one round of it.
      payload: { version: delivery.goalVersion, rounds: delivery.round - delivery.roundBase },
    })
  }
  const moved = await tx.goalDelivery.updateMany({
    where: { id: deliveryId, status: 'verifying', activeRunId: verdict.runId },
    data: { status: 'accepted', acceptedAt: new Date(), activeRunId: null, verifiedCommit: verdict.verifiedCommit },
  })
  if (moved.count === 0) return false
  // Plan A D4, ruling F3: what this version was asked but never delivered expires with the move.
  await expirePendingHandOffs(tx, delivery.workspaceId, delivery.goalVersion, 'accepted')
  return true
}

/**
 * Why the loop stopped, where that changes what a person must do first (final wave T6-M7): a
 * retry alone would ask the same question again.
 * - `unverifiable`: only unverifiable items -- the verifier lacked an environment or a tool.
 * - `blocked_package`: a failing requirement's package task is cancelled or failed, so it cannot
 *   be reworked until someone restores or unblocks it.
 */
export type NeedsHumanCause =
  | { readonly kind: 'unverifiable'; readonly count: number }
  | { readonly kind: 'blocked_package'; readonly tasks: readonly { readonly taskId: string; readonly status: string }[] }

/**
 * What a person can do about a goal version the loop stopped on (controller ruling Q9, user
 * ruling: no accept-anyway, and no "merge it by hand" -- nothing unverified is suggested).
 * `cause` (final wave T6-M7) names what to fix before `retry-goal`; without one (a cap), a retry
 * is the remedy by itself.
 */
export function needsHumanRemedy(workspaceId: string, version: number, cause?: NeedsHumanCause): string {
  const v = String(version)
  const read = `Read goal-status --workspace ${workspaceId} --version ${v} for the verdict`
  const retry = `retry-goal --workspace ${workspaceId} --version ${v}`
  const abandon = `or abandon-goal --workspace ${workspaceId} --version ${v} to move on.`
  if (cause?.kind === 'unverifiable') {
    const what = cause.count === 1 ? 'the requirement' : 'the requirements'
    return `${read}. Fix what made ${what} unverifiable (the environment or the tooling the verifier lacked), then run ${retry} to verify again; ${abandon}`
  }
  if (cause?.kind === 'blocked_package') {
    const what = cause.tasks.length === 1 ? 'the package task that owns the failing requirement' : 'the package tasks that own the failing requirements'
    const named = cause.tasks.map((task) => `task ${task.taskId}, ${task.status}`).join('; ')
    return `${read}. Restore or unblock ${what} (${named}), then run ${retry} to verify again; ${abandon}`
  }
  return `${read}, then run ${retry} to give it a fresh window of verification rounds, ${abandon}`
}

/**
 * `verifying` -> `needs_human` (plan D6/D7), under the delivery's lock, in the 4a order: the event
 * if it is missing, then the guarded move. `runId` is the claim the caller holds (a conclusion),
 * or null for a version with no run in flight (the goal pass's run-failure cap). `reason` gains
 * the remedy ({@link needsHumanRemedy}) and is bounded for the row and the event.
 */
export async function endInNeedsHuman(deliveryId: string, runId: string | null, reason: string, cause?: NeedsHumanCause): Promise<boolean> {
  return withDeliveryLock(deliveryId, async (tx) => needsHumanInLock(tx, deliveryId, runId, reason, cause))
}

/** {@link endInNeedsHuman}'s body, for a caller already holding the delivery's lock. */
export async function needsHumanInLock(
  tx: Prisma.TransactionClient,
  deliveryId: string,
  runId: string | null,
  reason: string,
  cause?: NeedsHumanCause,
): Promise<boolean> {
  const delivery = await tx.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId } })
  if (delivery.status !== 'verifying' || delivery.activeRunId !== runId) return false
  const remedy = needsHumanRemedy(delivery.workspaceId, delivery.goalVersion, cause)
  const full = `${reason.slice(0, VERIFICATION_REASON_MAX_CHARS - remedy.length - 2)}. ${remedy}`
  // Once per stop: a version stops at most once between two `retry-goal`s (every later stop is in
  // a later round), so "said since the last retry" is "said for this stop".
  const lastRetry = await tx.executionEvent.findFirst({
    where: { workspaceId: delivery.workspaceId, type: 'workspace_goal_retried', payload: { path: ['version'], equals: delivery.goalVersion } },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  const said = await goalEventWith(
    tx,
    delivery.workspaceId,
    'workspace_goal_needs_human',
    { version: delivery.goalVersion },
    lastRetry === null ? {} : { since: lastRetry.seq },
  )
  if (!said) {
    await appendEvent({
      type: 'workspace.goal_needs_human',
      workspaceId: delivery.workspaceId,
      actor: 'system',
      payload: { version: delivery.goalVersion, reason: full },
    })
  }
  const moved = await tx.goalDelivery.updateMany({
    where: { id: deliveryId, status: 'verifying', activeRunId: runId },
    // Skeleton spec S7: a stop also releases a smoke claim (the smoke gate's cap stops from its conclusion).
    data: { status: 'needs_human', activeRunId: null, activeSmokeId: null, needsHumanReason: full },
  })
  return moved.count > 0
}

/**
 * The one merge of a goal version into the base branch (spec R9, plan D9), in the primary checkout,
 * under the delivery's lock (two overlapping passes must not both run git on the person's checkout).
 *
 * Automatic only as a FAST-FORWARD from the commit the version was cut at (controller ruling P9:
 * nothing reaches the base branch unverified). Then the base branch becomes exactly the tree the
 * version's packages were verified on, commit for commit. A base branch that moved since the cut
 * would land a merged tree nobody checked, so the version waits for the person instead -- the same
 * wait as `autoMerge` off: they merge by hand and confirm (`confirm-goal-merge`). Said once.
 *
 * A checkout that is dirty or on another branch is the person working there: `waiting`, said once,
 * tried again next tick. A merge git refuses anyway is aborted, recorded on `mergeError` and left
 * for the person; nothing retries it.
 */
export async function mergeGoalIntoBase(deliveryId: string): Promise<'merged' | 'waiting' | 'failed'> {
  return withDeliveryLock(deliveryId, async (tx) => {
    // Read under the lock: an overlapping pass may have merged it, or recorded a refusal, meanwhile.
    const delivery = await tx.goalDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      include: { workspace: { select: { repoPath: true, baseBranch: true } } },
    })
    if (delivery.mergeError !== null) return 'failed'
    const { repoPath, baseBranch } = delivery.workspace
    const version = delivery.goalVersion
    const handMerge = handMergeInstruction(delivery.integrationBranch, baseBranch, delivery.workspaceId, version, delivery.verifiedCommit)

    const integrationTip = await integrationTipOrTrip(repoPath, delivery)
    if (integrationTip === null) return 'waiting'
    const baseTip = await gitIn(repoPath, 'rev-parse', `refs/heads/${baseBranch}`)
    // Already in the base branch: a pass that crashed after the fast-forward and before the stamp,
    // or the overlapping pass this lock just waited for. The base tip no longer equals
    // `baseCommit`, and without this the version would be told "the base moved, merge by hand"
    // about its own merge -- and hold every later version (D6) behind a needless confirmation.
    const contained = await gitIn(repoPath, 'merge-base', '--is-ancestor', delivery.integrationBranch, `refs/heads/${baseBranch}`).then(
      () => true,
      () => false,
    )
    //
    // Final wave I1: WHO merged it. This pass only ever fast-forwards, which lands exactly the
    // integration tip; a base tip that is anything else is the person's hand merge after a wait
    // (base moved, or a refused merge), and is recorded as theirs -- their `confirm-goal-merge`
    // then finds it recorded. A person who fast-forwarded by hand lands the same tree this pass
    // would have, so `system` is true enough of it.
    if (contained) {
      return landed(tx, delivery, baseTip, baseTip === integrationTip ? 'system' : 'human')
    }
    // Ruling Q6 and fix round 1 M2 (ruling V5): only the tip the version's passing verification
    // checked is ever landed. A branch that moved since (or a row accepted before verification
    // existed) goes back to `integrating` and is verified again -- a wait, never a hand merge.
    if (delivery.verifiedCommit === null || integrationTip !== delivery.verifiedCommit) {
      await reopenIfMovedInLock(tx, deliveryId)
      return 'waiting'
    }
    const verifiedCommit = delivery.verifiedCommit
    if (baseTip !== delivery.baseCommit) {
      await tripOnce(
        delivery.workspaceId,
        `goal v${String(version)} is accepted, but ${baseBranch} has moved since the goal was cut from it ` +
          `(at ${delivery.baseCommit.slice(0, 12)}), so merging it now would land a tree nobody verified. ${handMerge}`,
      )
      return 'waiting'
    }
    if (!(await primaryCheckoutReady(repoPath, baseBranch))) {
      await tripOnce(
        delivery.workspaceId,
        `goal v${String(version)} is accepted and waits for a clean checkout of ${baseBranch} to be merged into it`,
      )
      return 'waiting'
    }

    // Fix round 1, M1: to the verified SHA, not the branch name -- a branch that moves between the
    // check above and this line must not carry an unverified commit into the base branch.
    const merge = await mergeOrAbort(repoPath, ['--ff-only', verifiedCommit])
    if (!merge.ok) {
      await tx.goalDelivery.updateMany({ where: { id: deliveryId, mergedAt: null }, data: { mergeError: merge.error } })
      await tripOnce(
        delivery.workspaceId,
        `goal v${String(version)} could not be merged into ${baseBranch}: ${merge.error.split('\n')[0] ?? ''}. ${handMerge}`,
      )
      return 'failed'
    }
    return landed(tx, delivery, await gitIn(repoPath, 'rev-parse', 'HEAD'), 'system')
  })
}

/**
 * Fix round 1, M2 (ruling V5): `accepted` -> `integrating` for a version whose integration branch
 * is no longer at the commit its verification passed on, so the next pass verifies the new tip,
 * with a fresh round window (the acceptance's rounds were spent on a tree that is gone). In the
 * delivery's lock, in the 4a order: `workspace.goal_retried { version, round }` if missing (a
 * system retry; its `(version, round)` is unique, because a version is accepted in a later round
 * than any retry before it), then the guarded move. Returns whether it moved.
 */
async function reopenIfMovedInLock(tx: Prisma.TransactionClient, deliveryId: string): Promise<boolean> {
  const delivery = await tx.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { workspace: { select: { repoPath: true } } } })
  if (delivery.status !== 'accepted' || delivery.mergedAt !== null || delivery.mergeError !== null) return false
  const tip = await integrationTipOrTrip(delivery.workspace.repoPath, delivery)
  // A branch that is gone is not a branch that moved: there is nothing to verify again.
  if (tip === null) return false
  if (delivery.verifiedCommit !== null && tip === delivery.verifiedCommit) return false
  const version = delivery.goalVersion
  if (!(await goalEventWith(tx, delivery.workspaceId, 'workspace_goal_retried', { version, round: delivery.round }))) {
    await appendEvent({
      type: 'workspace.goal_retried',
      workspaceId: delivery.workspaceId,
      actor: 'system',
      // Final wave M5: said as the pass's own retry, so neither the card nor the timeline reads it
      // as a person's.
      payload: { version, round: delivery.round, cause: 'branch_moved' },
    })
  }
  const moved = await tx.goalDelivery.updateMany({
    where: { id: deliveryId, status: 'accepted', mergedAt: null, mergeError: null },
    data: { status: 'integrating', acceptedAt: null, verifiedCommit: null, roundBase: delivery.round, roundRunFailures: 0, needsHumanReason: null },
  })
  return moved.count > 0
}

/** Who put a goal version into the base branch: this pass's fast-forward, or a person's hand merge. */
type MergedBy = 'system' | 'human'

interface LandingDelivery {
  readonly id: string
  readonly workspaceId: string
  readonly goalVersion: number
  readonly integrationBranch: string
  readonly workspace: { readonly repoPath: string; readonly baseBranch: string }
}

/**
 * Records a goal version that has reached the base branch, inside the delivery's lock. The event
 * (and the evidence before it) first, the stamp LAST: a crash before the stamp leaves the row
 * unstamped, and the next pass comes back here (the branch is contained) and finds the event
 * already written.
 */
async function landed(tx: Prisma.TransactionClient, delivery: LandingDelivery, commit: string, by: MergedBy): Promise<'merged'> {
  await announceOnce(tx, delivery.workspaceId, delivery.goalVersion, delivery.integrationBranch, delivery.workspace.baseBranch, commit, by)
  await tx.goalDelivery.updateMany({ where: { id: delivery.id, mergedAt: null }, data: { mergedAt: new Date() } })
  await removeIntegrationWorktree(delivery.workspace.repoPath, delivery.goalVersion, delivery.workspaceId)
  return 'merged'
}

/** Plan D4's evidence, then `goal_merged` -- once per version, in the delivery's lock. Settled
 *  first, so an event never outlives a crash that lost the settling (settling is idempotent). */
async function announceOnce(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  version: number,
  branch: string,
  into: string,
  commit: string,
  by: MergedBy,
): Promise<void> {
  if (await goalEventSaid(tx, workspaceId, 'workspace_goal_merged', version)) return
  await settleGoalEvidence(workspaceId, version)
  await appendEvent({ type: 'workspace.goal_merged', workspaceId, actor: by, payload: { version, branch, into, commit, by } })
}

/** The goal versions of the workspace that already have their `goal_merged` -- an unlocked
 *  pre-filter only, so a tick does not take a lock per merged version; `announceOnce` decides. */
async function mergedVersionsAnnounced(workspaceId: string): Promise<ReadonlySet<number>> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'workspace_goal_merged' }, select: { payload: true } })
  return new Set(rows.map((row) => (row.payload as { readonly version: number }).version))
}

/** The branch stays (it is the goal version's record); the worktree on it is spent. */
async function removeIntegrationWorktree(repoPath: string, version: number, workspaceId: string): Promise<void> {
  const path = integrationWorktreePath(repoPath, version, workspaceId)
  if (!existsSync(path)) return
  await gitIn(repoPath, 'worktree', 'remove', '--force', path).catch((error: unknown) => {
    console.warn(`[goal] could not remove ${path}: ${String(error)}`)
  })
}

/**
 * Final wave M4: the integration branch's tip, or null -- after saying once what the person can do
 * -- when the branch is gone (somebody deleted it). Without this the `rev-parse` threw on every
 * tick, the pass only logged it, and the version (and every later one, D6) waited in silence.
 */
async function integrationTipOrTrip(
  repoPath: string,
  delivery: { readonly workspaceId: string; readonly goalVersion: number; readonly integrationBranch: string },
): Promise<string | null> {
  try {
    return await gitIn(repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${delivery.integrationBranch}^{commit}`)
  } catch {
    const v = String(delivery.goalVersion)
    await tripOnce(
      delivery.workspaceId,
      `the integration branch ${delivery.integrationBranch} of goal v${v} is gone: restore it or run abandon-goal --workspace ${delivery.workspaceId} --version ${v}`,
    )
    return null
  }
}

/** A `merge_failure` trip, workspace-scoped, said once per detail (the conductor's dedup rule). */
async function tripOnce(workspaceId: string, detail: string): Promise<void> {
  const said = await prisma.executionEvent.findFirst({
    where: { workspaceId, type: 'guardrail_tripped', payload: { path: ['detail'], equals: detail } },
    select: { seq: true },
  })
  if (said !== null) return
  await appendEvent({
    type: 'guardrail.tripped',
    workspaceId,
    actor: 'system',
    payload: { guardrail: 'merge_failure' satisfies GuardrailKind, detail },
  })
}
