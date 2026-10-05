import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { goalSpend, leadStatus, workspaceSpend } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { readLeadProgress } from '@slave-of-ai/domain'
import type { SlaveRuntimeAdapter } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGoalPass } from '../../src/goal.js'
import { resetTickObservation, sweep } from '../../src/sweep.js'
import { drainPumps, tick } from '../../src/tick.js'
import { LEAD_TRUNCATE, base64, checked, cleanUpLeadRepos, git, leadDelivery, leadNotes, leadTaskOf, merged, seedLead, tickUntil, type LeadFixture } from './lead-helpers.js'

const leadTurns = (f: LeadFixture) => f.starts.filter((s) => s.kind === 'implementation')
/**
 * A turn the vendor stopped at its budget cap (measured: `terminal_reason: "budget_exhausted"`, C3).
 * `usd` is the SESSION's running total at its end, as a resumed process reports it (C2).
 */
const capped = (usd: number): readonly string[] => ['--result-patch-base64', base64({ is_error: true, subtype: 'error_during_execution', terminal_reason: 'budget_exhausted', total_cost_usd: usd })]
/** A turn that ended normally with the session's running total at `usd`. */
const cost = (usd: number): readonly string[] => ['--result-patch-base64', base64({ total_cost_usd: usd })]
const children: number[] = []
/** What each lead turn's row holds, oldest first. */
const leadTurnCosts = async (f: LeadFixture): Promise<(number | null)[]> =>
  (await prisma.slaveRun.findMany({ where: { leadTurn: { not: null }, task: { workspaceId: f.workspaceId } }, orderBy: { startedAt: 'asc' }, select: { costUsd: true } })).map((run) => run.costUsd)

