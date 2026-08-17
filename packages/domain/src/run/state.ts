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

const ACTIVE: readonly RunStatus[] = ['starting', 'working', 'pause_requested', 'paused', 'resuming', 'stopping']

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
