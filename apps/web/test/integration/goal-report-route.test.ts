import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Loopback mode (no session secret) never reads a cookie; the mock only keeps a stray secret in the
// shell from reaching Next's request context, which a test does not have (`hooks-route.test.ts`).
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))

const { GET } = await import('../../src/app/api/w/[workspaceId]/goals/[version]/report/route.js')

async function seed(): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Report Route', repoPath: '/tmp/report-route', verifyCommands: ['true'], setupCommands: [], delivery: 'conducted' },
  })
  await prisma.requirementSet.create({
    data: { workspaceId: workspace.id, goalVersion: 1, items: [{ key: 'R1', text: 'a <b>bold</b> claim', source: 'x' }] },
  })
  return workspace.id
}

const get = (workspaceId: string, version: string, query = ''): Promise<Response> =>
  GET(new Request(`http://test/api/w/${workspaceId}/goals/${version}/report${query}`), { params: Promise.resolve({ workspaceId, version }) })

describe('the goal report route', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "RequirementSet", "GoalDelivery", "Workspace" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('answers the report as JSON', async (): Promise<void> => {
    const id = await seed()
    const response = await get(id, '1')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expect.objectContaining({ goalVersion: 1, state: 'not_conducted' }))
  })

  it('answers the Markdown as a download, escaped, byte-identical across two reads', async (): Promise<void> => {
    const id = await seed()
    const one = await get(id, '1', '?format=markdown')
    expect(one.status).toBe(200)
    expect(one.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(one.headers.get('content-disposition')).toBe('attachment; filename="goal-v1-report.md"')
    const text = await one.text()
    expect(text).toContain('a &lt;b&gt;bold&lt;/b&gt; claim')
    expect(await (await get(id, '1', '?format=markdown')).text()).toBe(text)
  })

  it('400s a version that is not a positive whole number, 404s an unknown version or workspace', async (): Promise<void> => {
    const id = await seed()
    expect((await get(id, 'abc')).status).toBe(400)
    expect((await get(id, '0')).status).toBe(400)
    const missing = await get(id, '9')
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: string }).error).toContain('has no conducted goal v9')
    expect((await get('nope', '1')).status).toBe(404)
  })
})
