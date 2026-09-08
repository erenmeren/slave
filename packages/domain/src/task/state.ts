import { err, ok, type Result } from '../result.js'
import type { SlaveId, RunId } from '../ids.js'

export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'blocked'
  | 'assigned'
  | 'running'
  | 'verifying'
  | 'reviewing'
  | 'merging'
  | 'rework'
  /**
   * Waiting for another slave to answer a question (M36 t2). Deliberately NOT `blocked`: M35 gave
   * `blocked` the meaning "a human must look at this", with `unblock-task` as its only exit, while
   * this state resolves by itself the moment an answer arrives. Not startable either -- the asking
   * run is still paused mid-session and still holds the worktree, so handing the task to a second
   * slave would put two of them on one branch.
   */
  | 'waiting'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface TaskState {
  readonly status: TaskStatus
  readonly assigneeId: SlaveId | null
  readonly activeRunId: RunId | null
  readonly attempt: number
  readonly maxAttempts: number
  readonly lastRejectionReason: string | null
}

export type TaskEvent =
  | { readonly type: 'dependencies_satisfied' }
  | { readonly type: 'dependencies_unmet' }
  | { readonly type: 'assigned'; readonly slaveId: SlaveId }
  | { readonly type: 'run_started'; readonly runId: RunId }
  | { readonly type: 'run_succeeded' }
  | { readonly type: 'run_failed'; readonly reason: string }
  | { readonly type: 'verify_passed' }
  | { readonly type: 'verify_failed'; readonly reason: string }
  | { readonly type: 'review_approved' }
  | { readonly type: 'review_rejected'; readonly reason: string }
  | { readonly type: 'merged' }
  | { readonly type: 'merge_failed'; readonly reason: string }
  | { readonly type: 'cancelled' }

export interface IllegalTransition {
  readonly kind: 'illegal_transition'
  readonly from: TaskStatus
  readonly event: TaskEvent['type']
}

/** Which statuses end a task's life. Exported (M23 B1) for `collectTaskWorktree`'s own terminal
 *  check -- the same set that ends `applyTaskEvent`'s state machine gates whether a worktree is
 *  ever safe to remove. */
export const TERMINAL: readonly TaskStatus[] = ['done', 'failed', 'cancelled']

export function initialTaskState(maxAttempts: number): TaskState {
  return {
    status: 'backlog',
    assigneeId: null,
    activeRunId: null,
    attempt: 0,
    maxAttempts,
    lastRejectionReason: null,
  }
}

function illegal(state: TaskState, event: TaskEvent): Result<TaskState, IllegalTransition> {
  return err({ kind: 'illegal_transition', from: state.status, event: event.type })
}

/** Route a rejection: back to rework, or to failed when attempts are exhausted. */
function reject(state: TaskState, reason: string): Result<TaskState, IllegalTransition> {
  const exhausted = state.attempt >= state.maxAttempts
  return ok({
    ...state,
    status: exhausted ? 'failed' : 'rework',
    activeRunId: null,
    lastRejectionReason: reason,
  })
}

export function applyTaskEvent(state: TaskState, event: TaskEvent): Result<TaskState, IllegalTransition> {
  if (event.type === 'cancelled') {
    return TERMINAL.includes(state.status)
      ? illegal(state, event)
      : ok({ ...state, status: 'cancelled', activeRunId: null })
  }

  switch (state.status) {
    case 'backlog':
    case 'blocked':
      if (event.type === 'dependencies_satisfied') return ok({ ...state, status: 'ready' })
      if (event.type === 'dependencies_unmet') return ok({ ...state, status: 'blocked' })
      return illegal(state, event)

    case 'ready':
    case 'rework':
      if (event.type === 'assigned') return ok({ ...state, status: 'assigned', assigneeId: event.slaveId })
      if (event.type === 'dependencies_unmet') return ok({ ...state, status: 'blocked' })
      return illegal(state, event)

    case 'assigned':
      if (event.type === 'run_started') {
        return ok({ ...state, status: 'running', activeRunId: event.runId, attempt: state.attempt + 1 })
      }
      return illegal(state, event)

    case 'running':
      if (event.type === 'run_succeeded') return ok({ ...state, status: 'verifying', activeRunId: null })
      if (event.type === 'run_failed') return reject(state, event.reason)
      return illegal(state, event)

    case 'verifying':
      if (event.type === 'verify_passed') return ok({ ...state, status: 'reviewing' })
      if (event.type === 'verify_failed') return reject(state, event.reason)
      return illegal(state, event)

    case 'reviewing':
      if (event.type === 'review_approved') return ok({ ...state, status: 'merging' })
      if (event.type === 'review_rejected') return reject(state, event.reason)
      return illegal(state, event)

    case 'merging':
      if (event.type === 'merged') return ok({ ...state, status: 'done', lastRejectionReason: null })
      if (event.type === 'merge_failed') return reject(state, event.reason)
      return illegal(state, event)

    case 'waiting':
      // M36 t2: no edge in or out of here, on purpose. This machine is the pure model of the
      // events a task's own lifecycle produces; the ask/answer loop is driven from outside it --
      // `apps/orchestrator/src/ask.ts` parks the task and Task 3's delivery releases it -- exactly
      // as M35's `blocked` park (`review.ts`, `verify.ts`) and `unblockTask` are. Every `TaskEvent`
      // there is arrives for a run that is paused, not concluded, so none of them is legal here.
      return illegal(state, event)

    case 'done':
    case 'failed':
    case 'cancelled':
      return illegal(state, event)
  }
}
