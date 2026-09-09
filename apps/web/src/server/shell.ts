import { workspaceSpend } from '@slave-of-ai/control'
import { toRunState } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { deriveSlaveStatus, NON_TERMINAL_RUN_STATUSES, type SpendGroup } from '@slave-of-ai/domain'
import { spendOfGroups } from './org'

/**
 * The shell's own tiny snapshot (M14 §3, widened M24 §2.2): the two live counts the sidebar's nav
 * rows once carried and now the project header/tab strip render, the workspace's guardrail
 * columns for the bottom block, and the header's own figures -- the goal line, the budget bar and
 * the halt state.
 *
 * Its own module and its own route rather than a slice of `OverviewSnapshot`, because the header
 * and tabs are mounted by the PROJECT LAYOUT on every page — including `/w/:id/tasks`, `/graph`
 * and `/activity`, none of which builds an overview snapshot. Reading the overview's much larger
 * snapshot from four routes to display a handful of figures is the cost this avoids.
 */
export interface ShellFacts {
  readonly workspace: { readonly id: string; readonly name: string }
  readonly counts: {
    /** Distinct SLAVES whose derived status is `working` — the handoff's "slaves working" badge.
     *  Slaves, never runs: one slave with two live runs is one slave working (M14 fix wave,
     *  review Minor 2 — the badge disagreed with Overview's per-slave strip on the same
     *  workspace). */
    readonly slavesWorking: number
    /** Tasks in the six statuses `overview.ts` counts as active work. */
    readonly tasksActive: number
  }
  readonly guardrails: {
    /** `null` for an unbudgeted workspace (M12 Task 9) — rendered `—`, never `$0.00`. */
    readonly budgetUsd: number | null
    readonly maxConcurrentRuns: number
    readonly runTimeoutMs: number
    readonly maxAttempts: number
  }
  /** The header's own figures (M24 §2.2): the goal line, the budget bar and the halt state.
   *  Published by every workspace page alongside the counts, so the header never opens a stream. */
  readonly status: {
    readonly goal: string | null
    /**
     * What this workspace has spent, by the ONE formula the budget guardrail uses
     * (`workspaceSpend`, spec erratum E2): every run that reported a cost, plus the Supervisor's
     * measured decisions, plus its unmeasured calls at `SUPERVISOR_PER_CALL_CAP_USD`.
     *
     * The same number Overview's spend tile shows (final review Important 3). It was
     * `spendOfGroups`' run-only total, which Overview stopped using in M38 t5 -- so the very same
     * header, mounted by the project layout on every page, reported one figure on `/w/:id` and a
     * smaller one on `/w/:id/tasks` and `/activity` the moment a Supervisor decision cost
     * anything. A budget bar that shrinks when you change tab is worse than either figure alone.
     */
    readonly spentUsd: number
    /** How many RUNS of this workspace have no recorded cost -- `spendOfGroups`' count, unchanged
     *  and deliberately still about runs: {@link spentUsd} is money and this is a caveat on how
     *  much of the run half of it could be known. The Supervisor's own unmeasured calls are not
     *  here; they are already IN the total, charged at the per-call cap rather than unknown. */
    readonly unmeasuredRuns: number
    readonly haltedReason: string | null
  }
}

// Mirrors `overview.ts`'s own list (the M8a widening: a task under review or in the merge queue
// is still active work; the M36 t2 one: a task waiting for another slave's answer is in flight,
// not parked for a human). Not imported — `overview.ts` does not export it, and this module's
// whole point is not to depend on that one.
const ACTIVE_TASK_STATUSES = ['ready', 'running', 'verifying', 'reviewing', 'merging', 'rework', 'waiting'] as const

export async function buildShellFacts(workspaceId: string): Promise<ShellFacts | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  const [runs, tasksActive, spendGroups, spendTotal] = await Promise.all([
    // No `select`: `toRunState` maps a whole `SlaveRun` row, and narrowing the query to the four
    // columns it happens to read today would hand it an object the mapper's own type rejects —
    // and would have to be revisited every time the domain's `RunState` grows a field. The row
    // set is bounded by `maxConcurrentRuns`-ish live runs, not by history.
    prisma.slaveRun.findMany({
      where: { slave: { team: { workspaceId } }, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
    }),
    prisma.task.count({ where: { workspaceId, status: { in: [...ACTIVE_TASK_STATUSES] } } }),
    // Grouped by the database, exactly `listWorkers`'/`listProjects`' shape (`org.ts`), scoped to
    // this one workspace's slaves rather than every slave everywhere -- `overview.ts`'s own spend
    // derivation, restated over `spendOfGroups` instead of the whole-history row array `sumSpend`
    // takes, so the header and Overview cannot come to disagree about what an unmeasured run does
    // to the total.
    prisma.slaveRun.groupBy({
      by: ['provider', 'status'],
      where: { slave: { team: { workspaceId } } },
      _sum: { costUsd: true },
      _count: { _all: true, costUsd: true },
    }),
    // The TOTAL, by the guardrail's own formula -- `overview.ts` does exactly this alongside the
    // same groups, and for the same reason: the groups stay for the unmeasured-RUN count that no
    // aggregate can produce, while the money comes from the one place that knows about the
    // Supervisor's spend as well as the runs'.
    workspaceSpend(workspaceId),
  ])

  // `deriveSlaveStatus` rather than a `status === 'working'` filter on the row: the domain owns
  // that mapping, and this badge must agree with the pill on every card that shows the same slave.
  // Deduped by `slaveId` (review Minor 2): the badge counts SLAVES, and `slaveRun` can hold more
  // than one live row for one slave, which made the same workspace's badge read differently
  // depending on which page happened to be publishing.
  const slavesWorking = new Set(
    runs.filter((run) => deriveSlaveStatus(toRunState(run)) === 'working').map((run) => run.slaveId),
  ).size

  // Same `SpendGroup` construction as `listProjects`/`listWorkers` (`org.ts`).
  const groups: SpendGroup[] = spendGroups.map((g) => ({
    provider: g.provider,
    status: g.status,
    knownUsd: g._sum.costUsd ?? 0,
    rowCount: g._count._all,
    measuredCount: g._count.costUsd,
  }))
  // `spend` (the groups' run-only total) is deliberately dropped: only the run COUNT is taken from
  // here now, and `spentUsd` below is `workspaceSpend`'s.
  const { unmeasuredRuns } = spendOfGroups(groups)

  return {
    workspace: { id: workspace.id, name: workspace.name },
    counts: { slavesWorking, tasksActive },
    guardrails: {
      budgetUsd: workspace.budgetUsd,
      maxConcurrentRuns: workspace.maxConcurrentRuns,
      runTimeoutMs: workspace.runTimeoutMs,
      maxAttempts: workspace.maxAttempts,
    },
    status: {
      goal: workspace.goal,
      spentUsd: spendTotal.spentUsd,
      unmeasuredRuns,
      haltedReason: workspace.haltedReason,
    },
  }
}
