import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { adoptRunbook, syncCapabilityTaxonomy, syncRunbooks } from '@slave-of-ai/control'
import { buildRunbookPanel } from '../../src/server/runbook'
import { GET as orgGET } from '../../src/app/api/org/runbooks/route'
import { GET as orgKeyGET } from '../../src/app/api/org/runbooks/[key]/route'
import {
  DELETE as workspaceDELETE,
  GET as workspaceGET,
  POST as workspacePOST,
} from '../../src/app/api/w/[workspaceId]/runbook/route'

/** The one `next/headers` mock the route cases need (`organization.test.ts`'s idiom). Inert
 *  without `SLAVEOFAI_SESSION_SECRET`: `requirePrincipal` short-circuits before `cookies()`. */
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (): undefined => undefined }),
}))

let workspaceId = ''

beforeAll(async () => {
  // Both syncs, not just the runbooks': a stage's capability chips are LABELS (docs/ia.md rule 3),
  // and an unsynced taxonomy would make every one of them print its key and still pass a test that
  // only checked "a chip is here".
  await syncCapabilityTaxonomy()
  await syncRunbooks()
  const workspace = await prisma.workspace.create({
    data: { name: 'M48 Panel', repoPath: '/tmp/m48p', verifyCommands: ['true'], setupCommands: [], goal: 'Ship the endpoint feature' },
  })
  workspaceId = workspace.id
})

afterAll(async () => {
  await prisma.task.deleteMany({ where: { workspaceId } })
  await prisma.executionEvent.deleteMany({ where: { workspaceId } })
  await prisma.workspace.deleteMany({ where: { id: workspaceId } })
  await prisma.$disconnect()
})

describe('buildRunbookPanel', () => {
  it('recommends before adoption, with a reason and a stage count, and offers every runbook in the picker', async () => {
    const view = await buildRunbookPanel(workspaceId)
    expect(view).not.toBeNull()
    if (view === null) return
    expect(view.adopted).toBeNull()
    expect(view.recommendations.map((r) => r.key)).toContain('feature-delivery')
    expect(view.recommendations[0]?.why).toContain('The goal says')
    expect(view.recommendations[0]?.stageCount).toBe(5)
    expect(view.all.length).toBeGreaterThanOrEqual(3)
  })

  it('after adoption shows the current stage, each stage state and the capability chips marked covered', async () => {
    await adoptRunbook(workspaceId, 'feature-delivery')
    await prisma.task.create({ data: { workspaceId, title: 'A', description: 'a', status: 'ready', maxAttempts: 3, stage: 'design', requiredCapabilities: ['planning.decomposition'] } })
    const view = await buildRunbookPanel(workspaceId)
    expect(view?.adopted?.key).toBe('feature-delivery')
    expect(view?.currentStage).toBe('design')
    expect(view?.stages.map((stage) => [stage.key, stage.state])).toEqual([
      ['design', 'active'],
      ['implement', 'pending'],
      ['verify', 'pending'],
      ['review', 'pending'],
      ['release', 'pending'],
    ])
    // Labels, never keys (docs/ia.md rule 3).
    expect(view?.stages[0]?.capabilities.map((cap) => cap.label)).toContain('Work decomposition')
    expect(view?.stages[0]?.capabilities.every((cap) => typeof cap.covered === 'boolean')).toBe(true)
  })

  it('stops recommending once a runbook is adopted -- the panel shows the plan, not a second opinion', async () => {
    const view = await buildRunbookPanel(workspaceId)
    expect(view?.recommendations).toEqual([])
    expect(view?.all.map((option) => option.key)).toContain('feature-delivery')
  })

  it('is null for a workspace that does not exist, which is what the route turns into a 404', async () => {
    expect(await buildRunbookPanel('nope')).toBeNull()
  })
})

/**
 * The three routes (M48 R7). Written after the handlers rather than before them -- the brief
 * specified no case for them -- but pinned here because a route is the only thing between the
 * panel's Adopt button and `adoptRunbook`, and its refusal STATUS is the contract the button reads.
 *
 * Loopback mode (no `SLAVEOFAI_SESSION_SECRET` in this environment), so `requirePrincipal` short
 * circuits before `cookies()` and the `next/headers` mock above is what keeps that honest rather
 * than accidental.
 */
describe('the runbook routes', () => {
  it('serves the catalogue, one runbook, and a 404 for a key nobody has', async () => {
    const all = (await (await orgGET()).json()) as readonly { key: string }[]
    expect(all.map((row) => row.key)).toContain('feature-delivery')

    const one = await orgKeyGET(new Request('http://x'), { params: Promise.resolve({ key: 'feature-delivery' }) })
    expect(one.status).toBe(200)
    expect(((await one.json()) as { stages: readonly unknown[] }).stages.length).toBe(5)

    const missing = await orgKeyGET(new Request('http://x'), { params: Promise.resolve({ key: 'no-such-runbook' }) })
    expect(missing.status).toBe(404)
    expect((await missing.json()) as { kind: string }).toMatchObject({ kind: 'runbook_not_found' })
  })

  it('adopts, re-reads, refuses an unknown key, and clears', async () => {
    const adopted = await workspacePOST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ key: 'bug-fix' }), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ workspaceId }) },
    )
    expect(adopted.status).toBe(200)
    expect(await adopted.json()).toMatchObject({ ok: true, key: 'bug-fix', changed: true })

    const read = await workspaceGET(new Request('http://x'), { params: Promise.resolve({ workspaceId }) })
    expect(((await read.json()) as { adopted: { key: string } }).adopted.key).toBe('bug-fix')

    const bad = await workspacePOST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ key: 'nope' }), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ workspaceId }) },
    )
    expect(bad.status).toBe(404)

    const noBody = await workspacePOST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ workspaceId }) })
    expect(noBody.status).toBe(400)

    const cleared = await workspaceDELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ workspaceId }) })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toMatchObject({ ok: true, key: null, changed: true })
  })

  it('is a 404 for a project that does not exist', async () => {
    const read = await workspaceGET(new Request('http://x'), { params: Promise.resolve({ workspaceId: 'nope' }) })
    expect(read.status).toBe(404)
  })
})
