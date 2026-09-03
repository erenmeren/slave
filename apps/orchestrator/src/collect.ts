import { prisma } from '@ai-team-os/db/client'
import { TERMINAL } from '@ai-team-os/domain'
import { collectTaskWorktree, refusalText, terminalTimestamp } from '@ai-team-os/control'

export interface CollectDeps { readonly workspaceId: string; readonly now: () => Date; readonly ttlMs: number }
export interface CollectReport { readonly collected: readonly { readonly taskId: string; readonly path: string }[]; readonly skipped: number }

/** Spec §3 B2/B3: every terminal task that still owns a tree, aged past the TTL, collected one
 *  by one. Never throws for one task's sake; a database failure on the candidate query still
 *  throws, and the daemon's `runCollect` catches it. */
export async function collectWorktrees(deps: CollectDeps): Promise<CollectReport> {
  const candidates = await prisma.task.findMany({
    where: { workspaceId: deps.workspaceId, status: { in: [...TERMINAL] }, runs: { some: { worktreePath: { not: null } } } },
    select: { id: true },
  })
  const collected: { taskId: string; path: string }[] = []
  let skipped = 0
  for (const { id } of candidates) {
    try {
      const at = await terminalTimestamp(id)
      // Not yet aged past the TTL, or a terminal task with no terminal event to date it by at
      // all: the ordinary case, not a failure -- counted as skipped with no stderr line.
      if (at === null || deps.now().getTime() - at.getTime() < deps.ttlMs) {
        skipped += 1
        continue
      }
      const result = await collectTaskWorktree(id, 'aged')
      if (result.ok) {
        collected.push({ taskId: id, path: result.value.path })
      } else {
        // A refusal (`run_still_alive`, `worktree_remove_failed`, ...) is a real reason this
        // task did not collect -- unlike the ageing check above, an operator should be able to
        // find out why from the log, not just that the count went up.
        skipped += 1
        process.stderr.write(`[collect] task ${id}: ${refusalText(result.error)}\n`)
      }
    } catch (error) {
      skipped += 1
      process.stderr.write(`[collect] task ${id}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  return { collected, skipped }
}
