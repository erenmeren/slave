import { prisma } from '@slave-of-ai/db/client'
import { LEAD_TEAM_NAME } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { listProjects } from '../../src/projectList.js'
import { projectView } from '../../src/projectView.js'

const UNKNOWN = '00000000-0000-4000-8000-000000000000'
/** The vendor's name for the subordinate-session tool (lead-flow plan A L17). */
const SUBORDINATE = 'Agent'

interface Lead {
  readonly workspaceId: string
  readonly deliveryId: string
  readonly leadSeat: string
  readonly verifierSeat: string
  readonly taskId: string
}

/** A lead-flow project building its first build: two requirements, one check done, the lead live. */
async function leadProject(): Promise<Lead> {
  const ws = await prisma.workspace.create({
    data: { name: 'Lead project', repoPath: '/tmp/no-such-repo', verifyCommands: ['true'], setupCommands: [], flow: 'lead', delivery: 'conducted', autoMerge: true, budgetUsd: 20, goalTimeLimitMs: 5_400_000, goalVersion: 1, goal: 'Build a todo app.' },
  })
  await prisma.goalVersion.create({ data: { workspaceId: ws.id, version: 1, text: 'Build a todo app.', sha256: 'x' } })
  await prisma.requirementSet.create({ data: { workspaceId: ws.id, goalVersion: 1, items: [{ key: 'R1', text: 'add a todo', source: 'todo' }, { key: 'R2', text: 'delete a todo', source: 'todo' }] } })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: LEAD_TEAM_NAME } })
  const leadSeat = await prisma.slave.create({ data: { teamId: team.id, role: 'Lead', runtimeRoles: ['implementer'], model: 'claude-opus-5', provider: 'claude_code', personId: (await prisma.person.create({ data: { name: `Lead ${ws.id.slice(0, 8)}` } })).id } })
  const verifierSeat = await prisma.slave.create({ data: { teamId: team.id, role: 'Verifier', runtimeRoles: ['verifier'], personId: (await prisma.person.create({ data: { name: `Verifier ${ws.id.slice(0, 8)}` } })).id } })
  const delivery = await prisma.goalDelivery.create({
    data: { workspaceId: ws.id, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1', baseCommit: 'b'.repeat(40), status: 'integrating', leadState: 'building', round: 1, leadProgress: { disputed: ['R2'] } },
  })
  const pkg = await prisma.workPackage.create({ data: { workspaceId: ws.id, goalVersion: 1, key: 'main', title: 'The whole goal', requirementKeys: ['R1', 'R2'], ownedPaths: ['**'], interface: '', templateId: 'lead' } })
  const task = await prisma.task.create({ data: { workspaceId: ws.id, title: 'The whole goal', description: 'x', status: 'running', requiredRole: 'implementer', maxAttempts: 3, goalVersion: 1, workPackageId: pkg.id } })

  // One finished check: R1 works, R2 does not.
  const check = await prisma.slaveRun.create({ data: { slaveId: verifierSeat.id, kind: 'verification', status: 'succeeded', goalDeliveryId: delivery.id, verificationTip: 'c'.repeat(40), terminalAt: new Date(), endedAt: new Date(), costUsd: 1.5 } })
  await prisma.verificationResult.create({ data: { workspaceId: ws.id, goalDeliveryId: delivery.id, goalVersion: 1, round: 1, runId: check.id, key: 'R1', status: 'pass', check: 'curl /todos', output: '201', reason: 'it was added' } })
  await prisma.verificationResult.create({ data: { workspaceId: ws.id, goalDeliveryId: delivery.id, goalVersion: 1, round: 1, runId: check.id, key: 'R2', status: 'fail', check: 'curl -X DELETE /todos/1', output: '500', reason: 'the server failed' } })

  // The lead's live turn: it handed work to a helper, and the helper is running a command.
  const turn = await prisma.slaveRun.create({ data: { slaveId: leadSeat.id, taskId: task.id, status: 'working', leadTurn: 'rework', sessionId: 'session-1', costUsd: null } })
  const base = { workspaceId: ws.id, taskId: task.id, slaveId: leadSeat.id, runId: turn.id, actor: 'slave' as const }
  await appendEvent({ ...base, type: 'run.tool_call', payload: { name: 'Edit', summary: 'Edit /work/src/app.ts', toolUseId: 'call-0' } })
  await appendEvent({ ...base, type: 'run.tool_result', payload: { toolUseId: 'call-0', toolName: 'Edit', outcome: 'ok', errorClass: null } })
  await appendEvent({ ...base, type: 'run.tool_call', payload: { name: SUBORDINATE, summary: `${SUBORDINATE} fix the delete route`, toolUseId: 'call-1', subagent: 'backend-dev' } })
  await appendEvent({ ...base, type: 'run.tool_call', payload: { name: 'Bash', summary: 'Bash npm test', toolUseId: 'call-2', parentToolUseId: 'call-1' } })
  return { workspaceId: ws.id, deliveryId: delivery.id, leadSeat: leadSeat.id, verifierSeat: verifierSeat.id, taskId: task.id }
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "VerificationResult", "RequirementSet", "GoalVersion", "WorkPackage", "GoalDelivery", "Checkpoint", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('projectView (lead UX design section 10)', () => {
  it('reads a building lead project: its phase, settings, limits and its newest build', async () => {
    const f = await leadProject()
    const view = await projectView(f.workspaceId)
    expect(view.ok).toBe(true)
    if (!view.ok) return

    expect(view.value).toMatchObject({
      name: 'Lead project',
      flow: 'lead',
      phase: 'building',
      autoMerge: true,
      budgetUsd: 20,
      timeLimitMs: 5_400_000,
      leadModel: 'claude-opus-5',
      goal: 'Build a todo app.',
      goalVersion: 1,
      older: null,
    })
    expect(view.value.builds).toMatchObject([{ version: 1, leadState: 'building', stopReason: null }])
    expect(view.value.build).toMatchObject({ version: 1, leadState: 'building', status: 'integrating', branch: 'slaveofai/goal-v1', rounds: 1, disputed: ['R2'] })
    // The live turn's cost is not in yet, so the check's is all that is measured.
    expect(view.value.build?.spentUsd).toBe(1.5)
  })

  it('reads the proof: one row per requirement, a disputed key read as disputed', async () => {
    const f = await leadProject()
    const view = await projectView(f.workspaceId)
    if (!view.ok) throw new Error('unreachable')

    expect(view.value.build?.proof).toEqual([
      { key: 'R1', text: 'add a todo', result: 'pass', reason: 'it was added', check: 'curl /todos', output: '201', checks: 1 },
      { key: 'R2', text: 'delete a todo', result: 'disputed', reason: 'the server failed', check: 'curl -X DELETE /todos/1', output: '500', checks: 1 },
    ])
  })

  it('reads who is working: the lead waiting for its open helper, and the helper\'s own newest call', async () => {
    const f = await leadProject()
    const view = await projectView(f.workspaceId)
    if (!view.ok) throw new Error('unreachable')

    expect(view.value.build?.faces).toEqual([
      { id: expect.any(String), kind: 'lead', name: 'Lead', working: true, doing: 'Waiting for its helpers' },
      { id: 'call-1', kind: 'helper', name: 'backend-dev', working: true, doing: 'Running npm test' },
    ])
  })

  it('reads everybody on the build: the lead, its helper and the checker, with steps, sessions and cost', async () => {
    const f = await leadProject()
    const view = await projectView(f.workspaceId)
    if (!view.ok) throw new Error('unreachable')
    const build = view.value.build
    if (build === null) throw new Error('unreachable')

    expect(build.people.map((person) => [person.id, person.state, person.sessions, person.running, person.toolCalls])).toEqual([
      ['lead', 'working', 1, 1, 2],
      ['helper:backend-dev', 'working', 1, 1, 1],
      ['checker', 'done', 1, 0, 0],
    ])
    expect(build.people[0]).toMatchObject({ doing: 'Waiting for its helpers', costUsd: null })
    // A helper's cost is inside the lead's; the finished check reported its own.
    expect(build.people[1]).toMatchObject({ name: 'backend-dev', doing: 'Running npm test', costUsd: null })
    expect(build.people[2]).toMatchObject({ name: 'Checker', costUsd: 1.5 })
    expect(build.workingNow).toBe(2)
    expect(build.toolCalls).toBe(3)
    expect(build.turns).toMatchObject([{ turn: 'rework', status: 'working', costUsd: null, endedAt: null }])
    expect(build.spend).toMatchObject({ leadUsd: 0, proofUsd: 1.5, totalUsd: build.spentUsd })
    // Newest first: the helper's open call, the lead's hand-off (open), the lead's finished edit.
    expect(build.activity.map((line) => [line.who, line.kind, line.outcome])).toEqual([
      ['backend-dev', 'helper', null],
      ['Lead', 'lead', null],
      ['Lead', 'lead', 'ok'],
    ])
  })

  it('reads no estimate where no run holds one: every figure null or zero, nothing invented', async () => {
    const f = await leadProject()
    const view = await projectView(f.workspaceId)
    if (!view.ok || view.value.build === null) throw new Error('unreachable')
    const build = view.value.build
    expect(build.people.map((person) => [person.estimatedUsd, person.estimatedRunningUsd, person.unpricedModels])).toEqual([[null, null, []], [null, null, []], [null, null, []]])
    expect(build.turns[0]).toMatchObject({ estimatedUsd: null, unpricedModels: [] })
    expect(build.spend).toMatchObject({ estimatedRunningUsd: 0, estimatedRunningLeadUsd: 0, estimatedRunningProofUsd: 0, unpricedModels: [] })
  })

  it('reads the live estimate beside the reported spend: the lead\u2019s own part, each helper\u2019s by its call, and what is still running', async () => {
    const f = await leadProject()
    const estimate = (usd: number, own: number, byCall: Record<string, number>): object => ({ usd, own, byCall, messages: 9, unpricedMessages: 0, models: { 'claude-opus-5': usd }, unpriced: [] })
    // An ended first turn that reported $4: its estimate stays on the row, a helper's share inside it.
    const first = await prisma.slaveRun.create({ data: { slaveId: f.leadSeat, taskId: f.taskId, status: 'succeeded', leadTurn: 'build', sessionId: 'session-1', costUsd: 4, startedAt: new Date(Date.now() - 3_600_000), terminalAt: new Date(Date.now() - 1_800_000), endedAt: new Date(Date.now() - 1_800_000), costEstimate: estimate(3.6, 3, { 'call-old': 0.6 }) } })
    await appendEvent({ workspaceId: f.workspaceId, taskId: f.taskId, slaveId: f.leadSeat, runId: first.id, actor: 'slave', type: 'run.tool_call', payload: { name: SUBORDINATE, summary: `${SUBORDINATE} write the routes`, toolUseId: 'call-old', subagent: 'backend-dev' } })
    await appendEvent({ workspaceId: f.workspaceId, taskId: f.taskId, slaveId: f.leadSeat, runId: first.id, actor: 'slave', type: 'run.tool_result', payload: { toolUseId: 'call-old', toolName: SUBORDINATE, outcome: 'ok', errorClass: null } })
    // The live turn: $3.20 so far, $1.10 of it the helper it has open (`call-1`).
    await prisma.slaveRun.updateMany({ where: { taskId: f.taskId, leadTurn: 'rework' }, data: { costEstimate: estimate(3.2, 2.1, { 'call-1': 1.1 }) } })
    // The finished check keeps its own estimate too; it has reported, so none of it is "running".
    await prisma.slaveRun.updateMany({ where: { kind: 'verification' }, data: { costEstimate: estimate(1.4, 1.4, {}) } })

    const view = await projectView(f.workspaceId)
    if (!view.ok || view.value.build === null) throw new Error('unreachable')
    const build = view.value.build

    // Reported money is exactly what it was: the estimate is in none of it.
    expect(build.spentUsd).toBe(5.5)
    expect(build.spend).toMatchObject({ leadUsd: 4, proofUsd: 1.5, totalUsd: 5.5 })
    expect(build.spend).toMatchObject({ estimatedRunningUsd: 3.2, estimatedRunningLeadUsd: 3.2, estimatedRunningProofUsd: 0, unpricedModels: [] })

    expect(build.turns.map((turn) => [turn.turn, turn.costUsd, turn.estimatedUsd])).toEqual([['build', 4, 3.6], ['rework', null, 3.2]])
    const [lead, helper, checker] = build.people
    // The lead: both turns' estimates (6.8) less its helper's parts (1.7); running, the live turn's own.
    expect(lead).toMatchObject({ id: 'lead', costUsd: 4, estimatedUsd: 5.1, estimatedRunningUsd: 2.1 })
    // The helper: every session of it, the ended turn's too; running, the live turn's.
    expect(helper).toMatchObject({ id: 'helper:backend-dev', costUsd: null, sessions: 2, estimatedUsd: 1.7, estimatedRunningUsd: 1.1 })
    expect(checker).toMatchObject({ id: 'checker', costUsd: 1.5, estimatedUsd: 1.4, estimatedRunningUsd: null })

    const [item] = await listProjects()
    expect(item).toMatchObject({ spentUsd: 5.5, estimatedRunningUsd: 3.2 })
  })

  it('names a running model with no price instead of estimating it', async () => {
    const f = await leadProject()
    await prisma.slaveRun.updateMany({ where: { taskId: f.taskId, leadTurn: 'rework' }, data: { costEstimate: { usd: 0, own: 0, byCall: {}, messages: 4, unpricedMessages: 4, models: {}, unpriced: ['claude-new-9'] } } })
    const view = await projectView(f.workspaceId)
    if (!view.ok || view.value.build === null) throw new Error('unreachable')
    const build = view.value.build
    expect(build.turns[0]).toMatchObject({ estimatedUsd: null, unpricedModels: ['claude-new-9'] })
    expect(build.people[0]).toMatchObject({ estimatedUsd: null, estimatedRunningUsd: null, unpricedModels: ['claude-new-9'] })
    expect(build.spend).toMatchObject({ estimatedRunningUsd: 0, unpricedModels: ['claude-new-9'] })
    expect((await listProjects())[0]?.estimatedRunningUsd).toBe(0)
  })

  it('reads a paused lead and a helper whose call ended as not working, and counts a failed step', async () => {
    const f = await leadProject()
    const turn = await prisma.slaveRun.findFirstOrThrow({ where: { leadTurn: { not: null } } })
    const base = { workspaceId: f.workspaceId, taskId: f.taskId, slaveId: f.leadSeat, runId: turn.id, actor: 'slave' as const }
    await appendEvent({ ...base, type: 'run.tool_result', payload: { toolUseId: 'call-2', toolName: 'Bash', outcome: 'error', errorClass: null, parentToolUseId: 'call-1' } })
    await appendEvent({ ...base, type: 'run.tool_result', payload: { toolUseId: 'call-1', toolName: SUBORDINATE, outcome: 'ok', errorClass: null } })
    // Paused well after the helper's last step: a helper started in the background counts as at
    // work only while a step of its own is newer than the quiet window.
    await prisma.slaveRun.update({ where: { id: turn.id }, data: { status: 'paused', pausedAt: new Date(Date.now() + 10 * 60_000) } })

    const view = await projectView(f.workspaceId)
    if (!view.ok) throw new Error('unreachable')
    const people = view.value.build?.people ?? []
    expect(people[0]).toMatchObject({ id: 'lead', state: 'paused', doing: null })
    expect(people[1]).toMatchObject({ id: 'helper:backend-dev', state: 'done', running: 0, doing: null, failedCalls: 1 })
    expect(view.value.build?.workingNow).toBe(0)
  })

  it('keeps a helper started in the background at work while its own steps are fresh', async () => {
    const f = await leadProject()
    const turn = await prisma.slaveRun.findFirstOrThrow({ where: { leadTurn: { not: null } } })
    const base = { workspaceId: f.workspaceId, taskId: f.taskId, slaveId: f.leadSeat, runId: turn.id, actor: 'slave' as const }
    // The starting call answered at once; the helper's own step ended a moment ago.
    await appendEvent({ ...base, type: 'run.tool_result', payload: { toolUseId: 'call-1', toolName: SUBORDINATE, outcome: 'ok', errorClass: null } })
    await appendEvent({ ...base, type: 'run.tool_result', payload: { toolUseId: 'call-2', toolName: 'Bash', outcome: 'ok', errorClass: null, parentToolUseId: 'call-1' } })

    const view = await projectView(f.workspaceId)
    if (!view.ok) throw new Error('unreachable')
    expect(view.value.build?.people[1]).toMatchObject({ id: 'helper:backend-dev', state: 'working', running: 1 })
    expect(view.value.build?.workingNow).toBe(2)
  })

  it('lets a helper go once its call has a result, and shows a live check as the checker', async () => {
    const f = await leadProject()
    const turn = await prisma.slaveRun.findFirstOrThrow({ where: { leadTurn: { not: null } } })
    await appendEvent({ workspaceId: f.workspaceId, taskId: f.taskId, slaveId: f.leadSeat, runId: turn.id, actor: 'slave', type: 'run.tool_result', payload: { toolUseId: 'call-1', toolName: 'Agent', outcome: 'ok', errorClass: null } })
    await prisma.slaveRun.update({ where: { id: turn.id }, data: { status: 'succeeded', endedAt: new Date() } })
    const live = await prisma.slaveRun.create({ data: { slaveId: f.verifierSeat, kind: 'verification', status: 'working', goalDeliveryId: f.deliveryId } })
    await appendEvent({ workspaceId: f.workspaceId, slaveId: f.verifierSeat, runId: live.id, actor: 'slave', type: 'run.tool_call', payload: { name: 'Bash', summary: 'Bash npm start', toolUseId: 'v-1' } })

    const view = await projectView(f.workspaceId)
    if (!view.ok) throw new Error('unreachable')
    expect(view.value.build?.faces).toEqual([{ id: live.id, kind: 'checker', name: 'Checker', working: true, doing: 'Running npm start' }])
  })

  it('reads an older project read-only: its tasks in a person\'s states, its pending decisions, no build', async () => {
    const ws = await prisma.workspace.create({ data: { name: 'Older', repoPath: '/tmp/older', verifyCommands: ['true'], setupCommands: [], goalVersion: 1, goal: 'x' } })
    await prisma.task.create({ data: { workspaceId: ws.id, title: 'One', description: 'x', status: 'running', maxAttempts: 3, goalVersion: 1 } })
    await prisma.task.create({ data: { workspaceId: ws.id, title: 'Two', description: 'x', status: 'done', integratedAt: new Date(), maxAttempts: 3, goalVersion: 1 } })

    const view = await projectView(ws.id)
    if (!view.ok) throw new Error('unreachable')
    expect(view.value).toMatchObject({ flow: 'packages', phase: 'older', build: null })
    expect(view.value.older).toMatchObject({ pendingDecisions: 0, tasks: [{ title: 'One', state: 'working', status: 'running' }, { title: 'Two', state: 'integrated', status: 'done' }] })
  })

  it('refuses a project that does not exist', async () => {
    expect(await projectView(UNKNOWN)).toEqual({ ok: false, error: { kind: 'workspace_not_found', workspaceId: UNKNOWN } })
  })
})

describe('listProjects (lead UX design section 10)', () => {
  it('lists every project with its phase and spend, archived ones last', async () => {
    const f = await leadProject()
    const archived = await prisma.workspace.create({ data: { name: 'A archived', repoPath: '/tmp/a', verifyCommands: ['true'], setupCommands: [], archivedAt: new Date() } })

    const list = await listProjects()

    expect(list.map((item) => item.id)).toEqual([f.workspaceId, archived.id])
    expect(list[0]).toMatchObject({ name: 'Lead project', flow: 'lead', phase: 'building', archived: false, waiting: 0, waitingSince: null, spentUsd: 1.5, budgetUsd: 20 })
    expect(list[1]).toMatchObject({ phase: 'older', archived: true })
  })

  it('counts a stopped build as one thing waiting, from when its state last moved', async () => {
    const f = await leadProject()
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'needs_human', leadState: 'awaiting_decision', stopReason: 'no_progress' } })
    await appendEvent({ workspaceId: f.workspaceId, actor: 'system', type: 'workspace.lead_state', payload: { version: 1, state: 'awaiting_decision', reason: 'no_progress' } })

    const [item] = await listProjects()

    expect(item).toMatchObject({ phase: 'needs_decision', waiting: 1, stopReason: 'no_progress' })
    expect(item?.waitingSince).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
  })

  it('counts an older project\'s pending decisions and blocked tasks', async () => {
    const ws = await prisma.workspace.create({ data: { name: 'Older', repoPath: '/tmp/older', verifyCommands: ['true'], setupCommands: [] } })
    await prisma.task.create({ data: { workspaceId: ws.id, title: 'Stuck', description: 'x', status: 'blocked', maxAttempts: 3 } })

    const [item] = await listProjects()

    expect(item).toMatchObject({ phase: 'older', waiting: 1 })
  })
})
