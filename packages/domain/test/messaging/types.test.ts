import { describe, expect, it } from 'vitest'
import { isValidRecipient } from '../../src/messaging/types.js'

describe('isValidRecipient', () => {
  it('accepts a named slave alone', () => {
    expect(isValidRecipient({ slaveId: 's1', role: null })).toBe(true)
  })

  it('accepts a role alone', () => {
    expect(isValidRecipient({ slaveId: null, role: 'reviewer' })).toBe(true)
  })

  it('refuses neither set', () => {
    expect(isValidRecipient({ slaveId: null, role: null })).toBe(false)
  })

  it('refuses both set', () => {
    expect(isValidRecipient({ slaveId: 's1', role: 'reviewer' })).toBe(false)
  })

  it('treats a blank string as unset on either side', () => {
    expect(isValidRecipient({ slaveId: '', role: 'reviewer' })).toBe(true)
    expect(isValidRecipient({ slaveId: 's1', role: '  ' })).toBe(true)
    expect(isValidRecipient({ slaveId: '', role: '' })).toBe(false)
  })
})
