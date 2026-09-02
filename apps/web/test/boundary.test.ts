import { describe, expect, it } from 'vitest'
import { boundaryVerdict, postureFor } from '../src/lib/boundary.js'

const base = {
  mode: 'loopback-only' as const,
  host: 'localhost:3000',
  secFetchSite: null,
  origin: null,
  path: '/api/w/x/overview',
  sessionValid: false,
  bearerValid: false,
}

describe('boundaryVerdict', () => {
  it('names both postures', () => {
    expect(postureFor('loopback-only')).toBe('loopback-only · no accounts · cross-site requests refused')
    expect(postureFor('password')).toBe('password login · single operator · cross-site requests refused')
  })

  it.each([
    ['localhost:3000', true], ['localhost', true], ['127.0.0.1:3000', true],
    ['127.0.0.1', true], ['[::1]:3000', true], ['[::1]', true],
    ['evil.example', false], ['evil.example:3000', false],
    ['localhost.evil.example', false], ['127.0.0.1.evil.example', false],
  ])('host %s → allow=%s (rule 1, every path)', (host, allow) => {
    expect(boundaryVerdict({ ...base, host, path: '/' }).allow).toBe(allow)
    expect(boundaryVerdict({ ...base, host }).allow).toBe(allow)
  })

  it('refuses a missing Host header with the literal <none>', () => {
    const verdict = boundaryVerdict({ ...base, host: null })
    expect(verdict).toEqual({ allow: false, kind: 'refused', reason: 'foreign host <none> — this instance is loopback-only' })
  })

  it('reports the parsed host, without the port, in the refusal reason', () => {
    const verdict = boundaryVerdict({ ...base, host: 'evil.example:8080' })
    expect(verdict).toEqual({ allow: false, kind: 'refused', reason: 'foreign host evil.example — this instance is loopback-only' })
  })

  it.each([['same-origin'], ['none']])('allows sec-fetch-site %s on /api/', (site) => {
    expect(boundaryVerdict({ ...base, secFetchSite: site }).allow).toBe(true)
  })

  it.each([['cross-site'], ['same-site'], ['cross-origin']])('refuses sec-fetch-site %s on /api/', (site) => {
    expect(boundaryVerdict({ ...base, secFetchSite: site })).toEqual({
      allow: false,
      kind: 'refused',
      reason: `cross-site request refused (sec-fetch-site: ${site})`,
    })
  })

  it('lets a cross-site page request through (rule 2 is /api/ only)', () => {
    expect(boundaryVerdict({ ...base, secFetchSite: 'cross-site', path: '/w/abc/tasks' }).allow).toBe(true)
  })

  it('falls back to Origin when fetch metadata is absent: loopback origins pass', () => {
    expect(boundaryVerdict({ ...base, origin: 'http://localhost:3000' }).allow).toBe(true)
    expect(boundaryVerdict({ ...base, origin: 'http://127.0.0.1:3000' }).allow).toBe(true)
  })

  it('ignores the port in loopback mode still', () => {
    expect(boundaryVerdict({ ...base, host: '127.0.0.1:3000', origin: 'http://localhost:8080' })).toEqual({ allow: true })
  })

  it('refuses a foreign Origin, quoting it verbatim', () => {
    expect(boundaryVerdict({ ...base, origin: 'https://evil.example' })).toEqual({
      allow: false,
      kind: 'refused',
      reason: 'cross-origin request refused (origin: https://evil.example)',
    })
  })

  it('refuses the literal "null" Origin (sandboxed frames)', () => {
    expect(boundaryVerdict({ ...base, origin: 'null' }).allow).toBe(false)
  })

  it('allows headerless clients (curl) on /api/', () => {
    expect(boundaryVerdict(base).allow).toBe(true)
  })

  it('prefers Sec-Fetch-Site over Origin when both are present', () => {
    // A same-origin fetch still carries Origin on POSTs; metadata wins.
    expect(boundaryVerdict({ ...base, secFetchSite: 'cross-site', origin: 'http://localhost:3000' }).allow).toBe(false)
  })

  it('throws, never allows, on a mode it does not know (M21 B2)', () => {
    expect(() => boundaryVerdict({ ...base, mode: 'sso' as never })).toThrow(/unreachable: sso/)
    expect(() => postureFor('sso' as never)).toThrow(/unreachable: sso/)
  })
})

