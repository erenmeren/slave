import { describe, expect, it } from 'vitest'
import { displayName, rosterLine } from '../../src/run-context/names.js'

describe('displayName', () => {
  it('formats name and role', () => {
    expect(displayName({ name: 'Maya', role: 'Senior Engineer' })).toBe('Maya (Senior Engineer)')
  })
})

describe('rosterLine', () => {
  it('formats name, role, runtime roles and id', () => {
    expect(
      rosterLine({ id: 'abc', name: 'Maya', role: 'Senior Engineer', runtimeRoles: ['backend', 'reviewer'] }),
    ).toBe('Maya (Senior Engineer; roles: backend, reviewer) — id abc')
  })

  it('says "roles: none" for an empty runtime role set', () => {
    expect(rosterLine({ id: 'abc', name: 'Maya', role: 'Senior Engineer', runtimeRoles: [] })).toBe(
      'Maya (Senior Engineer; roles: none) — id abc',
    )
  })
})
