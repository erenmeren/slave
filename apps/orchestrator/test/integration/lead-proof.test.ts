import { prisma } from '@slave-of-ai/db/client'
import { readLeadProgress } from '@slave-of-ai/domain'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTickObservation } from '../../src/sweep.js'
import { drainPumps, tick } from '../../src/tick.js'
import { LEAD_TRUNCATE, base64, checked, cleanUpLeadRepos, leadDelivery, leadNotes, leadTaskOf, merged, seedLead, tickUntil, type LeadFixture, type LeadSeedOptions } from './lead-helpers.js'

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
})
