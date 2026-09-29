import { realpathSync } from 'node:fs'
import { prisma } from '@slave-of-ai/db/client'
import { isOwned, ownershipPatterns, ownershipRuleFor, type OwnershipRule } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { gitNameOnlyZ } from './gitNameList.js'
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

/**
 * The ownership rule of every verification run (Conductor Plan 4b, D1): it owns nothing, so the
 * gate denies `Write`/`Edit`/`NotebookEdit` on any path inside its worktree, and a path outside it
 * (the scratch directory `$SLAVEOFAI_VERIFY_DIR`) is not judged. Written at dispatch AND at resume
 * -- `writePermissionsFile` refuses a verification run's file without it.
 */
export function verificationOwnership(worktreePath: string): PermissionOwnership {
  return { worktreeRoot: resolvedRoot(worktreePath), owned: [], excluded: [] }
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
  // `gitNameOnlyZ`, not `gitIn` (final review I2): no trimming, and a 64 MiB buffer.
  return gitNameOnlyZ(repoPath, ['diff', '--name-only', '--no-renames', '-z', `${base}...${branch}`])
}

/**
 * How a worker undoes a foreign change it COMMITTED (final review I1): the write tools are denied
 * on those files, so the reason has to name the git commands that still work -- restore a modified
 * or deleted file from the base, remove one it added -- and the commit that makes it the branch's.
 * The restore names the MERGE-BASE, not the base branch's tip: the audit's three-dot range compares
 * against where the branch left the base, and a file the base branch changed since would otherwise
 * be "restored" to a version that is itself a change on this branch.
 */
export function undoInstruction(base: string): string {
  return (
    `To undo committed changes to files you do not own, run \`git checkout $(git merge-base ${base} HEAD) -- <file>\` for each one you modified or deleted ` +
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
 * An audit that cannot read the branch's changes (a missing ref, a git that fails) is a rejection
 * too, never a throw (final review I2): a throw left the task to the stranded-claim sweep, which
 * put it back without charging an attempt -- a free endless loop. This one is charged, so
 * `maxAttempts` bounds it, and it is not a violation: `foreign_file` does not count it.
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
  let changed: readonly string[]
  try {
    changed = await changedFiles(workspace.repoPath, workspace.baseBranch, task.branch)
  } catch (error) {
    const detail = auditFailureDetail(error)
    await rejectRunBack(
      run,
      task,
      `the ownership audit could not read what this branch changed: ${detail}`,
      `ownership audit failed: ${detail}`,
      (attempt) => `the ownership audit could not read what this branch changed after ${String(attempt)} attempts: ${detail}`,
    )
    return false
  }
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

/** git's own complaint (its stderr's first line) when there is one -- "fatal: ambiguous argument
 *  ..." says more than execFile's "Command failed" -- else the error's first line. */
function auditFailureDetail(error: unknown): string {
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr).trim() : ''
  const text = stderr !== '' ? stderr : error instanceof Error ? error.message : String(error)
  return text.split('\n')[0] ?? ''
}
