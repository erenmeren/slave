import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { LEAD_TEAM_NAME } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as projects } from '../../src/app/api/projects/route.js'
import { GET as helpers } from '../../src/app/api/helpers/route.js'
import { GET as project } from '../../src/app/api/w/[workspaceId]/project/route.js'
import { POST as continueRoute } from '../../src/app/api/w/[workspaceId]/continue/route.js'
import { POST as flow } from '../../src/app/api/w/[workspaceId]/flow/route.js'
import { GET as leadGet, PATCH as leadPatch } from '../../src/app/api/w/[workspaceId]/lead/route.js'
import { POST as decide } from '../../src/app/api/w/[workspaceId]/goals/[version]/[decision]/route.js'
import { DELETE as remove } from '../../src/app/api/w/[workspaceId]/route.js'

/**
 * Lead UX design section 11: the new routes are thin envelopes over control functions. Each case
 * pins the envelope -- the status, the body's shape, the archived guard where a write has one --
 * and leaves what the verb does to the control package's own tests.
 */
const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-web-lead-routes-'))
afterAll(async () => {
  rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
})

const UNKNOWN = '00000000-0000-4000-8000-000000000000'

const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown, url = 'http://test/api'): Request =>
  new Request(url, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
const ws = (workspaceId: string): { params: Promise<{ workspaceId: string }> } => ({ params: Promise.resolve({ workspaceId }) })

let leadId = ''
let olderId = ''
let personId = ''

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "VerificationResult", "RequirementSet", "WorkPackage", "GoalDelivery", "Checkpoint", "SlaveRun", "Task", "Slave", "Person", "Team", "ProviderConfiguration", "Workspace", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
  const lead = await prisma.workspace.create({ data: { name: 'Lead project', repoPath, verifyCommands: ['true'], setupCommands: [], flow: 'lead', delivery: 'conducted', autoMerge: true } })
  const team = await prisma.team.create({ data: { workspaceId: lead.id, name: LEAD_TEAM_NAME } })
  for (const role of ['Lead', 'Verifier', 'Confirmer']) {
    await prisma.slave.create({ data: { teamId: team.id, role, runtimeRoles: [role === 'Lead' ? 'implementer' : 'verifier'], personId: (await prisma.person.create({ data: { name: `${role} x` } })).id } })
  }
  leadId = lead.id
  olderId = (await prisma.workspace.create({ data: { name: 'Older project', repoPath, verifyCommands: ['true'], setupCommands: [] } })).id
  const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Architect', role: 'Backend Architect', description: 'Builds APIs.', sourceDivision: 'engineering' } })
  personId = (await prisma.person.create({ data: { name: 'Bea', templateId: template.id } })).id
})

describe('GET /api/projects and /api/helpers', () => {
  it('lists every project with its phase', async () => {
    const response = await projects()
    expect(response.status).toBe(200)
    const body = (await response.json()) as { projects: { name: string; phase: string }[] }
    expect(body.projects.map((item) => [item.name, item.phase])).toEqual([
      ['Lead project', 'empty'],
      ['Older project', 'older'],
    ])
  })

  it('lists the catalogue\'s specialists and leaves the lead flow\'s own seats out', async () => {
    const body = (await (await helpers()).json()) as { helpers: { id: string; name: string; role: string | null; speciality: string | null }[] }
    expect(body.helpers).toEqual([expect.objectContaining({ id: personId, name: 'Bea', role: 'Backend Architect', speciality: 'engineering' })])
  })
})

describe('GET /api/w/:id/project', () => {
  it('answers the project view, and 404 for a project that does not exist', async () => {
    const response = await project(req('GET'), ws(leadId))
    expect(response.status).toBe(200)
    expect(((await response.json()) as { project: { name: string; phase: string } }).project).toMatchObject({ name: 'Lead project', phase: 'empty' })
    expect((await project(req('GET'), ws(UNKNOWN))).status).toBe(404)
  })
})

