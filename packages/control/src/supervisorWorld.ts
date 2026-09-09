import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  NON_TERMINAL_RUN_STATUSES,
  PENDING_TTL_MS,
  evaluateGuardrails,
  type DecisionStatus,
  type SituationKind,
  type SupervisorSlave,
  type SupervisorTask,
  type SupervisorWorld,
  type TaskStatusName,
  type Tier,
} from '@slave-of-ai/domain'
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
  readonly integratedAt: Date | null
  readonly createdAt: Date
  readonly dependents: number
  readonly dependenciesDone: boolean
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
      t."integratedAt",
      t."createdAt",
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
export async function loadSupervisorWorld(workspaceId: string, now: Date): Promise<LoadedSupervisorWorld> {
  return prisma.$transaction(
    async (tx): Promise<LoadedSupervisorWorld> => {
      const workspace = await tx.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        // The halt, the limits and the spend come from `workspaceStats` below (erratum E7), so
        // this read is narrowed to what only the Supervisor cares about.
        select: { id: true, goal: true, supervisorEnabled: true, supervisorProfile: true },
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
          // "Busy" is "holds a run that can still leave a non-terminal status", the same predicate
          // `world.ts` gives the scheduler -- not "has ever held one". `take: 1` answers "any?".
          runs: { where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } }, select: { id: true }, take: 1 },
        },
        orderBy: { id: 'asc' },
      })

      // On `tx`, like everything else: this is the `senderRunId` set the pending-question filter
      // is built from, so reading it outside the snapshot would let a run stop waiting between the
      // two halves of one predicate.
      const waitingRunIds = await waitingSenderRunIds(workspaceId, tx)
      const questionRows = await tx.slaveMessage.findMany({
        where: { workspaceId, ...stillPendingQuestion(waitingRunIds) },
        select: { id: true, slaveId: true, recipientRole: true, recipientSlaveId: true, createdAt: true },
        orderBy: { seq: 'asc' },
      })

      const decisionRows = await tx.supervisorDecision.findMany({
        where: { workspaceId, createdAt: { gte: new Date(now.getTime() - DECISION_WINDOW_MS) } },
        select: { situationKind: true, subjectId: true, status: true, tier: true, createdAt: true, resolvedAt: true },
        orderBy: { createdAt: 'desc' },
      })

      const snapshot = await workspaceStats(workspaceId, tx)

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
        })
      }

      const slaves: SupervisorSlave[] = slaveRows.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        runtimeRoles: row.runtimeRoles,
        busy: row.runs.length > 0,
      }))

      const world: SupervisorWorld = {
        workspaceId: workspace.id,
        now: now.getTime(),
        goal: workspace.goal,
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
        questions: questionRows.map((row) => ({
          messageId: row.id,
          askerSlaveId: row.slaveId,
          recipientRole: row.recipientRole,
          recipientSlaveId: row.recipientSlaveId,
          createdAt: row.createdAt.getTime(),
        })),
        decisions: decisionRows.map((row) => ({
          situationKind: row.situationKind as SituationKind,
          subjectId: row.subjectId,
          status: row.status as DecisionStatus,
          tier: row.tier as Tier,
          createdAt: row.createdAt.getTime(),
          resolvedAt: row.resolvedAt?.getTime() ?? null,
        })),
      }

      return {
        world,
        settings: { enabled: workspace.supervisorEnabled, profile: workspace.supervisorProfile },
      }
    },
    { isolationLevel: 'RepeatableRead', timeout: 15_000, maxWait: 5_000 },
  )
}
