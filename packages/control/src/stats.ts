import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  NON_TERMINAL_RUN_STATUSES,
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
  // Deliberately unbounded: the loop below stops at the first non-`failed` run, but the query
  // returns every run the workspace has ever concluded. A `LIMIT` would bound the transfer, and
  // the only bound that is certainly safe -- the workspace's `consecutiveFailureLimit` -- would
  // also cap the reported number, turning `stats.consecutiveFailures` from "the streak" into
  // "the streak, up to the limit". `evaluateGuardrails` only ever compares it with `>=` so it
  // would not notice, but a later consumer reading the figure as a count would.
  //
  // Joined through `Slave`/`Team`, not `Task`: a `planning` run (M8b) has no `Task` row, and a
  // garbage planner must still feed the circuit breaker like any other slave (the M8a review-run
  // precedent) -- a join through `Task` alone would let it fail forever with no streak to halt it.
  const concludedRuns = await client.$queryRaw<{ readonly status: RunStatus }[]>`
    SELECT r.status::text AS status
    FROM "SlaveRun" r
    JOIN "Slave" a ON a.id = r."slaveId"
    JOIN "Team" tm ON tm.id = a."teamId"
    WHERE tm."workspaceId" = ${workspaceId}
      AND r.status::text = ANY(${[...CONCLUDED_RUN_STATUSES]}::text[])
    ORDER BY COALESCE(r."terminalAt", r."startedAt") DESC, r."startedAt" DESC
  `

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
