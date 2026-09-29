import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  actionSchema,
  err,
  ok,
  requirementItemsSchema,
  type GoalReport,
  type GoalReportPackage,
  type GoalReportRequirement,
  type GoalReportRound,
  type GoalReportState,
  type GoalReportVerdictStatus,
  type GoalReportWorkerReport,
  type Result,
} from '@slave-of-ai/domain'
import { loadVersionScope, seatNames, versionQuestions, versionSubject, versionTrail } from './goalReportTrail.js'
import { versionSpend } from './goalReportSpend.js'
import type { ControlRefusal } from './refusal.js'

/** Plain `<` ordering (plan D7): the same on every machine, unlike `localeCompare`. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The workspace's versions that have a report (spec R10: one per goal version): every version
 *  with requirements or a delivery, ascending. A planned project has none. */
export async function reportVersions(workspaceId: string): Promise<readonly number[]> {
  const [sets, deliveries] = await Promise.all([
    prisma.requirementSet.findMany({ where: { workspaceId }, select: { goalVersion: true } }),
    prisma.goalDelivery.findMany({ where: { workspaceId }, select: { goalVersion: true } }),
  ])
  return [...new Set([...sets, ...deliveries].map((row) => row.goalVersion))].sort((a, b) => a - b)
}

/** The newest version that has a report, or null (the Team page's Goal link, plan D9). */
export async function latestReportVersion(workspaceId: string): Promise<number | null> {
  return (await reportVersions(workspaceId)).at(-1) ?? null
}

/** The newest event of `type` about this version (`payload.version`), or null. */
async function versionEvent(
  workspaceId: string,
  type: 'workspace_conducted' | 'workspace_goal_merged' | 'workspace_goal_abandoned',
  version: number,
): Promise<{ readonly ts: Date; readonly payload: Record<string, unknown> } | null> {
  const row = await prisma.executionEvent.findFirst({
    where: { workspaceId, type, payload: { path: ['version'], equals: version } },
    orderBy: { seq: 'desc' },
    select: { ts: true, payload: true },
  })
  return row === null ? null : { ts: row.ts, payload: (row.payload ?? {}) as Record<string, unknown> }
}

/** A stored `RunReport.report`, read defensively (the `listGoalVersions` rule for a `Json` column):
 *  a row a later build wrote differently degrades to fewer facts, never to a thrown read. */
function readWorkerReport(runId: string, value: Prisma.JsonValue): { readonly report: GoalReportWorkerReport; readonly files: readonly string[] } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const requirements = (Array.isArray(row['requirements']) ? row['requirements'] : []).flatMap((raw): GoalReportWorkerReport['requirements'][number][] => {
    if (raw === null || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    const status = item['status']
    if (typeof item['key'] !== 'string' || (status !== 'done' && status !== 'partial' && status !== 'not_done')) return []
    return [{ key: item['key'], status, evidence: typeof item['evidence'] === 'string' ? item['evidence'] : '' }]
  })
  const workflow = (Array.isArray(row['workflow']) ? row['workflow'] : []).filter((raw): raw is Record<string, unknown> => raw !== null && typeof raw === 'object')
  const files = (Array.isArray(row['filesTouched']) ? row['filesTouched'] : []).filter((file): file is string => typeof file === 'string')
  return {
    report: { runId, requirements, workflowDone: workflow.filter((step) => step['done'] === true).length, workflowTotal: workflow.length },
    files: [...files].sort(byText),
  }
}

/**
 * One goal version's report (spec R10, plan D1), read from recorded rows only: no model, no git.
 * Works for every state (plan D2) and for a version that has requirements but no delivery yet.
 * `goal_version_not_found` for a version with neither, which includes every version of a planned
 * project.
 */
