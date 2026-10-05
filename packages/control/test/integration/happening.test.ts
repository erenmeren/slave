import { prisma } from '@slave-of-ai/db/client'
import { LEAD_TEAM_NAME, SUBORDINATE_TOOLS } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { HAPPENING_STEPS, happeningNow, stateLine } from '../../src/happening.js'

const SUBORDINATE = SUBORDINATE_TOOLS[0] ?? ''

interface Lead {
  readonly workspaceId: string
  readonly base: { readonly workspaceId: string; readonly taskId: string; readonly slaveId: string; readonly runId: string; readonly actor: 'slave' }
  readonly verifierSeat: string
  readonly deliveryId: string
}

/** A lead-flow project with a live lead turn and nothing done yet. */
async function leadProject(name: string, roster: readonly string[] = []): Promise<Lead> {
  const ws = await prisma.workspace.create({ data: { name, repoPath: `/tmp/${name}`, verifyCommands: ['true'], setupCommands: [], flow: 'lead', delivery: 'conducted', goalVersion: 1, goal: 'Build it.', leadRoster: [...roster] } })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: LEAD_TEAM_NAME } })
  const leadSeat = await prisma.slave.create({ data: { teamId: team.id, role: 'Lead', runtimeRoles: ['implementer'], personId: (await prisma.person.create({ data: { name: `Lead of ${name}` } })).id } })
  const verifierSeat = await prisma.slave.create({ data: { teamId: team.id, role: 'Verifier', runtimeRoles: ['verifier'], personId: (await prisma.person.create({ data: { name: `Verifier of ${name}` } })).id } })
  const delivery = await prisma.goalDelivery.create({ data: { workspaceId: ws.id, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1', baseCommit: 'b'.repeat(40), leadState: 'building' } })
  const pkg = await prisma.workPackage.create({ data: { workspaceId: ws.id, goalVersion: 1, key: 'main', title: 'The whole goal', requirementKeys: [], ownedPaths: ['**'], interface: '', templateId: 'lead' } })
  const task = await prisma.task.create({ data: { workspaceId: ws.id, title: 'The whole goal', description: 'x', status: 'running', requiredRole: 'implementer', maxAttempts: 3, goalVersion: 1, workPackageId: pkg.id } })
  const turn = await prisma.slaveRun.create({ data: { slaveId: leadSeat.id, taskId: task.id, status: 'working', leadTurn: 'build', sessionId: `session-${name}` } })
  return { workspaceId: ws.id, base: { workspaceId: ws.id, taskId: task.id, slaveId: leadSeat.id, runId: turn.id, actor: 'slave' }, verifierSeat: verifierSeat.id, deliveryId: delivery.id }
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "VerificationResult", "WorkPackage", "GoalDelivery", "Checkpoint", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE')
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('happeningNow (Home: Happening now)', () => {
  it('is empty when there is no project, and when nothing has happened', async () => {
    expect(await happeningNow()).toEqual([])
    await leadProject('quiet')
    expect(await happeningNow()).toEqual([])
  })

  it('says who made each step, what it was and how it ended, newest first, with a helper under its roster name', async () => {
    const bea = await prisma.person.create({ data: { name: 'Bea Backend' } })
    const f = await leadProject('todo', [bea.id])
    await appendEvent({ ...f.base, type: 'run.tool_call', payload: { name: 'Edit', summary: 'Edit /work/src/app.ts', toolUseId: 'call-0' } })
    await appendEvent({ ...f.base, type: 'run.tool_result', payload: { toolUseId: 'call-0', toolName: 'Edit', outcome: 'ok', errorClass: null } })
    await appendEvent({ ...f.base, type: 'run.tool_call', payload: { name: SUBORDINATE, summary: `${SUBORDINATE} fix the delete route`, toolUseId: 'call-1', subagent: 'bea-backend' } })
    await appendEvent({ ...f.base, type: 'run.tool_call', payload: { name: 'Bash', summary: 'Bash npm test', toolUseId: 'call-2', parentToolUseId: 'call-1' } })
    await appendEvent({ ...f.base, type: 'run.tool_result', payload: { toolUseId: 'call-2', toolName: 'Bash', outcome: 'error', errorClass: 'other', parentToolUseId: 'call-1' } })
    // A helper of the helper: its steps are the first helper's.
    await appendEvent({ ...f.base, type: 'run.tool_call', payload: { name: SUBORDINATE, summary: `${SUBORDINATE} look deeper`, toolUseId: 'call-3', parentToolUseId: 'call-1' } })
    await appendEvent({ ...f.base, type: 'run.tool_call', payload: { name: 'Read', summary: 'Read /work/src/routes/todos.ts', toolUseId: 'call-4', parentToolUseId: 'call-3' } })
    const check = await prisma.slaveRun.create({ data: { slaveId: f.verifierSeat, kind: 'verification', status: 'succeeded', goalDeliveryId: f.deliveryId, endedAt: new Date() } })
    await appendEvent({ workspaceId: f.workspaceId, slaveId: f.verifierSeat, runId: check.id, actor: 'slave', type: 'run.tool_call', payload: { name: 'Bash', summary: 'Bash npm start', toolUseId: 'v-1' } })

    const lines = await happeningNow()
    expect(lines.map((line) => [line.kind, line.who, line.text, line.outcome])).toEqual([
      // The check ended before this step answered: no outcome is claimed.
      ['checker', 'Checker', 'Running npm start', null],
      ['helper', 'Bea Backend', 'Reading routes/todos.ts', 'running'],
      ['helper', 'Bea Backend', 'Handing work to a helper', 'running'],
      ['helper', 'Bea Backend', 'Running npm test', 'error'],
      ['lead', 'Lead', 'Handed work to a helper', 'running'],
      ['lead', 'Lead', 'Editing src/app.ts', 'ok'],
    ])
    expect(lines.every((line) => line.step && line.projectId === f.workspaceId && line.projectName === 'todo')).toBe(true)
  })

  it('names a helper nobody on the roster answers to by its own word, and a general helper as one', async () => {
    const f = await leadProject('todo')
    await appendEvent({ ...f.base, type: 'run.tool_call', payload: { name: SUBORDINATE, summary: SUBORDINATE, toolUseId: 'a', subagent: 'gone-person' } })
    await appendEvent({ ...f.base, type: 'run.tool_call', payload: { name: 'Bash', summary: 'Bash ls', toolUseId: 'a-1', parentToolUseId: 'a' } })
    await appendEvent({ ...f.base, type: 'run.tool_call', payload: { name: SUBORDINATE, summary: SUBORDINATE, toolUseId: 'b' } })
    await appendEvent({ ...f.base, type: 'run.tool_call', payload: { name: 'Bash', summary: 'Bash ls', toolUseId: 'b-1', parentToolUseId: 'b' } })
    const who = (await happeningNow()).filter((line) => line.kind === 'helper').map((line) => line.who)
    expect(who).toEqual(['General helper', 'gone-person'])
  })

  it('puts the changes of state beside the steps, across projects, and leaves an archived project out', async () => {
    const a = await leadProject('alpha')
    const b = await leadProject('beta')
    const archived = await leadProject('old')
    await appendEvent({ workspaceId: a.workspaceId, actor: 'human', type: 'workspace.goal_set', payload: { goal: 'Build it.', version: 1 } })
    await appendEvent({ workspaceId: a.workspaceId, actor: 'system', type: 'workspace.lead_state', payload: { version: 1, state: 'building', reason: null } })
    await appendEvent({ ...a.base, type: 'run.tool_call', payload: { name: 'Bash', summary: 'Bash make', toolUseId: 'a-0' } })
    await appendEvent({ ...b.base, type: 'run.tool_call', payload: { name: 'Bash', summary: 'Bash go test', toolUseId: 'b-0' } })
    await appendEvent({ workspaceId: b.workspaceId, actor: 'system', type: 'workspace.lead_state', payload: { version: 1, state: 'awaiting_decision', reason: 'budget_spent' } })
    await appendEvent({ workspaceId: a.workspaceId, actor: 'human', type: 'guardrail.tripped', payload: { guardrail: 'emergency_stop', detail: 'engaged by a person' } })
    await appendEvent({ workspaceId: a.workspaceId, actor: 'system', type: 'guardrail.tripped', payload: { guardrail: 'emergency_stop', detail: 'scheduling halted for this workspace' } })
    await appendEvent({ ...archived.base, type: 'run.tool_call', payload: { name: 'Bash', summary: 'Bash ls', toolUseId: 'o-0' } })
    await prisma.workspace.update({ where: { id: archived.workspaceId }, data: { archivedAt: new Date() } })

    const lines = await happeningNow()
    expect(lines.map((line) => [line.projectName, line.kind, line.who, line.text, line.step])).toEqual([
      ['alpha', 'person', 'You', 'The project was stopped. Nothing runs until Continue is pressed', false],
      ['beta', 'project', 'Slave', 'Build 1 is waiting for a decision. The budget ran out.', false],
      ['beta', 'lead', 'Lead', 'Running go test', true],
      ['alpha', 'lead', 'Lead', 'Running make', true],
      ['alpha', 'project', 'Slave', 'Build 1 started: the lead is building', false],
      ['alpha', 'person', 'You', 'A new build was asked for', false],
    ])
  })

  it('is bounded: the newest steps only', async () => {
    const f = await leadProject('busy')
    for (let n = 0; n < HAPPENING_STEPS + 5; n += 1) await appendEvent({ ...f.base, type: 'run.tool_call', payload: { name: 'Bash', summary: `Bash echo ${String(n)}`, toolUseId: `c-${String(n)}` } })
    const lines = await happeningNow()
    expect(lines).toHaveLength(HAPPENING_STEPS)
    expect(lines[0]?.text).toBe(`Running echo ${String(HAPPENING_STEPS + 4)}`)
  })
})

describe('stateLine', () => {
  it('says a merge, an acceptance and a person\'s own decision in words, and nothing for a state it does not know', () => {
    expect(stateLine('workspace_goal_merged', 'human', { version: 2, into: 'main', by: 'human' })).toEqual({ kind: 'person', who: 'You', text: 'Build 2 was merged into main' })
    expect(stateLine('workspace_goal_accepted', 'system', { version: 2, rounds: 1 })).toEqual({ kind: 'project', who: 'Slave', text: 'Build 2 passed its checks' })
    expect(stateLine('workspace_lead_state', 'human', { version: 2, state: 'stopped', reason: 'left' })?.text).toBe('Build 2 was stopped. You left it unmerged.')
    expect(stateLine('workspace_lead_state', 'human', { version: 2, state: 'building', reason: null })?.text).toBe('Build 2 was sent back to the lead')
    expect(stateLine('workspace_lead_state', 'system', { version: 2, state: 'elsewhere', reason: null })).toBeNull()
    expect(stateLine('guardrail_tripped', 'system', { guardrail: 'budget', detail: 'the budget is spent' })?.text).toBe('Slave stepped in: the budget is spent')
    expect(stateLine('run_started', 'slave', {})).toBeNull()
  })
})
