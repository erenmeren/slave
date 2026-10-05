/**
 * Lead-flow plan A, end to end through nothing but `tick`: a project in the lead flow takes a goal
 * from its requirements to the base branch. One lead session builds it with a subordinate from the
 * roster and records a decision; the first full verification fails one requirement and the
 * confirmer agrees; the evidence goes back into the lead's SAME session; the next round checks the
 * smoke and only what failed; a full verification on the final commit passes; the version is
 * merged. No review, no report block, no hand-off, no question, no card.
 */
import { leadStatus, loadGoalReport } from '@slave-of-ai/control'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTickObservation } from '../../src/sweep.js'
import { drainPumps } from '../../src/tick.js'
import { LEAD_TRUNCATE, base64, checked, cleanUpLeadRepos, git, leadDelivery, leadNotes, leadTaskOf, merged, seedLead, tickUntil } from './lead-helpers.js'

const ALL = ['R1', 'R2', 'RUN']

describe('the lead flow, end to end', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(LEAD_TRUNCATE)
    resetTickObservation()
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    cleanUpLeadRepos()
    await prisma.$disconnect()
  })

  it('builds, fails one requirement, confirms it, reworks it in the same session, verifies in full and merges', async (): Promise<void> => {
    const ada = await prisma.person.create({ data: { name: 'Ada Backend', profile: 'You build APIs.' } })
    const decisions = base64('## Database\nSQLite, one file: no server to run.\n')
    const f = await seedLead({
      budgetUsd: 40,
      timeLimitMs: 120 * 60_000,
      roster: [ada.id],
      // The rework resumes the session: its result line reports the running total, 6.00 + 1.50 (C2).
      leadArgs: (ordinal) => (ordinal === 1 ? ['--subordinate', 'ada-backend', '--extra-file-base64', `docs/DECISIONS.md:${decisions}`, '--result-patch-base64', base64({ total_cost_usd: 6 })] : ['--result-patch-base64', base64({ total_cost_usd: 7.5 })]),
      // Run 1 (full) fails R2; run 2 (the confirmer) fails it too; run 3 (partial) and run 4 (full) pass.
      verify: (ordinal, run) => (run.keys.length === 0 ? ALL : run.keys).map((key) => checked(key, ordinal <= 2 && key === 'R2' ? 'fail' : 'pass')),
    })
    await tickUntil(f, merged(f), 120)

    // One model call for the plan stage: the requirement extraction. No size decision was bought.
    expect(await prisma.conductorCall.findMany({ where: { workspaceId: f.workspaceId }, select: { stage: true, outcome: true } })).toEqual([{ stage: 'requirements', outcome: 'ok' }])
    expect(f.others).toEqual([])

    // One lead session, two turns; the rework went into the same session with the evidence.
    const turns = f.starts.filter((s) => s.kind === 'implementation')
    expect(turns.map((t) => [t.leadTurn, t.resumeSessionId])).toEqual([['build', null], ['rework', 'fake-session-complete']])
    expect(turns[1]?.prompt).toContain('R2: GET /version prints the version')
    expect(turns[1]?.prompt).toContain('404 Not Found')
    expect(turns[0]?.extras).toMatchObject({ maxBudgetUsd: 25.6, keepAliveForSubordinates: true })
    expect(typeof turns[0]?.extras.sessionDefinitions).toBe('string')
    expect((await leadTaskOf(f)).attempt).toBe(0)

    // Proof: full, confirm, partial, full -- by the verifier, the confirmer, the verifier, the verifier.
    const proof = f.starts.filter((s) => s.kind === 'verification')
    expect(proof.map((p) => [p.confirms, p.verificationKeys])).toEqual([[false, []], [true, ['R2']], [false, ['R2']], [false, []]])

    // Delivered: merged by a fast-forward to the verified commit.
    const delivery = await leadDelivery(f)
    expect([delivery.status, delivery.leadState, delivery.stopReason]).toEqual(['accepted', 'delivered', 'proven'])
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(delivery.verifiedCommit)
    expect(git(['ls-tree', '-r', '--name-only', 'main'], f.repoPath).split('\n')).toEqual(expect.arrayContaining(['lead-work-1.txt', 'lead-work-2.txt', 'docs/DECISIONS.md']))

    // On record: the lead's decision, the subordinate by person, the turns, the state word's path.
    expect(await prisma.goalDecision.findMany({ where: { workspaceId: f.workspaceId }, select: { title: true, source: true } })).toEqual([{ title: 'Database', source: 'lead' }])
    const status = await leadStatus(f.workspaceId)
    if (!status.ok) throw new Error('lead-status was refused')
    expect(status.value.subordinates).toEqual([{ name: 'ada-backend', personId: ada.id, calls: 1, running: 0 }])
    expect(status.value.spend).toMatchObject({ leadUsd: 7.5 })
    // Final review: each turn's row holds its own spend -- the rework's 7.50 total less the build's 6.00.
    expect(status.value.turns.map((t) => t.costUsd)).toEqual([6, 1.5])
    expect((await leadNotes(f)).filter((line) => line.startsWith('turn:'))).toEqual(['turn: turn 1 (build): a new session was started', 'turn: turn 2 (rework): the same session was resumed'])
    const states = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_lead_state' }, orderBy: { seq: 'asc' }, select: { payload: true } })
    expect(states.map((row) => (row.payload as { state: string }).state)).toEqual(['building', 'proving', 'building', 'proving', 'delivered'])

    // What the lead flow switched off never happened, and nobody was asked anything.
    const types = new Set<string>((await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId }, select: { type: true } })).map((row) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type))
    for (const absent of ['task.review_started', 'task.review_approved', 'task.verifying', 'task.ownership_violated', 'workspace.package_handed_off', 'slave.message_sent', 'supervisor.proposed', 'guardrail.tripped']) {
      expect(types.has(absent), absent).toBe(false)
    }
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, situationKind: { not: 'conduct' } } })).toBe(0)
    expect(await prisma.runReport.count()).toBe(0)
    expect(await prisma.slaveRun.count({ where: { kind: 'review' } })).toBe(0)

    // The existing goal report still reads a lead-flow version.
    const report = await loadGoalReport(f.workspaceId, 1)
    expect(report.ok).toBe(true)
  })
})
