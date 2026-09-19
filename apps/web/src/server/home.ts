import { prisma } from '@slave-of-ai/db/client'
import { NON_TERMINAL_RUN_STATUSES } from '@slave-of-ai/domain'
import { buildAnalytics, type Kpi } from './analytics'
import { loadHappeningRows } from './happeningRows'
import { buildNeedsYou, type NeedsYouItem } from './needsYou'
import { listProjects, type ProjectRow } from './org'
import { buildSidebarTree } from './sidebar'

/** How often `useHome` polls `GET /api/home` while the tab is visible (M61 R11). */
export const HOME_POLL_MS = 10_000

/** How many of `HAPPENING_TYPES`' events Home's own feed pages, newest first, across every
 *  project a person can see -- wide enough to cover a busy morning without paging. */
export const HOME_FEED_LIMIT = 40

/** One `NeedsYouItem`, carrying which project it is on (M61 R11): the queue is now cross-project,
 *  so a bare item (which already names its own href/kind/title) has nowhere to say whose project
 *  it belongs to. `workspaceName` rides beside `workspaceId` rather than making a caller join it
 *  back against `projects` -- the row and the chip are drawn from the same item. */
export interface HomeNeedsYouItem extends NeedsYouItem {
  readonly workspaceId: string
  readonly workspaceName: string
}

/** One `HappeningRow` (`server/happeningRows.ts`), plus the project name Home's feed names beside
 *  it -- `HappeningRow` itself carries only the id, which is enough for the Activity digest (one
 *  project at a time) but not for a feed that spans every project at once. */
export interface HappeningNowItem {
  readonly id: string
  /** ISO. */
  readonly at: string
  readonly type: string
  readonly workspaceId: string
  readonly workspaceName: string
  readonly actorName: string | null
  readonly sentence: string
}

export interface HomeSnapshot {
  /** `listProjects`' own rows, verbatim (plan erratum E4) -- Home's list is the SAME read model
   *  the deleted Projects page used, not a second projection of it. */
  readonly projects: readonly ProjectRow[]
  /** Oldest first (the thing that has waited longest is the thing to do), across every project
   *  that has something pending -- `buildNeedsYou`'s own order, merged rather than re-sorted by a
   *  different rule. */
  readonly needsYou: readonly HomeNeedsYouItem[]
  /** Newest first -- `loadHappeningRows`' own order (`seq desc`), across every visible project. */
  readonly feed: readonly HappeningNowItem[]
  readonly numbers: {
    readonly peopleWorking: number
    readonly peopleIdle: number
    /** Erratum E4: `Σ project.spend`, the SAME figure the row beside it prints -- not
     *  `workspaceSpend` read a second time under a different name. */
    readonly spendUsd: number
    /** Erratum E4: true when ANY project's `unmeasuredRuns > 0` -- the Spend tile's caveat, the
     *  same rule the deleted Projects card's own spend tile followed per-card. */
    readonly unmeasured: boolean
    readonly finishedThisWeek: number
  }
  /** The all-workspaces KPI tiles, `buildAnalytics(null).kpis` verbatim -- developer mode only
   *  (`HomeClient`'s own gate), the same five tiles the deleted Projects page drew. Empty unless
   *  `buildHomeSnapshot` was asked for them (`includeKpis`, I4 fix) -- simple mode never shows this
   *  strip, so it never has to pay for computing it either. */
  readonly kpis: readonly Kpi[]
}

/**
 * Home's one read (M61 R11): every project a person can see, what needs them across all of them,
 * a live feed of what just happened, and the headline numbers the top strip shows.
 *
 * FOUR queries beyond `listProjects`/`buildSidebarTree`/`buildAnalytics` (already-shared reads),
 * all scoped to the SAME id set `listProjects` answered with -- an archived project excluded by
 * `includeArchived: false` is excluded from the feed and the numbers too, not merely hidden from
 * the list.
 *
 * `needsYou` is gathered only for a project `buildSidebarTree` already says has something pending
 * (`needsYouCount > 0`): `buildNeedsYou` makes its own handful of reads per project, and asking it
 * for every project on every Home load -- most of which have nothing waiting -- would be a query
 * fan-out with no payoff. `nameOf.has(row.id)` guards a race between the two reads (a project
 * archived between them) rather than trusting the sidebar's own archived filter alone.
 */
