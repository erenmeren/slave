import { prisma } from '@slave-of-ai/db/client'
import {
  DOMAIN_EVENT_TYPE_BY_DB_VALUE,
  EVENT_TYPE_BY_DOMAIN_TYPE,
  toRunState,
  type DomainEventType,
} from '@slave-of-ai/db'
import { workspaceSpend, type WorkspaceSpend } from '@slave-of-ai/control'
import {
  NON_TERMINAL_RUN_STATUSES,
  RUN_UNMEASURED_CAP_USD,
  SUPERVISOR_PER_CALL_CAP_USD,
  TERMINAL,
  deriveSlaveStatus,
  estimateCostUsd,
  sumSpend,
  userSlaveStatus,
  userSupervisorStatus,
  userTaskStatus,
  type CostRow,
  type SlaveLifecycle,
  type TaskStatus,
  type UserSupervisorState,
  type UserTaskState,
} from '@slave-of-ai/domain'
import { readableEventType } from '../lib/eventLabels'
import { buildNeedsYou, type NeedsYouItem } from './needsYou'

/** How many "what changed lately" lines the brief carries (spec R1). */
const RECENT_CHANGES_LIMIT = 6

/**
 * The families a CHANGE belongs to -- what somebody did to this organisation, as opposed to what
 * its workers did with their hands. `supervisor.resolved` rather than a `supervisor.approved`,
 * which does not exist: approval is an OUTCOME on `resolved` (M45 plan erratum E25).
 *
 * `workspace.replan_started` is deliberately ABSENT while `workspace.replanned` is here: a re-plan
 * that has begun has not changed anything yet, and a six-line list that spent a line on "a re-plan
 * started" and another on what it did would say one thing twice. The start of an interpretation is
 * on the TIMELINE, where the SUPERVISOR INTERPRETATION lane shows both halves in order.
 */
const CHANGE_TYPES: readonly DomainEventType[] = [
  'workspace.goal_set',
  'workspace.plan_created',
  'workspace.replanned',
  'workspace.settings_changed',
  'workspace.company_assigned',
  'workspace.created',
  'workspace.archived',
  'workspace.restored',
  'org.changed',
  'slave.profile_changed',
  'slave.runtime_roles_changed',
  'supervisor.applied',
  'supervisor.resolved',
]

/** The three kinds of "verified", in the order a person reads them: landed, approved, passed. */
const VERIFIED_TYPES = [
  { type: 'task.integrated' as const, kind: 'integrated' as const },
  { type: 'task.review_approved' as const, kind: 'approved' as const },
  { type: 'task.verify_passed' as const, kind: 'verified' as const },
]

/** The same widened list `server/overview.ts` counts as active work (M8a Task 12, M36 t2). */
const ACTIVE_TASK_STATUSES: readonly string[] = [
  'ready',
  'running',
  'verifying',
  'reviewing',
  'merging',
  'rework',
  'waiting',
]

/**
 * The eight facts a person needs to understand a project in about ten seconds (M45 R1).
 *
 * A PROJECTION over reads that already exist: no new table, no new formula, no new autonomy. The
 * one number this is careful about is money -- `cost.spentUsd` is `workspaceSpend()`'s total, the
 * SAME figure the project header's budget bar and the Overview strip render, because a page that
 * shows two different totals for one project has taught its reader to trust neither (M24 §2.2,
 * M38 t5, and M45 plan erratum E2). `measuredUsd` and `unmeasuredCalls` are the two halves of it,
 * shown as the M32 upper-bound policy requires: an unmeasured call is named as an estimate at its
 * cap, never folded into one bare figure and never shown as $0.
 */
