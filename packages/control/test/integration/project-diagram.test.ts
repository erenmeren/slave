import { prisma } from '@slave-of-ai/db/client'
import { LEAD_TEAM_NAME, SUBORDINATE_TOOLS } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DIAGRAM_CALL_CAP, buildDiagram, type BuildDiagram } from '../../src/projectDiagram.js'
import { projectView } from '../../src/projectView.js'

const UNKNOWN = '00000000-0000-4000-8000-000000000000'
/** The tool that starts a helper session. */
const SUBORDINATE = SUBORDINATE_TOOLS[0] ?? ''
const T0 = Date.parse('2026-10-05T10:00:00.000Z')
/** A moment of the build, `seconds` after its start. */
const at = (seconds: number): Date => new Date(T0 + seconds * 1000)

interface Lead {
  readonly workspaceId: string
  readonly deliveryId: string
  readonly leadSeat: string
  readonly verifierSeat: string
  readonly taskId: string
  readonly turnId: string
  readonly checkId: string
}

type Kind = 'run.tool_call' | 'run.tool_result' | 'run.paused' | 'run.resumed'

/** One event of a run at a moment of the build: the log stamps "now", so the stamp is set after. */
async function emit(f: Pick<Lead, 'workspaceId'>, run: { readonly runId: string; readonly slaveId: string; readonly taskId?: string }, seconds: number, type: Kind, payload: Record<string, unknown>): Promise<void> {
  const event = await appendEvent({ workspaceId: f.workspaceId, ...run, actor: 'slave', type, payload } as Parameters<typeof appendEvent>[0])
  await prisma.executionEvent.update({ where: { seq: BigInt(event.seq) }, data: { ts: at(seconds) } })
}

