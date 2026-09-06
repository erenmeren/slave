import { prisma } from '@slave-of-ai/db/client'
import { createSimulation, stepSimulation } from '@slave-of-ai/control'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildSimulationSnapshot, listSimulationCards, listSimulationCompanies } from '../../src/server/simulation.js'

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

describe('buildSimulationSnapshot', () => {
  it('reads the company panel, the metrics, the last journal rows and an empty model-usage panel', async () => {
    const created = await createSimulation({ companyId, name: 'demo', sector: 'trade', policy: 'B' })
    const id = created.ok ? created.value.id : ''
    await stepSimulation(id, { untilDay: 30 })
    const snapshot = await buildSimulationSnapshot(id)
    expect(snapshot?.summary).toMatchObject({ name: 'demo', policy: 'B', status: 'finished', simTime: 30, synthetic: true, decisionProvider: 'rules' })
    expect(snapshot?.currency).toBe('USD')
    expect(snapshot?.company).toMatchObject({ day: 30, inventory: 50, openOrders: 0 })
    expect(snapshot?.metrics.deliveredQty).toBe(150)
    expect(snapshot?.modelUsage).toEqual({ rows: 0, costUsd: null, unmeasured: 0 })
    expect(snapshot?.journal.length).toBeLessThanOrEqual(200)
    expect(snapshot?.journal.at(-1)?.kind).toBe('control')
    expect(snapshot?.roles.map((r) => r.slaveName)).toEqual(['Sonia', 'Pete', 'Olga', 'Fin'])
    expect(snapshot?.scenario).toHaveLength(2)
  })
  it('is null for an unknown id; the cards list and the company list read the catalog', async () => {
    expect(await buildSimulationSnapshot('00000000-0000-4000-8000-00000000dead')).toBeNull()
    await createSimulation({ companyId, name: 'one', sector: 'trade', policy: 'A' })
    expect((await listSimulationCards()).map((c) => c.name)).toEqual(['one'])
    expect(await listSimulationCompanies()).toEqual([{ id: companyId, name: 'Demo Trading Co.', slaves: 4 }])
  })
})
