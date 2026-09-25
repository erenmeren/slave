import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  NON_TERMINAL_RUN_STATUSES,
  type FailureClass,
  type GuardrailLimits,
  type RunStatus,
  type WorkspaceStats,
} from '@slave-of-ai/domain'
import { workspaceSpend, type WorkspaceSpend } from './spend.js'

type RunStatusKind = 'non_terminal' | 'concluded' | 'terminal_uncounted'

/**
 * Every `RunStatus` classified exactly once. `CONCLUDED_RUN_STATUSES` below is *derived* from
 * this map rather than written out independently, so a tenth `RunStatus` added to
 * `packages/domain` breaks this build -- `satisfies Record<RunStatus, …>` demands a key per
 * member -- instead of quietly falling outside every list, where it would stay invisible to the
 * failure breaker.
 *
 * `non_terminal` here must still agree with `NON_TERMINAL_RUN_STATUSES` (`packages/domain/src/run/
 * state.ts`): this map does not derive that constant, but it still has to classify every
 * `RunStatus` to stay exhaustive, and "busy" and "non-terminal" are the same question asked of two
 * different tables.
 *
 * `stopped` is deliberately neither kind: it is terminal, so it releases the slave that held it,
 * but an operator stopping a run is not the run failing. It must not count toward the failure
 * streak, and it must not break one either -- a single stop should not launder away a real streak.
 */
const RUN_STATUS_KIND = {
  starting: 'non_terminal',
  working: 'non_terminal',
  pause_requested: 'non_terminal',
  paused: 'non_terminal',
  resuming: 'non_terminal',
  stopping: 'non_terminal',
  stopped: 'terminal_uncounted',
  succeeded: 'concluded',
  failed: 'concluded',
} satisfies Record<RunStatus, RunStatusKind>

function statusesOfKind(kind: RunStatusKind): readonly RunStatus[] {
  return (Object.keys(RUN_STATUS_KIND) as RunStatus[]).filter((status) => RUN_STATUS_KIND[status] === kind)
}

/**
 * The only statuses a run's `consecutiveFailures` streak can be counted from -- a run still in
 * progress has not concluded either way, so it contributes nothing to the streak and must not
 * break it either.
 */
const CONCLUDED_RUN_STATUSES: readonly RunStatus[] = statusesOfKind('concluded')

/**
 * Spec §5: a hard cap on non-terminal `SlaveRun`s across every workspace at once, not per
 * workspace. A `Workspace` column would let N workspaces each configure their own limit and
 * collectively blow the machine's real capacity for concurrent `claude` processes -- the whole
 * point is a ceiling nothing on a per-workspace path can raise.
 */
export const MAX_GLOBAL_CONCURRENT_RUNS = 6

/** One reading of everything `evaluateGuardrails` needs, plus the halt column and the spend split
 *  that only the surfaces care about. */
export interface WorkspaceStatsSnapshot {
  readonly limits: GuardrailLimits
  readonly stats: WorkspaceStats
  /** The three parts of `stats.spentUsd` -- see {@link workspaceSpend}. */
  readonly spend: WorkspaceSpend
  /** `Workspace.haltedReason`: the DURABLE halt, written by the pause gate, a verify halt, a merge
   *  halt or an operator's emergency stop. It is what `stats.emergencyStopped` is derived from,
   *  and it is returned raw because a caller that wants to SAY why a workspace is halted needs the
   *  reason, not a boolean. */
  readonly haltedReason: string | null
}

/**
 * The one reading of a workspace's limits and stats (spec erratum E7).
 *
 * Both callers evaluate the SAME guardrails from it: `apps/orchestrator/src/world.ts`, whose
 * `decide()` halts scheduling on a breach, and `packages/control/src/supervisorWorld.ts`, whose
 * `SupervisorWorld.halted` decides whether the Supervisor may apply anything or call a model. They
 * disagreed before this existed -- the loader keyed `halted` on `haltedReason` alone, which only an
 * emergency stop ever writes, so a budget-exhausted or circuit-broken workspace looked perfectly
 * healthy to the Supervisor while the scheduler had stopped it. Two readings of "is this workspace
 * stopped" is one too many; this is the reading.
 *
 * `client` exists so a caller can read INSIDE its own snapshot -- both callers wrap their world in
 * one `RepeatableRead` transaction, and stats fetched afterwards on the shared client would be from
 * a different instant than the tasks and runs they are compared against.
 */
