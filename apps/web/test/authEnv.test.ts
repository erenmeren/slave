import { afterEach, describe, expect, it, vi } from 'vitest'
import { boundaryMode, configuredPassword } from '../src/lib/authEnv.js'

describe('authEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is loopback mode when the variable is absent or blank', () => {
    vi.stubEnv('AITEAMOS_PASSWORD', undefined)
    expect(configuredPassword()).toBeNull()
    expect(boundaryMode()).toBe('loopback-only')
    vi.stubEnv('AITEAMOS_PASSWORD', '   ')
    expect(configuredPassword()).toBeNull()
    expect(boundaryMode()).toBe('loopback-only')
  })

  it('is password mode with the trimmed value otherwise', () => {
    vi.stubEnv('AITEAMOS_PASSWORD', '  hunter2 \n')
    expect(configuredPassword()).toBe('hunter2')
    expect(boundaryMode()).toBe('password')
  })
})
