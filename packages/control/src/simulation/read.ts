import { Prisma, prisma, type PrismaClient } from '@slave-of-ai/db/client'
import { err, ok, type Result } from '@slave-of-ai/domain'
import { replay, tradeInitialEngineState, tradeMetrics, tradeModel, type JournalEntry, type TradeEvent, type TradeMetrics } from '@slave-of-ai/simulation'
import type { ControlRefusal } from '../refusal.js'
import { comparable, parseRow, stableStringify, type LoadedSimulation, type SimulationSummary } from './shared.js'

const COMPARED_KEYS = ['roster', 'roles', 'initial', 'scenario', 'currency', 'horizonDays', 'limits'] as const
const METRIC_KEYS = ['deliveredQty', 'onTimeQty', 'lateDays', 'purchaseCostMinor', 'closingInventory', 'closingCashMinor', 'minCashMinor', 'collectedMinor', 'unpaidCommitmentsMinor'] as const

export interface SimulationComparison {
  readonly a: { readonly summary: SimulationSummary; readonly metrics: TradeMetrics; readonly injected: number }
  readonly b: { readonly summary: SimulationSummary; readonly metrics: TradeMetrics; readonly injected: number }
  readonly deltas: Readonly<Record<(typeof METRIC_KEYS)[number], number>>
  readonly definitionsMatch: boolean
  readonly differences: readonly string[]
  readonly currency: string
}

/** Shared by every read-only verb, plain `prisma` for a single unlocked read (`loadSimulation`
 *  itself) or `tx` for one that must see the row and the journal from the SAME snapshot
 *  (`replaySimulation`, `simulationStatus` -- fix round 1, Important #4; `apps/web`'s
 *  `buildSimulationSnapshot`, which imports this across the package boundary -- final fix wave,
 *  Important #2). */
export async function readSimulation(client: PrismaClient | Prisma.TransactionClient, simulationId: string): Promise<Result<LoadedSimulation, ControlRefusal>> {
  const row = await client.simulationRun.findUnique({ where: { id: simulationId }, include: { company: { select: { name: true } }, clonedFrom: { select: { name: true } } } })
  if (row === null) return err({ kind: 'simulation_not_found', simulationId })
  return parseRow(row)
}

export async function loadSimulation(simulationId: string): Promise<Result<LoadedSimulation, ControlRefusal>> {
  return readSimulation(prisma, simulationId)
}

export async function listSimulations(companyId?: string): Promise<readonly SimulationSummary[]> {
  const rows = await prisma.simulationRun.findMany({ where: companyId === undefined ? {} : { companyId }, include: { company: { select: { name: true } }, clonedFrom: { select: { name: true } } }, orderBy: [{ createdAt: 'desc' }] })
  return rows.flatMap((row) => { const p = parseRow(row); return p.ok ? [p.value.summary] : [] })
}

/** Re-runs the engine from the frozen definition with the journal's own decisions and compares.
 *  Reads the row and the journal inside one `RepeatableRead` transaction (fix round 1, Important
 *  #4): two unlocked reads outside a transaction could straddle a concurrent `stepSimulation`
 *  commit and compare a journal that is newer than the state it is checked against, reporting a
 *  spurious mismatch. `RepeatableRead` (not the default Read Committed) is what actually gives
 *  both reads the same snapshot. */
export async function replaySimulation(simulationId: string): Promise<Result<{ readonly matches: boolean }, ControlRefusal>> {
  return prisma.$transaction(async (tx) => {
    const loaded = await readSimulation(tx, simulationId)
    if (!loaded.ok) return loaded
    const rows = await tx.simulationJournalEntry.findMany({ where: { simulationId, kind: { in: ['decision', 'action_applied', 'action_rejected', 'event', 'external_event'] } }, orderBy: { seq: 'asc' } })
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
  }, { isolationLevel: 'RepeatableRead' })
}

/** Read model for an operator's dashboard (Task 8): the summary, the sector's headline numbers,
 *  the derived trade metrics computed from the journal, and how much real model spend (M31 writes
 *  it, M29 never does) is attributed so far. Reads the row and the journal inside one
 *  `RepeatableRead` transaction for the same reason as {@link replaySimulation} above (fix round
 *  1, Important #4): a step committing between two unlocked reads would otherwise make the
 *  journal newer than the state the metrics are computed against. */
