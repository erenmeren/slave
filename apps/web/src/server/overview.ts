import { prisma } from '@slave-of-ai/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, toRunState } from '@slave-of-ai/db'
import { capabilitiesOf, workspaceDefaultProvider, type ProviderCapabilities, type ProviderKind } from '@slave-of-ai/control'
import {
  deriveSlaveStatus,
  effectiveProfile,
  mergeQueueOrder,
  sumSpend,
  NON_TERMINAL_RUN_STATUSES,
  type SlaveStatus,
  type TaskStatus,
} from '@slave-of-ai/domain'
import { feedSummary, type SlaveFeedEvent } from '../lib/feedSummary'
import { skillNameOf } from '../lib/skillName'

// Re-exported so callers that already import from `server/overview.ts` keep working; the
// definition itself lives in the pure `lib/feedSummary.ts` module (controller ruling R3) so the
// client-side hook can import `feedSummary` without pulling `@slave-of-ai/db`'s `prisma` client
// into the browser bundle. Types are erased at build, so re-exporting the interface here costs
// nothing at runtime.
export type { SlaveFeedEvent }

/** How many of a slave's most recent events seed the panel's live feed (spec §6). */
const RECENT_EVENTS_LIMIT = 20

/** The 340px live-events panel shows the workspace's last 8 (design README §3a.1). */
const LIVE_EVENTS_LIMIT = 8

export interface SlaveCardData {
  readonly id: string
  readonly name: string
  readonly role: string
  /**
   * The runtime this slave's LIVE run resolved (M12 Task 9, ruling R10), replacing a hardcoded
   * `'claude-code'` from before `SlaveRun.provider` existed. `null` with no live run: a worker's
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
  /**
   * The persona that actually applies to this worker, and which level of the override chain it
   * came from (M37 §2, §6) -- `slave.profile ?? companySlave.profile ?? template.profile`, walked
   * once here by `@slave-of-ai/domain`'s `effectiveProfile`, the SAME function `buildRunContext`
   * walks at dispatch. One function, so the text the panel shows and the text the model is given
   * cannot drift apart; server-side, so no component ever re-derives an override chain.
   *
   * `null` when no level carries one: the run then gets no profile section at all (spec §7), and
   * the panel says so rather than showing an empty box that looks like a saved blank.
   *
   * `origin` is what makes the panel's edit honest: a `company` or `template` text is inherited,
   * and typing over it writes a `slave`-level OVERRIDE rather than editing what was shown.
   */
  readonly profile: { readonly text: string; readonly origin: 'slave' | 'company' | 'template' } | null
  /**
   * The roles this worker may be DISPATCHED as (M37 §5) -- the scheduler match, reviewer/manager
   * staffing and role-addressed messaging all read this set, and `role` above is now only the
   * profile's title.
   *
   * An empty array is a real state, not missing data: it means the worker is parked and can never
   * be picked (spec §7), which is why the card and the panel render it as a warning instead of an
   * absent chip row.
   */
  readonly runtimeRoles: readonly string[]
  readonly status: SlaveStatus
  readonly taskTitle: string | null
  /** The live run's task id — the card renders `TASK-<first 8 chars>` from it (the handoff's mono
   *  task reference). `null` with no live run or a task-less `planning` run (M8b). */
  readonly taskId: string | null
  /** The live run's task status, feeding `lib/tones.ts`'s `cardStateFor` so the card can reach
   *  `blocked`/`review`/`completed` — three states `SlaveStatus` alone cannot express. */
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
   * parser never sees a `Skill` tool (Cursor). A LIVE fact, distinct from `SlaveRun.skillCalls`
   * (M14 §4.1), which is an end-of-run tally and does not exist while the run is in flight.
   */
  readonly skill: string | null
  readonly actionLine: string | null
  readonly runId: string | null
  /** The instruction queued for this slave's live run, consumed on resume (Checkpoint semantics). */
  readonly queuedMessage: string | null
  /** Set once a resume intent has been recorded for this run (`requestResume`), cleared the moment
   *  the daemon or CLI claims it (`claimResume`) — the panel's own visible record that the click
   *  landed while the run is still `paused` (spec §3.3). */
  readonly resumeRequestedAt: string | null
  /** Last 20 execution events for this slave, oldest first — seeds the panel's live feed. */
  readonly recentEvents: readonly SlaveFeedEvent[]
  /**
   * The live run's spend so far. Panel's current-run block (spec §6).
   *
   * Two reachable states, and `number` could only say one of them (M12 Task 9, ruling R3):
   *
   * - `0` -- there is no live run. An absent run has spent nothing; this is the same statement
   *   `toolCalls: 0` makes beside it about the same absent object, and Decision 6 governs
   *   unmeasured RUNS, of which there is none here.
   * - `null` -- there is a live run and no cost is recorded for it. Rendered as `—`, the mark
   *   `AllSlavesTable`/`CompanyManager` already use, never `$0.00`.
   *
   * A positive figure is NOT reachable on this field, and saying so is the point of this
   * paragraph: `run` here is a NON-TERMINAL run, and `pump.ts` writes `SlaveRun.costUsd` only in
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
  /**
   * Non-null exactly when this slave's live run is `paused` with `SlaveRun.pauseReason =
   * waiting_for_answer` (M36 t2) — it asked another slave a question and stopped.
   *
   * One field, doing two jobs on purpose. A waiting run is `paused` like every operator pause, so
   * every surface that gates a resume button, a "paused at step N" line or a writable message box
   * on `status === 'paused'` alone would present it as a human pause and invite an operator to
   * resume a slave whose question nobody has answered. Non-null IS that discriminator, and it
   * carries what the waiting affordance needs so the panel does not have to ask a second question
   * to render one.
   *
   * `recipient` is already display text (a slave's name, or the role the question was broadcast
   * to) — the recipient is always in this workspace, so it is resolved from the roster this
   * snapshot already loaded rather than a second query. `question` is the body of the LATEST
   * question this run sent, or `null` in the one case the run says it is waiting and no message
   * row can be found for it.
   */
  readonly waitingFor: {
    readonly recipient: string
    readonly question: string | null
    /**
     * The question's own `SlaveMessage` id (M36 t3 fix round 1) -- what the panel POSTs an answer
     * against. `null` when the row is gone (or was never found), which is also the one case the
     * panel must fall back to a plain resume: there is no question to reply to.
     */
    readonly messageId: string | null
  } | null
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
    /** M33 §4: the run this project's organisation was adopted from, or `null` for a workspace
     *  assigned by hand. The overview's own note (`ws-adopted-from`) links back to it. */
    readonly adoptedFrom: { readonly simulationId: string; readonly name: string } | null
  }
  readonly slaves: readonly SlaveCardData[]
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
// `waiting` (M36 t2) counts as active: a task whose slave is waiting for another slave's answer is
// in flight, not parked for a human -- a workspace whose in-flight tasks are all waiting must not
// read "0 active". `org.ts` and `shell.ts` carry the same list and were widened with it.
const ACTIVE_TASK_STATUSES = ['ready', 'running', 'verifying', 'reviewing', 'merging', 'rework', 'waiting'] as const

