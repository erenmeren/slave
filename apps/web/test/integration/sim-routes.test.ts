import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as createPOST } from '../../src/app/api/sim/route.js'
import { DELETE as simDELETE } from '../../src/app/api/sim/[simulationId]/route.js'
import { POST as stepPOST } from '../../src/app/api/sim/[simulationId]/step/route.js'
import { POST as pausePOST } from '../../src/app/api/sim/[simulationId]/pause/route.js'
import { POST as resumePOST } from '../../src/app/api/sim/[simulationId]/resume/route.js'
import { POST as injectPOST } from '../../src/app/api/sim/[simulationId]/inject/route.js'
import { POST as haltPOST } from '../../src/app/api/sim/[simulationId]/halt/route.js'

async function seedTradingCompany(): Promise<string> {
  const template = await prisma.slaveTemplate.create({ data: { name: 'Trade Clerk', role: 'clerk' } })
  const company = await prisma.company.create({ data: { name: 'Demo Trading Co.' } })
  for (const [department, slave] of [['Sales', 'Sonia'], ['Purchasing', 'Pete'], ['Operations', 'Olga'], ['Finance', 'Fin']] as const) {
    const team = await prisma.companyTeam.create({ data: { companyId: company.id, name: department } })
    await prisma.companySlave.create({ data: { companyTeamId: team.id, templateId: template.id, name: slave } })
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
  it('create → 200 with the id; a bad body → 400; an unsupported sector → 409 with the refusal text', async () => {
    const created = await createPOST(json({ companyId, name: 'demo', policy: 'A' }))
    expect(created.status).toBe(200)
    const { id } = (await created.json()) as { id: string }
    expect(typeof id).toBe('string')
    expect((await createPOST(json({ companyId }))).status).toBe(400)
    const unsupported = await createPOST(json({ companyId, name: 'x', policy: 'A', sector: 'software' }))
    expect(unsupported.status).toBe(409)
    expect((await unsupported.json()).error).toContain('cannot run in simulation mode yet')
  })
  it('step / pause / resume / halt / inject answer 200 / 409 / 404 by the verb', async () => {
    const { id } = (await (await createPOST(json({ companyId, name: 'demo', policy: 'A' }))).json()) as { id: string }
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
})