export async function workspaceStats(
  workspaceId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<WorkspaceStatsSnapshot> {
  const workspace = await client.workspace.findUniqueOrThrow({ where: { id: workspaceId } })

  // `slave: { team: { workspaceId } }`, not `task: { workspaceId }`: a `planning` run (M8b) has no
  // `Task` row, and it still occupies a concurrency slot and spends real money -- scoping through
  // `Task` would silently drop it from both figures below.
  const activeRuns = await client.slaveRun.count({
    where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] }, slave: { team: { workspaceId } } },
  })
  const globalActiveRuns = await client.slaveRun.count({
    where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
  })

  // Aggregates, not `sumSpend` -- unlike `overview.ts` and `org.ts`, which read the same spend
  // through it (M12 Task 9, ruling R3, corrected in fix round F3). The difference is the CONSUMER,
  // not the arithmetic:
  //
  // This figure feeds `evaluateGuardrails`, and ruling R8 keeps `unknownRuns` out of the guardrail
  // deliberately -- a breach keyed on unmeasured RUNS would fire on every healthy tick, because a
  // live run's cost is null until it concludes. So the second half of `sumSpend`'s pair would be
  // computed and thrown away here, while the first half is numerically identical to what `_sum`
  // already returns: Postgres' `sum()` skips NULLs, which is the same rule `sumSpend.known`
  // applies. Paying for it would mean transferring one float per run of the workspace's ENTIRE
  // history, inside a transaction with a cumulative 15 s budget, on the tick's hot path, to compute
  // a number that does not change.
  //
  // M38 §5: the sum includes the SUPERVISOR's own model calls -- measured, plus every unmeasured
  // one at `SUPERVISOR_PER_CALL_CAP_USD`. An unmeasured supervisor CALL is charged (unlike an
  // unmeasured run) because it is finished: nothing will ever report its cost, so zero would be the
  // wrong guess and the cap is the honest ceiling.
  const spend = await workspaceSpend(workspaceId, client)

  // Most recently concluded first, so the leading run of the list is the one the streak counts
  // from. `SlaveRun.terminalAt` is written by the event pump as of M5 Task 12 -- when this was
  // first written nothing populated it, and the COALESCE below was defensive; it is now
  // load-bearing for every run the pump concludes, while rows written before it still carry
  // `null`. A bare `ORDER BY "terminalAt" DESC` is therefore not merely imprecise, it is a trap:
  // Postgres sorts `DESC` as NULLS FIRST, so the moment a later task starts populating the column,
  // every legacy null row jumps to the front and *inverts* the streak -- three ancient failures
  // ahead of today's success reads as `consecutiveFailures: 3`, which trips the circuit breaker
  // into a permanent halt on a workspace that is succeeding. `COALESCE` states what is actually
  // true: a run's position in the streak is when it concluded, and `startedAt` is the stand-in for
  // rows that predate the pump writing the column. `startedAt DESC` then breaks ties.
  //
  // Raw SQL rather than Prisma's `orderBy`, which cannot express a `COALESCE` sort key.
  //
  // Bounded at `consecutiveFailureLimit + 1` rows (final review Important 2), which is EXACT for
  // what the streak is used for rather than merely cheap. The loop below stops at the first
  // non-`failed` run, so only a prefix is ever read; and the one consumer,
  // `evaluateGuardrails`' circuit breaker, asks `consecutiveFailures >= consecutiveFailureLimit`.
  // A prefix of `limit + 1` decides that question for every possible history: `limit` failures
  // followed by anything already trips it, and any shorter prefix of failures is reported as its
  // true length because the run that ended the streak is inside the window. The `+ 1` is the run
  // that ENDS the streak -- without it a workspace exactly at the limit could not be told apart
  // from one past it, which does not change the breach but does change the number printed next
  // to it. Beyond that the figure would only ever say "and more failures before those", and
  // nothing reads it that way. It is a streak, not a lifetime count, and no caller reads it as
  // one -- a future consumer that wants the true total must count it itself, not widen this.
  //
  // Joined through `Slave`/`Team`, not `Task`: a `planning` run (M8b) has no `Task` row, and a
  // garbage planner must still feed the circuit breaker like any other slave (the M8a review-run
  // precedent) -- a join through `Task` alone would let it fail forever with no streak to halt it.
  //
  // The `::int` on the LIMIT parameter: a bare Prisma placeholder arrives untyped and Postgres
  // will not take a double there.
  // Only runs that concluded AFTER the operator last cleared a halt (`clearHalt`). The breaker is
  // recomputed every tick and the halt it raises prevents the very run that would break the
  // streak, so without this filter it is a one-way door: a project whose failure cause has been
  // fixed stays halted forever, because the three rows that halted it never stop being the three
  // most recent. The stamp does not disable the breaker -- it moves where it counts from, and the
  // next failure starts a new streak.
  //
  // The same `COALESCE` sort key the ORDER BY uses, for the same reason: a run's position in the
  // streak is when it CONCLUDED, and `startedAt` stands in for rows written before the pump
  // populated `terminalAt`.
  //
  // H4b, generalised by H9b R1: a PLATFORM failure (`failureClass = 'platform'` -- a spawn that
  // never reached the model, a run orphaned by a daemon crash, a provider `api_error`, a timeout
  // decided after the host slept) is left OUT of the window rather than counted as a failure or
  // read as a break. A missing binary, a killed daemon or a rate limit is not a worker failing
  // three times: on 2026-09-21 three daemon kills on one task (F4) and three rate-limit refusals
  // (F5) each halted a project and asked a person to decide what the platform had done. Left out,
  // not a break: three real failures with a platform failure between them are still three real
  // failures in a row. `IS DISTINCT FROM`, not `<>`: a failed row written before the column
  // existed has no class, counts as the worker's, and `<>` would drop it with the NULL.
  const concludedRuns = await streakHead(client, workspaceId, workspace)

  let consecutiveFailures = 0
  for (const run of concludedRuns) {
    if (run.status !== 'failed') break
    consecutiveFailures += 1
  }

  return {
    limits: {
      maxConcurrentRuns: workspace.maxConcurrentRuns,
      budgetUsd: workspace.budgetUsd,
      runTimeoutMs: workspace.runTimeoutMs,
      maxToolCallsPerRun: workspace.maxToolCallsPerRun,
      maxAttempts: workspace.maxAttempts,
      consecutiveFailureLimit: workspace.consecutiveFailureLimit,
      maxGlobalConcurrentRuns: MAX_GLOBAL_CONCURRENT_RUNS,
    },
    // No unmeasured-run count in `WorkspaceStats`, deliberately (M12 Task 9, ruling R8): admission
    // already keeps a cost-blind runtime out of a budgeted workspace, and every LIVE run has a null
    // cost until it concludes -- so a guardrail keyed on unmeasured runs would trip on every
    // healthy tick of every healthy workspace. The figure belongs on the surfaces, where
    // `apps/web`'s `sumSpend` calls put it in front of an operator.
    stats: {
      activeRuns,
      globalActiveRuns,
      spentUsd: spend.spentUsd,
      consecutiveFailures,
      // Not hardcoded: a pause gate failure sets `Workspace.haltedReason` (spec §13.1), and M8's
      // human-facing emergency stop is deliberately built on this same column rather than a second
      // one. Reading it live is what lets a persistent halt survive a daemon restart -- there is no
      // in-memory latch anywhere for it to be lost from.
      emergencyStopped: workspace.haltedReason !== null,
    },
    spend,
    haltedReason: workspace.haltedReason,
  }
}