describe('boundaryVerdict in password mode', () => {
  const pw = { ...base, mode: 'password' as const }
  const UNAUTH = { allow: false, kind: 'unauthenticated', reason: 'authentication required' }

  it('lifts the Host allowlist (rule 1 is loopback mode only)', () => {
    expect(boundaryVerdict({ ...pw, host: 'box.tail1234.ts.net:3000', sessionValid: true }).allow).toBe(true)
    expect(boundaryVerdict({ ...pw, host: null, sessionValid: true }).allow).toBe(true)
  })

  it('closes the headerless escape hatch: no credential is unauthenticated, on API and page', () => {
    expect(boundaryVerdict(pw)).toEqual(UNAUTH)
    expect(boundaryVerdict({ ...pw, path: '/w/abc/tasks' })).toEqual(UNAUTH)
    expect(boundaryVerdict({ ...pw, secFetchSite: 'same-origin' })).toEqual(UNAUTH)
  })

  it.each([['/_next/static/chunks/main.js'], ['/favicon.ico'], ['/login']])('public path %s needs no credential', (path) => {
    expect(boundaryVerdict({ ...pw, path })).toEqual({ allow: true })
  })

  it('lets the login POST through without a credential, but not cross-site', () => {
    expect(boundaryVerdict({ ...pw, path: '/api/auth/login' })).toEqual({ allow: true })
    expect(boundaryVerdict({ ...pw, path: '/api/auth/login', secFetchSite: 'cross-site' })).toEqual({
      allow: false,
      kind: 'refused',
      reason: 'cross-site request refused (sec-fetch-site: cross-site)',
    })
  })

  it('a valid session allows any path', () => {
    expect(boundaryVerdict({ ...pw, sessionValid: true })).toEqual({ allow: true })
    expect(boundaryVerdict({ ...pw, sessionValid: true, path: '/w/abc/tasks' })).toEqual({ allow: true })
  })

  it('a valid bearer allows /api/ paths only', () => {
    expect(boundaryVerdict({ ...pw, bearerValid: true })).toEqual({ allow: true })
    expect(boundaryVerdict({ ...pw, bearerValid: true, path: '/w/abc/tasks' })).toEqual(UNAUTH)
  })

  it('still refuses cross-site fetch metadata even with a session', () => {
    expect(boundaryVerdict({ ...pw, sessionValid: true, secFetchSite: 'cross-site' })).toEqual({
      allow: false,
      kind: 'refused',
      reason: 'cross-site request refused (sec-fetch-site: cross-site)',
    })
  })

  it('compares an Origin against the request Host WITH its port in password mode (M21 B1)', () => {
    const host = 'box.tail1234.ts.net:3000'
    expect(boundaryVerdict({ ...pw, host, sessionValid: true, origin: 'http://box.tail1234.ts.net:3000' })).toEqual({ allow: true })
    expect(boundaryVerdict({ ...pw, host: 'Box.Tail1234.TS.net:3000', sessionValid: true, origin: 'http://box.tail1234.ts.net:3000' })).toEqual({ allow: true })
    expect(boundaryVerdict({ ...pw, host, sessionValid: true, origin: 'http://box.tail1234.ts.net:8080' })).toEqual({
      allow: false,
      kind: 'refused',
      reason: 'cross-origin request refused (origin: http://box.tail1234.ts.net:8080)',
    })
    expect(boundaryVerdict({ ...pw, host: 'box.tail1234.ts.net:80', sessionValid: true, origin: 'http://box.tail1234.ts.net' })).toEqual({
      allow: false,
      kind: 'refused',
      reason: 'cross-origin request refused (origin: http://box.tail1234.ts.net)',
    })
    expect(boundaryVerdict({ ...pw, host, sessionValid: true, origin: 'http://evil.example' })).toEqual({
      allow: false,
      kind: 'refused',
      reason: 'cross-origin request refused (origin: http://evil.example)',
    })
    expect(boundaryVerdict({ ...pw, host: null, sessionValid: true, origin: 'http://box.tail1234.ts.net' })).toEqual({
      allow: false,
      kind: 'refused',
      reason: 'cross-origin request refused (origin: http://box.tail1234.ts.net)',
    })
  })

  it('refuses an unparsable Origin in password mode too', () => {
    for (const origin of ['null', 'not a url']) {
      expect(boundaryVerdict({ ...pw, sessionValid: true, origin })).toEqual({
        allow: false,
        kind: 'refused',
        reason: `cross-origin request refused (origin: ${origin})`,
      })
    }
  })

  it('in loopback mode the Origin still goes against the allowlist (localhost ↔ 127.0.0.1 allowed)', () => {
    expect(boundaryVerdict({ ...base, host: '127.0.0.1:3000', origin: 'http://localhost:3000' })).toEqual({ allow: true })
  })

  it('never emits unauthenticated in loopback mode', () => {
    expect(boundaryVerdict({ ...base, path: '/w/abc/tasks' })).toEqual({ allow: true })
    expect(boundaryVerdict(base)).toEqual({ allow: true })
  })
})
