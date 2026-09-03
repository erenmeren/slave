import { describe, expect, it } from 'vitest'
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  digestEqual,
  mintSession,
  requestIsHttps,
  sessionCookieHeader,
  verifySession,
} from '../src/lib/session.js'

const SECRET = '0123456789abcdef0123456789abcdef'
const OTHER = 'fedcba9876543210fedcba9876543210'
const USER = '3f1c9a2e-0000-4000-8000-abcdefabcdef'
const NOW = new Date('2026-09-02T12:00:00Z')
const LATER = new Date(NOW.getTime() + 60_000)

describe('digestEqual', () => {
  it('is true for equal strings and false for different ones, regardless of length', async () => {
    expect(await digestEqual('hunter2', 'hunter2')).toBe(true)
    expect(await digestEqual('hunter2', 'hunter3')).toBe(false)
    expect(await digestEqual('hunter2', 'hunter22')).toBe(false)
    expect(await digestEqual('', '')).toBe(true)
  })
})

describe('mintSession / verifySession', () => {
  it('round-trips a freshly minted cookie and names the user it was minted for', async () => {
    const value = await mintSession(SECRET, USER, NOW)
    expect(value).toMatch(/^[A-Za-z0-9-]{1,64}\.\d+\.[0-9a-f]{64}$/)
    expect(value.split('.')[0]).toBe(USER)
    expect(await verifySession(SECRET, value, LATER)).toEqual({ userId: USER })
  })

  it('encodes an expiry exactly 30 days out', async () => {
    const value = await mintSession(SECRET, USER, NOW)
    const expiresAt = Number(value.split('.')[1])
    expect(expiresAt).toBe(Math.floor(NOW.getTime() / 1000) + SESSION_TTL_SECONDS)
    expect(SESSION_TTL_SECONDS).toBe(30 * 24 * 60 * 60)
  })

  it('is expired at, and after, its own expiry second', async () => {
    const value = await mintSession(SECRET, USER, NOW)
    const expiresAt = Number(value.split('.')[1])
    expect(await verifySession(SECRET, value, new Date(expiresAt * 1000))).toBeNull()
    expect(await verifySession(SECRET, value, new Date((expiresAt + 1) * 1000))).toBeNull()
    expect(await verifySession(SECRET, value, new Date((expiresAt - 1) * 1000))).toEqual({ userId: USER })
  })

  it('rejects a tampered signature', async () => {
    const value = await mintSession(SECRET, USER, NOW)
    const flipped = value.slice(0, -1) + (value.endsWith('0') ? '1' : '0')
    expect(await verifySession(SECRET, flipped, LATER)).toBeNull()
  })

  it('rejects a tampered expiry (the signature covers it)', async () => {
    const [userId, expiry, signature] = (await mintSession(SECRET, USER, NOW)).split('.')
    expect(await verifySession(SECRET, `${userId}.${Number(expiry) + 1000}.${signature}`, LATER)).toBeNull()
  })

  it('rejects a swapped user id — the signature covers it too, so no session is another user', async () => {
    const [, expiry, signature] = (await mintSession(SECRET, USER, NOW)).split('.')
    expect(await verifySession(SECRET, `someone-else.${expiry}.${signature}`, LATER)).toBeNull()
  })

  it.each([
    [null],
    [''],
    ['nodot'],
    ['a.b'],
    ['a.1.2.3'],
    ['user.abc.deadbeef'],
    ['user.1700000000.'],
    ['.1700000000.deadbeef'],
    ['user.-5.deadbeef'],
    ['us er.1700000000.deadbeef'],
    ['user_name.1700000000.deadbeef'],
    [`${'a'.repeat(65)}.1700000000.deadbeef`],
  ])('rejects the malformed value %j', async (value) => {
    expect(await verifySession(SECRET, value, LATER)).toBeNull()
  })

  it('invalidates every session when the secret changes', async () => {
    const value = await mintSession(SECRET, USER, NOW)
    expect(await verifySession(OTHER, value, LATER)).toBeNull()
  })
})

describe('sessionCookieHeader', () => {
  it('serialises the spec attributes, Secure only when asked', () => {
    expect(sessionCookieHeader('u.123.abc', { secure: false })).toBe(
      `${SESSION_COOKIE}=u.123.abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
    )
    expect(sessionCookieHeader('u.123.abc', { secure: true })).toBe(
      `${SESSION_COOKIE}=u.123.abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}; Secure`,
    )
  })

  it('clears with an empty value and Max-Age=0', () => {
    expect(sessionCookieHeader(null, { secure: false })).toBe(`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  })
})

describe('requestIsHttps', () => {
  it('reads the URL scheme or x-forwarded-proto', () => {
    expect(requestIsHttps(new Request('https://box.example/login'))).toBe(true)
    expect(requestIsHttps(new Request('http://box.example/login'))).toBe(false)
    expect(requestIsHttps(new Request('http://box.example/login', { headers: { 'x-forwarded-proto': 'https' } }))).toBe(true)
  })
})

describe('the retired bearer', () => {
  it('is gone from the module — accounts mode accepts the cookie only (spec §7 F4)', async () => {
    const module: Record<string, unknown> = await import('../src/lib/session.js')
    expect(Object.keys(module)).not.toContain('verifyBearer')
  })
})
