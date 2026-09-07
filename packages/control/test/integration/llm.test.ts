import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  PER_CALL_CAP_USD,
  applyModelDecision,
  drainModelCalls,
  inFlightModelCalls,
  cloneSimulation,
  createSimulation,
  haltSimulation,
  injectExternalEvent,
  loadSimulation,
  prepareModelDecision,
  startAutoRun,
  stopAutoRun,
  stepSimulation,
  tickSimulations,
  type ModelDecider,
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
    const exhausted = control.map((r) => r.payload as { op: string; spentUsd?: number; unmeasured?: number; chargedUsd?: number; capUsd?: number }).find((p) => p.op === 'model_budget_exhausted')
    // Ruling R10: `chargedUsd` is what the cap is actually enforced on -- here it equals `spentUsd`
    // because both rows were measured.
    expect(exhausted).toMatchObject({ spentUsd: 0.011, unmeasured: 0, chargedUsd: 0.011, capUsd: 0.01 })
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

  it('a stopped auto-run makes the decision stale, and the run is not stepped after it was stopped (spec §2.6)', async () => {
    const id = await armedLlmRun('stopped')
    const before = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    // The person stopped the run while the model was thinking. Since M32 item 1 `stopAutoRun`
    // bumps `version` with the clear (so the page's stream sees it), so this answer is stale by
    // `version` -- the first of the three questions. What spec §2.6 requires is unchanged and is
    // what this asserts: the answer is recorded and dropped, never stepped.
    expect((await stopAutoRun(id)).ok).toBe(true)
    const mid = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(mid).toMatchObject({ version: before.version + 1, status: 'running', autoRunEveryMs: null })
    const applied = await applyModelDecision(id, { expectedVersion: before.version, role: 'purchasing', outcome: answer(), promptHash: 'abc', now: T0 })
    expect(applied.ok && applied.value).toEqual({ applied: false, reason: 'stale' })
    const after = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(after).toMatchObject({ simTime: 0, version: mid.version, lastAutoStepAt: mid.lastAutoStepAt })
    // The call was still made and paid for.
    expect(await prisma.simulationModelUsage.count({ where: { simulationId: id } })).toBe(1)
    const stale = (await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'control' }, orderBy: { seq: 'asc' } })).map((r) => r.payload as { op: string; reason?: string }).find((p) => p.op === 'stale_decision')
    expect(stale).toMatchObject({ op: 'stale_decision', reason: 'version' })
  })

  it('the third question still answers: an intent cleared with the version left where it was is stale by intent_cleared', async () => {
    const id = await armedLlmRun('intent cleared')
    const before = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    // Bypasses `stopAutoRun` (which since M32 item 1 bumps `version` and would be caught by the
    // first question) so the row lands in the state the third question exists for: an intent that
    // is gone with `version` and `status` both untouched. `applyModelDecision` asks all three
    // deliberately -- a future writer that clears an intent some other way must not slip an
    // answer through.
    await prisma.simulationRun.update({ where: { id }, data: { autoRunEveryMs: null, autoRunUntilDay: null } })
    const applied = await applyModelDecision(id, { expectedVersion: before.version, role: 'purchasing', outcome: answer(), promptHash: 'abc', now: T0 })
    expect(applied.ok && applied.value).toEqual({ applied: false, reason: 'stale' })
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).simTime).toBe(0)
    const stale = (await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'control' }, orderBy: { seq: 'asc' } })).map((r) => r.payload as { op: string; reason?: string }).find((p) => p.op === 'stale_decision')
    expect(stale).toMatchObject({ op: 'stale_decision', reason: 'intent_cleared' })
  })

  // ---------------------------------------------------------------------------------------------
  // Final review, Critical #1: the `stale_decision` row is written at the journal's OWN `max(seq)
  // + 1`, so the run's `state.journalSeq` must move with it. It did not, and every later writer
  // computes its seq as `state.journalSeq + 1` (`stepLocked`, `setStatus`, `startAutoRun`) -- so
  // the very next write collided on the journal's `(simulationId, seq)` unique and threw. A stale
  // decision is not a terminal state: the run is still running, still armed, still haltable.
  // ---------------------------------------------------------------------------------------------
  it('a stale-by-version decision moves the journal watermark, so the next pass steps normally', async () => {
    const id = await armedLlmRun('stale-then-step')
    const before = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    // The world moved while the model was thinking: an injection bumps `version` (ruling R8).
    expect((await injectExternalEvent(id, { day: 1, event: { type: 'supplier_delay', supplierId: 'normal', extraDays: 2 } })).ok).toBe(true)
    const applied = await applyModelDecision(id, { expectedVersion: before.version, role: 'purchasing', outcome: answer(), promptHash: 'abc', now: T0 })
    expect(applied.ok && applied.value).toEqual({ applied: false, reason: 'stale' })
    // The watermark now equals the journal's real maximum -- the stale row included.
    const maxSeq = (await prisma.simulationJournalEntry.aggregate({ where: { simulationId: id }, _max: { seq: true } }))._max.seq
    const state = (await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).state as { journalSeq: number }
    expect(state.journalSeq).toBe(maxSeq)
    const report = await tickSimulations({ now: plus(250), modelDecider: async () => answer() })
    expect(report).toMatchObject({ startedModelCalls: 1, halted: 0 })
    await drainModelCalls()
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).simTime).toBe(1)
  })

  it('a stale decision after a stop leaves the run haltable', async () => {
    const id = await armedLlmRun('stale-then-halt')
    const before = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect((await stopAutoRun(id)).ok).toBe(true)
    const applied = await applyModelDecision(id, { expectedVersion: before.version, role: 'purchasing', outcome: answer(), promptHash: 'abc', now: T0 })
    expect(applied.ok && applied.value).toEqual({ applied: false, reason: 'stale' })
    const halted = await haltSimulation(id, 'operator')
    expect(halted.ok).toBe(true)
    expect(await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'halted', haltedReason: 'operator' })
  })

  it('a stale decision leaves the run re-armable', async () => {
    const id = await armedLlmRun('stale-then-arm')
    const before = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect((await stopAutoRun(id)).ok).toBe(true)
    const applied = await applyModelDecision(id, { expectedVersion: before.version, role: 'purchasing', outcome: answer(), promptHash: 'abc', now: T0 })
    expect(applied.ok && applied.value).toEqual({ applied: false, reason: 'stale' })
    const restarted = await startAutoRun(id, { everyMs: 250, untilDay: 5 })
    expect(restarted.ok).toBe(true)
    expect(await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).toMatchObject({ autoRunEveryMs: 250, autoRunUntilDay: 5 })
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
    const ops = (await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'control' }, orderBy: { seq: 'asc' } })).map((r) => r.payload as { op: string; tools?: string[]; reason?: string })
    expect(ops.find((p) => p.op === 'isolation_breach')).toMatchObject({ tools: ['Write', 'Bash'] })
    // Ruling R12: the automatic halt says it halted, like every other halt path -- the breach row
    // names WHAT happened, the `halted` row names what was DONE about it.
    expect(ops.map((p) => p.op).slice(-3)).toEqual(['isolation_breach', 'halted', 'auto_run_stopped'])
    expect(ops.find((p) => p.op === 'halted')).toMatchObject({ reason: 'isolation breach: Write, Bash' })
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

