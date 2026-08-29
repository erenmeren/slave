import { prisma } from '@ai-team-os/db/client'
import { toRunState } from '@ai-team-os/db'
import { deriveAgentStatus, NON_TERMINAL_RUN_STATUSES, type TaskStatus } from '@ai-team-os/domain'

/**
 * `costUsd` lived here briefly (M12 Task 9, ruling R3, widened to `number | null` for Decision 6)
 * and was deleted at M12 Task 13 fix round 1 (spec gap 4c, controller ruling): the graph surface
 * has no renderer for cost -- `grep -rn cost apps/web/src/components/graph/` found nothing then
 * and still finds nothing -- and a DTO field nothing consumes is the ruling's own words "the worse
 * of the two" against rendering a `—` nobody asked for. If a future task wants cost on the graph,
 * it re-adds the field at the point it also adds the renderer, not before.
 */
export interface GraphAgent {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly teamId: string
  readonly status: string // the M4 derived status vocabulary (AgentStatus, widened per spec §3.1)
  readonly activeTaskId: string | null
  readonly activeTaskTitle: string | null
  readonly activeRunId: string | null
}

export interface GraphTask {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  readonly priority: number
  readonly attempt: number
  readonly maxAttempts: number
  readonly dependenciesDone: boolean
}

export interface GraphSnapshot {
  readonly workspace: { readonly id: string; readonly name: string; readonly haltedReason: string | null }
  readonly teams: readonly { readonly id: string; readonly name: string }[]
  readonly agents: readonly GraphAgent[]
  readonly tasks: readonly GraphTask[]
  readonly dependencies: readonly { readonly taskId: string; readonly dependsOnTaskId: string }[]
}

interface GraphTaskRow {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  readonly priority: number
  readonly attempt: number
  readonly maxAttempts: number
  readonly dependenciesDone: boolean
}

/**
 * `dependenciesDone` reuses the scheduler's own `NOT EXISTS` SQL shape (`apps/orchestrator/src/
 * world.ts`'s `loadTaskRows`, lines 90-109) rather than fetching `TaskDependency` rows and
 * reducing "every dependency done" in JS a second time -- the read model must agree with the
 * scheduler's own definition of ready-to-run, not a hand-rolled approximation of it that could
 * drift. `apps/orchestrator` is a separate app from `apps/web` (not a shared package), so the
 * query is copied here rather than imported, extended with the columns the graph view needs
 * (`title`, `attempt`, `maxAttempts`) that the scheduler's own row shape does not carry.
 */
async function loadGraphTaskRows(workspaceId: string): Promise<readonly GraphTaskRow[]> {
  return prisma.$queryRaw<GraphTaskRow[]>`
    SELECT
      t.id,
      t.title,
      t.status::text AS status,
      t.priority,
      t.attempt,
      t."maxAttempts",
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

export async function buildGraphSnapshot(workspaceId: string): Promise<GraphSnapshot | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  const teams = await prisma.team.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } })

  const agents = await prisma.agent.findMany({
    where: { team: { workspaceId } },
    orderBy: { name: 'asc' },
  })

  // One live run per agent at most (the scheduler enforces it); latest by startedAt breaks any
  // fixture-made tie deterministically. Mirrors `buildOverviewSnapshot`'s own wiring so the two
  // read models cannot derive "which run is this agent's live one" differently.
  const liveRuns = await prisma.agentRun.findMany({
    where: {
      agentId: { in: agents.map((a) => a.id) },
      status: { in: [...NON_TERMINAL_RUN_STATUSES] },
    },
    orderBy: { startedAt: 'desc' },
    include: { task: true },
  })
  const liveRunByAgent = new Map<string, (typeof liveRuns)[number]>()
  for (const run of liveRuns) {
    if (!liveRunByAgent.has(run.agentId)) liveRunByAgent.set(run.agentId, run)
  }

  const [taskRows, dependencyRows] = await Promise.all([
    loadGraphTaskRows(workspaceId),
    prisma.taskDependency.findMany({ where: { task: { workspaceId } } }),
  ])

  return {
    workspace: { id: workspace.id, name: workspace.name, haltedReason: workspace.haltedReason },
    teams: teams.map((team) => ({ id: team.id, name: team.name })),
    agents: agents.map((agent) => {
      const run = liveRunByAgent.get(agent.id) ?? null
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        teamId: agent.teamId,
        // The one translator (ADR 0002): never re-derive the run→agent status mapping here.
        status: deriveAgentStatus(run === null ? null : toRunState(run)),
        activeTaskId: run?.taskId ?? null,
        activeTaskTitle: run?.task?.title ?? null,
        activeRunId: run?.id ?? null,
      }
    }),
    tasks: taskRows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      priority: row.priority,
      attempt: row.attempt,
      maxAttempts: row.maxAttempts,
      dependenciesDone: row.dependenciesDone,
    })),
    dependencies: dependencyRows.map((row) => ({ taskId: row.taskId, dependsOnTaskId: row.dependsOnTaskId })),
  }
}
