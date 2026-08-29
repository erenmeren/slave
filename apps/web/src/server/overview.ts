import { prisma } from '@ai-team-os/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, toRunState } from '@ai-team-os/db'
import { capabilitiesOf, workspaceDefaultProvider, type ProviderCapabilities, type ProviderKind } from '@ai-team-os/control'
import { deriveAgentStatus, sumSpend, NON_TERMINAL_RUN_STATUSES, type AgentStatus } from '@ai-team-os/domain'
import { feedSummary, type AgentFeedEvent } from '../lib/feedSummary'
import { bucketSparkline } from './activity'

// Re-exported so callers that already import from `server/overview.ts` keep working; the
// definition itself lives in the pure `lib/feedSummary.ts` module (controller ruling R3) so the
// client-side hook can import `feedSummary` without pulling `@ai-team-os/db`'s `prisma` client
// into the browser bundle. Types are erased at build, so re-exporting the interface here costs
// nothing at runtime.
export type { AgentFeedEvent }

/** How many of an agent's most recent events seed the panel's live feed (spec §6). */
const RECENT_EVENTS_LIMIT = 20

export interface AgentCardData {
  readonly id: string
  readonly name: string
  readonly role: string
  /**
   * The runtime this agent's LIVE run resolved (M12 Task 9, ruling R10), replacing a hardcoded
   * `'claude-code'` from before `AgentRun.provider` existed. `null` with no live run: a worker's
   * runtime is not decided until a run resolves it -- the override chain crosses four levels and
   * a workspace default, and naming one here in advance would be a guess the surface presents as
   * a fact. Note the spelling: `'claude_code'` is the `ProviderKind`, `'claude-code'` was the
   * ADAPTER ID this field used to carry.
   */
  readonly provider: ProviderKind | null
  /**
   * `capabilitiesOf(provider).gate`, or `null` when `provider` itself is `null` (M12 Task 13 fix
   * round 1, spec §8 / finding 4a: "wherever a worker's runtime is shown, a provider whose gate
   * is shell-only is marked as such"). Derived HERE, server-side, the same way `server/org.ts`'s
   * `listRoster` derives a worker's gate -- one capability table, never recomputed per renderer.
   */
  readonly gate: ProviderCapabilities['gate'] | null
  readonly status: AgentStatus
  readonly taskTitle: string | null
  readonly actionLine: string | null
  readonly runId: string | null
  /** The instruction queued for this agent's live run, consumed on resume (Checkpoint semantics). */
  readonly queuedMessage: string | null
  /** Set once a resume intent has been recorded for this run (`requestResume`), cleared the moment
   *  the daemon or CLI claims it (`claimResume`) — the panel's own visible record that the click
   *  landed while the run is still `paused` (spec §3.3). */
  readonly resumeRequestedAt: string | null
  /** Last 20 execution events for this agent, oldest first — seeds the panel's live feed. */
  readonly recentEvents: readonly AgentFeedEvent[]
  /** This agent's `run.tool_call` counts for the last 10 minutes, one bucket per minute, oldest
   *  minute first, zero-filled. */
  readonly sparkline: readonly number[]
  /**
   * The live run's spend so far. Panel's current-run block (spec §6).
   *
   * Two reachable states, and `number` could only say one of them (M12 Task 9, ruling R3):
   *
   * - `0` -- there is no live run. An absent run has spent nothing; this is the same statement
   *   `toolCalls: 0` makes beside it about the same absent object, and Decision 6 governs
   *   unmeasured RUNS, of which there is none here.
   * - `null` -- there is a live run and no cost is recorded for it. Rendered as `—`, the mark
   *   `RosterTable`/`CompanyManager` already use, never `$0.00`.
   *
   * A positive figure is NOT reachable on this field, and saying so is the point of this
   * paragraph: `run` here is a NON-TERMINAL run, and `pump.ts` writes `AgentRun.costUsd` only in
   * the same statement that makes a run terminal. So a live run's cost is always null today. The
   * field is nullable because that is what it means, not because a figure is expected -- and if a
   * later task starts writing cost mid-run, this comment is what tells the next reader that the
   * third state has become reachable rather than leaving them to wonder why it never fires.
   */
  readonly costUsd: number | null
  /** The live run's tool call count so far; 0 with no live run. */
  readonly toolCalls: number
  /** Set only while a checkpoint exists to resume from — null outside `paused`. */
  readonly pausedAtStep: number | null
}