export interface ProjectBrief {
  readonly objective: { readonly text: string | null; readonly version: number }
  readonly supervisor: { readonly state: UserSupervisorState; readonly label: string; readonly needsYou: boolean }
  readonly work: {
    readonly working: number
    readonly verifying: number
    readonly review: number
    readonly waiting: number
    readonly done: number
  }
  readonly team: readonly {
    readonly slaveId: string
    readonly name: string
    readonly roleLabel: string
    readonly status: string
    readonly taskTitle: string | null
    /** M50 R1: why this worker is here. Replaces `company: boolean`, which was the only marker the
     *  schema carried before the column existed. */
    readonly lifecycle: SlaveLifecycle
    /** M50 R3: the engagement is over; the row is greyed and the date is one hover away. */
    readonly released: { readonly at: string; readonly reason: string } | null
  }[]
  readonly needsYou: readonly NeedsYouItem[]
  readonly latestVerified: {
    readonly taskTitle: string
    readonly kind: 'integrated' | 'approved' | 'verified'
    readonly at: string
  } | null
  /**
   * ONE total, and the two DIFFERENT holes beside it -- never one figure that adds them up.
   *
   * - `spentUsd` is `workspaceSpend()`'s total: measured run cost + measured Supervisor cost +
   *   `unmeasuredCalls` charged at `SUPERVISOR_PER_CALL_CAP_USD`.
   * - `measuredUsd` is the part of that total somebody actually reported.
   * - `unmeasuredCalls` are Supervisor model calls whose cost never came back. They ARE in
   *   `spentUsd`, at the cap -- an upper bound, shown as an estimate (M32).
   * - `unmeasuredRuns` are runs that spawned, finished, and left no figure behind. They are in NO
   *   total: nobody can name what they cost, and the guardrail does not charge for them. The same
   *   field, with the same meaning, as `OverviewSnapshot.workspace.unmeasuredRuns`.
   *
   * Adding the two together (which this field did until fix round 1) states that a run nobody
   * measured has been charged for. It has not.
   */
  readonly cost: {
    /**
     * THE GUARDRAIL'S NUMBER, unchanged: `workspaceSpend()`'s total. Every other figure on this
     * tile is a different question, and exactly one of them -- this one -- is what
     * `evaluateGuardrails` compares against the budget.
     */
    readonly spentUsd: number
    readonly measuredUsd: number
    /**
     * M51 R5, **Actual**: what a provider actually reported, summed. Identical to `measuredUsd` to
     * the cent -- it IS `runsMeasuredUsd + supervisorMeasuredUsd` -- and it is kept as its own field
     * rather than reusing the old name because the tile now names three figures and a field called
     * `measured` beside `estimated` and `upperBound` reads as a fourth (plan erratum E13: the LINE
     * `measured $X` is replaced, not joined).
     */
    readonly actualUsd: number
    /**
     * M51 R5, **Estimated**: the same total with the price table filling in wherever nothing was
     * reported. Reported runs contribute their reported figure, never their estimate -- the rule
     * `costProvenanceOf` enforces in one place. Equal to `actualUsd` on a project where everything
     * reported, which is when the tile hides the line.
     */
    readonly estimatedUsd: number
    /**
     * M51 R5, **Upper bound**: `spentUsd` plus every concluded unmeasured RUN at
     * `RUN_UNMEASURED_CAP_USD`. A DISPLAY figure and nothing charges it -- see
     * `RUN_UNMEASURED_CAP_USD`'s own docstring for why charging it would move the budget guardrail
     * and `gate:m38-supervisor` stage 3 with it.
     */
    readonly upperBoundUsd: number
    readonly unmeasuredCalls: number
    readonly unmeasuredRuns: number
    readonly budgetUsd: number | null
  }
  readonly recentChanges: readonly { readonly at: string; readonly summary: string }[]
  /** M49 R6: what this project knows, in two numbers. A LINE inside the `latest verified` fact and
   *  never a ninth tile (plan erratum E6): the eight facts are pinned by `gate:m45` and by
   *  `project-brief.test.tsx`, and R6 asks for a line rather than a panel. */
  readonly knowledge: { readonly verified: number; readonly candidates: number }
}

