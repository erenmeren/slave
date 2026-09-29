/**
 * Conductor Plan 5, Task 4: one goal version's whole report, for every state it can be in (plan D1,
 * D2, D4), read from seeded rows -- no git, no model.
 */
import { prisma } from '@slave-of-ai/db/client'
import { reportCaveats } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { latestReportVersion, loadGoalReport, reportVersions } from '../../src/goalReport.js'

const TEMPLATE_NAME = 'Goal Report Test Backend Persona'
let templateIds: string[] = []

interface World {
  readonly workspaceId: string
  readonly alexSeat: string
  readonly samSeat: string
}

async function world(): Promise<World> {
  const template = await prisma.slaveTemplate.create({ data: { name: TEMPLATE_NAME, role: 'backend' } })
  templateIds.push(template.id)
  const workspace = await prisma.workspace.create({
    data: { name: 'Goal Report', repoPath: '/tmp/goal-report', baseBranch: 'main', verifyCommands: ['true'], setupCommands: [], delivery: 'conducted', goalVersion: 1, goal: 'Add CSV and JSON modes.' },
  })
  await prisma.goalVersion.create({ data: { workspaceId: workspace.id, version: 1, text: 'Add CSV and JSON modes.', sha256: 'x' } })
  await prisma.requirementSet.create({
    data: { workspaceId: workspace.id, goalVersion: 1, items: [{ key: 'R1', text: 'csv mode', source: 'Add CSV.' }, { key: 'R2', text: 'json mode', source: 'Add JSON.' }] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const alex = await prisma.person.create({ data: { name: 'Alex Report', templateId: template.id } })
  const sam = await prisma.person.create({ data: { name: 'Sam Report' } })
  const alexSeat = await prisma.slave.create({ data: { teamId: team.id, role: 'backend', runtimeRoles: ['implementer'], personId: alex.id } })
  const samSeat = await prisma.slave.create({ data: { teamId: team.id, role: 'reviewer', runtimeRoles: ['verifier'], personId: sam.id } })
  return { workspaceId: workspace.id, alexSeat: alexSeat.id, samSeat: samSeat.id }
}

type Status = 'integrating' | 'verifying' | 'accepted' | 'needs_human' | 'abandoned'

/** Conducted as one package holding both requirements, on a delivery in `status`. */
async function conduct(
  w: World,
  data: Partial<{ status: Status; mergedAt: Date; verifiedCommit: string; needsHumanReason: string; mergeError: string; round: number; taskStatus: 'running' | 'rework' | 'done' }> = {},
): Promise<{ readonly deliveryId: string; readonly packageId: string; readonly taskId: string }> {
  const delivery = await prisma.goalDelivery.create({
    data: {
      workspaceId: w.workspaceId, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1-x', baseCommit: 'b'.repeat(40), verifierSlaveId: w.samSeat,
      status: data.status ?? 'integrating', mergedAt: data.mergedAt ?? null, verifiedCommit: data.verifiedCommit ?? null, needsHumanReason: data.needsHumanReason ?? null,
      mergeError: data.mergeError ?? null, round: data.round ?? 0,
      acceptedAt: data.status === 'accepted' ? new Date('2026-09-29T10:05:00Z') : null,
    },
  })
  await prisma.supervisorDecision.create({
    data: {
      workspaceId: w.workspaceId, situationKind: 'conduct', subjectId: `${w.workspaceId}:v1`, situation: {}, candidates: [], chosenIndex: 0,
      action: { kind: 'conduct', goalVersion: 1, mode: 'single', packageKeys: ['report'] }, rationale: 'fits one session', tier: 'applied', status: 'applied', decidedBy: 'model',
    },
  })
  await appendEvent({ type: 'workspace.conducted', workspaceId: w.workspaceId, actor: 'system', payload: { version: 1, mode: 'single', packages: ['report'], decisionId: 'd', fallback: false } })
  const pkg = await prisma.workPackage.create({
    data: { workspaceId: w.workspaceId, goalVersion: 1, key: 'report', title: 'Report modes', requirementKeys: ['R1', 'R2'], ownedPaths: ['src/**'], interface: '', templateId: templateIds.at(-1) ?? 'tpl' },
  })
  const done = (data.taskStatus ?? 'done') === 'done'
  const task = await prisma.task.create({
    data: {
      workspaceId: w.workspaceId, title: 'Report modes', description: 'x', status: data.taskStatus ?? 'done', requiredRole: 'implementer', maxAttempts: 3,
      workPackageId: pkg.id, goalVersion: 1, assigneeId: w.alexSeat, integratedAt: done ? new Date() : null,
    },
  })
  return { deliveryId: delivery.id, packageId: pkg.id, taskId: task.id }
}

/** One verification round: a run by Sam at `tip`, with one row per key. */
async function round(w: World, deliveryId: string, n: number, tip: string, statuses: Readonly<Record<'R1' | 'R2', 'pass' | 'fail' | 'unverifiable'>>): Promise<string> {
  const run = await prisma.slaveRun.create({
    data: { slaveId: w.samSeat, kind: 'verification', status: 'succeeded', goalDeliveryId: deliveryId, verificationTip: tip, terminalAt: new Date(`2026-09-29T10:0${String(n)}:00Z`) },
  })
  for (const key of ['R1', 'R2'] as const) {
    await prisma.verificationResult.create({
      data: {
        workspaceId: w.workspaceId, goalDeliveryId: deliveryId, goalVersion: 1, round: n, runId: run.id, key, status: statuses[key],
        check: `check ${key}`, output: `out ${key} r${String(n)}`, reason: statuses[key] === 'pass' ? '' : `${key} broke`,
      },
    })
  }
  return run.id
}

const HAND_MERGE_UNVERIFIED = 'was not itself verified'

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "ConductorCall", "VerificationResult", "RunReport", "SlaveRun", "Task", "WorkPackage", "GoalDelivery", "RequirementSet", "GoalVersion", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
})

afterEach(async (): Promise<void> => {
  await prisma.slaveTemplate.deleteMany({ where: { id: { in: templateIds } } })
  templateIds = []
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('loadGoalReport', () => {
  it('refuses an unknown workspace, and a version with no requirements and no delivery', async (): Promise<void> => {
    expect(await loadGoalReport('nope', 1)).toEqual({ ok: false, error: { kind: 'workspace_not_found', workspaceId: 'nope' } })
    const w = await world()
    expect(await loadGoalReport(w.workspaceId, 2)).toEqual({ ok: false, error: { kind: 'goal_version_not_found', workspaceId: w.workspaceId, goalVersion: 2 } })
  })

  it('refuses every version of a planned project, which has no report', async (): Promise<void> => {
    const planned = await prisma.workspace.create({
      data: { name: 'Planned Report', repoPath: '/tmp/planned-report', verifyCommands: ['true'], setupCommands: [], goalVersion: 1, goal: 'Plan it.' },
    })
    await prisma.goalVersion.create({ data: { workspaceId: planned.id, version: 1, text: 'Plan it.', sha256: 'y' } })
    expect(await loadGoalReport(planned.id, 1)).toEqual({ ok: false, error: { kind: 'goal_version_not_found', workspaceId: planned.id, goalVersion: 1 } })
    expect(await reportVersions(planned.id)).toEqual([])
    expect(await latestReportVersion(planned.id)).toBe(null)
  })

  it('reports a version that has requirements and nothing else as not conducted', async (): Promise<void> => {
    const w = await world()
    const report = await loadGoalReport(w.workspaceId, 1)
    expect(report.ok && report.value).toEqual(
      expect.objectContaining({
        state: 'not_conducted',
        delivery: null,
        decision: null,
        goal: 'Add CSV and JSON modes.',
        packages: [],
        rounds: [],
        requirements: [
          { key: 'R1', text: 'csv mode', source: 'Add CSV.', packageKey: null, verdict: null, history: [] },
          { key: 'R2', text: 'json mode', source: 'Add JSON.', packageKey: null, verdict: null, history: [] },
        ],
      }),
    )
    expect(await reportVersions(w.workspaceId)).toEqual([1])
    expect(await latestReportVersion(w.workspaceId)).toBe(1)
  })

  it('lists the versions with requirements or a delivery, ascending, and v10 sorts after v2', async (): Promise<void> => {
    const w = await world()
    await prisma.requirementSet.create({ data: { workspaceId: w.workspaceId, goalVersion: 10, items: [{ key: 'R1', text: 't', source: 's' }] } })
    await prisma.goalDelivery.create({ data: { workspaceId: w.workspaceId, goalVersion: 2, integrationBranch: 'slaveofai/goal-v2-x', baseCommit: 'b'.repeat(40) } })
    expect(await reportVersions(w.workspaceId)).toEqual([1, 2, 10])
    expect(await latestReportVersion(w.workspaceId)).toBe(10)
    // A delivery without a requirement set still has a report: requirements read as not extracted.
    const v2 = await loadGoalReport(w.workspaceId, 2)
    expect(v2.ok && v2.value.state).toBe('integrating')
    expect(v2.ok && v2.value.requirements).toBe(null)
    expect(v2.ok && v2.value.versions).toEqual([1, 2, 10])
  })

  it('reports a version being built, before any round', async (): Promise<void> => {
    const w = await world()
    await conduct(w, { status: 'integrating', taskStatus: 'running' })
    const result = await loadGoalReport(w.workspaceId, 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.state).toBe('integrating')
    expect(result.value.rounds).toEqual([])
    expect(result.value.requirements?.map((r) => [r.key, r.packageKey, r.verdict])).toEqual([
      ['R1', 'report', null],
      ['R2', 'report', null],
    ])
    expect(result.value.packages[0]).toEqual(expect.objectContaining({ taskStatus: 'running', integrated: false, mergedFiles: null, reportedFiles: null, report: null }))
    expect(result.value.decision).toEqual(expect.objectContaining({ mode: 'single', reason: 'fits one session', decidedBy: 'model', fallback: false }))
    expect(result.value.trail.map((e) => e.text)).toContain('Size decision: one package does the whole goal.')
    expect(reportCaveats(result.value)).toContain('No verification round has run yet: no requirement is verified.')
  })

  it('reports a version being verified again, with the last round and a package reworked since', async (): Promise<void> => {
    const w = await world()
    const c = await conduct(w, { status: 'verifying', round: 1, taskStatus: 'rework' })
    await round(w, c.deliveryId, 1, 'a'.repeat(40), { R1: 'pass', R2: 'fail' })
    const result = await loadGoalReport(w.workspaceId, 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.state).toBe('verifying')
    expect(result.value.requirements?.map((r) => r.verdict?.status)).toEqual(['pass', 'fail'])
    expect(reportCaveats(result.value).some((line) => line.includes('may change'))).toBe(true)
  })

  it('reports an accepted version waiting to be merged, with its merge error', async (): Promise<void> => {
    const w = await world()
    const c = await conduct(w, { status: 'accepted', round: 1, verifiedCommit: 'a'.repeat(40), mergeError: 'main moved' })
    await round(w, c.deliveryId, 1, 'a'.repeat(40), { R1: 'pass', R2: 'pass' })
    const result = await loadGoalReport(w.workspaceId, 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.state).toBe('accepted')
    expect(result.value.delivery).toEqual(
      expect.objectContaining({ acceptedAt: '2026-09-29T10:05:00.000Z', mergedAt: null, merge: null, mergeError: 'main moved', verifiedCommit: 'a'.repeat(40) }),
    )
  })

  it('reports a merged version: latest verdicts with history, rounds, the package with its files, the hand merge, the verifier', async (): Promise<void> => {
    const w = await world()
    const c = await conduct(w, { status: 'accepted', mergedAt: new Date('2026-09-29T10:06:00Z'), verifiedCommit: 'c'.repeat(40), round: 2 })
    await round(w, c.deliveryId, 1, 'a'.repeat(40), { R1: 'pass', R2: 'fail' })
    const r2 = await round(w, c.deliveryId, 2, 'c'.repeat(40), { R1: 'pass', R2: 'pass' })
    const impl = await prisma.slaveRun.create({ data: { taskId: c.taskId, slaveId: w.alexSeat, status: 'succeeded' } })
    await prisma.runReport.create({
      data: { runId: impl.id, taskId: c.taskId, workPackageId: c.packageId, report: { requirements: [{ key: 'R1', status: 'done', evidence: 'e' }, { key: 'R2', status: 'partial', evidence: '' }], filesTouched: ['src/csv.py'], workflow: [{ step: 1, done: true, note: '' }, { step: 2, done: false, note: '' }], questions: [] } },
    })
    await appendEvent({ type: 'task.done', workspaceId: w.workspaceId, taskId: c.taskId, actor: 'system', payload: { branch: 'b1', files: ['src/csv.py'], filesTotal: 1 } })
    await appendEvent({ type: 'task.done', workspaceId: w.workspaceId, taskId: c.taskId, actor: 'system', payload: { branch: 'b1', files: ['src/json.py', 'src/csv.py'], filesTotal: 2 } })
    await appendEvent({ type: 'workspace.goal_merged', workspaceId: w.workspaceId, actor: 'human', payload: { version: 1, branch: 'slaveofai/goal-v1-x', into: 'main', commit: 'd'.repeat(40), by: 'human' } })

    const result = await loadGoalReport(w.workspaceId, 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const report = result.value
    expect(report.state).toBe('merged')
    expect(report.delivery).toEqual(expect.objectContaining({ merge: { by: 'human', commit: 'd'.repeat(40), into: 'main' }, verifiedCommit: 'c'.repeat(40), baseBranch: 'main', roundCap: 3 }))
    expect(report.decision).toEqual(expect.objectContaining({ mode: 'single', reason: 'fits one session', decidedBy: 'model', fallback: false }))
    expect(report.requirements?.[1]).toEqual({
      key: 'R2', text: 'json mode', source: 'Add JSON.', packageKey: 'report',
      verdict: { round: 2, runId: r2, status: 'pass', check: 'check R2', output: 'out R2 r2', reason: '' },
      history: [{ round: 1, status: 'fail' }, { round: 2, status: 'pass' }],
    })
    expect(report.rounds.map((r) => [r.round, r.verifier, r.commit, r.pass, r.fail])).toEqual([
      [1, 'Sam Report', 'a'.repeat(40), 1, 1],
      [2, 'Sam Report', 'c'.repeat(40), 2, 0],
    ])
    expect(report.packages).toEqual([
      expect.objectContaining({
        key: 'report', seat: 'Alex Report', persona: TEMPLATE_NAME, taskStatus: 'done', integrated: true,
        mergedFiles: ['src/csv.py', 'src/json.py'], mergedFilesTruncated: false, reportedFiles: ['src/csv.py'],
        report: { runId: impl.id, requirements: [{ key: 'R1', status: 'done', evidence: 'e' }, { key: 'R2', status: 'partial', evidence: '' }], workflowDone: 1, workflowTotal: 2 },
        implementationRuns: 1,
      }),
    ])
    expect(report.verifier).toBe('Sam Report')
    // The newest fact: the seeded merge stamp or the newest event, whichever the clock made later.
    expect(report.asOf).toBe([report.trail.at(-1)?.at ?? '', '2026-09-29T10:06:00.000Z'].sort().at(-1))
    expect(report.trail.map((e) => e.text)).toContain('Merged into main by a person (commit dddddddddddd).')
    // Plan D2: the hand merge landed commit d, not the verified commit c, so the report flags it.
    expect(reportCaveats(report).some((line) => line.includes(HAND_MERGE_UNVERIFIED))).toBe(true)
  })

  it('does not flag a merge that landed the verified commit itself', async (): Promise<void> => {
    const w = await world()
    const c = await conduct(w, { status: 'accepted', mergedAt: new Date('2026-09-29T10:06:00Z'), verifiedCommit: 'c'.repeat(40), round: 1 })
    await round(w, c.deliveryId, 1, 'c'.repeat(40), { R1: 'pass', R2: 'pass' })
    await appendEvent({ type: 'workspace.goal_merged', workspaceId: w.workspaceId, actor: 'system', payload: { version: 1, branch: 'slaveofai/goal-v1-x', into: 'main', commit: 'c'.repeat(40), by: 'system' } })
    const result = await loadGoalReport(w.workspaceId, 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.state).toBe('merged')
    expect(result.value.delivery?.merge).toEqual({ by: 'system', commit: 'c'.repeat(40), into: 'main' })
    expect(reportCaveats(result.value).some((line) => line.includes(HAND_MERGE_UNVERIFIED))).toBe(false)
  })

  it('counts, per round, only the rows of the run that wrote last (plan D4)', async (): Promise<void> => {
    const w = await world()
    const c = await conduct(w, { status: 'verifying', round: 1 })
    await round(w, c.deliveryId, 1, 'a'.repeat(40), { R1: 'fail', R2: 'fail' })
    const later = await round(w, c.deliveryId, 1, 'e'.repeat(40), { R1: 'pass', R2: 'fail' })
    const result = await loadGoalReport(w.workspaceId, 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.rounds.map((r) => [r.round, r.runId, r.commit, r.pass, r.fail])).toEqual([[1, later, 'e'.repeat(40), 1, 1]])
    expect(result.value.requirements?.[0]?.history).toEqual([{ round: 1, status: 'pass' }])
  })

  it('reports a stopped version with its reason and the unverifiable verdict', async (): Promise<void> => {
    const w = await world()
    const c = await conduct(w, { status: 'needs_human', round: 1, needsHumanReason: 'only unverifiable items: R2' })
    await round(w, c.deliveryId, 1, 'a'.repeat(40), { R1: 'pass', R2: 'unverifiable' })
    const report = await loadGoalReport(w.workspaceId, 1)
    expect(report.ok && report.value.state).toBe('needs_human')
    expect(report.ok && report.value.delivery?.needsHumanReason).toBe('only unverifiable items: R2')
    expect(report.ok && report.value.requirements?.[1]?.verdict?.status).toBe('unverifiable')
  })

  it('reports an abandoned version with when it was abandoned', async (): Promise<void> => {
    const w = await world()
    await conduct(w, { status: 'abandoned' })
    const event = await appendEvent({ type: 'workspace.goal_abandoned', workspaceId: w.workspaceId, actor: 'human', payload: { version: 1, cancelled: [] } })
    const report = await loadGoalReport(w.workspaceId, 1)
    expect(report.ok && report.value.state).toBe('abandoned')
    expect(report.ok && report.value.delivery?.abandonedAt).toBe(event.ts)
  })

  it('says a package merged before Plan 5 has no recorded files', async (): Promise<void> => {
    const w = await world()
    const c = await conduct(w)
    await appendEvent({ type: 'task.done', workspaceId: w.workspaceId, taskId: c.taskId, actor: 'system', payload: { branch: 'b1' } })
    const report = await loadGoalReport(w.workspaceId, 1)
    expect(report.ok && report.value.packages[0]?.mergedFiles).toBe(null)
  })

  it('marks a merged file list cut when a merge touched more files than it recorded', async (): Promise<void> => {
    const w = await world()
    const c = await conduct(w)
    await appendEvent({ type: 'task.done', workspaceId: w.workspaceId, taskId: c.taskId, actor: 'system', payload: { branch: 'b1', files: ['src/a.py'], filesTotal: 600 } })
    const report = await loadGoalReport(w.workspaceId, 1)
    expect(report.ok && report.value.packages[0]?.mergedFilesTruncated).toBe(true)
  })

  it("wires the version's question ids into both the trail and the spend (Task 3)", async (): Promise<void> => {
    const w = await world()
    const c = await conduct(w)
    const question = await prisma.slaveMessage.create({
      data: { workspaceId: w.workspaceId, taskId: c.taskId, slaveId: w.alexSeat, threadId: 't1', kind: 'question', body: 'CSV or TSV?', expectsReply: true, actor: 'slave' },
    })
    await prisma.supervisorDecision.create({
      data: {
        workspaceId: w.workspaceId, situationKind: 'goal_needs_human', subjectId: question.id, situation: {}, candidates: [], chosenIndex: 0,
        action: { kind: 'no_action' }, rationale: 'the goal says CSV', tier: 'applied', status: 'applied', decidedBy: 'model',
        modelCalled: true, modelCostUsd: 0.25,
      },
    })
    const result = await loadGoalReport(w.workspaceId, 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.questions.map((q) => q.id)).toEqual([question.id])
    expect(result.value.spend.supervisorMeasuredUsd).toBe(0.25)
    expect(result.value.trail.some((e) => e.detail === 'the goal says CSV')).toBe(true)
  })
})