/**
 * The head of the failure streak: the workspace's most recently concluded runs, newest first,
 * bounded at `consecutiveFailureLimit + 1` -- the ONE reading of which runs the circuit breaker
 * counts, shared by {@link workspaceStats} (how many) and {@link breakerCountedFailures} (which,
 * and why). Two copies of this query would be two breakers that could disagree about one halt.
 */
async function streakHead(
  client: Prisma.TransactionClient,
  workspaceId: string,
  workspace: { readonly haltClearedAt: Date | null; readonly consecutiveFailureLimit: number },
): Promise<readonly { readonly id: string; readonly status: RunStatus }[]> {
  return client.$queryRaw<{ readonly id: string; readonly status: RunStatus }[]>`
    SELECT r.id AS id, r.status::text AS status
    FROM "SlaveRun" r
    JOIN "Slave" a ON a.id = r."slaveId"
    JOIN "Team" tm ON tm.id = a."teamId"
    WHERE tm."workspaceId" = ${workspaceId}
      AND r.status::text = ANY(${[...CONCLUDED_RUN_STATUSES]}::text[])
      AND r."failureClass" IS DISTINCT FROM 'platform'
      AND (
        ${workspace.haltClearedAt}::timestamp IS NULL
        OR COALESCE(r."terminalAt", r."startedAt") > ${workspace.haltClearedAt}::timestamp
      )
    ORDER BY COALESCE(r."terminalAt", r."startedAt") DESC, r."startedAt" DESC
    LIMIT ${workspace.consecutiveFailureLimit + 1}::int
  `
}

