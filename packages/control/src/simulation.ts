import { Prisma, prisma } from '@slave-of-ai/db/client'
import { err, ok, type Result } from '@slave-of-ai/domain'
import {
  RulesDecisionProvider, demoDefinition, replay, runUntil, tradeExternalEventSchema, tradeInitialEngineState, tradeMetrics, tradeModel,
  tradeSimulationDefinitionSchema, tradeStateSchema, type EngineState, type JournalEntry, type TradeEvent, type TradeMetrics, type TradeSimulationDefinition, type TradeState,
} from '@slave-of-ai/simulation'
import { z } from 'zod'
import { isUniqueConstraintViolation } from './prisma-errors.js'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

/** One request steps at most this many days, whatever `untilDay` asks (spec §6). */
export const MAX_STEPS_PER_REQUEST = 365

const SUPPORTED: ReadonlySet<string> = new Set(['trade:simulation'])

export interface SimulationSummary {
  readonly id: string
  readonly companyId: string
  readonly companyName: string
  readonly name: string
  readonly sector: 'trade'
  readonly mode: 'simulation'
  readonly decisionProvider: 'rules'
  readonly policy: 'A' | 'B'
  readonly status: 'ready' | 'running' | 'paused' | 'finished' | 'halted'
  readonly simTime: number
  readonly horizonDays: number
  readonly stepCount: number
  readonly decisionCount: number
  readonly version: number
  readonly haltedReason: string | null
  readonly createdAt: string
  readonly synthetic: true
}

export interface LoadedSimulation {
  readonly summary: SimulationSummary
  readonly definition: TradeSimulationDefinition
  readonly state: EngineState<TradeState, TradeEvent>
}

const queueItemSchema = z.object({ time: z.number().int(), priority: z.enum(['external', 'scheduled', 'decision', 'close']), seq: z.number().int(), event: z.unknown() })
const engineStateSchema = z.object({
  day: z.number().int(), sector: tradeStateSchema, queue: z.object({ items: z.array(queueItemSchema), nextSeq: z.number().int() }), rngState: z.number(),
  journalSeq: z.number().int(), stepCount: z.number().int(), decisionCount: z.number().int(), status: z.enum(['ready', 'running', 'finished', 'halted']), haltedReason: z.string().nullable(),
})

type Row = Prisma.SimulationRunGetPayload<{ include: { company: { select: { name: true } } } }>

function summarize(row: Row, definition: TradeSimulationDefinition): SimulationSummary {
  return {
    id: row.id, companyId: row.companyId, companyName: row.company.name, name: row.name, sector: 'trade', mode: 'simulation', decisionProvider: 'rules',
    policy: definition.policy, status: row.status, simTime: row.simTime, horizonDays: definition.horizonDays, stepCount: row.stepCount, decisionCount: row.decisionCount,
    version: row.version, haltedReason: row.haltedReason, createdAt: row.createdAt.toISOString(), synthetic: true,
  }
}

function parseRow(row: Row): Result<LoadedSimulation, ControlRefusal> {
  const definition = tradeSimulationDefinitionSchema.safeParse(row.definition)
  if (!definition.success) return err({ kind: 'simulation_corrupt', simulationId: row.id, reason: `definition: ${definition.error.issues[0]?.message ?? 'invalid'}` })
  const state = engineStateSchema.safeParse(row.state)
  if (!state.success) return err({ kind: 'simulation_corrupt', simulationId: row.id, reason: `state: ${state.error.issues[0]?.message ?? 'invalid'}` })
  const typed = definition.data as TradeSimulationDefinition
  return ok({ summary: summarize(row, typed), definition: typed, state: state.data as EngineState<TradeState, TradeEvent> })
}

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

function journalRows(simulationId: string, entries: readonly JournalEntry[]): Prisma.SimulationJournalEntryCreateManyInput[] {
  return entries.map((e) => ({ simulationId, seq: e.seq, simTime: e.simTime, kind: e.kind, actorRole: e.actorRole, payload: json(e.payload) }))
}