describe('POST /api/w/:id/continue', () => {
  it('retracts a stop and says what it resumed', async () => {
    await prisma.workspace.update({ where: { id: leadId }, data: { haltedReason: 'emergency stop by web operator', haltedAt: new Date() } })
    const response = await continueRoute(req('POST'), ws(leadId))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, cleared: true, requested: [], refused: [] })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: leadId } })).haltedReason).toBeNull()
  })

  it('409s on an archived project', async () => {
    await prisma.workspace.update({ where: { id: leadId }, data: { archivedAt: new Date() } })
    expect((await continueRoute(req('POST'), ws(leadId))).status).toBe(409)
  })
})

describe('POST /api/w/:id/flow', () => {
  it('400s a body without a flow, and refuses the lead flow where no Claude Code runtime is set', async () => {
    expect((await flow(req('POST', { flow: 'sideways' }), ws(olderId))).status).toBe(400)
    const refused = await flow(req('POST', { flow: 'lead' }), ws(olderId))
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toContain('claude_code')
  })

  it('switches a project back to the older way', async () => {
    const response = await flow(req('POST', { flow: 'packages' }), ws(leadId))
    expect(response.status).toBe(200)
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: leadId } })).flow).toBe('packages')
  })
})

describe('/api/w/:id/lead', () => {
  it('PATCH stores the time limit and the helpers, and answers what was stored', async () => {
    const response = await leadPatch(req('PATCH', { timeLimitMs: 3_600_000, roster: [personId] }), ws(leadId))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, timeLimitMs: 3_600_000, roster: [personId] })
  })

  it('PATCH 400s an empty body and 409s a limit out of its bounds, with the rule', async () => {
    expect((await leadPatch(req('PATCH', {}), ws(leadId))).status).toBe(400)
    const refused = await leadPatch(req('PATCH', { timeLimitMs: 60_000 }), ws(leadId))
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toContain('whole number of minutes')
  })

  it('PATCH refuses a project not in the lead flow, and an archived one', async () => {
    expect((await leadPatch(req('PATCH', { timeLimitMs: 3_600_000 }), ws(olderId))).status).toBe(409)
    await prisma.workspace.update({ where: { id: leadId }, data: { archivedAt: new Date() } })
    const archived = await leadPatch(req('PATCH', { timeLimitMs: 3_600_000 }), ws(leadId))
    expect(archived.status).toBe(409)
    expect(((await archived.json()) as { error: string }).error).toContain('archived')
  })

  it('GET 409s a lead project with no build yet, and 400s a version that is not a number', async () => {
    expect((await leadGet(req('GET'), ws(leadId))).status).toBe(409)
    expect((await leadGet(req('GET', undefined, 'http://test/api?version=abc'), ws(leadId))).status).toBe(400)
  })
})

describe('POST /api/w/:id/goals/:n/:decision', () => {
  const at = (workspaceId: string, version: string, decision: string): { params: Promise<{ workspaceId: string; version: string; decision: string }> } => ({
    params: Promise.resolve({ workspaceId, version, decision }),
  })

  it('404s a decision it does not know and 400s a version that is not a number', async () => {
    expect((await decide(req('POST'), at(leadId, '1', 'shrug'))).status).toBe(404)
    expect((await decide(req('POST'), at(leadId, 'one', 'accept'))).status).toBe(400)
  })

  it('answers a build that is not waiting with the refusal, and a missing build with 404', async () => {
    await prisma.goalDelivery.create({ data: { workspaceId: leadId, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1', baseCommit: 'b'.repeat(40), status: 'integrating', leadState: 'building' } })
    const refused = await decide(req('POST'), at(leadId, '1', 'accept'))
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toContain('not waiting')
    expect((await decide(req('POST'), at(leadId, '2', 'retry'))).status).toBe(404)
  })
})

describe('DELETE /api/w/:id', () => {
  it('deletes the project and names the repository it left on disk', async () => {
    const response = await remove(req('DELETE'), ws(leadId))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, name: 'Lead project', repoPath })
    expect(await prisma.workspace.count({ where: { id: leadId } })).toBe(0)
  })

  it('409s while a run is live and 404s a project that does not exist', async () => {
    const seat = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: leadId } } })
    await prisma.slaveRun.create({ data: { slaveId: seat.id, status: 'working' } })
    expect((await remove(req('DELETE'), ws(leadId))).status).toBe(409)
    expect((await remove(req('DELETE'), ws(UNKNOWN))).status).toBe(404)
  })
})
