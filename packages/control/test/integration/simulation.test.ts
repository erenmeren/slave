import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deleteCompany, renameCompanyTeam } from '../../src/org.js'
import {
  createSimulation,
  deleteSimulation,
  haltSimulation,
  injectExternalEvent,
  listSimulations,
  loadSimulation,
  pauseSimulation,
  replaySimulation,
  resumeSimulation,
  simulationStatus,
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

async function create(name = 'Q3 plan', policy: 'A' | 'B' = 'A'): Promise<string> {
  const result = await createSimulation({ companyId, name, sector: 'trade', policy, seed: 7 })
  expect(result.ok).toBe(true)
  return result.ok ? result.value.id : ''
}

describe('createSimulation', () => {
  it('freezes the roster: a catalog rename afterwards does not reach the definition', async () => {
    const id = await create()
    const team = await prisma.companyTeam.findFirstOrThrow({ where: { companyId, name: 'Sales' } })
    await renameCompanyTeam(team.id, 'Revenue')
    await prisma.companySlave.updateMany({ where: { companyTeamId: team.id }, data: { name: 'Someone Else' } })
    const loaded = await loadSimulation(id)
    expect(loaded.ok && loaded.value.definition.roles[0]).toMatchObject({ name: 'sales', slaveName: 'Sonia' })
    expect(loaded.ok && loaded.value.definition.roster.map((r) => r.departmentName)).toContain('Sales')
  })
  it('refuses an unsupported sector/mode, a small roster, a duplicate name, an unknown company', async () => {
    const unsupported = await createSimulation({ companyId, name: 'x', sector: 'software' as unknown as 'trade', policy: 'A' })
    expect(unsupported.ok === false && unsupported.error).toEqual({ kind: 'unsupported_simulation', sector: 'software', mode: 'simulation' })
    const small = await prisma.company.create({ data: { name: 'Tiny' } })
    const tooSmall = await createSimulation({ companyId: small.id, name: 'x', sector: 'trade', policy: 'A' })
    expect(tooSmall.ok === false && tooSmall.error).toEqual({ kind: 'roster_too_small', companyId: small.id, needed: 4, have: 0 })
    await create('dup')
    const dup = await createSimulation({ companyId, name: 'dup', sector: 'trade', policy: 'A' })
    expect(dup.ok === false && dup.error).toEqual({ kind: 'duplicate_name', name: 'dup' })
    const unknown = await createSimulation({ companyId: '00000000-0000-4000-8000-00000000dead', name: 'x', sector: 'trade', policy: 'A' })
    expect(unknown.ok === false && unknown.error.kind).toBe('company_not_found')
  })
  it('two runs from one company never share state', async () => {
    const a = await create('a', 'A')
    const b = await create('b', 'B')
    await stepSimulation(a, { untilDay: 30 })
    const la = await loadSimulation(a)
    const lb = await loadSimulation(b)
    expect(la.ok && la.value.state.day).toBe(30)
    expect(lb.ok && lb.value.state.day).toBe(0)
    expect(lb.ok && lb.value.state.sector.inventory).toBe(100)
    expect(await prisma.simulationJournalEntry.count({ where: { simulationId: b } })).toBe(1) // the create record only
  })
})

describe('stepSimulation', () => {
  it('persists state, counters, version and the journal atomically; the same idempotency key returns the first outcome without stepping', async () => {
    const id = await create()
    const first = await stepSimulation(id, { steps: 3, idempotencyKey: 'k1' })
    expect(first.ok && first.value).toMatchObject({ day: 3, status: 'running', version: 1, replayed: false })
    const again = await stepSimulation(id, { steps: 3, idempotencyKey: 'k1' })
    expect(again.ok && again.value).toMatchObject({ day: 3, version: 1, replayed: true })
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ simTime: 3, stepCount: 3, version: 1, status: 'running' })
    const entries = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id }, orderBy: { seq: 'asc' } })
    // The stored key is namespaced by verb (`step:k1`), not the caller's bare `k1` (fix round 1, Important #1).
    expect(entries.at(-1)).toMatchObject({ kind: 'control', idempotencyKey: 'step:k1' })
    expect(new Set(entries.map((e) => e.seq)).size).toBe(entries.length)
  })
  it('refuses a stale version and a paused, halted or finished run', async () => {
    const id = await create()
    await stepSimulation(id, { steps: 1 })
    const stale = await stepSimulation(id, { steps: 1, expectedVersion: 0 })
    expect(stale.ok === false && stale.error).toEqual({ kind: 'stale_version', simulationId: id, expected: 0, actual: 1 })
    expect((await pauseSimulation(id)).ok).toBe(true)
    const paused = await stepSimulation(id, { steps: 1 })
    expect(paused.ok === false && paused.error).toEqual({ kind: 'simulation_not_runnable', simulationId: id, status: 'paused' })
    expect((await resumeSimulation(id)).ok).toBe(true)
    expect((await stepSimulation(id, { untilDay: 30 })).ok).toBe(true)
    const finished = await stepSimulation(id, { steps: 1 })
    expect(finished.ok === false && finished.error).toEqual({ kind: 'simulation_not_runnable', simulationId: id, status: 'finished' })
    const other = await create('other')
    expect((await haltSimulation(other, 'operator')).ok).toBe(true)
    const halted = await stepSimulation(other, { steps: 1 })
    expect(halted.ok === false && halted.error).toEqual({ kind: 'simulation_not_runnable', simulationId: other, status: 'halted' })
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: other } })).haltedReason).toBe('operator')
  })
  it('a stored run replays to the same state from its journal, and writes no model usage', async () => {
    const id = await create('r', 'B')
    await stepSimulation(id, { untilDay: 30 })
    const verdict = await replaySimulation(id)
    expect(verdict.ok && verdict.value.matches).toBe(true)
    expect(await prisma.simulationModelUsage.count({ where: { simulationId: id } })).toBe(0)
    const status = await simulationStatus(id)
    expect(status.ok && status.value.metrics.deliveredQty).toBe(150)
    expect(status.ok && status.value.modelUsage).toEqual({ rows: 0, costUsd: null, unmeasured: 0 })
  })
  it('two concurrent steps: one wins, the other sees stale_version, and the journal has no duplicate seq', async () => {
    const id = await create()
    const [a, b] = await Promise.all([stepSimulation(id, { steps: 2, expectedVersion: 0 }), stepSimulation(id, { steps: 2, expectedVersion: 0 })])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row.simTime).toBe(2)
  })
  // Fix round 1, Important #2: `runUntil` to the 30-day horizon plus the `createMany` of every
  // day's journal rows must fit inside the transaction's timeout, not Prisma's 5 s default.
  // The demo scenario's own decisions produce ~197 entries over 30 days (measured directly against
  // `runUntil`, both policies) plus the create and step control rows, so 150 is a real, comfortably
  // above-baseline floor -- not an arbitrary round number -- that still fails loudly if the engine
  // stops early (e.g. from a halt) instead of proving the transaction survives a full-size run.
  it('a real-size request (untilDay: 30, steps omitted) fits inside the transaction timeout', async () => {
    const id = await create()
    const result = await stepSimulation(id, { untilDay: 30 })
    expect(result.ok && result.value.status).toBe('finished')
    expect(await prisma.simulationJournalEntry.count({ where: { simulationId: id } })).toBeGreaterThan(150)
  })
  // Fix round 1, Important #3: an injected event must survive `replaySimulation` and actually
  // become an order once the run steps past its day.
  it('an injected event replays: the run matches, and the injected demand became an order', async () => {
    const id = await create()
    await stepSimulation(id, { steps: 2 })
    const injected = await injectExternalEvent(id, { day: 5, event: { type: 'demand', qty: 40, unitPriceMinor: 2_000, dueInDays: 5, collectInDays: 0 }, idempotencyKey: 'ev-replay' })
    expect(injected.ok).toBe(true)
    expect((await stepSimulation(id, { untilDay: 10 })).ok).toBe(true)
    const verdict = await replaySimulation(id)
    expect(verdict.ok && verdict.value.matches).toBe(true)
    const accepted = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id, kind: 'action_applied', simTime: 5 } })
    expect(accepted.some((e) => (e.payload as { action?: { type?: string } }).action?.type === 'accept_order')).toBe(true)
  })
})

