import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { verifyCredentials } = vi.hoisted(() => ({ verifyCredentials: vi.fn() }))

// The route asks `packages/control` who this is; the derivation itself is that package's test's
// business (M23 F3). Mocking it here keeps this file about the HTTP contract — and fast.
vi.mock('@ai-team-os/control', () => ({ verifyCredentials }))

const { POST: loginPOST } = await import('../src/app/api/auth/login/route.js')
const { POST: logoutPOST } = await import('../src/app/api/auth/logout/route.js')
const { SESSION_COOKIE, verifySession } = await import('../src/lib/session.js')

const SECRET = '0123456789abcdef0123456789abcdef'
const ADA = { id: 'ada-0001', username: 'ada' }

function loginRequest(body: unknown, url = 'http://127.0.0.1:3000/api/auth/login', headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', SECRET)
    verifyCredentials.mockReset()
    verifyCredentials.mockImplementation(async (username: string, password: string) =>
      username === 'ada' && password === 'hunter2-hunter2' ? ADA : null,
    )
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('404s when the instance has no session secret (loopback mode has no accounts)', async () => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', '')
    const response = await loginPOST(loginRequest({ username: 'ada', password: 'hunter2-hunter2' }))
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'accounts are not configured on this instance' })
    expect(response.headers.get('set-cookie')).toBeNull()
    // It refuses before it ever asks the database who that is.
    expect(verifyCredentials).not.toHaveBeenCalled()
  })

  it('sets a session cookie bound to the user on the right credentials (plain http → no Secure)', async () => {
    const response = await loginPOST(loginRequest({ username: 'ada', password: 'hunter2-hunter2' }))
    expect(response.status).toBe(204)
    expect(verifyCredentials).toHaveBeenCalledWith('ada', 'hunter2-hunter2')
    const cookie = response.headers.get('set-cookie')
    expect(cookie).toMatch(
      new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9-]+\\.\\d+\\.[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000$`),
    )
    const value = cookie?.split(';')[0]?.slice(SESSION_COOKIE.length + 1) ?? null
    expect(await verifySession(SECRET, value, new Date())).toEqual({ userId: ADA.id })
  })

  it('marks the cookie Secure over https', async () => {
    const response = await loginPOST(loginRequest({ username: 'ada', password: 'hunter2-hunter2' }, 'https://box.example/api/auth/login'))
    expect(response.headers.get('set-cookie')).toMatch(/; Secure$/)
    const proxied = await loginPOST(
      loginRequest({ username: 'ada', password: 'hunter2-hunter2' }, 'http://box.example/api/auth/login', { 'x-forwarded-proto': 'https' }),
    )
    expect(proxied.headers.get('set-cookie')).toMatch(/; Secure$/)
  })

  it('waits 300 ms, logs one line, and 401s on the wrong password — no cookie', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const started = performance.now()
    const response = await loginPOST(loginRequest({ username: 'ada', password: 'hunter3-hunter3' }))
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(290)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'wrong username or password' })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[auth] failed login attempt')
  })

  it('answers an unknown username exactly as it answers a wrong password — same delay, same text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const started = performance.now()
    const response = await loginPOST(loginRequest({ username: 'nobody', password: 'hunter2-hunter2' }))
    expect(performance.now() - started).toBeGreaterThanOrEqual(290)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'wrong username or password' })
    // The name the caller guessed never reaches the log or the body.
    expect(warn).toHaveBeenCalledWith('[auth] failed login attempt')
  })

  it.each([['not json'], [JSON.stringify({})], [JSON.stringify({ username: 'ada' })], [JSON.stringify({ username: 42, password: 42 })], [JSON.stringify(null)]])(
    'treats a malformed body (%s) as wrong credentials',
    async (body) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const response = await loginPOST(loginRequest(body))
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'wrong username or password' })
    },
  )

  it('serialises concurrent wrong guesses (M21 B3): the second waits behind the first, a right guess does not', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const started = performance.now()
    const [first, second, right] = await Promise.all([
      loginPOST(loginRequest({ username: 'ada', password: 'wrong-1' })).then((r) => ({ status: r.status, at: performance.now() - started })),
      loginPOST(loginRequest({ username: 'mallory', password: 'wrong-2' })).then((r) => ({ status: r.status, at: performance.now() - started })),
      loginPOST(loginRequest({ username: 'ada', password: 'hunter2-hunter2' })).then((r) => ({ status: r.status, at: performance.now() - started })),
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
