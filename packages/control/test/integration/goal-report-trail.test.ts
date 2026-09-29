/**
 * Conductor Plan 5, Task 3: a goal version's spend (plan D5), its decision trail (D6) and its
 * questions, read from recorded rows. Versions 1 and 10 share a workspace in every case, so a
 * prefix that matched both would show up here.
 */
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { loadVersionScope, versionQuestions, versionTrail } from '../../src/goalReportTrail.js'
import { versionSpend } from '../../src/goalReportSpend.js'

interface Seeded {
  readonly workspaceId: string
  readonly slaveId: string
  readonly taskOf: Readonly<Record<1 | 10, string>>
  readonly deliveryOf: Readonly<Record<1 | 10, string>>
}

async function seed(): Promise<Seeded> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Report Trail', repoPath: '/tmp/report-trail', verifyCommands: ['true'], setupCommands: [], delivery: 'conducted', budgetUsd: 20 },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const alex = await prisma.person.create({ data: { name: 'Alex Trail' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, role: 'backend', runtimeRoles: ['implementer'], personId: alex.id } })
  const taskOf = {} as Record<1 | 10, string>
  const deliveryOf = {} as Record<1 | 10, string>
  for (const version of [1, 10] as const) {
    const delivery = await prisma.goalDelivery.create({
      data: { workspaceId: workspace.id, goalVersion: version, integrationBranch: `slaveofai/goal-v${String(version)}-x`, baseCommit: 'b'.repeat(40) },
    })
    deliveryOf[version] = delivery.id
    const pkg = await prisma.workPackage.create({
      data: { workspaceId: workspace.id, goalVersion: version, key: `pkg${String(version)}`, title: 'p', requirementKeys: ['R1'], ownedPaths: ['**'], interface: '', templateId: 'tpl' },
    })
    const task = await prisma.task.create({
      data: { workspaceId: workspace.id, title: 'p', description: 'x', status: 'done', requiredRole: 'implementer', maxAttempts: 3, workPackageId: pkg.id, goalVersion: version, assigneeId: slave.id },
    })
    taskOf[version] = task.id
  }
  return { workspaceId: workspace.id, slaveId: slave.id, taskOf, deliveryOf }
}

const decision = (workspaceId: string, subjectId: string, modelCostUsd: number | null, modelCalled: boolean) =>
  prisma.supervisorDecision.create({
    data: {
      workspaceId, situationKind: 'goal_needs_human', subjectId, situation: {}, candidates: [], chosenIndex: 0,
      action: { kind: 'no_action' }, rationale: 'r', tier: 'applied', status: 'applied', decidedBy: 'rules', modelCostUsd, modelCalled,
    },
  })

/** The newest event's time, set by hand: `appendEvent` stamps `now()`, and a case about ordering
 *  needs a time that disagrees with `seq`. */
