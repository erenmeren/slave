import { prisma } from '@slave-of-ai/db/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `PUT|DELETE /api/w/[workspaceId]/staffing/[capability]` (M53 R9), against a real database.
 *
 * `next/headers` is mocked for the 401 case alone, the `route-principal.test.ts` idiom: with no
 * `SLAVEOFAI_SESSION_SECRET` in the vitest environment `requirePrincipal` short-circuits before it
 * ever reaches `cookies()`, and every other case in this file runs in that loopback mode. The one
 * case that stubs the secret needs the mock, because `cookies()` outside a Next request throws.
 */
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))

const { PUT, DELETE } = await import('../../src/app/api/w/[workspaceId]/staffing/[capability]/route')

const SECRET = '0123456789abcdef0123456789abcdef'
/** A key the seeded taxonomy actually holds -- the verb refuses one it does not. */
const CAPABILITY = 'backend.services'

interface Fixture {
  readonly workspaceId: string
  readonly templateId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/m53-staffing-routes', verifyCommands: ['true'], setupCommands: [] },
  })
  const template = await prisma.slaveTemplate.create({
    data: { name: 'Backend Developer', role: 'backend' },
  })
  return { workspaceId: workspace.id, templateId: template.id }
}

function putRequest(body: unknown): Request {
  return new Request('http://x', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

function params(workspaceId: string, capability = CAPABILITY): { params: Promise<{ workspaceId: string; capability: string }> } {
  return { params: Promise.resolve({ workspaceId, capability }) }
}

const rowCount = (): Promise<number> => prisma.staffingPreference.count()

describe('the staffing preference routes (M53 R9)', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "SlaveTemplate", "User" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterEach((): void => {
    vi.unstubAllEnvs()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('writes the decision and answers 200', async (): Promise<void> => {
    const response = await PUT(putRequest({ templateId: fixture.templateId, model: 'opus' }), params(fixture.workspaceId))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    const row = await prisma.staffingPreference.findUniqueOrThrow({
      where: { workspaceId_capability: { workspaceId: fixture.workspaceId, capability: CAPABILITY } },
    })
    expect(row.templateId).toBe(fixture.templateId)
    expect(row.model).toBe('opus')
  })

  // The verb owns this sentence and this route repeats none of it -- a second list of refusals here
  // is a second place for them to go stale.
  it('answers 409 with the verb own sentence when the body names neither half', async (): Promise<void> => {
    const response = await PUT(putRequest({}), params(fixture.workspaceId))

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: `a staffing preference for ${CAPABILITY} must name a profile, a model, or both`,
    })
    expect(await rowCount()).toBe(0)
  })

  it('answers 400 for a body written against a field this route does not know', async (): Promise<void> => {
    const response = await PUT(putRequest({ template: fixture.templateId }), params(fixture.workspaceId))

    expect(response.status).toBe(400)
    expect(await rowCount()).toBe(0)
  })

  it('answers 409 workspace_archived on an archived project, before the verb runs at all', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { archivedAt: new Date() } })

    const response = await PUT(putRequest({ model: 'opus' }), params(fixture.workspaceId))

    expect(response.status).toBe(409)
    expect((await response.json()) as { error: string }).toMatchObject({ error: expect.stringContaining('archived') })
    expect(await rowCount()).toBe(0)
  })

  it('answers 404 for a project that is not there', async (): Promise<void> => {
    const response = await PUT(putRequest({ model: 'opus' }), params('00000000-0000-0000-0000-000000000000'))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'no such workspace' })
  })

  // 404, not 409: `refusalStatus` maps every `*_not_found` kind by its own suffix (M34 t1), and
  // `capability_not_found` is one of them -- the route enumerates nothing to make that so.
  it('answers 404 for a capability the taxonomy does not hold', async (): Promise<void> => {
    const response = await PUT(putRequest({ model: 'opus' }), params(fixture.workspaceId, 'nonsense.thing'))

    expect(response.status).toBe(404)
    expect(await rowCount()).toBe(0)
  })

  it('removes the row on DELETE, and answers 200 for a decision that was never taken', async (): Promise<void> => {
    await PUT(putRequest({ model: 'opus' }), params(fixture.workspaceId))
    expect(await rowCount()).toBe(1)

    const removed = await DELETE(new Request('http://x', { method: 'DELETE' }), params(fixture.workspaceId))
    expect(removed.status).toBe(200)
    expect(await rowCount()).toBe(0)

    // Deleting nothing is SUCCESS -- what DELETE promises, and `clearStaffingPreference`'s contract.
    const again = await DELETE(new Request('http://x', { method: 'DELETE' }), params(fixture.workspaceId))
    expect(again.status).toBe(200)
    expect(await rowCount()).toBe(0)
  })

  it('refuses an unauthenticated request with 401 and touches no row', async (): Promise<void> => {
    vi.stubEnv('SLAVEOFAI_SESSION_SECRET', SECRET)

    const put = await PUT(putRequest({ model: 'opus' }), params(fixture.workspaceId))
    expect(put.status).toBe(401)
    expect(await put.json()).toEqual({ error: 'session revoked' })

    const remove = await DELETE(new Request('http://x', { method: 'DELETE' }), params(fixture.workspaceId))
    expect(remove.status).toBe(401)
    expect(await rowCount()).toBe(0)
  })

  // M52 erratum E18: the column holds a `User.id` and every surface resolves it to a username at its
  // own boundary. The ROUTE's job is only to hand the session's principal on.
  it('records the signed-in user id as the setter, never a name', async (): Promise<void> => {
    const user = await prisma.user.create({ data: { username: 'ada', passwordHash: 'x' } })
    const { setStaffingPreference } = await import('@slave-of-ai/control')
    const result = await setStaffingPreference(
      fixture.workspaceId,
      { capability: CAPABILITY, model: 'opus' },
      // `Principal` in control is a `userId` and nothing else -- the NAME is each surface's own
      // resolution, which is the whole of M52 erratum E18.
      { userId: user.id },
    )

    expect(result.ok).toBe(true)
    const row = await prisma.staffingPreference.findUniqueOrThrow({
      where: { workspaceId_capability: { workspaceId: fixture.workspaceId, capability: CAPABILITY } },
    })
    expect(row.setBy).toBe(user.id)
    expect(row.setBy).not.toBe('ada')
  })
})
