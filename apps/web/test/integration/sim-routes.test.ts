import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as createPOST } from '../../src/app/api/sim/route.js'
import { DELETE as simDELETE, GET as simGET } from '../../src/app/api/sim/[simulationId]/route.js'
import { POST as stepPOST } from '../../src/app/api/sim/[simulationId]/step/route.js'
import { POST as pausePOST } from '../../src/app/api/sim/[simulationId]/pause/route.js'
import { POST as resumePOST } from '../../src/app/api/sim/[simulationId]/resume/route.js'
import { POST as injectPOST } from '../../src/app/api/sim/[simulationId]/inject/route.js'
import { POST as haltPOST } from '../../src/app/api/sim/[simulationId]/halt/route.js'
import { POST as clonePOST } from '../../src/app/api/sim/[simulationId]/clone/route.js'
import { POST as autoRunPOST } from '../../src/app/api/sim/[simulationId]/auto-run/route.js'
import { POST as autoRunStopPOST } from '../../src/app/api/sim/[simulationId]/auto-run/stop/route.js'
import { GET as compareGET } from '../../src/app/api/sim/compare/route.js'

async function seedTradingCompany(): Promise<string> {
  const template = await prisma.slaveTemplate.create({ data: { name: 'Trade Clerk', role: 'clerk' } })
  const company = await prisma.company.create({ data: { name: 'Demo Trading Co.' } })
  for (const [department, slave] of [['Sales', 'Sonia'], ['Purchasing', 'Pete'], ['Operations', 'Olga'], ['Finance', 'Fin']] as const) {
    const team = await prisma.companyTeam.create({ data: { companyId: company.id, name: department } })
    await prisma.companySlave.create({ data: { companyTeamId: team.id, templateId: template.id, name: slave } })
  }
  return company.id
}
/** A roster the software sector can staff (design §3.2): a Product slave, a Management slave, a
 *  dedicated reviewer and two more Engineering slaves. */
async function seedSoftwareCompany(): Promise<string> {
  const company = await prisma.company.create({ data: { name: 'Checkout Platform' } })
  const members = [
    { name: 'John', department: 'Product', role: 'Business Analyst' },
    { name: 'Atlas', department: 'Management', role: 'manager' },
    { name: 'Riley', department: 'Engineering', role: 'reviewer' },
    { name: 'Alex', department: 'Engineering', role: 'Backend' },
    { name: 'Emma', department: 'Engineering', role: 'Frontend' },
  ] as const
  const teams = new Map<string, string>()
  for (const member of members) {
    let teamId = teams.get(member.department)
    if (teamId === undefined) {
      const team = await prisma.companyTeam.create({ data: { companyId: company.id, name: member.department } })
      teamId = team.id
      teams.set(member.department, teamId)
    }
    const template = await prisma.slaveTemplate.create({ data: { name: `Checkout ${member.role}`, role: member.role } })
    await prisma.companySlave.create({ data: { companyTeamId: teamId, templateId: template.id, name: member.name } })
  }
  return company.id
}
let companyId: string
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "SimulationModelUsage", "SimulationJournalEntry", "SimulationRun", "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE')
  companyId = await seedTradingCompany()
})
afterAll(async () => { await prisma.$disconnect() })

