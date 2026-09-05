import { describe, expect, it } from 'vitest'
import { deriveSlaveStatus } from '../../src/slave/derived.js'
import { initialRunState, type RunState, type RunStatus } from '../../src/run/state.js'

function runWith(status: RunStatus): RunState {
  return { ...initialRunState(), status }
}

describe('deriveSlaveStatus', () => {
  it('is idle when there is no active run', () => {
    expect(deriveSlaveStatus(null)).toBe('idle')
  })

  it('maps each active run status to an slave status', () => {
    expect(deriveSlaveStatus(runWith('starting'))).toBe('starting')
    expect(deriveSlaveStatus(runWith('working'))).toBe('working')
    expect(deriveSlaveStatus(runWith('pause_requested'))).toBe('pausing')
    expect(deriveSlaveStatus(runWith('paused'))).toBe('paused')
    expect(deriveSlaveStatus(runWith('resuming'))).toBe('resuming')
    expect(deriveSlaveStatus(runWith('stopping'))).toBe('stopping')
  })

  it('is idle once the run reaches a terminal status', () => {
    expect(deriveSlaveStatus(runWith('succeeded'))).toBe('idle')
    expect(deriveSlaveStatus(runWith('failed'))).toBe('idle')
    expect(deriveSlaveStatus(runWith('stopped'))).toBe('idle')
  })
})
