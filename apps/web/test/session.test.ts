import { describe, expect, it } from 'vitest'
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  digestEqual,
  mintSession,
  requestIsHttps,
  sessionCookieHeader,
  verifyBearer,
  verifySession,
} from '../src/lib/session.js'

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
  it('round-trips a freshly minted cookie', async () => {
    const value = await mintSession('hunter2', NOW)
    expect(value).toMatch(/^\d+\.[0-9a-f]{64}$/)
    expect(await verifySession('hunter2', value, LATER)).toBe(true)
  })

  it('encodes an expiry exactly 30 days out', async () => {
    const value = await mintSession('hunter2', NOW)
    const expiresAt = Number(value.split('.')[0])
    expect(expiresAt).toBe(Math.floor(NOW.getTime() / 1000) + SESSION_TTL_SECONDS)
    expect(SESSION_TTL_SECONDS).toBe(30 * 24 * 60 * 60)
  })

  it('is expired at, and after, its own expiry second', async () => {
    const value = await mintSession('hunter2', NOW)
    const expiresAt = Number(value.split('.')[0])
    expect(await verifySession('hunter2', value, new Date(expiresAt * 1000))).toBe(false)
    expect(await verifySession('hunter2', value, new Date((expiresAt - 1) * 1000))).toBe(true)
  })

  it('rejects a tampered signature', async () => {
    const value = await mintSession('hunter2', NOW)
    const flipped = value.slice(0, -1) + (value.endsWith('0') ? '1' : '0')
    expect(await verifySession('hunter2', flipped, LATER)).toBe(false)
  })

  it('rejects a tampered expiry (the signature no longer matches)', async () => {
    const value = await mintSession('hunter2', NOW)
    const [expiry, signature] = value.split('.')
    expect(await verifySession('hunter2', `${Number(expiry) + 1000}.${signature}`, LATER)).toBe(false)
  })

  it.each([[null], [''], ['nodot'], ['1.2.3'], ['abc.def'], ['1700000000.'], ['.deadbeef'], ['-5.deadbeef']])(
    'rejects the malformed value %j',
    async (value) => {
      expect(await verifySession('hunter2', value, LATER)).toBe(false)
    },
  )

  it('invalidates every session when the password changes', async () => {
    const value = await mintSession('hunter2', NOW)
    expect(await verifySession('hunter3', value, LATER)).toBe(false)
  })
})

describe('verifyBearer', () => {
  it('accepts exactly `Bearer <password>`', async () => {
    expect(await verifyBearer('hunter2', 'Bearer hunter2')).toBe(true)
  })

  it.each([[null], [''], ['hunter2'], ['bearer hunter2'], ['Bearer  hunter2'], ['Bearer hunter3'], ['Bearer '], ['Basic hunter2']])(
    'refuses %j',
    async (header) => {
      expect(await verifyBearer('hunter2', header)).toBe(false)
    },
  )
})

describe('sessionCookieHeader', () => {
  it('serialises the spec attributes, Secure only when asked', () => {
    expect(sessionCookieHeader('123.abc', { secure: false })).toBe(
      `${SESSION_COOKIE}=123.abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
    )
    expect(sessionCookieHeader('123.abc', { secure: true })).toBe(
      `${SESSION_COOKIE}=123.abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}; Secure`,
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
