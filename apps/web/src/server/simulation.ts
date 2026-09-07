import { prisma } from '@slave-of-ai/db/client'
import { compareCandidatesOf, compareSimulations, listSimulations, readSimulation, refusalText, type SimulationComparison, type SimulationSummary } from '@slave-of-ai/control'
import { tradeMetrics, type JournalEntry, type TradeMetrics } from '@slave-of-ai/simulation'

export interface JournalRow { readonly seq: number; readonly simTime: number; readonly kind: string; readonly actorRole: string | null; readonly payload: Record<string, unknown> }
export interface CompareCandidate { readonly id: string; readonly name: string; readonly policy: 'A' | 'B'; readonly status: SimulationSummary['status']; readonly simTime: number }
export interface SimulationSnapshot {
  readonly summary: SimulationSummary
  readonly currency: string
  readonly company: { readonly day: number; readonly cashMinor: number; readonly inventory: number; readonly openOrders: number; readonly pendingDemand: number; readonly inboundPurchases: number; readonly dailyShipCapacity: number }
  readonly roles: readonly { readonly name: string; readonly slaveName: string; readonly purpose: string; readonly allowedActions: readonly string[] }[]
  readonly metrics: TradeMetrics
  readonly journal: readonly JournalRow[]
  /** Real model spend (M31 writes it; M31a adds the cap and the per-call rows). `spentUsd` null
   *  means no measured figure — never shown as $0. `capUsd` is `summary.maxModelCostUsd`, carried
   *  here so the panel never has to reach back into `summary` itself. `rows` is every usage row
   *  (seq order) so a decision's `usageSeq` can be matched to its own cost, not just the total. */
  readonly modelUsage: {
    readonly spentUsd: number | null
    readonly capUsd: number | null
    readonly rows: readonly { readonly seq: number; readonly simTime: number | null; readonly role: string | null; readonly costUsd: number | null }[]
    readonly unmeasured: number
  }
  readonly scenario: readonly { readonly day: number; readonly event: unknown }[]
  readonly compareCandidates: readonly CompareCandidate[]
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
    const usageRows = await tx.simulationModelUsage.findMany({ where: { simulationId }, orderBy: { seq: 'asc' } })
    const unmeasured = usageRows.filter((r) => r.costUsd === null).length
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
      modelUsage: {
        spentUsd: usage._count._all === 0 || usage._sum.costUsd === null ? null : usage._sum.costUsd,
        capUsd: summary.maxModelCostUsd,
        rows: usageRows.map((r) => ({ seq: r.seq, simTime: r.simTime, role: r.role, costUsd: r.costUsd })),
        unmeasured,
      },
      scenario: definition.scenario.map((s) => ({ day: s.day, event: s.event })),
      compareCandidates: compareCandidatesOf(await listSimulations(tx, summary.companyId), summary).map((s) => ({ id: s.id, name: s.name, policy: s.policy, status: s.status, simTime: s.simTime })),
    }
  }, { isolationLevel: 'RepeatableRead' })
}

export function listSimulationCards(): Promise<readonly SimulationSummary[]> {
  return listSimulations()
}

/** The "compare with…" select's options (M30 §4): other runs of the SAME company and sector —
 *  never itself — as the thin shape the dropdown needs, not a full `SimulationSummary`. Shares
 *  `compareCandidatesOf`'s filter with `buildSimulationSnapshot` above (fix round 1, Important #2)
 *  so "what counts as a candidate" is decided in exactly one place. */
export async function listCompareCandidates(simulationId: string): Promise<readonly CompareCandidate[]> {
  const loaded = await readSimulation(prisma, simulationId)
  if (!loaded.ok) return []
  const all = await listSimulations(prisma, loaded.value.summary.companyId)
  return compareCandidatesOf(all, loaded.value.summary).map((s) => ({ id: s.id, name: s.name, policy: s.policy, status: s.status, simTime: s.simTime }))
}

export type ComparisonResult = { readonly kind: 'ok'; readonly comparison: SimulationComparison } | { readonly kind: 'refused'; readonly text: string } | null

/** Wraps `compareSimulations` for the page and the route: `null` on a not-found id (→
 *  `notFound()`), a `'refused'` text for everything else the control layer declines (same id,
 *  different sector), the comparison on success. Throws nothing. */
export async function buildComparison(a: string, b: string): Promise<ComparisonResult> {
  const result = await compareSimulations(a, b)
  if (result.ok) return { kind: 'ok', comparison: result.value }
  if (result.error.kind === 'simulation_not_found') return null
  return { kind: 'refused', text: refusalText(result.error) }
}

export async function listSimulationCompanies(): Promise<readonly { id: string; name: string; slaves: number }[]> {
  const companies = await prisma.company.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, teams: { select: { _count: { select: { slaves: true } } } } } })
  return companies.map((c) => ({ id: c.id, name: c.name, slaves: c.teams.reduce((n, t) => n + t._count.slaves, 0) }))
}
