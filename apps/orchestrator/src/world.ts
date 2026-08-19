import {
  agentId,
  taskId,
  type RunStatus,
  type SchedulableAgent,
  type SchedulableTask,
  type TaskStatus,
  type WorkspaceId,
  type World,
} from '@ai-team-os/domain'
import { prisma } from '@ai-team-os/db/client'

/**
 * Mirrors the `ACTIVE` list in `packages/domain/src/run/state.ts` -- that list is not exported
 * (it is a private implementation detail of `applyRunEvent`), so it is restated here rather than
 * imported. "Busy" and "non-terminal" are the same question from two different tables, and they
 * must stay the same list: `stopped`, `succeeded`, and `failed` are the only statuses an
 * `AgentRun` cannot leave, so those three -- and only those three -- release the agent that held
 * it.
 */
const NON_TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'starting',
  'working',
  'pause_requested',
  'paused',
  'resuming',
  'stopping',
]

/** Only the statuses a run's `consecutiveFailures` streak can be counted from -- a run still in
 * progress has not concluded either way, so it contributes nothing to the streak and must not
 * break it either. */
const CONCLUDED_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed']

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
async function loadTaskRows(workspaceId: WorkspaceId): Promise<readonly TaskWorldRow[]> {
  return prisma.$queryRaw<TaskWorldRow[]>`
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
async function loadAgentRows(workspaceId: WorkspaceId): Promise<readonly AgentWorldRow[]> {
  return prisma.agent.findMany({
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
  workspaceId: WorkspaceId,
): Promise<{ readonly activeRuns: number; readonly spentUsd: number; readonly consecutiveFailures: number }> {
  const [activeRuns, spend, concludedRuns] = await Promise.all([
    prisma.agentRun.count({
      where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] }, task: { workspaceId } },
    }),
    prisma.agentRun.aggregate({
      where: { task: { workspaceId } },
      _sum: { costUsd: true },
    }),
    // Most recently concluded first, so the leading run of the list is the one the streak counts
    // from. `terminalAt` is the column `packages/db`'s schema added for exactly this kind of
    // "when did this run actually conclude" ordering; `startedAt` breaks ties for runs that
    // concluded in the same tick (or, in a fixture, share `terminalAt: null`).
    prisma.agentRun.findMany({
      where: { status: { in: [...CONCLUDED_RUN_STATUSES] }, task: { workspaceId } },
      orderBy: [{ terminalAt: 'desc' }, { startedAt: 'desc' }],
      select: { status: true },
    }),
  ])

  let consecutiveFailures = 0
  for (const run of concludedRuns) {
    if (run.status !== 'failed') break
    consecutiveFailures += 1
  }

  return { activeRuns, spentUsd: spend._sum.costUsd ?? 0, consecutiveFailures }
}

/**
 * Maps the database onto the domain's `World` (spec §4). This is the only place that translation
 * happens: `decide()` stays pure and never sees a `Prisma` type, and every field below traces to
 * a named source in spec §4's table rather than an inferred default.
 */
export async function loadWorld(workspaceId: WorkspaceId): Promise<LoadedWorld> {
  const [workspace, taskRows, agentRows, runStats] = await Promise.all([
    prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } }),
    loadTaskRows(workspaceId),
    loadAgentRows(workspaceId),
    loadRunStats(workspaceId),
  ])

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
    },
    stats: {
      activeRuns: runStats.activeRuns,
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