/**
 * The reads `buildOverviewSnapshot` has ALREADY made, handed down rather than made again (fix
 * round 1, review Important 8).
 *
 * Every field is optional and every one has a fallback read, so a direct caller -- a test, a future
 * route, the gate -- still gets a correct brief from a workspace id alone. What the fallbacks cost
 * is one extra round trip each; what passing them saves, on the page that refetches this on every
 * event, is a second full `SlaveRun` scan, a second `workspaceSpend()` and a second walk of the
 * Supervisor's world.
 */
export interface ProjectBriefReads {
  /** The needs-you queue. `buildNeedsYou` walks the Supervisor's world, so building it twice per
   *  refetch means two `RepeatableRead` transactions for one list. */
  readonly needsYou?: readonly NeedsYouItem[]
  /** `workspaceSpend()`'s total -- the ONE spend formula (spec erratum E2). */
  readonly spend?: WorkspaceSpend
  /** The rows `sumSpend` counts unmeasured RUNS from -- and, since M51 R5 (plan erratum E14), the
   *  rows the ESTIMATE is computed from. A `CostRow` IS a `SpendRow`, so `sumSpend` keeps taking
   *  exactly what it took. */
  readonly spendRows?: readonly CostRow[]
}

export async function buildProjectBrief(
  workspaceId: string,
  now: Date = new Date(),
  shared: ProjectBriefReads = {},
): Promise<ProjectBrief | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, goal: true, goalVersion: true, budgetUsd: true, haltedReason: true, supervisorEnabled: true },
  })
  if (workspace === null) return null

  const [
    tasks,
    slaves,
    spend,
    spendRows,
    pendingDecisions,
    needsYouItems,
    changeRows,
    verified,
    verifiedMemories,
    candidateMemories,
  ] = await Promise.all([
      prisma.task.findMany({
        where: { workspaceId },
        select: { id: true, title: true, status: true, integratedAt: true },
      }),
      prisma.slave.findMany({
        where: { team: { workspaceId } },
        select: {
          id: true,
          name: true,
          role: true,
          // `companySlaveId` is gone from this select (M50 R1): it was here to compute
          // `company: boolean`, and the column below answers the question that flag was
          // approximating. Nothing else in this builder read the roster link.
          lifecycle: true,
          releasedAt: true,
          releaseReason: true,
          // The LIVE run, the same predicate AND the same ordering `server/overview.ts` uses for
          // its slave cards: a worker's task is the one its run is on, because nothing in the
          // pipeline writes `Task.assigneeId`. Newest first, so a worker that somehow holds two
          // non-terminal runs shows the one it is actually on rather than an arbitrary row. The
          // whole row, because `toRunState` takes one -- narrowing the `select` here would mean
          // spelling that mapper's four fields out a second time.
          runs: {
            where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
            orderBy: { startedAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { name: 'asc' },
      }),
      shared.spend ?? workspaceSpend(workspaceId),
      shared.spendRows ??
        prisma.slaveRun.findMany({
          where: { slave: { team: { workspaceId } } },
          // M51 R5: `tokensIn`/`tokensOut`/`model` join the three `sumSpend` reads, so the brief's
          // ESTIMATE can be computed from the same rows rather than from a second scan. `sumSpend`
          // itself is untouched and still reads only the three it always did -- a `CostRow` IS a
          // `SpendRow`.
          select: { costUsd: true, provider: true, status: true, tokensIn: true, tokensOut: true, model: true },
        }),
      // A COUNT, not a listing (fix round 1, review Important 8 / minor 2): the word only needs
      // how many are waiting, and `listDecisions` both fetches every row's JSON and caps itself at
      // `MAX_DECISION_LIMIT` -- so a project with more pending proposals than that cap would have
      // been told the wrong number by a listing.
      prisma.supervisorDecision.count({ where: { workspaceId, status: 'pending' } }),
      shared.needsYou ?? buildNeedsYou(workspaceId, now),
      prisma.executionEvent.findMany({
        where: { workspaceId, type: { in: CHANGE_TYPES.map((type) => EVENT_TYPE_BY_DOMAIN_TYPE[type]) } },
        orderBy: { seq: 'desc' },
        take: RECENT_CHANGES_LIMIT,
      }),
      latestVerifiedRows(workspaceId),
      // Two index probes over the index M49 t1 added, in the batch that is already running: the
      // brief refetches on every event, and a count is what a LINE needs -- the same reason
      // `pendingDecisions` above is a count rather than a listing.
      prisma.memory.count({ where: { workspaceId, status: 'verified' } }),
      prisma.memory.count({ where: { workspaceId, status: 'candidate' } }),
    ])

  // The counts a person reads, in the DOMAIN's words -- `userTaskStatus`, the same projection the
  // Tasks board's pill and the project card's count use. `TopStrip` below this on the page keeps
  // the raw statuses; that overlap is deliberate (M45 plan erratum E17).
  const wordOf = (task: (typeof tasks)[number]): UserTaskState =>
    userTaskStatus({ status: task.status as TaskStatus, integrated: task.integratedAt !== null }).state
  const countWord = (word: UserTaskState): number => tasks.filter((task) => wordOf(task) === word).length

  const titleById = new Map(tasks.map((task) => [task.id, task.title]))

  const pendingQuestions = needsYouItems.filter((item) => item.kind === 'question').length
  const tasksActive = tasks.filter((task) => ACTIVE_TASK_STATUSES.includes(task.status)).length
  const tasksOpen = tasks.filter((task) => !TERMINAL.includes(task.status as TaskStatus)).length

  const supervisor = userSupervisorStatus({
    halted: workspace.haltedReason !== null,
    enabled: workspace.supervisorEnabled,
    // NOT `report.supervisor.pending`, which is windowed (plan erratum E3).
    pendingDecisions,
    pendingQuestions,
    tasksActive,
    tasksOpen,
  })

  const runSpend = sumSpend(spendRows)

  return {
    objective: { text: workspace.goal, version: workspace.goalVersion },
    supervisor: { state: supervisor.state, label: supervisor.label, needsYou: supervisor.needsYou },
    work: {
      working: countWord('working'),
      verifying: countWord('verifying'),
      review: countWord('review'),
      waiting: countWord('waiting'),
      done: countWord('done') + countWord('integrated'),
    },
    team: slaves.map((slave) => {
      const run = slave.runs[0] ?? null
      return {
        slaveId: slave.id,
        name: slave.name,
        roleLabel: slave.role,
        // The projected WORD, never `deriveSlaveStatus`'s member -- `docs/ia.md` rule 3. The raw
        // value reaches the page on the `SlaveCard` below, which keeps it in `title`.
        status: userSlaveStatus(deriveSlaveStatus(run === null ? null : toRunState(run))).label,
        taskTitle: run?.taskId === null || run === null ? null : (titleById.get(run.taskId) ?? null),
        lifecycle: slave.lifecycle,
        released:
          slave.releasedAt === null
            ? null
            : { at: slave.releasedAt.toISOString(), reason: slave.releaseReason ?? 'released' },
      }
    }),
    needsYou: needsYouItems,
    latestVerified: pickVerified(verified, titleById),
    cost: {
      spentUsd: spend.spentUsd,
      measuredUsd: spend.runsMeasuredUsd + spend.supervisorMeasuredUsd,
      // The SAME sum under its own name (M51 R5, erratum E13): the tile's `actual` line replaces
      // its `measured` line, and the field is duplicated rather than renamed so nothing that reads
      // `measuredUsd` today has to move.
      actualUsd: spend.runsMeasuredUsd + spend.supervisorMeasuredUsd,
      // Σ over runs of (reported ?? estimated ?? 0), plus the Supervisor's own measured spend and
      // its capped unmeasured calls -- i.e. `spentUsd` with the holes filled in wherever they can
      // be. A run that reported nothing and cannot be priced contributes 0 here and shows up in
      // `unmeasuredRuns` instead, which is the honest split. A REPORTED figure is never replaced
      // by its estimate: the `??` chain checks `costUsd` first, the one rule `costProvenanceOf`
      // states in one place.
      estimatedUsd:
        spendRows.reduce((total, row) => total + (row.costUsd ?? estimateCostUsd(row.model, tokensOf(row)) ?? 0), 0) +
        spend.supervisorMeasuredUsd +
        spend.supervisorUnmeasuredCalls * SUPERVISOR_PER_CALL_CAP_USD,
      // A DISPLAY figure, computed HERE and never inside `workspaceSpend` (spec R5): charging an
      // unmeasured run would let a budget halt fire on spending nobody measured.
      upperBoundUsd: spend.spentUsd + runSpend.unknownRuns * RUN_UNMEASURED_CAP_USD,
      // Two different facts, kept apart: a CALL is charged at the cap and is inside `spentUsd`; a
      // RUN nobody measured is in no total at all (`sumSpend`'s own reading).
      unmeasuredCalls: spend.supervisorUnmeasuredCalls,
      unmeasuredRuns: runSpend.unknownRuns,
      budgetUsd: workspace.budgetUsd,
    },
    knowledge: { verified: verifiedMemories, candidates: candidateMemories },
    recentChanges: changeRows.map((row) => ({
      at: row.ts.toISOString(),
      // The family, said out loud -- never the dotted type. `readableEventType` is the projection
      // M44 added for exactly this (erratum E26 there).
      summary: readableEventType(DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type),
    })),
  }
}

/**
 * The newest row of EACH of the three "verified" kinds, in one read.
 *
 * `distinct: ['type']` under `orderBy: { seq: 'desc' }` is Postgres' `DISTINCT ON`: at most three
 * rows come back, and each is the newest of its type. Three sequential `findFirst`s said the same
 * thing in up to three round trips on a page that refetches on every event (fix round 1, review
 * minor 10).
 */
/**
 * One run's token reading, or `null` when either half is missing (M51 R5).
 *
 * `estimateCostUsd`'s own contract: a half-measured run is not a measured one, and passing a `0`
 * for the half nobody recorded would price a run at a fraction of what it really cost. Both columns
 * are written together by the pump, so "one of them null" means the run predates M51 or its runtime
 * reports no usage at all.
 */
function tokensOf(row: CostRow): { readonly input: number; readonly output: number } | null {
  return row.tokensIn === null || row.tokensOut === null ? null : { input: row.tokensIn, output: row.tokensOut }
}

async function latestVerifiedRows(
  workspaceId: string,
): Promise<readonly { readonly type: string; readonly taskId: string | null; readonly ts: Date }[]> {
  return prisma.executionEvent.findMany({
    where: { workspaceId, type: { in: VERIFIED_TYPES.map((one) => EVENT_TYPE_BY_DOMAIN_TYPE[one.type]) } },
    orderBy: { seq: 'desc' },
    distinct: ['type'],
    take: VERIFIED_TYPES.length,
    select: { type: true, taskId: true, ts: true },
  })
}

/**
 * The newest thing this project can honestly call finished (spec R1).
 *
 * PREFERENCE, not recency, across the three: an INTEGRATION is work in the base branch, an
 * APPROVAL is work a reviewer accepted, and a VERIFY PASS is work the commands accepted. A project
 * that auto-merges reaches the first; one that hands the branch to a person usually stops at the
 * second. `null` -- "nothing yet" -- is a real answer and is shown as one; guessing at a task that
 * merely reached `done` would call unreviewed work verified.
 */
function pickVerified(
  rows: readonly { readonly type: string; readonly taskId: string | null; readonly ts: Date }[],
  titleById: ReadonlyMap<string, string>,
): ProjectBrief['latestVerified'] {
  for (const { type, kind } of VERIFIED_TYPES) {
    const row = rows.find((one) => one.type === EVENT_TYPE_BY_DOMAIN_TYPE[type])
    if (row === undefined) continue
    return {
      taskTitle: row.taskId === null ? 'a task' : (titleById.get(row.taskId) ?? 'a task'),
      kind,
      at: row.ts.toISOString(),
    }
  }
  return null
}