export async function createSimulation(
  input: { readonly companyId: string; readonly name: string; readonly sector: 'trade'; readonly mode?: 'simulation'; readonly policy: 'A' | 'B'; readonly seed?: number; readonly scenario?: 'demo' },
  principal?: Principal,
): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  const mode = input.mode ?? 'simulation'
  if (!SUPPORTED.has(`${input.sector}:${mode}`)) return err({ kind: 'unsupported_simulation', sector: input.sector, mode })
  if (input.name.trim() === '') return err({ kind: 'invalid_simulation_input', detail: 'name must not be empty' })
  const company = await prisma.company.findUnique({ where: { id: input.companyId }, include: { teams: { orderBy: { name: 'asc' }, include: { slaves: { orderBy: { name: 'asc' } } } } } })
  if (company === null) return err({ kind: 'company_not_found', companyId: input.companyId })
  const roster = company.teams.flatMap((team) => team.slaves.map((slave) => ({ slaveName: slave.name, departmentName: team.name })))
  if (roster.length < 4) return err({ kind: 'roster_too_small', companyId: company.id, needed: 4, have: roster.length })
  const seed = input.seed ?? 1
  const definition = demoDefinition({ policy: input.policy, seed, roster, currency: 'USD' })
  const state = tradeInitialEngineState(definition)
  try {
    const row = await prisma.simulationRun.create({
      data: {
        companyId: company.id, name: input.name.trim(), sector: 'trade', mode: 'simulation', decisionProvider: 'rules', seed,
        definition: json(definition), state: json(state), createdByUserId: principal?.userId ?? null,
        journal: { create: { seq: 0, simTime: 0, kind: 'control', actorRole: null, payload: { op: 'created', policy: input.policy, seed, synthetic: true } } },
      },
    })
    return ok({ id: row.id })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name: input.name.trim() })
    throw error
  }
}

async function locked(tx: Prisma.TransactionClient, simulationId: string): Promise<Result<{ row: Row; loaded: LoadedSimulation }, ControlRefusal>> {
  await tx.$queryRaw`SELECT id FROM "SimulationRun" WHERE id = ${simulationId} FOR UPDATE`
  const row = await tx.simulationRun.findUnique({ where: { id: simulationId }, include: { company: { select: { name: true } } } })
  if (row === null) return err({ kind: 'simulation_not_found', simulationId })
  const loaded = parseRow(row)
  return loaded.ok ? ok({ row, loaded: loaded.value }) : loaded
}

export async function stepSimulation(
  simulationId: string,
  input: { readonly steps?: number; readonly untilDay?: number; readonly idempotencyKey?: string; readonly expectedVersion?: number },
  _principal?: Principal,
): Promise<Result<{ readonly day: number; readonly status: string; readonly version: number; readonly entries: number; readonly replayed: boolean }, ControlRefusal>> {
  if (input.steps !== undefined && (!Number.isInteger(input.steps) || input.steps < 1)) return err({ kind: 'invalid_simulation_input', detail: 'steps must be a positive integer' })
  if (input.untilDay !== undefined && (!Number.isInteger(input.untilDay) || input.untilDay < 0)) return err({ kind: 'invalid_simulation_input', detail: 'untilDay must be a non-negative integer' })
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value
    if (input.idempotencyKey !== undefined) {
      const seen = await tx.simulationJournalEntry.findUnique({ where: { simulationId_idempotencyKey: { simulationId, idempotencyKey: input.idempotencyKey } } })
      if (seen !== null) {
        const p = seen.payload as { day?: number; status?: string; version?: number; entries?: number }
        return ok({ day: p.day ?? row.simTime, status: p.status ?? row.status, version: p.version ?? row.version, entries: p.entries ?? 0, replayed: true })
      }
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) return err({ kind: 'stale_version', simulationId, expected: input.expectedVersion, actual: row.version })
    if (row.status !== 'ready' && row.status !== 'running') return err({ kind: 'simulation_not_runnable', simulationId, status: row.status })
    const untilDay = input.untilDay ?? loaded.state.day + (input.steps ?? 1)
    const provider = new RulesDecisionProvider(loaded.definition)
    const result = runUntil(tradeModel, loaded.definition, loaded.state, provider, Math.min(untilDay, loaded.definition.horizonDays), MAX_STEPS_PER_REQUEST)
    const version = row.version + 1
    const status = result.state.status
    const controlSeq = result.state.journalSeq + 1
    const outcome = { day: result.state.day, status, version, entries: result.entries.length }
    await tx.simulationJournalEntry.createMany({ data: journalRows(simulationId, result.entries) })
    await tx.simulationJournalEntry.create({
      data: { simulationId, seq: controlSeq, simTime: result.state.day, kind: 'control', actorRole: null, idempotencyKey: input.idempotencyKey ?? null, payload: { op: 'stepped', ...outcome } },
    })
    await tx.simulationRun.update({
      where: { id: simulationId },
      data: { state: json({ ...result.state, journalSeq: controlSeq }), version, status, simTime: result.state.day, stepCount: result.state.stepCount, decisionCount: result.state.decisionCount, haltedReason: result.state.haltedReason },
    })
    return ok({ ...outcome, replayed: false })
  })
}

