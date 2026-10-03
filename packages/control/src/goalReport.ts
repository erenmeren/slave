import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  GOAL_REPORT_DENIALS_MAX,
  GOAL_REPORT_HANDOFFS_MAX,
  actionSchema,
  err,
  handOffFromName,
  ok,
  personDecisionSchema,
  personText,
  requirementItemsSchema,
  smokeStoppedByAbandon,
  type GoalReport,
  type GoalReportDenial,
  type GoalReportPackage,
  type GoalReportPersonDecision,
  type GoalReportRequirement,
  type GoalReportRound,
  type GoalReportHandOff,
  type GoalReportSharedDecision,
  type GoalReportSmoke,
  type GoalReportState,
  type GoalReportVerdictStatus,
  type GoalReportWorkerReport,
  type Result,
} from '@slave-of-ai/domain'
import { loadVersionScope, seatNames, versionQuestions, versionSubject, versionTrail } from './goalReportTrail.js'
import { versionSpend } from './goalReportSpend.js'
import { handOffViews, recordedHandOffStatus } from './handOffs.js'
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

  // Skeleton spec S7 (plan B D10): every smoke attempt of the version, oldest first.
  const smokeRows = delivery === null ? [] : await prisma.smokeAttempt.findMany({ where: { goalDeliveryId: delivery.id }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] })
  const packageOfTask = new Map(scope.tasks.map((task) => [task.taskId, task.packageKey] as const))
  const smoke = smokeRows.map(
    (row): GoalReportSmoke => ({
      attemptId: row.id,
      round: row.round,
      outcome: row.status,
      exitCode: row.exitCode,
      durationMs: row.durationMs,
      tip: row.tip,
      output: row.output,
      at: (row.endedAt ?? row.startedAt).toISOString(),
      reworkedPackage: row.reworkedTaskId === null ? null : (packageOfTask.get(row.reworkedTaskId) ?? null),
      handOff:
        row.handOffTaskId === null
          ? null
          : { toPackage: packageOfTask.get(row.handOffTaskId) ?? 'a package', path: row.handOffPath ?? '', change: row.handOffChange ?? '' },
      // Task 4: abandon SIGTERMs a running attempt, which then records `failed` (exit 143) with
      // nothing sent back. The trail decides it by the same rule (final review 5b).
      stoppedByAbandon: smokeStoppedByAbandon(
        { endedAt: row.endedAt, sentBack: row.reworkedTaskId !== null },
        delivery?.status === 'abandoned' ? (abandoned?.ts ?? null) : null,
      ),
    }),
  )
  // Supervisor-as-conductor spec C2/C3: the version's hand-offs and shared decisions, oldest first.
  // Every hand-off row is listed, so an expired one (which has no event) shows too.
  const [handOffRows, decisionRows] = await Promise.all([
    prisma.packageHandOff.findMany({ where: { workspaceId, goalVersion }, orderBy: [{ createdAt: 'asc' }, { sourceKey: 'asc' }] }),
    prisma.goalDecision.findMany({ where: { workspaceId, goalVersion }, orderBy: [{ createdAt: 'asc' }, { titleKey: 'asc' }] }),
  ])
  // Pre-flight F65: who a hand-off came from, named as the workers' prompts name it -- a person's
  // request or late answer as the operator's, a worker's late answer by its seat, the Supervisor's as
  // the conductor's (`handOffViews` reads the late answers' seats in one query).
  const listed = handOffRows.slice(0, GOAL_REPORT_HANDOFFS_MAX)
  const views = await handOffViews(listed)
  const handOffs = listed.map(
    (row, index): GoalReportHandOff => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      source: row.source,
      fromPackage: row.fromPackageKey,
      from: handOffFromName(views[index] ?? { id: row.id, from: row.fromPackageKey, path: row.path, packageKey: row.packageKey, change: row.change }),
      toPackage: row.toPackageKey,
      path: row.path,
      packageKey: row.packageKey,
      change: row.change,
      status: recordedHandOffStatus(row),
      note: row.note,
    }),
  )
  // Human cards H1/H2 (plan B D3): what a person decided on a card about one of the version's
  // questions, oldest first -- every claimed card (`approved` or `rejected`; a `failed` one's decision
  // did not take). `personDecision` keeps the person's raw words (Task 3 carry): only its summary is
  // reported, read back through `personText`, so no page or prompt reads a marker from it.
  const decidedRows = await prisma.$queryRaw<{ resolvedAt: Date | null; createdAt: Date; subjectId: string; personDecision: unknown }[]>`
    SELECT "resolvedAt", "createdAt", "subjectId", "personDecision" FROM "SupervisorDecision"
    WHERE "workspaceId" = ${workspaceId} AND "personDecision" ->> 'goalVersion' = ${String(goalVersion)} AND status IN ('approved', 'rejected')
    ORDER BY COALESCE("resolvedAt", "createdAt"), id`
  const personDecisions = decidedRows.flatMap((row): GoalReportPersonDecision[] => {
    // A row the schema cannot read is left out rather than trusted (`personDecisionSchema`'s rule).
    const parsed = personDecisionSchema.safeParse(row.personDecision)
    if (!parsed.success) return []
    const summary = personText(parsed.data.summary, 500)
    if (summary === '') return []
    const grant = parsed.data.grant
    return [{ at: (row.resolvedAt ?? row.createdAt).toISOString(), questionId: row.subjectId, kind: parsed.data.decision.kind, summary, grant: grant === undefined ? null : { path: grant.path, fromKey: grant.fromKey, toKey: grant.toKey } }]
  })
  const decisions = decisionRows.map((row): GoalReportSharedDecision => ({ title: row.title, decision: row.decision, source: row.source, at: row.createdAt.toISOString() }))
  // Skeleton spec S9 (plan B D10): the denials of the version's runs -- its package tasks' and its verification runs'.
  const versionRuns = await prisma.slaveRun.findMany({
    where: { OR: [{ taskId: { in: scope.tasks.map((task) => task.taskId) } }, ...(delivery === null ? [] : [{ goalDeliveryId: delivery.id }])] },
    select: { id: true, taskId: true },
  })
  const taskOfRun = new Map(versionRuns.map((run) => [run.id, run.taskId] as const))
  const denialRows = await prisma.executionEvent.findMany({
    where: { runId: { in: versionRuns.map((run) => run.id) }, type: { in: ['guardrail_tripped', 'run_tool_denied'] } },
    orderBy: { seq: 'asc' },
    select: { runId: true, type: true, ts: true, payload: true },
  })
  const denials = denialRows.flatMap((row): GoalReportDenial[] => {
    const p = (row.payload ?? {}) as Record<string, unknown>
    const taskId = row.runId === null ? null : (taskOfRun.get(row.runId) ?? null)
    const base = { at: row.ts.toISOString(), runId: row.runId ?? '', packageKey: taskId === null ? null : (packageOfTask.get(taskId) ?? null) }
    if (row.type === 'guardrail_tripped') {
      // Only the permission mode's refusals are denied tool calls; every other trip is a guardrail's own.
      return p['guardrail'] === 'permission_mode' && typeof p['detail'] === 'string' ? [{ ...base, kind: 'permission_mode', detail: p['detail'] }] : []
    }
    const tool = typeof p['tool'] === 'string' ? p['tool'] : 'a tool'
    const capability = typeof p['capability'] === 'string' ? ` (${p['capability']})` : ''
    return [{ ...base, kind: 'permission_matrix', detail: `${tool}${capability} was refused by the permission matrix` }]
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
        releasedPaths: pkg.releasedPaths,
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
    ...smoke.map((attempt) => attempt.at),
    ...handOffs.map((h) => h.at),
    ...decisions.map((d) => d.at),
    ...personDecisions.map((d) => d.at),
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
    personDecisions,
    smoke,
    handOffs,
    handOffsOmitted: Math.max(0, handOffRows.length - GOAL_REPORT_HANDOFFS_MAX),
    decisions,
    deniedToolCalls: denials.slice(0, GOAL_REPORT_DENIALS_MAX),
    deniedToolCallsOmitted: Math.max(0, denials.length - GOAL_REPORT_DENIALS_MAX),
    spend,
    trail: trail.entries,
    trailOmitted: trail.omitted,
    asOf: stamps.at(-1) ?? null,
  })
}
