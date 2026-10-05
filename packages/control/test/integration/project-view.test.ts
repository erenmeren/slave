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
