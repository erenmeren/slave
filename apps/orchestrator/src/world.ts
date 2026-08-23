import {
  agentId,
  taskId,
  NON_TERMINAL_RUN_STATUSES,
  type RunStatus,
  type SchedulableAgent,
  type SchedulableTask,
  type TaskStatus,
  type WorkspaceId,
  type World,
} from '@ai-team-os/domain'
import { prisma, type Prisma } from '@ai-team-os/db/client'

// Re-exported so `cli.ts` and `sweep.ts` keep importing it from here -- the statuses an
// `AgentRun` can still leave (an agent holding one of these is busy) now live in
// `packages/domain/src/run/state.ts`, the one place the web and the orchestrator both read them
// from, so the two cannot drift onto different definitions of "not finished".
export { NON_TERMINAL_RUN_STATUSES } from '@ai-team-os/domain'

type RunStatusKind = 'non_terminal' | 'concluded' | 'terminal_uncounted'

/**
 * Every `RunStatus` classified exactly once. `CONCLUDED_RUN_STATUSES` below is *derived* from
 * this map rather than written out independently, so a tenth `RunStatus` added to
 * `packages/domain` breaks this build -- `satisfies Record<RunStatus, …>` demands a key per
 * member -- instead of quietly falling outside every list, where it would stay invisible to the
 * failure breaker.
 *
 * `non_terminal` here must still agree with `NON_TERMINAL_RUN_STATUSES`, imported above from
 * `packages/domain/src/run/state.ts` -- this map no longer derives that constant (it is the
 * domain's now), but it still has to classify every `RunStatus` to stay exhaustive, and "busy"
 * and "non-terminal" are the same question asked of two different tables.
 *
 * `stopped` is deliberately neither kind: it is terminal, so it releases the agent that held it,
 * but an operator stopping a run is not the run failing. It must not count toward the failure
 * streak, and it must not break one either -- a single stop should not launder away a real streak.
 */
const RUN_STATUS_KIND = {
  starting: 'non_terminal',
  working: 'non_terminal',
  pause_requested: 'non_terminal',
  paused: 'non_terminal',
  resuming: 'non_terminal',
  stopping: 'non_terminal',
  stopped: 'terminal_uncounted',
  succeeded: 'concluded',
  failed: 'concluded',
} satisfies Record<RunStatus, RunStatusKind>

function statusesOfKind(kind: RunStatusKind): readonly RunStatus[] {
  return (Object.keys(RUN_STATUS_KIND) as RunStatus[]).filter((status) => RUN_STATUS_KIND[status] === kind)
}

/**
 * The only statuses a run's `consecutiveFailures` streak can be counted from -- a run still in
 * progress has not concluded either way, so it contributes nothing to the streak and must not
 * break it either.
 */
const CONCLUDED_RUN_STATUSES: readonly RunStatus[] = statusesOfKind('concluded')

export interface LoadedWorld {
  readonly world: World
  /**
   * Tasks excluded from `world.tasks` because `Task.requiredRole` is `null`. Spec §4: a task
   * with no required role cannot be matched to an agent by `decide()`, whose `SchedulableTask`
   * makes `requiredRole` non-nullable by design. The exclusion is real (the domain type leaves
   * no other way to represent "no role"), but it must never be *silent* -- an operator needs to
   * see that a task is stuck outside the schedulable set for a reason that has nothing to do
   * with dependencies or guardrails.
   */
  readonly skippedNoRole: number
}

interface TaskWorldRow {
  readonly id: string
  readonly status: TaskStatus
  readonly requiredRole: string | null
  readonly priority: number
  readonly dependenciesDone: boolean
}

/**
 * Loads every `Task` row for the workspace alongside a SQL-computed `dependenciesDone`: true
 * when the task has no dependencies at all (vacuously satisfied) or when every dependency it
 * does have is `done`. Computing this with `NOT EXISTS` rather than fetching dependencies and
 * reducing in application code keeps the read to one round trip and, more importantly, keeps the
 * "every dependency done" definition in the one place a query planner can prove it against the
 * data instead of a second, hand-written traversal that could drift from it.
 */
async function loadTaskRows(
  tx: Prisma.TransactionClient,
  workspaceId: WorkspaceId,
): Promise<readonly TaskWorldRow[]> {
  return tx.$queryRaw<TaskWorldRow[]>`
    SELECT
      t.id,
      t.status::text AS status,
      t."requiredRole",
      t.priority,
      NOT EXISTS (
        SELECT 1
        FROM "TaskDependency" td
        JOIN "Task" dep ON dep.id = td."dependsOnTaskId"
        WHERE td."taskId" = t.id AND dep.status <> 'done'
      ) AS "dependenciesDone"
    FROM "Task" t
    WHERE t."workspaceId" = ${workspaceId}
  `
}

interface AgentWorldRow {
  readonly id: string
  readonly role: string
  readonly runs: readonly { readonly id: string }[]
}

