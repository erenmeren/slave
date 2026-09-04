import { prisma } from '@ai-team-os/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, toRunState } from '@ai-team-os/db'
import { capabilitiesOf, workspaceDefaultProvider, type ProviderCapabilities, type ProviderKind } from '@ai-team-os/control'
import {
  deriveAgentStatus,
  mergeQueueOrder,
  sumSpend,
  NON_TERMINAL_RUN_STATUSES,
  type AgentStatus,
  type TaskStatus,
} from '@ai-team-os/domain'
import { feedSummary, type AgentFeedEvent } from '../lib/feedSummary'
import { skillNameOf } from '../lib/skillName'

// Re-exported so callers that already import from `server/overview.ts` keep working; the
// definition itself lives in the pure `lib/feedSummary.ts` module (controller ruling R3) so the
// client-side hook can import `feedSummary` without pulling `@ai-team-os/db`'s `prisma` client
// into the browser bundle. Types are erased at build, so re-exporting the interface here costs
// nothing at runtime.
export type { AgentFeedEvent }

/** How many of an agent's most recent events seed the panel's live feed (spec §6). */
const RECENT_EVENTS_LIMIT = 20

/** The 340px live-events panel shows the workspace's last 8 (design README §3a.1). */
const LIVE_EVENTS_LIMIT = 8

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
  /** The live run's task id — the card renders `TASK-<first 8 chars>` from it (the handoff's mono
   *  task reference). `null` with no live run or a task-less `planning` run (M8b). */
  readonly taskId: string | null
  /** The live run's task status, feeding `lib/tones.ts`'s `cardStateFor` so the card can reach
   *  `blocked`/`review`/`completed` — three states `AgentStatus` alone cannot express. */
  readonly taskStatus: TaskStatus | null
  /**
   * The run's progress as a percentage of the workspace's own tool-call ceiling
   * (`Workspace.maxToolCallsPerRun`, the limit `sweep.ts` enforces), clamped to [0,100]. `0` with
   * no live run: an absent run has made no progress, the same measured zero `toolCalls: 0` makes
   * beside it. NOT null-able: there is no "unknown progress" state — the ceiling is a column and
   * the count is a column.
   */
  readonly progressPct: number
  /** `"<toolCalls>/<maxToolCallsPerRun>"`, or `null` with no live run (rendered `—`). */
  readonly stepLabel: string | null
  /**
   * The skill this run most recently invoked — the `summary` of its latest `run.tool_call` event
   * whose payload `name` is `Skill`. `null` when the run has invoked none, or on a runtime whose
   * parser never sees a `Skill` tool (Cursor). A LIVE fact, distinct from `AgentRun.skillCalls`
   * (M14 §4.1), which is an end-of-run tally and does not exist while the run is in flight.
   */
  readonly skill: string | null
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
  /**
   * The live run's spend so far. Panel's current-run block (spec §6).
   *
   * Two reachable states, and `number` could only say one of them (M12 Task 9, ruling R3):
   *
   * - `0` -- there is no live run. An absent run has spent nothing; this is the same statement
   *   `toolCalls: 0` makes beside it about the same absent object, and Decision 6 governs
   *   unmeasured RUNS, of which there is none here.
   * - `null` -- there is a live run and no cost is recorded for it. Rendered as `—`, the mark
   *   `AllAgentsTable`/`CompanyManager` already use, never `$0.00`.
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
     * `ProjectHeader` as known spend with no ratio and no bar, never as a budget of zero.
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
    /**
     * The three guardrail columns (M14 Task 8, the `ShellFactsContext` half of the controller
     * ruling carried from Task 3). After M24 the sidebar reads nothing per-project at all -- these
     * columns instead feed the project header and the Tasks tab's badge, via
     * `OverviewClient`'s `publishShellFacts` call (`hooks/useShellFacts.ts`).
     *
     * They are here so the Overview page can PROVIDE those facts out of the stream it already
     * runs, instead of the header opening a second `EventSource` per workspace page. Every other
     * workspace page (Tasks, Graph, Activity, and -- with no stream of its own -- the Settings
     * tab) now provides its own copy the same way, off `server/shell.ts`'s `buildShellFacts`:
     * the same four columns read once per page, not a second source of truth.
     */
    readonly maxConcurrentRuns: number
    readonly runTimeoutMs: number
    readonly maxAttempts: number
  }
  readonly agents: readonly AgentCardData[]
  readonly tasks: {
    readonly active: number
    /** Its own tile in the handoff's 6-up strip (M14 Task 8), as well as part of `active`. */
    readonly ready: number
    readonly blocked: number
    readonly done: number
    readonly failed: number
  }
  /**
   * The "blocked · needs you" panel's contents: blocked tasks, plus every run whose status is
   * `pause_requested` or `paused` (an operator asked and the answer has not landed, or it has and
   * nobody resumed). Each carries the action an operator can take from this panel.
   */
  readonly blocked: readonly {
    readonly kind: 'task' | 'run'
    readonly id: string
    readonly title: string
    readonly detail: string
    /** `'resume'` for a paused run, `null` for anything the panel can only report. */
    readonly action: 'resume' | null
    /** Set only when `action` is non-null. */
    readonly runId: string | null
  }[]
  /** The last 8 events in this workspace, newest first -- the 340px live-events panel. */
  readonly liveEvents: readonly { readonly seq: number; readonly ts: string; readonly summary: string }[]
  /**
   * Tasks in `merging`, in the order `apps/orchestrator/src/merge.ts` will actually process them.
   * At most one is really merging (the queue is serialized); the rest are waiting.
   */
  readonly mergeQueue: readonly {
    readonly id: string
    readonly title: string
    /**
     * `false` for a `merging` task with no `task.review_approved` event -- one an operator moved
     * by hand. `merge.ts` FILTERS such a task out of its candidate list, so it will never be
     * picked up; the panel lists it last and marks it, because a task stuck in the queue forever
     * is precisely what an operator opened the panel to find.
     */
    readonly hasApproval: boolean
  }[]
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

  // The card's skill chip: the latest `Skill` tool call on this run.
  //
  // COST, stated plainly: this is a second `findFirst` per LIVE run, in the loop that already
  // issues one — two per live run, not one. The `(runId, seq)` index landed in M18 (migration
  // 20260831190100) and serves the per-run read; the remaining cost is the type/payload filter
  // (the functional-index follow-up is M19 backlog).
  const skills = new Map<string, string>()
  for (const run of liveRunByAgent.values()) {
    const event = await prisma.executionEvent.findFirst({
      where: { runId: run.id, type: 'run_tool_call', payload: { path: ['name'], equals: 'Skill' } },
      orderBy: { seq: 'desc' },
    })
    if (event !== null) {
      const skill = skillNameOf((event.payload as { summary?: unknown }).summary)
      if (skill !== null) skills.set(run.agentId, skill)
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

  // The bottom row's three panels, in one round with everything else loaded.
  const [blockedTasks, pausedRuns, recentForPanel, mergingTasks] = await Promise.all([
    prisma.task.findMany({ where: { workspaceId, status: 'blocked' }, orderBy: { createdAt: 'asc' } }),
    prisma.agentRun.findMany({
      where: { agent: { team: { workspaceId } }, status: { in: ['pause_requested', 'paused'] } },
      orderBy: { startedAt: 'asc' },
      include: { agent: true },
    }),
    prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'desc' }, take: LIVE_EVENTS_LIMIT }),
    prisma.task.findMany({ where: { workspaceId, status: 'merging' } }),
  ])

  const blocked = [
    ...blockedTasks.map((task) => ({
      kind: 'task' as const,
      id: task.id,
      title: task.title,
      detail: task.lastRejectionReason ?? 'blocked',
      action: null,
      runId: null,
    })),
    ...pausedRuns.map((run) => ({
      kind: 'run' as const,
      id: run.id,
      title: run.agent.name,
      detail: run.status === 'paused' ? `paused at step ${run.pausedAtStep ?? 0}` : 'pause requested',
      // Only a run that has actually landed on `paused` can be resumed -- `requestResume` refuses
      // a `pause_requested` one, and offering a button that always refuses is worse than none.
      action: run.status === 'paused' ? ('resume' as const) : null,
      runId: run.status === 'paused' ? run.id : null,
    })),
  ]

  // FIFO by the LATEST `task.review_approved` event's seq -- `apps/orchestrator/src/merge.ts`'s
  // own rule (`merge.ts:105-122`), which is the source of truth for what merges next. Two things
  // this is NOT, both deliberate:
  //
  // - NOT `Approval.decidedAt`. That table exists in the schema and NOTHING writes it: the review
  //   pass records its verdict as a `task.review_approved` EVENT. Ordering by a column no row
  //   ever carries would silently degrade to the `createdAt` fallback, so the panel would claim
  //   an approval order while showing a creation order.
  // - NOT the FIRST approval. A task sent back to rework is re-approved, and `merge.ts` counts
  //   only the latest as "when it became eligible to merge NOW" -- so a re-approved task goes to
  //   the BACK of the queue. First-approval ordering would put it first and contradict the daemon.
  //
  // Ordered in JS rather than in SQL because the key lives on a related to-many row, which Prisma
  // cannot `orderBy`; `mergeQueueOrder` is the daemon's own comparator, imported rather than
  // rewritten (`packages/domain/src/merge/queue.ts`).
  const approvalEvents =
    mergingTasks.length === 0
      ? []
      : await prisma.executionEvent.findMany({
          where: { workspaceId, type: 'task_review_approved', taskId: { in: mergingTasks.map((t) => t.id) } },
          orderBy: { seq: 'asc' },
          select: { taskId: true, seq: true },
        })
  const latestApprovalSeq = new Map<string, number>()
  // Ascending order means the last write for a given task is its latest approval.
  for (const event of approvalEvents) {
    if (event.taskId !== null) latestApprovalSeq.set(event.taskId, Number(event.seq))
  }
  const taskById = new Map(mergingTasks.map((task) => [task.id, task]))
  const approvedQueue = mergeQueueOrder(
    mergingTasks
      .filter((task) => latestApprovalSeq.has(task.id))
      .map((task) => ({ taskId: task.id, enqueuedAt: latestApprovalSeq.get(task.id) as number })),
  ).map((entry) => ({ id: entry.taskId, title: taskById.get(entry.taskId)?.title ?? '', hasApproval: true }))
  // Controller ruling (b): a `merging` task the merge pass will never pick up is still LISTED --
  // last, and marked. Ordered among themselves by creation, the only time they carry.
  const unapprovedQueue = mergingTasks
    .filter((task) => !latestApprovalSeq.has(task.id))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((task) => ({ id: task.id, title: task.title, hasApproval: false }))

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
      maxConcurrentRuns: workspace.maxConcurrentRuns,
      runTimeoutMs: workspace.runTimeoutMs,
      maxAttempts: workspace.maxAttempts,
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
        taskId: run?.taskId ?? null,
        taskStatus: (run?.task?.status as TaskStatus | undefined) ?? null,
        // The ceiling is `sweep.ts`'s own, so the bar measures the run against the limit that will
        // actually stop it. A workspace configured with a non-positive ceiling has no scale to
        // measure against at all, and 0% is the only honest reading of an undefined denominator.
        progressPct:
          run === null || workspace.maxToolCallsPerRun <= 0
            ? 0
            : Math.min(100, Math.round((run.toolCalls / workspace.maxToolCallsPerRun) * 100)),
        stepLabel: run === null ? null : `${run.toolCalls}/${workspace.maxToolCallsPerRun}`,
        skill: skills.get(agent.id) ?? null,
        actionLine: lines.get(agent.id) ?? null,
        runId: run?.id ?? null,
        queuedMessage: run?.queuedMessage ?? null,
        resumeRequestedAt: run?.resumeRequestedAt?.toISOString() ?? null,
        recentEvents: recentEventsByAgent.get(agent.id) ?? [],
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
      ready: countOf(['ready']),
      blocked: countOf(['blocked']),
      done: countOf(['done']),
      failed: countOf(['failed']),
    },
    blocked,
    liveEvents: recentForPanel.map((event) => ({
      seq: Number(event.seq),
      ts: event.ts.toISOString(),
      summary: feedSummary(
        DOMAIN_EVENT_TYPE_BY_DB_VALUE[event.type] ?? event.type,
        event.payload as Record<string, unknown>,
      ),
    })),
    mergeQueue: [...approvedQueue, ...unapprovedQueue],
  }
}