describe('the lead flow: limits belong to the goal', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(LEAD_TRUNCATE)
    resetTickObservation()
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    for (const pid of children) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    cleanUpLeadRepos()
    await prisma.$disconnect()
  })

  it('tells the lead to wrap up at four fifths of its share, in the same session, and charges no attempt', async (): Promise<void> => {
    // The wrap-up turn resumes the session and reports its running total: 19.20 + 1.00.
    const f = await seedLead({ budgetUsd: 30, leadArgs: (ordinal) => (ordinal === 1 ? capped(19.2) : cost(20.2)) })
    await tickUntil(f, merged(f))

    const turns = leadTurns(f)
    expect(turns.map((t) => [t.leadTurn, t.extras.maxBudgetUsd])).toEqual([['build', 19.2], ['wrap_up', 4.8]])
    expect(turns[1]?.resumeSessionId).toBe('fake-session-complete')
    expect(turns[1]?.prompt).toContain('Wrap up now')
    // Final review: each row holds what its own turn spent -- the reported running total less the
    // earlier turns of the session.
    expect(await leadTurnCosts(f)).toEqual([19.2, 1])
    expect((await leadTaskOf(f)).attempt).toBe(0)
    expect(readLeadProgress((await leadDelivery(f)).leadProgress)).toMatchObject({ wrapUpSent: true, leadEnded: null })
    expect((await leadNotes(f)).some((line) => line.startsWith('wrap_up:'))).toBe(true)
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, situationKind: { not: 'conduct' } } })).toBe(0)
  })

  it('ends the lead at 100% of its share and proves what is committed, with a subordinate still at work', async (): Promise<void> => {
    const f = await seedLead({
      budgetUsd: 30,
      // The second leg spends its 4.80; the session's running total is then the whole share, 24.00.
      leadArgs: (ordinal) => (ordinal === 1 ? capped(19.2) : [...capped(24), '--subordinate', 'general-purpose', '--subordinate-unfinished']),
    })
    await tickUntil(f, merged(f))

    expect(leadTurns(f).map((t) => t.leadTurn)).toEqual(['build', 'wrap_up'])
    expect((await leadTaskOf(f)).attempt).toBe(0)
    expect(readLeadProgress((await leadDelivery(f)).leadProgress).leadEnded).toBe('budget_spent')
    expect(await leadTurnCosts(f)).toEqual([19.2, 4.8])
    // What both turns committed is on main: proof ran on it and passed.
    const files = git(['ls-tree', '-r', '--name-only', 'main'], f.repoPath).split('\n')
    expect(files).toEqual(expect.arrayContaining(['lead-work-1.txt', 'lead-work-2.txt']))
    expect(await leadNotes(f)).toEqual(expect.arrayContaining([expect.stringMatching(/^lead_ended: the lead's share of the budget is spent/), 'report_missing: the lead was stopped before it could write its closing report']))
    // The subordinate's unfinished call tripped nothing.
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'guardrail_tripped' } })).toBe(0)
    // More ticks start no further lead turn.
    await tick(f.deps)
    await drainPumps()
    expect(leadTurns(f)).toHaveLength(2)
  })

  it('stores each turn of one session at its own spend, so every reader that sums the rows counts the session once (final review)', async (): Promise<void> => {
    // Three turns of one session: the build, the smoke's rework, the verification's rework. Each
    // result line reports the session's running total (C2): 5, then 10, then 15.
    const f = await seedLead({
      smokeFailures: 1,
      leadArgs: (ordinal) => cost(ordinal * 5),
      // The first verification fails R1 and the confirmer confirms it; then everything passes.
      verify: (ordinal, run) => (run.keys.length === 0 ? ['R1', 'R2', 'RUN'] : run.keys).map((key) => checked(key, ordinal <= 2 && key === 'R1' ? 'fail' : 'pass')),
    })
    await tickUntil(f, merged(f), 120)

    expect(leadTurns(f).map((t) => [t.leadTurn, t.resumeSessionId])).toEqual([['build', null], ['rework', 'fake-session-complete'], ['rework', 'fake-session-complete']])
    expect(await leadTurnCosts(f)).toEqual([5, 5, 5])
    const spend = await goalSpend(f.workspaceId, 1)
    expect(spend.leadUsd).toBe(15)
    // The project's figure sums every run's row: the lead's session is in it once.
    const project = await workspaceSpend(f.workspaceId)
    expect(project.runsMeasuredUsd).toBeCloseTo(15 + spend.proofUsd, 6)
  })

  it('ends the lead when the goal\'s time is spent and proves what is committed', async (): Promise<void> => {
    const failed = ['--result-patch-base64', base64({ is_error: true, subtype: 'error_during_execution', terminal_reason: 'error_during_execution' })]
    const f = await seedLead({ timeLimitMs: 10 * 60_000, leadArgs: () => failed })
    await tickUntil(f, async () => (await prisma.slaveRun.count({ where: { leadTurn: { not: null }, status: 'failed' } })) === 1)
    // That turn took eleven minutes of the goal's ten.
    const turn = await prisma.slaveRun.findFirstOrThrow({ where: { leadTurn: { not: null } } })
    await prisma.slaveRun.update({ where: { id: turn.id }, data: { startedAt: new Date((turn.endedAt ?? new Date()).getTime() - 11 * 60_000) } })

    await tickUntil(f, merged(f))
    expect(leadTurns(f)).toHaveLength(1)
    expect(readLeadProgress((await leadDelivery(f)).leadProgress).leadEnded).toBe('time_spent')
    expect((await leadNotes(f)).some((line) => line.startsWith('lead_ended: the goal\'s time limit of 10 minutes is reached'))).toBe(true)
    expect(git(['ls-tree', '-r', '--name-only', 'main'], f.repoPath).split('\n')).toContain('lead-work-1.txt')
  })

  it('stops the version with one card, under the reason the lead was ended for, when the ended lead\'s work cannot be put on the work branch', async (): Promise<void> => {
    const failed = ['--result-patch-base64', base64({ is_error: true, subtype: 'error_during_execution', terminal_reason: 'error_during_execution' })]
    const f = await seedLead({ timeLimitMs: 10 * 60_000, leadArgs: () => failed })
    await tickUntil(f, async () => (await prisma.slaveRun.count({ where: { leadTurn: { not: null }, status: 'failed' } })) === 1)
    const turn = await prisma.slaveRun.findFirstOrThrow({ where: { leadTurn: { not: null } } })
    await prisma.slaveRun.update({ where: { id: turn.id }, data: { startedAt: new Date((turn.endedAt ?? new Date()).getTime() - 11 * 60_000) } })
    // A stale lock on the work branch's ref: every `update-ref` on it fails while the ref stays put.
    const before = await leadDelivery(f)
    writeFileSync(join(f.repoPath, '.git', 'refs', 'heads', `${before.integrationBranch}.lock`), '')

    await tickUntil(f, async () => (await leadDelivery(f)).status === 'needs_human')

    const delivery = await leadDelivery(f)
    expect([delivery.stopReason, delivery.leadState]).toEqual(['time_spent', 'awaiting_decision'])
    expect(delivery.needsHumanReason).toMatch(/the work branch could not be moved: .*\.lock/)
    expect(git(['rev-parse', delivery.integrationBranch], f.repoPath)).toBe(f.initialTip)
    expect((await leadTaskOf(f)).integratedAt).toBeNull()
    expect(leadTurns(f)).toHaveLength(1)
    const stops = await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'workspace_goal_needs_human' } })
    expect(stops).toBe(1)
  })

  it('cancels a live turn when the time runs out', async (): Promise<void> => {
    const f = await seedLead({ timeLimitMs: 10 * 60_000 })
    await tick(f.deps)
    await tick(f.deps)
    await drainPumps()
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' })
    children.push(child.pid ?? 0)
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    const task = await leadTaskOf(f)
    const lead = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: f.workspaceId }, role: 'Lead' } })
    const live = await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId: lead.id, kind: 'implementation', status: 'working', leadTurn: 'build', pid: child.pid ?? 0, provider: 'claude_code', startedAt: new Date(Date.now() - 11 * 60_000) },
    })
    await prisma.task.update({ where: { id: task.id }, data: { status: 'running', activeRunId: live.id } })
    const cancelled: string[] = []
    const stub = { cancel: async (runId: string): Promise<void> => void cancelled.push(runId) } as unknown as SlaveRuntimeAdapter

    await runGoalPass({ ...f.deps, registry: { resolve: () => stub } }, { mayStartRuns: false })

    expect(cancelled).toEqual([live.id])
    // The goal's limit, not the lead's fault: the claim is the platform's, as a clock jump's is.
    expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({ status: 'stopping', failureClass: 'platform' })
    expect(readLeadProgress((await leadDelivery(f)).leadProgress).leadEnded).toBe('time_spent')

    // The process dies and the sweep's stopping arm concludes the turn: no attempt is charged.
    child.kill('SIGKILL')
    await exited
    const report = await sweep({ ...f.deps, registry: { resolve: () => stub } })
    expect(report.stoppingConcluded).toEqual([live.id])
    expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({ status: 'failed', failureClass: 'platform' })
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'rework', attempt: task.attempt, activeRunId: null })
  })

  it('cancels a live base turn of an accepted version when the time runs out (task 10 review)', async (): Promise<void> => {
    // Automatic merge off: the accepted version stays accepted, as one waiting for its base turn does.
    const f = await seedLead({ timeLimitMs: 10 * 60_000, autoMerge: false })
    await tickUntil(f, async () => (await leadDelivery(f)).status === 'accepted')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' })
    children.push(child.pid ?? 0)
    const task = await leadTaskOf(f)
    const lead = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: f.workspaceId }, role: 'Lead' } })
    const live = await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId: lead.id, kind: 'implementation', status: 'working', leadTurn: 'base', pid: child.pid ?? 0, provider: 'claude_code', startedAt: new Date(Date.now() - 11 * 60_000) },
    })
    await prisma.task.update({ where: { id: task.id }, data: { status: 'running', activeRunId: live.id } })
    const cancelled: string[] = []
    const stub = { cancel: async (runId: string): Promise<void> => void cancelled.push(runId) } as unknown as SlaveRuntimeAdapter

    await runGoalPass({ ...f.deps, registry: { resolve: () => stub } }, { mayStartRuns: false })

    expect(cancelled).toEqual([live.id])
    expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({ status: 'stopping', failureClass: 'platform' })
    expect(readLeadProgress((await leadDelivery(f)).leadProgress).leadEnded).toBe('time_spent')
    expect((await leadDelivery(f)).status).toBe('accepted')
    child.kill('SIGKILL')
  })

  it('leaves an accepted version whose lead is done alone, whatever the time (task 10 review)', async (): Promise<void> => {
    const f = await seedLead({ timeLimitMs: 10 * 60_000, autoMerge: false })
    await tickUntil(f, async () => (await leadDelivery(f)).status === 'accepted')
    const turn = await prisma.slaveRun.findFirstOrThrow({ where: { leadTurn: { not: null } } })
    await prisma.slaveRun.update({ where: { id: turn.id }, data: { startedAt: new Date((turn.endedAt ?? new Date()).getTime() - 11 * 60_000) } })

    await runGoalPass(f.deps, { mayStartRuns: false })

    expect(readLeadProgress((await leadDelivery(f)).leadProgress).leadEnded).toBeNull()
    expect((await leadTaskOf(f)).status).toBe('done')
  })

  it('keeps the state word in step with the version and says each change once', async (): Promise<void> => {
    const f = await seedLead()
    await tickUntil(f, merged(f))
    await tick(f.deps)
    await drainPumps()
    const states = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_lead_state' }, orderBy: { seq: 'asc' }, select: { payload: true } })
    expect(states.map((row) => (row.payload as { state: string }).state)).toEqual(['building', 'proving', 'delivered'])
    expect(await leadDelivery(f)).toMatchObject({ leadState: 'delivered', stopReason: 'proven' })
  })

  it('shows the state, the spend, the turns and the subordinates by person from the CLI\'s read', async (): Promise<void> => {
    const ada = await prisma.person.create({ data: { name: 'Ada Backend', profile: 'You build APIs.' } })
    const f = await seedLead({ budgetUsd: 30, roster: [ada.id], leadArgs: () => [...cost(2), '--subordinate', 'ada-backend'] })
    await tickUntil(f, merged(f))
    await tick(f.deps)
    await drainPumps()

    const view = await leadStatus(f.workspaceId)
    if (!view.ok) throw new Error('lead-status was refused')
    expect(view.value).toMatchObject({ goalVersion: 1, state: 'delivered', stopReason: 'proven', budgetUsd: 30 })
    expect(view.value.spend.leadUsd).toBe(2)
    expect(view.value.turns.map((t) => [t.turn, t.status, t.resumed, t.costUsd])).toEqual([['build', 'succeeded', false, 2]])
    expect(view.value.subordinates).toEqual([{ name: 'ada-backend', personId: ada.id, calls: 1, running: 0 }])
    expect(view.value.lastCommits.length).toBeGreaterThan(0)
    expect(view.value.notes.map((n) => n.kind)).toContain('turn')
  })
})