export async function loadGoalReport(workspaceId: string, goalVersion: number): Promise<Result<GoalReport, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true, baseBranch: true, verificationRoundCap: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  const versions = await reportVersions(workspaceId)
  if (!versions.includes(goalVersion)) return err({ kind: 'goal_version_not_found', workspaceId, goalVersion })

  const scope = await loadVersionScope(workspaceId, goalVersion)
  const [goalRow, set, delivery, decisionRow, conducted, merged, abandoned, packageRows] = await Promise.all([
    prisma.goalVersion.findUnique({ where: { workspaceId_version: { workspaceId, version: goalVersion } }, select: { text: true } }),
    prisma.requirementSet.findUnique({ where: { workspaceId_goalVersion: { workspaceId, goalVersion } }, select: { items: true } }),
    prisma.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId, goalVersion } } }),
    prisma.supervisorDecision.findFirst({
      where: { workspaceId, situationKind: 'conduct', subjectId: versionSubject(workspaceId, goalVersion).equals },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { action: true, rationale: true, decidedBy: true, createdAt: true },
    }),
    versionEvent(workspaceId, 'workspace_conducted', goalVersion),
    versionEvent(workspaceId, 'workspace_goal_merged', goalVersion),
    versionEvent(workspaceId, 'workspace_goal_abandoned', goalVersion),
    prisma.workPackage.findMany({
      where: { workspaceId, goalVersion },
      include: {
        tasks: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, status: true, integratedAt: true, assigneeId: true } },
        reports: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { runId: true, report: true } },
      },
    }),
  ])

  // Verification (plan D4): per round, the rows of the run that wrote last count. The same rule as
  // `latestVerifications`, kept as a second reading here (ruling R6) because that one keeps only
  // the latest round's counts, and the report needs every round's rows and each run's verdicts.
  const results =
    delivery === null
      ? []
      : await prisma.verificationResult.findMany({
          where: { goalDeliveryId: delivery.id },
          orderBy: [{ round: 'asc' }, { createdAt: 'asc' }, { runId: 'asc' }, { key: 'asc' }],
        })
  const writerOf = new Map<number, string>()
  for (const row of results) writerOf.set(row.round, row.runId)
  const counted = results.filter((row) => writerOf.get(row.round) === row.runId)
  const verificationRuns = await prisma.slaveRun.findMany({
    where: { id: { in: [...new Set(writerOf.values())] } },
    select: { id: true, slaveId: true, verificationTip: true, startedAt: true, terminalAt: true },
  })

  const packageTasks = packageRows.map((pkg) => ({ pkg, task: pkg.tasks[0] ?? null }))
  const taskIds = packageTasks.flatMap(({ task }) => (task === null ? [] : [task.id]))
  const [names, templates, implCounts, doneEvents] = await Promise.all([
    seatNames([...packageTasks.map(({ task }) => task?.assigneeId ?? null), delivery?.verifierSlaveId ?? null, ...verificationRuns.map((run) => run.slaveId)]),
    prisma.slaveTemplate.findMany({ where: { id: { in: [...new Set(packageRows.map((pkg) => pkg.templateId))] } }, select: { id: true, name: true } }),
    prisma.slaveRun.groupBy({ by: ['taskId'], where: { taskId: { in: taskIds }, kind: 'implementation' }, _count: { _all: true } }),
    prisma.executionEvent.findMany({ where: { workspaceId, taskId: { in: taskIds }, type: 'task_done' }, orderBy: { seq: 'asc' }, select: { taskId: true, payload: true } }),
  ])
  const templateName = new Map(templates.map((row) => [row.id, row.name] as const))
  const implOf = new Map(implCounts.map((row) => [row.taskId, row._count._all] as const))

  const packages: GoalReportPackage[] = packageTasks
    .map(({ pkg, task }): GoalReportPackage => {
      // Plan D3: git's list at each merge into the integration branch; a merge from before Plan 5
      // carries no `files`, and a package none of whose merges recorded one reads "not recorded".
      const merges = doneEvents.filter((event) => event.taskId === task?.id).map((event) => (event.payload ?? {}) as Record<string, unknown>)
      const recorded = merges.filter((payload) => Array.isArray(payload['files']))
      const files = new Set(recorded.flatMap((payload) => (payload['files'] as unknown[]).filter((file): file is string => typeof file === 'string')))
      const worker = pkg.reports[0] === undefined ? null : readWorkerReport(pkg.reports[0].runId, pkg.reports[0].report)
      return {
        key: pkg.key,
        title: pkg.title,
        isIntegration: pkg.isIntegration,
        requirementKeys: pkg.requirementKeys,
        ownedPaths: pkg.ownedPaths,
        dependsOn: pkg.dependsOn,
        persona: templateName.get(pkg.templateId) ?? null,
        seat: task?.assigneeId == null ? null : (names.get(task.assigneeId) ?? null),
        taskId: task?.id ?? null,
        taskStatus: task?.status ?? null,
        integrated: task?.integratedAt != null,
        mergedFiles: recorded.length === 0 ? null : [...files].sort(byText),
        mergedFilesTruncated: recorded.some((payload) => typeof payload['filesTotal'] === 'number' && payload['filesTotal'] > (payload['files'] as unknown[]).length),
        reportedFiles: worker?.files ?? null,
        report: worker?.report ?? null,
        implementationRuns: task === null ? 0 : (implOf.get(task.id) ?? 0),
      }
    })
    .sort((a, b) => byText(a.key, b.key))

  const items = set === null ? null : requirementItemsSchema.safeParse(set.items)
  const requirements: GoalReportRequirement[] | null =
    items === null || !items.success
      ? null
      : items.data.map((item) => {
          const mine = counted.filter((row) => row.key === item.key)
          const latest = mine.at(-1)
          return {
            key: item.key,
            text: item.text,
            source: item.source,
            packageKey: packages.find((pkg) => pkg.requirementKeys.includes(item.key))?.key ?? null,
            verdict:
              latest === undefined
                ? null
                : { round: latest.round, runId: latest.runId, status: latest.status as GoalReportVerdictStatus, check: latest.check, output: latest.output, reason: latest.reason },
            history: mine.map((row) => ({ round: row.round, status: row.status as GoalReportVerdictStatus })),
          }
        })

  const rounds: GoalReportRound[] = [...writerOf.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, runId]) => {
      const run = verificationRuns.find((row) => row.id === runId)
      const rows = counted.filter((row) => row.round === n)
      return {
        round: n,
        runId,
        verifier: run === undefined ? null : (names.get(run.slaveId) ?? null),
        commit: run?.verificationTip ?? null,
        at: (run?.terminalAt ?? run?.startedAt ?? rows[0]?.createdAt ?? new Date(0)).toISOString(),
        pass: rows.filter((row) => row.status === 'pass').length,
        fail: rows.filter((row) => row.status === 'fail').length,
        unverifiable: rows.filter((row) => row.status === 'unverifiable').length,
      }
    })

  const decisionAction = decisionRow === null ? null : actionSchema.safeParse(decisionRow.action)
  const decision =
    decisionRow === null || decisionAction === null || !decisionAction.success || decisionAction.data.kind !== 'conduct'
      ? null
      : {
          mode: decisionAction.data.mode,
          reason: decisionRow.rationale,
          decidedBy: decisionRow.decidedBy === 'model' ? ('model' as const) : ('rules' as const),
          fallback: conducted?.payload['fallback'] === true,
          at: decisionRow.createdAt.toISOString(),
        }

  // Plan D2: `merged` is its own state, read from `mergedAt`; every other state is the delivery's.
  // Final wave I1: no delivery but a conduct decision or packages is a version conducted under
  // Plans 2/3 (Plan 4a writes the delivery in the packages' own transaction), not one waiting to be.
  const state: GoalReportState =
    delivery === null
      ? decisionRow !== null || packageRows.length > 0
        ? 'conducted_without_delivery'
        : 'not_conducted'
      : delivery.mergedAt !== null
        ? 'merged'
        : delivery.status
  const mergedBy = merged?.payload['by']
  // The question ids scope both the trail and the spend (Task 3): a Supervisor decision about one
  // of the version's questions is about the version, so both must see the same set.
  const questions = await versionQuestions(scope)
  const questionIds = questions.map((q) => q.id)
  const [spend, trail] = await Promise.all([versionSpend(scope, questionIds), versionTrail(scope, questionIds)])

  const stamps = [
    ...trail.entries.map((entry) => entry.at),
    ...rounds.map((r) => r.at),
    ...questions.flatMap((q) => [q.at, ...(q.answer === null ? [] : [q.answer.at])]),
    ...[delivery?.acceptedAt, delivery?.mergedAt].flatMap((at) => (at == null ? [] : [at.toISOString()])),
  ].sort(byText)

  return ok({
    workspaceId,
    workspaceName: workspace.name,
    baseBranch: workspace.baseBranch,
    goalVersion,
    versions,
    goal: goalRow?.text ?? null,
    state,
    delivery:
      delivery === null
        ? null
        : {
            integrationBranch: delivery.integrationBranch,
            baseBranch: workspace.baseBranch,
            baseCommit: delivery.baseCommit,
            verifiedCommit: delivery.verifiedCommit,
            round: delivery.round,
            roundBase: delivery.roundBase,
            roundCap: workspace.verificationRoundCap,
            acceptedAt: delivery.acceptedAt?.toISOString() ?? null,
            mergedAt: delivery.mergedAt?.toISOString() ?? null,
            merge:
              merged === null || (mergedBy !== 'system' && mergedBy !== 'human')
                ? null
                : { by: mergedBy, commit: String(merged.payload['commit'] ?? ''), into: String(merged.payload['into'] ?? workspace.baseBranch) },
            mergeError: delivery.mergeError,
            needsHumanReason: delivery.needsHumanReason,
            abandonedAt: abandoned?.ts.toISOString() ?? null,
          },
    decision,
    requirements,
    rounds,
    packages,
    verifier: scope.verifier,
    questions,
    spend,
    trail: trail.entries,
    trailOmitted: trail.omitted,
    asOf: stamps.at(-1) ?? null,
  })
}
