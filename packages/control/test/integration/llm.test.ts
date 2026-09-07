import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  PER_CALL_CAP_USD,
  applyModelDecision,
  cloneSimulation,
  createSimulation,
  haltSimulation,
  loadSimulation,
  prepareModelDecision,
  startAutoRun,
  stopAutoRun,
  stepSimulation,
  tickSimulations,
  type ModelOutcome,
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

describe('cloneSimulation of an llm run (controller ruling R4: a clone never inherits paid use)', () => {
  it('the clone is a rules run with no llm roles and no model fields, whatever the source carried', async () => {
    const source = await createSimulation({ companyId, name: 'llm-source', sector: 'trade', policy: 'A', ...validLlmInput })
    const sourceId = source.ok ? source.value.id : ''
    const cloned = await cloneSimulation(sourceId, { name: 'llm-clone', policy: 'B' })
    expect(cloned.ok).toBe(true)
    const cloneId = cloned.ok ? cloned.value.id : ''
    const loaded = await loadSimulation(cloneId)
    expect(loaded.ok && loaded.value.summary).toMatchObject({
      decisionProvider: 'rules', modelProvider: null, model: null, maxModelCostUsd: null, llmRoles: [],
    })
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

// ---------------------------------------------------------------------------------------------
// M31a Task 4: the two-phase model step. Every decider below is a plain function -- no `claude`
// binary is spawned anywhere in this file, and no paid call is ever made.
// ---------------------------------------------------------------------------------------------

const T0 = new Date('2026-09-07T10:00:00Z')
const plus = (ms: number): Date => new Date(T0.getTime() + ms)

const ANSWER_TEXT = 'Looking at the open orders.\n```json\n[{"type":"place_purchase","params":{"supplierId":"fast","qty":50},"rationale":"cover the shortfall early","refs":[]}]\n```\nThat is my proposal.'
const answer = (text = ANSWER_TEXT, costUsd: number | null = 0.004): ModelOutcome => ({ kind: 'answer', text, costUsd, tokens: { input: 900, output: 120 }, numTurns: 1 })

async function armedLlmRun(name: string, over: { readonly maxModelCostUsd?: number; readonly everyMs?: number; readonly untilDay?: number } = {}): Promise<string> {
  const created = await createSimulation({ companyId, name, sector: 'trade', policy: 'A', ...validLlmInput, ...(over.maxModelCostUsd !== undefined ? { maxModelCostUsd: over.maxModelCostUsd } : {}) })
  const id = created.ok ? created.value.id : ''
  expect(id).not.toBe('')
  expect((await startAutoRun(id, { everyMs: over.everyMs ?? 250, untilDay: over.untilDay ?? 5 })).ok).toBe(true)
  return id
}

async function decisionRows(id: string): Promise<readonly { actorRole: string | null; payload: Record<string, unknown> }[]> {
  const rows = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'decision' }, orderBy: { seq: 'asc' } })
  return rows.map((r) => ({ actorRole: r.actorRole, payload: r.payload as Record<string, unknown> }))
}

describe('prepareModelDecision', () => {
  it('skips a run with no intent, one that is not running, and one that is not due yet', async () => {
    const noIntent = await createSimulation({ companyId, name: 'no-intent', sector: 'trade', policy: 'A', ...validLlmInput })
    const noIntentId = noIntent.ok ? noIntent.value.id : ''
    const noIntentResult = await prepareModelDecision(noIntentId, T0)
    expect(noIntentResult.ok && noIntentResult.value).toEqual({ kind: 'skip', reason: 'no_intent' })

    const paused = await armedLlmRun('paused')
    // Straight to the column: `pauseSimulation` would clear the intent itself, and the state this
    // branch exists for is an ARMED intent on a row that is not running.
    await prisma.simulationRun.update({ where: { id: paused }, data: { status: 'paused' } })
    const pausedResult = await prepareModelDecision(paused, T0)
    expect(pausedResult.ok && pausedResult.value).toEqual({ kind: 'skip', reason: 'not_running' })

    const early = await armedLlmRun('early', { everyMs: 1_000 })
    await prisma.simulationRun.update({ where: { id: early }, data: { lastAutoStepAt: T0 } })
    const earlyResult = await prepareModelDecision(early, plus(500))
    expect(earlyResult.ok && earlyResult.value).toEqual({ kind: 'skip', reason: 'not_due' })
  })

  it('builds the purchasing prompt from the observation, hashes it, and reports the version, day and remaining budget', async () => {
    const id = await armedLlmRun('prep')
    const prepared = await prepareModelDecision(id, T0)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok || prepared.value.kind !== 'decide') throw new Error('expected a decide outcome')
    const decide = prepared.value
    expect(decide).toMatchObject({ kind: 'decide', day: 0, role: 'purchasing', model: 'claude-haiku-4-5', remainingUsd: 2 })
    expect(decide.version).toBe((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).version)
    expect(decide.promptHash).toMatch(/^[0-9a-f]{64}$/)
    // The observation itself is in the prompt -- the purchasing role's own fields, not the world's.
    expect(decide.prompt).toContain('purchasing')
    expect(decide.prompt).toContain('"inventory":100')
    expect(decide.prompt).toContain('"cashMinor":5000000')
    expect(decide.prompt).toContain('place_purchase')
    // Only the actions purchasing is allowed to propose are documented to it.
    expect(decide.prompt).not.toContain('ship_order')
    expect(decide.prompt).not.toContain('accept_order')
    // Preparing changes nothing: no lock, no journal row, no usage row.
    expect(await prisma.simulationModelUsage.count({ where: { simulationId: id } })).toBe(0)
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).version).toBe(decide.version)
  })

  it('halts the run when the spend already reached the cap, journalling model_budget_exhausted with both figures', async () => {
    const id = await armedLlmRun('exhausted', { maxModelCostUsd: 0.01 })
    await prisma.simulationModelUsage.create({ data: { simulationId: id, seq: 0, provider: 'claude_code', costUsd: 0.007, tokensIn: 10, tokensOut: 5, simTime: 0, role: 'purchasing' } })
    await prisma.simulationModelUsage.create({ data: { simulationId: id, seq: 1, provider: 'claude_code', costUsd: 0.004, tokensIn: 10, tokensOut: 5, simTime: 0, role: 'purchasing' } })
    const prepared = await prepareModelDecision(id, T0)
    expect(prepared.ok && prepared.value).toEqual({ kind: 'budget' })
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ status: 'halted', haltedReason: 'model budget exhausted', autoRunEveryMs: null, autoRunUntilDay: null })
    const control = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'control' }, orderBy: { seq: 'asc' } })
    const exhausted = control.map((r) => r.payload as { op: string; spentUsd?: number; capUsd?: number }).find((p) => p.op === 'model_budget_exhausted')
    expect(exhausted).toMatchObject({ spentUsd: 0.011, capUsd: 0.01 })
    expect(control.map((r) => (r.payload as { op: string }).op).slice(-2)).toEqual(['auto_run_stopped', 'halted'])
  })
})