// ---------------------------------------------------------------------------------------------
// M32 item 2: the model step happens OFF the daemon's loop. A pass PREPARES each due llm run,
// starts its `modelDecider(...)` without awaiting it, records the run id in the in-flight set and
// returns; the apply happens when the promise settles. Every test below therefore has two halves
// -- what the pass did (its report, immediately) and what the call did (after `drainModelCalls`).
// Nothing here spawns anything: every decider is a plain function.
// ---------------------------------------------------------------------------------------------

/** A decider whose calls hang until the test releases them, which is the only way to observe a
 *  call that is genuinely in flight across two passes. */
function heldDecider(): {
  readonly decider: ModelDecider
  readonly inputs: { model: string; prompt: string; maxBudgetUsd: number }[]
  readonly release: (outcome?: ModelOutcome) => void
  readonly rejectAll: (error: Error) => void
} {
  const waiting: { resolve: (outcome: ModelOutcome) => void; reject: (error: Error) => void }[] = []
  const inputs: { model: string; prompt: string; maxBudgetUsd: number }[] = []
  return {
    decider: (input) => {
      inputs.push(input)
      return new Promise<ModelOutcome>((resolve, reject) => { waiting.push({ resolve, reject }) })
    },
    inputs,
    release: (outcome = answer()) => { for (const w of waiting.splice(0)) w.resolve(outcome) },
    rejectAll: (error) => { for (const w of waiting.splice(0)) w.reject(error) },
  }
}

