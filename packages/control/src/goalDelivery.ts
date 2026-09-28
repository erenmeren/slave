import { prisma } from '@slave-of-ai/db/client'
import { settleTaskEvidence } from './evidence.js'

/**
 * Plan 4a D4: the integration verdict of every package task of a goal version, settled when the
 * version's branch reaches the base branch -- by the goal pass, or by a person's confirmed hand
 * merge. "Integrated" in the ranker means "reached the base branch", which a package merged into
 * its integration branch has not yet done.
 */
export async function settleGoalEvidence(workspaceId: string, goalVersion: number): Promise<void> {
  const tasks = await prisma.task.findMany({
    where: { workspaceId, workPackage: { goalVersion }, integratedAt: { not: null } },
    select: { id: true },
  })
  for (const task of tasks) await settleTaskEvidence(task.id, { kind: 'integration', integrated: true })
}
