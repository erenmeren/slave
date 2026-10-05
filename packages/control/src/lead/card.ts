import { prisma } from '@slave-of-ai/db/client'
import { type Result, err, ok } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { gitIn } from '../git.js'
import { abandonGoal, withDeliveryLock } from '../goalDelivery.js'
import type { Principal } from '../principal.js'
import type { ControlRefusal } from '../refusal.js'

/** The task statuses of a lead that will not work again: nothing runs them, so they are taken off the board. */
const UNFINISHED = ['ready', 'rework', 'blocked'] as const

/**
 * Lead-flow spec D2 in its smallest form (plan A L13): a person accepts a stopped lead-flow version
 * as it is. Under the delivery's lock: `needs_human → accepted` with `verifiedCommit` = the work
 * branch's tip (what the goal pass's merge lands), the stop's reason replaced by `accepted_as_is`,
 * and the lead's unfinished task cancelled -- the lead will not work on it again. The goal pass then
 * merges it or waits for the hand merge, as for any accepted version.
 *
 * `'none'`, with nothing written, for any other version: one not built by a lead (`leadState`
 * null), or one that is not stopped -- so the card's Approve keeps meaning what it meant.
 */
export async function acceptLeadGoalAsIs(workspaceId: string, goalVersion: number, principal?: Principal): Promise<Result<'applied' | 'none', ControlRefusal>> {
  const found = await prisma.goalDelivery.findUnique({
    where: { workspaceId_goalVersion: { workspaceId, goalVersion } },
    include: { workspace: { select: { repoPath: true } } },
  })
  if (found === null) return err({ kind: 'goal_version_not_found', workspaceId, goalVersion })
  if (found.leadState === null || found.status !== 'needs_human') return ok('none')
  const tip = await gitIn(found.workspace.repoPath, 'rev-parse', `refs/heads/${found.integrationBranch}`)

  const cancelled = await withDeliveryLock(found.id, async (tx): Promise<readonly string[] | null> => {
    // The guarded move is the first write: a version something else moved meanwhile is left alone.
    const moved = await tx.goalDelivery.updateMany({
      where: { id: found.id, status: 'needs_human' },
      data: { status: 'accepted', acceptedAt: new Date(), verifiedCommit: tip, needsHumanReason: null, stopReason: 'accepted_as_is' },
    })
    if (moved.count === 0) return null
    const tasks = await tx.task.findMany({ where: { workspaceId, workPackage: { goalVersion }, status: { in: [...UNFINISHED] }, activeRunId: null }, select: { id: true } })
    const ids = tasks.map((task) => task.id)
    await tx.task.updateMany({ where: { id: { in: ids } }, data: { status: 'cancelled', lastRejectionReason: `goal v${String(goalVersion)} was accepted as it is` } })
    return ids
  })
  if (cancelled === null) return ok('none')
  for (const taskId of cancelled) {
    await appendEvent({ type: 'task.cancelled', workspaceId, taskId, actor: 'human', payload: { reason: `goal v${String(goalVersion)} was accepted as it is`, goalVersion }, userId: principal?.userId ?? null })
  }
  return ok('applied')
}

/**
 * Plan A L13: a person leaves a stopped lead-flow version. The existing `abandonGoal` -- the work
 * branch stays, its unfinished task is cancelled, the next goal version may be conducted -- with
 * the stop's reason replaced by `left`. `'none'` for a version not built by a lead.
 */
export async function leaveLeadGoal(workspaceId: string, goalVersion: number, principal?: Principal): Promise<Result<'applied' | 'none', ControlRefusal>> {
  const found = await prisma.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId, goalVersion } }, select: { id: true, leadState: true, status: true } })
  if (found === null) return err({ kind: 'goal_version_not_found', workspaceId, goalVersion })
  if (found.leadState === null || found.status !== 'needs_human') return ok('none')
  const abandoned = await abandonGoal(workspaceId, goalVersion, principal)
  if (!abandoned.ok) return abandoned
  await prisma.goalDelivery.update({ where: { id: found.id }, data: { stopReason: 'left' } })
  return ok('applied')
}
