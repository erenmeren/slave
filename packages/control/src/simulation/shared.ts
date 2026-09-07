import { Prisma } from '@slave-of-ai/db/client'
import { err, ok, type Result } from '@slave-of-ai/domain'
import {
  sectorFor, sectors, type AnySectorPlugin, type EngineDefinition, type EngineState, type JournalEntry, type SectorName,
} from '@slave-of-ai/simulation'
import { z } from 'zod'
import type { ControlRefusal } from '../refusal.js'

/** One request steps at most this many days, whatever `untilDay` asks (spec §6). */
export const MAX_STEPS_PER_REQUEST = 365

/** M31b §4: the supported set is the registry, not a literal. A third sector is one entry in
 *  `packages/simulation`'s `sectors` and nothing here. */
export const SUPPORTED: ReadonlySet<string> = new Set(Object.keys(sectors).map((sector) => `${sector}:simulation`))

export interface SimulationSummary {
  readonly id: string
  readonly companyId: string
  readonly companyName: string
  readonly name: string
  readonly sector: SectorName
  readonly mode: 'simulation'
  readonly decisionProvider: 'rules' | 'llm'
  readonly modelProvider: 'claude_code' | 'cursor' | null
  readonly model: string | null
  readonly maxModelCostUsd: number | null
  readonly llmRoles: readonly string[]
  readonly policy: 'A' | 'B'
  readonly status: 'ready' | 'running' | 'paused' | 'finished' | 'halted'
  readonly simTime: number
  readonly horizonDays: number
  readonly stepCount: number
  readonly actionCount: number
  readonly version: number
  readonly haltedReason: string | null
  readonly createdAt: string
  readonly synthetic: true
  readonly autoRun: { readonly everyMs: number; readonly untilDay: number; readonly lastStepAt: string | null } | null
  readonly clonedFromId: string | null
  readonly clonedFromName: string | null
}

/** What EVERY sector's frozen definition carries, whatever else it carries beside it (M31b §4):
 *  the engine's own fields plus the three control itself reads — the currency a money figure is
 *  formatted in, the policy the summary reports, and which roles decide with a model. The
 *  `Record<string, unknown>` tail is how a caller that already knows the sector (the trade run
 *  page, until Task 4 generalises it) reaches a sector-specific field without control naming one. */
export type LoadedDefinition = EngineDefinition & {
  readonly currency: string
  readonly policy: 'A' | 'B'
  readonly llmRoles: readonly string[]
} & Record<string, unknown>

/** A run as control reads it: the row's summary, the plugin its `sector` resolves to, and the
 *  definition and state parsed by THAT plugin's schemas. Nothing downstream names a sector; it
 *  asks `plugin` (M31b §1 principle 1). */
export interface LoadedSimulation {
  readonly summary: SimulationSummary
  readonly sector: SectorName
  readonly plugin: AnySectorPlugin
  readonly definition: LoadedDefinition
  readonly state: EngineState<unknown, unknown>
}

/** The engine's own envelope around a sector state, built per plugin: everything but `sector` is
 *  the same for every sector, and `sector` is the plugin's own `stateSchema`.
 *
 *  The queue's `event` is deliberately `z.unknown()`. A queue holds every event the sector
 *  schedules — `task_finished`, `defect_surfaced`, trade's `delivery` — not just the injectable
 *  ones, and the plugin contract (design §2) publishes only `externalEventSchema`. The events in
 *  a stored queue were written by the engine itself from a definition this same parse has already
 *  validated, and every one of them is validated again by the sector's own `applyEvent` when it
 *  comes due; what this schema is actually guarding is the SHAPE control depends on — the day, the
 *  counters, the status and the sector state. */
const schemaCache = new WeakMap<AnySectorPlugin, z.ZodType<EngineState<unknown, unknown>>>()
export function engineStateSchemaFor(plugin: AnySectorPlugin): z.ZodType<EngineState<unknown, unknown>> {
  const cached = schemaCache.get(plugin)
  if (cached !== undefined) return cached
  const queueItemSchema = z.object({ time: z.number().int(), priority: z.enum(['external', 'scheduled', 'decision', 'close']), seq: z.number().int(), event: z.unknown() })
  const schema = z.object({
    day: z.number().int(), sector: plugin.stateSchema, queue: z.object({ items: z.array(queueItemSchema), nextSeq: z.number().int() }), rngState: z.number(),
    journalSeq: z.number().int(), stepCount: z.number().int(), decisionCount: z.number().int(), status: z.enum(['ready', 'running', 'finished', 'halted']), haltedReason: z.string().nullable(),
  }) as unknown as z.ZodType<EngineState<unknown, unknown>>
  schemaCache.set(plugin, schema)
  return schema
}

export type Row = Prisma.SimulationRunGetPayload<{ include: { company: { select: { name: true } }; clonedFrom: { select: { name: true } } } }>

export function summarize(row: Row, definition: LoadedDefinition): SimulationSummary {
  return {
    id: row.id, companyId: row.companyId, companyName: row.company.name, name: row.name, sector: row.sector, mode: 'simulation', decisionProvider: row.decisionProvider,
    modelProvider: row.modelProvider, model: row.model, maxModelCostUsd: row.maxModelCostUsd, llmRoles: definition.llmRoles,
    policy: definition.policy, status: row.status, simTime: row.simTime, horizonDays: definition.horizonDays, stepCount: row.stepCount,
    actionCount: row.actionCount,
    clonedFromId: row.clonedFromId,
    clonedFromName: row.clonedFrom?.name ?? null,
    autoRun: row.autoRunEveryMs !== null && row.autoRunUntilDay !== null ? { everyMs: row.autoRunEveryMs, untilDay: row.autoRunUntilDay, lastStepAt: row.lastAutoStepAt?.toISOString() ?? null } : null,
    version: row.version, haltedReason: row.haltedReason, createdAt: row.createdAt.toISOString(), synthetic: true,
  }
}

