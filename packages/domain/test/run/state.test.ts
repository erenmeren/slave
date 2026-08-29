import { describe, expect, it } from 'vitest'
import { applyRunEvent, initialRunState, type RunEvent, type RunState } from '../../src/run/state.js'

function drive(state: RunState, events: readonly RunEvent[]): RunState {
  return events.reduce((current, event) => {
    const result = applyRunEvent(current, event)
    if (!result.ok) throw new Error(`illegal: ${result.error.from} + ${result.error.event}`)
    return result.value
  }, state)
}

describe('applyRunEvent', () => {
  it('starts in starting', () => {
    expect(initialRunState().status).toBe('starting')
  })

  it('captures the session id when the run begins working', () => {
    const state = drive(initialRunState(), [{ type: 'started', sessionId: 'sess-1' }])
    expect(state.status).toBe('working')
    expect(state.sessionId).toBe('sess-1')
  })

  it('counts tool calls', () => {
    const state = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'tool_call', name: 'Read' },
      { type: 'tool_call', name: 'Edit' },
    ])
    expect(state.toolCalls).toBe(2)
  })

  it('walks the pause cycle back to working', () => {
    const state = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'tool_call', name: 'Read' },
      { type: 'pause_requested' },
      { type: 'paused', atStep: 1 },
      { type: 'resume_requested' },
      { type: 'resumed', sessionId: 'sess-1' },
    ])
    expect(state.status).toBe('working')
    expect(state.pausedAtStep).toBeNull()
  })

  it('records the step at which it paused', () => {
    const state = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'tool_call', name: 'Read' },
      { type: 'pause_requested' },
      { type: 'paused', atStep: 1 },
    ])
    expect(state.status).toBe('paused')
    expect(state.pausedAtStep).toBe(1)
  })

  it('updates the session id when resume returns a new one', () => {
    const state = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'pause_requested' },
      { type: 'paused', atStep: 0 },
      { type: 'resume_requested' },
      { type: 'resumed', sessionId: 'sess-2' },
    ])
    expect(state.sessionId).toBe('sess-2')
  })

  it('allows stopping from paused', () => {
    const state = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'pause_requested' },
      { type: 'paused', atStep: 0 },
      { type: 'stop_requested' },
      { type: 'stopped' },
    ])
    expect(state.status).toBe('stopped')
  })

  it('reaches succeeded from working', () => {
    const state = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'succeeded' },
    ])
    expect(state.status).toBe('succeeded')
  })

  it('rejects a pause request on a finished run', () => {
    const finished = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'succeeded' },
    ])
    const result = applyRunEvent(finished, { type: 'pause_requested' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.from).toBe('succeeded')
  })

  it('rejects a tool call before the run has started', () => {
    const result = applyRunEvent(initialRunState(), { type: 'tool_call', name: 'Read' })
    expect(result.ok).toBe(false)
  })

  it('counts tool calls while pause is requested but not yet paused', () => {
    const state = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'pause_requested' },
      { type: 'tool_call', name: 'Read' },
    ])
    expect(state.toolCalls).toBe(1)
    expect(state.status).toBe('pause_requested')
  })

  it('gives a claimed pause back to the status it interrupted when the signal could not be sent', () => {
    const state = drive(initialRunState(), [
      { type: 'started', sessionId: 'sess-1' },
      { type: 'tool_call', name: 'Read' },
      { type: 'pause_requested' },
      { type: 'pause_unsignalled', restoredTo: 'working' },
    ])
    expect(state.status).toBe('working')
    // The claim's rollback is not a step backwards through the run's history: the work it counted
    // stays counted.
    expect(state.toolCalls).toBe(1)
  })

  it('refuses to un-claim a pause that was never claimed', () => {
    const working = drive(initialRunState(), [{ type: 'started', sessionId: 'sess-1' }])
    const result = applyRunEvent(working, { type: 'pause_unsignalled', restoredTo: 'working' })
    expect(result.ok).toBe(false)
  })
})
