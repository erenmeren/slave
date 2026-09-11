import { TERMINAL, type TaskStatus } from '../task/state.js'
import type { SlaveLifecycle } from './types.js'

/**
 * The five facts {@link isReleasable} decides on, and the whole of what the rule reads.
 *
 * Deliberately NOT a `SupervisorSlave`: control re-asks the same question of Prisma rows under a
 * row lock, and a shape both sides can build is what keeps one rule from becoming two that drift
 * (the `AnswerEligibility` precedent in `../supervisor/policy.ts`).
 *
 * `engagementTaskStatus` is the status of the ONE task this worker was brought in for, or null when
 * the worker names no task or the world no longer holds it. `openAssignedTasks` counts the
 * non-terminal tasks whose `assigneeId` is this worker.
 */
export interface ReleasableWorker {
  readonly lifecycle: SlaveLifecycle
  readonly released: boolean
  readonly busy: boolean
  readonly engagementTaskStatus: TaskStatus | null
  readonly openAssignedTasks: number
}

/**
 * Is this worker's engagement over (M50 R3)? Pure and total.
 *
 * Five clauses, each of which would otherwise release somebody who is still working:
 *
 *  - only an `ephemeral` worker is released at all. A `project` worker leaves by `deleteSlave`
 *    (M23) and a `permanent` one by leaving the roster; neither is this rule's business.
 *  - an already-released worker is not released twice -- the row keeps the timestamp and the
 *    sentence the first release wrote.
 *  - a BUSY worker holds a live run. Emptying its runtime roles under that run would leave the
 *    record and the roster disagreeing about who the run belongs to.
 *  - the engagement task must be TERMINAL -- `done`, `failed` or `cancelled`. A failed assignment is
 *    over as surely as a finished one; what is NOT over is one still on the board, and a worker
 *    whose task the world cannot find is not evidence of anything.
 *  - nothing else may be assigned to it. `Task.assigneeId` is written by nobody in the pipeline
 *    today, which makes this clause quiet rather than redundant: a hand-assigned task is a real
 *    row, and releasing the only worker who holds it would strand it.
 */
export function isReleasable(worker: ReleasableWorker): boolean {
  if (worker.lifecycle !== 'ephemeral') return false
  if (worker.released) return false
  if (worker.busy) return false
  if (worker.engagementTaskStatus === null) return false
  if (!TERMINAL.includes(worker.engagementTaskStatus)) return false
  return worker.openAssignedTasks === 0
}
