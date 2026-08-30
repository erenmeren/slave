import { describe, expect, it } from 'vitest'
import { POSTURE, boundaryVerdict } from '../src/lib/boundary.js'

const base = { host: 'localhost:3000', secFetchSite: null, origin: null, path: '/api/w/x/overview' }

describe('boundaryVerdict', () => {
  it('names the posture', () => {
    expect(POSTURE).toBe('loopback-only')
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
    expect(verdict).toEqual({ allow: false, reason: 'foreign host <none> — this instance is loopback-only' })
  })

  it('reports the parsed host, without the port, in the refusal reason', () => {
    const verdict = boundaryVerdict({ ...base, host: 'evil.example:8080' })
    expect(verdict).toEqual({ allow: false, reason: 'foreign host evil.example — this instance is loopback-only' })
  })

  it.each([['same-origin'], ['none']])('allows sec-fetch-site %s on /api/', (site) => {
    expect(boundaryVerdict({ ...base, secFetchSite: site }).allow).toBe(true)
  })

  it.each([['cross-site'], ['same-site'], ['cross-origin']])('refuses sec-fetch-site %s on /api/', (site) => {
    expect(boundaryVerdict({ ...base, secFetchSite: site })).toEqual({
      allow: false,
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

  it('refuses a foreign Origin, quoting it verbatim', () => {
    expect(boundaryVerdict({ ...base, origin: 'https://evil.example' })).toEqual({
      allow: false,
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
})