describe('applyModelDecision', () => {
  it('a stale version writes the usage row anyway, journals stale_decision and steps nothing', async () => {
    const id = await armedLlmRun('stale')
    const before = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    const applied = await applyModelDecision(id, { expectedVersion: before.version + 7, role: 'purchasing', outcome: answer(), promptHash: 'abc', now: T0 })
    expect(applied.ok && applied.value).toEqual({ applied: false, reason: 'stale' })
    // The call was made and paid for: the usage row exists whatever the row's version did.
    const usage = await prisma.simulationModelUsage.findMany({ where: { simulationId: id } })
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ seq: 0, provider: 'claude_code', costUsd: 0.004, tokensIn: 900, tokensOut: 120, simTime: 0, role: 'purchasing' })
    const after = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(after.version).toBe(before.version)
    expect(after.simTime).toBe(0)
    const stale = (await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'control' }, orderBy: { seq: 'asc' } })).map((r) => r.payload as { op: string; role?: string; expectedVersion?: number; actual?: number }).find((p) => p.op === 'stale_decision')
    expect(stale).toMatchObject({ op: 'stale_decision', role: 'purchasing', expectedVersion: before.version + 7, actual: before.version, reason: 'version' })
  })

  it('a stopped auto-run makes the decision stale, though neither the version nor the status moved (fix round 1, Critical #1)', async () => {
    const id = await armedLlmRun('stopped')
    const before = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    // The person stopped the run while the model was thinking. `stopAutoRun` clears the intent
    // columns and NOTHING else -- same `version`, same `running` status -- so a stale check that
    // reads only those two would step the run after it was stopped (spec §2.6).
    expect((await stopAutoRun(id)).ok).toBe(true)
    const mid = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(mid).toMatchObject({ version: before.version, status: 'running', autoRunEveryMs: null })
    const applied = await applyModelDecision(id, { expectedVersion: before.version, role: 'purchasing', outcome: answer(), promptHash: 'abc', now: T0 })
    expect(applied.ok && applied.value).toEqual({ applied: false, reason: 'stale' })
    const after = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(after).toMatchObject({ simTime: 0, version: before.version, lastAutoStepAt: mid.lastAutoStepAt })
    // The call was still made and paid for.
    expect(await prisma.simulationModelUsage.count({ where: { simulationId: id } })).toBe(1)
    const stale = (await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'control' }, orderBy: { seq: 'asc' } })).map((r) => r.payload as { op: string; reason?: string }).find((p) => p.op === 'stale_decision')
    expect(stale).toMatchObject({ op: 'stale_decision', reason: 'intent_cleared' })
  })

  it('an isolation breach halts the run, names the tools, clears the intent and still records the usage', async () => {
    const id = await armedLlmRun('breach')
    const version = (await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).version
    const applied = await applyModelDecision(id, { expectedVersion: version, role: 'purchasing', outcome: { kind: 'isolation_breach', tools: ['Write', 'Bash'], costUsd: null, tokens: null }, promptHash: 'abc', now: T0 })
    expect(applied.ok && applied.value).toEqual({ applied: false, reason: 'breach' })
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ status: 'halted', haltedReason: 'isolation breach: Write, Bash', autoRunEveryMs: null, autoRunUntilDay: null, simTime: 0 })
    const usage = await prisma.simulationModelUsage.findMany({ where: { simulationId: id } })
    expect(usage).toHaveLength(1)
    // Unmeasured stays unmeasured: a null cost is never written as 0.
    expect(usage[0]?.costUsd).toBeNull()
    expect(usage[0]?.tokensIn).toBeNull()
    const ops = (await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'control' }, orderBy: { seq: 'asc' } })).map((r) => r.payload as { op: string; tools?: string[] })
    expect(ops.find((p) => p.op === 'isolation_breach')).toMatchObject({ tools: ['Write', 'Bash'] })
    expect(ops.map((p) => p.op).slice(-2)).toEqual(['isolation_breach', 'auto_run_stopped'])
  })

  it('a failed call still advances the day, with the reason on the decision row and no purchasing action', async () => {
    const id = await armedLlmRun('failed')
    const version = (await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).version
    const applied = await applyModelDecision(id, { expectedVersion: version, role: 'purchasing', outcome: { kind: 'failed', reason: 'timeout', costUsd: null, tokens: null }, promptHash: 'abc', now: T0 })
    expect(applied.ok && applied.value).toMatchObject({ applied: true, reason: 'failed' })
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ simTime: 1, status: 'running', version: version + 1, lastAutoStepAt: T0 })
    const purchasing = (await decisionRows(id)).filter((r) => r.actorRole === 'purchasing')
    expect(purchasing).toHaveLength(1)
    expect(purchasing[0]?.payload).toMatchObject({ provider: 'llm', model: 'claude-haiku-4-5', usageSeq: 0, parseError: 'timeout' })
    expect(purchasing[0]?.payload['actions']).toEqual([])
    expect(await prisma.simulationJournalEntry.count({ where: { simulationId: id, kind: 'action_applied', actorRole: 'purchasing' } })).toBe(0)
  })

  it('an unparseable answer advances the day with the parse error on the decision row', async () => {
    const id = await armedLlmRun('unparseable')
    const version = (await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).version
    const applied = await applyModelDecision(id, { expectedVersion: version, role: 'purchasing', outcome: answer('I would rather not answer in JSON today.'), promptHash: 'abc', now: T0 })
    expect(applied.ok && applied.value.applied).toBe(true)
    const purchasing = (await decisionRows(id)).filter((r) => r.actorRole === 'purchasing')
    expect(purchasing[0]?.payload['parseError']).toBe('no JSON array found in the answer')
    expect(purchasing[0]?.payload['actions']).toEqual([])
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).simTime).toBe(1)
  })

  it('an answer places the purchase it asked for; purchasing reads llm, every other role still reads rules', async () => {
    const id = await armedLlmRun('answered')
    const version = (await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).version
    const applied = await applyModelDecision(id, { expectedVersion: version, role: 'purchasing', outcome: answer(), promptHash: 'abc', now: T0 })
    expect(applied.ok && applied.value).toMatchObject({ applied: true })
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ simTime: 1, status: 'running', version: version + 1 })
    const usage = await prisma.simulationModelUsage.findUniqueOrThrow({ where: { id: (await prisma.simulationModelUsage.findFirstOrThrow({ where: { simulationId: id } })).id } })
    const rows = await decisionRows(id)
    const purchasing = rows.find((r) => r.actorRole === 'purchasing')
    expect(purchasing?.payload).toMatchObject({ provider: 'llm', model: 'claude-haiku-4-5', usageSeq: usage.seq, parseError: null })
    for (const other of rows.filter((r) => r.actorRole !== 'purchasing')) expect(other.payload['provider']).toBe('rules')
    const placed = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'action_applied', actorRole: 'purchasing' } })
    expect(placed).toHaveLength(1)
    expect((placed[0]?.payload as { action: { type: string; params: Record<string, unknown> } }).action).toMatchObject({ type: 'place_purchase', params: { supplierId: 'fast', qty: 50 } })
    const state = row.state as { sector: { purchases: { supplierId: string; qty: number }[] } }
    expect(state.sector.purchases).toMatchObject([{ supplierId: 'fast', qty: 50 }])
  })
})