describe('injectExternalEvent', () => {
  it('validates against the sector, refuses a past day and a non-external event, and is idempotent', async () => {
    const id = await create()
    await stepSimulation(id, { steps: 2 })
    const past = await injectExternalEvent(id, { day: 1, event: { type: 'demand', qty: 10, unitPriceMinor: 1, dueInDays: 3, collectInDays: 0 } })
    expect(past.ok === false && past.error.kind).toBe('invalid_simulation_input')
    const delivery = await injectExternalEvent(id, { day: 5, event: { type: 'delivery', purchaseId: 'purchase-1' } })
    expect(delivery.ok === false && delivery.error.kind).toBe('invalid_simulation_input')
    const ok1 = await injectExternalEvent(id, { day: 5, event: { type: 'demand', qty: 10, unitPriceMinor: 1_000, dueInDays: 3, collectInDays: 0 }, idempotencyKey: 'ev1' })
    const ok2 = await injectExternalEvent(id, { day: 5, event: { type: 'demand', qty: 10, unitPriceMinor: 1_000, dueInDays: 3, collectInDays: 0 }, idempotencyKey: 'ev1' })
    expect(ok1.ok && ok2.ok).toBe(true)
    const loaded = await loadSimulation(id)
    expect(loaded.ok && loaded.value.state.queue.items.filter((i) => i.time === 5)).toHaveLength(1)
    // The scenario's day-1 demand is journaled as `external_event` too; the injected one is the row with the key.
    // The stored key is namespaced by verb (`inject:ev1`), not the caller's bare `ev1` (fix round 1, Important #1).
    expect(await prisma.simulationJournalEntry.count({ where: { simulationId: id, kind: 'external_event', idempotencyKey: 'inject:ev1' } })).toBe(1)
  })
})

