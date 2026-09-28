import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { integrationWorktreeKey } from '@slave-of-ai/domain'
import { gitIn, worktreeRootFor } from './worktree.js'

/**
 * Cuts a conducted goal version's integration branch from the base branch (spec R9), or reuses it.
 *
 * Reuse is the crash case: the branch is cut BEFORE the materialisation transaction (git is not
 * transactional), so a daemon that died between the two finds its own branch on the next tick.
 * It is reused only while it carries nothing the base branch does not -- a branch of this name with
 * commits of its own is somebody else's, and building a goal version on it would ship them.
 */
export async function ensureIntegrationBranch(
  repoPath: string,
  baseBranch: string,
  branch: string,
): Promise<{ readonly baseCommit: string }> {
  const exists = await gitIn(repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`).then(
    () => true,
    () => false,
  )
  if (!exists) {
    await gitIn(repoPath, 'branch', branch, baseBranch)
  } else {
    const onBase = await gitIn(repoPath, 'merge-base', '--is-ancestor', branch, baseBranch).then(
      () => true,
      () => false,
    )
    if (!onBase) throw new Error(`integration branch ${branch} exists and is not on ${baseBranch}'s history`)
  }
  return { baseCommit: await gitIn(repoPath, 'rev-parse', branch) }
}

export interface IntegrationTarget {
  readonly deliveryId: string
  readonly goalVersion: number
  readonly branch: string
}

/**
 * The branch a package task was cut from and merges back into (spec R9, plan D5): its goal
 * version's integration branch. `null` for a task with no package, and for a package whose version
 * was materialised before goal deliveries existed -- that one keeps the base-branch path it started on.
 * One answer for dispatch, the ownership audit, review and the merge pass, so none of them can
 * judge a task against a different base than another (plan D12).
 */
export async function integrationTargetFor(taskId: string): Promise<IntegrationTarget | null> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { workspaceId: true, workPackage: { select: { goalVersion: true } } },
  })
  if (task === null || task.workPackage === null) return null
  const delivery = await prisma.goalDelivery.findUnique({
    where: { workspaceId_goalVersion: { workspaceId: task.workspaceId, goalVersion: task.workPackage.goalVersion } },
    select: { id: true, goalVersion: true, integrationBranch: true },
  })
  return delivery === null ? null : { deliveryId: delivery.id, goalVersion: delivery.goalVersion, branch: delivery.integrationBranch }
}

/** The ref a task's work is measured from: its integration branch, else the workspace's base branch. */
export async function baseRefFor(taskId: string, baseBranch: string): Promise<string> {
  return (await integrationTargetFor(taskId))?.branch ?? baseBranch
}

/**
 * Where the worktree kept on a goal version's integration branch lives (plan D2): outside the
 * repository, beside the task worktrees (`worktreeRootFor`). The one spelling of that path, for the
 * code that creates it and the code that will remove it.
 */
export function integrationWorktreePath(repoPath: string, goalVersion: number, workspaceId: string): string {
  return join(worktreeRootFor(repoPath), integrationWorktreeKey(goalVersion, workspaceId))
}

/**
 * The worktree the merge pass keeps checked out on a goal version's integration branch (plan D2):
 * package merges land here, never in the person's primary checkout. Created when missing (after a
 * `worktree prune`, so a directory somebody deleted does not leave a registration `worktree add`
 * refuses); otherwise it must be registered on exactly that branch -- line equality, as
 * `adoptWorktree` checks it, so a longer-named branch is not mistaken for this one. A merge a crash
 * interrupted is aborted first: nothing else ever writes here, so an in-progress merge can only be
 * this pass's own.
 */
export async function ensureIntegrationWorktree(repoPath: string, target: IntegrationTarget, workspaceId: string): Promise<string> {
  const path = integrationWorktreePath(repoPath, target.goalVersion, workspaceId)
  if (!existsSync(path)) {
    await gitIn(repoPath, 'worktree', 'prune')
    await gitIn(repoPath, 'worktree', 'add', path, target.branch)
    return path
  }
  const records = (await gitIn(repoPath, 'worktree', 'list', '--porcelain')).split('\n\n')
  const registered = records.find((record) => record.startsWith(`worktree ${path}\n`))
  if (registered === undefined || !registered.split('\n').includes(`branch refs/heads/${target.branch}`)) {
    throw new Error(`${path} is not a worktree of ${repoPath} on ${target.branch}`)
  }
  await gitIn(path, 'merge', '--abort').catch(() => {})
  return path
}
