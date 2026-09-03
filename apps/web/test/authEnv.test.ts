import { afterEach, describe, expect, it, vi } from 'vitest'
import { boundaryMode, sessionSecret } from '../src/lib/authEnv.js'

describe('authEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is loopback mode when the variable is absent or blank', () => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', undefined)
    expect(sessionSecret()).toBeNull()
    expect(boundaryMode()).toBe('loopback-only')
    vi.stubEnv('AITEAMOS_SESSION_SECRET', '   ')
    expect(sessionSecret()).toBeNull()
    expect(boundaryMode()).toBe('loopback-only')
  })

  it('is accounts mode with the trimmed secret otherwise', () => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', '  0123456789abcdef0123456789abcdef \n')
    expect(sessionSecret()).toBe('0123456789abcdef0123456789abcdef')
    expect(boundaryMode()).toBe('accounts')
  })

  it('does not read the retired password variable', () => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', undefined)
    vi.stubEnv('AITEAMOS_PASSWORD', 'hunter2')
    expect(sessionSecret()).toBeNull()
    expect(boundaryMode()).toBe('loopback-only')
  })
})