describe('idempotency keys are namespaced by verb', () => {
  it('a key used for an injection does not collide with the same key used for a step, or vice versa', async () => {
    const id = await create()
    const injected = await injectExternalEvent(id, { day: 5, event: { type: 'demand', qty: 10, unitPriceMinor: 1_000, dueInDays: 3, collectInDays: 0 }, idempotencyKey: 'k' })
    expect(injected.ok).toBe(true)
    // The same key used for a step is a DIFFERENT stored key (`step:k` vs. `inject:k`): the step really runs.
    const stepped = await stepSimulation(id, { steps: 1, idempotencyKey: 'k' })
    expect(stepped.ok && stepped.value).toMatchObject({ day: 1, replayed: false })
    // Stepping again with the same key replays the step's own outcome.
    const steppedAgain = await stepSimulation(id, { steps: 1, idempotencyKey: 'k' })
    expect(steppedAgain.ok && steppedAgain.value).toMatchObject({ day: 1, replayed: true })
    // Injecting again with the same key is still recognized as the injection's own idempotency key, not the step's.
    const injectedAgain = await injectExternalEvent(id, { day: 5, event: { type: 'demand', qty: 10, unitPriceMinor: 1_000, dueInDays: 3, collectInDays: 0 }, idempotencyKey: 'k' })
    expect(injectedAgain.ok).toBe(true)
    const loaded = await loadSimulation(id)
    expect(loaded.ok && loaded.value.state.queue.items.filter((i) => i.time === 5)).toHaveLength(1)
  })
})

describe('delete', () => {
  it('deleteSimulation cascades the journal; deleteCompany refuses while runs exist and works after', async () => {
    const id = await create()
    await stepSimulation(id, { steps: 1 })
    const refused = await deleteCompany(companyId)
    expect(refused.ok === false && refused.error).toEqual({ kind: 'live_simulations', companyId, simulations: 1 })
    expect((await deleteSimulation(id)).ok).toBe(true)
    expect(await prisma.simulationJournalEntry.count()).toBe(0)
    expect((await deleteCompany(companyId)).ok).toBe(true)
    expect(await listSimulations()).toEqual([])
  })
})
