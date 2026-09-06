import { prisma } from '@slave-of-ai/db/client'
import { createSimulation, stepSimulation } from '@slave-of-ai/control'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createSimulationSse } from '../../src/server/simulationEvents.js'

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

async function create(): Promise<string> {
  const created = await createSimulation({ companyId, name: 'demo', sector: 'trade', policy: 'A' })
  if (!created.ok) throw new Error('seed failed')
  return created.value.id
}

describe('createSimulationSse', () => {
  it('emits the version on open, again when a step bumps it, heartbeats, and 404s an unknown id', async () => {
    const id = await create()
    const response = await createSimulationSse({ simulationId: id, pollMs: 50, heartbeatMs: 120 })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const read = async (): Promise<string> => new TextDecoder().decode((await reader.read()).value)
    expect(await read()).toContain('"version":0')
    await stepSimulation(id, { steps: 1 })
    let seen = ''
    for (let i = 0; i < 10 && !seen.includes('"version":1'); i++) seen += await read()
    expect(seen).toContain('"version":1')
    expect(seen).toContain('"simTime":1')
    let beat = ''
    for (let i = 0; i < 10 && !beat.includes(': heartbeat'); i++) beat += await read()
    expect(beat).toContain(': heartbeat')
    await reader.cancel()
    expect((await createSimulationSse({ simulationId: '00000000-0000-4000-8000-00000000dead' })).status).toBe(404)
  })
})