export function parseRow(row: Row): Result<LoadedSimulation, ControlRefusal> {
  // A row whose `sector` no plugin answers to is unreadable, not silently trade: the column is a
  // database enum, so this can only happen if a sector was removed from the registry while its
  // runs were still on disk -- which is exactly a corrupt run, and says so.
  const plugin = sectorFor(row.sector)
  if (plugin === undefined) return err({ kind: 'simulation_corrupt', simulationId: row.id, reason: `sector: ${row.sector} has no registered plugin` })
  const definition = plugin.definitionSchema.safeParse(row.definition)
  if (!definition.success) return err({ kind: 'simulation_corrupt', simulationId: row.id, reason: `definition: ${definition.error.issues[0]?.message ?? 'invalid'}` })
  const state = engineStateSchemaFor(plugin).safeParse(row.state)
  if (!state.success) return err({ kind: 'simulation_corrupt', simulationId: row.id, reason: `state: ${state.error.issues[0]?.message ?? 'invalid'}` })
  const typed = definition.data as LoadedDefinition
  return ok({ summary: summarize(row, typed), sector: row.sector, plugin, definition: typed, state: state.data })
}

export const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

export function journalRows(simulationId: string, entries: readonly JournalEntry[]): Prisma.SimulationJournalEntryCreateManyInput[] {
  return entries.map((e) => ({ simulationId, seq: e.seq, simTime: e.simTime, kind: e.kind, actorRole: e.actorRole, payload: json(e.payload) }))
}

/** Stored idempotency keys are namespaced by verb -- `step:${key}` vs. `inject:${key}` -- so the
 *  same caller-supplied key used once for a step and once for an injection cannot collide on the
 *  per-run `simulationId_idempotencyKey` unique and be replayed as the other verb's outcome
 *  (fix round 1, Important #1). */
export const namespacedKey = (verb: 'step' | 'inject', key: string): string => `${verb}:${key}`

export async function locked(tx: Prisma.TransactionClient, simulationId: string): Promise<Result<{ row: Row; loaded: LoadedSimulation }, ControlRefusal>> {
  await tx.$queryRaw`SELECT id FROM "SimulationRun" WHERE id = ${simulationId} FOR UPDATE`
  const row = await tx.simulationRun.findUnique({ where: { id: simulationId }, include: { company: { select: { name: true } }, clonedFrom: { select: { name: true } } } })
  if (row === null) return err({ kind: 'simulation_not_found', simulationId })
  const loaded = parseRow(row)
  return loaded.ok ? ok({ row, loaded: loaded.value }) : loaded
}

/** Clears an auto-run intent (spec §4) and journals `auto_run_stopped { reason }` when one was
 *  set. Returns the journal seq the caller should store as `state.journalSeq` (unchanged when
 *  nothing was written). The row update itself is the caller's — this only writes the journal
 *  row, so one `simulationRun.update` per verb keeps `version`/`state` writes in one place. */
export async function clearAutoRun(
  tx: Prisma.TransactionClient,
  row: Row,
  loaded: LoadedSimulation,
  reason: 'operator' | 'until_day' | 'paused' | 'halted' | 'finished' | 'error',
  seq: number,
): Promise<number> {
  if (row.autoRunEveryMs === null) return seq - 1
  await tx.simulationJournalEntry.create({ data: { simulationId: row.id, seq, simTime: loaded.state.day, kind: 'control', actorRole: null, payload: { op: 'auto_run_stopped', reason } } })
  return seq
}

/** A `JSON.stringify` that sorts object keys at every level, so two structurally-identical values
 *  compare equal regardless of the key insertion order either one happens to carry (fix round 1,
 *  Important #3): Postgres `jsonb` reorders an object's keys on storage (by key length, then
 *  alphabetically) and `queueItemSchema`'s `event: z.unknown()` field passes that raw, reordered
 *  value straight through `parseRow` untouched, while a freshly-run (never persisted) engine state
 *  keeps the event object's natural construction order — so the SAME event, live vs. replayed, can
 *  stringify differently by key order alone with zero difference in content. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** What replay must reproduce: the day, the sector state, the counters and the PENDING events as a
 *  `(time, priority, event)` list. Not compared: `journalSeq` (the stored state counts the control
 *  entries too), `status` (a paused row keeps its engine status), and the queue's own `seq`/`nextSeq`
 *  (an event injected mid-run was enqueued after the rules' own schedules; replay enqueues it up
 *  front, so the tie-break numbers differ while the pending events do not). Uses {@link
 *  stableStringify}, not raw `JSON.stringify`, so key order (see its docstring) never manufactures
 *  a false mismatch; every field's VALUE is still compared exactly, so this does not weaken what is
 *  checked. */
export function comparable(state: EngineState<unknown, unknown>): string {
  const pending = [...state.queue.items].map((i) => ({ time: i.time, priority: i.priority, event: i.event })).sort((a, b) => a.time - b.time || a.priority.localeCompare(b.priority) || stableStringify(a.event).localeCompare(stableStringify(b.event)))
  return stableStringify({ day: state.day, sector: state.sector, stepCount: state.stepCount, decisionCount: state.decisionCount, pending })
}
