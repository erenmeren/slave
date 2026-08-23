import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import type { ControlRefusal } from './refusal.js'

/**
 * Set (or overwrite) a workspace's standing goal (M8b) -- the operator's instruction for what a
 * planning run (Task 6) should decompose into tasks.
 *
 * Succeeds even on a workspace that already has tasks on its board: the planning pass itself
 * (spec scope note) is what stays dormant until the board is empty, not this setter. An operator
 * revising the goal mid-milestone is ordinary, not a refusal.
 */
export async function setGoal(workspaceId: string, goal: string): Promise<Result<void, ControlRefusal>> {
  if (goal.trim() === '') return err({ kind: 'invalid_goal' })

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  await prisma.workspace.update({ where: { id: workspaceId }, data: { goal } })
  await appendEvent({ type: 'workspace.goal_set', workspaceId, actor: 'human', payload: { goal } })

  return ok(undefined)
}
