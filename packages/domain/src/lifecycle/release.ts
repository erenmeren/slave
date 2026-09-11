import { TERMINAL, type TaskStatus } from '../task/state.js'
import type { SlaveLifecycle } from './types.js'

/**
 * The five facts {@link isReleasable} decides on, and the whole of what the rule reads.
 *
 * Deliberately NOT a `SupervisorSlave`: this is the whole of what the RULE reads, five flat facts
 * a caller with Prisma rows can assemble as easily as one with a world, and keeping it that narrow
 * is what stops the predicate from growing a dependency on the Supervisor's own shape (the
 * `AnswerEligibility` precedent in `../supervisor/policy.ts`).
 *
 * Control does NOT re-ask this question (M50 final review, Minor 1). `releaseWorker` applies a
 * deliberately LOOSER rule under its row lock -- `slave_not_found`, `not_ephemeral`,
 * `already_released`, `live_runs` -- and accepts a release whatever the engagement state, because a
 * person may end an engagement early and `release-worker` asks for no finished task. So the two are
 * not one rule in two places: this decides who the Supervisor OFFERS to release, and control
 * decides what it will actually write. The three facts they do share -- ephemeral, not already
 * released, no live run -- are refused on both sides, so the observe-to-apply race ends in a
 * refusal rather than a bad write.
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
