import { existsSync } from 'node:fs'
import { settleGoalEvidence } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
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
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { autoMerge: true, repoPath: true } })
  // A hand merge confirmed from the CLI leaves the integration worktree behind (`packages/control`
  // does not know where worktrees live); it is spent once the branch is in the base branch.
  const merged = await prisma.goalDelivery.findMany({ where: { workspaceId, mergedAt: { not: null } }, select: { goalVersion: true } })
  for (const delivery of merged) await removeIntegrationWorktree(workspace.repoPath, delivery.goalVersion, workspaceId)

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

/** Guarded on the status it leaves, so a replay (or two ticks) writes one `goal_accepted`. */
export async function acceptGoal(deliveryId: string, rounds: number): Promise<boolean> {
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId } })
  const moved = await prisma.goalDelivery.updateMany({
    where: { id: deliveryId, status: 'integrating' },
    data: { status: 'accepted', acceptedAt: new Date() },
  })
  if (moved.count === 0) return false
  await appendEvent({
    type: 'workspace.goal_accepted',
    workspaceId: delivery.workspaceId,
    actor: 'system',
    payload: { version: delivery.goalVersion, rounds },
  })
  return true
}

/**
 * The one merge of a goal version into the base branch (spec R9, plan D9), in the primary checkout.
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
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
    include: { workspace: { select: { repoPath: true, baseBranch: true } } },
  })
  const { repoPath, baseBranch } = delivery.workspace
  const version = delivery.goalVersion
  const handMerge =
    `Merge ${delivery.integrationBranch} into ${baseBranch} by hand, then run ` +
    `confirm-goal-merge --workspace ${delivery.workspaceId} --version ${String(version)}`

  const baseTip = await gitIn(repoPath, 'rev-parse', `refs/heads/${baseBranch}`)
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
    await prisma.goalDelivery.updateMany({ where: { id: deliveryId, mergedAt: null }, data: { mergeError: merge.error } })
    await tripOnce(
      delivery.workspaceId,
      `goal v${String(version)} could not be merged into ${baseBranch}: ${merge.error.split('\n')[0] ?? ''}. ${handMerge}`,
    )
    return 'failed'
  }
  const commit = await gitIn(repoPath, 'rev-parse', 'HEAD')
  const stamped = await prisma.goalDelivery.updateMany({ where: { id: deliveryId, mergedAt: null }, data: { mergedAt: new Date() } })
  if (stamped.count === 0) return 'merged'
  await appendEvent({
    type: 'workspace.goal_merged',
    workspaceId: delivery.workspaceId,
    actor: 'system',
    payload: { version, branch: delivery.integrationBranch, into: baseBranch, commit, by },
  })
  await settleGoalEvidence(delivery.workspaceId, version)
  await removeIntegrationWorktree(repoPath, version, delivery.workspaceId)
  return 'merged'
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
