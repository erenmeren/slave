import { prisma } from '@ai-team-os/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, toRunState } from '@ai-team-os/db'
import { deriveAgentStatus, NON_TERMINAL_RUN_STATUSES, type TaskStatus } from '@ai-team-os/domain'
import type { ProviderKind } from '@ai-team-os/control'
import { feedSummary } from '../lib/feedSummary'
import { buildShellFacts, type ShellFacts } from './shell'

/** One line of the drawer's checkpoint list (design README "1b — Drawer"): `✓` done, `●` current,
 *  `○` pending. The GLYPH is the drawer's; this is only which of the three a line is in. */
export interface GraphCheckpoint {
  readonly label: string
  readonly state: 'done' | 'current' | 'pending'
}

/** One line of the drawer's event tail. Deliberately narrower than `lib/feedSummary.ts`'s
 *  `AgentFeedEvent` (no `type`): the drawer renders a clock and a sentence, and a raw event type
 *  beside an already-summarized line says nothing the summary does not. */
export interface GraphEvent {
  readonly seq: number
  readonly ts: string
  readonly summary: string
}

/**
 * `costUsd` lived here briefly (M12 Task 9, ruling R3, widened to `number | null` for Decision 6)
 * and was deleted at M12 Task 13 fix round 1 (spec gap 4c, controller ruling): the graph surface
 * has no renderer for cost -- `grep -rn cost apps/web/src/components/graph/` found nothing then
 * and still finds nothing -- and a DTO field nothing consumes is the ruling's own words "the worse
 * of the two" against rendering a `—` nobody asked for. If a future task wants cost on the graph,
 * it re-adds the field at the point it also adds the renderer, not before.
 *
 * The six fields below `activeRunId` are the M14 Task 11 drawer's facts, and every one of them has
 * a renderer in `components/graph/GraphDrawer.tsx` -- the same rule that deleted `costUsd`.
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
  /** The runtime this agent's live run is on, falling back to the agent row's own override --
   *  `null` when neither is recorded (every run before M12 Task 8). */
  readonly provider: ProviderKind | null
  /** The model the live run STARTED with (`Checkpoint.model`, which resume replays), falling back
   *  to the agent row's override. `null` when neither is recorded. */
  readonly model: string | null
  /** `toolCalls / Workspace.maxToolCallsPerRun`, clamped to [0,100] -- the same ceiling `sweep.ts`
   *  enforces, so the bar measures the run against the limit that will actually stop it. `0` with
   *  no live run. */
  readonly progressPct: number
  /** `✓` done / `●` current / `○` pending, from this run's `Checkpoint` row and its tool-call
   *  count. Empty for an agent with no live run. */
  readonly checkpoints: readonly GraphCheckpoint[]
  /** This run's most recent events, newest first, capped at 8 -- the drawer's tail. */
  readonly recentEvents: readonly GraphEvent[]
  /** `true` when the agent's live or most recent run has a non-null `skillCalls` -- what makes the
   *  "Skill chain" mode reachable rather than a disabled `later`. `{}` counts: it is a
   *  MEASUREMENT (a Claude run that invoked no skill), not an absence. */
  readonly hasSkillData: boolean
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
  /**
   * The same counts/guardrails the global shell's `<Sidebar>` shows (M14 Task 8/10 controller
   * ruling, carried to this route): `/w/:id/graph` already streams this workspace, so `GraphClient`
   * publishes these to `hooks/useShellFacts.ts` rather than the sidebar opening a second
   * `EventSource` against `/api/w/:id/shell` for the workspace already on screen. Same field, same
   * builder and same idiom as `TasksSnapshot.shellFacts`.
   */
  readonly shellFacts: ShellFacts
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

/** The drawer's event tail (design README "1b — Drawer": "recent events"). Eight lines is what the
 *  352px column holds without becoming a transcript -- the full history is the Activity page. */
const DRAWER_EVENTS_LIMIT = 8

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

/**
 * The drawer's checkpoint list for one live run.
 *
 * A run carries at most ONE `Checkpoint` row (`@unique` on `runId`) -- the last resumable point --
 * so this is never a long history: the checkpoint that exists is `done`, and where the run has
 * since moved past it, the step it is on now is `current`. A run with no checkpoint row yet has
 * only its current step. There is no `pending` line to write, because nothing in the schema says
 * where the NEXT checkpoint will fall; `pending` stays in the type (and in the drawer's glyph
 * table) for the planned-steps list a later milestone can fill without changing this shape.
 */
function checkpointsFor(
  run: { readonly toolCalls: number; readonly checkpoint: { readonly numTurns: number } | null } | null,
): readonly GraphCheckpoint[] {
  if (run === null) return []
  const lines: GraphCheckpoint[] = []
  if (run.checkpoint !== null) lines.push({ label: `checkpoint at step ${run.checkpoint.numTurns}`, state: 'done' })
  lines.push({ label: `step ${run.toolCalls}`, state: 'current' })
  return lines
}

