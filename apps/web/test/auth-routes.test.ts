import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as loginPOST } from '../src/app/api/auth/login/route.js'
import { POST as logoutPOST } from '../src/app/api/auth/logout/route.js'
import { SESSION_COOKIE, verifySession } from '../src/lib/session.js'

function loginRequest(body: unknown, url = 'http://127.0.0.1:3000/api/auth/login', headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.stubEnv('AITEAMOS_PASSWORD', 'hunter2')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('404s when no password is configured', async () => {
    vi.stubEnv('AITEAMOS_PASSWORD', '')
    const response = await loginPOST(loginRequest({ password: 'anything' }))
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'password login is not configured on this instance' })
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('sets a verifiable session cookie on the right password (plain http → no Secure)', async () => {
    const response = await loginPOST(loginRequest({ password: 'hunter2' }))
    expect(response.status).toBe(204)
    const cookie = response.headers.get('set-cookie')
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=\\d+\\.[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000$`))
    const value = cookie?.split(';')[0]?.slice(SESSION_COOKIE.length + 1) ?? null
    expect(await verifySession('hunter2', value, new Date())).toBe(true)
  })

  it('marks the cookie Secure over https', async () => {
    const response = await loginPOST(loginRequest({ password: 'hunter2' }, 'https://box.example/api/auth/login'))
    expect(response.headers.get('set-cookie')).toMatch(/; Secure$/)
    const proxied = await loginPOST(loginRequest({ password: 'hunter2' }, 'http://box.example/api/auth/login', { 'x-forwarded-proto': 'https' }))
    expect(proxied.headers.get('set-cookie')).toMatch(/; Secure$/)
  })

  it('waits 300 ms, logs one line, and 401s on the wrong password — no cookie', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const started = performance.now()
    const response = await loginPOST(loginRequest({ password: 'hunter3' }))
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(290)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'wrong password' })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[auth] failed login attempt')
  })

  it.each([['not json'], [JSON.stringify({})], [JSON.stringify({ password: 42 })], [JSON.stringify(null)]])(
    'treats a malformed body (%s) as a wrong password',
    async (body) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const response = await loginPOST(loginRequest(body))
      expect(response.status).toBe(401)
    },
  )

  it('serialises concurrent wrong guesses (M21 B3): the second waits behind the first, a right guess does not', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const started = performance.now()
    const [first, second, right] = await Promise.all([
      loginPOST(loginRequest({ password: 'wrong-1' })).then((r) => ({ status: r.status, at: performance.now() - started })),
      loginPOST(loginRequest({ password: 'wrong-2' })).then((r) => ({ status: r.status, at: performance.now() - started })),
      loginPOST(loginRequest({ password: 'hunter2' })).then((r) => ({ status: r.status, at: performance.now() - started })),
    ])
    expect(first.status).toBe(401)
    expect(second.status).toBe(401)
    expect(right.status).toBe(204)
    expect(Math.min(first.at, second.at)).toBeGreaterThanOrEqual(290)
    expect(Math.max(first.at, second.at)).toBeGreaterThanOrEqual(590)
    expect(right.at).toBeLessThan(250)
  })
})

describe('POST /api/auth/logout', () => {
  it('always 204s with a clearing cookie', async () => {
    const response = await logoutPOST(new Request('http://127.0.0.1:3000/api/auth/logout', { method: 'POST' }))
    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toBe(`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  })

  it('clears with Secure over https', async () => {
    const response = await logoutPOST(new Request('https://box.example/api/auth/logout', { method: 'POST' }))
    expect(response.headers.get('set-cookie')).toMatch(/; Max-Age=0; Secure$/)
  })
})
