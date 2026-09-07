import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { autoStepDue, createSimulation, haltSimulation, injectExternalEvent, loadSimulation, pauseSimulation, startAutoRun, stepSimulation, stopAutoRun, tickSimulations } from '../../src/simulation.js'

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

async function create(name = 'Q3 plan', policy: 'A' | 'B' = 'A'): Promise<string> {
  const result = await createSimulation({ companyId, name, sector: 'trade', policy, seed: 7 })
  expect(result.ok).toBe(true)
  return result.ok ? result.value.id : ''
}

const T0 = new Date('2026-09-06T10:00:00Z')
const plus = (ms: number): Date => new Date(T0.getTime() + ms)
async function controlOps(id: string): Promise<readonly string[]> {
  const rows = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'control' }, orderBy: { seq: 'asc' } })
  return rows.map((r) => String((r.payload as { op: string }).op))
}

describe('startAutoRun / stopAutoRun', () => {
  it('validates, flips ready → running, writes the intent, journals; stop clears and journals; stop is idempotent', async () => {
    const id = await create()
    expect((await startAutoRun(id, { everyMs: 100, untilDay: 10 })).ok).toBe(false)
    expect((await startAutoRun(id, { everyMs: 1000, untilDay: 0 })).ok).toBe(false)
    expect((await startAutoRun(id, { everyMs: 1000, untilDay: 31 })).ok).toBe(false)
    expect((await startAutoRun(id, { everyMs: 1000, untilDay: 10 })).ok).toBe(true)
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ status: 'running', autoRunEveryMs: 1000, autoRunUntilDay: 10, lastAutoStepAt: null })
    expect((await loadSimulation(id)).ok && (await loadSimulation(id) as { ok: true; value: { summary: { autoRun: unknown } } }).value.summary.autoRun).toEqual({ everyMs: 1000, untilDay: 10, lastStepAt: null })
    expect((await stopAutoRun(id)).ok).toBe(true)
    expect((await stopAutoRun(id)).ok).toBe(true)
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).autoRunEveryMs).toBeNull()
    expect(await controlOps(id)).toEqual(['created', 'auto_run_started', 'auto_run_stopped'])
  })
  it('pause and halt clear the intent with their reason; a finished run clears it with finished', async () => {
    const a = await create('a')
    await startAutoRun(a, { everyMs: 1000, untilDay: 10 })
    await pauseSimulation(a)
    expect((await controlOps(a)).at(-1)).toBe('auto_run_stopped')
    expect((await prisma.simulationJournalEntry.findFirst({ where: { simulationId: a, kind: 'control' }, orderBy: { seq: 'desc' } }))?.payload).toMatchObject({ reason: 'paused' })
    const b = await create('b')
    await startAutoRun(b, { everyMs: 1000, untilDay: 10 })
    await haltSimulation(b, 'op')
    expect((await prisma.simulationJournalEntry.findFirst({ where: { simulationId: b, kind: 'control' }, orderBy: { seq: 'desc' } }))?.payload).toMatchObject({ op: 'auto_run_stopped', reason: 'halted' })
    const c = await create('c')
    await startAutoRun(c, { everyMs: 1000, untilDay: 30 })
    await stepSimulation(c, { untilDay: 30 })
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: c } })).autoRunEveryMs).toBeNull()
    expect((await prisma.simulationJournalEntry.findFirst({ where: { simulationId: c, kind: 'control' }, orderBy: { seq: 'desc' } }))?.payload).toMatchObject({ op: 'auto_run_stopped', reason: 'finished' })
  })
})

describe('autoStepDue', () => {
  it('steps once when due, refuses when not due, stops at untilDay', async () => {
    const id = await create()
    expect((await autoStepDue(id, T0)).ok && (await autoStepDue(id, T0) as { ok: true; value: { reason?: string } }).value.reason).toBe('no_intent')
    await startAutoRun(id, { everyMs: 1000, untilDay: 2 })
    const first = await autoStepDue(id, T0)
    expect(first.ok && first.value).toEqual({ stepped: true, day: 1 })
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).lastAutoStepAt?.toISOString()).toBe(T0.toISOString())
    const early = await autoStepDue(id, plus(500))
    expect(early.ok && early.value).toEqual({ stepped: false, reason: 'not_due' })
    const second = await autoStepDue(id, plus(1000))
    expect(second.ok && second.value).toEqual({ stepped: true, day: 2 })
    const beforeClear = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    const done = await autoStepDue(id, plus(2000))
    expect(done.ok && done.value).toEqual({ stepped: false, reason: 'until_day' })
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ simTime: 2, status: 'running', autoRunEveryMs: null })
    // Ruling R11 (M31a): the clear moves neither the day nor the status, so `version` is the only
    // thing the run page's SSE stream can see it by -- it must move.
    expect(row.version).toBe(beforeClear.version + 1)
    expect((await controlOps(id)).at(-1)).toBe('auto_run_stopped')
    expect((await prisma.simulationJournalEntry.findFirst({ where: { simulationId: id, kind: 'control' }, orderBy: { seq: 'desc' } }))?.payload).toMatchObject({ op: 'auto_run_stopped', reason: 'until_day' })
    await pauseSimulation(id)
    // `startAutoRun` on a `paused` row refuses (its own status guard: only `ready`/`running` may
    // arm an intent) without writing anything, so the row here is field-identical to a row that
    // never had an intent (autoRunEveryMs/autoRunUntilDay both null) -- the same state line 71
    // above asserts must answer `no_intent`. Task 3 brief's own text expected `not_running` here,
    // but no self-consistent `autoStepDue` (checking intent-null before status, the only order
    // that satisfies line 71) can tell "never had an intent" apart from "had one, now cleared" —
    // `Row` carries no such history field. See task-3-report.md for the full trace.
    await startAutoRun(id, { everyMs: 1000, untilDay: 5 }).catch(() => undefined)
    expect((await autoStepDue(id, plus(3000))).ok && (await autoStepDue(id, plus(3000)) as { ok: true; value: { reason?: string } }).value.reason).toBe('no_intent')
  })
  it('not_running when the intent is still armed but the row itself is paused (fix round 1, item 2)', async () => {
    const id = await create()
    await startAutoRun(id, { everyMs: 1000, untilDay: 10 })
    // Bypasses `pauseSimulation` (which would clear the intent itself) so the row lands in the
    // state `autoStepDue`'s `not_running` branch actually exists for: an armed intent on a row
    // that is not `running`.
    await prisma.simulationRun.update({ where: { id }, data: { status: 'paused' } })
    const result = await autoStepDue(id, T0)
    expect(result.ok && result.value).toEqual({ stepped: false, reason: 'not_running' })
  })
})

