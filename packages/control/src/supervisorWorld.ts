import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  ACTION_KINDS,
  NON_TERMINAL_RUN_STATUSES,
  PENDING_TTL_MS,
  RUN_PROMPT_MAX_CHARS,
  THREAD_BODY_MAX_CHARS,
  boundThread,
  evaluateGuardrails,
  isStaffableTask,
  parseHandoffContract,
  parseRunbookStages,
  runbookSourceOf,
  type ActionKind,
  type CapabilityRecord,
  type DecisionStatus,
  type HandoffContract,
  type Runbook,
  type SituationKind,
  type SupervisorCatalogEntry,
  type SupervisorCompanyWorker,
  type SupervisorQuestion,
  type SupervisorSlave,
  type SupervisorTask,
  type SupervisorWorld,
  type TaskStatusName,
  type ThreadMessage,
  type Tier,
} from '@slave-of-ai/domain'
import { staleCandidateCount } from './memory.js'
import { stillPendingQuestion, waitingSenderRunIds } from './messaging.js'
import { workspaceStats, type WorkspaceStatsSnapshot } from './stats.js'

/**
 * The guardrail breaches that mean "this workspace is STUCK" to the Supervisor (spec erratum E7).
 *
 * `evaluateGuardrails` halts scheduling on five kinds, and two of them -- `concurrency` and
 * `global_concurrency` -- are normal operation: a workspace at its run cap is busy, not stuck, and
 * raising a `workspace_halted` escalation about it would put a proposal in front of a human every
 * time three runs were in flight, while freezing every routine action for the duration. The other
 * three are real stops that nothing inside the workspace will clear on its own.
 *
 * Order matters: this list is used as a FILTER over `evaluateGuardrails`' output, which is already
 * ordered, and the first surviving breach is the reason reported.
 */
const HALTING_GUARDRAILS: readonly string[] = ['emergency_stop', 'budget_exhausted', 'circuit_breaker']

/**
 * Why the Supervisor should consider this workspace stopped, or `null` (spec erratum E7).
 *
 * The durable column wins when it is set, because it carries a REASON a human wrote or a gate
 * recorded ("verify command failed: …") and that is more useful than the guardrail's name. But
 * only an emergency stop, a pause-gate failure, a verify halt and a merge halt ever write that
 * column: a budget-exhausted or circuit-broken workspace has `haltedReason: null` while `decide()`
 * has stopped scheduling it entirely. Keying on the column alone -- which this loader did until fix
 * round 2 -- meant the Supervisor saw such a workspace as perfectly healthy: no `workspace_halted`
 * situation, routine actions still applying, and the model seam open.
 */
function haltOf(snapshot: WorkspaceStatsSnapshot): { readonly reason: string } | null {
  if (snapshot.haltedReason !== null) return { reason: snapshot.haltedReason }
  const breach = evaluateGuardrails(snapshot.limits, snapshot.stats).find((candidate) =>
    HALTING_GUARDRAILS.includes(candidate.guardrail),
  )
  return breach === undefined ? null : { reason: breach.guardrail }
}

/**
 * The world plus the two settings that are ABOUT the Supervisor rather than about the workspace it
 * watches.
 *
 * `SupervisorWorld` is the domain's shape and stays exactly that -- `observe`, `candidates` and
 * `summarise` must not be able to read a switch that decides whether they run at all. `enabled`
 * gates the whole pass (`recordDecision` refuses `supervisor_disabled` anyway; the orchestrator
 * checks it first so a switched-off project costs one read instead of one refusal per situation),
 * and `profile` is prompt material. Both are read here rather than in a second query because they
 * come off the same `Workspace` row the halt and the budget already do.
 */
export interface LoadedSupervisorWorld {
  readonly world: SupervisorWorld
  readonly settings: { readonly enabled: boolean; readonly profile: string | null }
}

/** The taxonomy, key ascending -- the same order `listCapabilities` returns, because the domain's
 *  "first spelling wins" rule reads it. */
async function loadTaxonomy(tx: Prisma.TransactionClient): Promise<readonly CapabilityRecord[]> {
  const rows = await tx.capability.findMany({ orderBy: { key: 'asc' } })
  return rows.map((row) => ({ key: row.key, label: row.label, domain: row.domain, role: row.role, synonyms: row.synonyms }))
}

/** The company's roster rows that are NOT already materialised into this project (R4's second
 *  place to look). One query: the `NOT EXISTS` is Postgres's, never a filter in JavaScript over a
 *  roster that may be a hundred people. */
