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
   *  from what the orchestrator's own run-stats read summed before `stats.ts`'s `workspaceStats`
   *  took it over (M12 Task 9 ruling R8: the budget guardrail must not trip on unmeasured runs, or
   *  it would fire on every healthy tick, because a LIVE run's cost is null until it concludes).
   *  `apps/web`'s `sumSpend` is what puts the count of those in front of an operator. */
  readonly runsMeasuredUsd: number
  /** Σ `SupervisorDecision.modelCostUsd`. */
  readonly supervisorMeasuredUsd: number
  /** Supervisor model calls that were MADE and whose cost never came back (`modelCalled &&
   *  modelCostUsd === null`). Each is charged at `SUPERVISOR_PER_CALL_CAP_USD`. */
  readonly supervisorUnmeasuredCalls: number
}

/**
 * The ONE spend formula for a workspace (spec erratum E2).
 *
 * Every reader goes through it. `stats.ts`'s `workspaceStats` puts it in `stats.spentUsd`, which
 * is what the budget guardrail evaluates for BOTH of its callers -- `apps/orchestrator/src/world.ts`
 * (whose `decide()` halts scheduling) and `loadSupervisorWorld` (whose `world.budgetExhausted` is
 * the gate that stops the Supervisor calling a model at all) -- and `apps/web`'s `overview.ts` and
 * `shell.ts` call it directly so every page shows the guardrail's own number. So a workspace
 * cannot be talked into an unbounded number of $1 decisions by a formula that only counted runs.
 * Two spellings of it would drift, and the drift would be a Supervisor that keeps spending after
 * the guardrail has halted the workspace.
 *
 * UNMEASURED CALLS (spec erratum E6). A decision row is charged at the cap when `modelCalled` is
 * true and `modelCostUsd` is null: the call was made and its cost never came back, which is
 * exactly the `SlaveRun.costUsd` rule one table over. The predicate is `modelCalled`, NOT
 * `decidedBy: 'model'`, because those differ in the case that matters -- a call that came back
 * unusable (failed, an isolation breach, an unparseable answer) falls back to the rules, so the
 * row honestly says `decidedBy: 'rules'` while the money was still spent. That case is exactly
 * when a provider reports no cost either (`decideWithModel` returns `costUsd: null` on a timeout),
 * so keying the charge on `decidedBy` would have missed precisely the calls it needed to catch.
 *
 * ONE `groupBy`, not an aggregate plus a count: this runs inside `loadWorld`'s transaction on the
 * tick's hot path, and `_count._all` minus `_count.modelCostUsd` (Prisma counts NON-NULL values
 * for a named field) is the unmeasured tally without a second round trip.
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
  // spends real money -- `stats.ts`'s own `activeRuns` comment has the full reasoning.
  const runs = await client.slaveRun.aggregate({
    where: { slave: { team: { workspaceId } } },
    _sum: { costUsd: true },
  })
  const supervisor = await client.supervisorDecision.groupBy({
    by: ['modelCalled'],
    where: { workspaceId },
    _sum: { modelCostUsd: true },
    _count: { _all: true, modelCostUsd: true },
  })

  // `?? 0` is the empty-aggregate case and only that: `_sum` returns null when NO ROWS matched,
  // never because some row's value was null (those are skipped, not folded in as zeros).
  const runsMeasuredUsd = runs._sum.costUsd ?? 0
  const called = supervisor.find((group) => group.modelCalled)
  // Summed across BOTH groups. A row with `modelCalled: false` should never carry a cost, and if
  // one somehow does, money that was spent belongs in the total rather than filtered out of it.
  const supervisorMeasuredUsd = supervisor.reduce((total, group) => total + (group._sum.modelCostUsd ?? 0), 0)
  const supervisorUnmeasuredCalls = called === undefined ? 0 : called._count._all - called._count.modelCostUsd
  return {
    runsMeasuredUsd,
    supervisorMeasuredUsd,
    supervisorUnmeasuredCalls,
    spentUsd: runsMeasuredUsd + supervisorMeasuredUsd + supervisorUnmeasuredCalls * SUPERVISOR_PER_CALL_CAP_USD,
  }
}