describe('tickSimulations', () => {
  it('steps every due run once, skips the rest, and never double-steps under two concurrent passes', async () => {
    const a = await create('a')
    const b = await create('b')
    const c = await create('c')
    await startAutoRun(a, { everyMs: 250, untilDay: 30 })
    await startAutoRun(b, { everyMs: 250, untilDay: 30 })
    await startAutoRun(c, { everyMs: 250, untilDay: 30 })
    await pauseSimulation(c)
    const first = await tickSimulations({ now: T0 })
    expect(first).toEqual({ candidates: 2, stepped: 2, halted: 0, skippedNoDecider: 0 })
    const [x, y] = await Promise.all([tickSimulations({ now: plus(250) }), tickSimulations({ now: plus(250) })])
    expect(x.stepped + y.stepped).toBe(2)
    for (const id of [a, b]) {
      const days = (await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'control' }, orderBy: { seq: 'asc' } }))
        .map((r) => r.payload as { op: string; day?: number }).filter((p) => p.op === 'stepped').map((p) => p.day)
      expect(days).toEqual([1, 2])
    }
  })
  it('skips an llm run when no model decider is injected, and steps the rules run beside it (M31a §4)', async () => {
    const rules = await create('rules beside')
    const llm = await createSimulation({ companyId, name: 'llm run', sector: 'trade', policy: 'A', decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-haiku-4-5', maxModelCostUsd: 1 })
    const llmId = llm.ok ? llm.value.id : ''
    expect(llmId).not.toBe('')
    await startAutoRun(rules, { everyMs: 250, untilDay: 30 })
    await startAutoRun(llmId, { everyMs: 250, untilDay: 30 })
    // `tickSimulations` with no `modelDecider` is the one-shot CLI `tick`: it must never make a
    // model call of its own, so the llm run is counted and left exactly where it was.
    const report = await tickSimulations({ now: T0 })
    expect(report).toEqual({ candidates: 2, stepped: 1, halted: 0, skippedNoDecider: 1 })
    const untouched = await prisma.simulationRun.findUniqueOrThrow({ where: { id: llmId } })
    expect(untouched).toMatchObject({ simTime: 0, status: 'running', autoRunEveryMs: 250, lastAutoStepAt: null })
    expect(await prisma.simulationModelUsage.count({ where: { simulationId: llmId } })).toBe(0)
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: rules } })).simTime).toBe(1)
  })
  it('halts a run whose step throws, with the error in the reason, and keeps ticking the others', async () => {
    const good = await create('good')
    const bad = await create('bad')
    await startAutoRun(good, { everyMs: 250, untilDay: 30 })
    await startAutoRun(bad, { everyMs: 250, untilDay: 30 })
    // Force a step failure without touching the engine: a state row `engineStateSchema` rejects
    // (`simulation_corrupt` from `autoStepDue`), which `tickSimulations` treats exactly like a
    // thrown step -- halt the run with the refusal text and move on to the next run.
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id: bad } })
    const state = row.state as { sector: { suppliers: { unitPriceMinor: unknown }[] } }
    state.sector.suppliers[0]!.unitPriceMinor = 'x'
    await prisma.simulationRun.update({ where: { id: bad }, data: { state: state as object } })
    const report = await tickSimulations({ now: T0 })
    expect(report.stepped).toBe(1)
    expect(report.halted).toBe(1)
    const halted = await prisma.simulationRun.findUniqueOrThrow({ where: { id: bad } })
    expect(halted.status).toBe('halted')
    expect(halted.haltedReason).toMatch(/^auto-run step failed: /)
    expect(halted.autoRunEveryMs).toBeNull()
    const controlRows = await prisma.simulationJournalEntry.findMany({ where: { simulationId: bad, kind: 'control' }, orderBy: { seq: 'asc' } })
    expect(controlRows.map((r) => (r.payload as { op: string }).op).slice(-3)).toEqual(['auto_run_started', 'auto_run_stopped', 'halted'])
    expect(controlRows.find((r) => (r.payload as { op: string }).op === 'auto_run_stopped')?.payload).toMatchObject({ reason: 'error' })
    // `haltUnparsed` (fix round 1, Important #1) never rewrites the corrupt `state` -- it stays as
    // evidence -- so this row still fails `locked()`'s own `parseRow` on `simulation_corrupt`.
    // Either way `injectExternalEvent` must come back a refusal, never throw and never touch a
    // stale `journalSeq`.
    const injected = await injectExternalEvent(bad, { day: 5, event: { type: 'demand', qty: 10, unitPriceMinor: 1_000, dueInDays: 3, collectInDays: 0 } })
    expect(injected.ok).toBe(false)
  })
})