const call = (toolUseId: string, name: string, summary: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({ name, summary: `${name} ${summary}`, toolUseId, ...more })
const answer = (toolUseId: string, outcome: 'ok' | 'error' = 'ok', more: Record<string, unknown> = {}): Record<string, unknown> => ({ toolUseId, toolName: 'x', outcome, errorClass: null, ...more })

/**
 * A lead-flow build under way: a first check ended, then the lead's live turn edited a file and
 * handed work to a helper, whose first step is still open.
 */
async function leadProject(): Promise<Lead> {
  const ws = await prisma.workspace.create({
    data: { name: 'Lead project', repoPath: '/tmp/no-such-repo', verifyCommands: ['true'], setupCommands: [], flow: 'lead', delivery: 'conducted', autoMerge: true, goalVersion: 1, goal: 'Build a todo app.' },
  })
  await prisma.goalVersion.create({ data: { workspaceId: ws.id, version: 1, text: 'Build a todo app.', sha256: 'x' } })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: LEAD_TEAM_NAME } })
  const leadSeat = await prisma.slave.create({ data: { teamId: team.id, role: 'Lead', runtimeRoles: ['implementer'], provider: 'claude_code', personId: (await prisma.person.create({ data: { name: `Lead ${ws.id.slice(0, 8)}` } })).id } })
  const verifierSeat = await prisma.slave.create({ data: { teamId: team.id, role: 'Verifier', runtimeRoles: ['verifier'], personId: (await prisma.person.create({ data: { name: `Verifier ${ws.id.slice(0, 8)}` } })).id } })
  const delivery = await prisma.goalDelivery.create({ data: { workspaceId: ws.id, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1', baseCommit: 'b'.repeat(40), status: 'integrating', leadState: 'building', round: 1, createdAt: at(-5) } })
  const pkg = await prisma.workPackage.create({ data: { workspaceId: ws.id, goalVersion: 1, key: 'main', title: 'The whole goal', requirementKeys: [], ownedPaths: ['**'], interface: '', templateId: 'lead' } })
  const task = await prisma.task.create({ data: { workspaceId: ws.id, title: 'The whole goal', description: 'x', status: 'running', requiredRole: 'implementer', maxAttempts: 3, goalVersion: 1, workPackageId: pkg.id } })

  const first = await prisma.slaveRun.create({ data: { slaveId: leadSeat.id, taskId: task.id, status: 'succeeded', leadTurn: 'build', costUsd: 2, startedAt: at(0), endedAt: at(60), terminalAt: at(60) } })
  await emit({ workspaceId: ws.id }, { runId: first.id, slaveId: leadSeat.id, taskId: task.id }, 10, 'run.tool_call', call('b-0', 'Write', '/work/src/app.ts'))
  await emit({ workspaceId: ws.id }, { runId: first.id, slaveId: leadSeat.id, taskId: task.id }, 12, 'run.tool_result', answer('b-0'))

  const check = await prisma.slaveRun.create({ data: { slaveId: verifierSeat.id, kind: 'verification', status: 'succeeded', goalDeliveryId: delivery.id, verificationTip: 'c'.repeat(40), startedAt: at(70), terminalAt: at(100), endedAt: at(100), costUsd: 1.5 } })
  await emit({ workspaceId: ws.id }, { runId: check.id, slaveId: verifierSeat.id }, 80, 'run.tool_call', call('v-0', 'Bash', 'npm start'))
  await emit({ workspaceId: ws.id }, { runId: check.id, slaveId: verifierSeat.id }, 90, 'run.tool_result', answer('v-0', 'error'))

  const turn = await prisma.slaveRun.create({ data: { slaveId: leadSeat.id, taskId: task.id, status: 'working', leadTurn: 'rework', costUsd: null, startedAt: at(110) } })
  const run = { runId: turn.id, slaveId: leadSeat.id, taskId: task.id }
  await emit({ workspaceId: ws.id }, run, 120, 'run.tool_call', call('call-0', 'Edit', '/work/src/app.ts'))
  await emit({ workspaceId: ws.id }, run, 125, 'run.tool_result', answer('call-0'))
  await emit({ workspaceId: ws.id }, run, 130, 'run.tool_call', call('call-1', SUBORDINATE, 'fix the delete route', { subagent: 'backend-dev' }))
  await emit({ workspaceId: ws.id }, run, 135, 'run.tool_call', call('call-2', 'Bash', 'npm test', { parentToolUseId: 'call-1' }))
  return { workspaceId: ws.id, deliveryId: delivery.id, leadSeat: leadSeat.id, verifierSeat: verifierSeat.id, taskId: task.id, turnId: turn.id, checkId: check.id }
}

async function read(f: Lead, seconds = 140): Promise<BuildDiagram> {
  const diagram = await buildDiagram(f.workspaceId, undefined, at(seconds))
  if (!diagram.ok || diagram.value.build === null) throw new Error('unreachable')
  return diagram.value.build
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "VerificationResult", "RequirementSet", "GoalVersion", "WorkPackage", "GoalDelivery", "Checkpoint", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('buildDiagram: a build as a diagram', () => {
  it('reads the nodes: the request, the lead, its helper, the checker and the result', async () => {
    const build = await read(await leadProject())

    expect(build).toMatchObject({ version: 1, goal: 'Build a todo app.', result: 'not_yet', to: null, from: at(0).toISOString(), at: at(140).toISOString() })
    expect(build.nodes.map((node) => [node.id, node.kind, node.state, node.sessions, node.running, node.toolCalls, node.failedCalls])).toEqual([
      ['request', 'request', 'done', 0, 0, 0, 0],
      ['lead', 'lead', 'working', 2, 1, 3, 0],
      ['helper:backend-dev', 'helper', 'working', 1, 1, 1, 0],
      ['checker', 'checker', 'done', 1, 0, 1, 1],
      ['result', 'result', 'working', 0, 0, 0, 0],
    ])
    expect(build.nodes[1]).toMatchObject({ name: 'Lead', doing: 'Waiting for its helpers', costUsd: 2 })
    expect(build.nodes[2]).toMatchObject({ name: 'backend-dev', personId: null, doing: 'Running npm test', costUsd: null })
    expect(build.nodes[3]).toMatchObject({ name: 'Checker', doing: null, costUsd: 1.5 })
  })

  it('reads the lines: who called whom and how often, moving while the target works', async () => {
    const build = await read(await leadProject())

    expect(build.edges.map((edge) => [edge.source, edge.target, edge.kind, edge.label, edge.state])).toEqual([
      ['request', 'lead', 'request', 'build 1', 'working'],
      ['lead', 'helper:backend-dev', 'helper', 'called once', 'working'],
      ['lead', 'checker', 'check', 'check 1', 'done'],
      ['checker', 'result', 'result', null, 'done'],
    ])
  })

  it('reads the sessions oldest first: each turn, each check and each call of a helper', async () => {
    const f = await leadProject()
    const build = await read(f)

    expect(build.sessions.map((session) => [session.nodeId, session.label, session.state, session.toolCalls, session.costUsd, session.endedAt === null])).toEqual([
      ['lead', 'build', 'done', 1, 2, false],
      ['checker', 'check', 'done', 1, 1.5, false],
      ['lead', 'rework', 'working', 2, null, true],
      ['helper:backend-dev', 'fix the delete route', 'working', 1, null, true],
    ])
    expect(build.sessions[3]).toMatchObject({ id: 'call-1', startedAt: at(130).toISOString(), doing: 'Running npm test' })
    expect(build.sessions.map((session) => session.doing).slice(0, 3)).toEqual([null, null, 'Handing work to a helper'])
  })

  it('reads every step with when it began and when its result came', async () => {
    const f = await leadProject()
    const build = await read(f)

    expect(build.totalCalls).toBe(5)
    expect(build.calls.map((one) => [one.nodeId, one.text, one.outcome, one.at, one.endedAt])).toEqual([
      ['lead', 'Writing src/app.ts', 'ok', at(10).toISOString(), at(12).toISOString()],
      ['checker', 'Running npm start', 'error', at(80).toISOString(), at(90).toISOString()],
      ['lead', 'Editing src/app.ts', 'ok', at(120).toISOString(), at(125).toISOString()],
      ['lead', 'Handing work to a helper', null, at(130).toISOString(), null],
      ['helper:backend-dev', 'Running npm test', null, at(135).toISOString(), null],
    ])
    expect(build.calls[4]?.sessionId).toBe('call-1')
    expect(build.calls[2]?.sessionId).toBe(f.turnId)
  })

  it('counts the same people and steps as the Project screen does', async () => {
    const f = await leadProject()
    const build = await read(f)
    const view = await projectView(f.workspaceId)
    if (!view.ok || view.value.build === null) throw new Error('unreachable')

    const people = build.nodes.filter((node) => node.kind !== 'request' && node.kind !== 'result')
    expect(people.map((node) => [node.id, node.sessions, node.toolCalls, node.failedCalls, node.costUsd])).toEqual(
      [...view.value.build.people].sort((a, b) => people.findIndex((node) => node.id === a.id) - people.findIndex((node) => node.id === b.id)).map((person) => [person.id, person.sessions, person.toolCalls, person.failedCalls, person.costUsd]),
    )
    expect(build.totalCalls).toBe(view.value.build.toolCalls)
  })

  it('keeps a helper started in the background open while its own steps are recent, then lets it go', async () => {
    const f = await leadProject()
    const run = { runId: f.turnId, slaveId: f.leadSeat, taskId: f.taskId }
    // The starting call answers at once; the helper works on.
    await emit(f, run, 131, 'run.tool_result', answer('call-1'))
    await emit(f, run, 150, 'run.tool_result', answer('call-2', 'error', { parentToolUseId: 'call-1' }))
    await emit(f, run, 152, 'run.tool_call', call('call-3', 'Read', '/work/README.md'))

    const soon = await read(f, 160)
    expect(soon.nodes.find((node) => node.id === 'helper:backend-dev')).toMatchObject({ state: 'working', running: 1, failedCalls: 1, doing: 'Running npm test' })
    expect(soon.nodes.find((node) => node.id === 'lead')).toMatchObject({ state: 'working', doing: 'Reading work/README.md' })

    const later = await read(f, 600)
    expect(later.nodes.find((node) => node.id === 'helper:backend-dev')).toMatchObject({ state: 'done', running: 0, doing: null })
    expect(later.sessions.find((session) => session.id === 'call-1')).toMatchObject({ state: 'done', endedAt: at(150).toISOString() })
  })

  it('reads a paused build: everybody open is paused, the pause is a gap, and the build ends at its last instant', async () => {
    const f = await leadProject()
    const run = { runId: f.turnId, slaveId: f.leadSeat, taskId: f.taskId }
    await emit(f, run, 131, 'run.tool_result', answer('call-1'))
    await emit(f, run, 140, 'run.tool_result', answer('call-2', 'ok', { parentToolUseId: 'call-1' }))
    await emit(f, run, 145, 'run.paused', { atStep: 4 })
    await prisma.slaveRun.update({ where: { id: f.turnId }, data: { status: 'paused' } })

    // Read a day later: the helper was at work when the build paused, so it is paused, not gone.
    const build = await read(f, 86_400)
    expect(build.nodes.filter((node) => node.kind === 'lead' || node.kind === 'helper').map((node) => [node.id, node.state, node.doing])).toEqual([
      ['lead', 'paused', null],
      ['helper:backend-dev', 'paused', null],
    ])
    expect(build.pauses).toEqual([{ from: at(145).toISOString(), to: null }])
    expect(build.to).toBe(at(145).toISOString())

    await emit(f, run, 200, 'run.resumed', { sessionId: 's' })
    await prisma.slaveRun.update({ where: { id: f.turnId }, data: { status: 'working' } })
    expect((await read(f, 210)).pauses).toEqual([{ from: at(145).toISOString(), to: at(200).toISOString() }])
  })

  it('reads a failed turn, a failed helper, a second checker and what came of the build', async () => {
    const f = await leadProject()
    const run = { runId: f.turnId, slaveId: f.leadSeat, taskId: f.taskId }
    await emit(f, run, 140, 'run.tool_result', answer('call-1', 'error'))
    await prisma.slaveRun.update({ where: { id: f.turnId }, data: { status: 'failed', endedAt: at(150), terminalAt: at(150) } })
    const second = await prisma.slaveRun.create({ data: { slaveId: f.verifierSeat, kind: 'verification', status: 'working', goalDeliveryId: f.deliveryId, confirmsRunId: f.checkId, startedAt: at(160) } })
    await emit(f, { runId: second.id, slaveId: f.verifierSeat }, 170, 'run.tool_call', call('s-0', 'Bash', 'curl /todos'))

    const build = await read(f, 180)
    expect(build.nodes.map((node) => [node.id, node.state])).toEqual([
      ['request', 'done'],
      ['lead', 'failed'],
      ['helper:backend-dev', 'failed'],
      ['checker', 'done'],
      ['second-checker', 'working'],
      ['result', 'working'],
    ])
    expect(build.nodes[4]).toMatchObject({ name: 'Second checker', doing: 'Running curl /todos' })
    expect(build.edges.slice(-2).map((edge) => [edge.source, edge.target, edge.label])).toEqual([
      ['lead', 'second-checker', 'confirms check 1'],
      ['second-checker', 'result', null],
    ])
    // The helper's open step ended with its turn, without a result of its own.
    expect(build.calls.find((one) => one.nodeId === 'helper:backend-dev')).toMatchObject({ outcome: null, endedAt: at(150).toISOString() })

    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { leadState: 'awaiting_decision', status: 'needs_human' } })
    expect((await read(f, 180)).result).toBe('waiting_for_you')
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { leadState: 'stopped' } })
    expect((await read(f, 180)).result).toBe('left_unmerged')
    await prisma.slaveRun.update({ where: { id: second.id }, data: { status: 'succeeded', endedAt: at(175), terminalAt: at(175) } })
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { leadState: 'delivered', status: 'accepted', mergedAt: at(190) } })
    expect(await read(f, 300)).toMatchObject({ result: 'merged', to: at(175).toISOString() })
  })

  it('names a helper after the roster person it was made from, and groups a general helper\'s calls', async () => {
    const f = await leadProject()
    const run = { runId: f.turnId, slaveId: f.leadSeat, taskId: f.taskId }
    await emit(f, run, 136, 'run.tool_call', call('g-1', SUBORDINATE, 'look at the logs'))
    await emit(f, run, 137, 'run.tool_call', call('g-2', SUBORDINATE, 'write the docs'))

    const build = await read(f)
    expect(build.nodes.find((node) => node.id === 'helper:general-purpose')).toMatchObject({ name: 'General helper', sessions: 2, running: 2, doing: 'Starting' })
    expect(build.edges.find((edge) => edge.target === 'helper:general-purpose')?.label).toBe('called 2 times')
    expect(build.sessions.filter((session) => session.nodeId === 'helper:general-purpose').map((session) => session.label)).toEqual(['look at the logs', 'write the docs'])
  })

  it('carries only the newest steps of a very long build, and still counts them all', async () => {
    const f = await leadProject()
    const extra = DIAGRAM_CALL_CAP + 10
    await prisma.executionEvent.createMany({
      data: Array.from({ length: extra }, (_, index) => ({ type: 'run_tool_call' as const, workspaceId: f.workspaceId, runId: f.turnId, actor: 'slave' as const, ts: at(200 + index), payload: { name: 'Read', summary: `Read /work/file-${String(index)}.ts`, toolUseId: `many-${String(index)}` } })),
    })

    const build = await read(f, 200 + extra)
    expect(build.totalCalls).toBe(5 + extra)
    expect(build.calls).toHaveLength(DIAGRAM_CALL_CAP)
    expect(build.calls.at(-1)?.text).toBe(`Reading work/file-${String(extra - 1)}.ts`)
    expect(build.nodes.find((node) => node.id === 'lead')?.toolCalls).toBe(3 + extra)
  })

  it('reads a chosen build, and refuses one that does not exist', async () => {
    const f = await leadProject()
    const chosen = await buildDiagram(f.workspaceId, 1, at(140))
    expect(chosen.ok && chosen.value.build?.version).toBe(1)
    expect(await buildDiagram(f.workspaceId, 7)).toEqual({ ok: false, error: { kind: 'goal_version_not_found', workspaceId: f.workspaceId, goalVersion: 7 } })
    expect(await buildDiagram(UNKNOWN)).toEqual({ ok: false, error: { kind: 'workspace_not_found', workspaceId: UNKNOWN } })
  })

  it('has no diagram for an older project, nor for a project nothing was asked of', async () => {
    const older = await prisma.workspace.create({ data: { name: 'Older', repoPath: '/tmp/older', verifyCommands: ['true'], setupCommands: [], goalVersion: 1, goal: 'x' } })
    expect(await buildDiagram(older.id)).toEqual({ ok: true, value: { workspaceId: older.id, flow: 'packages', build: null } })
    const fresh = await prisma.workspace.create({ data: { name: 'Fresh', repoPath: '/tmp/fresh', verifyCommands: ['true'], setupCommands: [], flow: 'lead' } })
    expect(await buildDiagram(fresh.id)).toEqual({ ok: true, value: { workspaceId: fresh.id, flow: 'lead', build: null } })
  })
})
