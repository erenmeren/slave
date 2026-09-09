import { type Prisma, prisma } from '@slave-of-ai/db/client'
import { SUPERVISOR_PER_CALL_CAP_USD } from '@slave-of-ai/domain'

/** What a workspace has spent, and the three parts it is made of. The parts are kept because the
 *  total alone cannot say whether a figure is measured -- which is the difference between "this
 *  project spent $4" and "this project spent at least $4 and we stopped being able to tell". */
export interface WorkspaceSpend {
  /** `runsMeasuredUsd + supervisorMeasuredUsd + supervisorUnmeasuredCalls * SUPERVISOR_PER_CALL_CAP_USD`. */
  readonly spentUsd: number
  /** Σ `SlaveRun.costUsd` over every run of the workspace, whatever its status. Postgres' `sum()`
   *  skips NULLs, so an unmeasured RUN contributes nothing here -- deliberately, and unchanged
   *  from what `loadRunStats` has always summed (M12 Task 9 ruling R8: the budget guardrail must
   *  not trip on unmeasured runs, or it would fire on every healthy tick, because a LIVE run's
   *  cost is null until it concludes). `apps/web`'s `sumSpend` is what puts the count of those in
   *  front of an operator. */
  readonly runsMeasuredUsd: number
  /** Σ `SupervisorDecision.modelCostUsd`. */
  readonly supervisorMeasuredUsd: number
  /** Supervisor model calls whose cost never came back -- see {@link workspaceSpend} for the rule
   *  that decides which rows count. Each is charged at `SUPERVISOR_PER_CALL_CAP_USD`. */
  readonly supervisorUnmeasuredCalls: number
}

/**
 * The ONE spend formula for a workspace (spec erratum E2).
 *
 * Both readers use this: `apps/orchestrator/src/world.ts`'s `loadRunStats`, so the budget
 * guardrail sees Supervisor spend and a workspace cannot be talked into an unbounded number of
 * $1 decisions by a formula that only counted runs, and `loadSupervisorWorld`, so
 * `world.budgetExhausted` -- the gate that stops the Supervisor calling a model at all -- is the
 * same number the guardrail acts on. Two spellings of it would drift, and the drift would be a
 * Supervisor that keeps spending after the guardrail has halted the workspace.
 *
 * UNMEASURED CALLS. A decision row is charged at the cap when `decidedBy: 'model'` and
 * `modelCostUsd` is null: the call was made and its cost never came back, which is exactly the
 * `SlaveRun.costUsd` rule one table over. A `rules` row is not charged -- it makes no call at all.
 * The one case this under-counts is a model call that came back unusable (failed, breached, or an
 * answer that would not parse) WITH no cost: the row is honestly recorded as `decidedBy: 'rules'`,
 * because the rules are what chose, and nothing on the row distinguishes it from a decision that
 * never called anybody. Correcting that would need a column (`modelCalls`, or a nullable
 * `modelAttemptedAt`), which M38 deliberately does not add; the exposure is bounded by
 * `SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK` calls per tick and only bites when the provider both
 * fails AND reports no cost, which is the same case `decideWithModel` returns `costUsd: null` for
 * on a timeout.
 *
 * `client` exists so the caller can run this INSIDE its own snapshot: `loadWorld` reads the world
 * in one `RepeatableRead` transaction, and a spend figure fetched on the shared client afterwards
 * would be from a different instant than the tasks and runs it is compared against.
 */
export async function workspaceSpend(
  workspaceId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<WorkspaceSpend> {
  // Joined through `Slave`/`Team`, not `Task`: a planning run (M8b) has no `Task` row and still
  // spends real money -- `loadRunStats`' own comment has the full reasoning.
  const runs = await client.slaveRun.aggregate({
    where: { slave: { team: { workspaceId } } },
    _sum: { costUsd: true },
  })
  const supervisor = await client.supervisorDecision.aggregate({
    where: { workspaceId },
    _sum: { modelCostUsd: true },
  })
  const supervisorUnmeasuredCalls = await client.supervisorDecision.count({
    where: { workspaceId, decidedBy: 'model', modelCostUsd: null },
  })

  // `?? 0` is the empty-aggregate case and only that: `_sum` returns null when NO ROWS matched,
  // never because some row's value was null (those are skipped, not folded in as zeros).
  const runsMeasuredUsd = runs._sum.costUsd ?? 0
  const supervisorMeasuredUsd = supervisor._sum.modelCostUsd ?? 0
  return {
    runsMeasuredUsd,
    supervisorMeasuredUsd,
    supervisorUnmeasuredCalls,
    spentUsd: runsMeasuredUsd + supervisorMeasuredUsd + supervisorUnmeasuredCalls * SUPERVISOR_PER_CALL_CAP_USD,
  }
}