export interface OverviewSnapshot {
  readonly workspace: {
    readonly id: string
    readonly name: string
    readonly haltedReason: string | null
    readonly haltedAt: string | null
    /**
     * The spend ceiling, or `null` for a workspace that is not budgeted at all (M12 Task 9) --
     * spec §6's only state in which a runtime that cannot report cost may run. Rendered by
     * `TopBar` as known spend with no ratio and no bar, never as a budget of zero.
     */
    readonly budgetUsd: number | null
    /** KNOWN spend: every run that reported a cost, summed. Never includes a guess. */
    readonly spentUsd: number
    /**
     * How many of this workspace's runs actually ran, finished, and left no cost figure behind
     * (M12 Task 9, ruling R11; corrected in fix round F1). Rendered beside the budget bar, because
     * `spentUsd` alone reads as total spend and is only the measured part of it whenever this is
     * non-zero.
     *
     * NOT the count of null `costUsd` columns: a run in flight is unfinished rather than
     * unmeasured, and a run that never spawned spent nothing. `sumSpend` holds the rule and the
     * column facts behind it.
     */
    readonly unmeasuredRuns: number
    readonly goal: string | null
    /** The workspace's configured default runtime, or `null` for "nothing configured" (M13 §6.3). */
    readonly provider: ProviderKind | null
    /**
     * `true` when the configured provider cannot report cost AND a budget is set -- the
     * combination `admitRun` refuses at dispatch with `a budget needs a provider that reports
     * cost`. Derived HERE with `capabilitiesOf` and shipped as a plain boolean, so the client
     * never needs the capability table (spec §6.3).
     */
    readonly costBlindBudgeted: boolean
  }
  readonly agents: readonly AgentCardData[]
  readonly tasks: { readonly active: number; readonly blocked: number; readonly done: number; readonly failed: number }
}

// A task under review or in the merge queue is still active work, not a vanished one — widened
// (M8a Task 12) from the M5-era four to also cover `reviewing`/`merging`, the two verify-passed
// states that sit between a run finishing and the task landing on `main`.
const ACTIVE_TASK_STATUSES = ['ready', 'running', 'verifying', 'reviewing', 'merging', 'rework'] as const

