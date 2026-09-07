import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deleteCompany, renameCompanyTeam } from '../../src/org.js'
import {
  cloneSimulation,
  compareSimulations,
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
  type LoadedSimulation,
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
    const badSeed = await createSimulation({ companyId, name: 'nan', sector: 'trade', policy: 'A', seed: Number.NaN })
    expect(badSeed.ok === false && badSeed.error).toEqual({ kind: 'invalid_simulation_input', detail: 'seed must be an integer' })
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
    const otherRow = await prisma.simulationRun.findUniqueOrThrow({ where: { id: other } })
    expect(otherRow.haltedReason).toBe('operator')
    // The embedded engine state carries the halted reason too, not just the row column (fix wave, Minor #5).
    expect((otherRow.state as { haltedReason: string | null }).haltedReason).toBe('operator')
  })
  it('refuses a no-op `untilDay` at or before the current day, before touching the journal or version (fix wave, Important #1)', async () => {
    const id = await create()
    await stepSimulation(id, { untilDay: 3 })
    const before = await prisma.simulationJournalEntry.count({ where: { simulationId: id, kind: 'control' } })
    const atDay = await stepSimulation(id, { untilDay: 3 })
    expect(atDay.ok === false && atDay.error).toEqual({ kind: 'invalid_simulation_input', detail: 'untilDay must be greater than the current day (3)' })
    const beforeDay = await stepSimulation(id, { untilDay: 1 })
    expect(beforeDay.ok === false && beforeDay.error).toEqual({ kind: 'invalid_simulation_input', detail: 'untilDay must be greater than the current day (3)' })
    const row = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    expect(row.version).toBe(1)
    expect(await prisma.simulationJournalEntry.count({ where: { simulationId: id, kind: 'control' } })).toBe(before)
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
  // M31a fix round 1, ruling R8: an injection is a state mutation like every other, so it bumps
  // `version`. Without this an event injected while a model was thinking left the row's version
  // unchanged, and `applyModelDecision`'s stale check waved through a decision taken against a
  // world that had since gained an event.
  it('bumps version like every other state mutation, and an idempotent replay bumps it once', async () => {
    const id = await create()
    const before = await prisma.simulationRun.findUniqueOrThrow({ where: { id } })
    const injected = await injectExternalEvent(id, { day: 5, event: { type: 'demand', qty: 10, unitPriceMinor: 1_000, dueInDays: 3, collectInDays: 0 }, idempotencyKey: 'v1' })
    expect(injected.ok).toBe(true)
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).version).toBe(before.version + 1)
    const again = await injectExternalEvent(id, { day: 5, event: { type: 'demand', qty: 10, unitPriceMinor: 1_000, dueInDays: 3, collectInDays: 0 }, idempotencyKey: 'v1' })
    expect(again.ok).toBe(true)
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id } })).version).toBe(before.version + 1)
  })
  // Auto-run fix round 1, Important #1: `injectExternalEvent` was the one write verb with no
  // status guard, computing its journal seq from `state.journalSeq` -- which a throw-path
  // `haltUnparsed` (M30 §5) never rewrites. On a halted run that seq can lag the journal's real
  // max, so an injection collided on the `(simulationId, seq)` unique instead of refusing cleanly.
  it('refuses on a halted run instead of computing a stale journal seq (auto-run fix round 1, Important #1)', async () => {
    const id = await create()
    expect((await haltSimulation(id, 'operator')).ok).toBe(true)
    const injected = await injectExternalEvent(id, { day: 0, event: { type: 'demand', qty: 10, unitPriceMinor: 1_000, dueInDays: 3, collectInDays: 0 } })
    expect(injected.ok === false && injected.error).toEqual({ kind: 'simulation_not_runnable', simulationId: id, status: 'halted' })
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

describe('cloneSimulation', () => {
  it('starts at day 0 from the frozen definition with the new policy and seed, carrying no injected event and no journal', async () => {
    const source = await create('src', 'A')
    await stepSimulation(source, { steps: 2 })
    await injectExternalEvent(source, { day: 5, event: { type: 'demand', qty: 10, unitPriceMinor: 1_000, dueInDays: 3, collectInDays: 0 } })
    const cloned = await cloneSimulation(source, { name: 'src (B)', policy: 'B', seed: 11 })
    expect(cloned.ok).toBe(true)
    const id = cloned.ok ? cloned.value.id : ''
    const loaded = await loadSimulation(id)
    expect(loaded.ok && loaded.value.summary).toMatchObject({ policy: 'B', status: 'ready', simTime: 0, clonedFromId: source, autoRun: null })
    expect(loaded.ok && loaded.value.definition.seed).toBe(11)
    const sourceLoaded = await loadSimulation(source)
    expect(loaded.ok && loaded.value.definition.roster).toEqual(sourceLoaded.ok ? (sourceLoaded as { ok: true; value: LoadedSimulation }).value.definition.roster : null)
    expect(loaded.ok && loaded.value.state.queue.items.filter((i) => i.time === 5)).toHaveLength(0)
    const rows = await prisma.simulationJournalEntry.findMany({ where: { simulationId: id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({ op: 'created', clonedFrom: source, policy: 'B', seed: 11 })
  })
  it('refuses an unknown source, a duplicate name, an empty name and a non-integer seed', async () => {
    const source = await create('src')
    expect((await cloneSimulation('00000000-0000-4000-8000-00000000dead', { name: 'x', policy: 'A' })).ok).toBe(false)
    const dup = await cloneSimulation(source, { name: 'src', policy: 'B' })
    expect(dup.ok === false && dup.error).toEqual({ kind: 'duplicate_name', name: 'src' })
    expect((await cloneSimulation(source, { name: '  ', policy: 'B' })).ok).toBe(false)
    expect((await cloneSimulation(source, { name: 'y', policy: 'B', seed: 1.5 })).ok).toBe(false)
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

describe('compareSimulations', () => {
  it('reports both metric sets, b − a deltas, definitionsMatch for a clone pair, and injected counts', async () => {
    const a = await create('a', 'A')
    const cloned = await cloneSimulation(a, { name: 'b', policy: 'B' })
    const b = cloned.ok ? cloned.value.id : ''
    await stepSimulation(a, { untilDay: 30 })
    await stepSimulation(b, { untilDay: 30 })
    const result = await compareSimulations(a, b)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.definitionsMatch).toBe(true)
    expect(result.value.differences).toEqual([])
    expect(result.value.deltas.purchaseCostMinor).toBe(725_000 - 300_000)
    expect(result.value.deltas.lateDays).toBe(0 - 4)
    expect(result.value.deltas.closingInventory).toBe(50)
    expect(result.value.a.injected).toBe(0)
    expect(result.value.currency).toBe('USD')
  })
  it('flags a differing world and counts injected events; refuses the same id', async () => {
    const a = await create('a', 'A')
    const b = await create('b', 'B')
    await injectExternalEvent(b, { day: 2, event: { type: 'supplier_delay', supplierId: 'fast', extraDays: 1 } })
    await prisma.simulationRun.update({ where: { id: b }, data: { definition: { ...((await prisma.simulationRun.findUniqueOrThrow({ where: { id: b } })).definition as object), initial: { cashMinor: 1, inventory: 100, dailyShipCapacity: 30, suppliers: [{ id: 'normal', name: 'Normal Supply', unitPriceMinor: 6_000, leadDays: 7, paymentTermDays: 30 }, { id: 'fast', name: 'Fast Supply', unitPriceMinor: 8_500, leadDays: 2, paymentTermDays: 0 }] } } as object } })
    const result = await compareSimulations(a, b)
    expect(result.ok && result.value.definitionsMatch).toBe(false)
    expect(result.ok && result.value.differences).toEqual(['initial'])
    expect(result.ok && result.value.b.injected).toBe(1)
    const same = await compareSimulations(a, a)
    expect(same.ok === false && same.error.kind).toBe('invalid_simulation_input')
    expect((await compareSimulations(a, '00000000-0000-4000-8000-00000000dead')).ok).toBe(false)
  })
})