/** One failed run the circuit breaker counted, as a person has to be told about it (H9c). */
export interface CountedFailure {
  readonly runId: string
  readonly runKind: 'implementation' | 'review' | 'planning'
  /** The task the run worked on; null for a planning run, which has none. */
  readonly taskTitle: string | null
  /** The newest `run.failed` reason the run recorded, or null when it recorded none. */
  readonly reason: string | null
  readonly failureClass: FailureClass | null
}

/**
 * The failed runs at the head of the streak, newest first -- exactly the ones
 * `stats.consecutiveFailures` counted, with the reason each one recorded (H9c).
 *
 * What a circuit-breaker escalation is written from: "three failed runs" sends a person to the run
 * log, and the three reasons are the whole of what they went there for. Also what an approval of
 * that escalation re-reads (F5b): a breaker whose every counted failure was the platform's is
 * lifted by the approval itself.
 */
export async function breakerCountedFailures(
  workspaceId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<readonly CountedFailure[]> {
  const workspace = await client.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { haltClearedAt: true, consecutiveFailureLimit: true },
  })
  const head = await streakHead(client, workspaceId, workspace)
  const counted: string[] = []
  for (const run of head) {
    if (run.status !== 'failed') break
    counted.push(run.id)
  }
  if (counted.length === 0) return []
  const runs = await client.slaveRun.findMany({
    where: { id: { in: counted } },
    select: { id: true, kind: true, failureClass: true, task: { select: { title: true } } },
  })
  const events = await client.executionEvent.findMany({
    where: { runId: { in: counted }, type: 'run_failed' },
    orderBy: { seq: 'desc' },
    select: { runId: true, payload: true },
  })
  const reasonOf = (runId: string): string | null => {
    const payload = events.find((event) => event.runId === runId)?.payload
    const reason = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload['reason'] : undefined
    return typeof reason === 'string' ? reason : null
  }
  return counted.flatMap((runId) => {
    const run = runs.find((one) => one.id === runId)
    if (run === undefined) return []
    return [
      {
        runId,
        runKind: run.kind,
        taskTitle: run.task?.title ?? null,
        reason: reasonOf(runId),
        failureClass: run.failureClass,
      },
    ]
  })
}
