import { prisma } from '@slave-of-ai/db/client'
import { CONDUCT_PER_CALL_CAP_USD, LEAD_TEAM_NAME, SUBORDINATE_TOOLS } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { analyticsDaysOf, analyticsView, buildStateOf } from '../../src/analyticsView.js'

const SUBORDINATE = SUBORDINATE_TOOLS[0] ?? ''
const NOW = new Date()
const DAY = 86_400_000
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY)
const dayOf = (date: Date): string => date.toISOString().slice(0, 10)

interface Lead {
  readonly workspaceId: string
  readonly deliveryId: string
  readonly leadSeat: string
  readonly verifierSeat: string
  readonly taskId: string
}

/** A lead-flow project with one build and no session yet. */
async function leadProject(name: string, over: { readonly roster?: readonly string[]; readonly budgetUsd?: number; readonly leadState?: 'building' | 'delivered' | 'awaiting_decision'; readonly createdAt?: Date } = {}): Promise<Lead> {
  const ws = await prisma.workspace.create({ data: { name, repoPath: `/tmp/${name}`, verifyCommands: ['true'], setupCommands: [], flow: 'lead', delivery: 'conducted', goalVersion: 1, goal: 'Build it.', leadRoster: [...(over.roster ?? [])], budgetUsd: over.budgetUsd ?? null } })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: LEAD_TEAM_NAME } })
  const leadSeat = await prisma.slave.create({ data: { teamId: team.id, role: 'Lead', runtimeRoles: ['implementer'], personId: (await prisma.person.create({ data: { name: `Lead of ${name}` } })).id } })
  const verifierSeat = await prisma.slave.create({ data: { teamId: team.id, role: 'Verifier', runtimeRoles: ['verifier'], personId: (await prisma.person.create({ data: { name: `Verifier of ${name}` } })).id } })
  const delivery = await prisma.goalDelivery.create({
    data: { workspaceId: ws.id, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1', baseCommit: 'b'.repeat(40), leadState: over.leadState ?? 'building', ...(over.leadState === 'delivered' ? { status: 'accepted', mergedAt: NOW } : {}), ...(over.createdAt === undefined ? {} : { createdAt: over.createdAt }) },
  })
  const pkg = await prisma.workPackage.create({ data: { workspaceId: ws.id, goalVersion: 1, key: 'main', title: 'The whole goal', requirementKeys: [], ownedPaths: ['**'], interface: '', templateId: 'lead' } })
  const task = await prisma.task.create({ data: { workspaceId: ws.id, title: 'The whole goal', description: 'x', status: 'running', requiredRole: 'implementer', maxAttempts: 3, goalVersion: 1, workPackageId: pkg.id } })
  return { workspaceId: ws.id, deliveryId: delivery.id, leadSeat: leadSeat.id, verifierSeat: verifierSeat.id, taskId: task.id }
}

