import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { goalSpend } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { LEAD_MIN_LEG_USD, cents, readLeadProgress } from '@slave-of-ai/domain'
import { readSpawnExtras, writeSpawnExtras } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openLeadGoal } from '../../src/lead/open.js'
import { refreshLeadProofSpawn } from '../../src/lead/proofRun.js'
import { applySmokeOutcome } from '../../src/smoke.js'
import { resetTickObservation } from '../../src/sweep.js'
import { drainPumps, tick } from '../../src/tick.js'
import { LEAD_TRUNCATE, base64, checked, cleanUpLeadRepos, git, leadDelivery, leadNotes, leadTaskOf, merged, seedLead, tickUntil, type LeadFixture, type LeadSeedOptions } from './lead-helpers.js'

const ALL = ['R1', 'R2', 'RUN']
const leadTurns = (f: LeadFixture) => f.starts.filter((s) => s.kind === 'implementation')
const proofRuns = (f: LeadFixture) => f.starts.filter((s) => s.kind === 'verification')
const stopped = (f: LeadFixture) => async (): Promise<boolean> => (await leadDelivery(f)).status === 'needs_human'
const cards = (f: LeadFixture) => prisma.supervisorDecision.findMany({ where: { workspaceId: f.workspaceId, status: 'pending' }, select: { situationKind: true } })

/** A verifier script: run n answers `failing[n - 1]` (keys that fail; `'?'` + key: unverifiable) among the keys it was asked; past the end, everything passes. */
function script(failing: readonly (readonly string[])[]): NonNullable<LeadSeedOptions['verify']> {
  return (ordinal, run) => {
    const marks = failing[ordinal - 1]
    if (marks === undefined) return undefined
    return (run.keys.length === 0 ? ALL : run.keys).map((key) => checked(key, marks.includes(key) ? 'fail' : marks.includes(`?${key}`) ? 'unverifiable' : 'pass'))
  }
}