export async function buildOverviewSnapshot(workspaceId: string): Promise<OverviewSnapshot | null> {
  // M33 §4: `adoptedFromSimulation` is read here, in the one existing workspace query, rather than
  // a second round trip -- the same reason every other field on `workspace` below comes off this
  // one row.
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { adoptedFromSimulation: { select: { id: true, name: true } } } })
  if (workspace === null) return null

  // The one tested rule, not a copy of it (fix round 1, Important finding 1): ONE
  // `ProviderConfiguration` row is a default, none is "nothing configured", and more than one is
  // ALSO null -- the table has no "this one is the default" column, so picking one would be an
  // arbitrary choice dressed up as a default. `workspaceDefaultProvider` issues exactly the same
  // single query this used to inline, so there is nothing to save by restating it here, and a
  // second copy of the two-row branch is how the surface and dispatch drift apart.
  const provider = await workspaceDefaultProvider(workspaceId)

  const slaves = await prisma.slave.findMany({
    where: { team: { workspaceId } },
    orderBy: { name: 'asc' },
    // The roster/template legs of the profile override chain (M37 t4), included rather than
    // queried per worker: `effectiveProfile` needs both levels below the worker's own column, and
    // a second round trip per row is how a roster of thirty becomes thirty-one queries.
    include: { companySlave: { select: { profile: true, template: { select: { profile: true } } } } },
  })

  // One live run per slave at most (the scheduler enforces it); latest by startedAt breaks any
  // fixture-made tie deterministically.
  const liveRuns = await prisma.slaveRun.findMany({
    where: {
      slaveId: { in: slaves.map((a) => a.id) },
      status: { in: [...NON_TERMINAL_RUN_STATUSES] },
    },
    orderBy: { startedAt: 'desc' },
    include: { task: true },
  })
  const liveRunBySlave = new Map<string, (typeof liveRuns)[number]>()
  for (const run of liveRuns) {
    if (!liveRunBySlave.has(run.slaveId)) liveRunBySlave.set(run.slaveId, run)
  }

  // Initial action lines: the latest run.tool_call per live run, so a freshly opened page is not
  // blank until the next event. DB enum value is `run_tool_call`.
  const lines = new Map<string, string>()
  for (const run of liveRunBySlave.values()) {
    const event = await prisma.executionEvent.findFirst({
      where: { runId: run.id, type: 'run_tool_call' },
      orderBy: { seq: 'desc' },
    })
    if (event !== null) {
      const summary = (event.payload as { summary?: string }).summary
      if (typeof summary === 'string') lines.set(run.slaveId, summary)
    }
  }

  // The waiting affordance (M36 t2): what each waiting run asked, and of whom. One query for every
  // waiting run in the workspace -- usually none -- rather than one per run, and no query at all
  // when nothing is waiting.
  const waitingRunIds = [...liveRunBySlave.values()]
    .filter((run) => run.status === 'paused' && run.pauseReason === 'waiting_for_answer')
    .map((run) => run.id)
  const waitingFor = new Map<
    string,
    { readonly recipient: string; readonly question: string | null; readonly messageId: string | null }
  >()
  if (waitingRunIds.length > 0) {
    const nameById = new Map(slaves.map((slave) => [slave.id, slave.name]))
    const questions = await prisma.slaveMessage.findMany({
      where: { senderRunId: { in: waitingRunIds }, kind: 'question' },
      orderBy: { seq: 'desc' },
    })
    for (const message of questions) {
      // Descending `seq`, so the first row seen for a run is its latest question; a run that asked,
      // was answered, resumed and asked again is waiting on the second one.
      if (message.senderRunId === null || waitingFor.has(message.senderRunId)) continue
      waitingFor.set(message.senderRunId, {
        recipient:
          message.recipientSlaveId !== null
            ? // A named recipient is always in this workspace (`sendMessage` refuses any other), so
              // the roster above resolves it; the id is the honest fallback if a slave was deleted.
              (nameById.get(message.recipientSlaveId) ?? message.recipientSlaveId)
            : `anyone with the ${message.recipientRole ?? 'unknown'} role`,
        question: message.body,
        messageId: message.id,
      })
    }
  }

  // The card's skill chip: the latest `Skill` tool call on this run.
  //
  // COST, stated plainly: this is a second `findFirst` per LIVE run, in the loop that already
  // issues one — two per live run, not one. The `(runId, seq)` index landed in M18 (migration
  // 20260831190100) and serves the per-run read; the remaining cost is the type/payload filter
  // (the functional-index follow-up is M19 backlog).
  const skills = new Map<string, string>()
  for (const run of liveRunBySlave.values()) {
    const event = await prisma.executionEvent.findFirst({
      where: { runId: run.id, type: 'run_tool_call', payload: { path: ['name'], equals: 'Skill' } },
      orderBy: { seq: 'desc' },
    })
    if (event !== null) {
      const skill = skillNameOf((event.payload as { summary?: unknown }).summary)
      if (skill !== null) skills.set(run.slaveId, skill)
    }
  }

  // One query for every slave's recent events, not one per slave (the M4 review flagged
  // per-run queries as the first scaling cliff). `take` is generous enough that an even spread of
  // activity across slaves leaves each with its own last 20; a single very chatty slave can still
  // crowd out a quiet one within this bound — accepted for M5, the brief's own reference query.
  const recentEventRows = await prisma.executionEvent.findMany({
    where: { slaveId: { in: slaves.map((a) => a.id) } },
    orderBy: { seq: 'desc' },
    take: RECENT_EVENTS_LIMIT * slaves.length,
  })
  const recentEventsBySlave = new Map<string, SlaveFeedEvent[]>()
  for (const row of recentEventRows) {
    if (row.slaveId === null) continue
    const forSlave = recentEventsBySlave.get(row.slaveId)
    if (forSlave !== undefined && forSlave.length >= RECENT_EVENTS_LIMIT) continue
    const domainType = DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type
    const feedEvent: SlaveFeedEvent = {
      seq: Number(row.seq),
      ts: row.ts.toISOString(),
      type: domainType,
      summary: feedSummary(domainType, row.payload as Record<string, unknown>),
    }
    if (forSlave === undefined) recentEventsBySlave.set(row.slaveId, [feedEvent])
    else forSlave.push(feedEvent)
  }
  // Rows arrived newest-first (capped per slave while iterating that order); the panel wants
  // oldest-first, newest at the bottom.
  for (const events of recentEventsBySlave.values()) events.reverse()

  // `slave: { team: { workspaceId } }`, not `task: { workspaceId }`: a `planning` run (M8b) has no
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
    prisma.slaveRun.findMany({
      where: { slave: { team: { workspaceId } } },
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
    prisma.slaveRun.findMany({
      where: {
        slave: { team: { workspaceId } },
        status: { in: ['pause_requested', 'paused'] },
        // M36 t2: a run waiting for another slave's answer is `paused` -- the same status an
        // operator's pause lands in, and the reason `SlaveRun.pauseReason` carries the CATEGORY --
        // but it does not need a human. Listing it under "needs you" with a resume button would
        // invite an operator to continue a slave whose question has not been answered yet, and
        // would report the fleet as blocked on people when it is waiting on itself. Written as an
        // explicit two-arm OR rather than `{ not: 'waiting_for_answer' }` so the rows with NO
        // pause reason at all (a gate-deny pause nobody requested) are unambiguously kept.
        OR: [{ pauseReason: null }, { pauseReason: { not: 'waiting_for_answer' } }],
      },
      orderBy: { startedAt: 'asc' },
      include: { slave: true },
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
      title: run.slave.name,
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
      // safe here and unsafe in a client component -- `@slave-of-ai/providers`'s barrel imports
      // `node:child_process` at module scope, which is why `ProviderSelect.tsx` carries its own
      // compiler-guarded mirror of `PROVIDER_KINDS` rather than importing the list. The client gets
      // a boolean and needs no table at all.
      costBlindBudgeted: provider !== null && workspace.budgetUsd !== null && !capabilitiesOf(provider).reportsCost,
      maxConcurrentRuns: workspace.maxConcurrentRuns,
      runTimeoutMs: workspace.runTimeoutMs,
      maxAttempts: workspace.maxAttempts,
      adoptedFrom: workspace.adoptedFromSimulation === null ? null : { simulationId: workspace.adoptedFromSimulation.id, name: workspace.adoptedFromSimulation.name },
    },
    slaves: slaves.map((slave) => {
      const run = liveRunBySlave.get(slave.id) ?? null
      return {
        id: slave.id,
        name: slave.name,
        role: slave.role,
        // Walked by the domain's own function, not restated here (M37 t4): this is the same call
        // `buildRunContext` makes, so what the panel shows is what the next dispatch will send.
        profile: effectiveProfile(slave),
        runtimeRoles: slave.runtimeRoles,
        // The run's own column, not a constant (M12 Task 9, ruling R10). `SlaveRun.provider` has
        // been written by every dispatch since Task 8, so the surface finally has real data where
        // it used to have `'claude-code' as const` -- which was not even the `ProviderKind`
        // spelling, but `ClaudeCodeAdapter.id`.
        provider: run?.provider ?? null,
        gate: run === null || run.provider === null ? null : capabilitiesOf(run.provider).gate,
        status: deriveSlaveStatus(run === null ? null : toRunState(run)),
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
        skill: skills.get(slave.id) ?? null,
        actionLine: lines.get(slave.id) ?? null,
        runId: run?.id ?? null,
        queuedMessage: run?.queuedMessage ?? null,
        resumeRequestedAt: run?.resumeRequestedAt?.toISOString() ?? null,
        recentEvents: recentEventsBySlave.get(slave.id) ?? [],
        // `run === null ? 0 : run.costUsd`, not `run?.costUsd ?? 0` (M12 Task 9, ruling R3). The
        // coalesce collapsed two different facts into one number: "no live run" (nothing has been
        // spent, a measured zero, the same claim `toolCalls: 0` makes on the next line) and "a
        // live run whose runtime reports no spend" (unknown, which Decision 6 forbids showing as
        // $0.00). Only the second becomes null.
        costUsd: run === null ? 0 : run.costUsd,
        toolCalls: run?.toolCalls ?? 0,
        pausedAtStep: run?.pausedAtStep ?? null,
        // Derived from the RUN's own pause category, not from the message lookup: the run saying
        // it is waiting is the fact, and a missing message row must not silently turn a waiting
        // slave back into an ordinary paused one on every surface that reads this field.
        waitingFor:
          run !== null && run.status === 'paused' && run.pauseReason === 'waiting_for_answer'
            ? (waitingFor.get(run.id) ?? { recipient: 'another slave', question: null, messageId: null })
            : null,
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