/**
 * An agent is busy when it holds any `AgentRun` in a non-terminal status -- not when it has ever
 * held one. `take: 1` on the filtered relation is enough to answer "any?" without pulling every
 * run an agent has accumulated over its lifetime.
 */
async function loadAgentRows(
  tx: Prisma.TransactionClient,
  workspaceId: WorkspaceId,
): Promise<readonly AgentWorldRow[]> {
  return tx.agent.findMany({
    where: { team: { workspaceId } },
    select: {
      id: true,
      role: true,
      runs: { where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } }, select: { id: true }, take: 1 },
    },
  })
}

/**
 * `stats.activeRuns` and `stats.spentUsd` are aggregated from every `AgentRun` belonging to the
 * workspace's tasks -- there is no `AgentRun.workspaceId` column, so both queries join through
 * `Task`. Spend is summed across *every* run regardless of status, not just non-terminal ones:
 * spec §4 notes that summing `costUsd` across a task's run segments is the correct accounting
 * (ADR 0001 Q3 measured each segment's `total_cost_usd` as that segment's own total, not a
 * running session total), and a run that already finished still spent real money.
 */
async function loadRunStats(
  tx: Prisma.TransactionClient,
  workspaceId: WorkspaceId,
): Promise<{
  readonly activeRuns: number
  readonly globalActiveRuns: number
  readonly spentUsd: number
  readonly consecutiveFailures: number
}> {
  // `agent: { team: { workspaceId } }`, not `task: { workspaceId }`: a `planning` run (M8b) has no
  // `Task` row, and it still occupies a concurrency slot and spends real money -- scoping through
  // `Task` would silently drop it from both figures below.
  const activeRuns = await tx.agentRun.count({
    where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] }, agent: { team: { workspaceId } } },
  })
  const globalActiveRuns = await tx.agentRun.count({
    where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
  })
  const spend = await tx.agentRun.aggregate({
    where: { agent: { team: { workspaceId } } },
    _sum: { costUsd: true },
  })

  // Most recently concluded first, so the leading run of the list is the one the streak counts
  // from. `AgentRun.terminalAt` is written by the event pump as of Task 12 -- when this was first
  // written nothing populated it, and the COALESCE below was defensive; it is now load-bearing for
  // every run the pump concludes, while rows written before it still carry `null`. A bare
  // `ORDER BY "terminalAt" DESC` is therefore not merely imprecise, it is a trap: Postgres sorts
  // `DESC` as NULLS FIRST, so the moment a later task starts populating the column, every legacy
  // null row jumps to the front and *inverts* the streak -- three ancient failures ahead of
  // today's success reads as `consecutiveFailures: 3`, which trips the circuit breaker into a
  // permanent halt on a workspace that is succeeding. `COALESCE` states what is actually true: a
  // run's position in the streak is when it concluded, and `startedAt` is the stand-in for rows
  // that predate the pump writing the column. `startedAt DESC` then breaks ties.
  //
  // Raw SQL rather than Prisma's `orderBy`, which cannot express a `COALESCE` sort key.
  //
  // Deliberately unbounded: the loop below stops at the first non-`failed` run, but the query
  // returns every run the workspace has ever concluded. A `LIMIT` would bound the transfer, and
  // the only bound that is certainly safe -- the workspace's `consecutiveFailureLimit` -- would
  // also cap the reported number, turning `stats.consecutiveFailures` from "the streak" into
  // "the streak, up to the limit". `evaluateGuardrails` only ever compares it with `>=` so it
  // would not notice, but a later consumer reading the figure as a count would. One status column
  // per concluded run is cheap enough that the trade is not worth making blind; revisit it against
  // a workspace with a real run history rather than a fixture.
  // Joined through `Agent`/`Team`, not `Task`: a `planning` run (M8b) has no `Task` row, and a
  // garbage planner must still feed the circuit breaker like any other agent (the M8a review-run
  // precedent) -- a join through `Task` alone would let it fail forever with no streak to halt it.
  const concludedRuns = await tx.$queryRaw<{ readonly status: RunStatus }[]>`
    SELECT r.status::text AS status
    FROM "AgentRun" r
    JOIN "Agent" a ON a.id = r."agentId"
    JOIN "Team" tm ON tm.id = a."teamId"
    WHERE tm."workspaceId" = ${workspaceId}
      AND r.status::text = ANY(${[...CONCLUDED_RUN_STATUSES]}::text[])
    ORDER BY COALESCE(r."terminalAt", r."startedAt") DESC, r."startedAt" DESC
  `

  let consecutiveFailures = 0
  for (const run of concludedRuns) {
    if (run.status !== 'failed') break
    consecutiveFailures += 1
  }

  return { activeRuns, globalActiveRuns, spentUsd: spend._sum.costUsd ?? 0, consecutiveFailures }
}