export async function simulationStatus(
  simulationId: string,
): Promise<Result<{ readonly summary: SimulationSummary; readonly company: { readonly day: number; readonly cashMinor: number; readonly inventory: number; readonly openOrders: number }; readonly metrics: TradeMetrics; readonly modelUsage: { readonly rows: number; readonly costUsd: number | null; readonly unmeasured: number } }, ControlRefusal>> {
  return prisma.$transaction(async (tx) => {
    const loaded = await readSimulation(tx, simulationId)
    if (!loaded.ok) return loaded
    const rows = await tx.simulationJournalEntry.findMany({ where: { simulationId }, orderBy: { seq: 'asc' } })
    const entries: JournalEntry[] = rows.map((r) => ({ seq: r.seq, simTime: r.simTime, kind: r.kind, actorRole: r.actorRole, payload: r.payload as Record<string, unknown> }))
    const usage = await tx.simulationModelUsage.aggregate({ where: { simulationId }, _count: { _all: true }, _sum: { costUsd: true } })
    const unmeasured = await tx.simulationModelUsage.count({ where: { simulationId, costUsd: null } })
    const sector = loaded.value.state.sector
    return ok({
      summary: loaded.value.summary,
      company: { day: loaded.value.state.day, cashMinor: sector.cashMinor, inventory: sector.inventory, openOrders: sector.orders.filter((o) => o.status !== 'shipped').length },
      metrics: tradeMetrics(entries, sector),
      modelUsage: { rows: usage._count._all, costUsd: usage._count._all === 0 || usage._sum.costUsd === null ? null : usage._sum.costUsd, unmeasured },
    })
  }, { isolationLevel: 'RepeatableRead' })
}

/** Two runs side by side (spec §4): metrics, b − a deltas, and whether they lived in the same
 *  world (frozen definition minus policy and seed). Never a verdict. */
export async function compareSimulations(aId: string, bId: string): Promise<Result<SimulationComparison, ControlRefusal>> {
  if (aId === bId) return err({ kind: 'invalid_simulation_input', detail: 'compare two different runs' })
  return prisma.$transaction(async (tx) => {
    const sideOf = async (id: string) => {
      const loaded = await readSimulation(tx, id)
      if (!loaded.ok) return loaded
      const rows = await tx.simulationJournalEntry.findMany({ where: { simulationId: id }, orderBy: { seq: 'asc' } })
      const entries: JournalEntry[] = rows.map((r) => ({ seq: r.seq, simTime: r.simTime, kind: r.kind, actorRole: r.actorRole, payload: r.payload as Record<string, unknown> }))
      const injected = rows.filter((r) => r.kind === 'external_event' && (r.payload as { op?: string }).op === 'injected').length
      return ok({ loaded: loaded.value, metrics: tradeMetrics(entries, loaded.value.state.sector), injected })
    }
    const a = await sideOf(aId)
    if (!a.ok) return a
    const b = await sideOf(bId)
    if (!b.ok) return b
    if (a.value.loaded.summary.sector !== b.value.loaded.summary.sector) return err({ kind: 'invalid_simulation_input', detail: 'runs of different sectors cannot be compared' })
    const differences = COMPARED_KEYS.filter((key) => stableStringify(a.value.loaded.definition[key]) !== stableStringify(b.value.loaded.definition[key]))
    const deltas = Object.fromEntries(METRIC_KEYS.map((key) => [key, b.value.metrics[key] - a.value.metrics[key]])) as SimulationComparison['deltas']
    return ok({
      a: { summary: a.value.loaded.summary, metrics: a.value.metrics, injected: a.value.injected },
      b: { summary: b.value.loaded.summary, metrics: b.value.metrics, injected: b.value.injected },
      deltas, definitionsMatch: differences.length === 0, differences, currency: a.value.loaded.definition.currency,
    })
  }, { isolationLevel: 'RepeatableRead' })
}