describe('haltSimulation on an llm run (spec §6)', () => {
  it('journals model_calls_blocked immediately before the halt entry; a rules run gets no such entry', async () => {
    const id = await armedLlmRun('halted')
    expect((await haltSimulation(id, 'operator')).ok).toBe(true)
    const ops = (await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'control' }, orderBy: { seq: 'asc' } })).map((r) => (r.payload as { op: string }).op)
    expect(ops.slice(-3)).toEqual(['model_calls_blocked', 'halted', 'auto_run_stopped'])

    const rules = await createSimulation({ companyId, name: 'rules halted', sector: 'trade', policy: 'A' })
    const rulesId = rules.ok ? rules.value.id : ''
    expect((await haltSimulation(rulesId, 'operator')).ok).toBe(true)
    const rulesOps = (await prisma.simulationJournalEntry.findMany({ where: { simulationId: rulesId, kind: 'control' }, orderBy: { seq: 'asc' } })).map((r) => (r.payload as { op: string }).op)
    expect(rulesOps).not.toContain('model_calls_blocked')
    expect(rulesOps.slice(-1)).toEqual(['halted'])
  })
})

describe('tickSimulations with a model decider', () => {
  it('makes at most ONE model call per pass; two due llm runs need two passes (fix round 1, Important #3)', async () => {
    // A model call can take minutes and the daemon awaits it inline, so a pass that decided for
    // every due llm run would stall the whole loop for as long as the sum of them.
    const a = await armedLlmRun('llm a', { everyMs: 10_000 })
    const b = await armedLlmRun('llm b', { everyMs: 10_000 })
    let calls = 0
    const decider = async (): Promise<ModelOutcome> => { calls += 1; return answer() }
    const first = await tickSimulations({ now: T0, modelDecider: decider })
    expect(calls).toBe(1)
    expect(first).toMatchObject({ candidates: 2, stepped: 1, halted: 0, skippedNoDecider: 0 })
    // The oldest due run goes first: candidates are read in creation order.
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: a } })).simTime).toBe(1)
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: b } })).simTime).toBe(0)
    const second = await tickSimulations({ now: plus(250), modelDecider: decider })
    expect(calls).toBe(2)
    expect(second).toMatchObject({ stepped: 1 })
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: b } })).simTime).toBe(1)
  })

  it('steps the llm run through the decider, reports skippedNoDecider without one, and leaves a rules run alone', async () => {
    const llmId = await armedLlmRun('ticked')
    const rulesCreated = await createSimulation({ companyId, name: 'rules-beside', sector: 'trade', policy: 'A' })
    const rulesId = rulesCreated.ok ? rulesCreated.value.id : ''
    expect((await startAutoRun(rulesId, { everyMs: 250, untilDay: 5 })).ok).toBe(true)

    // No decider: the llm run is skipped untouched and the rules run steps as it always did.
    const without = await tickSimulations({ now: T0 })
    expect(without).toEqual({ candidates: 2, stepped: 1, halted: 0, skippedNoDecider: 1 })
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: llmId } })).simTime).toBe(0)
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: rulesId } })).simTime).toBe(1)
    expect(await prisma.simulationModelUsage.count({ where: { simulationId: llmId } })).toBe(0)

    const calls: { model: string; prompt: string; maxBudgetUsd: number }[] = []
    const decider = async (input: { model: string; prompt: string; maxBudgetUsd: number }): Promise<ModelOutcome> => {
      calls.push(input)
      return answer()
    }
    const withDecider = await tickSimulations({ now: plus(250), modelDecider: decider })
    expect(withDecider).toEqual({ candidates: 2, stepped: 2, halted: 0, skippedNoDecider: 0 })
    expect(calls).toHaveLength(1)
    // `Math.min(remainingUsd, PER_CALL_CAP_USD)`: the run's cap is 2, the per-call ceiling is 1.
    expect(calls[0]).toMatchObject({ model: 'claude-haiku-4-5', maxBudgetUsd: PER_CALL_CAP_USD })
    expect(calls[0]?.prompt).toContain('"inventory":100')
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: llmId } })).simTime).toBe(1)
    expect(await prisma.simulationModelUsage.count({ where: { simulationId: llmId } })).toBe(1)
  })

  it('a cumulative spend that reaches the cap halts the run on the NEXT pass, before any further call', async () => {
    const id = await armedLlmRun('cumulative', { maxModelCostUsd: 0.01 })
    let calls = 0
    const decider = async (): Promise<ModelOutcome> => {
      calls += 1
      return answer(ANSWER_TEXT, 0.006)
    }
    const first = await tickSimulations({ now: T0, modelDecider: decider })
    expect(first).toMatchObject({ stepped: 1, halted: 0 })
    const second = await tickSimulations({ now: plus(250), modelDecider: decider })
    expect(second).toMatchObject({ stepped: 1, halted: 0 })
    expect(calls).toBe(2)
    // 0.012 >= 0.01: the third pass never calls the model at all.
    const third = await tickSimulations({ now: plus(500), modelDecider: decider })
    expect(third).toMatchObject({ stepped: 0, halted: 1 })
    expect(calls).toBe(2)
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ status: 'halted', haltedReason: 'model budget exhausted' })
  })

  it('an unmeasured call counts 0 toward the cap and never becomes a 0 cost row', async () => {
    const id = await armedLlmRun('unmeasured', { maxModelCostUsd: 0.01 })
    const decider = async (): Promise<ModelOutcome> => answer(ANSWER_TEXT, null)
    for (const at of [T0, plus(250), plus(500)]) await tickSimulations({ now: at, modelDecider: decider })
    const usage = await prisma.simulationModelUsage.findMany({ where: { simulationId: id }, orderBy: { seq: 'asc' } })
    expect(usage).toHaveLength(3)
    for (const row of usage) expect(row.costUsd).toBeNull()
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).status).toBe('running')
  })

  it('stops at untilDay without spending another cent', async () => {
    const id = await armedLlmRun('until', { untilDay: 1 })
    let calls = 0
    const decider = async (): Promise<ModelOutcome> => { calls += 1; return answer() }
    await tickSimulations({ now: T0, modelDecider: decider })
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).simTime).toBe(1)
    await tickSimulations({ now: plus(250), modelDecider: decider })
    expect(calls).toBe(1)
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ simTime: 1, status: 'running', autoRunEveryMs: null })
  })
})
