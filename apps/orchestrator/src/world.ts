import { workspaceStats } from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  slaveId,
  taskId,
  NON_TERMINAL_RUN_STATUSES,
  type SchedulableSlave,
  type SchedulableTask,
  type TaskStatus,
  type WorkspaceId,
  type World,
} from '@slave-of-ai/domain'

// Re-exported so `cli.ts` and `sweep.ts` keep importing it from here -- the statuses an
// `SlaveRun` can still leave (a slave holding one of these is busy) now live in
// `packages/domain/src/run/state.ts`, the one place the web and the orchestrator both read them
// from, so the two cannot drift onto different definitions of "not finished".
export { NON_TERMINAL_RUN_STATUSES } from '@slave-of-ai/domain'

export interface LoadedWorld {
  readonly world: World
  /**
   * Tasks excluded from `world.tasks` because `Task.requiredRole` is `null`. Spec §4: a task
   * with no required role cannot be matched to a slave by `decide()`, whose `SchedulableTask`
   * makes `requiredRole` non-nullable by design. The exclusion is real (the domain type leaves
   * no other way to represent "no role"), but it must never be *silent* -- an operator needs to
   * see that a task is stuck outside the schedulable set for a reason that has nothing to do
   * with dependencies or guardrails.
   */
  readonly skippedNoRole: number
  /**
   * The Supervisor's share of `world.stats.spentUsd` (M38 §5), split so a surface can say what it
   * is made of. NOT on `world.stats`: that is the domain's `WorkspaceStats`, which `decide()` and
   * `evaluateGuardrails` read, and neither of them has any business knowing WHO spent the money --
   * only how much. `unmeasuredCalls` are already charged into `spentUsd` at
   * `SUPERVISOR_PER_CALL_CAP_USD` each; the count is here so an operator sees an estimate labelled
   * as one, the same way `apps/web`'s `unmeasuredRuns` note does for runs.
   */
  readonly supervisorSpend: { readonly measuredUsd: number; readonly unmeasuredCalls: number }
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
 * does have is both `done` AND integrated. Computing this with `NOT EXISTS` rather than fetching
 * dependencies and reducing in application code keeps the read to one round trip and, more
 * importantly, keeps the "every dependency done" definition in the one place a query planner can
 * prove it against the data instead of a second, hand-written traversal that could drift from it.
 *
 * M35 t2: `dep.status <> 'done'` alone used to be the whole predicate -- but `merge.ts`'s
 * `!autoMerge` path marks a task `done` with no git merge at all (spec Decision 5), leaving its
 * branch and worktree for a human. A dependent gated on `status` alone was scheduled and
 * provisioned from `workspace.baseBranch` while that dependency's commits were still sitting on
 * the unmerged branch. `dep."integratedAt" IS NULL` closes that: it is null until `merge.ts`'s
 * real-merge path stamps it, or a human runs `confirmIntegration`/`orchestrator
 * confirm-integration` after merging by hand -- see `Task.integratedAt`'s own doc comment in
 * `schema.prisma`.
 *
 * `apps/web/src/server/graph.ts`'s `loadGraphTaskRows` copies this exact `WHERE` clause for the
 * same reason its own comment gives (the graph's read model must not disagree with the scheduler
 * about what "ready" means) -- the two must move together; if you change one, change the other in
 * the same commit (M35 t2 review round 1 caught this pair drifting once already).
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
        WHERE td."taskId" = t.id AND (dep.status <> 'done' OR dep."integratedAt" IS NULL)
      ) AS "dependenciesDone"
    FROM "Task" t
    WHERE t."workspaceId" = ${workspaceId}
  `
}

interface SlaveWorldRow {
  readonly id: string
  /** M37 §5: what the scheduler matches `Task.requiredRole` against. `Slave.role` is the profile's
   *  title and is deliberately NOT selected here -- nothing in a scheduling decision reads it. */
  readonly runtimeRoles: readonly string[]
  readonly runs: readonly { readonly id: string }[]
}

/**
 * A slave is busy when it holds any `SlaveRun` in a non-terminal status -- not when it has ever
 * held one. `take: 1` on the filtered relation is enough to answer "any?" without pulling every
 * run a slave has accumulated over its lifetime.
 */
async function loadSlaveRows(
  tx: Prisma.TransactionClient,
  workspaceId: WorkspaceId,
): Promise<readonly SlaveWorldRow[]> {
  return tx.slave.findMany({
    where: { team: { workspaceId } },
    select: {
      id: true,
      runtimeRoles: true,
      runs: { where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } }, select: { id: true }, take: 1 },
    },
  })
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
  // decides from*. A torn read -- `slaves` from one instant, `stats` from another -- lets
  // `decide()` emit a `start_run` for a slave that became busy between two of the reads, and
  // that spawns a real `claude` process spending real money.
  const { snapshot, taskRows, slaveRows } = await prisma.$transaction(
    async (tx) => {
      // Sequential rather than `Promise.all`: an interactive transaction is pinned to a single
      // connection, so queries issued concurrently on `tx` serialize anyway, and under
      // RepeatableRead the order they run in cannot change what they see.
      //
      // The workspace row, the limits and every guardrail statistic come from control's
      // `workspaceStats` as of M38 t3 fix round 2 (spec erratum E7) -- the same helper
      // `loadSupervisorWorld` reads, so the halt the scheduler acts on and the halt the Supervisor
      // sees are computed from one reading of one workspace. It runs on `tx`, so it is this
      // snapshot's reading and not a later one.
      const snapshot = await workspaceStats(workspaceId, tx)
      const taskRows = await loadTaskRows(tx, workspaceId)
      const slaveRows = await loadSlaveRows(tx, workspaceId)
      return { snapshot, taskRows, slaveRows }
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

  const slaves: SchedulableSlave[] = slaveRows.map((row) => ({
    id: slaveId(row.id),
    runtimeRoles: row.runtimeRoles,
    busy: row.runs.length > 0,
  }))

  const world: World = { tasks, slaves, limits: snapshot.limits, stats: snapshot.stats }

  return {
    world,
    skippedNoRole,
    supervisorSpend: {
      measuredUsd: snapshot.spend.supervisorMeasuredUsd,
      unmeasuredCalls: snapshot.spend.supervisorUnmeasuredCalls,
    },
  }
}
