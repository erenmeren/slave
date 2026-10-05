import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { acceptLeadGoalAsIs, leaveLeadGoal } from '../../src/lead/card.js'
import { approveDecision } from '../../src/supervisor.js'

const dirs: string[] = []

/** A repository with a work branch one commit ahead of main, and a delivery row on it. */
async function seed(data: { readonly leadState: 'awaiting_decision' | null; readonly status: 'needs_human' | 'integrating' }): Promise<{ readonly workspaceId: string; readonly tip: string; readonly taskId: string; readonly dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-lead-card-'))
  dirs.push(dir)
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@x', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), '# x\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'initial')
  const base = git('rev-parse', 'HEAD')
  git('checkout', '-q', '-b', 'slaveofai/goal-v1')
  writeFileSync(join(dir, 'work.txt'), 'work\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'work')
  const tip = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'main')
  const ws = await prisma.workspace.create({ data: { name: `Card ${String(Math.random()).slice(2)}`, repoPath: dir, verifyCommands: ['true'], setupCommands: [], flow: 'lead', delivery: 'conducted', autoMerge: true } })
  const pkg = await prisma.workPackage.create({ data: { workspaceId: ws.id, goalVersion: 1, key: 'main', title: 'The whole goal', requirementKeys: ['R1'], ownedPaths: ['**'], interface: '', templateId: 'lead' } })
  const task = await prisma.task.create({ data: { workspaceId: ws.id, title: 'The whole goal', description: 'x', status: 'rework', requiredRole: 'implementer', maxAttempts: 3, goalVersion: 1, workPackageId: pkg.id } })
  await prisma.goalDelivery.create({
    data: { workspaceId: ws.id, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1', baseCommit: base, status: data.status, leadState: data.leadState, stopReason: data.leadState === null ? null : 'no_progress', needsHumanReason: data.status === 'needs_human' ? 'it stopped' : null },
  })
  return { workspaceId: ws.id, tip, taskId: task.id, dir }
}

/** A pending `goal_needs_human` card for `goalVersion`, as the Supervisor's rule raises it. */
async function cardFor(workspaceId: string, goalVersion: number): Promise<string> {
  const subjectId = `${workspaceId}:v${String(goalVersion)}:r1`
  const row = await prisma.supervisorDecision.create({
    data: {
      workspaceId,
      situationKind: 'goal_needs_human',
      subjectId,
      situation: { kind: 'goal_needs_human', subjectId, summary: `Goal v${String(goalVersion)} needs a person: it stopped`, facts: { goalVersion, reason: 'it stopped' } },
      candidates: [],
      chosenIndex: 0,
      action: { kind: 'escalate_to_human', summary: 'Goal needs a person' },
      rationale: 'the loop stopped',
      tier: 'escalated',
      status: 'pending',
      decidedBy: 'rules',
      expiresAt: new Date(Date.now() + 24 * 3_600_000),
    },
  })
  return row.id
}

describe('the delivery card\'s two decisions (lead-flow plan A L13)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "WorkPackage", "GoalDelivery", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    await prisma.$disconnect()
  })

  it('accepts a stopped lead-flow version as it is: accepted at the work branch\'s tip, its unfinished task cancelled', async (): Promise<void> => {
    const f = await seed({ leadState: 'awaiting_decision', status: 'needs_human' })
    expect(await acceptLeadGoalAsIs(f.workspaceId, 1)).toEqual({ ok: true, value: 'applied' })
    const delivery = await prisma.goalDelivery.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })
    expect(delivery).toMatchObject({ status: 'accepted', verifiedCommit: f.tip, stopReason: 'accepted_as_is', needsHumanReason: null })
    expect(delivery.acceptedAt).not.toBeNull()
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })).status).toBe('cancelled')
    expect(await prisma.executionEvent.count({ where: { taskId: f.taskId, type: 'task_cancelled' } })).toBe(1)
    // A second approval finds nothing to accept and writes nothing.
    expect(await acceptLeadGoalAsIs(f.workspaceId, 1)).toEqual({ ok: true, value: 'none' })
  })

  it('leaves a stopped lead-flow version: abandoned, the branch untouched', async (): Promise<void> => {
    const f = await seed({ leadState: 'awaiting_decision', status: 'needs_human' })
    expect(await leaveLeadGoal(f.workspaceId, 1)).toEqual({ ok: true, value: 'applied' })
    expect(await prisma.goalDelivery.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })).toMatchObject({ status: 'abandoned', stopReason: 'left' })
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'workspace_goal_abandoned' } })).toBe(1)
  })

  it('does nothing for a version that is not a stopped lead-flow version', async (): Promise<void> => {
    const other = await seed({ leadState: null, status: 'needs_human' })
    expect(await acceptLeadGoalAsIs(other.workspaceId, 1)).toEqual({ ok: true, value: 'none' })
    expect(await leaveLeadGoal(other.workspaceId, 1)).toEqual({ ok: true, value: 'none' })
    expect((await prisma.goalDelivery.findFirstOrThrow({ where: { workspaceId: other.workspaceId } })).status).toBe('needs_human')

    const running = await seed({ leadState: 'awaiting_decision', status: 'integrating' })
    expect(await acceptLeadGoalAsIs(running.workspaceId, 1)).toEqual({ ok: true, value: 'none' })
    expect(await acceptLeadGoalAsIs(running.workspaceId, 7)).toMatchObject({ ok: false, error: { kind: 'goal_version_not_found' } })
  })

  it('refuses, writing nothing, when the work branch is gone -- and the card says why instead of throwing (task 10 review)', async (): Promise<void> => {
    const f = await seed({ leadState: 'awaiting_decision', status: 'needs_human' })
    execFileSync('git', ['branch', '-D', 'slaveofai/goal-v1'], { cwd: f.dir, stdio: 'ignore' })
    expect(await acceptLeadGoalAsIs(f.workspaceId, 1)).toMatchObject({ ok: false, error: { kind: 'base_branch_not_found', branch: 'slaveofai/goal-v1' } })
    expect((await prisma.goalDelivery.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })).status).toBe('needs_human')

    const cardId = await cardFor(f.workspaceId, 1)
    expect((await approveDecision(cardId)).ok).toBe(false)
    const decision = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: cardId } })
    expect(decision.status).toBe('failed')
    expect(decision.failureReason).toContain('slaveofai/goal-v1')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })).status).toBe('rework')
  })

  it('approves a card whose version is gone as it always did: nothing to carry out (task 10 review)', async (): Promise<void> => {
    const f = await seed({ leadState: null, status: 'needs_human' })
    const cardId = await cardFor(f.workspaceId, 7)
    expect(await approveDecision(cardId)).toEqual({ ok: true, value: undefined })
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: cardId } })).status).toBe('approved')
  })
})
