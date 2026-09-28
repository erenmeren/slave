import { realpathSync } from 'node:fs'
import { prisma } from '@slave-of-ai/db/client'
import { ownershipPatterns, ownershipRuleFor, type OwnershipRule } from '@slave-of-ai/domain'

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
