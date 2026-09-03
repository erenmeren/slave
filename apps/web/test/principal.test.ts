import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { cookieValue, findUnique } = vi.hoisted(() => ({
  cookieValue: { current: null as string | null },
  findUnique: vi.fn(),
}))

// `next/headers` and the Prisma client are the two things `currentPrincipal` reaches for; both are
// stubbed so this file stays a unit test of the decision, not of Next or of Postgres.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'aiteamos_session' && cookieValue.current !== null ? { name, value: cookieValue.current } : undefined) }),
}))
vi.mock('@ai-team-os/db/client', () => ({ prisma: { user: { findUnique } } }))

const { currentPrincipal, requirePrincipal } = await import('../src/server/principal.js')
const { mintSession } = await import('../src/lib/session.js')

const SECRET = '0123456789abcdef0123456789abcdef'
const ADA = { id: 'ada-0001', username: 'ada' }

describe('currentPrincipal', () => {
  beforeEach(() => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', SECRET)
    cookieValue.current = null
    findUnique.mockReset()
    findUnique.mockResolvedValue(ADA)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('resolves the signed-in user from a valid cookie', async () => {
    cookieValue.current = await mintSession(SECRET, ADA.id, new Date())
    expect(await currentPrincipal()).toEqual({ userId: ADA.id, username: ADA.username })
    expect(findUnique).toHaveBeenCalledWith({ where: { id: ADA.id }, select: { id: true, username: true } })
  })

  it('is null in loopback mode, and never asks the database', async () => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', '')
    cookieValue.current = await mintSession(SECRET, ADA.id, new Date())
    expect(await currentPrincipal()).toBeNull()
    expect(findUnique).not.toHaveBeenCalled()
  })

  it('is null with no cookie at all, and never asks the database', async () => {
    expect(await currentPrincipal()).toBeNull()
    expect(findUnique).not.toHaveBeenCalled()
  })

  it('is null on a tampered cookie, and never asks the database', async () => {
    const value = await mintSession(SECRET, ADA.id, new Date())
    cookieValue.current = value.slice(0, -1) + (value.endsWith('0') ? '1' : '0')
    expect(await currentPrincipal()).toBeNull()
    expect(findUnique).not.toHaveBeenCalled()
  })

  it('is null on an expired cookie', async () => {
    cookieValue.current = await mintSession(SECRET, ADA.id, new Date(Date.now() - 31 * 24 * 60 * 60 * 1000))
    expect(await currentPrincipal()).toBeNull()
    expect(findUnique).not.toHaveBeenCalled()
  })

  it('is null when the signature is good but the user was deleted since — the one revocation story', async () => {
    findUnique.mockResolvedValue(null)
    cookieValue.current = await mintSession(SECRET, ADA.id, new Date())
    expect(await currentPrincipal()).toBeNull()
    expect(findUnique).toHaveBeenCalledOnce()
  })
})

describe('requirePrincipal', () => {
  beforeEach(() => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', SECRET)
    cookieValue.current = null
    findUnique.mockReset()
    findUnique.mockResolvedValue(ADA)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('hands back the principal in accounts mode', async () => {
    cookieValue.current = await mintSession(SECRET, ADA.id, new Date())
    expect(await requirePrincipal()).toEqual({ principal: { userId: ADA.id, username: ADA.username } })
  })

  it('hands back a null principal in loopback mode — writes carry no user, as today', async () => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', '')
    expect(await requirePrincipal()).toEqual({ principal: null })
  })

  it('refuses a revoked session with 401 { error: "session revoked" }', async () => {
    findUnique.mockResolvedValue(null)
    cookieValue.current = await mintSession(SECRET, ADA.id, new Date())
    const outcome = await requirePrincipal()
    expect('response' in outcome).toBe(true)
    const response = (outcome as { response: Response }).response
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'session revoked' })
  })
})
