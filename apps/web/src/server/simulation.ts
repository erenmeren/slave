import { prisma } from '@slave-of-ai/db/client'
import { listSimulations, readSimulation, type SimulationSummary } from '@slave-of-ai/control'
import { tradeMetrics, type JournalEntry, type TradeMetrics } from '@slave-of-ai/simulation'

export interface JournalRow { readonly seq: number; readonly simTime: number; readonly kind: string; readonly actorRole: string | null; readonly payload: Record<string, unknown> }
export interface SimulationSnapshot {
  readonly summary: SimulationSummary
  readonly currency: string
  readonly company: { readonly day: number; readonly cashMinor: number; readonly inventory: number; readonly openOrders: number; readonly pendingDemand: number; readonly inboundPurchases: number; readonly dailyShipCapacity: number }
  readonly roles: readonly { readonly name: string; readonly slaveName: string; readonly purpose: string; readonly allowedActions: readonly string[] }[]
  readonly metrics: TradeMetrics
  readonly journal: readonly JournalRow[]
  /** Real model spend (M31 writes it). `costUsd` null means no measured figure — never shown as $0. */
  readonly modelUsage: { readonly rows: number; readonly costUsd: number | null; readonly unmeasured: number }
  readonly scenario: readonly { readonly day: number; readonly event: unknown }[]
}

const JOURNAL_PAGE = 200

/** Reads the row, the whole journal and the model-usage aggregates from the SAME snapshot: two
 *  unlocked reads outside a transaction could straddle a concurrent `stepSimulation` commit and
 *  page a journal that is newer than the state the metrics are computed against (final fix wave,
 *  Important #2, the same reasoning as `replaySimulation`/`simulationStatus` in
 *  `packages/control/src/simulation.ts`). `RepeatableRead` (not the default Read Committed) is
 *  what actually gives every read here the same snapshot. The journal is read once, ordered by
 *  seq, and the last-200 page is `.slice(-200)` off that same array -- not a second query. */
export async function buildSimulationSnapshot(simulationId: string): Promise<SimulationSnapshot | null> {
  return prisma.$transaction(async (tx) => {
    const loaded = await readSimulation(tx, simulationId)
    if (!loaded.ok) return null
    const { summary, definition, state } = loaded.value
    const rows = await tx.simulationJournalEntry.findMany({ where: { simulationId }, orderBy: { seq: 'asc' } })
    const usage = await tx.simulationModelUsage.aggregate({ where: { simulationId }, _count: { _all: true }, _sum: { costUsd: true } })
    const unmeasured = await tx.simulationModelUsage.count({ where: { simulationId, costUsd: null } })
    const entries: JournalEntry[] = rows.map((r) => ({ seq: r.seq, simTime: r.simTime, kind: r.kind, actorRole: r.actorRole, payload: r.payload as Record<string, unknown> }))
    const sector = state.sector
    return {
      summary,
      currency: definition.currency,
      company: {
        day: state.day, cashMinor: sector.cashMinor, inventory: sector.inventory,
        openOrders: sector.orders.filter((o) => o.status !== 'shipped').length, pendingDemand: sector.pendingDemand.length,
        inboundPurchases: sector.purchases.filter((p) => p.status === 'ordered').length, dailyShipCapacity: sector.dailyShipCapacity,
      },
      roles: definition.roles.map((r) => ({ name: r.name, slaveName: r.slaveName, purpose: r.purpose, allowedActions: r.allowedActions })),
      metrics: tradeMetrics(entries, sector),
      journal: entries.slice(-JOURNAL_PAGE),
      modelUsage: { rows: usage._count._all, costUsd: usage._count._all === 0 || usage._sum.costUsd === null ? null : usage._sum.costUsd, unmeasured },
      scenario: definition.scenario.map((s) => ({ day: s.day, event: s.event })),
    }
  }, { isolationLevel: 'RepeatableRead' })
}

export function listSimulationCards(): Promise<readonly SimulationSummary[]> {
  return listSimulations()
}

export async function listSimulationCompanies(): Promise<readonly { id: string; name: string; slaves: number }[]> {
  const companies = await prisma.company.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, teams: { select: { _count: { select: { slaves: true } } } } } })
  return companies.map((c) => ({ id: c.id, name: c.name, slaves: c.teams.reduce((n, t) => n + t._count.slaves, 0) }))
}
