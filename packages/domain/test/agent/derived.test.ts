import { describe, expect, it } from 'vitest'
import { deriveAgentStatus } from '../../src/agent/derived.js'
import { initialRunState, type RunState, type RunStatus } from '../../src/run/state.js'

function runWith(status: RunStatus): RunState {
  return { ...initialRunState(), status }
}

describe('deriveAgentStatus', () => {
  it('is idle when there is no active run', () => {
    expect(deriveAgentStatus(null)).toBe('idle')
  })

  it('maps each active run status to an agent status', () => {
    expect(deriveAgentStatus(runWith('starting'))).toBe('starting')
    expect(deriveAgentStatus(runWith('working'))).toBe('working')
    expect(deriveAgentStatus(runWith('pause_requested'))).toBe('pausing')
    expect(deriveAgentStatus(runWith('paused'))).toBe('paused')
    expect(deriveAgentStatus(runWith('resuming'))).toBe('resuming')
    expect(deriveAgentStatus(runWith('stopping'))).toBe('stopping')
  })

  it('is idle once the run reaches a terminal status', () => {
    expect(deriveAgentStatus(runWith('succeeded'))).toBe('idle')
    expect(deriveAgentStatus(runWith('failed'))).toBe('idle')
    expect(deriveAgentStatus(runWith('stopped'))).toBe('idle')
  })
})