async function loadCompanyRoster(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<readonly SupervisorCompanyWorker[]> {
  return tx.$queryRaw<SupervisorCompanyWorker[]>`
    SELECT cs.id AS "companySlaveId", cs.name, t."capabilityKeys" AS capabilities
    FROM "CompanySlave" cs
    JOIN "CompanyTeam" ct ON ct.id = cs."companyTeamId"
    JOIN "Workspace" w ON w."companyId" = ct."companyId"
    JOIN "SlaveTemplate" t ON t.id = cs."templateId"
    WHERE w.id = ${workspaceId}
      AND NOT EXISTS (
        SELECT 1 FROM "Slave" s JOIN "Team" tm ON tm.id = s."teamId"
        WHERE s."companySlaveId" = cs.id AND tm."workspaceId" = ${workspaceId}
      )
    ORDER BY cs.id ASC
  `
}

/** Every catalog template that provides ANY capability, plus whether a worker already here has a
 *  profile that recommends pairing with it (R5's advisory tie-break). Two queries, both bounded:
 *  a template with no `capabilityKeys` can never cover a gap, and the hint read is keyed on the
 *  templates the current roster came from. */
async function loadCatalogEntries(
  tx: Prisma.TransactionClient,
  slaveRows: readonly { readonly id: string }[],
): Promise<readonly SupervisorCatalogEntry[]> {
  const templates = await tx.slaveTemplate.findMany({
    where: { NOT: { capabilityKeys: { isEmpty: true } } },
    select: { id: true, name: true, capabilityKeys: true, sourceDivision: true },
    orderBy: { id: 'asc' },
    take: CATALOG_ENTRIES_MAX,
  })
  const recommended = new Set(
    slaveRows.length === 0
      ? []
      : (
          await tx.collaborationHint.findMany({
            where: {
              targetTemplateId: { not: null },
              OR: [
                { template: { hiredWorkers: { some: { id: { in: slaveRows.map((row) => row.id) } } } } },
                { template: { companySlaves: { some: { workers: { some: { id: { in: slaveRows.map((row) => row.id) } } } } } } },
              ],
            },
            select: { targetTemplateId: true },
          })
        ).flatMap((hint) => (hint.targetTemplateId === null ? [] : [hint.targetTemplateId])),
  )
  return templates.map((template) => ({
    templateId: template.id,
    name: template.name,
    capabilities: template.capabilityKeys,
    division: template.sourceDivision,
    recommended: recommended.has(template.id),
  }))
}

/** A bound, because a full catalog import is thousands of rows (M55) and a Supervisor world is
 *  built once a tick. Ordered by id, so the same thousand rows come back in the same order and
 *  `formTeam` is still deterministic when the bound bites. */
const CATALOG_ENTRIES_MAX = 500

/**
 * How far back the world's decision window reaches. `PENDING_TTL_MS` (24 h) rather than a number
 * of its own: a `pending` decision cannot outlive its own TTL by more than one tick
 * (`expirePendingDecisions` retires it), and `COOLDOWN_MS` is fifteen minutes, so this window
 * covers every row `filterFresh` could still be blocked by, with a day of history left over for
 * `summarise`'s counts. It is a CHEAP first pass either way -- `recordDecision` holds the real
 * gate, in the same transaction it writes in, and would refuse a duplicate this window missed.
 */
const DECISION_WINDOW_MS = PENDING_TTL_MS

interface TaskRow {
  readonly id: string
  readonly title: string
  readonly status: TaskStatusName
  readonly attempt: number
  readonly maxAttempts: number
  readonly requiredRole: string | null
  /** M47 R2/R3: the taxonomy keys this task asked for, verbatim -- `String[]` and never null
   *  (`@default([])`), so a pre-M47 row reads back as "asked for none". */
  readonly requiredCapabilities: readonly string[]
  /** M50 R3 (plan erratum E4): who this task is assigned to, verbatim. `engagement_over` counts a
   *  worker's non-terminal assigned tasks off it -- an ephemeral worker holding one is not done. */
  readonly assigneeId: string | null
  readonly integratedAt: Date | null
  readonly createdAt: Date
  readonly dependents: number
  readonly dependenciesDone: boolean
  /** M40 §1: the goal version the plan that produced this task derived from; null for a hand-made
   *  one. Read straight through -- the domain's `summarise` compares it with `world.goalVersion`. */
  readonly goalVersion: number | null
  /** M48 R2: the runbook stage the plan stamped on this task, or null -- which is what every task
   *  planned before this milestone, and every hand-made one, carries. */
  readonly stage: string | null
}

/**
 * Every task in the workspace with the two counts the Supervisor reasons about.
 *
 * `dependenciesDone` is the SAME predicate `apps/orchestrator/src/world.ts`'s `loadTaskRows` and
 * `apps/web/src/server/graph.ts` use, character for character in its `WHERE`: a dependency is only
 * satisfied when it is `done` AND integrated (M35 t2 -- a `!autoMerge` task is marked `done` with
 * its commits still on an unmerged branch). Three copies is two too many, and they must move
 * together; the alternative here would be for the Supervisor to have its own opinion about which
 * tasks are startable, which is exactly the disagreement `ready_unstaffed` would surface as a
 * situation about a task the scheduler was never going to run.
 *
 * `dependents` is the reverse edge -- how many other tasks are waiting on this one -- which is what
 * makes a failed or unintegrated task everybody's problem rather than its own.
 */
async function loadTaskRows(tx: Prisma.TransactionClient, workspaceId: string): Promise<readonly TaskRow[]> {
  return tx.$queryRaw<TaskRow[]>`
    SELECT
      t.id,
      t.title,
      t.status::text AS status,
      t.attempt,
      t."maxAttempts",
      t."requiredRole",
      t."requiredCapabilities",
      t."assigneeId",
      t."integratedAt",
      t."createdAt",
      t."goalVersion",
      t.stage,
      (SELECT COUNT(*)::int FROM "TaskDependency" td WHERE td."dependsOnTaskId" = t.id) AS dependents,
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

/**
 * When each task last entered a status, from the log (spec erratum E1: `Task` has no
 * `statusChangedAt` column and adding one would touch every status write).
 *
 * `DISTINCT ON` with `seq DESC` is one indexed pass for the whole workspace rather than one query
 * per task, and `seq` -- not `ts` -- is the ordering key for the same reason every other reader of
 * this log uses it: `ts` is a wall clock two appends can share, `seq` is the order they actually
 * happened in.
 *
 * `LIKE 'task.%'` on the DB VALUE, not the Prisma enum member: the column stores the mapped string
 * (`task.created`, `task.rework`, …), and matching the family by prefix is what keeps a task status
 * event added next milestone from silently falling out of this without anybody noticing.
 *
 * Keyed on the task ids the caller ALREADY HOLDS rather than on `taskId IS NOT NULL` (fix round 1):
 * the log's index is `(workspaceId, taskId, seq)`, so `= ANY(...)` gives Postgres one bounded index
 * scan per task instead of a scan over every event the workspace has ever written. Same rows, same
 * semantics -- the caller only ever looks up ids it passed in.
 */
async function loadStatusSince(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, Date>> {
  const rows = await tx.$queryRaw<{ readonly taskId: string; readonly ts: Date }[]>`
    SELECT DISTINCT ON (e."taskId") e."taskId" AS "taskId", e.ts AS ts
    FROM "ExecutionEvent" e
    WHERE e."workspaceId" = ${workspaceId}
      AND e."taskId" = ANY(${[...taskIds]}::text[])
      AND e.type::text LIKE 'task.%'
    ORDER BY e."taskId", e.seq DESC
  `
  return new Map(rows.map((row) => [row.taskId, row.ts]))
}

/** The newest `guardrail.tripped` per task -- what tells `review_cap_blocked` (the one park the
 *  Supervisor may leave routinely, erratum E5) from `task_blocked_human` (a person's park, which it
 *  may only propose leaving). Bounded to the caller's task ids for the reason
 *  {@link loadStatusSince} gives; a workspace-level guardrail carries no `taskId` and matches none
 *  of them. */
async function loadLatestGuardrails(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const rows = await tx.$queryRaw<{ readonly taskId: string; readonly guardrail: string | null }[]>`
    SELECT DISTINCT ON (e."taskId") e."taskId" AS "taskId", e.payload->>'guardrail' AS guardrail
    FROM "ExecutionEvent" e
    WHERE e."workspaceId" = ${workspaceId}
      AND e."taskId" = ANY(${[...taskIds]}::text[])
      AND e.type::text = 'guardrail.tripped'
    ORDER BY e."taskId", e.seq DESC
  `
  return new Map(rows.flatMap((row) => (row.guardrail === null ? [] : [[row.taskId, row.guardrail] as const])))
}

/** `text` at most `max` characters. Every foreign text this loader puts into the world is bounded
 *  HERE, at the edge, so a worker that pasted a log file into a question cannot decide how large
 *  the Supervisor's next prompt is. `buildAnswerPrompt` caps again on its own side, because the
 *  cap that bounds a call belongs where the call is built. */
const cap = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max))

/** The row's `kind`, flattened to the three-way shape `ThreadMessage` reasons about: what was
 *  asked, what replied, and everything else the workers can send -- context worth quoting, but not
 *  part of the ask-and-answer pair. */
function threadKind(kind: string): ThreadMessage['kind'] {
  return kind === 'question' || kind === 'answer' ? kind : 'note'
}

interface ThreadRow {
  readonly id: string
  readonly threadId: string
  readonly slaveId: string
  readonly actor: string
  readonly kind: string
  readonly body: string
  readonly createdAt: Date
}

/**
 * Every message of every thread named, grouped by thread and oldest first (M39 section 3).
 *
 * ONE query for all of them, keyed on the thread ids the caller already holds -- a loop per
 * question would be a scan of the message table per pending question, on the tick's hot path, for
 * a workspace whose whole mailbox is usually two rows.
 *
 * `seq` is the ordering key, not `createdAt`, for the reason every other reader of these rows uses
 * it: two messages written in the same millisecond share a wall clock, and thread order is the
 * order they were actually appended in.
 *
 * `senderSlaveId` comes off the ENVELOPE actor, not off `slaveId`. A human's or the Supervisor's
 * answer carries the ASKER in `slaveId` (the pre-M36 convention for a row nobody's run wrote), so
 * reading that column would tell the model that the asker answered its own question. Erratum E8
 * rests on this column being right: it is what tells a note the asker planted from a colleague's.
 *
 * The `THREAD_MESSAGES_MAX` window (erratum E9) is NOT applied here, but one message later, per
 * QUESTION -- two pending questions can share a thread, and each needs a window that keeps its own
 * question in view. This returns the thread; `boundThread` decides how much of it each question
 * carries.
 */
async function loadThreads(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  threadIds: readonly string[],
): Promise<ReadonlyMap<string, ThreadMessage[]>> {
  if (threadIds.length === 0) return new Map()
  const rows = await tx.slaveMessage.findMany({
    where: { workspaceId, threadId: { in: [...threadIds] } },
    select: { id: true, threadId: true, slaveId: true, actor: true, kind: true, body: true, createdAt: true },
    orderBy: { seq: 'asc' },
  })

  const byThread = new Map<string, ThreadMessage[]>()
  for (const row of rows as readonly ThreadRow[]) {
    const thread = byThread.get(row.threadId) ?? []
    thread.push({
      messageId: row.id,
      kind: threadKind(row.kind),
      senderSlaveId: row.actor === 'slave' ? row.slaveId : null,
      body: cap(row.body, THREAD_BODY_MAX_CHARS),
      createdAt: row.createdAt.getTime(),
    })
    byThread.set(row.threadId, thread)
  }
  return byThread
}

/** The recorded run context of each asking run (M37), capped -- the `run_context` source an answer
 *  may quote. One `findMany` over the run ids the questions name; a run with no `RunContext` row
 *  (a pre-M37 run, or one that never started) is simply absent, and reads back as `null`. */
async function loadRunPrompts(
  tx: Prisma.TransactionClient,
  runIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (runIds.length === 0) return new Map()
  const rows = await tx.runContext.findMany({
    where: { runId: { in: [...runIds] } },
    select: { runId: true, prompt: true },
  })
  return new Map(rows.map((row) => [row.runId, cap(row.prompt, RUN_PROMPT_MAX_CHARS)]))
}

/** The title, description and required role of each asking task -- the `task` source, plus the
 *  role {@link holdersOf} reads for a slave-addressed question. Read separately from
 *  {@link loadTaskRows} because that one carries no description and DROPS a task with no required
 *  role, and a question asked from such a task still has a task text worth quoting. */
async function loadQuestionTasks(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  taskIds: readonly string[],
): Promise<
  ReadonlyMap<
    string,
    {
      readonly title: string
      readonly description: string
      readonly requiredRole: string | null
      readonly handoff: HandoffContract | null
    }
  >
> {
  if (taskIds.length === 0) return new Map()
  const rows = await tx.task.findMany({
    where: { workspaceId, id: { in: [...taskIds] } },
    select: { id: true, title: true, description: true, requiredRole: true, handoff: true },
  })
  return new Map(
    rows.map((row) => [
      row.id,
      { title: row.title, description: row.description, requiredRole: row.requiredRole, handoff: handoffOf(row.handoff) },
    ]),
  )
}

/** M48 R4: a stored `Task.handoff` as a contract, or null. A row that will not parse is `null` --
 *  a malformed handoff must not take the Supervisor's mailbox down, and `null` is already the
 *  ordinary answer for every task planned before this milestone. */
function handoffOf(value: unknown): HandoffContract | null {
  const parsed = parseHandoffContract(value)
  return parsed.ok ? parsed.value : null
}

/**
 * A `RunbookTemplate` row as the domain's {@link Runbook} (M48 R5).
 *
 * A row whose `stages` will not parse comes back with NO stages rather than throwing, the same
 * ruling `control/src/runbook.ts`'s `viewOf` makes: the project HAS adopted this runbook, and
 * hiding the adoption would make the panel lie about what it is following. The CATALOGUE is the
 * other way round -- see {@link loadRunbooks}.
 */
function runbookOf(row: {
  readonly id: string
  readonly key: string
  readonly name: string
  readonly description: string
  readonly keywords: string[]
  readonly requiredCapabilities: string[]
  readonly optionalCapabilities: string[]
  readonly stages: Prisma.JsonValue
  readonly source: string
  readonly sourceTemplateId: string | null
}): Runbook {
  const stages = parseRunbookStages(row.stages)
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    keywords: row.keywords,
    requiredCapabilities: row.requiredCapabilities,
    optionalCapabilities: row.optionalCapabilities,
    stages: stages.ok ? stages.value : [],
    source: runbookSourceOf(row.source),
    sourceTemplateId: row.sourceTemplateId,
  }
}

/** A bound, for `CATALOG_ENTRIES_MAX`'s reason: one catalog import translates a persona runbook per
 *  persona, and a Supervisor world is built once a tick. Key ascending, so the same rows come back
 *  in the same order and `recommendRunbooks` is still deterministic when the bound bites. */
export const RUNBOOKS_IN_WORLD_MAX = 200

/** M48 R5: the runbooks this project could adopt. Read ONLY when `runbook_recommended` could fire
 *  -- a goal, no adopted runbook, and an empty board. A project that has already chosen, or one
 *  with a board, pays for no scan at all. */
async function loadRunbooks(tx: Prisma.TransactionClient): Promise<readonly Runbook[]> {
  const rows = await tx.runbookTemplate.findMany({ orderBy: { key: 'asc' }, take: RUNBOOKS_IN_WORLD_MAX })
  return rows.flatMap((row) => {
    const runbook = runbookOf(row)
    // A row nothing can read recommends nothing: it would score on keywords and then offer an
    // empty process. Dropped rather than offered.
    return runbook.stages.length === 0 ? [] : [runbook]
  })
}

/**
 * Who may answer this question TODAY (spec erratum E5) -- the loader contract
 * `SupervisorQuestion.holders` states, and the same rule control's `reassign_not_permitted`
 * enforces from the other side, so a re-address the rules stamp routine is one the verb accepts.
 *
 * Role-addressed: every slave whose RUNTIME roles include that role. Nobody else can be dispatched
 * the question, which is why an `unanswerable_question` about a role has an empty list by
 * construction and is fixed by staffing rather than by a re-address.
 *
 * Slave-addressed: the addressed slave, plus every slave who could have been dispatched the ASKING
 * task -- a colleague who could do the work can answer a question about it. A null or EMPTY
 * `requiredRole` adds nobody: there is no role to match on, and the empty string ("any role will
 * do") must not read as "everybody".
 *
 * Either way, never the ASKER (erratum E8): nobody answers their own question, and the domain's
 * `answerBar` refuses it from the other side.
 *
 * Built by filtering the roster, so a slave who has left the workspace is never here (the roster is
 * this workspace's slaves) and the order is the roster's own id order, deterministic across passes.
 */
function holdersOf(
  question: {
    readonly slaveId: string
    readonly recipientRole: string | null
    readonly recipientSlaveId: string | null
  },
  taskRole: string | null,
  slaves: readonly SupervisorSlave[],
): string[] {
  // THE ASKER IS NEVER A HOLDER OF ITS OWN QUESTION (erratum E8). It holds the asking task's role
  // by construction -- that is how it came to be doing the task it asked about -- so on the
  // slave-addressed branch it fell straight into this list, and the panel told an operator "2
  // workers could answer it" about a question exactly one worker could answer. It is a filter over
  // both branches rather than one, because a worker can be a holder of a role it also asked about.
  const eligible = slaves.filter((slave) => slave.id !== question.slaveId)
  if (question.recipientRole !== null) {
    return eligible.filter((slave) => slave.runtimeRoles.includes(question.recipientRole as string)).map((slave) => slave.id)
  }
  return eligible
    .filter(
      (slave) =>
        slave.id === question.recipientSlaveId ||
        (taskRole !== null && taskRole !== '' && slave.runtimeRoles.includes(taskRole)),
    )
    .map((slave) => slave.id)
}

/** The `kind` off a stored `SupervisorDecision.action`, or `no_action` when today's catalogue has
 *  no such action (an M38 `nudge_answer`, a hand-edited column). Only the kind is read, never the
 *  whole action: naming what a decision did must not depend on every field of it still validating,
 *  and a tick must not throw over history nobody can read any more. */
function actionKindOf(action: unknown): ActionKind {
  const kind = (action as { readonly kind?: unknown } | null)?.kind
  return typeof kind === 'string' && (ACTION_KINDS as readonly string[]).includes(kind) ? (kind as ActionKind) : 'no_action'
}

/**
 * Just the two Supervisor settings, in one indexed read (fix round 1).
 *
 * `null` means there is no such project. The caller that matters is `supervise()`, which asks this
 * BEFORE {@link loadSupervisorWorld}: a switched-off Supervisor must not pay for a world it will
 * never look at, and on a daemon that is a dozen queries a second, forever, for a project whose
 * operator has explicitly said "report only". `loadSupervisorWorld` reads the same two columns off
 * the same row it already fetches, so nothing is read twice on the path that does proceed.
 */
export async function supervisorSettings(
  workspaceId: string,
): Promise<{ readonly enabled: boolean; readonly profile: string | null } | null> {
  const row = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { supervisorEnabled: true, supervisorProfile: true },
  })
  return row === null ? null : { enabled: row.supervisorEnabled, profile: row.supervisorProfile }
}

/**
 * Loads the snapshot the Supervisor decides from (M38 §3, spec erratum E2: the loader lives in
 * control, which may read Prisma, because `apps/web` needs it too and must not import the
 * orchestrator).
 *
 * `RepeatableRead`, for the same reason `loadWorld` is: the whole contract of this function is
 * *the world one decision was made on*. A torn read -- tasks from one instant, the roster from
 * another -- lets the Supervisor propose staffing a slave that started a run in between, and that
 * proposal is then stored, shown to a human and approved against a world that never existed.
 * `workspaceStats` runs on the same `tx`, so the halt and the budget gate are read from the same
 * snapshot as everything they are compared against -- and are the SAME reading the scheduler's own
 * `loadWorld` makes (erratum E7).
 *
 * Everything is epoch ms by the time it reaches the domain: `SupervisorWorld` holds no `Date`, so
 * a fixture is a literal and a stored `situation` is comparable months later.
 */
export async function loadSupervisorWorld(
  workspaceId: string,
  now: Date,
  opts: { readonly stats?: WorkspaceStatsSnapshot } = {},
): Promise<LoadedSupervisorWorld> {
  return prisma.$transaction(
    async (tx): Promise<LoadedSupervisorWorld> => {
      const workspace = await tx.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        // The halt, the limits and the spend come from `workspaceStats` below (erratum E7), so
        // this read is narrowed to what only the Supervisor cares about.
        select: {
          id: true,
          goal: true,
          goalVersion: true,
          supervisorEnabled: true,
          supervisorProfile: true,
          runbookId: true,
        },
      })

      const taskRows = await loadTaskRows(tx, workspaceId)
      const taskIds = taskRows.map((row) => row.id)
      const statusSince = await loadStatusSince(tx, workspaceId, taskIds)
      const guardrails = await loadLatestGuardrails(tx, workspaceId, taskIds)

      const slaveRows = await tx.slave.findMany({
        where: { team: { workspaceId } },
        select: {
          id: true,
          name: true,
          role: true,
          runtimeRoles: true,
          // M47 R4: what the worker PROVIDES, which is what `assign_capability` is offered off --
          // a worker that already provides the missing capability and was never given its role.
          capabilities: true,
          // M50 R3: the three facts `engagement_over` is decided from. `lifecycle` says whether the
          // question applies at all, `engagementTaskId` names the assignment, and `releasedAt` is
          // what keeps a released worker out of `formTeam`'s roster and out of `staffableSlaves`.
          lifecycle: true,
          engagementTaskId: true,
          releasedAt: true,
          // "Busy" is "holds a run that can still leave a non-terminal status", the same predicate
          // `world.ts` gives the scheduler -- not "has ever held one". `take: 1` answers "any?".
          runs: { where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } }, select: { id: true }, take: 1 },
        },
        orderBy: { id: 'asc' },
      })

      // M47 R4. The catalog and the company roster are read ONLY when the board actually asks for
      // a capability: a project planned before this milestone -- or one whose planner named plain
      // roles -- gets exactly the queries it got before, and no tick scans hundreds of templates
      // to answer a question nobody asked. One query each, never one per capability.
      //
      // The gate is the SAME predicate every reading of "what is missing" now applies -- the domain's
      // own `isStaffableTask` (M47 final review, Important 2), not a fourth spelling of it here.
      // A finished 200-task project whose history is full of capabilities has no gap left to staff,
      // and paying three queries a tick to build a roster and a catalog `formTeam` would then be
      // handed zero requirements for is a cost with no answer in it.
      const asksForCapabilities = taskRows.some(
        (row) => isStaffableTask(row) && row.requiredCapabilities.length > 0,
      )

      // M48 R5. The ADOPTED runbook is read whenever the column is set -- `observe`'s escalation
      // sentence, the panel and `verify` all read the same row. The CATALOGUE is read only when a
      // recommendation could actually be made, the same "do not pay for a query nobody's plan
      // needs" rule the company roster and the catalog follow.
      const adoptedRow =
        workspace.runbookId === null
          ? null
          : await tx.runbookTemplate.findUnique({ where: { id: workspace.runbookId } })
      const adopted = adoptedRow === null ? null : runbookOf(adoptedRow)
      const canRecommend =
        workspace.goal !== null && workspace.goal !== '' && workspace.runbookId === null && taskRows.length === 0

      // THE TAXONOMY IS LOADED WHENEVER RUNBOOKS MATTER, not only when the board asks for a
      // capability (M48 final review, Important 1). A runbook names capabilities of its own -- per
      // stage, and in `requiredCapabilities` -- and every surface that shows one shows the LABEL
      // (`docs/ia.md` rule 3): the recommendation's rationale sentence, which is stored on the
      // decision row a person reads months later, and the Overview panel's stage chips. With an
      // empty taxonomy `capabilityLabel` falls back to the raw key, so the fact that goes in front
      // of a person is `operations.deployment` rather than "Deployment" -- and on a project whose
      // board asks for no capabilities at all (a plan written in plain roles, or no plan yet, which
      // is EXACTLY the state a recommendation is made in) that was the only reading there was. The
      // company roster and the catalog still wait for `asksForCapabilities`: they answer a staffing
      // question nobody here asked.
      const taxonomy = asksForCapabilities || workspace.runbookId !== null || canRecommend ? await loadTaxonomy(tx) : []
      const companyRows = asksForCapabilities ? await loadCompanyRoster(tx, workspaceId) : []
      const catalogRows = asksForCapabilities ? await loadCatalogEntries(tx, slaveRows) : []

      const runbooks = canRecommend ? await loadRunbooks(tx) : []

      // On `tx`, like everything else: this is the `senderRunId` set the pending-question filter
      // is built from, so reading it outside the snapshot would let a run stop waiting between the
      // two halves of one predicate.
      const waitingRunIds = await waitingSenderRunIds(workspaceId, tx)
      const questionRows = await tx.slaveMessage.findMany({
        where: { workspaceId, ...stillPendingQuestion(waitingRunIds) },
        select: {
          id: true,
          slaveId: true,
          taskId: true,
          senderRunId: true,
          threadId: true,
          body: true,
          createdAt: true,
          recipientRole: true,
          recipientSlaveId: true,
        },
        orderBy: { seq: 'asc' },
      })

      // The four sources an answer may be quoted from, loaded for ALL the pending questions at
      // once (M39 section 3). Each is one query keyed on ids this transaction already holds --
      // never a loop per question, which on a workspace with a busy mailbox would be three scans
      // of the message table per tick.
      const questionTasks = await loadQuestionTasks(
        tx,
        workspaceId,
        [...new Set(questionRows.flatMap((row) => (row.taskId === null ? [] : [row.taskId])))],
      )
      const threads = await loadThreads(tx, workspaceId, [...new Set(questionRows.map((row) => row.threadId))])
      const runPrompts = await loadRunPrompts(
        tx,
        [...new Set(questionRows.flatMap((row) => (row.senderRunId === null ? [] : [row.senderRunId])))],
      )

      // M49 R2: how many OBSERVATION candidates nothing has verified in over a day. A COUNT and
      // never the rows (plan erratum E11): the only predicate that reads it asks "how many", and
      // this is exactly the read `Memory`'s `(workspaceId, status, type, createdAt)` index exists
      // for -- no row leaves the database for it. Unlike the catalog and the runbook table there is
      // no gate in front of it: the question is about the project rather than about anything on the
      // board, so there is no cheaper one to ask first.
      //
      // Through `staleCandidateCount` (M49 t2) so the predicate behind "stale" is written once --
      // the verb that WITHDRAWS them has to agree with the count that raised the situation, or the
      // Supervisor proposes five and a person gets four.
      //
      // The cost, stated where a reader meets it (final review, Minor 7 / plan erratum E11): ONE
      // indexed count per world load, and a world is loaded by every Supervisor tick AND by each
      // Overview render that asks for one. It buys back nothing and no gate stands in front of it;
      // the backlog carries "one count per Overview world load" as the thing to revisit if the
      // Overview's read budget ever matters.
      const staleMemoryCandidates = await staleCandidateCount(workspaceId, now, tx)

      const decisionRows = await tx.supervisorDecision.findMany({
        where: { workspaceId, createdAt: { gte: new Date(now.getTime() - DECISION_WINDOW_MS) } },
        select: {
          situationKind: true,
          subjectId: true,
          action: true,
          status: true,
          tier: true,
          createdAt: true,
          resolvedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      })

      // The tick's own reading when it has one (M39 section 4). `loadWorld` already ran
      // `workspaceStats` a few milliseconds ago for the scheduler, on the same numbers, and the
      // limits, the run counts and the spend are the most expensive part of this load. Reusing it
      // is also the more HONEST reading: the halt the Supervisor sees is then literally the halt
      // `decide()` acted on this tick, not a second one taken after the pass moved work.
      const snapshot = opts.stats ?? (await workspaceStats(workspaceId, tx))

      // Plan erratum E6: the stage escalations, resolved ONCE for the board rather than per task.
      const escalationByStage = new Map(
        (adopted?.stages ?? []).map((stage) => [stage.key, stage.escalation] as const),
      )

      const tasks: SupervisorTask[] = []
      for (const row of taskRows) {
        // The loader contract `SupervisorTask.requiredRole` states: a task with NO required role is
        // dropped, exactly as `apps/orchestrator/src/world.ts` drops it from the schedulable set,
        // rather than having a role invented for it here. The EMPTY STRING is a different, real
        // value -- "any role will do" -- and stays.
        if (row.requiredRole === null) continue
        tasks.push({
          id: row.id,
          title: row.title,
          status: row.status,
          attempt: row.attempt,
          maxAttempts: row.maxAttempts,
          requiredRole: row.requiredRole,
          integratedAt: row.integratedAt?.getTime() ?? null,
          statusSince: (statusSince.get(row.id) ?? row.createdAt).getTime(),
          dependents: row.dependents,
          dependenciesDone: row.dependenciesDone,
          latestGuardrail: guardrails.get(row.id) ?? null,
          goalVersion: row.goalVersion,
          requiredCapabilities: row.requiredCapabilities,
          assigneeId: row.assigneeId,
          stage: row.stage,
          // Plan erratum E6: resolved HERE, so `observe` can append the sentence without knowing
          // what a runbook is. Null whenever the task has no stage, the workspace has no runbook,
          // or that stage sets no escalation -- all three are ordinary.
          stageEscalation: row.stage === null ? null : (escalationByStage.get(row.stage) ?? null),
        })
      }

      const slaves: SupervisorSlave[] = slaveRows.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        runtimeRoles: row.runtimeRoles,
        capabilities: row.capabilities,
        busy: row.runs.length > 0,
        // M50 R1/R3 (plan erratum E4): the three lifecycle facts, straight off the columns.
        // `released` is `releasedAt !== null` -- the world carries the ANSWER, not the timestamp,
        // because that is the whole of what the rules ask of it.
        lifecycle: row.lifecycle,
        engagementTaskId: row.engagementTaskId,
        released: row.releasedAt !== null,
      }))

      const world: SupervisorWorld = {
        workspaceId: workspace.id,
        now: now.getTime(),
        goal: workspace.goal,
        goalVersion: workspace.goalVersion,
        halted: haltOf(snapshot),
        // The same comparison `evaluateGuardrails` makes, on the same total: an UNBUDGETED
        // workspace (`budgetUsd` null) is never exhausted, however much it has spent. Kept as its
        // own field rather than folded into `halted` because the two answer different questions --
        // `halted` says the Supervisor may only propose, `budgetExhausted` says it may not SPEND --
        // and a workspace can be halted for a reason that has nothing to do with money.
        budgetExhausted:
          snapshot.limits.budgetUsd !== null && snapshot.stats.spentUsd >= snapshot.limits.budgetUsd,
        tasks,
        slaves,
        questions: questionRows.map((row): SupervisorQuestion => {
          const task = row.taskId === null ? undefined : questionTasks.get(row.taskId)
          return {
            messageId: row.id,
            askerSlaveId: row.slaveId,
            recipientRole: row.recipientRole,
            recipientSlaveId: row.recipientSlaveId,
            createdAt: row.createdAt.getTime(),
            // UNCAPPED, unlike the copy of it in `thread` below (fix round 1, Important 1). The
            // critical lexicon reads THIS field, and a lexicon that read a truncated question would
            // miss "which api key do I use?" written past the two-thousandth character -- and then
            // pay for a second model call to answer the very question it exists to stop. Nothing is
            // unbounded by it: `buildAnswerPrompt` caps the body where the PROMPT is built, which is
            // where the cap actually bounds a call, and the thread copy carries the cap for the
            // quoting the model does.
            body: row.body,
            taskId: row.taskId,
            taskTitle: task?.title ?? null,
            taskDescription: task?.description ?? null,
            senderRunId: row.senderRunId,
            threadId: row.threadId,
            // INCLUDING the question itself: `verifySources` needs it in the thread precisely so
            // it can refuse a citation of it (errata E4/E8 -- nothing the asker wrote is evidence).
            // BOUNDED to the newest `THREAD_MESSAGES_MAX` (E9) by the domain's own rule, which is
            // what keeps the question present even when it has fallen out of that window.
            thread: boundThread(threads.get(row.threadId) ?? [], row.id),
            askerRunPrompt: row.senderRunId === null ? null : runPrompts.get(row.senderRunId) ?? null,
            // M48 R4: the contract behind the asking task, so the answer prompt can show what the
            // asker was actually asked for. A row that will not parse is `null` -- a malformed
            // handoff must not take the Supervisor's mailbox down.
            taskHandoff: task?.handoff ?? null,
            holders: holdersOf(row, task?.requiredRole ?? null, slaves),
          }
        }),
        decisions: decisionRows.map((row) => ({
          situationKind: row.situationKind as SituationKind,
          subjectId: row.subjectId,
          actionKind: actionKindOf(row.action),
          status: row.status as DecisionStatus,
          tier: row.tier as Tier,
          createdAt: row.createdAt.getTime(),
          resolvedAt: row.resolvedAt?.getTime() ?? null,
        })),
        taxonomy,
        company: companyRows,
        catalog: catalogRows,
        runbook: adopted,
        runbooks,
        staleMemoryCandidates,
      }

      return {
        world,
        settings: { enabled: workspace.supervisorEnabled, profile: workspace.supervisorProfile },
      }
    },
    { isolationLevel: 'RepeatableRead', timeout: 15_000, maxWait: 5_000 },
  )
}