async function leadTurn(f: Lead, data: { readonly costUsd: number | null; readonly startedAt: Date; readonly endedAt: Date | null; readonly sessionId?: string }): Promise<{ readonly workspaceId: string; readonly taskId: string; readonly slaveId: string; readonly runId: string; readonly actor: 'slave' }> {
  const turn = await prisma.slaveRun.create({ data: { slaveId: f.leadSeat, taskId: f.taskId, status: data.endedAt === null ? 'working' : 'succeeded', leadTurn: 'build', sessionId: data.sessionId ?? null, costUsd: data.costUsd, startedAt: data.startedAt, endedAt: data.endedAt } })
  return { workspaceId: f.workspaceId, taskId: f.taskId, slaveId: f.leadSeat, runId: turn.id, actor: 'slave' }
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "EvidenceRecord", "ConductorCall", "SupervisorDecision", "SupervisorMessage", "Intake", "VerificationResult", "WorkPackage", "GoalDelivery", "Checkpoint", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('analyticsView', () => {
  it('reads nothing as nothing: no project, no day, no figure', async () => {
    const view = await analyticsView({ days: null, now: NOW })
    expect(view).toMatchObject({ days: null, since: null, projectId: null, projects: [], truncated: false })
    expect(view.money).toMatchObject({ totalUsd: 0, unmeasuredSessions: 0, liveSessions: 0, byDay: [], byProject: [], byBuild: [] })
    expect(view.work).toMatchObject({ steps: 0, byDay: [], leadTurns: 0, helperSessions: 0, checks: 0, averageDeliveredWorkedMs: null, builds: { delivered: 0, stopped: 0, waiting: 0, running: 0 } })
    expect(view.helpers).toEqual([])
    expect(view.evidence).toEqual({ profiles: [], models: [], records: 0, leadFlowRecords: 0 })
  })

  it('reads a project with a live turn honestly: a row of zeros, one open session, every day of the period', async () => {
    const f = await leadProject('fresh')
    await leadTurn(f, { costUsd: null, startedAt: ago(0), endedAt: null })
    const view = await analyticsView({ days: 7, now: NOW })
    expect(view.money.byDay).toHaveLength(7)
    expect(view.money.byDay.at(-1)?.day).toBe(dayOf(NOW))
    expect(view.money.totalUsd).toBe(0)
    expect(view.money.liveSessions).toBe(1)
    expect(view.money.byProject).toMatchObject([{ name: 'fresh', builds: 1, totalUsd: 0, liveSessions: 1, unmeasuredSessions: 0, budgetUsd: null }])
    expect(view.money.byBuild).toMatchObject([{ projectName: 'fresh', version: 1, state: 'Building', group: 'running', turns: 1, steps: 0, spentUsd: 0, liveSessions: 1 }])
    expect(view.work.builds).toEqual({ delivered: 0, stopped: 0, waiting: 0, running: 1 })
  })

  it('sums the money by what it paid for, per project and per day, a session on the day it ended', async () => {
    const a = await leadProject('alpha', { budgetUsd: 20 })
    const b = await leadProject('beta')
    await leadTurn(a, { costUsd: 4, startedAt: ago(2), endedAt: ago(1) })
    await leadTurn(a, { costUsd: 1, startedAt: ago(0.01), endedAt: NOW })
    await prisma.slaveRun.create({ data: { slaveId: a.verifierSeat, kind: 'verification', status: 'succeeded', goalDeliveryId: a.deliveryId, costUsd: 1.5, startedAt: ago(0.01), endedAt: NOW } })
    await prisma.conductorCall.create({ data: { workspaceId: a.workspaceId, goalVersion: 1, stage: 'requirements', outcome: 'ok', modelCostUsd: 0.25, createdAt: ago(1) } })
    await leadTurn(b, { costUsd: 2, startedAt: ago(1.2), endedAt: ago(1) })
    // Ended long before the period: in "everything", not in seven days.
    await leadTurn(b, { costUsd: 10, startedAt: ago(41), endedAt: ago(40) })

    const week = await analyticsView({ days: 7, now: NOW })
    expect(week.money).toMatchObject({ buildingUsd: 7, checkingUsd: 1.5, steeringUsd: 0.25, totalUsd: 8.75, unmeasuredSessions: 0, liveSessions: 0 })
    expect(week.money.byProject.map((row) => [row.name, row.buildingUsd, row.checkingUsd, row.steeringUsd, row.totalUsd, row.budgetUsd, row.budgetSpentUsd])).toEqual([
      ['alpha', 5, 1.5, 0.25, 6.75, 20, 6.75],
      ['beta', 2, 0, 0, 2, null, 0],
    ])
    const yesterday = week.money.byDay.find((day) => day.day === dayOf(ago(1)))
    expect(yesterday).toEqual({ day: dayOf(ago(1)), totalUsd: 6.25, byProject: [{ projectId: a.workspaceId, usd: 4.25 }, { projectId: b.workspaceId, usd: 2 }] })
    expect(week.money.byDay.reduce((total, day) => total + day.totalUsd, 0)).toBeCloseTo(8.75)
    // A build's own figures are whole, whatever the period.
    expect(week.money.byBuild.find((row) => row.projectName === 'beta')).toMatchObject({ turns: 2, spentUsd: 12 })

    const everything = await analyticsView({ days: null, now: NOW })
    expect(everything.money.totalUsd).toBe(18.75)
    expect(everything.money.byDay[0]?.day).toBe(dayOf(ago(40)))
    expect(everything.money.byDay.at(-1)?.day).toBe(dayOf(NOW))

    const one = await analyticsView({ days: null, projectId: b.workspaceId, now: NOW })
    expect(one.projectId).toBe(b.workspaceId)
    expect(one.projects).toHaveLength(2)
    expect(one.money.byProject.map((row) => row.name)).toEqual(['beta'])
    expect(one.money.totalUsd).toBe(12)
    // A project that does not exist is every project.
    expect((await analyticsView({ projectId: '00000000-0000-4000-8000-000000000000', now: NOW })).projectId).toBeNull()
  })

  it('counts what was not measured: a session that ended without a cost, unless a later turn of its session reported; an unmeasured call at its cap', async () => {
    const f = await leadProject('gaps')
    await leadTurn(f, { costUsd: null, startedAt: ago(0.5), endedAt: ago(0.4), sessionId: 's-1' })
    await leadTurn(f, { costUsd: 3, startedAt: ago(0.3), endedAt: ago(0.2), sessionId: 's-1' })
    await leadTurn(f, { costUsd: null, startedAt: ago(0.1), endedAt: NOW, sessionId: 's-2' })
    await prisma.conductorCall.create({ data: { workspaceId: f.workspaceId, goalVersion: 1, stage: 'requirements', outcome: 'failed', modelCostUsd: null, unmeasured: true } })
    const view = await analyticsView({ days: 7, now: NOW })
    expect(view.money.unmeasuredSessions).toBe(1)
    expect(view.money.byProject[0]).toMatchObject({ unmeasuredSessions: 1, buildingUsd: 3, steeringUsd: CONDUCT_PER_CALL_CAP_USD })
    expect(view.money.byBuild[0]).toMatchObject({ unmeasuredSessions: 1, turns: 3 })
  })

  it('counts the work in the database: steps per day, helper sessions, checks and their verdicts, builds by how they stand', async () => {
    const bea = await prisma.person.create({ data: { name: 'Bea Backend' } })
    const a = await leadProject('alpha', { roster: [bea.id], leadState: 'delivered' })
    const b = await leadProject('beta', { roster: [bea.id], leadState: 'awaiting_decision' })
    const turnA = await leadTurn(a, { costUsd: 2, startedAt: ago(0.2), endedAt: NOW })
    const turnB = await leadTurn(b, { costUsd: null, startedAt: ago(0.1), endedAt: null })
    await appendEvent({ ...turnA, type: 'run.tool_call', payload: { name: 'Edit', summary: 'Edit a.ts', toolUseId: 'call-0' } })
    await appendEvent({ ...turnA, type: 'run.tool_call', payload: { name: SUBORDINATE, summary: SUBORDINATE, toolUseId: 'call-1', subagent: 'bea-backend' } })
    await appendEvent({ ...turnA, type: 'run.tool_call', payload: { name: 'Bash', summary: 'Bash npm test', toolUseId: 'call-2', parentToolUseId: 'call-1' } })
    await appendEvent({ ...turnA, type: 'run.tool_result', payload: { toolUseId: 'call-2', toolName: 'Bash', outcome: 'error', errorClass: 'other', parentToolUseId: 'call-1' } })
    await appendEvent({ ...turnA, type: 'run.tool_call', payload: { name: SUBORDINATE, summary: SUBORDINATE, toolUseId: 'call-3', parentToolUseId: 'call-1' } })
    await appendEvent({ ...turnA, type: 'run.tool_call', payload: { name: 'Read', summary: 'Read b.ts', toolUseId: 'call-4', parentToolUseId: 'call-3' } })
    await appendEvent({ ...turnA, type: 'run.tool_call', payload: { name: SUBORDINATE, summary: SUBORDINATE, toolUseId: 'call-5' } })
    // The same call ids on another project's turn: never mixed up.
    await appendEvent({ ...turnB, type: 'run.tool_call', payload: { name: SUBORDINATE, summary: SUBORDINATE, toolUseId: 'call-1', subagent: 'bea-backend' } })
    await appendEvent({ ...turnB, type: 'run.tool_call', payload: { name: 'Bash', summary: 'Bash ls', toolUseId: 'call-2', parentToolUseId: 'call-1' } })
    await appendEvent({ ...turnB, type: 'run.tool_call', payload: { name: SUBORDINATE, summary: SUBORDINATE, toolUseId: 'x-1', subagent: 'somebody-gone' } })
    const check = await prisma.slaveRun.create({ data: { slaveId: a.verifierSeat, kind: 'verification', status: 'succeeded', goalDeliveryId: a.deliveryId, costUsd: 0.5, startedAt: ago(0.05), endedAt: NOW } })
    await appendEvent({ workspaceId: a.workspaceId, slaveId: a.verifierSeat, runId: check.id, actor: 'slave', type: 'run.tool_call', payload: { name: 'Bash', summary: 'Bash npm start', toolUseId: 'v-1' } })
    for (const [key, status] of [['R1', 'pass'], ['R2', 'pass'], ['R3', 'fail'], ['R4', 'unverifiable']] as const) {
      await prisma.verificationResult.create({ data: { workspaceId: a.workspaceId, goalDeliveryId: a.deliveryId, goalVersion: 1, round: 1, runId: check.id, key, status, check: 'c', output: 'o', reason: 'r' } })
    }

    const view = await analyticsView({ days: 7, now: NOW })
    expect(view.work).toMatchObject({ steps: 10, leadTurns: 2, helperSessions: 4, checks: 1, verdicts: { works: 2, fails: 1, unverifiable: 1 }, builds: { delivered: 1, stopped: 0, waiting: 1, running: 0 } })
    expect(view.work.byDay).toHaveLength(7)
    expect(view.work.byDay.reduce((total, day) => total + day.steps, 0)).toBe(10)
    expect(view.work.averageDeliveredWorkedMs).toBeGreaterThan(0)
    expect(view.money.byBuild.map((row) => [row.projectName, row.state, row.turns, row.helperSessions, row.steps])).toEqual(expect.arrayContaining([
      ['alpha', 'Delivered', 1, 2, 7],
      ['beta', 'Needs your decision', 1, 2, 3],
    ]))
    // The same person on two projects is one row; a helper of a helper counts for the first.
    expect(view.helpers.map((row) => [row.name, row.personId, row.sessions, row.steps, row.failedSteps, row.projects])).toEqual([
      ['Bea Backend', bea.id, 2, 4, 1, 2],
      ['General helper', null, 1, 0, 0, 1],
      ['somebody-gone', null, 1, 0, 0, 1],
    ])
    expect(view.helpers[0]?.lastAt).not.toBeNull()

    expect((await analyticsView({ days: 7, projectId: b.workspaceId, now: NOW })).helpers.map((row) => [row.name, row.sessions, row.steps])).toEqual([['Bea Backend', 1, 1], ['somebody-gone', 1, 0]])
  })

  it('reads the evidence tally with a rate only where enough were judged, and says which records a lead-built project wrote', async () => {
    const f = await leadProject('lead-built')
    const older = await prisma.workspace.create({ data: { name: 'older', repoPath: '/tmp/older', verifyCommands: ['true'], setupCommands: [] } })
    const record = (workspaceId: string, n: number, over: { readonly verifiedFirstPass?: boolean; readonly actualCostUsd?: number | null } = {}): Promise<unknown> =>
      prisma.evidenceRecord.create({
        data: { runId: `run-${workspaceId.slice(0, 4)}-${String(n)}`, workspaceId, slaveId: 'seat', profileKey: 'template:backend', profileName: 'Backend developer', model: 'opus', repositoryKey: workspaceId === older.id ? '/tmp/older' : '/tmp/lead-built', domains: ['general'], runKind: 'implementation', attempt: 1, outcome: 'succeeded', verifiedFirstPass: over.verifiedFirstPass ?? null, durationMs: 60_000, actualCostUsd: over.actualCostUsd === undefined ? 1 : over.actualCostUsd, costProvenance: over.actualCostUsd === null ? 'unmeasured' : 'reported' },
      })
    for (let n = 0; n < 5; n += 1) await record(older.id, n, { verifiedFirstPass: n < 4 })
    await record(f.workspaceId, 0, { actualCostUsd: null })

    const view = await analyticsView({ days: 7, now: NOW })
    expect(view.evidence.records).toBe(6)
    expect(view.evidence.leadFlowRecords).toBe(1)
    expect(view.evidence.profiles.map((line) => [line.name, line.repository, line.attempted, line.thin, line.firstPass, line.integrated, line.reportedUsd, line.unmeasuredRuns])).toEqual([
      ['Backend developer', '/tmp/older', 5, false, { pct: 80, judged: 5 }, { pct: null, judged: 0 }, 5, 0],
      ['Backend developer', '/tmp/lead-built', 1, true, { pct: null, judged: 0 }, { pct: null, judged: 0 }, null, 1],
    ])
    expect(view.evidence.models).toMatchObject([{ name: 'opus', repository: null, attempted: 6, thin: false, firstPass: { pct: 80, judged: 5 } }])
    expect((await analyticsView({ projectId: f.workspaceId, now: NOW })).evidence).toMatchObject({ records: 1, leadFlowRecords: 1 })
  })

  it('leaves an archived project with no figure out of the list, and keeps one that spent', async () => {
    const quiet = await leadProject('quiet-archived', { createdAt: ago(60) })
    const spent = await leadProject('spent-archived', { createdAt: ago(60) })
    await leadTurn(spent, { costUsd: 2, startedAt: ago(1.1), endedAt: ago(1) })
    await prisma.workspace.updateMany({ where: { id: { in: [quiet.workspaceId, spent.workspaceId] } }, data: { archivedAt: NOW } })
    const view = await analyticsView({ days: 7, now: NOW })
    expect(view.money.byProject.map((row) => [row.name, row.archived])).toEqual([['spent-archived', true]])
    expect(view.projects.map((project) => project.name).sort()).toEqual(['quiet-archived', 'spent-archived'])
  })
})

describe('analyticsDaysOf', () => {
  it('reads 7, 30 and all, and anything else as 30 days', () => {
    expect([analyticsDaysOf('7'), analyticsDaysOf('30'), analyticsDaysOf('all'), analyticsDaysOf(null), analyticsDaysOf('x')]).toEqual([7, 30, null, 30, 30])
  })
})

describe('buildStateOf', () => {
  const delivery = { goalVersion: 1, status: 'integrating', leadState: 'building', mergedAt: null } as const
  it('says a build in words and puts it in one of four piles', () => {
    expect(buildStateOf({ flow: 'lead', haltedReason: null, newest: true, delivery })).toEqual({ state: 'Building', group: 'running' })
    expect(buildStateOf({ flow: 'lead', haltedReason: 'emergency stop: engaged by a person', newest: true, delivery })).toEqual({ state: 'Paused', group: 'waiting' })
    expect(buildStateOf({ flow: 'lead', haltedReason: null, newest: false, delivery })).toEqual({ state: 'Replaced by a newer build', group: 'stopped' })
    expect(buildStateOf({ flow: 'lead', haltedReason: null, newest: true, delivery: { ...delivery, leadState: 'awaiting_decision', status: 'accepted' } })).toEqual({ state: 'Ready to merge', group: 'waiting' })
    expect(buildStateOf({ flow: 'lead', haltedReason: null, newest: true, delivery: { ...delivery, leadState: 'stopped' } })).toEqual({ state: 'Left unmerged', group: 'stopped' })
    expect(buildStateOf({ flow: 'packages', haltedReason: null, newest: true, delivery: { ...delivery, leadState: null, status: 'accepted', mergedAt: new Date() } })).toEqual({ state: 'Delivered', group: 'delivered' })
    expect(buildStateOf({ flow: 'packages', haltedReason: null, newest: true, delivery: { ...delivery, leadState: null, status: 'needs_human' } })).toEqual({ state: 'Needs a person', group: 'waiting' })
  })
})