/**
 * How long `loadWorld`'s snapshot transaction may take, and how long it may wait for a pooled
 * connection before giving up. Prisma's own defaults are 5000/2000 ms; these are deliberately
 * looser. A `loadWorld` that genuinely needs more than 15 s means something is badly wrong and
 * failing the tick is the right answer -- but 5 s is tight enough that ordinary contention could
 * reach it, and a tick that throws `P2028` under load is a worse failure than a tick that takes
 * six seconds.
 *
 * Measured, because the enforcement point is not the obvious one: Prisma checks the budget when it
 * issues the *next* statement, not while one is running. A single 7 s statement inside a default
 * transaction completes; the same 7 s followed by any second statement raises `P2028`. The reads
 * below are five sequential statements, so this budget is checked four times and it is the
 * *cumulative* elapsed time that matters, not any one query's.
 */
const LOAD_WORLD_TIMEOUT_MS = 15_000
const LOAD_WORLD_MAX_WAIT_MS = 5_000

/**
 * Spec §5: a hard cap on non-terminal `AgentRun`s across every workspace at once, not per
 * workspace. A `Workspace` column would let N workspaces each configure their own limit and
 * collectively blow the machine's real capacity for concurrent `claude` processes -- the whole
 * point is a ceiling nothing on a per-workspace path can raise.
 */
const MAX_GLOBAL_CONCURRENT_RUNS = 6

/**
 * Maps the database onto the domain's `World` (spec §4). This is the only place that translation
 * happens: `decide()` stays pure and never sees a `Prisma` type, and every field below traces to
 * a named source in spec §4's table rather than an inferred default.
 */
export async function loadWorld(workspaceId: WorkspaceId): Promise<LoadedWorld> {
  // `isolationLevel: 'RepeatableRead'` is the point of this transaction, not the transaction
  // wrapper. Postgres defaults to Read Committed, under which each statement inside a transaction
  // still takes its own fresh snapshot -- a bare `$transaction` would look like a fix and change
  // nothing. Do not "simplify" the isolation level away.
  //
  // Atomicity matters here because `loadWorld`'s whole contract is *the snapshot the scheduler
  // decides from*. A torn read -- `agents` from one instant, `stats` from another -- lets
  // `decide()` emit a `start_run` for an agent that became busy between two of the reads, and
  // that spawns a real `claude` process spending real money.
  const { workspace, taskRows, agentRows, runStats } = await prisma.$transaction(
    async (tx) => {
      // Sequential rather than `Promise.all`: an interactive transaction is pinned to a single
      // connection, so queries issued concurrently on `tx` serialize anyway, and under
      // RepeatableRead the order they run in cannot change what they see.
      const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
      const taskRows = await loadTaskRows(tx, workspaceId)
      const agentRows = await loadAgentRows(tx, workspaceId)
      const runStats = await loadRunStats(tx, workspaceId)
      return { workspace, taskRows, agentRows, runStats }
    },
    {
      isolationLevel: 'RepeatableRead',
      // Both numbers are stated rather than defaulted, because wrapping these reads in a
      // transaction silently imported Prisma's defaults onto a once-per-tick path: a 5 s
      // transaction budget and a 2 s wait for a pooled connection, neither chosen by anyone. The
      // failure mode that change introduces is not "the tick is slow" but "the tick throws
      // P2028", so the budget is worth naming at the size we actually mean.
      timeout: LOAD_WORLD_TIMEOUT_MS,
      maxWait: LOAD_WORLD_MAX_WAIT_MS,
    },
  )

  let skippedNoRole = 0
  const tasks: SchedulableTask[] = []
  for (const row of taskRows) {
    if (row.requiredRole === null) {
      skippedNoRole += 1
      continue
    }
    tasks.push({
      id: taskId(row.id),
      status: row.status,
      requiredRole: row.requiredRole,
      priority: row.priority,
      dependenciesDone: row.dependenciesDone,
    })
  }

  const agents: SchedulableAgent[] = agentRows.map((row) => ({
    id: agentId(row.id),
    role: row.role,
    busy: row.runs.length > 0,
  }))

  const world: World = {
    tasks,
    agents,
    limits: {
      maxConcurrentRuns: workspace.maxConcurrentRuns,
      budgetUsd: workspace.budgetUsd,
      runTimeoutMs: workspace.runTimeoutMs,
      maxToolCallsPerRun: workspace.maxToolCallsPerRun,
      maxAttempts: workspace.maxAttempts,
      consecutiveFailureLimit: workspace.consecutiveFailureLimit,
      maxGlobalConcurrentRuns: MAX_GLOBAL_CONCURRENT_RUNS,
    },
    stats: {
      activeRuns: runStats.activeRuns,
      globalActiveRuns: runStats.globalActiveRuns,
      spentUsd: runStats.spentUsd,
      consecutiveFailures: runStats.consecutiveFailures,
      // Not hardcoded: a pause gate failure sets `Workspace.haltedReason` (spec §13.1), and M8's
      // human-facing emergency stop is deliberately built on this same column rather than a
      // second one. Reading it live here is what lets a persistent halt survive a daemon
      // restart -- there is no in-memory latch anywhere for it to be lost from.
      emergencyStopped: workspace.haltedReason !== null,
    },
  }

  return { world, skippedNoRole }
}
