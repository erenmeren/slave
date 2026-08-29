import { err, ok, type Result } from '../result.js'

export type RunStatus =
  | 'starting'
  | 'working'
  | 'pause_requested'
  | 'paused'
  | 'resuming'
  | 'stopping'
  | 'stopped'
  | 'succeeded'
  | 'failed'

export interface RunState {
  readonly status: RunStatus
  readonly toolCalls: number
  readonly sessionId: string | null
  readonly pausedAtStep: number | null
}

export type RunEvent =
  | { readonly type: 'started'; readonly sessionId: string }
  | { readonly type: 'tool_call'; readonly name: string }
  | { readonly type: 'pause_requested' }
  /**
   * The pause was claimed but could not be signalled, so the claim is given back (M13 Decision 5).
   * `restoredTo` is the status the run held before the claim -- the machine has no memory of it, so
   * the writer that made the claim is the only thing that can name it.
   */
  | { readonly type: 'pause_unsignalled'; readonly restoredTo: 'starting' | 'working' | 'resuming' }
  | { readonly type: 'paused'; readonly atStep: number }
  | { readonly type: 'resume_requested' }
  | { readonly type: 'resumed'; readonly sessionId: string }
  | { readonly type: 'stop_requested' }
  | { readonly type: 'stopped' }
  | { readonly type: 'succeeded' }
  | { readonly type: 'failed'; readonly reason: string }

export interface IllegalRunTransition {
  readonly kind: 'illegal_run_transition'
  readonly from: RunStatus
  readonly event: RunEvent['type']
}

/** Every status that means "this run is not finished". The web and the orchestrator must agree. */
export const NON_TERMINAL_RUN_STATUSES = [
  'starting',
  'working',
  'pause_requested',
  'paused',
  'resuming',
  'stopping',
] as const satisfies readonly RunStatus[]

const ACTIVE: readonly RunStatus[] = NON_TERMINAL_RUN_STATUSES

export function initialRunState(): RunState {
  return { status: 'starting', toolCalls: 0, sessionId: null, pausedAtStep: null }
}

function illegal(state: RunState, event: RunEvent): Result<RunState, IllegalRunTransition> {
  return err({ kind: 'illegal_run_transition', from: state.status, event: event.type })
}

export function applyRunEvent(state: RunState, event: RunEvent): Result<RunState, IllegalRunTransition> {
  // A run may fail from any active status; the runtime can die at any moment.
  if (event.type === 'failed') {
    return ACTIVE.includes(state.status) ? ok({ ...state, status: 'failed' }) : illegal(state, event)
  }

  switch (state.status) {
    case 'starting':
      if (event.type === 'started') return ok({ ...state, status: 'working', sessionId: event.sessionId })
      return illegal(state, event)

    case 'working':
      if (event.type === 'tool_call') return ok({ ...state, toolCalls: state.toolCalls + 1 })
      if (event.type === 'pause_requested') return ok({ ...state, status: 'pause_requested' })
      if (event.type === 'stop_requested') return ok({ ...state, status: 'stopping' })
      if (event.type === 'succeeded') return ok({ ...state, status: 'succeeded' })
      return illegal(state, event)

    case 'pause_requested':
      // The claim, given back (M13 Decision 5). `requestPause` claims `pause_requested` before it
      // signals, because the claim is what makes the request idempotent; when the signal then
      // throws, the run is holding a status nothing is coming to resolve, and the machine needs a
      // legal way out. `restoredTo` is supplied by the writer because this machine keeps no
      // history -- `RunState` carries a status, not the one before it.
      if (event.type === 'pause_unsignalled') return ok({ ...state, status: event.restoredTo })
      if (event.type === 'paused') return ok({ ...state, status: 'paused', pausedAtStep: event.atStep })
      if (event.type === 'tool_call') return ok({ ...state, toolCalls: state.toolCalls + 1 })
      if (event.type === 'succeeded') return ok({ ...state, status: 'succeeded' })
      if (event.type === 'stop_requested') return ok({ ...state, status: 'stopping' })
      return illegal(state, event)

    case 'paused':
      if (event.type === 'resume_requested') return ok({ ...state, status: 'resuming' })
      if (event.type === 'stop_requested') return ok({ ...state, status: 'stopping' })
      return illegal(state, event)

    case 'resuming':
      if (event.type === 'resumed') {
        return ok({ ...state, status: 'working', sessionId: event.sessionId, pausedAtStep: null })
      }
      return illegal(state, event)

    case 'stopping':
      if (event.type === 'stopped') return ok({ ...state, status: 'stopped' })
      return illegal(state, event)

    case 'stopped':
    case 'succeeded':
    case 'failed':
      return illegal(state, event)
  }
}