async function setStatus(simulationId: string, from: readonly string[], to: 'paused' | 'running' | 'halted', op: string, haltedReason: string | null): Promise<Result<void, ControlRefusal>> {
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value
    if (!from.includes(row.status)) return err({ kind: 'simulation_not_runnable', simulationId, status: row.status })
    const seq = loaded.state.journalSeq + 1
    await tx.simulationJournalEntry.create({ data: { simulationId, seq, simTime: row.simTime, kind: 'control', actorRole: null, payload: { op, reason: haltedReason } } })
    await tx.simulationRun.update({ where: { id: simulationId }, data: { status: to, haltedReason, state: json({ ...loaded.state, journalSeq: seq, status: to === 'paused' ? loaded.state.status : to }) } })
    return ok(undefined)
  })
}

export const pauseSimulation = (id: string, _principal?: Principal): Promise<Result<void, ControlRefusal>> => setStatus(id, ['ready', 'running'], 'paused', 'paused', null)
export const resumeSimulation = (id: string, _principal?: Principal): Promise<Result<void, ControlRefusal>> => setStatus(id, ['paused'], 'running', 'resumed', null)
/** The emergency stop. Stepping is in-request, so nothing is in flight to kill: this blocks every
 *  next step (and, in M31, every model call). */
export const haltSimulation = (id: string, reason: string, _principal?: Principal): Promise<Result<void, ControlRefusal>> => setStatus(id, ['ready', 'running', 'paused'], 'halted', 'halted', reason)

export async function injectExternalEvent(
  simulationId: string,
  input: { readonly day: number; readonly event: unknown; readonly idempotencyKey?: string },
  _principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const parsed = tradeExternalEventSchema.safeParse(input.event)
  if (!parsed.success) return err({ kind: 'invalid_simulation_input', detail: `event: ${parsed.error.issues[0]?.message ?? 'not an external event'}` })
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value
    if (!Number.isInteger(input.day) || input.day < loaded.state.day) return err({ kind: 'invalid_simulation_input', detail: `day must be an integer ≥ the current day (${loaded.state.day})` })
    if (input.idempotencyKey !== undefined) {
      const seen = await tx.simulationJournalEntry.findUnique({ where: { simulationId_idempotencyKey: { simulationId, idempotencyKey: input.idempotencyKey } } })
      if (seen !== null) return ok(undefined)
    }
    const queue = loaded.state.queue
    const item = { time: input.day, priority: 'external' as const, seq: queue.nextSeq, event: parsed.data }
    const seq = loaded.state.journalSeq + 1
    await tx.simulationJournalEntry.create({ data: { simulationId, seq, simTime: row.simTime, kind: 'external_event', actorRole: null, idempotencyKey: input.idempotencyKey ?? null, payload: { op: 'injected', day: input.day, event: json(parsed.data) } } })
    await tx.simulationRun.update({ where: { id: simulationId }, data: { state: json({ ...loaded.state, journalSeq: seq, queue: { items: [...queue.items, item], nextSeq: queue.nextSeq + 1 } }) } })
    return ok(undefined)
  })
}

export async function deleteSimulation(simulationId: string, _principal?: Principal): Promise<Result<void, ControlRefusal>> {
  const { count } = await prisma.simulationRun.deleteMany({ where: { id: simulationId } })
  return count === 0 ? err({ kind: 'simulation_not_found', simulationId }) : ok(undefined)
}

export async function loadSimulation(simulationId: string): Promise<Result<LoadedSimulation, ControlRefusal>> {
  const row = await prisma.simulationRun.findUnique({ where: { id: simulationId }, include: { company: { select: { name: true } } } })
  if (row === null) return err({ kind: 'simulation_not_found', simulationId })
  return parseRow(row)
}

export async function listSimulations(companyId?: string): Promise<readonly SimulationSummary[]> {
  const rows = await prisma.simulationRun.findMany({ where: companyId === undefined ? {} : { companyId }, include: { company: { select: { name: true } } }, orderBy: [{ createdAt: 'desc' }] })
  return rows.flatMap((row) => { const p = parseRow(row); return p.ok ? [p.value.summary] : [] })
}