export async function buildOverviewSnapshot(workspaceId: string): Promise<OverviewSnapshot | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  // The one tested rule, not a copy of it (fix round 1, Important finding 1): ONE
  // `ProviderConfiguration` row is a default, none is "nothing configured", and more than one is
  // ALSO null -- the table has no "this one is the default" column, so picking one would be an
  // arbitrary choice dressed up as a default. `workspaceDefaultProvider` issues exactly the same
  // single query this used to inline, so there is nothing to save by restating it here, and a
  // second copy of the two-row branch is how the surface and dispatch drift apart.
  const provider = await workspaceDefaultProvider(workspaceId)

  const agents = await prisma.agent.findMany({
    where: { team: { workspaceId } },
    orderBy: { name: 'asc' },
  })

  // One live run per agent at most (the scheduler enforces it); latest by startedAt breaks any
  // fixture-made tie deterministically.
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

  // Initial action lines: the latest run.tool_call per live run, so a freshly opened page is not
  // blank until the next event. DB enum value is `run_tool_call`.
  const lines = new Map<string, string>()
  for (const run of liveRunByAgent.values()) {
    const event = await prisma.executionEvent.findFirst({
      where: { runId: run.id, type: 'run_tool_call' },
      orderBy: { seq: 'desc' },
    })
    if (event !== null) {
      const summary = (event.payload as { summary?: string }).summary
      if (typeof summary === 'string') lines.set(run.agentId, summary)
    }
  }

  // One query for every agent's recent events, not one per agent (the M4 review flagged
  // per-run queries as the first scaling cliff). `take` is generous enough that an even spread of
  // activity across agents leaves each with its own last 20; a single very chatty agent can still
  // crowd out a quiet one within this bound — accepted for M5, the brief's own reference query.
  const recentEventRows = await prisma.executionEvent.findMany({
    where: { agentId: { in: agents.map((a) => a.id) } },
    orderBy: { seq: 'desc' },
    take: RECENT_EVENTS_LIMIT * agents.length,
  })
  const recentEventsByAgent = new Map<string, AgentFeedEvent[]>()
  for (const row of recentEventRows) {
    if (row.agentId === null) continue
    const forAgent = recentEventsByAgent.get(row.agentId)
    if (forAgent !== undefined && forAgent.length >= RECENT_EVENTS_LIMIT) continue
    const domainType = DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type
    const feedEvent: AgentFeedEvent = {
      seq: Number(row.seq),
      ts: row.ts.toISOString(),
      type: domainType,
      summary: feedSummary(domainType, row.payload as Record<string, unknown>),
    }
    if (forAgent === undefined) recentEventsByAgent.set(row.agentId, [feedEvent])
    else forAgent.push(feedEvent)
  }
  // Rows arrived newest-first (capped per agent while iterating that order); the panel wants
  // oldest-first, newest at the bottom.
  for (const events of recentEventsByAgent.values()) events.reverse()

  // One grouped query for every agent's sparkline, not one per agent. The DB enum's stored value
  // is dotted (`'run.tool_call'`, confirmed against the schema and the test database — see
  // `toolCallSparkline` in `server/activity.ts`), not the Prisma member name `run_tool_call`.
  const sparklineNow = new Date()
  const sparklineRows = await prisma.$queryRaw<Array<{ agent_id: string | null; minute: Date; n: bigint }>>`
    SELECT "agentId" as agent_id, date_trunc('minute', ts) as minute, count(*) as n
    FROM "ExecutionEvent"
    WHERE "workspaceId" = ${workspaceId} AND type = 'run.tool_call'::"EventType"
      AND ts >= now() - interval '10 minutes'
    GROUP BY 1, 2`
  const sparklineRowsByAgent = new Map<string, Array<{ minute: Date; n: bigint }>>()
  for (const row of sparklineRows) {
    if (row.agent_id === null) continue
    const forAgent = sparklineRowsByAgent.get(row.agent_id)
    if (forAgent === undefined) sparklineRowsByAgent.set(row.agent_id, [row])
    else forAgent.push(row)
  }

  // `agent: { team: { workspaceId } }`, not `task: { workspaceId }`: a `planning` run (M8b) has no
  // `Task` row, and its cost still counts toward the budget shown here.
  // Rows rather than a `_sum` (M12 Task 9, ruling R3): an aggregate can only return a number, and
  // a number cannot also say how many of the rows behind it reported nothing. `world.ts`'s budget
  // guardrail keeps its `_sum`, because ruling R8 keeps the count out of the guardrail and it
  // would pay for the transfer to discard it (fix round F3).
  //
  // `provider` and `status` are selected because they are what tells an unmeasured run from a null
  // cost -- `sumSpend`'s docstring carries the full reasoning and the column facts behind it.
  // Selected rather than filtered in SQL, deliberately: a pre-M12 row has a real recorded cost and
  // a null `provider`, so a `WHERE` would take its money out of `spentUsd` in order to fix the
  // count beside it.
  const [spendRows, taskGroups] = await Promise.all([
    prisma.agentRun.findMany({
      where: { agent: { team: { workspaceId } } },
      select: { costUsd: true, provider: true, status: true },
    }),
    prisma.task.groupBy({ by: ['status'], where: { workspaceId }, _count: { _all: true } }),
  ])
  const spend = sumSpend(spendRows)
  const countOf = (statuses: readonly string[]): number =>
    taskGroups.filter((g) => statuses.includes(g.status)).reduce((n, g) => n + g._count._all, 0)

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      haltedReason: workspace.haltedReason,
      haltedAt: workspace.haltedAt?.toISOString() ?? null,
      budgetUsd: workspace.budgetUsd,
      spentUsd: spend.known,
      unmeasuredRuns: spend.unknownRuns,
      goal: workspace.goal,
      provider,
      // The warning the Runtime card shows, derived SERVER-side (spec §6.3): `capabilitiesOf` is
      // safe here and unsafe in a client component -- `@ai-team-os/providers`'s barrel imports
      // `node:child_process` at module scope, which is why `ProviderSelect.tsx` carries its own
      // compiler-guarded mirror of `PROVIDER_KINDS` rather than importing the list. The client gets
      // a boolean and needs no table at all.
      costBlindBudgeted: provider !== null && workspace.budgetUsd !== null && !capabilitiesOf(provider).reportsCost,
    },
    agents: agents.map((agent) => {
      const run = liveRunByAgent.get(agent.id) ?? null
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        // The run's own column, not a constant (M12 Task 9, ruling R10). `AgentRun.provider` has
        // been written by every dispatch since Task 8, so the surface finally has real data where
        // it used to have `'claude-code' as const` -- which was not even the `ProviderKind`
        // spelling, but `ClaudeCodeAdapter.id`.
        provider: run?.provider ?? null,
        gate: run === null || run.provider === null ? null : capabilitiesOf(run.provider).gate,
        status: deriveAgentStatus(run === null ? null : toRunState(run)),
        taskTitle: run?.task?.title ?? null,
        actionLine: lines.get(agent.id) ?? null,
        runId: run?.id ?? null,
        queuedMessage: run?.queuedMessage ?? null,
        resumeRequestedAt: run?.resumeRequestedAt?.toISOString() ?? null,
        recentEvents: recentEventsByAgent.get(agent.id) ?? [],
        sparkline: bucketSparkline(sparklineRowsByAgent.get(agent.id) ?? [], sparklineNow),
        // `run === null ? 0 : run.costUsd`, not `run?.costUsd ?? 0` (M12 Task 9, ruling R3). The
        // coalesce collapsed two different facts into one number: "no live run" (nothing has been
        // spent, a measured zero, the same claim `toolCalls: 0` makes on the next line) and "a
        // live run whose runtime reports no spend" (unknown, which Decision 6 forbids showing as
        // $0.00). Only the second becomes null.
        costUsd: run === null ? 0 : run.costUsd,
        toolCalls: run?.toolCalls ?? 0,
        pausedAtStep: run?.pausedAtStep ?? null,
      }
    }),
    tasks: {
      active: countOf([...ACTIVE_TASK_STATUSES]),
      blocked: countOf(['blocked']),
      done: countOf(['done']),
      failed: countOf(['failed']),
    },
  }
}
