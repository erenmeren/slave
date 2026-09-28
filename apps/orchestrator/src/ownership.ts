import { realpathSync } from 'node:fs'
import { gitIn } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { isOwned, ownershipPatterns, ownershipRuleFor, type OwnershipRule } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { rejectRunBack } from './runs.js'

/** How many foreign files the rejection reason names: enough to act on, short enough to read. */
export const FOREIGN_FILES_LISTED = 20
/** How many the `task.ownership_violated` event records -- its schema's cap; `total` counts all. */
const FOREIGN_FILES_RECORDED = 50

/**
 * The ownership rule of a package task (conductor spec R4): its package among its goal version's
 * packages. Read by both enforcers -- the permission gate (through the run's permissions file)
 * and the diff audit -- so the two can never judge the same path differently.
 *
 * `null` for a task with no package (every planned-workspace task), a package that is gone, or a
 * package that owns `**` (`single` mode): none of them is governed, so none gets a rule.
 */
export async function ownershipRuleForTask(taskId: string): Promise<OwnershipRule | null> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { workPackage: true } })
  const pkg = task?.workPackage ?? null
  if (pkg === null) return null
  const all = await prisma.workPackage.findMany({
    where: { workspaceId: pkg.workspaceId, goalVersion: pkg.goalVersion },
    orderBy: { key: 'asc' },
  })
  return ownershipRuleFor(pkg, all)
}

/** The `ownership` field of a run's permissions file (`writePermissionsFile`'s input shape). */
export interface PermissionOwnership {
  readonly worktreeRoot: string
  readonly owned: readonly string[] | null
  readonly excluded: readonly string[]
}

/**
 * What the gate is told about a package run's ownership, or `undefined` when the run is not
 * governed -- and then the file carries no `ownership` key at all.
 *
 * The root is written RESOLVED (controller Ruling 2): the gate resolves each tool call's path
 * against `worktreeRoot`, and a session started in a worktree reached through a symlink reports
 * its paths under the realpath -- an unresolved root would make every such path look outside the
 * worktree. The fallback keeps the given path when it cannot be resolved; at dispatch and resume
 * the worktree exists, so that is a caller's test path, never a live run's.
 */
export async function permissionOwnership(taskId: string, worktreeRoot: string): Promise<PermissionOwnership | undefined> {
  const rule = await ownershipRuleForTask(taskId)
  return rule === null ? undefined : { worktreeRoot: resolvedRoot(worktreeRoot), ...ownershipPatterns(rule) }
}

function resolvedRoot(worktreeRoot: string): string {
  try {
    return realpathSync(worktreeRoot)
  } catch {
    return worktreeRoot
  }
}

/**
 * The files `branch` changed since it left `base` -- the three-dot range, so the NET change of the
 * branch alone: a file changed and then reverted on it is not listed, and neither is anything the
 * base did after the branch left it. `--no-renames` lists a rename as both of its paths, so a file
 * moved out of (or into) someone else's globs is judged on both sides; `-z` keeps a path with a
 * newline or a quote in it one entry.
 */
export async function changedFiles(repoPath: string, base: string, branch: string): Promise<readonly string[]> {
  const out = await gitIn(repoPath, 'diff', '--name-only', '--no-renames', '-z', `${base}...${branch}`)
  return out.split('\0').filter((name) => name !== '')
}

/**
 * How a worker undoes a foreign change it COMMITTED (final review I1): the write tools are denied
 * on those files, so the reason has to name the git commands that still work -- restore a modified
 * or deleted file from the base, remove one it added -- and the commit that makes it the branch's.
 */
export function undoInstruction(base: string): string {
  return (
    `To undo committed changes to files you do not own, run \`git checkout ${base} -- <file>\` for each one you modified or deleted ` +
    'and `git rm <file>` (or `git rm --cached <file>` to keep it on disk) for each one you added, then commit; ' +
    'Edit and Write on those files are denied.'
  )
}

/**
 * The second enforcement of spec R4: a shell can write anywhere, so the files this task's branch
 * changed since it left the base branch are checked against its package's ownership before the run
 * is verified or its report filed (plan D7). Three-dot range: the NET change, so a rework that
 * reverted a foreign edit passes. A violation goes back through the same guarded rejection a
 * missing report uses, with every foreign file named up to FOREIGN_FILES_LISTED, and is recorded
 * as `task.ownership_violated` -- only when the rejection applied, so a replayed conclusion does
 * not count a second violation toward the Supervisor's `foreign_file` (Task 5).
 *
 * Returns whether verify may go on: true for a task with no rule (no package, or one that owns
 * everything) and for a branch that changed only what it owns.
 */
export async function auditOwnership(
  run: { readonly id: string; readonly slaveId: string },
  task: { readonly id: string; readonly workspaceId: string; readonly branch: string },
  workspace: { readonly repoPath: string; readonly baseBranch: string },
): Promise<boolean> {
  const rule = await ownershipRuleForTask(task.id)
  if (rule === null) return true
  const changed = await changedFiles(workspace.repoPath, workspace.baseBranch, task.branch)
  const foreign = changed.filter((path) => !isOwned(rule, path))
  if (foreign.length === 0) return true
  const listed = foreign.slice(0, FOREIGN_FILES_LISTED).join(', ')
  const more = foreign.length > FOREIGN_FILES_LISTED ? ` and ${String(foreign.length - FOREIGN_FILES_LISTED)} more` : ''
  const reason = `revert changes to files you do not own: ${listed}${more}. ${undoInstruction(workspace.baseBranch)}`
  const applied = await rejectRunBack(
    run,
    task,
    reason,
    `ownership: ${String(foreign.length)} foreign file(s)`,
    (attempt) => `still changing files it does not own after ${String(attempt)} attempts: ${listed}${more}`,
  )
  if (applied) {
    await appendEvent({
      type: 'task.ownership_violated',
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      actor: 'system',
      payload: { runId: run.id, files: foreign.slice(0, FOREIGN_FILES_RECORDED), total: foreign.length },
    })
  }
  return false
}
