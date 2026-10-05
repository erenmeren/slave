import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { approveDecision, rejectDecision, setGoal } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { LEAD_BASE_MERGES_MAX, readLeadProgress } from '@slave-of-ai/domain'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTickObservation } from '../../src/sweep.js'
import { drainPumps, tick } from '../../src/tick.js'
import { LEAD_TRUNCATE, checked, cleanUpLeadRepos, git, leadDelivery, leadNotes, leadTaskOf, merged, seedLead, tickUntil, type LeadFixture, type LeadStart } from './lead-helpers.js'

const ALL = ['R1', 'R2', 'RUN']
const leadTurns = (f: LeadFixture) => f.starts.filter((s) => s.kind === 'implementation')
const proofRuns = (f: LeadFixture) => f.starts.filter((s) => s.kind === 'verification')

/** A version stopped `not_all_proven`: the first round fails R1 and the confirmer passes it. */
async function stoppedWithACard(): Promise<{ readonly f: LeadFixture; readonly cardId: string }> {
  const f = await seedLead({
    verify: (ordinal, run) => (ordinal === 1 ? ALL.map((key) => checked(key, key === 'R1' ? 'fail' : 'pass')) : (run.keys.length === 0 ? ALL : run.keys).map((key) => checked(key, 'pass'))),
  })
  await tickUntil(f, async () => (await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, status: 'pending', situationKind: 'goal_needs_human' } })) === 1)
  const card = await prisma.supervisorDecision.findFirstOrThrow({ where: { workspaceId: f.workspaceId, status: 'pending' } })
  return { f, cardId: card.id }
}

/** Commits `file` on main in the primary checkout, once, when the first verification starts. */
function moveBaseOnce(repoPath: () => string, file: string, content: string): (start: LeadStart) => Promise<void> {
  let done = false
  return async (start) => {
    if (done || start.kind !== 'verification') return
    done = true
    writeFileSync(join(repoPath(), file), content)
    git(['add', '-A'], repoPath())
    git(['commit', '-q', '-m', 'somebody else moved main'], repoPath())
  }
}

describe('the lead flow: delivery', () => {
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

  it('raises one card that says what is unproven and what each button does', async (): Promise<void> => {
    const { f, cardId } = await stoppedWithACard()
    const card = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: cardId } })
    const summary = (card.situation as { summary: string }).summary
    expect(summary).toContain('Goal v1 needs a person: it stopped because')
    expect(summary).toContain('disputed (the two verifiers disagreed): R1')
    expect(summary).toContain('Approve accepts the version as it is and merges it. Reject leaves it')
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(f.initialTip)
  })

  it('Approve accepts the version as it is and it is merged', async (): Promise<void> => {
    const { f, cardId } = await stoppedWithACard()
    expect((await approveDecision(cardId)).ok).toBe(true)
    await tickUntil(f, merged(f))
    const delivery = await leadDelivery(f)
    expect([delivery.status, delivery.stopReason, delivery.leadState]).toEqual(['accepted', 'accepted_as_is', 'delivered'])
    expect(git(['ls-tree', '-r', '--name-only', 'main'], f.repoPath).split('\n')).toContain('lead-work-1.txt')
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, status: 'pending' } })).toBe(0)
  })

  it('Reject leaves the version: the branch stays, nothing is merged, and the next goal version starts', async (): Promise<void> => {
    const { f, cardId } = await stoppedWithACard()
    expect((await rejectDecision(cardId, undefined, 'not good enough')).ok).toBe(true)
    await tick(f.deps)
    await drainPumps()
    const delivery = await leadDelivery(f)
    expect([delivery.status, delivery.stopReason, delivery.leadState]).toEqual(['abandoned', 'left', 'stopped'])
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(f.initialTip)
    expect(git(['rev-parse', '--verify', `refs/heads/${delivery.integrationBranch}`], f.repoPath)).not.toBe('')
    expect((await setGoal(f.workspaceId, 'Add a health route. Add a version route. Add a status route.')).ok).toBe(true)
    await tickUntil(f, async () => (await prisma.goalDelivery.count({ where: { workspaceId: f.workspaceId, goalVersion: 2 } })) === 1)
    expect((await leadDelivery(f, 2)).leadState).toBe('building')
  })

  it('takes a base branch that moved into the work branch, verifies the merged tree in full, and merges (spec D3, clean)', async (): Promise<void> => {
    let repo = ''
    const f = await seedLead({ onStart: moveBaseOnce(() => repo, 'elsewhere.txt', 'not the lead\'s\n') })
    repo = f.repoPath
    await tickUntil(f, merged(f))

    const files = git(['ls-tree', '-r', '--name-only', 'main'], f.repoPath).split('\n')
    expect(files).toEqual(expect.arrayContaining(['elsewhere.txt', 'lead-work-1.txt']))
    expect(leadTurns(f)).toHaveLength(1)
    expect(proofRuns(f).map((run) => run.verificationKeys)).toEqual([[], []])
    expect((await leadNotes(f)).some((line) => line.startsWith('base_taken: main moved; it was merged into the work branch cleanly'))).toBe(true)
    const delivery = await leadDelivery(f)
    expect(readLeadProgress(delivery.leadProgress).baseMerges).toBe(1)
    expect(git(['merge-base', '--is-ancestor', delivery.baseCommit, 'main'], f.repoPath)).toBe('')
    expect(delivery.baseCommit).not.toBe(f.initialTip)
  })

  it('gives the lead a turn when the moved base conflicts, and falls back to the hand merge when it never takes it in (spec D3, conflict)', async (): Promise<void> => {
    let repo = ''
    // The base gains the very file the lead's first turn wrote, with other content.
    const f = await seedLead({ onStart: moveBaseOnce(() => repo, 'lead-work-1.txt', 'somebody else\'s content\n') })
    repo = f.repoPath
    // The fake never merges the base, so after the bound the existing wait is what is left: a person merges by hand.
    const waitsForAHandMerge = async (): Promise<boolean> =>
      (await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'guardrail_tripped' }, select: { payload: true } })).some((row) =>
        (row.payload as { detail: string }).detail.includes('has moved since the goal was cut'),
      )
    await tickUntil(f, waitsForAHandMerge, 200)

    const baseTurns = leadTurns(f).filter((turn) => turn.leadTurn === 'base')
    expect(baseTurns).toHaveLength(LEAD_BASE_MERGES_MAX)
    expect(baseTurns[0]?.prompt).toContain('git merge main')
    expect(baseTurns[0]?.resumeSessionId).toBe('fake-session-complete')
    expect(readLeadProgress((await leadDelivery(f)).leadProgress).baseMerges).toBe(LEAD_BASE_MERGES_MAX)
    expect((await leadDelivery(f)).mergedAt).toBeNull()
    expect((await leadTaskOf(f)).status).toBe('done')
    expect(leadTurns(f)).toHaveLength(1 + LEAD_BASE_MERGES_MAX)
  })
})