async function stampLastEvent(workspaceId: string, ts: Date): Promise<void> {
  const last = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId }, orderBy: { seq: 'desc' }, select: { seq: true } })
  await prisma.executionEvent.update({ where: { seq: last.seq }, data: { ts } })
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "ConductorCall", "VerificationResult", "SlaveRun", "Task", "WorkPackage", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('versionSpend', () => {
  it("sums the version's runs, conductor calls and decisions, charges the unmeasured, and leaves v10 out", async (): Promise<void> => {
    const s = await seed()
    // Every run spawned (`provider` written) unless it says otherwise: `sumSpend` counts only a
    // spawned, finished run with no cost as unmeasured.
    const run = (taskId: string | null, costUsd: number | null, status: 'succeeded' | 'working' | 'failed', goalDeliveryId?: string, spawned = true) =>
      prisma.slaveRun.create({
        data: { taskId, slaveId: s.slaveId, status, costUsd, provider: spawned ? 'claude_code' : null, ...(goalDeliveryId === undefined ? {} : { goalDeliveryId, kind: 'verification' }) },
      })
    await run(s.taskOf[1], 1.5, 'succeeded')
    await run(s.taskOf[1], null, 'succeeded') // unmeasured
    await run(s.taskOf[1], null, 'working') // live
    await run(s.taskOf[1], null, 'failed', undefined, false) // never spawned: spent nothing, not unmeasured
    await run(null, 0.5, 'succeeded', s.deliveryOf[1]) // the verification run
    await run(s.taskOf[10], 9, 'succeeded') // v10's: must not count
    await run(null, 4, 'succeeded', s.deliveryOf[10]) // v10's verification run: must not count
    await prisma.conductorCall.createMany({
      data: [
        { workspaceId: s.workspaceId, goalVersion: 1, stage: 'requirements', outcome: 'ok', modelCostUsd: 0.02 },
        { workspaceId: s.workspaceId, goalVersion: 1, stage: 'conduct', outcome: 'failed', modelCostUsd: null, unmeasured: true },
        { workspaceId: s.workspaceId, goalVersion: 10, stage: 'conduct', outcome: 'ok', modelCostUsd: 5 },
      ],
    })
    await decision(s.workspaceId, `${s.workspaceId}:v1:r1`, 0.1, true)
    await decision(s.workspaceId, `${s.workspaceId}:v10:r1`, 0.7, true) // v10's
    await decision(s.workspaceId, `${s.workspaceId}:v10`, 0.3, true) // v10's conduct subject
    await decision(s.workspaceId, s.taskOf[1], null, true) // about v1's task, unmeasured

    const scope = await loadVersionScope(s.workspaceId, 1)
    const spend = await versionSpend(scope, [])

    expect(spend).toEqual(
      expect.objectContaining({
        runsMeasuredUsd: 2,
        runsUnmeasured: 1,
        runsLive: 1,
        conductorMeasuredUsd: 0.02,
        conductorUnmeasuredCalls: 1,
        supervisorMeasuredUsd: 0.1,
        supervisorUnmeasuredCalls: 1,
        projectBudgetUsd: 20,
      }),
    )
    // 2 + 0.02 + 1 x CONDUCT cap + 0.1 + 1 x SUPERVISOR cap (both caps are $1 today: read them, never hard-code).
    const { CONDUCT_PER_CALL_CAP_USD, SUPERVISOR_PER_CALL_CAP_USD } = await import('@slave-of-ai/domain')
    expect(spend.versionUsd).toBeCloseTo(2.12 + CONDUCT_PER_CALL_CAP_USD + SUPERVISOR_PER_CALL_CAP_USD, 6)
    // The project figure is the one spend formula's, v10's money included.
    const { workspaceSpend } = await import('../../src/spend.js')
    expect(spend.projectSpentUsd).toBeCloseTo((await workspaceSpend(s.workspaceId)).spentUsd, 6)
  })
})

