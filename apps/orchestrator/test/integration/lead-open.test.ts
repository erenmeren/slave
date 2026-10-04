import { prisma } from '@slave-of-ai/db/client'
import { INITIAL_LEAD_PROGRESS, LEAD_RULES, LEAD_TEMPLATE_ID, LEAD_TURN_NOTE_MAX_CHARS, integrationBranchName, readLeadProgress } from '@slave-of-ai/domain'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { updateLeadProgress } from '../../src/lead/record.js'
import { drainPumps, tick } from '../../src/tick.js'
import { LEAD_TRUNCATE, base64, cleanUpLeadRepos, git, leadDelivery, leadNotes, leadTaskOf, merged, seedLead, tickUntil } from './lead-helpers.js'

describe('the lead flow: a goal is built by one lead turn', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(LEAD_TRUNCATE)
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    cleanUpLeadRepos()
    await prisma.$disconnect()
  })

  it('makes one package and one task for the lead with no model call for the plan', async (): Promise<void> => {
    const f = await seedLead()
    await tick(f.deps) // the requirement extraction (the one model call)
    await tick(f.deps) // the plan, by rule
    await drainPumps()

    expect(f.others.filter((prompt) => prompt.includes('"conductAnswer"'))).toEqual([])
    expect(await prisma.conductorCall.findMany({ where: { workspaceId: f.workspaceId }, select: { stage: true } })).toEqual([{ stage: 'requirements' }])
    const packages = await prisma.workPackage.findMany({ where: { workspaceId: f.workspaceId } })
    expect(packages).toEqual([expect.objectContaining({ key: 'main', ownedPaths: ['**'], requirementKeys: ['R1', 'R2', 'RUN'], templateId: LEAD_TEMPLATE_ID })])
    const task = await leadTaskOf(f)
    const lead = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: f.workspaceId }, role: 'Lead' } })
    const verifier = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: f.workspaceId }, role: 'Verifier' } })
    expect(task.assigneeId).toBe(lead.id)
    const delivery = await leadDelivery(f)
    expect(delivery).toMatchObject({ integrationBranch: integrationBranchName(1, f.workspaceId), verifierSlaveId: verifier.id, leadState: 'building', smokeRequired: true })
    expect(delivery.leadProgress).toEqual(INITIAL_LEAD_PROGRESS)
    const decision = await prisma.supervisorDecision.findFirstOrThrow({ where: { workspaceId: f.workspaceId, situationKind: 'conduct' } })
    expect(decision.decidedBy).toBe('rules')
    const states = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_lead_state' }, select: { payload: true } })
    expect(states.map((row) => row.payload)).toEqual([{ version: 1, state: 'building', reason: null }])
  })

  it('starts the lead once with the whole brief, the roster and a capped first leg, and no session to resume', async (): Promise<void> => {
    const ada = await prisma.person.create({ data: { name: 'Ada Backend', profile: 'You build APIs.' } })
    const f = await seedLead({ budgetUsd: 30, roster: [ada.id] })
    await tickUntil(f, async () => f.starts.length > 0)

    const start = f.starts[0]
    expect(start).toMatchObject({ kind: 'implementation', leadTurn: 'build', resumeSessionId: null })
    expect(start?.prompt).toContain('THE GOAL (v1)')
    expect(start?.prompt).toContain('R1: GET /health answers 200')
    expect(start?.prompt).toContain('- ada-backend:')
    expect(start?.prompt.endsWith(LEAD_RULES)).toBe(true)
    expect(start?.prompt).not.toContain('<slave-ask>')
    expect(start?.prompt).not.toContain('<slave-report>')
    // 30 less one fifth is the share (24); the first leg runs to four fifths of it. The lead has spent nothing yet.
    expect(start?.extras).toEqual({ sessionDefinitions: JSON.stringify({ 'ada-backend': { description: 'a specialist of this organisation', prompt: 'You build APIs.' } }), maxBudgetUsd: 19.2, keepAliveForSubordinates: true })
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: start?.runId ?? '' } })
    expect([run.leadTurn, run.leadResumed, run.kind]).toEqual(['build', false, 'implementation'])
    // C5: no model named, so no `--model` flag -- the installed CLI's default runs the lead.
    expect(start?.model).toBeNull()
    expect([run.model, run.provider]).toEqual([null, 'claude_code'])
    expect((await leadNotes(f))[0]).toBe('turn: turn 1 (build): a new session was started')
  })

  it('integrates the turn by a fast-forward, with no review, no report and no merge pass, and proves and merges it', async (): Promise<void> => {
    const f = await seedLead()
    await tickUntil(f, merged(f))

    const task = await leadTaskOf(f)
    expect(task.status).toBe('done')
    expect(task.integratedAt).not.toBeNull()
    const delivery = await leadDelivery(f)
    expect(delivery.status).toBe('accepted')
    // The work branch is the lead's branch tip, not a merge commit on top of it.
    expect(git(['rev-parse', delivery.integrationBranch], f.repoPath)).toBe(git(['rev-parse', task.branch ?? ''], f.repoPath))
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(delivery.verifiedCommit)
    expect(git(['ls-tree', '-r', '--name-only', 'main'], f.repoPath).split('\n')).toContain('lead-work-1.txt')

    const runs = await prisma.slaveRun.findMany({ where: { slave: { team: { workspaceId: f.workspaceId } } }, select: { kind: true } })
    expect(runs.map((run) => run.kind).sort()).toEqual(['implementation', 'verification'])
    const types = (await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId }, select: { type: true } })).map((row) => row.type)
    for (const absent of ['task_review_started', 'task_review_approved', 'task_verify_passed', 'task_ownership_violated', 'task_merge_failed', 'supervisor_proposed']) expect(types).not.toContain(absent)
    expect(types).toContain('task_done')
    expect(await prisma.runReport.count()).toBe(0)
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, situationKind: { not: 'conduct' } } })).toBe(0)
    expect(f.starts.filter((s) => s.kind === 'implementation')).toHaveLength(1)
  })

  it('stops with "nothing was built" when the lead commits nothing, and starts no proof', async (): Promise<void> => {
    const f = await seedLead({ leadArgs: () => ['--no-work'] })
    await tickUntil(f, async () => (await leadDelivery(f)).status === 'needs_human')

    const delivery = await leadDelivery(f)
    expect([delivery.stopReason, delivery.leadState]).toEqual(['nothing_built', 'awaiting_decision'])
    expect(delivery.needsHumanReason).toContain('nothing was built')
    expect(await prisma.smokeAttempt.count()).toBe(0)
    expect(f.starts.filter((s) => s.kind === 'verification')).toEqual([])
    // Held: more ticks start no further turn.
    for (let i = 0; i < 3; i += 1) {
      await tick(f.deps)
      await drainPumps()
    }
    expect(f.starts.filter((s) => s.kind === 'implementation')).toHaveLength(1)
    // The one card, by the existing rule.
    const cards = await prisma.supervisorDecision.findMany({ where: { workspaceId: f.workspaceId, status: 'pending' }, select: { situationKind: true } })
    expect(cards).toEqual([{ situationKind: 'goal_needs_human' }])
  })

  it('commits what the lead left uncommitted, under the lead\'s name, before it is judged', async (): Promise<void> => {
    const f = await seedLead({ leadArgs: () => ['--no-commit', '--extra-file-base64', `notes/left.txt:${base64('left behind')}`] })
    await tickUntil(f, merged(f))
    const files = git(['ls-tree', '-r', '--name-only', 'main'], f.repoPath).split('\n')
    expect(files).toContain('lead-work-1.txt')
    expect(files).toContain('notes/left.txt')
    const lead = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: f.workspaceId }, role: 'Lead' }, include: { person: true } })
    expect(git(['log', '-1', '--format=%an', 'main'], f.repoPath)).toBe(lead.person.name)
  })

  it('cuts an over-long turn note to its stored bound, and refuses a progress that cannot be stored, never resetting what is recorded', async (): Promise<void> => {
    const f = await seedLead()
    await tick(f.deps)
    await tick(f.deps)
    await drainPumps()
    const { id } = await leadDelivery(f)
    await updateLeadProgress(id, (progress) => ({ ...progress, askReplies: 1, baseMerges: 2 }))

    const written = await updateLeadProgress(id, (progress) => ({ ...progress, nextTurn: { kind: 'continue', note: `head ${'x'.repeat(30_000)} tail` } }))
    const stored = readLeadProgress((await leadDelivery(f)).leadProgress)
    expect(stored).toEqual(written)
    expect(stored.nextTurn?.note.length).toBeLessThanOrEqual(LEAD_TURN_NOTE_MAX_CHARS)
    expect(stored.nextTurn?.note.startsWith('head ')).toBe(true)
    expect(stored.nextTurn?.note.endsWith(' tail')).toBe(true)
    // Cut, not reset: the counters a reset would wipe are still there.
    expect([stored.askReplies, stored.baseMerges]).toEqual([1, 2])

    // A progress the schema refuses is thrown inside the lock: nothing is written.
    await expect(updateLeadProgress(id, (progress) => ({ ...progress, askReplies: -1 }))).rejects.toThrow(/lead progress/)
    expect(readLeadProgress((await leadDelivery(f)).leadProgress)).toEqual(stored)
  })
})
