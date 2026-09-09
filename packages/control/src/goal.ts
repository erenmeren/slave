import { prisma } from '@slave-of-ai/db/client'
import { goalSha256, type Result, err, ok } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

/**
 * Set (or overwrite) a workspace's standing goal (M8b) -- the operator's instruction for what a
 * planning run (Task 6) should decompose into tasks.
 *
 * Succeeds even on a workspace that already has tasks on its board: the planning pass itself
 * (spec scope note) is what stays dormant until the board is empty, not this setter. An operator
 * revising the goal mid-milestone is ordinary, not a refusal.
 */
export async function setGoal(
  workspaceId: string,
  goal: string,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  if (goal.trim() === '') return err({ kind: 'invalid_goal' })

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { goal, goalSetByUserId: principal?.userId ?? null },
  })
  await appendEvent({
    type: 'workspace.goal_set',
    workspaceId,
    actor: 'human',
    // M40 t1: the content hash of the goal just set -- the one field this verb can already say
    // truthfully. `version` is deliberately ABSENT until M40 Task 2 makes this verb transactional
    // and versioned: no `GoalVersion` row is inserted here yet, and naming a version this write
    // did not create would be a claim the table does not back. The payload schema keeps both
    // fields optional, so a pre-M40 row and this interim one both read back.
    payload: { goal, sha256: goalSha256(goal) },
    userId: principal?.userId ?? null,
  })

  return ok(undefined)
}