describe('versionTrail', () => {
  it("orders v1's events by seq, merges decisions and failed calls by time, and leaves v10's out", async (): Promise<void> => {
    const s = await seed()
    await appendEvent({ type: 'workspace.requirements_set', workspaceId: s.workspaceId, actor: 'system', payload: { version: 1, count: 2, setId: 'set1' } })
    await appendEvent({ type: 'workspace.requirements_set', workspaceId: s.workspaceId, actor: 'system', payload: { version: 10, count: 9, setId: 'set10' } })
    await appendEvent({ type: 'task.rework', workspaceId: s.workspaceId, taskId: s.taskOf[1], actor: 'system', payload: { reason: 'R1 fails: prints JSON', attempt: 0, verificationRound: 1 } })
    await appendEvent({ type: 'task.rework', workspaceId: s.workspaceId, taskId: s.taskOf[10], actor: 'system', payload: { reason: 'other', attempt: 1 } })
    await appendEvent({ type: 'guardrail.tripped', workspaceId: s.workspaceId, actor: 'system', payload: { guardrail: 'merge_failure', detail: 'goal v1 is accepted and autoMerge is off: merge it' } })
    await appendEvent({ type: 'guardrail.tripped', workspaceId: s.workspaceId, actor: 'system', payload: { guardrail: 'merge_failure', detail: 'goal v10 is accepted and autoMerge is off: merge it' } })
    await prisma.conductorCall.create({ data: { workspaceId: s.workspaceId, goalVersion: 1, stage: 'conduct', outcome: 'failed', reason: 'not JSON' } })
    await prisma.conductorCall.create({ data: { workspaceId: s.workspaceId, goalVersion: 10, stage: 'conduct', outcome: 'failed', reason: 'v10' } })
    await decision(s.workspaceId, `${s.workspaceId}:v10:r1`, null, false) // v10's

    const { entries, omitted } = await versionTrail(await loadVersionScope(s.workspaceId, 1), [])

    expect(omitted).toBe(0)
    expect(entries.map((e) => e.text)).toEqual([
      '2 requirements were extracted from the goal.',
      'pkg1: sent back for rework by verification round 1.',
      'Waiting: goal v1 is accepted and autoMerge is off: merge it',
      "The conductor's conduct call failed.",
    ])
    expect(entries[1]).toEqual(expect.objectContaining({ detail: 'R1 fails: prints JSON', detailBy: 'model', packageKey: 'pkg1' }))
    expect(entries[3]).toEqual(expect.objectContaining({ detail: 'not JSON', detailBy: 'system' }))
  })

  it('keeps events in seq order even when their times disagree, and merges calls and decisions in by time (ruling R5)', async (): Promise<void> => {
    const s = await seed()
    const t0 = new Date('2026-09-01T00:00:00.000Z')
    const at = (seconds: number): Date => new Date(t0.getTime() + seconds * 1000)
    await appendEvent({ type: 'workspace.verification_started', workspaceId: s.workspaceId, actor: 'system', payload: { version: 1, round: 1, runId: 'r1' } })
    await stampLastEvent(s.workspaceId, at(10))
    await appendEvent({ type: 'workspace.verification_started', workspaceId: s.workspaceId, actor: 'system', payload: { version: 1, round: 2, runId: 'r2' } })
    await stampLastEvent(s.workspaceId, at(0)) // later seq, earlier time
    await prisma.conductorCall.create({ data: { workspaceId: s.workspaceId, goalVersion: 1, stage: 'requirements', outcome: 'failed', createdAt: at(5) } })
    const late = await decision(s.workspaceId, `${s.workspaceId}:v1:r2`, null, false)
    await prisma.supervisorDecision.update({ where: { id: late.id }, data: { createdAt: at(20) } })

    const { entries } = await versionTrail(await loadVersionScope(s.workspaceId, 1), [])

    expect(entries.map((e) => e.text)).toEqual([
      "The conductor's requirements call failed.",
      'Verification round 1 started.',
      'Verification round 2 started.',
      expect.stringMatching(/^Supervisor: /),
    ])
  })

  it("includes the Supervisor decisions about the version's questions, and not v10's (ruling R4)", async (): Promise<void> => {
    const s = await seed()
    const ask = (taskId: string, body: string) =>
      prisma.slaveMessage.create({ data: { workspaceId: s.workspaceId, taskId, slaveId: s.slaveId, threadId: body, kind: 'question', body, expectsReply: true, actor: 'slave' } })
    const q1 = await ask(s.taskOf[1], 'v1?')
    const q10 = await ask(s.taskOf[10], 'v10?')
    await decision(s.workspaceId, q1.id, 0.25, true)
    await decision(s.workspaceId, q10.id, 0.5, true)

    const scope = await loadVersionScope(s.workspaceId, 1)
    const questionIds = (await versionQuestions(scope)).map((q) => q.id)
    const { entries } = await versionTrail(scope, questionIds)
    const spend = await versionSpend(scope, questionIds)

    expect(questionIds).toEqual([q1.id])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.text).toMatch(/^Supervisor: /)
    expect(spend.supervisorMeasuredUsd).toBe(0.25)
  })

  // Round 2 X2: with no delivery, a package merges into the base branch, but with autoMerge off
  // merge.ts writes `task.done` without any git merge; a person may confirm the merge later.
  it("does not say Slave merged a pre-delivery package it marked done with autoMerge off, and shows a person's confirmation", async (): Promise<void> => {
    const s = await seed()
    await prisma.workspace.update({ where: { id: s.workspaceId }, data: { baseBranch: 'trunk' } })
    await prisma.goalDelivery.delete({ where: { id: s.deliveryOf[1] } })
    await appendEvent({ type: 'task.done', workspaceId: s.workspaceId, taskId: s.taskOf[1], actor: 'system', payload: { branch: 'b1' } })
    const texts = async (): Promise<readonly string[]> => (await versionTrail(await loadVersionScope(s.workspaceId, 1), [])).entries.map((e) => e.text)
    expect(await texts()).toEqual(['pkg1: done; auto-merge was off, so Slave did not merge it into trunk.'])

    // confirmIntegration's own writes: the stamp, then `task.integrated` by a person.
    await prisma.task.update({ where: { id: s.taskOf[1] }, data: { integratedAt: new Date() } })
    await appendEvent({ type: 'task.integrated', workspaceId: s.workspaceId, taskId: s.taskOf[1], actor: 'human', payload: {} })
    expect(await texts()).toEqual(['pkg1: done; auto-merge was off, so Slave did not merge it into trunk.', 'pkg1: confirmed merged into trunk by a person.'])
  })

  it('says a pre-delivery package Slave merged merged into the base branch', async (): Promise<void> => {
    const s = await seed()
    await prisma.workspace.update({ where: { id: s.workspaceId }, data: { baseBranch: 'trunk' } })
    await prisma.goalDelivery.delete({ where: { id: s.deliveryOf[1] } })
    await prisma.task.update({ where: { id: s.taskOf[1] }, data: { integratedAt: new Date() } })
    await appendEvent({ type: 'task.done', workspaceId: s.workspaceId, taskId: s.taskOf[1], actor: 'system', payload: { branch: 'b1' } })
    const { entries } = await versionTrail(await loadVersionScope(s.workspaceId, 1), [])
    expect(entries.map((e) => e.text)).toEqual(['pkg1: merged into trunk.'])
  })

  it('keeps the newest entries and counts the rest', async (): Promise<void> => {
    const s = await seed()
    for (let round = 1; round <= 4; round += 1) {
      await appendEvent({ type: 'workspace.verification_started', workspaceId: s.workspaceId, actor: 'system', payload: { version: 1, round, runId: `r${String(round)}` } })
    }
    const { entries, omitted } = await versionTrail(await loadVersionScope(s.workspaceId, 1), [], 3)
    expect(omitted).toBe(1)
    expect(entries.map((e) => e.text)).toEqual(['Verification round 2 started.', 'Verification round 3 started.', 'Verification round 4 started.'])
  })

  it('names the size decision, its reason as the model wrote it, and who holds each package', async (): Promise<void> => {
    const s = await seed()
    await prisma.supervisorDecision.create({
      data: {
        workspaceId: s.workspaceId, situationKind: 'conduct', subjectId: `${s.workspaceId}:v1`, situation: {}, candidates: [], chosenIndex: 0,
        action: { kind: 'conduct', goalVersion: 1, mode: 'single', packageKeys: ['pkg1'] }, rationale: 'fits one session', tier: 'applied', status: 'applied', decidedBy: 'model',
      },
    })
    await appendEvent({ type: 'workspace.conducted', workspaceId: s.workspaceId, actor: 'system', payload: { version: 1, mode: 'single', packages: ['pkg1'], decisionId: 'd', fallback: false } })

    const { entries } = await versionTrail(await loadVersionScope(s.workspaceId, 1), [])

    expect(entries.map((e) => e.text)).toEqual(['Size decision: one package does the whole goal.', 'Staffed: pkg1 by Alex Trail; no verifier recorded.'])
    expect(entries[0]).toEqual(expect.objectContaining({ detail: 'fits one session', detailBy: 'model' }))
  })
})

