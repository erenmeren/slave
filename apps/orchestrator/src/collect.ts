import { prisma } from '@ai-team-os/db/client'
import { TERMINAL } from '@ai-team-os/domain'
import { collectTaskWorktree, terminalTimestamp } from '@ai-team-os/control'

export interface CollectDeps { readonly workspaceId: string; readonly now: () => Date; readonly ttlMs: number }
export interface CollectReport { readonly collected: readonly { readonly taskId: string; readonly path: string }[]; readonly skipped: number }

/** Spec §3 B2/B3: every terminal task that still owns a tree, aged past the TTL, collected one
 *  by one. A refusal or a git failure on one task is logged and skipped; the pass never throws. */
export async function collectWorktrees(deps: CollectDeps): Promise<CollectReport> {
  const candidates = await prisma.task.findMany({
    where: { workspaceId: deps.workspaceId, status: { in: [...TERMINAL] }, runs: { some: { worktreePath: { not: null } } } },
    select: { id: true },
  })
  const collected: { taskId: string; path: string }[] = []
  let skipped = 0
  for (const { id } of candidates) {
    const at = await terminalTimestamp(id)
    if (at === null || deps.now().getTime() - at.getTime() < deps.ttlMs) { skipped += 1; continue }
    try {
      const result = await collectTaskWorktree(id, 'aged')
      if (result.ok) collected.push({ taskId: id, path: result.value.path })
      else skipped += 1
    } catch (error) {
      skipped += 1
      process.stderr.write(`[collect] task ${id}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  return { collected, skipped }
}