describe('the lead flow: proof gates', () => {
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

  it('confirms a failure, reworks it in the lead\'s own session with the evidence, re-checks only it, and ends on a full verification', async (): Promise<void> => {
    const f = await seedLead({ verify: script([['R1'], ['R1'], [], []]) })
    await tickUntil(f, merged(f))

    expect(proofRuns(f).map((run) => [run.confirms, run.verificationKeys])).toEqual([[false, []], [true, ['R1']], [false, ['R1']], [false, []]])
    const seats = await prisma.slaveRun.findMany({ where: { id: { in: proofRuns(f).map((run) => run.runId) } }, orderBy: { startedAt: 'asc' }, select: { slave: { select: { role: true } } } })
    expect(seats.map((run) => run.slave.role)).toEqual(['Verifier', 'Confirmer', 'Verifier', 'Verifier'])
    expect(proofRuns(f)[1]?.prompt).toContain('Requirement keys: R1\n')
    expect(proofRuns(f)[1]?.prompt).not.toContain('R2:')
    // C5: the verifier and the confirmer run on Claude Code with no `--model` either.
    expect(proofRuns(f).map((run) => run.model)).toEqual([null, null, null, null])
    expect(await prisma.slaveRun.count({ where: { kind: 'verification', model: { not: null } } })).toBe(0)

    expect(leadTurns(f).map((turn) => turn.leadTurn)).toEqual(['build', 'rework'])
    const rework = leadTurns(f)[1]
    expect(rework?.resumeSessionId).toBe('fake-session-complete')
    expect(rework?.prompt).toContain('independent verification')
    expect(rework?.prompt).toContain('R1: GET /health answers 200')
    expect(rework?.prompt).toContain('404 Not Found')
    expect(rework?.prompt).not.toContain('THE GOAL')
    expect((await leadTaskOf(f)).attempt).toBe(0)

    const delivery = await leadDelivery(f)
    expect([delivery.stopReason, delivery.round]).toEqual(['proven', 3])
    expect(readLeadProgress(delivery.leadProgress)).toMatchObject({ failing: [], recheckKeys: [], disputed: [], confirm: null })
    const confirmRows = await prisma.verificationResult.findMany({ where: { runId: proofRuns(f)[1]?.runId ?? '' }, select: { key: true, status: true, round: true } })
    expect(confirmRows).toEqual([{ key: 'R1', status: 'fail', round: 1 }])
    // Two smoke checks: the first tip and the reworked one (P5).
    expect(await prisma.smokeAttempt.count({ where: { status: 'passed' } })).toBe(2)
    expect(await cards(f)).toEqual([])
  })

  it('does not rework a failure the confirmer does not confirm: the key is disputed and the version waits for a decision', async (): Promise<void> => {
    const f = await seedLead({ verify: script([['R1'], []]) })
    await tickUntil(f, stopped(f))

    expect(leadTurns(f)).toHaveLength(1)
    expect((await leadTaskOf(f)).status).toBe('done')
    const delivery = await leadDelivery(f)
    expect([delivery.stopReason, delivery.leadState]).toEqual(['not_all_proven', 'awaiting_decision'])
    expect(delivery.needsHumanReason).toContain('disputed (the two verifiers disagreed): R1')
    expect(readLeadProgress(delivery.leadProgress).disputed).toEqual(['R1'])
    expect(await leadNotes(f)).toContain('disputed: R1: the first verifier said it fails and the second did not; it is not sent back to the lead')
    for (let i = 0; i < 3; i += 1) {
      await tick(f.deps)
      await drainPumps()
    }
    expect(leadTurns(f)).toHaveLength(1)
    expect(await cards(f)).toEqual([{ situationKind: 'goal_needs_human' }])
  })

  it('stops after two rounds that fail the same set, with one card', async (): Promise<void> => {
    const f = await seedLead({ verify: script([['R1'], ['R1'], ['R1'], ['R1']]) })
    await tickUntil(f, stopped(f))

    expect(leadTurns(f).map((turn) => turn.leadTurn)).toEqual(['build', 'rework'])
    expect(proofRuns(f)).toHaveLength(4)
    const delivery = await leadDelivery(f)
    expect(delivery.stopReason).toBe('no_progress')
    expect(delivery.needsHumanReason).toContain('two rounds in a row failed the same items')
    expect(delivery.needsHumanReason).toContain('failing: R1')
    for (let i = 0; i < 3; i += 1) {
      await tick(f.deps)
      await drainPumps()
    }
    expect(leadTurns(f)).toHaveLength(2)
    expect(await cards(f)).toEqual([{ situationKind: 'goal_needs_human' }])
  })

  it('goes on past an unverifiable requirement and names it at the end (P4)', async (): Promise<void> => {
    const f = await seedLead({ verify: script([['?R1', 'R2'], ['R2'], [], ['?R1']]) })
    await tickUntil(f, stopped(f))

    expect(leadTurns(f).map((turn) => turn.leadTurn)).toEqual(['build', 'rework'])
    const delivery = await leadDelivery(f)
    expect(delivery.stopReason).toBe('not_all_proven')
    expect(delivery.needsHumanReason).toContain('could not be verified: R1')
    expect(delivery.needsHumanReason).not.toContain('failing:')
  })

  it('sends a failing smoke back to the lead and proves the fix; the same smoke failure twice stops the version (P2, P7)', async (): Promise<void> => {
    const fixed = await seedLead({ smokeFailures: 1 })
    await tickUntil(fixed, merged(fixed))
    expect(leadTurns(fixed).map((turn) => turn.leadTurn)).toEqual(['build', 'rework'])
    expect(leadTurns(fixed)[1]?.prompt).toContain('the product did not start')
    expect(proofRuns(fixed)).toHaveLength(1)

    const broken = await seedLead({ smokeFailures: 5 })
    await tickUntil(broken, stopped(broken))
    expect(leadTurns(broken)).toHaveLength(2)
    expect(proofRuns(broken)).toEqual([])
    const delivery = await leadDelivery(broken)
    expect(delivery.stopReason).toBe('no_progress')
    expect(delivery.needsHumanReason).toContain('the smoke check found')
    expect(delivery.needsHumanReason).toContain('failing: SMOKE')
    // The stopping attempt sent nothing back, and its event says so.
    const smokeRuns = await prisma.executionEvent.findMany({ where: { workspaceId: broken.workspaceId, type: 'workspace_smoke_run' }, orderBy: { seq: 'asc' }, select: { payload: true } })
    expect(smokeRuns.map((row) => (row.payload as { reworkedPackage: string | null }).reworkedPackage)).toEqual(['main', null])
  })

  it('queues the smoke\'s rework as the lead\'s next turn, with the smoke\'s evidence as its note (final review)', async (): Promise<void> => {
    const queued: unknown[] = []
    const f = await seedLead({
      smokeFailures: 1,
      onStart: async (start) => {
        // Before the turn is recorded as started, what was queued for it is still on the version.
        if (start.kind === 'implementation' && start.ordinal === 2) queued.push(readLeadProgress((await prisma.goalDelivery.findFirstOrThrow()).leadProgress).nextTurn)
      },
    })
    await tickUntil(f, merged(f))

    expect(queued).toEqual([{ kind: 'rework', note: expect.stringContaining('the product did not start') }])
    expect(leadTurns(f)[1]?.prompt).toContain('the product did not start')
  })

  it('caps a verification at what the goal has left, and stops unproven when nothing is left to pay one', async (): Promise<void> => {
    const cost = (usd: number): readonly string[] => ['--result-patch-base64', base64({ total_cost_usd: usd })]
    const paid = await seedLead({ budgetUsd: 30, leadArgs: () => cost(10) })
    await tickUntil(paid, merged(paid))
    expect(proofRuns(paid)[0]?.extras).toEqual({ maxBudgetUsd: 19.98 })

    const broke = await seedLead({ budgetUsd: 30, leadArgs: () => cost(29.99) })
    await tickUntil(broke, stopped(broke))
    expect(proofRuns(broke)).toEqual([])
    const delivery = await leadDelivery(broke)
    expect(delivery.stopReason).toBe('budget_spent')
    expect(delivery.needsHumanReason).toContain('the result is unproven')
  })

  // Task 9 review, below.
  const cost = (usd: number): readonly string[] => ['--result-patch-base64', base64({ total_cost_usd: usd })]

  it('names the failure awaiting confirmation when the budget cannot pay the confirmer (task 9 review)', async (): Promise<void> => {
    // 29.75 for the lead and 0.02 for the requirement call leave 0.23 for the verifier, whose run
    // (the fake reports about 0.21) leaves less than a run is worth.
    const f = await seedLead({ budgetUsd: 30, leadArgs: () => cost(29.75), verify: script([['R1']]) })
    await tickUntil(f, stopped(f))

    expect(proofRuns(f).map((run) => [run.confirms, run.extras])).toEqual([[false, { maxBudgetUsd: 0.23 }]])
    const delivery = await leadDelivery(f)
    expect(delivery.stopReason).toBe('budget_spent')
    expect(delivery.needsHumanReason).toContain('the first verifier failed R1 and its confirmation could not be paid')
  })

  it('reads a key the confirmer cannot verify as disputed, not as unverifiable (task 9 review)', async (): Promise<void> => {
    const f = await seedLead({ verify: script([['R1'], ['?R1']]) })
    await tickUntil(f, stopped(f))

    const delivery = await leadDelivery(f)
    expect(delivery.stopReason).toBe('not_all_proven')
    expect(readLeadProgress(delivery.leadProgress)).toMatchObject({ disputed: ['R1'], unverifiable: [] })
    expect(delivery.needsHumanReason).not.toContain('could not be verified')
    expect((await leadNotes(f)).filter((line) => line.startsWith('unverifiable:'))).toEqual([])
  })

  it('stops lead_failed, with the lead flow\'s card, when a failing smoke cannot be sent back to the lead\'s task (task 9 review)', async (): Promise<void> => {
    const f = await seedLead()
    await tick(f.deps)
    const set = await prisma.requirementSet.findUniqueOrThrow({ where: { workspaceId_goalVersion: { workspaceId: f.workspaceId, goalVersion: 1 } } })
    expect(await openLeadGoal(f.workspaceId, { repoPath: f.repoPath, baseBranch: 'main', maxAttempts: 3 }, 1, set.items)).toBe('conducted')
    // The lead's task is not `done` (here: never run) while a smoke attempt holds the version and fails.
    const { id: deliveryId } = await leadDelivery(f)
    const attempt = await prisma.smokeAttempt.create({
      data: { workspaceId: f.workspaceId, goalDeliveryId: deliveryId, goalVersion: 1, round: 1, tip: git(['rev-parse', 'main'], f.repoPath), status: 'failed', exitCode: 1, output: 'the product did not start', endedAt: new Date() },
    })
    await prisma.goalDelivery.update({ where: { id: deliveryId }, data: { status: 'verifying', round: 1, activeSmokeId: attempt.id } })

    await applySmokeOutcome(attempt.id)

    const delivery = await leadDelivery(f)
    expect([delivery.status, delivery.stopReason, delivery.leadState]).toEqual(['needs_human', 'lead_failed', 'awaiting_decision'])
    expect(delivery.needsHumanReason).toContain("the lead's task cannot be sent back")
    expect(delivery.needsHumanReason).toContain('failing: SMOKE')
    expect((await leadTaskOf(f)).status).not.toBe('rework')
  })

  it('re-caps a resumed lead-flow verification run at what the goal has left, its own spend so far included (task 9 review)', async (): Promise<void> => {
    const f = await seedLead({ budgetUsd: 30, leadArgs: () => cost(10) })
    await tickUntil(f, merged(f))
    const delivery = await leadDelivery(f)
    const verifier = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: f.workspaceId }, role: 'Verifier' } })
    // A paused verification run: no cost on its row yet, $4 by the pump's count on its checkpoint.
    const run = await prisma.slaveRun.create({ data: { slaveId: verifier.id, kind: 'verification', status: 'paused', goalDeliveryId: delivery.id, provider: 'claude_code' } })
    const runDir = mkdtempSync(join(tmpdir(), 'lead-proof-resume-'))
    await prisma.checkpoint.create({
      data: { runId: run.id, sessionId: 's', worktreePath: f.repoPath, pauseFlagPath: join(runDir, 'pause.flag'), headCommit: 'h', settingsPath: 's', hookPath: 'h', gitAuthorName: 'n', gitAuthorEmail: 'e', cumulativeCostUsd: 4 },
    })
    writeSpawnExtras(runDir, { maxBudgetUsd: 19.98 })

    await refreshLeadProofSpawn(run.id, runDir)
    const spent = (await goalSpend(f.workspaceId, 1)).totalUsd
    expect(readSpawnExtras(runDir)).toEqual({ maxBudgetUsd: cents(30 - spent - 4) })

    // Nothing left: the smallest leg, so it ends on its cap at once.
    await prisma.checkpoint.update({ where: { runId: run.id }, data: { cumulativeCostUsd: 100 } })
    await refreshLeadProofSpawn(run.id, runDir)
    expect(readSpawnExtras(runDir)).toEqual({ maxBudgetUsd: LEAD_MIN_LEG_USD })

    // Not in the lead flow: left as it was.
    writeSpawnExtras(runDir, { maxBudgetUsd: 19.98 })
    await prisma.workspace.update({ where: { id: f.workspaceId }, data: { flow: 'packages' } })
    await refreshLeadProofSpawn(run.id, runDir)
    expect(readSpawnExtras(runDir)).toEqual({ maxBudgetUsd: 19.98 })
  })
})
