import { prisma } from '@slave-of-ai/db/client'
import { type Result, err, ok } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { settleTaskEvidence } from './evidence.js'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

/**
 * The human's half of M35 t2: `merge.ts`'s `!autoMerge` path marks a task `done` with no git
 * merge, on purpose (spec Decision 5), and leaves `Task.integratedAt` null -- `world.ts`'s
 * dependency gate then keeps every dependent of that task waiting. This is the ONLY other writer
 * of that column (the real-merge path in `merge.ts` is the other): an operator, having merged the
 * branch by hand, says so, and whatever was waiting on it becomes schedulable on the next tick.
 *
 * Conditioned on `status: 'done', integratedAt: null` in the same `updateMany` that claims the
 * stamp -- the same idiom `restoreWorkspace`'s clear uses (`workspace.ts`): two confirmations
 * racing each other both pass the reads below, the winner's `updateMany` claims it, the loser's
 * `count` is 0 and it answers `already_integrated`, exactly the refusal it would get arriving a
 * moment later instead of at the same instant.
 */
export async function confirmIntegration(
  taskId: string,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const task = await prisma.task.findUnique({ where: { id: taskId } })
  if (task === null) return err({ kind: 'task_not_found', taskId })
  if (task.status !== 'done') return err({ kind: 'task_not_done', taskId, status: task.status })
  if (task.integratedAt !== null) return err({ kind: 'already_integrated', taskId })

  const integratedAt = new Date()
  const claimed = await prisma.task.updateMany({
    where: { id: taskId, status: 'done', integratedAt: null },
    data: { integratedAt },
  })
  if (claimed.count === 0) return err({ kind: 'already_integrated', taskId })

  await appendEvent({
    type: 'task.integrated',
    workspaceId: task.workspaceId,
    taskId,
    actor: 'human',
    payload: {},
    userId: principal?.userId ?? null,
  })

  // M53 R4: the human half of the integration verdict. AFTER the event, for `promote`'s reason
  // (M49 R2d) and for one of its own: `settleTaskEvidence` resolves the task's implementation run,
  // and the row it settles is the IMPLEMENTER's -- the person confirming a merge is judging the
  // work, not the confirmation. A crash between the two leaves an event with no fact rather than a
  // fact with no event, which is the direction R7's backfill can repair.
  await settleTaskEvidence(taskId, { kind: 'integration', integrated: true })
  return ok(undefined)
}
