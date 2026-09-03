import { describe, expect, it } from 'vitest'
import { dummyHash, hashPassword, hashWithSalt, verifyPassword } from '../src/password.js'

// Known-answer vector, computed ONCE with:
//   node -e "const c=require('crypto');console.log(c.pbkdf2Sync('correct horse battery staple',
//     Buffer.from('000102030405060708090a0b0c0d0e0f','hex'),600000,32,'sha256').toString('hex'))"
// and pasted here as a literal so the test never re-derives it (that would just be testing the
// implementation against itself).
const PASSWORD = 'correct horse battery staple'
const SALT_HEX = '000102030405060708090a0b0c0d0e0f'
const SALT = Uint8Array.from(Buffer.from(SALT_HEX, 'hex'))
const EXPECTED_HASH_HEX = 'ef177144eec9420cbc1093d2a8b344a92bc506d0d4ec9c028dd19f8324d8c1e6'
const EXPECTED_STORED = `pbkdf2-sha256$600000$${SALT_HEX}$${EXPECTED_HASH_HEX}`

describe('hashWithSalt', () => {
  it('matches the known-answer vector', async () => {
    expect(await hashWithSalt(PASSWORD, SALT)).toBe(EXPECTED_STORED)
  })
})

describe('hashPassword / verifyPassword', () => {
  it('round-trips: a hashed password verifies against itself', async () => {
    const stored = await hashPassword('a reasonably long passphrase')
    expect(await verifyPassword('a reasonably long passphrase', stored)).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('a reasonably long passphrase')
    expect(await verifyPassword('not the right one', stored)).toBe(false)
  })

  it('rejects a malformed stored string', async () => {
    expect(await verifyPassword('whatever', 'not-a-real-hash')).toBe(false)
    expect(await verifyPassword('whatever', 'pbkdf2-sha256$notanumber$aa$bb')).toBe(false)
    expect(await verifyPassword('whatever', 'bcrypt$10$aa$bb')).toBe(false)
  })

  it('two hashes of the same password use different salts', async () => {
    const a = await hashPassword('same password twice')
    const b = await hashPassword('same password twice')
    expect(a).not.toBe(b)
  })
})

describe('dummyHash', () => {
  it('is memoized: repeated calls return the same value', async () => {
    const a = await dummyHash()
    const b = await dummyHash()
    expect(a).toBe(b)
  })

  it('a real hash and dummyHash() both cost a real derivation (>= 50 ms)', async () => {
    const startReal = performance.now()
    await hashPassword('timing check password')
    const realElapsed = performance.now() - startReal

    const startDummy = performance.now()
    await verifyPassword('irrelevant', await dummyHash())
    const dummyElapsed = performance.now() - startDummy

    expect(realElapsed).toBeGreaterThanOrEqual(50)
    expect(dummyElapsed).toBeGreaterThanOrEqual(50)
  })
})
