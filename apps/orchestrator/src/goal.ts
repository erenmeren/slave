import { existsSync } from 'node:fs'
import { goalEventSaid, settleGoalEvidence, withDeliveryLock } from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import { type GuardrailKind, type WorkspaceId } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { mergeOrAbort, primaryCheckoutReady } from './gitMerge.js'
import { integrationWorktreePath } from './goalBranch.js'
import { gitIn } from './worktree.js'

/**
 * The goal pass (Conductor Plan 4a, spec R9): once per ordinary tick, after the merge pass. Moves
 * each open goal version of the workspace on -- accepted when its gate holds, merged into the base
 * branch once when accepted. Plan 4b puts the verification run between "every package integrated"
 * and "accepted".
 */
export async function runGoalPass(workspaceId: WorkspaceId): Promise<void> {
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

  const open = await prisma.goalDelivery.findMany({
    where: { workspaceId, OR: [{ status: 'integrating' }, { status: 'accepted', mergedAt: null, mergeError: null }] },
    orderBy: { goalVersion: 'asc' },
  })
  for (const delivery of open) {
    if (delivery.status === 'integrating') {
      if (!(await everyPackageIntegrated(workspaceId, delivery.goalVersion))) continue
      // Plan D8: until Plan 4b the per-task verify and review are the gate.
      if (!(await acceptGoal(delivery.id, 0))) continue
    }
    if (workspace.autoMerge) {
      await mergeGoalIntoBase(delivery.id)
    } else {
      // Final wave I2: the version waits for the person, and so does every later version (D6) --
      // said once, the same trip as the other waits (ruling P7), or the wait is silent.
      await tripOnce(
        workspaceId,
        `goal v${String(delivery.goalVersion)} is accepted and autoMerge is off: ` +
          handMergeInstruction(delivery.integrationBranch, workspace.baseBranch, workspaceId, delivery.goalVersion),
      )
    }
  }
}

/** Every package task of the version is `done` and on the integration branch -- and there is at
 *  least one (a version whose tasks were all cancelled is not "delivered"; it is abandoned). */
async function everyPackageIntegrated(workspaceId: string, goalVersion: number): Promise<boolean> {
  const tasks = await prisma.task.findMany({
    where: { workspaceId, workPackage: { goalVersion } },
    select: { status: true, integratedAt: true },
  })
  return tasks.length > 0 && tasks.every((task) => task.status === 'done' && task.integratedAt !== null)
}

/**
 * `integrating` -> `accepted`, once: under the delivery's lock, the event first (if a crash did not
 * already write it), then the guarded status move. Returns whether this call moved it.
 */
export async function acceptGoal(deliveryId: string, rounds: number): Promise<boolean> {
  return withDeliveryLock(deliveryId, async (tx) => {
    const delivery = await tx.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId } })
    if (delivery.status !== 'integrating') return false
    if (!(await goalEventSaid(tx, delivery.workspaceId, 'workspace_goal_accepted', delivery.goalVersion))) {
      await appendEvent({
        type: 'workspace.goal_accepted',
        workspaceId: delivery.workspaceId,
        actor: 'system',
        payload: { version: delivery.goalVersion, rounds },
      })
    }
    const moved = await tx.goalDelivery.updateMany({
      where: { id: deliveryId, status: 'integrating' },
      data: { status: 'accepted', acceptedAt: new Date() },
    })
    return moved.count > 0
  })
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
    const handMerge = handMergeInstruction(delivery.integrationBranch, baseBranch, delivery.workspaceId, version)

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
      const integrationTip = await gitIn(repoPath, 'rev-parse', delivery.integrationBranch)
      return landed(tx, delivery, baseTip, baseTip === integrationTip ? 'system' : 'human')
    }
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

    const merge = await mergeOrAbort(repoPath, ['--ff-only', delivery.integrationBranch])
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

/** Who put a goal version into the base branch: this pass's fast-forward, or a person's hand merge. */
type MergedBy = 'system' | 'human'

/**
 * What a person does when a goal version waits for them (base moved, a merge git refused,
 * `autoMerge` off): one wording, so the three waits cannot drift apart.
 */
function handMergeInstruction(integrationBranch: string, baseBranch: string, workspaceId: string, version: number): string {
  return (
    `Merge ${integrationBranch} into ${baseBranch} by hand, then run ` +
    `confirm-goal-merge --workspace ${workspaceId} --version ${String(version)}`
  )
}

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