describe('tickSimulations with a model decider', () => {
  it('starts every due llm run in ONE pass and returns without waiting for any of them', async () => {
    // The M31a rule this replaces (ruling R7) let one pass make ONE model call, because the pass
    // awaited it inline and a slow call would otherwise stall the whole daemon for the sum of
    // them. Nothing is awaited now, so both runs start together and neither waits a period.
    const a = await armedLlmRun('llm a', { everyMs: 10_000 })
    const b = await armedLlmRun('llm b', { everyMs: 10_000 })
    const held = heldDecider()
    const first = await tickSimulations({ now: T0, modelDecider: held.decider })
    expect(first).toEqual({ candidates: 2, stepped: 0, halted: 0, skippedNoDecider: 0, skippedInFlight: 0, startedModelCalls: 2 })
    expect(held.inputs).toHaveLength(2)
    // The pass returned while both calls were still out: that is the whole point of the change.
    expect(inFlightModelCalls()).toEqual(new Set([a, b]))
    // Neither has stepped yet -- `applyModelDecision` is what steps, and it has not run.
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: a } })).simTime).toBe(0)
    held.release()
    await drainModelCalls()
    expect(inFlightModelCalls().size).toBe(0)
    for (const id of [a, b]) {
      expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).simTime).toBe(1)
      expect(await prisma.simulationModelUsage.count({ where: { simulationId: id } })).toBe(1)
    }
  })

  it('a run whose call is in flight is skipped by the next pass, and never asked twice', async () => {
    const id = await armedLlmRun('in flight')
    const held = heldDecider()
    const first = await tickSimulations({ now: T0, modelDecider: held.decider })
    expect(first).toMatchObject({ startedModelCalls: 1, skippedInFlight: 0 })
    expect(inFlightModelCalls()).toEqual(new Set([id]))
    // Due again by the clock: `lastAutoStepAt` has not moved, because nothing has been applied
    // yet -- so the in-flight set is the only thing standing between this run and a second paid
    // call for the same day.
    const second = await tickSimulations({ now: plus(250), modelDecider: held.decider })
    expect(second).toEqual({ candidates: 1, stepped: 0, halted: 0, skippedNoDecider: 0, skippedInFlight: 1, startedModelCalls: 0 })
    expect(held.inputs).toHaveLength(1)
    held.release()
    await drainModelCalls()
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).simTime).toBe(1)
    expect(await prisma.simulationModelUsage.count({ where: { simulationId: id } })).toBe(1)
  })

  it('the concurrency cap leaves the third due run for a later pass', async () => {
    const a = await armedLlmRun('cap a', { everyMs: 10_000 })
    const b = await armedLlmRun('cap b', { everyMs: 10_000 })
    const c = await armedLlmRun('cap c', { everyMs: 10_000 })
    const held = heldDecider()
    const first = await tickSimulations({ now: T0, modelDecider: held.decider, maxConcurrentModelCalls: 2 })
    expect(first).toEqual({ candidates: 3, stepped: 0, halted: 0, skippedNoDecider: 0, skippedInFlight: 1, startedModelCalls: 2 })
    // Creation order decides who goes: the two oldest due runs, then the cap.
    expect(inFlightModelCalls()).toEqual(new Set([a, b]))
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: c } })).simTime).toBe(0)
    held.release()
    await drainModelCalls()
    const second = await tickSimulations({ now: plus(250), modelDecider: held.decider, maxConcurrentModelCalls: 2 })
    expect(second).toMatchObject({ startedModelCalls: 1 })
    expect(inFlightModelCalls()).toEqual(new Set([c]))
    held.release()
    await drainModelCalls()
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: c } })).simTime).toBe(1)
  })

  it('a decider that rejects halts its own run, leaves the set clean and never throws out of the pass', async () => {
    const bad = await armedLlmRun('rejects')
    const held = heldDecider()
    const report = await tickSimulations({ now: T0, modelDecider: held.decider })
    expect(report).toMatchObject({ startedModelCalls: 1, halted: 0 })
    held.rejectAll(new Error('the CLI died'))
    await drainModelCalls()
    expect(inFlightModelCalls().size).toBe(0)
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id: bad } })
    expect(row).toMatchObject({ status: 'halted', simTime: 0, autoRunEveryMs: null })
    expect(row.haltedReason).toBe('auto-run step failed: the CLI died')
    // No usage row: the call never came back, so nothing is known to have been spent.
    expect(await prisma.simulationModelUsage.count({ where: { simulationId: bad } })).toBe(0)
    // And the next pass simply finds nothing to do.
    expect(await tickSimulations({ now: plus(250), modelDecider: held.decider })).toMatchObject({ candidates: 0 })
  })

  it('an apply that lands after the run was stopped still writes the usage row, and steps nothing (spec §2.6)', async () => {
    const id = await armedLlmRun('stopped mid-call')
    const held = heldDecider()
    await tickSimulations({ now: T0, modelDecider: held.decider })
    expect(inFlightModelCalls()).toEqual(new Set([id]))
    // The operator stops the run while the call is out. Spec §2.6: the call finishes and is
    // billed; its decision is discarded.
    expect((await stopAutoRun(id)).ok).toBe(true)
    held.release()
    await drainModelCalls()
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ simTime: 0, status: 'running', autoRunEveryMs: null })
    expect(await prisma.simulationModelUsage.count({ where: { simulationId: id } })).toBe(1)
    const stale = (await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'control' }, orderBy: { seq: 'asc' } })).map((r) => r.payload as { op: string }).find((p) => p.op === 'stale_decision')
    expect(stale).toBeDefined()
  })

  it('steps the llm run through the decider, reports skippedNoDecider without one, and leaves a rules run alone', async () => {
    const llmId = await armedLlmRun('ticked')
    const rulesCreated = await createSimulation({ companyId, name: 'rules-beside', sector: 'trade', policy: 'A' })
    const rulesId = rulesCreated.ok ? rulesCreated.value.id : ''
    expect((await startAutoRun(rulesId, { everyMs: 250, untilDay: 5 })).ok).toBe(true)

    // No decider: the llm run is skipped untouched and the rules run steps as it always did.
    const without = await tickSimulations({ now: T0 })
    expect(without).toEqual({ candidates: 2, stepped: 1, halted: 0, skippedNoDecider: 1, skippedInFlight: 0, startedModelCalls: 0 })
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: llmId } })).simTime).toBe(0)
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: rulesId } })).simTime).toBe(1)
    expect(await prisma.simulationModelUsage.count({ where: { simulationId: llmId } })).toBe(0)

    const calls: { model: string; prompt: string; maxBudgetUsd: number }[] = []
    const decider = async (input: { model: string; prompt: string; maxBudgetUsd: number }): Promise<ModelOutcome> => {
      calls.push(input)
      return answer()
    }
    // The rules run steps inside the pass; the llm run's call is merely started by it.
    const withDecider = await tickSimulations({ now: plus(250), modelDecider: decider })
    expect(withDecider).toEqual({ candidates: 2, stepped: 1, halted: 0, skippedNoDecider: 0, skippedInFlight: 0, startedModelCalls: 1 })
    await drainModelCalls()
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
    expect(first).toMatchObject({ startedModelCalls: 1, halted: 0 })
    await drainModelCalls()
    const second = await tickSimulations({ now: plus(250), modelDecider: decider })
    expect(second).toMatchObject({ startedModelCalls: 1, halted: 0 })
    await drainModelCalls()
    expect(calls).toBe(2)
    // 0.012 >= 0.01: the third pass never calls the model at all. The budget halt is decided in
    // `prepareModelDecision`, which the pass still awaits, so it is this pass's own `halted`.
    const third = await tickSimulations({ now: plus(500), modelDecider: decider })
    expect(third).toMatchObject({ startedModelCalls: 0, halted: 1 })
    expect(calls).toBe(2)
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ status: 'halted', haltedReason: 'model budget exhausted' })
  })

  it('an unmeasured call charges the per-call cap toward the run cap and never becomes a 0 cost row (ruling R10)', async () => {
    // A cap of 2.5 against a provider that reports nothing: three unmeasured calls charge
    // 3 × PER_CALL_CAP_USD = $3, which is past the cap, so the fourth prepare never calls at all.
    // Counting an unmeasured call as $0 would have let this run spend to the horizon for free.
    const id = await armedLlmRun('unmeasured', { maxModelCostUsd: 2.5 })
    const decider = async (): Promise<ModelOutcome> => answer(ANSWER_TEXT, null)
    for (const at of [T0, plus(250), plus(500)]) {
      await tickSimulations({ now: at, modelDecider: decider })
      await drainModelCalls()
    }
    const usage = await prisma.simulationModelUsage.findMany({ where: { simulationId: id }, orderBy: { seq: 'asc' } })
    expect(usage).toHaveLength(3)
    // Unmeasured stays unmeasured on the row itself: the cap arithmetic charges it, the ledger does not invent a figure.
    for (const row of usage) expect(row.costUsd).toBeNull()
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).status).toBe('running')

    const prepared = await prepareModelDecision(id, plus(750))
    expect(prepared.ok && prepared.value).toEqual({ kind: 'budget' })
    expect(await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'halted', haltedReason: 'model budget exhausted' })
    const exhausted = (await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'control' }, orderBy: { seq: 'asc' } }))
      .map((r) => r.payload as { op: string; spentUsd?: number; unmeasured?: number; chargedUsd?: number; capUsd?: number })
      .find((p) => p.op === 'model_budget_exhausted')
    expect(exhausted).toMatchObject({ spentUsd: 0, unmeasured: 3, chargedUsd: 3 * PER_CALL_CAP_USD, capUsd: 2.5 })
  })

  it('stops at untilDay without spending another cent, and the clear bumps version so the stream sees it (ruling R11)', async () => {
    const id = await armedLlmRun('until', { untilDay: 1 })
    let calls = 0
    const decider = async (): Promise<ModelOutcome> => { calls += 1; return answer() }
    await tickSimulations({ now: T0, modelDecider: decider })
    await drainModelCalls()
    const stepped = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(stepped.simTime).toBe(1)
    await tickSimulations({ now: plus(250), modelDecider: decider })
    await drainModelCalls()
    expect(calls).toBe(1)
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ simTime: 1, status: 'running', autoRunEveryMs: null })
    // Ruling R11: the clear touches neither status nor day, so `version` is the ONLY thing the SSE
    // stream can notice it by -- without this bump the page kept offering "Stop auto-run" forever.
    expect(row.version).toBe(stepped.version + 1)
  })
})