const json = (body: unknown, method = 'POST'): Request => new Request('http://x', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const params = (simulationId: string) => ({ params: Promise.resolve({ simulationId }) })

describe('the simulation routes', () => {
  it('create → 200 with the id; a bad body → 400; no sector → 400; an unregistered sector → 400 (M31b §5: the zod enum IS the registry)', async () => {
    const created = await createPOST(json({ companyId, name: 'demo', policy: 'A', sector: 'trade' }))
    expect(created.status).toBe(200)
    const { id } = (await created.json()) as { id: string }
    expect(typeof id).toBe('string')
    expect((await createPOST(json({ companyId }))).status).toBe(400)
    // No `sector` at all -- there is no default any more (M31b §5).
    expect((await createPOST(json({ companyId, name: 'x', policy: 'A' }))).status).toBe(400)
    // `retail` is not one of `Object.keys(sectors)`, so the route's own zod enum rejects it
    // before `createSimulation` (control) ever sees it -- a 400, not control's 409 refusal.
    const unsupported = await createPOST(json({ companyId, name: 'x', policy: 'A', sector: 'retail' }))
    expect(unsupported.status).toBe(400)
  })
  it('create a software run and GET reads its own headline, metric labels and inject forms (M31b §5)', async () => {
    const softwareCompanyId = await seedSoftwareCompany()
    const created = await createPOST(json({ companyId: softwareCompanyId, name: 'sw run', policy: 'A', sector: 'software' }))
    expect(created.status).toBe(200)
    const { id } = (await created.json()) as { id: string }
    const got = await simGET(new Request('http://x', { method: 'GET' }), params(id))
    expect(got.status).toBe(200)
    const snapshot = (await got.json()) as {
      sector: string
      headline: { label: string; value: number; kind: string }[]
      metricLabels: Record<string, { label: string; kind: string }>
      injectForms: { type: string; fields: { name: string }[] }[]
    }
    expect(snapshot.sector).toBe('software')
    expect(snapshot.headline.some((h) => h.label === 'queued')).toBe(true)
    expect(snapshot.headline.some((h) => h.label === 'cash')).toBe(false)
    expect(snapshot.metricLabels['deliveredTasks']).toEqual({ label: 'delivered', kind: 'count' })
    expect(snapshot.injectForms.map((f) => f.type)).toEqual(['request', 'incident', 'absence'])
  })
  it('create with decisionProvider llm but no cap → 400 with the refusal text; nothing is created', async () => {
    const missingCap = await createPOST(json({ companyId, name: 'llm run', policy: 'A', sector: 'trade', decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-sonnet-4-5' }))
    expect(missingCap.status).toBe(400)
    expect((await missingCap.json()).error).toContain('maxModelCostUsd must be a positive number')
    expect(await prisma.simulationRun.count()).toBe(0)
  })
  it('create with decisionProvider llm and a cap → 200; the row and the GET snapshot carry the llm fields', async () => {
    const created = await createPOST(json({ companyId, name: 'llm run', policy: 'A', sector: 'trade', decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-sonnet-4-5', maxModelCostUsd: 2 }))
    expect(created.status).toBe(200)
    const { id } = (await created.json()) as { id: string }
    const row = await prisma.simulationRun.findUnique({ where: { id } })
    expect(row).toMatchObject({ decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-sonnet-4-5', maxModelCostUsd: 2 })
    const got = await simGET(new Request('http://x', { method: 'GET' }), params(id))
    const snapshot = (await got.json()) as { summary: { decisionProvider: string; modelProvider: string; model: string; maxModelCostUsd: number } }
    expect(snapshot.summary).toMatchObject({ decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-sonnet-4-5', maxModelCostUsd: 2 })
  })
  it('step / pause / resume / halt / inject answer 200 / 409 / 404 by the verb', async () => {
    const { id } = (await (await createPOST(json({ companyId, name: 'demo', policy: 'A', sector: 'trade' }))).json()) as { id: string }
    // `steps` must be a positive integer, same as every other malformed body (fix wave, Minor #10).
    expect((await stepPOST(json({ steps: 0 }), params(id))).status).toBe(400)
    const stepped = await stepPOST(json({ steps: 2, idempotencyKey: 'r1' }), params(id))
    expect(stepped.status).toBe(200)
    expect(await stepped.json()).toMatchObject({ ok: true, day: 2, version: 1 })
    expect((await pausePOST(new Request('http://x', { method: 'POST' }), params(id))).status).toBe(200)
    const paused = await stepPOST(json({ steps: 1 }), params(id))
    expect(paused.status).toBe(409)
    expect((await paused.json()).error).toContain('is paused')
    expect((await resumePOST(new Request('http://x', { method: 'POST' }), params(id))).status).toBe(200)
    expect((await injectPOST(json({ day: 5, event: { type: 'supplier_delay', supplierId: 'normal', extraDays: 2 } }), params(id))).status).toBe(200)
    expect((await injectPOST(json({ day: 5, event: { type: 'delivery', purchaseId: 'p' } }), params(id))).status).toBe(409)
    expect((await haltPOST(json({ reason: 'test' }), params(id))).status).toBe(200)
    expect((await stepPOST(json({ steps: 1 }), params('00000000-0000-4000-8000-00000000dead'))).status).toBe(404)
    expect((await simDELETE(new Request('http://x', { method: 'DELETE' }), params(id))).status).toBe(200)
    expect((await simDELETE(new Request('http://x', { method: 'DELETE' }), params(id))).status).toBe(404)
  })
  it('halt with no body defaults reason to operator; a non-empty non-JSON body is 400', async () => {
    const { id } = (await (await createPOST(json({ companyId, name: 'demo', policy: 'A', sector: 'trade' }))).json()) as { id: string }
    expect((await haltPOST(new Request('http://x', { method: 'POST' }), params(id))).status).toBe(200)
    const row = await prisma.simulationRun.findUnique({ where: { id } })
    expect(row?.haltedReason).toBe('operator')

    const { id: id2 } = (await (await createPOST(json({ companyId, name: 'demo-two', policy: 'A', sector: 'trade' }))).json()) as { id: string }
    const malformed = new Request('http://x', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } })
    expect((await haltPOST(malformed, params(id2))).status).toBe(400)
  })
  it('GET reads the snapshot; an unknown id is 404 (fix wave, Important #3)', async () => {
    const { id } = (await (await createPOST(json({ companyId, name: 'demo', policy: 'A', sector: 'trade' }))).json()) as { id: string }
    const got = await simGET(new Request('http://x', { method: 'GET' }), params(id))
    expect(got.status).toBe(200)
    const snapshot = (await got.json()) as { summary: { id: string }; modelUsage: { spentUsd: number | null; capUsd: number | null; rows: unknown[]; unmeasured: number } }
    expect(snapshot.summary.id).toBe(id)
    expect(snapshot.modelUsage.spentUsd).toBeNull()
    expect(snapshot.modelUsage.capUsd).toBeNull()
    expect(snapshot.modelUsage.rows).toEqual([])
    const missing = await simGET(new Request('http://x', { method: 'GET' }), params('00000000-0000-4000-8000-00000000dead'))
    expect(missing.status).toBe(404)
    expect((await missing.json()).error).toBe('no such simulation')
  })
  it('clone → 200 with the id and the new row cloned from the source; a bad body → 400; unknown id → 404', async () => {
    const { id } = (await (await createPOST(json({ companyId, name: 'demo', policy: 'A', sector: 'trade' }))).json()) as { id: string }
    const cloned = await clonePOST(json({ name: 'demo (B)', policy: 'B' }), params(id))
    expect(cloned.status).toBe(200)
    const { id: cloneId } = (await cloned.json()) as { ok: true; id: string }
    const row = await prisma.simulationRun.findUnique({ where: { id: cloneId } })
    expect(row?.clonedFromId).toBe(id)
    expect((await clonePOST(json({ name: '' }), params(id))).status).toBe(400)
    expect((await clonePOST(json({ name: 'x', policy: 'A' }), params('00000000-0000-4000-8000-00000000dead'))).status).toBe(404)
  })
  it('auto-run → 200 and the row has the intent; a bad body → 400; stop → 200', async () => {
    const { id } = (await (await createPOST(json({ companyId, name: 'demo', policy: 'A', sector: 'trade' }))).json()) as { id: string }
    const started = await autoRunPOST(json({ everyMs: 1000, untilDay: 10 }), params(id))
    expect(started.status).toBe(200)
    const row = await prisma.simulationRun.findUnique({ where: { id } })
    expect(row).toMatchObject({ autoRunEveryMs: 1000, autoRunUntilDay: 10 })
    expect((await autoRunPOST(json({ everyMs: 10 }), params(id))).status).toBe(400)
    expect((await autoRunStopPOST(new Request('http://x', { method: 'POST' }), params(id))).status).toBe(200)
    const stopped = await prisma.simulationRun.findUnique({ where: { id } })
    expect(stopped?.autoRunEveryMs).toBeNull()
  })
  it('GET compare → 200 with definitionsMatch; missing a param → 400; unknown id → 404; a === b → 409', async () => {
    const { id: a } = (await (await createPOST(json({ companyId, name: 'a', policy: 'A', sector: 'trade' }))).json()) as { id: string }
    const cloned = await clonePOST(json({ name: 'b', policy: 'B' }), params(a))
    const { id: b } = (await cloned.json()) as { id: string }
    const got = await compareGET(new Request(`http://x/api/sim/compare?a=${a}&b=${b}`))
    expect(got.status).toBe(200)
    const body = (await got.json()) as { definitionsMatch: boolean; a: { summary: { id: string } } }
    expect(body.definitionsMatch).toBe(true)
    expect(body.a.summary.id).toBe(a)
    expect((await compareGET(new Request(`http://x/api/sim/compare?a=${a}`))).status).toBe(400)
    expect((await compareGET(new Request('http://x/api/sim/compare'))).status).toBe(400)
    expect((await compareGET(new Request(`http://x/api/sim/compare?a=${a}&b=00000000-0000-4000-8000-00000000dead`))).status).toBe(404)
    expect((await compareGET(new Request(`http://x/api/sim/compare?a=${a}&b=${a}`))).status).toBe(409)
  })
})
