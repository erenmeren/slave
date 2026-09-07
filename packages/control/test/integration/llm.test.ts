import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createSimulation,
  loadSimulation,
  startAutoRun,
  stepSimulation,
} from '../../src/simulation.js'

async function seedTradingCompany(name = 'Demo Trading Co.'): Promise<string> {
  const template = await prisma.slaveTemplate.upsert({ where: { name: 'Trade Clerk' }, create: { name: 'Trade Clerk', role: 'clerk' }, update: {} })
  const company = await prisma.company.create({ data: { name } })
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

const validLlmInput = { decisionProvider: 'llm' as const, modelProvider: 'claude_code' as const, model: 'claude-haiku-4-5', maxModelCostUsd: 2 }

describe('createSimulation on an llm run', () => {
  it('refuses a missing modelProvider, a cursor modelProvider, and an unknown provider string', async () => {
    const missingProvider = await createSimulation({ companyId, name: 'x1', sector: 'trade', policy: 'A', decisionProvider: 'llm', model: 'claude-haiku-4-5', maxModelCostUsd: 2 })
    expect(missingProvider.ok === false && missingProvider.error).toEqual({ kind: 'invalid_simulation_input', detail: 'modelProvider is required for an llm run' })

    const cursor = await createSimulation({ companyId, name: 'x2', sector: 'trade', policy: 'A', decisionProvider: 'llm', modelProvider: 'cursor', model: 'claude-haiku-4-5', maxModelCostUsd: 2 })
    expect(cursor.ok === false && cursor.error).toEqual({ kind: 'unsupported_model_provider', provider: 'cursor', reason: 'it reports no cost, so a cap cannot be enforced' })

    const unknown = await createSimulation({ companyId, name: 'x3', sector: 'trade', policy: 'A', decisionProvider: 'llm', modelProvider: 'ollama' as unknown as 'claude_code', model: 'claude-haiku-4-5', maxModelCostUsd: 2 })
    expect(unknown.ok === false && unknown.error).toEqual({ kind: 'unsupported_model_provider', provider: 'ollama', reason: 'it is not a configured provider' })
  })

  it('refuses a missing or blank model', async () => {
    const missing = await createSimulation({ companyId, name: 'x4', sector: 'trade', policy: 'A', decisionProvider: 'llm', modelProvider: 'claude_code', maxModelCostUsd: 2 })
    expect(missing.ok === false && missing.error).toEqual({ kind: 'invalid_simulation_input', detail: 'model is required for an llm run' })

    const blank = await createSimulation({ companyId, name: 'x5', sector: 'trade', policy: 'A', decisionProvider: 'llm', modelProvider: 'claude_code', model: '   ', maxModelCostUsd: 2 })
    expect(blank.ok === false && blank.error).toEqual({ kind: 'invalid_simulation_input', detail: 'model is required for an llm run' })
  })

  it('refuses a missing, non-finite or non-positive maxModelCostUsd', async () => {
    const missing = await createSimulation({ companyId, name: 'x6', sector: 'trade', policy: 'A', decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-haiku-4-5' })
    expect(missing.ok === false && missing.error).toEqual({ kind: 'invalid_simulation_input', detail: 'maxModelCostUsd must be a positive number' })

    const zero = await createSimulation({ companyId, name: 'x7', sector: 'trade', policy: 'A', decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-haiku-4-5', maxModelCostUsd: 0 })
    expect(zero.ok === false && zero.error).toEqual({ kind: 'invalid_simulation_input', detail: 'maxModelCostUsd must be a positive number' })

    const negative = await createSimulation({ companyId, name: 'x8', sector: 'trade', policy: 'A', decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-haiku-4-5', maxModelCostUsd: -1 })
    expect(negative.ok === false && negative.error).toEqual({ kind: 'invalid_simulation_input', detail: 'maxModelCostUsd must be a positive number' })

    const infinite = await createSimulation({ companyId, name: 'x9', sector: 'trade', policy: 'A', decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-haiku-4-5', maxModelCostUsd: Number.POSITIVE_INFINITY })
    expect(infinite.ok === false && infinite.error).toEqual({ kind: 'invalid_simulation_input', detail: 'maxModelCostUsd must be a positive number' })
  })

  it('a valid llm run stores decisionProvider, modelProvider, model, maxModelCostUsd and llmRoles: [purchasing]', async () => {
    const result = await createSimulation({ companyId, name: 'llm-run', sector: 'trade', policy: 'A', ...validLlmInput })
    expect(result.ok).toBe(true)
    const id = result.ok ? result.value.id : ''
    const loaded = await loadSimulation(id)
    expect(loaded.ok && loaded.value.summary).toMatchObject({
      decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-haiku-4-5', maxModelCostUsd: 2, llmRoles: ['purchasing'],
    })
    expect(loaded.ok && loaded.value.definition.llmRoles).toEqual(['purchasing'])
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-haiku-4-5', maxModelCostUsd: 2 })
  })

  it('a rules run ignores modelProvider/model/maxModelCostUsd input and stores them null with llmRoles: []', async () => {
    const result = await createSimulation({ companyId, name: 'rules-run', sector: 'trade', policy: 'A', modelProvider: 'claude_code', model: 'claude-haiku-4-5', maxModelCostUsd: 2 })
    expect(result.ok).toBe(true)
    const id = result.ok ? result.value.id : ''
    const loaded = await loadSimulation(id)
    expect(loaded.ok && loaded.value.summary).toMatchObject({ decisionProvider: 'rules', modelProvider: null, model: null, maxModelCostUsd: null, llmRoles: [] })
    expect(loaded.ok && loaded.value.definition.llmRoles).toEqual([])
  })
})

describe('stepSimulation on an llm run', () => {
  it('refuses llm_steps_in_daemon without taking a lock or writing anything', async () => {
    const created = await createSimulation({ companyId, name: 'llm-step', sector: 'trade', policy: 'A', ...validLlmInput })
    const id = created.ok ? created.value.id : ''
    const before = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    const stepped = await stepSimulation(id, { steps: 1 })
    expect(stepped.ok === false && stepped.error).toEqual({ kind: 'llm_steps_in_daemon', simulationId: id })
    const after = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(after).toEqual(before)
    expect(await prisma.simulationJournalEntry.count({ where: { simulationId: id } })).toBe(1) // the create record only
  })

  it('startAutoRun still accepts an llm run', async () => {
    const created = await createSimulation({ companyId, name: 'llm-auto', sector: 'trade', policy: 'A', ...validLlmInput })
    const id = created.ok ? created.value.id : ''
    const started = await startAutoRun(id, { everyMs: 1_000, untilDay: 5 })
    expect(started.ok).toBe(true)
    const loaded = await loadSimulation(id)
    expect(loaded.ok && loaded.value.summary.autoRun).toMatchObject({ everyMs: 1_000, untilDay: 5 })
    expect(loaded.ok && loaded.value.summary.status).toBe('running')
  })
})
