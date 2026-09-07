import { Prisma, prisma, type PrismaClient } from '@slave-of-ai/db/client'
import { err, ok, type Result } from '@slave-of-ai/domain'
import { replay, sectorFor, type HeadlineItem, type JournalEntry, type MetricLabel, type RosterEntry, type SectorName } from '@slave-of-ai/simulation'
import type { ControlRefusal } from '../refusal.js'
import { comparable, parseRow, stableStringify, type LoadedSimulation, type SimulationSummary } from './shared.js'

/** The definition fields two runs of the SAME world must agree on (M30 §4). Deliberately a union
 *  across sectors rather than a per-sector list: a key a sector's definition does not carry reads
 *  `undefined` on both sides and so never manufactures a difference, and the two keys a policy
 *  IS -- `policy` and `seed` -- are absent by design, since differing on them is the whole point
 *  of a clone. */
const COMPARED_KEYS = ['roster', 'roles', 'initial', 'scenario', 'currency', 'horizonDays', 'limits', 'engineers'] as const

/** Metrics are the plugin's, not trade's (M31b §4): a plain `name -> number` map, read against
 *  `metricLabels` for the label, the order and the `money`/`count`/`days` kind. */
export type SimulationMetrics = Readonly<Record<string, number>>

export interface SimulationComparison {
  readonly a: { readonly summary: SimulationSummary; readonly metrics: SimulationMetrics; readonly injected: number }
  readonly b: { readonly summary: SimulationSummary; readonly metrics: SimulationMetrics; readonly injected: number }
  readonly deltas: SimulationMetrics
  /** The sector's own labels, in the sector's own order -- what a reader renders these numbers
   *  with, carried here so a page never has to know which sector it is looking at. */
  readonly metricLabels: Readonly<Record<string, MetricLabel>>
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

/** `client` defaults to plain `prisma` for every existing unlocked caller, but takes a `tx` too
 *  (fix round 1, Important #2) so a caller already inside a `RepeatableRead` transaction --
 *  `apps/web`'s `buildSimulationSnapshot` -- can read the candidate list from the SAME snapshot
 *  as everything else it returns, instead of a second, unlocked connection racing a concurrent
 *  write. */
export async function listSimulations(client: PrismaClient | Prisma.TransactionClient = prisma, companyId?: string): Promise<readonly SimulationSummary[]> {
  const rows = await client.simulationRun.findMany({ where: companyId === undefined ? {} : { companyId }, include: { company: { select: { name: true } }, clonedFrom: { select: { name: true } } }, orderBy: [{ createdAt: 'desc' }] })
  return rows.flatMap((row) => { const p = parseRow(row); return p.ok ? [p.value.summary] : [] })
}

/** Pure filter behind the "compare with…" list (fix round 1, Important #2): other runs of the
 *  SAME company and sector, never the run itself. No I/O of its own -- shared by `apps/web`'s
 *  `listCompareCandidates` (its own unlocked read) and `buildSimulationSnapshot` (inside its
 *  `RepeatableRead` transaction) so "what counts as a candidate" is decided in exactly one place. */
export function compareCandidatesOf(summaries: readonly SimulationSummary[], self: SimulationSummary): readonly SimulationSummary[] {
  return summaries.filter((s) => s.id !== self.id && s.sector === self.sector)
}

/** One run's row, its FULL journal (mapped to `JournalEntry[]`, seq ascending), the derived trade
 *  metrics and the count of externally injected events — the read every one of
 *  `simulationStatus`, `compareSimulations` and `replaySimulation` needs, previously written out
 *  three times with three separate journal queries (fix round 1, Important #3). Takes the caller's
 *  `client` (plain `prisma` or a `tx`) so every caller keeps reading the row and the journal from
 *  the SAME snapshot it already opened -- this helper adds no transaction of its own. */
async function loadSideMetrics(
  client: PrismaClient | Prisma.TransactionClient,
  simulationId: string,
): Promise<Result<{ readonly loaded: LoadedSimulation; readonly entries: readonly JournalEntry[]; readonly metrics: SimulationMetrics; readonly injected: number }, ControlRefusal>> {
  const loaded = await readSimulation(client, simulationId)
  if (!loaded.ok) return loaded
  const rows = await client.simulationJournalEntry.findMany({ where: { simulationId }, orderBy: { seq: 'asc' } })
  const entries: JournalEntry[] = rows.map((r) => ({ seq: r.seq, simTime: r.simTime, kind: r.kind, actorRole: r.actorRole, payload: r.payload as Record<string, unknown> }))
  const injected = entries.filter((e) => e.kind === 'external_event' && (e.payload as { op?: string }).op === 'injected').length
  return ok({ loaded: loaded.value, entries, metrics: loaded.value.plugin.metrics(entries, loaded.value.state.sector) as SimulationMetrics, injected })
}

/** Re-runs the engine from the frozen definition with the journal's own decisions and compares.
 *  Reads the row and the journal inside one `RepeatableRead` transaction (fix round 1, Important
 *  #4): two unlocked reads outside a transaction could straddle a concurrent `stepSimulation`
 *  commit and compare a journal that is newer than the state it is checked against, reporting a
 *  spurious mismatch. `RepeatableRead` (not the default Read Committed) is what actually gives
 *  both reads the same snapshot. Filters `loadSideMetrics`'s full entry list down to the kinds
 *  replay cares about (control rows are never replayed) rather than querying the journal a second
 *  time with a `kind IN (...)` filter. */
export async function replaySimulation(simulationId: string): Promise<Result<{ readonly matches: boolean }, ControlRefusal>> {
  return prisma.$transaction(async (tx) => {
    const side = await loadSideMetrics(tx, simulationId)
    if (!side.ok) return side
    const { loaded, entries: allEntries } = side.value
    const entries = allEntries.filter((e) => e.kind === 'decision' || e.kind === 'action_applied' || e.kind === 'action_rejected' || e.kind === 'event' || e.kind === 'external_event')
    const initial = loaded.plugin.initialState(loaded.definition)
    const injected = entries.filter((e) => e.kind === 'external_event' && (e.payload as { op?: string }).op === 'injected')
    let seeded = initial
    for (const e of injected) {
      const p = e.payload as { day: number; event: unknown }
      seeded = { ...seeded, queue: { items: [...seeded.queue.items, { time: p.day, priority: 'external', seq: seeded.queue.nextSeq, event: p.event }], nextSeq: seeded.queue.nextSeq + 1 } }
    }
    const replayed = replay(loaded.plugin.model, loaded.definition, seeded, entries.filter((e) => !(e.kind === 'external_event' && e.payload['op'] === 'injected')))
    const stored = loaded.state
    return ok({ matches: comparable(replayed) === comparable(stored) })
  }, { isolationLevel: 'RepeatableRead' })
}

/** Real model spend attributed to one run: how many calls were made, what they are KNOWN to have
 *  cost, and how many reported nothing. One shape, everywhere (final review, Minor #5): the CLI's
 *  `simulation-status` adds only `capUsd` to it and `apps/web`'s snapshot uses the same three field
 *  NAMES, so nobody has to remember whether this reader calls the total `costUsd` or `spentUsd`.
 *  `spentUsd` is null -- never 0 -- when nothing measured was recorded: no calls at all, or calls
 *  that every one of them reported no cost for. `unmeasured` is what tells those two apart. */
export interface ModelUsageTotals {
  readonly calls: number
  readonly spentUsd: number | null
  readonly unmeasured: number
}

/** Read model for an operator's dashboard (Task 8): the summary, the sector's headline numbers,
 *  the derived trade metrics computed from the journal, and how much real model spend (M31 writes
 *  it, M29 never does) is attributed so far. Reads the row and the journal inside one
 *  `RepeatableRead` transaction for the same reason as {@link replaySimulation} above (fix round
 *  1, Important #4): a step committing between two unlocked reads would otherwise make the
 *  journal newer than the state the metrics are computed against. */
export async function simulationStatus(
  simulationId: string,
): Promise<Result<{ readonly summary: SimulationSummary; readonly headline: readonly HeadlineItem[]; readonly metrics: SimulationMetrics; readonly metricLabels: Readonly<Record<string, MetricLabel>>; readonly modelUsage: ModelUsageTotals }, ControlRefusal>> {
  return prisma.$transaction(async (tx) => {
    const side = await loadSideMetrics(tx, simulationId)
    if (!side.ok) return side
    const { loaded, metrics } = side.value
    // One aggregate, not an aggregate plus a count: `_count.costUsd` counts the non-null costs, so
    // the unmeasured rows are the difference against `_count._all`.
    const usage = await tx.simulationModelUsage.aggregate({ where: { simulationId }, _count: { _all: true, costUsd: true }, _sum: { costUsd: true } })
    return ok({
      summary: loaded.summary,
      headline: loaded.plugin.headline(loaded.state.sector, loaded.state.day) as readonly HeadlineItem[],
      metrics,
      metricLabels: loaded.plugin.metricLabels as Readonly<Record<string, MetricLabel>>,
      modelUsage: { calls: usage._count._all, spentUsd: usage._count.costUsd === 0 ? null : usage._sum.costUsd, unmeasured: usage._count._all - usage._count.costUsd },
    })
  }, { isolationLevel: 'RepeatableRead' })
}

/** Two runs side by side (spec §4): metrics, b − a deltas, and whether they lived in the same
 *  world (frozen definition minus policy and seed). Never a verdict. */
export async function compareSimulations(aId: string, bId: string): Promise<Result<SimulationComparison, ControlRefusal>> {
  if (aId === bId) return err({ kind: 'invalid_simulation_input', detail: 'compare two different runs' })
  return prisma.$transaction(async (tx) => {
    const a = await loadSideMetrics(tx, aId)
    if (!a.ok) return a
    const b = await loadSideMetrics(tx, bId)
    if (!b.ok) return b
    if (a.value.loaded.summary.sector !== b.value.loaded.summary.sector) return err({ kind: 'invalid_simulation_input', detail: 'runs of different sectors cannot be compared' })
    const differences = COMPARED_KEYS.filter((key) => stableStringify(a.value.loaded.definition[key]) !== stableStringify(b.value.loaded.definition[key]))
    const metricLabels = a.value.loaded.plugin.metricLabels as Readonly<Record<string, MetricLabel>>
    // The plugin's own label keys, in its own order: the metrics a sector publishes are exactly
    // the ones it labels, so this is the list and there is no second one to keep in step.
    const deltas: Record<string, number> = {}
    for (const key of Object.keys(metricLabels)) deltas[key] = (b.value.metrics[key] ?? 0) - (a.value.metrics[key] ?? 0)
    return ok({
      a: { summary: a.value.loaded.summary, metrics: a.value.metrics, injected: a.value.injected },
      b: { summary: b.value.loaded.summary, metrics: b.value.metrics, injected: b.value.injected },
      deltas, metricLabels, definitionsMatch: differences.length === 0, differences, currency: a.value.loaded.definition.currency,
    })
  }, { isolationLevel: 'RepeatableRead' })
}

/** The catalog companies one sector can actually be run on (M31b §5): every company whose frozen
 *  roster would pass that sector's own `rosterFits`, with the same `{ id, name, slaves }` shape the
 *  drawer's company list already uses. The roster is read exactly as `createSimulation` reads it --
 *  departments and slaves by name, the catalog ROLE off the template -- so the list can never offer
 *  a company that the create verb would then refuse.
 *
 *  Ordering is by company name, matching the drawer's existing list. */
export async function companiesForSector(sector: SectorName, client: PrismaClient | Prisma.TransactionClient = prisma): Promise<readonly { readonly id: string; readonly name: string; readonly slaves: number }[]> {
  const plugin = sectorFor(sector)
  if (plugin === undefined) return []
  const companies = await client.company.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, teams: { orderBy: { name: 'asc' }, select: { name: true, slaves: { orderBy: { name: 'asc' }, select: { name: true, template: { select: { role: true } } } } } } },
  })
  return companies.flatMap((company) => {
    const roster = rosterOf(company.teams)
    return plugin.rosterFits(roster) ? [{ id: company.id, name: company.name, slaves: roster.length }] : []
  })
}

/** The one reading of a catalog company's roster (M31b §4), shared by `companiesForSector` here and
 *  `createSimulation` in `write.ts` so the list and the create verb can never disagree about what a
 *  roster is. `role` is the CATALOG role, which lives on the template rather than on the roster row
 *  -- the software sector reads an engineer's expertise from it, and trade ignores it. */
export function rosterOf(teams: readonly { readonly name: string; readonly slaves: readonly { readonly name: string; readonly template: { readonly role: string } }[] }[]): readonly RosterEntry[] {
  return teams.flatMap((team) => team.slaves.map((slave) => ({ slaveName: slave.name, departmentName: team.name, role: slave.template.role })))
}
