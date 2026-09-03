import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@ai-team-os/db/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * M23 F6's route-level gate, proven against a real route handler and a real database — the two
 * things `principal.test.ts` deliberately stubs away to stay a unit test of the decision alone.
 *
 * Only `next/headers` is mocked here (the same hoisted-holder idiom `principal.test.ts` uses):
 * `requirePrincipal` reads it directly, and nothing in this file's own scope reaches `next`'s
 * request context, which only a real Next request would provide. `@ai-team-os/db/client` stays
 * the real client — the whole point of this file is to watch a real `User` row's id land on a
 * real `ExecutionEvent` row through the actual route.
 */
const { cookieValue } = vi.hoisted(() => ({ cookieValue: { current: null as string | null } }))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'aiteamos_session' && cookieValue.current !== null ? { name, value: cookieValue.current } : undefined,
  }),
}))

const { POST: goalPOST } = await import('../../src/app/api/w/[workspaceId]/goal/route.js')
const { POST: reseedPOST } = await import('../../src/app/api/dev/reseed/route.js')
const { mintSession } = await import('../../src/lib/session.js')

const SECRET = '0123456789abcdef0123456789abcdef'

interface Fixture {
  readonly workspace: { readonly id: string }
}

async function seed(): Promise<Fixture> {
  const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-route-principal-'))
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['npm test'], setupCommands: [] },
  })
  return { workspace: { id: workspace.id } }
}

function postGoal(workspaceId: string): Promise<Response> {
  return goalPOST(
    new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ goal: 'ship the checkout redesign' }),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ workspaceId }) },
  )
}

describe('route-level principal gating (M23 F6)', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Task", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
    )
    cookieValue.current = null
    fixture = await seed()
  })

  afterEach((): void => {
    vi.unstubAllEnvs()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  // Every OTHER route-handler integration test in this directory relies on this being true: with
  // no secret in the vitest environment, `requirePrincipal` short-circuits to `{ principal: null }`
  // before ever touching `next/headers`' `cookies()` — which is why none of those files need a
  // `next/headers` mock at all. If this ever starts failing, every one of those files needs one.
  it('runs with no AITEAMOS_SESSION_SECRET set — the vitest environment is loopback by default', () => {
    expect(process.env['AITEAMOS_SESSION_SECRET']).toBeUndefined()
  })

  it('refuses a mutating route with 401 { error: "session revoked" } in accounts mode with no cookie', async (): Promise<void> => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', SECRET)

    const response = await postGoal(fixture.workspace.id)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'session revoked' })
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })
    expect(workspace.goal).toBeNull()
    expect(await prisma.executionEvent.count()).toBe(0)
  })

  // Final review Important 1: `/api/dev/reseed` was the one mutating route with no
  // `requirePrincipal()` gate. Only the 401 path is exercised here -- the gate returns before
  // `db:seed` ever runs, so this asserts the refusal without actually reseeding anything.
  it('refuses POST /api/dev/reseed with 401 { error: "session revoked" } in accounts mode with no cookie', async (): Promise<void> => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', SECRET)

    const response = await reseedPOST(new Request('http://x', { method: 'POST' }))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'session revoked' })
  })

  it('attributes the resulting event and workspace column to the signed-in user with a valid cookie', async (): Promise<void> => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', SECRET)
    const user = await prisma.user.create({ data: { username: 'ada', passwordHash: 'irrelevant-for-this-test' } })
    cookieValue.current = await mintSession(SECRET, user.id, new Date())

    const response = await postGoal(fixture.workspace.id)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })
    expect(workspace.goalSetByUserId).toBe(user.id)
    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: fixture.workspace.id, type: 'workspace_goal_set' },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.userId).toBe(user.id)
  })
})
