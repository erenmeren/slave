import { prisma } from '@slave-of-ai/db/client'
import { companiesForSector, compareCandidatesOf, compareSimulations, listSimulations, readSimulation, refusalText, type SimulationComparison, type SimulationMetrics, type SimulationSummary } from '@slave-of-ai/control'
import type { ExternalEventForm, HeadlineItem, JournalEntry, MetricLabel, SectorName } from '@slave-of-ai/simulation'

export interface JournalRow { readonly seq: number; readonly simTime: number; readonly kind: string; readonly actorRole: string | null; readonly payload: Record<string, unknown> }
export interface CompareCandidate { readonly id: string; readonly name: string; readonly policy: 'A' | 'B'; readonly status: SimulationSummary['status']; readonly simTime: number }
export interface SimulationSnapshot {
  readonly summary: SimulationSummary
  /** M31b Task 4: the run's own sector, read off the row through the plugin -- never hardcoded. */
  readonly sector: SectorName
  readonly currency: string
  /** The "company" panel, drawn from the sector's own `headline` (M31b §4/§5): a plain list of
   *  `{ label, value, kind }`, in the plugin's own order. What used to be a trade-shaped `company`
   *  object is now whatever the run's own sector reports. */
  readonly headline: readonly HeadlineItem[]
  readonly roles: readonly { readonly name: string; readonly slaveName: string; readonly purpose: string; readonly allowedActions: readonly string[] }[]
  /** The sector's own metrics, a plain `name -> number` map read against {@link metricLabels} for
   *  the label, order and `money`/`count`/`days` kind. Trade's runtime object also carries two
   *  extra fields the panel reads directly rather than through a label -- `sources` (per-metric
   *  provenance) and `minCashDay` -- exactly as `packages/simulation`'s trade plugin already
   *  documents; this type says nothing about them; the panel reaches for them defensively. */
  readonly metrics: SimulationMetrics
  readonly metricLabels: Readonly<Record<string, MetricLabel>>
  /** The inject form's own shape (M31b §5): one entry per event type the run's sector accepts,
   *  each with its fields and (for trade) the `data-testid`s the run page already carried. */
  readonly injectForms: readonly ExternalEventForm[]
  /** `select`-kind fields' options, keyed by `FormField.optionsFrom` (M31b §5) -- trade's
   *  `suppliers`, software's `areas`/`engineers`. */
  readonly injectOptions: Readonly<Record<string, readonly { readonly id: string; readonly label: string }[]>>
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
    // M31b Task 4: everything below reads through the run's own plugin -- `headline`,
    // `metricLabels`, `externalEventForms`, `injectOptions` -- rather than narrowing to trade's
    // own shapes. The trade run page still renders exactly what it always did (the trade plugin's
    // labels and forms carry the M29/M30 text and test ids verbatim), but nothing here names a
    // sector.
    const { summary, sector, plugin, definition, state } = loaded.value
    const rows = await tx.simulationJournalEntry.findMany({ where: { simulationId }, orderBy: { seq: 'asc' } })
    // Fix round 1, Minor #2: one query, not two -- `spentUsd` (the measured rows' sum, or null
    // when none are measured) and `unmeasured` (the null-cost count) are both derived from these
    // same rows instead of a redundant `aggregate` over the same table.
    const usageRows = await tx.simulationModelUsage.findMany({ where: { simulationId }, orderBy: { seq: 'asc' } })
    const measuredCosts = usageRows.flatMap((r) => (r.costUsd === null ? [] : [r.costUsd]))
    const spentUsd = measuredCosts.length === 0 ? null : measuredCosts.reduce((sum, cost) => sum + cost, 0)
    const unmeasured = usageRows.length - measuredCosts.length
    const entries: JournalEntry[] = rows.map((r) => ({ seq: r.seq, simTime: r.simTime, kind: r.kind, actorRole: r.actorRole, payload: r.payload as Record<string, unknown> }))
    return {
      summary,
      sector,
      currency: definition.currency,
      headline: plugin.headline(state.sector, state.day),
      roles: definition.roles.map((r) => ({ name: r.name, slaveName: r.slaveName, purpose: r.purpose, allowedActions: r.allowedActions })),
      metrics: plugin.metrics(entries, state.sector) as SimulationMetrics,
      metricLabels: plugin.metricLabels,
      injectForms: plugin.externalEventForms,
      injectOptions: plugin.injectOptions(state.sector),
      journal: entries.slice(-JOURNAL_PAGE),
      modelUsage: {
        spentUsd,
        capUsd: summary.maxModelCostUsd,
        rows: usageRows.map((r) => ({ seq: r.seq, simTime: r.simTime, role: r.role, costUsd: r.costUsd })),
        unmeasured,
      },
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

/** The catalog companies the drawer can offer for ONE sector (M31b §5): delegates to control's
 *  `companiesForSector`, which already keeps only the companies whose frozen roster passes that
 *  sector's own `rosterFits` -- the list the drawer shows can never offer a company `createSimulation`
 *  would then refuse.
 *
 *  A refusal (only `unsupported_simulation`, for a sector no plugin answers to) becomes an empty
 *  list HERE rather than in control: the page iterates the registry's own keys, so it cannot ask
 *  for an unregistered sector, and a drawer has nothing useful to say about one if it did. */
export async function listSimulationCompanies(sector: SectorName): Promise<readonly { id: string; name: string; slaves: number }[]> {
  const result = await companiesForSector(sector)
  return result.ok ? result.value : []
}
