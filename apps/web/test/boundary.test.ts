import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PUBLIC_API_PREFIX, boundaryVerdict, postureFor } from '../src/lib/boundary.js'

const base = {
  mode: 'loopback-only' as const,
  host: 'localhost:3000',
  secFetchSite: null,
  origin: null,
  path: '/api/w/x/overview',
  sessionValid: false,
}

describe('boundaryVerdict', () => {
  it('names every posture', () => {
    expect(postureFor('loopback-only')).toBe('loopback-only · no accounts · cross-site requests refused')
    // The loopback line never names a user: there is nobody to name.
    expect(postureFor('loopback-only', 'ada')).toBe('loopback-only · no accounts · cross-site requests refused')
    expect(postureFor('accounts', 'ada')).toBe('accounts · signed in as ada · cross-site requests refused')
    expect(postureFor('accounts', null)).toBe('accounts · not signed in · cross-site requests refused')
    expect(postureFor('accounts')).toBe('accounts · not signed in · cross-site requests refused')
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

describe('boundaryVerdict in accounts mode', () => {
  const pw = { ...base, mode: 'accounts' as const }
  const UNAUTH = { allow: false, kind: 'unauthenticated', reason: 'sign in first' }

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

  it('has no bearer to fall back on: an Authorization header is not a session (spec §7 F4)', () => {
    // The field is gone from the request shape; the only credential accounts mode reads is the
    // cookie, so an /api/ call without one is unauthenticated no matter what it carries.
    expect(boundaryVerdict({ ...pw })).toEqual(UNAUTH)
    expect('bearerValid' in pw).toBe(false)
  })

  it('still refuses cross-site fetch metadata even with a session', () => {
    expect(boundaryVerdict({ ...pw, sessionValid: true, secFetchSite: 'cross-site' })).toEqual({
      allow: false,
      kind: 'refused',
      reason: 'cross-site request refused (sec-fetch-site: cross-site)',
    })
  })

  it('compares an Origin against the request Host WITH its port in accounts mode (M21 B1)', () => {
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

  it('refuses an unparsable Origin in accounts mode too', () => {
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

describe('the one public API family (M54 R1)', () => {
  const HOOK = '/api/hooks/github/2f1c-not-a-real-uuid'

  it('spells the prefix once, and it is a prefix and not a path', () => {
    expect(PUBLIC_API_PREFIX).toBe('/api/hooks/')
  })

  it.each([['loopback-only'], ['accounts']] as const)(
    'allows a hooks path in %s mode with no cookie, from a foreign host, cross-site',
    (mode) => {
      expect(
        boundaryVerdict({
          mode,
          host: 'hooks.example.com',
          secFetchSite: 'cross-site',
          origin: 'https://evil.example',
          path: HOOK,
          sessionValid: false,
        }),
      ).toEqual({ allow: true })
    },
  )

  it('allows it with NO host header at all -- a sender on the internet cannot arrange one', () => {
    expect(boundaryVerdict({ ...base, host: null, path: HOOK }).allow).toBe(true)
  })

  it('is checked FIRST -- before the host rule, the cross-site rule and the session', () => {
    // The same three inputs on ANY other /api/ path are refused in loopback mode, refused
    // cross-site, and unauthenticated in accounts mode. Asserting the contrast is what shows the
    // carve-out is a carve-out rather than a coincidence.
    expect(boundaryVerdict({ ...base, host: 'evil.example', path: '/api/w/x/overview' }).allow).toBe(false)
    expect(boundaryVerdict({ ...base, secFetchSite: 'cross-site', path: '/api/w/x/overview' }).allow).toBe(false)
    expect(
      boundaryVerdict({ ...base, mode: 'accounts', path: '/api/w/x/overview', sessionValid: false }).allow,
    ).toBe(false)
  })

  it('opens NOTHING else: a path that merely starts with /api/hook is not in the family', () => {
    for (const path of ['/api/hook', '/api/hooks', '/api/hookserver/x', '/api/w/x/hooks/github/1']) {
      expect(boundaryVerdict({ ...base, mode: 'accounts', path, sessionValid: false }).allow, path).toBe(false)
    }
  })

  it('does not become a third BoundaryMode -- `postureFor` says exactly what it said', () => {
    expect(postureFor('loopback-only')).toBe('loopback-only · no accounts · cross-site requests refused')
    expect(postureFor('accounts', 'ada')).toBe('accounts · signed in as ada · cross-site requests refused')
  })

  /**
   * WHAT IS ACTUALLY BEHIND THE CARVE-OUT (fix-wave item 19).
   *
   * The rule above is a prefix, so every route file that ever lands under `/api/hooks/` is public by
   * construction -- with no session, from any host, cross-site. Nothing else in the repository would
   * notice a second one being added. This walks the directory and pins the list: a new file here has
   * to be added to this literal on purpose, by somebody who has read this comment.
   */
  it('has exactly ONE route file behind it, and a second one has to be added here on purpose', () => {
    const root = new URL('../src/app/api/hooks/', import.meta.url).pathname
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [relative(root, join(dir, entry.name))],
      )
    expect(walk(root).sort()).toEqual(['[source]/[hookId]/route.ts'])
  })
})
