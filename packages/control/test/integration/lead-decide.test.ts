import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { BUILD_DECISIONS, decideBuild } from '../../src/lead/decide.js'
import { refusalText } from '../../src/refusal.js'

const dirs: string[] = []

/** A repository with a work branch one commit ahead of main, and a lead-flow build on it. */
async function seed(data: { readonly leadState: 'awaiting_decision' | null; readonly status: 'needs_human' | 'integrating' | 'accepted' }): Promise<{ readonly workspaceId: string; readonly dir: string; readonly git: (...args: string[]) => string }> {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-lead-decide-'))
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
  const ws = await prisma.workspace.create({ data: { name: `Decide ${String(Math.random()).slice(2)}`, repoPath: dir, verifyCommands: ['true'], setupCommands: [], flow: 'lead', delivery: 'conducted', autoMerge: false } })
  const pkg = await prisma.workPackage.create({ data: { workspaceId: ws.id, goalVersion: 1, key: 'main', title: 'The whole goal', requirementKeys: ['R1'], ownedPaths: ['**'], interface: '', templateId: 'lead' } })
  await prisma.task.create({ data: { workspaceId: ws.id, title: 'The whole goal', description: 'x', status: 'done', integratedAt: new Date(), requiredRole: 'implementer', maxAttempts: 3, goalVersion: 1, workPackageId: pkg.id } })
  await prisma.goalDelivery.create({
    data: {
      workspaceId: ws.id,
      goalVersion: 1,
      integrationBranch: 'slaveofai/goal-v1',
      baseCommit: base,
      status: data.status,
      leadState: data.leadState,
      stopReason: data.leadState === null ? null : 'not_all_proven',
      needsHumanReason: data.status === 'needs_human' ? 'it stopped' : null,
      ...(data.status === 'accepted' ? { acceptedAt: new Date(), verifiedCommit: tip } : {}),
    },
  })
  return { workspaceId: ws.id, dir, git }
}

/** The pending `goal_needs_human` card the Supervisor raises for a stopped build. */
async function cardFor(workspaceId: string): Promise<string> {
  const subjectId = `${workspaceId}:v1:r1`
  const row = await prisma.supervisorDecision.create({
    data: {
      workspaceId,
      situationKind: 'goal_needs_human',
      subjectId,
      situation: { kind: 'goal_needs_human', subjectId, summary: 'Goal v1 needs a person: it stopped', facts: { goalVersion: 1, reason: 'it stopped' } },
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

describe('decideBuild (lead UX design section 7)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "WorkPackage", "GoalDelivery", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    await prisma.$disconnect()
  })

  it('names exactly the four answers the decision card offers', () => {
    expect(BUILD_DECISIONS).toEqual(['accept', 'leave', 'retry', 'merged'])
  })

  it('accepts a stopped build as it is and closes its card, as an approval on the card would', async () => {
    const f = await seed({ leadState: 'awaiting_decision', status: 'needs_human' })
    const cardId = await cardFor(f.workspaceId)

    expect(await decideBuild(f.workspaceId, 1, 'accept')).toEqual({ ok: true, value: { decision: 'accept' } })

    expect(await prisma.goalDelivery.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })).toMatchObject({ status: 'accepted', stopReason: 'accepted_as_is' })
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: cardId } })).status).toBe('rejected')
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'supervisor_resolved' } })).toBe(1)
  })

  it('leaves a stopped build unmerged and closes its card', async () => {
    const f = await seed({ leadState: 'awaiting_decision', status: 'needs_human' })
    const cardId = await cardFor(f.workspaceId)

    expect(await decideBuild(f.workspaceId, 1, 'leave')).toEqual({ ok: true, value: { decision: 'leave' } })

    expect(await prisma.goalDelivery.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })).toMatchObject({ status: 'abandoned', stopReason: 'left' })
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: cardId } })).status).not.toBe('pending')
  })

  it('checks a stopped build again: back to integrating, its card closed', async () => {
    const f = await seed({ leadState: 'awaiting_decision', status: 'needs_human' })
    const cardId = await cardFor(f.workspaceId)

    expect(await decideBuild(f.workspaceId, 1, 'retry')).toEqual({ ok: true, value: { decision: 'retry' } })

    expect(await prisma.goalDelivery.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })).toMatchObject({ status: 'integrating', needsHumanReason: null })
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: cardId } })).status).not.toBe('pending')
  })

  it('records a hand merge only once git shows the branch in the base branch', async () => {
    const f = await seed({ leadState: 'awaiting_decision', status: 'accepted' })

    const early = await decideBuild(f.workspaceId, 1, 'merged')
    expect(early).toMatchObject({ ok: false, error: { kind: 'goal_not_merged' } })

    f.git('merge', '-q', '--no-ff', '-m', 'merge the build', 'slaveofai/goal-v1')
    expect(await decideBuild(f.workspaceId, 1, 'merged')).toEqual({ ok: true, value: { decision: 'merged' } })
    expect((await prisma.goalDelivery.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })).mergedAt).not.toBeNull()
  })

  it('refuses accept and leave for a build that is not waiting for them, with words a person reads', async () => {
    const running = await seed({ leadState: 'awaiting_decision', status: 'integrating' })
    for (const decision of ['accept', 'leave'] as const) {
      const result = await decideBuild(running.workspaceId, 1, decision)
      expect(result).toEqual({ ok: false, error: { kind: 'build_not_waiting', goalVersion: 1 } })
      if (!result.ok) expect(refusalText(result.error)).toContain('not waiting')
    }
    expect((await prisma.goalDelivery.findFirstOrThrow({ where: { workspaceId: running.workspaceId } })).status).toBe('integrating')

    const older = await seed({ leadState: null, status: 'needs_human' })
    expect(await decideBuild(older.workspaceId, 1, 'accept')).toEqual({ ok: false, error: { kind: 'build_not_waiting', goalVersion: 1 } })
  })

  it('refuses a retry of a build that did not stop, and a build that does not exist', async () => {
    const running = await seed({ leadState: 'awaiting_decision', status: 'integrating' })
    expect(await decideBuild(running.workspaceId, 1, 'retry')).toMatchObject({ ok: false, error: { kind: 'goal_not_needs_human' } })
    expect(await decideBuild(running.workspaceId, 9, 'accept')).toMatchObject({ ok: false, error: { kind: 'goal_version_not_found' } })
  })
})
