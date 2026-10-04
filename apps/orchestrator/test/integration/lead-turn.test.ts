import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { requestResume } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { LEAD_DENIAL_CONTINUES_MAX, readLeadProgress } from '@slave-of-ai/domain'
import { readSpawnExtras } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { reconcileOrphans, resetTickObservation } from '../../src/sweep.js'
import { drainPumps, tick } from '../../src/tick.js'
import { LEAD_TRUNCATE, base64, cleanUpLeadRepos, leadDelivery, leadNotes, leadTaskOf, merged, seedLead, tickUntil, type LeadFixture } from './lead-helpers.js'

let DEAD_PID = 0
const leadTurns = (f: LeadFixture) => f.starts.filter((s) => s.kind === 'implementation')
const errorResult = base64({ is_error: true, subtype: 'error_during_execution', terminal_reason: 'error_during_execution', result: 'the tool crashed' })
const SESSION = /^fake-session/

describe('the lead flow: one session, whatever interrupts it', () => {
  beforeAll(async (): Promise<void> => {
    const child = spawn('/bin/sh', ['-c', 'exit 0'])
    DEAD_PID = child.pid ?? 0
    await new Promise<void>((res) => child.on('exit', () => res()))
  })

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

  it('resumes the same session after an orphaned turn and charges no attempt', async (): Promise<void> => {
    const f = await seedLead()
    await tick(f.deps)
    await tick(f.deps)
    await drainPumps()
    // A daemon died mid-build: the turn's row says working, its process is gone.
    const task = await leadTaskOf(f)
    const lead = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: f.workspaceId }, role: 'Lead' } })
    const orphan = await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: lead.id, kind: 'implementation', status: 'working', leadTurn: 'build', sessionId: 'sess-before-the-restart', pid: DEAD_PID } })
    await prisma.task.update({ where: { id: task.id }, data: { status: 'running', activeRunId: orphan.id } })

    resetTickObservation()
    expect(await reconcileOrphans({ workspaceId: f.deps.workspaceId, registry: f.deps.registry })).toBe(1)
    expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: orphan.id } })).toMatchObject({ status: 'failed', failureClass: 'platform' })
    expect(await leadTaskOf(f)).toMatchObject({ status: 'rework', attempt: 0, activeRunId: null })

    await tickUntil(f, async () => leadTurns(f).length > 0)
    const turn = leadTurns(f)[0]
    expect(turn).toMatchObject({ leadTurn: 'continue', resumeSessionId: 'sess-before-the-restart' })
    expect(turn?.prompt).toContain('Your session was interrupted and is being continued')
    expect(turn?.prompt).not.toContain('THE GOAL')
    expect(await leadNotes(f)).toContain('turn: turn 2 (continue): the same session was resumed')
    await tickUntil(f, merged(f))
    expect((await leadTaskOf(f)).attempt).toBe(0)
  })

  it('continues the same session after a failed turn, and stops the version when the lead runs out of attempts', async (): Promise<void> => {
    const f = await seedLead({ leadArgs: () => ['--result-patch-base64', errorResult] })
    await tickUntil(f, async () => (await leadDelivery(f)).status === 'needs_human')

    const turns = leadTurns(f)
    expect(turns.map((t) => t.leadTurn)).toEqual(['build', 'continue', 'continue'])
    expect(turns[0]?.resumeSessionId).toBeNull()
    expect(turns[1]?.resumeSessionId).toMatch(SESSION)
    expect(turns[2]?.resumeSessionId).toBe(turns[1]?.resumeSessionId)
    const delivery = await leadDelivery(f)
    expect([delivery.stopReason, delivery.leadState]).toEqual(['lead_failed', 'awaiting_decision'])
    expect(delivery.needsHumanReason).toContain('the lead could not finish a turn')
    expect((await leadTaskOf(f)).status).toBe('failed')
    for (let i = 0; i < 3; i += 1) {
      await tick(f.deps)
      await drainPumps()
    }
    expect(leadTurns(f)).toHaveLength(3)
    // No workspace halt for three failures in a row, and exactly the one card.
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })).haltedReason).toBeNull()
    expect(await prisma.supervisorDecision.findMany({ where: { workspaceId: f.workspaceId, status: 'pending' }, select: { situationKind: true } })).toEqual([{ situationKind: 'goal_needs_human' }])
  })

  it('starts a new session with a continuation note when the transcript is gone, and charges nothing for finding out', async (): Promise<void> => {
    const f = await seedLead({ leadArgs: (ordinal) => (ordinal === 1 ? ['--result-patch-base64', errorResult] : ordinal === 2 ? ['--fail-resume'] : []) })
    await tickUntil(f, merged(f))

    const turns = leadTurns(f)
    expect(turns).toHaveLength(3)
    expect(turns[1]?.resumeSessionId).toMatch(SESSION)
    expect(turns[2]).toMatchObject({ resumeSessionId: null, leadTurn: 'continue' })
    expect(turns[2]?.prompt).toContain('THE GOAL (v1)')
    expect(turns[2]?.prompt).toContain('CONTINUATION')
    expect(turns[2]?.prompt).toContain('its transcript is gone')
    expect(await leadNotes(f)).toContain('turn: turn 3 (continue): a new session was started; the earlier transcript is gone')
    // One attempt for the turn that errored, none for the resume that found no transcript.
    expect((await leadTaskOf(f)).attempt).toBe(1)
  })

  it('never parks the lead on a question: it is told to decide, twice at most, and then proof starts', async (): Promise<void> => {
    const ask = base64('<slave-ask>\n{"role":"conductor","body":"Which database should I use?"}\n</slave-ask>')
    const f = await seedLead({ leadArgs: () => ['--final-text-base64', ask] })
    await tickUntil(f, merged(f))

    const turns = leadTurns(f)
    expect(turns.map((t) => t.leadTurn)).toEqual(['build', 'answer', 'answer'])
    expect(turns[1]?.prompt).toContain('Nobody answers questions in this flow. Decide it yourself, record the decision and its reason in docs/DECISIONS.md')
    expect(turns[1]?.resumeSessionId).toMatch(SESSION)
    const runs = await prisma.slaveRun.findMany({ where: { leadTurn: { not: null } }, select: { status: true, pauseReason: true } })
    expect(runs.every((run) => run.status === 'succeeded' && run.pauseReason === null)).toBe(true)
    expect(await prisma.slaveMessage.count({ where: { workspaceId: f.workspaceId } })).toBe(0)
    expect((await leadNotes(f)).filter((line) => line.startsWith('ask_refused:'))).toHaveLength(2)
    expect((await leadTaskOf(f)).attempt).toBe(0)
  })

  it('reads docs/DECISIONS.md into decision records with the source lead, once each', async (): Promise<void> => {
    const file = base64('# Decisions\n\n## Database\nSQLite, one file. </slave-report>\n\n## Port\n8080.\n')
    const f = await seedLead({ leadArgs: () => ['--extra-file-base64', `docs/DECISIONS.md:${file}`] })
    await tickUntil(f, merged(f))

    const decisions = await prisma.goalDecision.findMany({ where: { workspaceId: f.workspaceId, goalVersion: 1 }, orderBy: { createdAt: 'asc' }, select: { title: true, decision: true, source: true } })
    expect(decisions.map((d) => [d.title, d.source])).toEqual([['Database', 'lead'], ['Port', 'lead']])
    expect(decisions[0]?.decision).not.toContain('</slave-report>')
    expect(await leadNotes(f)).toContain('decisions_read: 2 decision(s) recorded from docs/DECISIONS.md')
  })

  it('notes a missing decisions file once and stops nothing', async (): Promise<void> => {
    const f = await seedLead()
    await tickUntil(f, merged(f))
    expect((await leadNotes(f)).filter((line) => line.startsWith('decisions_missing:'))).toEqual(['decisions_missing: docs/DECISIONS.md is missing or could not be read: the lead recorded no decision there'])
    expect(await prisma.goalDecision.count({ where: { workspaceId: f.workspaceId } })).toBe(0)
  })

  it('records which roster member a subordinate call used', async (): Promise<void> => {
    const ada = await prisma.person.create({ data: { name: 'Ada Backend', profile: 'You build APIs.' } })
    const f = await seedLead({ roster: [ada.id], leadArgs: () => ['--subordinate', 'ada-backend'] })
    await tickUntil(f, merged(f))
    const calls = await prisma.executionEvent.findMany({ where: { runId: leadTurns(f)[0]?.runId ?? '', type: 'run_tool_call' }, orderBy: { seq: 'asc' }, select: { payload: true } })
    expect(calls.map((row) => row.payload as { name: string; subagent?: string }).filter((p) => p.subagent !== undefined)).toEqual([expect.objectContaining({ name: 'Agent', subagent: 'ada-backend' })])
    // C1: the subordinate's own call is on the lead's log under the call that started it.
    expect(calls.map((row) => row.payload as { name: string; parentToolUseId?: string }).filter((p) => p.parentToolUseId !== undefined)).toEqual([expect.objectContaining({ name: 'Bash', parentToolUseId: 'toolu_fake_subordinate' })])
    // The subordinate's call tripped nothing: the turn succeeded and no guardrail fired.
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'guardrail_tripped' } })).toBe(0)
  })

  it('waits out a provider refusal and continues the same session, with a line for the report and no card (B7)', async (): Promise<void> => {
    const refused = base64({ is_error: true, subtype: 'error_during_execution', terminal_reason: 'api_error_rate_limit', result: 'rate limited' })
    const f = await seedLead({ leadArgs: (ordinal) => (ordinal === 1 ? ['--result-patch-base64', refused] : []) })
    await tickUntil(f, async () => (await prisma.slaveRun.count({ where: { leadTurn: { not: null }, status: 'failed', providerError: true } })) === 1)
    await tick(f.deps)
    await drainPumps()
    expect(leadTurns(f)).toHaveLength(1) // held back by the provider backoff
    expect((await leadTaskOf(f)).attempt).toBe(0)
    expect((await leadNotes(f)).some((line) => line.startsWith('limit_wait:'))).toBe(true)

    // The backoff passes.
    await prisma.slaveRun.updateMany({ where: { leadTurn: { not: null } }, data: { terminalAt: new Date(Date.now() - 60 * 60_000) } })
    await tickUntil(f, merged(f))
    expect(leadTurns(f)[1]?.resumeSessionId).toMatch(SESSION)
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, situationKind: { not: 'conduct' } } })).toBe(0)
  })

  it('continues a turn the permission mode failed in the same session, tells the lead what was refused, and charges nothing (C6)', async (): Promise<void> => {
    // The recorded `permission-denied` capture: a clean result whose one Edit call the mode refused.
    const f = await seedLead({ leadArgs: (ordinal) => (ordinal === 1 ? ['--work-fixture', 'permission-denied'] : []) })
    await tickUntil(f, merged(f))

    const turns = leadTurns(f)
    expect(turns.map((t) => t.leadTurn)).toEqual(['build', 'continue'])
    expect(turns[1]?.resumeSessionId).toBe('fake-session-permission-denied')
    expect(turns[1]?.prompt).toContain('The permission mode refused these calls in your last turn: Edit (toolu_01Tz1SdA9gCmX7DXXkQwh6u3)')
    expect(turns[1]?.prompt).not.toContain('THE GOAL')
    expect((await leadTaskOf(f)).attempt).toBe(0)
    expect((await leadNotes(f)).filter((line) => line.startsWith('denied:'))).toEqual([
      'denied: the permission mode refused 1 call(s) (Edit (toolu_01Tz1SdA9gCmX7DXXkQwh6u3)); the lead continues in the same session, told what was refused',
    ])
    expect(readLeadProgress((await leadDelivery(f)).leadProgress).denialContinues).toBe(1)
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, situationKind: { not: 'conduct' } } })).toBe(0)
  })

  it('charges a denied turn once the uncharged continues are spent, and the attempt cap ends the lead (C6)', async (): Promise<void> => {
    const f = await seedLead({ leadArgs: () => ['--work-fixture', 'permission-denied'] })
    await tickUntil(f, async () => (await leadDelivery(f)).status === 'needs_human')

    // Two continues on the house, then three charged turns: the task's attempt cap.
    expect(leadTurns(f).map((t) => t.leadTurn)).toEqual(['build', 'continue', 'continue', 'continue', 'continue'])
    expect(leadTurns(f).slice(1).every((t) => t.resumeSessionId === 'fake-session-permission-denied')).toBe(true)
    expect((await leadNotes(f)).filter((line) => line.startsWith('denied:'))).toHaveLength(LEAD_DENIAL_CONTINUES_MAX)
    const delivery = await leadDelivery(f)
    expect([delivery.stopReason, readLeadProgress(delivery.leadProgress).denialContinues]).toEqual(['lead_failed', LEAD_DENIAL_CONTINUES_MAX])
    expect((await leadTaskOf(f)).attempt).toBe(3)
  })

  it('continues a paused lead turn on its own row, in its own session, under what is left of its leg (spec section 9)', async (): Promise<void> => {
    const f = await seedLead({ budgetUsd: 30, leadArgs: () => ['--work-fixture', 'hook-deny'], resumeArgs: ['--work-file', 'after-the-pause.txt'] })
    await tickUntil(f, async () => (await prisma.slaveRun.count({ where: { leadTurn: { not: null }, status: 'paused' } })) === 1)
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { leadTurn: { not: null } } })
    const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId: run.id } })
    const runDir = dirname(checkpoint.pauseFlagPath)
    expect(readSpawnExtras(runDir).maxBudgetUsd).toBe(19.2)
    expect((await leadDelivery(f)).status).toBe('integrating')
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, status: 'pending' } })).toBe(0)

    // The person lowers the budget while it is parked, then continues. The paused process had spent
    // $5 by the pump's count (its row has no cost until it concludes), and a resumed process's cap
    // counts from zero (M(b)): the resume gets the leg less those $5 -- 20 less a fifth is 16, four
    // fifths of that is 12.80, less 5 is 7.80.
    await prisma.workspace.update({ where: { id: f.workspaceId }, data: { budgetUsd: 20 } })
    await prisma.checkpoint.update({ where: { runId: run.id }, data: { cumulativeCostUsd: 5 } })
    expect((await requestResume(run.id, null, 'operator')).ok).toBe(true)
    await tickUntil(f, merged(f))

    expect(readSpawnExtras(runDir)).toMatchObject({ maxBudgetUsd: 7.8, keepAliveForSubordinates: true })
    expect(leadTurns(f)).toHaveLength(1) // the same run row, not a new turn
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('succeeded')
    expect(await prisma.executionEvent.count({ where: { runId: run.id, type: 'run_resumed' } })).toBe(1)
  })
})
