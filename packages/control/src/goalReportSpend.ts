import { prisma } from '@slave-of-ai/db/client'
import { CONDUCT_PER_CALL_CAP_USD, NON_TERMINAL_RUN_STATUSES, SUPERVISOR_PER_CALL_CAP_USD, sumSpend, type GoalReportSpend } from '@slave-of-ai/domain'
import { versionSubject, type VersionScope } from './goalReportTrail.js'
import { workspaceSpend } from './spend.js'

/** A run that has not finished. `sumSpend` counts only the finished unmeasured runs and has no
 *  count of the live ones, so this reads the same shared status list rather than a copy of it. */
const LIVE: ReadonlySet<string> = new Set(NON_TERMINAL_RUN_STATUSES)

/**
 * What one goal version cost (plan D5): its package runs and its verification runs (measured cost
 * summed; a finished run with no cost is unmeasured, a live one's cost is not known yet -- both
 * counted, neither summed, `sumSpend`'s rule), its conductor calls and the Supervisor decisions
 * about it (an unmeasured one charged at its cap, `workspaceSpend`'s rule). The run terms are
 * `sumSpend` itself (ruling R6: shared, not copied), so a run that never spawned (no `provider`)
 * is not unmeasured here either. The project figure is `workspaceSpend` itself: the guardrail's
 * own number, not a second formula.
 */
export async function versionSpend(scope: VersionScope, questionIds: readonly string[]): Promise<GoalReportSpend> {
  const { workspaceId, goalVersion } = scope
  const taskIds = scope.tasks.map((task) => task.taskId)
  const subject = versionSubject(workspaceId, goalVersion)
  const [runs, calls, decisions, project, workspace] = await Promise.all([
    prisma.slaveRun.findMany({
      where: { OR: [{ taskId: { in: taskIds } }, ...(scope.deliveryId === null ? [] : [{ goalDeliveryId: scope.deliveryId }])] },
      orderBy: { id: 'asc' },
      select: { costUsd: true, status: true, provider: true },
    }),
    prisma.conductorCall.findMany({ where: { workspaceId, goalVersion }, orderBy: { id: 'asc' }, select: { modelCostUsd: true, unmeasured: true } }),
    prisma.supervisorDecision.findMany({
      where: { workspaceId, OR: [{ subjectId: subject.equals }, { subjectId: { startsWith: subject.prefix } }, { subjectId: { in: [...taskIds, ...questionIds] } }] },
      orderBy: { id: 'asc' },
      select: { modelCostUsd: true, modelCalled: true },
    }),
    workspaceSpend(workspaceId),
    prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { budgetUsd: true } }),
  ])
  const { known: runsMeasuredUsd, unknownRuns: runsUnmeasured } = sumSpend(runs)
  const runsLive = runs.filter((run) => run.costUsd === null && LIVE.has(run.status)).length
  const conductorMeasuredUsd = calls.reduce((total, call) => total + (call.modelCostUsd ?? 0), 0)
  const conductorUnmeasuredCalls = calls.filter((call) => call.unmeasured).length
  const supervisorMeasuredUsd = decisions.reduce((total, row) => total + (row.modelCostUsd ?? 0), 0)
  const supervisorUnmeasuredCalls = decisions.filter((row) => row.modelCalled && row.modelCostUsd === null).length
  return {
    runsMeasuredUsd,
    runsUnmeasured,
    runsLive,
    conductorMeasuredUsd,
    conductorUnmeasuredCalls,
    supervisorMeasuredUsd,
    supervisorUnmeasuredCalls,
    versionUsd:
      runsMeasuredUsd +
      conductorMeasuredUsd +
      conductorUnmeasuredCalls * CONDUCT_PER_CALL_CAP_USD +
      supervisorMeasuredUsd +
      supervisorUnmeasuredCalls * SUPERVISOR_PER_CALL_CAP_USD,
    projectSpentUsd: project.spentUsd,
    projectBudgetUsd: workspace.budgetUsd,
  }
}