export async function buildHomeSnapshot(
  options: { readonly includeArchived?: boolean; readonly includeKpis?: boolean; readonly now?: Date } = {},
): Promise<HomeSnapshot> {
  const now = options.now ?? new Date()
  // I4 (final-review wave): `buildAnalytics(null)` is an UNSCOPED read across every workspace --
  // the 7-day series, run totals and task counts `AnalyticsSnapshot` carries -- built for the five
  // developer-only KPI tiles this page's own docstring already says they are. `useHome`'s poll ran
  // it on every tick regardless of mode; `includeKpis` (default false) is what the poll now passes
  // only in developer mode, and simple mode's `kpis: []` costs nothing.
  const includeKpis = options.includeKpis ?? false
  const [projects, tree, analytics] = await Promise.all([
    listProjects({ includeArchived: options.includeArchived ?? false }),
    buildSidebarTree(),
    includeKpis ? buildAnalytics(null) : Promise.resolve(null),
  ])
  const nameOf = new Map(projects.map((project) => [project.id, project.name]))
  const ids = [...nameOf.keys()]

  const hot = tree.filter((row) => row.needsYouCount > 0 && nameOf.has(row.id))
  const queues = await Promise.all(
    hot.map(async (row): Promise<readonly HomeNeedsYouItem[]> => {
      const items = await buildNeedsYou(row.id, now)
      return items.map((item) => ({ ...item, workspaceId: row.id, workspaceName: row.name }))
    }),
  )
  const needsYou = queues.flat().sort((a, b) => Date.parse(a.since) - Date.parse(b.since))

  const weekAgo = new Date(now.getTime() - 7 * 86_400_000)
  const [rows, finishedThisWeek, liveSeats, seatCount] = await Promise.all([
    // Ruling 1 (binding): the ONE `HAPPENING_TYPES` read, shared with `activityDigest.ts` --
    // Home's own scope is every visible project rather than one workspace, so `{ in: ids }`
    // stands where `activityDigest.ts` passes a bare `workspaceId`.
    loadHappeningRows({ workspaceId: { in: ids } }, HOME_FEED_LIMIT),
    prisma.task.count({
      where: { workspaceId: { in: ids }, status: 'done', integratedAt: { gte: weekAgo } },
    }),
    // A live run's seat, deduplicated below -- a worker mid-resume or paused-and-resuming still
    // counts as one working seat, not zero and not two.
    prisma.slaveRun.findMany({
      where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] }, slave: { team: { workspaceId: { in: ids } } } },
      select: { slaveId: true },
    }),
    // `Slave.closedAt`, not `releasedAt` -- that column moved to `Person` in M58 R2/R3 and a seat's
    // own "this is gone" fact is `closedAt` (checked against `schema.prisma` per Step 3's note).
    prisma.slave.count({ where: { closedAt: null, team: { workspaceId: { in: ids } } } }),
  ])

  const feed: readonly HappeningNowItem[] = rows.map((row) => ({
    id: row.id,
    at: row.at,
    type: row.type,
    workspaceId: row.workspaceId,
    workspaceName: nameOf.get(row.workspaceId) ?? row.workspaceId,
    actorName: row.actorName,
    sentence: row.sentence,
  }))

  const peopleWorking = new Set(liveSeats.map((run) => run.slaveId)).size

  return {
    projects,
    needsYou,
    feed,
    numbers: {
      peopleWorking,
      peopleIdle: Math.max(0, seatCount - peopleWorking),
      spendUsd: projects.reduce((sum, project) => sum + project.spend, 0),
      unmeasured: projects.some((project) => project.unmeasuredRuns > 0),
      finishedThisWeek,
    },
    kpis: analytics?.kpis ?? [],
  }
}
