import { prisma } from '@slave-of-ai/db/client'

/**
 * H4b: the ONE reading of "how many planning runs have failed against this goal", shared by the
 * tick's `dispatchPlanning` (which stops at `PLANNING_RETRY_CAP`), `replanVerdict` (the same cap
 * for a re-plan) and the Supervisor's world loader (which raises `planning_stalled/cap_spent` at
 * the same number). Three readers, one rule, so none of them can drift into its own idea of when
 * planning has given up -- H4a wired the reset event on the Supervisor's side and the tick was
 * still counting from the goal alone.
 *
 * The rule, in two halves:
 *
 * 1. **Since when.** The LATER of the anchoring `workspace.goal_set` and the newest
 *    `workspace.planning_reset` -- the reset the Supervisor's `retry_planning` writes is what
 *    gives a spent cap back, and from that instant the count starts at zero again. A project
 *    whose goal was hand-seeded has neither event and counts from the epoch, exactly as the tick
 *    always has. The max by `ts`, not the newest by `seq`: "whichever is later" is a claim about
 *    TIME, which is the column the runs are then compared against.
 *
 * 2. **Which runs.** `planning` runs of this workspace that FAILED and started after that instant,
 *    EXCLUDING a run that never reached the model (`SlaveRun.spawnFailed`): no runtime, an adapter
 *    refusal, a spawn that threw. Such a failure is the installation's, not the planner's, and it
 *    spends nothing -- on 2026-09-21 two of them landed in the same second and spent the whole
 *    cap, and nothing could re-plan.
 *
 * Which `goal_set` anchors the count is the one thing the readers legitimately differ on, and
 * {@link PlanningAnchor} names the two readings rather than letting each caller spell its own:
 * the first-plan path and the loader count from the LATEST goal edit (a goal edit is what buys a
 * fresh cap, and the newest row is that edit whether or not it was versioned), while a re-plan
 * counts from ITS version's own `goal_set` and its version's own resets (`replanVerdict`'s M40
 * rule -- a version whose cap is spent stays spent whatever happens to a later one).
 *
 * The event read is bounded to the newest {@link PLANNING_EVENTS_SCANNED} rows: both types are
 * workspace-LIFETIME events (one per goal edit, one per reset), so the rows that can anchor the
 * current version are by construction the last ones written. `payload.version` is read in JS,
 * never as a `payload.path` filter on a JSON number -- `replanIntent`'s own caution.
 */
export interface PlanningCount {
  /** When the count starts. The epoch when neither event exists. */
  readonly since: Date
  /** `planning` runs that FAILED after {@link since}, spawn failures excluded. */
  readonly failures: number
  /** `workspace.planning_reset` rows naming `goalVersion` -- how many times THIS version's cap
   *  has already been given back. Read by the once-per-version rule at both the offer and the
   *  apply. */
  readonly resetsOfVersion: number
}

/**
 * Which `workspace.goal_set` row starts the count -- see the module comment.
 * - `latest_goal`: the newest `goal_set` of any version, and the newest reset of any version.
 * - `this_version`: the newest `goal_set` whose payload names `goalVersion`, and only the resets
 *   naming it. A version no event names counts from the epoch.
 */
export type PlanningAnchor = 'latest_goal' | 'this_version'

/** How far back the one bounded event read scans. `replanIntent`'s `RECENT_EVENTS` is the same
 *  number for the same reason; the two bound different reads and either may move alone. */
const PLANNING_EVENTS_SCANNED = 20

/** The `version` off a `workspace.goal_set` / `workspace.planning_reset` payload, or null for a row
 *  that names none -- a pre-M40 `goal_set`, or a hand-edited row that must not throw the whole
 *  count away. */
function versionOf(payload: unknown): number | null {
  if (payload === null || typeof payload !== 'object') return null
  const version = (payload as Record<string, unknown>)['version']
  return typeof version === 'number' ? version : null
}

/**
 * The count. `tx` for the world loader's reason (`workspaceDefaultProvider`): asked inside the
 * loader's own `RepeatableRead` snapshot it is part of the world one decision was made on; every
 * other caller passes nothing and reads the global client.
 */
export async function planningCountSince(
  workspaceId: string,
  goalVersion: number,
  options: {
    readonly anchor?: PlanningAnchor
    readonly tx?: Pick<typeof prisma, 'executionEvent' | 'slaveRun'>
  } = {},
): Promise<PlanningCount> {
  const tx = options.tx ?? prisma
  const anchor = options.anchor ?? 'latest_goal'

  const events = await tx.executionEvent.findMany({
    where: { workspaceId, type: { in: ['workspace_goal_set', 'workspace_planning_reset'] } },
    orderBy: { seq: 'desc' },
    take: PLANNING_EVENTS_SCANNED,
    select: { type: true, ts: true, payload: true },
  })

  const goalSets = events.filter((row) => row.type === 'workspace_goal_set')
  const resets = events.filter((row) => row.type === 'workspace_planning_reset')
  const resetsOfVersion = resets.filter((row) => versionOf(row.payload) === goalVersion)

  // Newest first, so `[0]` / `find` are the newest matching rows.
  const anchoringGoalSet =
    anchor === 'latest_goal' ? goalSets[0] : goalSets.find((row) => versionOf(row.payload) === goalVersion)
  const anchoringResets = anchor === 'latest_goal' ? resets : resetsOfVersion

  const since = new Date(
    [anchoringGoalSet, ...anchoringResets].reduce(
      (latest, row) => (row === undefined ? latest : Math.max(latest, row.ts.getTime())),
      0,
    ),
  )

  const failures = await tx.slaveRun.count({
    where: {
      kind: 'planning',
      status: 'failed',
      spawnFailed: false,
      startedAt: { gt: since },
      slave: { team: { workspaceId } },
    },
  })

  return { since, failures, resetsOfVersion: resetsOfVersion.length }
}
