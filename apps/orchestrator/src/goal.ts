import { existsSync } from 'node:fs'
import { settleGoalEvidence } from '@slave-of-ai/control'
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
      const commit = await gitIn(workspace.repoPath, 'rev-parse', delivery.integrationBranch)
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
    if (workspace.autoMerge) await mergeGoalIntoBase(delivery.id, 'system')
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
 * Serialises everything that decides a delivery's once-only facts (`goal_accepted`, the final
 * merge, `goal_merged`) across overlapping ticks -- a CLI `tick` beside a live daemon, or two
 * ticks of one daemon.
 *
 * A Postgres TRANSACTION advisory lock keyed on the delivery (the daemon already relies on a
 * session advisory lock for "one daemon per database"). The events themselves cannot be written in
 * this transaction -- `appendEvent` is the log's only writer and commits on its own -- so the rule
 * is: under the lock, look for the event, write it if it is missing, THEN move the row. An event
 * `appendEvent` returned is committed before the lock is released, so the next holder sees it; a
 * crash anywhere releases the lock with the connection and leaves the row unmoved, so the next
 * pass comes back and finds the event already there. Exactly once, and nothing lost.
 */
async function withDeliveryLock<T>(deliveryId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`slaveofai:goal-delivery:${deliveryId}`}))`
      return work(tx)
    },
    // The final merge runs git under the lock, and a waiter waits out the holder's whole merge.
    { maxWait: 10_000, timeout: 120_000 },
  )
}

/** Whether the workspace's log already has `type` for this goal version -- read in the lock's
 *  transaction, which sees every event committed before the lock was granted. */
async function saidFor(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  type: 'workspace_goal_accepted' | 'workspace_goal_merged',
  version: number,
): Promise<boolean> {
  const row = await tx.executionEvent.findFirst({
    where: { workspaceId, type, payload: { path: ['version'], equals: version } },
    select: { seq: true },
  })
  return row !== null
}

/**
 * `integrating` -> `accepted`, once: under the delivery's lock, the event first (if a crash did not
 * already write it), then the guarded status move. Returns whether this call moved it.
 */
export async function acceptGoal(deliveryId: string, rounds: number): Promise<boolean> {
  return withDeliveryLock(deliveryId, async (tx) => {
    const delivery = await tx.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId } })
    if (delivery.status !== 'integrating') return false
    if (!(await saidFor(tx, delivery.workspaceId, 'workspace_goal_accepted', delivery.goalVersion))) {
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
export async function mergeGoalIntoBase(deliveryId: string, by: 'system'): Promise<'merged' | 'waiting' | 'failed'> {
  return withDeliveryLock(deliveryId, async (tx) => {
    // Read under the lock: an overlapping pass may have merged it, or recorded a refusal, meanwhile.
    const delivery = await tx.goalDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      include: { workspace: { select: { repoPath: true, baseBranch: true } } },
    })
    if (delivery.mergeError !== null) return 'failed'
    const { repoPath, baseBranch } = delivery.workspace
    const version = delivery.goalVersion
    const handMerge =
      `Merge ${delivery.integrationBranch} into ${baseBranch} by hand, then run ` +
      `confirm-goal-merge --workspace ${delivery.workspaceId} --version ${String(version)}`

    const baseTip = await gitIn(repoPath, 'rev-parse', `refs/heads/${baseBranch}`)
    // Already in the base branch: a pass that crashed after the fast-forward and before the stamp,
    // or the overlapping pass this lock just waited for. The base tip no longer equals
    // `baseCommit`, and without this the version would be told "the base moved, merge by hand"
    // about its own merge -- and hold every later version (D6) behind a needless confirmation.
    const contained = await gitIn(repoPath, 'merge-base', '--is-ancestor', delivery.integrationBranch, `refs/heads/${baseBranch}`).then(
      () => true,
      () => false,
    )
    if (contained) return landed(tx, delivery, baseTip, by)
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
    return landed(tx, delivery, await gitIn(repoPath, 'rev-parse', 'HEAD'), by)
  })
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
async function landed(tx: Prisma.TransactionClient, delivery: LandingDelivery, commit: string, by: 'system'): Promise<'merged'> {
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
  by: 'system',
): Promise<void> {
  if (await saidFor(tx, workspaceId, 'workspace_goal_merged', version)) return
  await settleGoalEvidence(workspaceId, version)
  await appendEvent({ type: 'workspace.goal_merged', workspaceId, actor: 'system', payload: { version, branch, into, commit, by } })
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