export async function buildGraphSnapshot(workspaceId: string): Promise<GraphSnapshot | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  const teams = await prisma.team.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } })

  const agents = await prisma.agent.findMany({
    where: { team: { workspaceId } },
    orderBy: { name: 'asc' },
  })
  const agentIds = agents.map((agent) => agent.id)

  // One live run per agent at most (the scheduler enforces it); latest by startedAt breaks any
  // fixture-made tie deterministically. Mirrors `buildOverviewSnapshot`'s own wiring so the two
  // read models cannot derive "which run is this agent's live one" differently.
  //
  // `checkpoint` joins in here (M14 Task 11) because both the drawer's checkpoint list and the
  // model it displays come off that row -- `AgentRun` has no `model` column at all; the checkpoint
  // is where the model a run STARTED with is recorded, which is the one resume replays.
  const liveRuns = await prisma.agentRun.findMany({
    where: {
      agentId: { in: agentIds },
      status: { in: [...NON_TERMINAL_RUN_STATUSES] },
    },
    orderBy: { startedAt: 'desc' },
    include: { task: true, checkpoint: true },
  })
  const liveRunByAgent = new Map<string, (typeof liveRuns)[number]>()
  for (const run of liveRuns) {
    if (!liveRunByAgent.has(run.agentId)) liveRunByAgent.set(run.agentId, run)
  }

  // Whether the "Skill chain" mode is reachable at all, per agent: the MOST RECENT run of any
  // status, not just a live one -- a finished run's tally is exactly the data that mode would
  // draw. `distinct` + `orderBy` is one row per agent out of Postgres, not the agent's history.
  const latestRuns = await prisma.agentRun.findMany({
    where: { agentId: { in: agentIds } },
    orderBy: [{ agentId: 'asc' }, { startedAt: 'desc' }],
    distinct: ['agentId'],
    select: { agentId: true, skillCalls: true },
  })
  const hasSkillDataByAgent = new Map(latestRuns.map((run) => [run.agentId, run.skillCalls !== null]))

  const liveRunIds = [...liveRunByAgent.values()].map((run) => run.id)
  // One query for every live run's tail rather than one per run (the M4 review flagged per-run
  // queries as the first scaling cliff). The `take` bound is generous enough that an even spread
  // leaves each run its own eight; a single very chatty run can still crowd out a quiet one within
  // that bound -- the same accepted trade `buildOverviewSnapshot` documents for its own tail.
  const eventRows =
    liveRunIds.length === 0
      ? []
      : await prisma.executionEvent.findMany({
          where: { runId: { in: liveRunIds } },
          orderBy: { seq: 'desc' },
          take: DRAWER_EVENTS_LIMIT * liveRunIds.length,
        })
  const eventsByRun = new Map<string, GraphEvent[]>()
  for (const row of eventRows) {
    if (row.runId === null) continue
    const forRun = eventsByRun.get(row.runId)
    if (forRun !== undefined && forRun.length >= DRAWER_EVENTS_LIMIT) continue
    const domainType = DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type
    // Rows arrived newest-first and stay that way: the drawer's tail reads top-down from "just
    // now", unlike the Overview panel's feed, which reads oldest-first into a scrolled view.
    const event: GraphEvent = {
      seq: Number(row.seq),
      ts: row.ts.toISOString(),
      summary: feedSummary(domainType, row.payload as Record<string, unknown>),
    }
    if (forRun === undefined) eventsByRun.set(row.runId, [event])
    else forRun.push(event)
  }

  const [taskRows, dependencyRows, shellFacts] = await Promise.all([
    loadGraphTaskRows(workspaceId),
    prisma.taskDependency.findMany({ where: { task: { workspaceId } } }),
    buildShellFacts(workspaceId),
  ])
  // `buildShellFacts` only returns null for a workspace that does not exist, which the guard at
  // the top of this function has already ruled out -- but the type says it can, so this says what
  // happens if it ever does rather than asserting it away.
  if (shellFacts === null) return null

  return {
    workspace: { id: workspace.id, name: workspace.name, haltedReason: workspace.haltedReason },
    teams: teams.map((team) => ({ id: team.id, name: team.name })),
    shellFacts,
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
        // The run's own column first, the agent row's override second -- the same precedence
        // `resolveProvider`/`resolveModel` apply, read from the bottom of the chain up: what this
        // run actually IS beats what the worker is configured to be next time.
        provider: run?.provider ?? agent.provider ?? null,
        model: run?.checkpoint?.model ?? agent.model ?? null,
        // A workspace configured with a non-positive ceiling has no scale to measure against, and
        // 0% is the only honest reading of an undefined denominator (same rule as `overview.ts`).
        progressPct:
          run === null || workspace.maxToolCallsPerRun <= 0
            ? 0
            : Math.min(100, Math.round((run.toolCalls / workspace.maxToolCallsPerRun) * 100)),
        checkpoints: checkpointsFor(run),
        recentEvents: run === null ? [] : (eventsByRun.get(run.id) ?? []),
        hasSkillData: hasSkillDataByAgent.get(agent.id) ?? false,
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
