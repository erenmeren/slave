import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  NON_TERMINAL_RUN_STATUSES,
  PENDING_TTL_MS,
  type DecisionStatus,
  type SituationKind,
  type SupervisorSlave,
  type SupervisorTask,
  type SupervisorWorld,
  type TaskStatusName,
  type Tier,
} from '@slave-of-ai/domain'
import { stillPendingQuestion, waitingSenderRunIds } from './messaging.js'
import { workspaceSpend } from './spend.js'

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
 */
async function loadStatusSince(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<ReadonlyMap<string, Date>> {
  const rows = await tx.$queryRaw<{ readonly taskId: string; readonly ts: Date }[]>`
    SELECT DISTINCT ON (e."taskId") e."taskId" AS "taskId", e.ts AS ts
    FROM "ExecutionEvent" e
    WHERE e."workspaceId" = ${workspaceId} AND e."taskId" IS NOT NULL AND e.type::text LIKE 'task.%'
    ORDER BY e."taskId", e.seq DESC
  `
  return new Map(rows.map((row) => [row.taskId, row.ts]))
}

/** The newest `guardrail.tripped` per task -- what tells `review_cap_blocked` (a park the
 *  Supervisor knows a routine exit from) from `task_blocked_human` (one it must not guess at). A
 *  workspace-level guardrail carries no `taskId` and is skipped by the `IS NOT NULL`. */
async function loadLatestGuardrails(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<ReadonlyMap<string, string>> {
  const rows = await tx.$queryRaw<{ readonly taskId: string; readonly guardrail: string | null }[]>`
    SELECT DISTINCT ON (e."taskId") e."taskId" AS "taskId", e.payload->>'guardrail' AS guardrail
    FROM "ExecutionEvent" e
    WHERE e."workspaceId" = ${workspaceId} AND e."taskId" IS NOT NULL AND e.type::text = 'guardrail.tripped'
    ORDER BY e."taskId", e.seq DESC
  `
  return new Map(rows.flatMap((row) => (row.guardrail === null ? [] : [[row.taskId, row.guardrail] as const])))
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
 * `workspaceSpend` runs on the same `tx` so the budget gate is read from the same snapshot.
 *
 * Everything is epoch ms by the time it reaches the domain: `SupervisorWorld` holds no `Date`, so
 * a fixture is a literal and a stored `situation` is comparable months later.
 */
export async function loadSupervisorWorld(workspaceId: string, now: Date): Promise<LoadedSupervisorWorld> {
  return prisma.$transaction(
    async (tx): Promise<LoadedSupervisorWorld> => {
      const workspace = await tx.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: {
          id: true,
          goal: true,
          haltedReason: true,
          budgetUsd: true,
          supervisorEnabled: true,
          supervisorProfile: true,
        },
      })

      const taskRows = await loadTaskRows(tx, workspaceId)
      const statusSince = await loadStatusSince(tx, workspaceId)
      const guardrails = await loadLatestGuardrails(tx, workspaceId)

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

      const spend = await workspaceSpend(workspaceId, tx)

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
        halted: workspace.haltedReason === null ? null : { reason: workspace.haltedReason },
        // The same comparison `evaluateGuardrails` makes, on the same total: an UNBUDGETED
        // workspace (`budgetUsd` null) is never exhausted, however much it has spent.
        budgetExhausted: workspace.budgetUsd !== null && spend.spentUsd >= workspace.budgetUsd,
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