/** Re-runs the engine from the frozen definition with the journal's own decisions and compares. */
export async function replaySimulation(simulationId: string): Promise<Result<{ readonly matches: boolean }, ControlRefusal>> {
  const loaded = await loadSimulation(simulationId)
  if (!loaded.ok) return loaded
  const rows = await prisma.simulationJournalEntry.findMany({ where: { simulationId, kind: { in: ['decision', 'action_applied', 'action_rejected', 'event', 'external_event'] } }, orderBy: { seq: 'asc' } })
  const entries: JournalEntry[] = rows.map((r) => ({ seq: r.seq, simTime: r.simTime, kind: r.kind, actorRole: r.actorRole, payload: r.payload as Record<string, unknown> }))
  const initial = tradeInitialEngineState(loaded.value.definition)
  const injected = rows.filter((r) => r.kind === 'external_event' && (r.payload as { op?: string }).op === 'injected')
  let seeded = initial
  for (const r of injected) {
    const p = r.payload as { day: number; event: TradeEvent }
    seeded = { ...seeded, queue: { items: [...seeded.queue.items, { time: p.day, priority: 'external', seq: seeded.queue.nextSeq, event: p.event }], nextSeq: seeded.queue.nextSeq + 1 } }
  }
  const replayed = replay(tradeModel, loaded.value.definition, seeded, entries.filter((e) => !(e.kind === 'external_event' && e.payload['op'] === 'injected')))
  const stored = loaded.value.state
  return ok({ matches: comparable(replayed) === comparable(stored) })
}

/** What replay must reproduce: the day, the sector state, the counters and the PENDING events as a
 *  `(time, priority, event)` list. Not compared: `journalSeq` (the stored state counts the control
 *  entries too), `status` (a paused row keeps its engine status), and the queue's own `seq`/`nextSeq`
 *  (an event injected mid-run was enqueued after the rules' own schedules; replay enqueues it up
 *  front, so the tie-break numbers differ while the pending events do not). */
function comparable(state: EngineState<TradeState, TradeEvent>): string {
  const pending = [...state.queue.items].map((i) => ({ time: i.time, priority: i.priority, event: i.event })).sort((a, b) => a.time - b.time || a.priority.localeCompare(b.priority) || JSON.stringify(a.event).localeCompare(JSON.stringify(b.event)))
  return JSON.stringify({ day: state.day, sector: state.sector, stepCount: state.stepCount, decisionCount: state.decisionCount, pending })
}

/** Read model for an operator's dashboard (Task 8): the summary, the sector's headline numbers,
 *  the derived trade metrics computed from the journal, and how much real model spend (M31 writes
 *  it, M29 never does) is attributed so far. */
export async function simulationStatus(
  simulationId: string,
): Promise<Result<{ readonly summary: SimulationSummary; readonly company: { readonly day: number; readonly cashMinor: number; readonly inventory: number; readonly openOrders: number }; readonly metrics: TradeMetrics; readonly modelUsage: { readonly rows: number; readonly costUsd: number | null; readonly unmeasured: number } }, ControlRefusal>> {
  const loaded = await loadSimulation(simulationId)
  if (!loaded.ok) return loaded
  const rows = await prisma.simulationJournalEntry.findMany({ where: { simulationId }, orderBy: { seq: 'asc' } })
  const entries: JournalEntry[] = rows.map((r) => ({ seq: r.seq, simTime: r.simTime, kind: r.kind, actorRole: r.actorRole, payload: r.payload as Record<string, unknown> }))
  const usage = await prisma.simulationModelUsage.aggregate({ where: { simulationId }, _count: { _all: true }, _sum: { costUsd: true } })
  const unmeasured = await prisma.simulationModelUsage.count({ where: { simulationId, costUsd: null } })
  const sector = loaded.value.state.sector
  return ok({
    summary: loaded.value.summary,
    company: { day: loaded.value.state.day, cashMinor: sector.cashMinor, inventory: sector.inventory, openOrders: sector.orders.filter((o) => o.status !== 'shipped').length },
    metrics: tradeMetrics(entries, sector),
    modelUsage: { rows: usage._count._all, costUsd: usage._count._all === 0 || usage._sum.costUsd === null ? null : usage._sum.costUsd, unmeasured },
  })
}