describe('versionQuestions', () => {
  it("lists every question on the version's package tasks with its first answer, and who answered", async (): Promise<void> => {
    const s = await seed()
    const asked = await prisma.slaveMessage.create({
      data: { workspaceId: s.workspaceId, taskId: s.taskOf[1], slaveId: s.slaveId, threadId: 't1', kind: 'question', body: 'Header row?', recipientRole: 'conductor', expectsReply: true, actor: 'slave' },
    })
    await prisma.slaveMessage.create({
      data: { workspaceId: s.workspaceId, taskId: s.taskOf[1], slaveId: s.slaveId, threadId: 't1', kind: 'answer', body: 'Yes.', replyToId: asked.id, actor: 'system' },
    })
    await prisma.slaveMessage.create({
      data: { workspaceId: s.workspaceId, taskId: s.taskOf[1], slaveId: s.slaveId, threadId: 't2', kind: 'question', body: 'Quote all?', expectsReply: true, actor: 'slave' },
    })
    await prisma.slaveMessage.create({
      data: { workspaceId: s.workspaceId, taskId: s.taskOf[10], slaveId: s.slaveId, threadId: 't3', kind: 'question', body: 'v10?', expectsReply: true, actor: 'slave' },
    })

    const questions = await versionQuestions(await loadVersionScope(s.workspaceId, 1))

    expect(questions).toEqual([
      expect.objectContaining({ id: asked.id, packageKey: 'pkg1', askedBy: 'Alex Trail', question: 'Header row?', answer: expect.objectContaining({ by: 'supervisor', text: 'Yes.' }) }),
      expect.objectContaining({ packageKey: 'pkg1', question: 'Quote all?', answer: null }),
    ])
  })
})
