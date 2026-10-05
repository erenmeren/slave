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

  it('does not send a version accepted as it is round again when its work branch moves after a moved base: the hand merge stands (final review)', async (): Promise<void> => {
    const { f, cardId } = await stoppedWithACard()
    // The base moves, so the accepted version waits for a hand merge.
    writeFileSync(join(f.repoPath, 'elsewhere.txt'), 'not the lead\'s\n')
    git(['add', '-A'], f.repoPath)
    git(['commit', '-q', '-m', 'somebody else moved main'], f.repoPath)
    expect((await approveDecision(cardId)).ok).toBe(true)
    const accepted = await leadDelivery(f)
    // Then somebody puts a commit on the work branch (resolving the base by hand there, say).
    const tree = git(['rev-parse', `${accepted.integrationBranch}^{tree}`], f.repoPath)
    const byHand = git(['commit-tree', tree, '-p', accepted.integrationBranch, '-m', 'by hand'], f.repoPath)
    git(['update-ref', `refs/heads/${accepted.integrationBranch}`, byHand], f.repoPath)
    for (let i = 0; i < 4; i += 1) {
      await tick(f.deps)
      await drainPumps()
    }

    const delivery = await leadDelivery(f)
    expect([delivery.status, delivery.stopReason, delivery.verifiedCommit, delivery.mergedAt]).toEqual(['accepted', 'accepted_as_is', accepted.verifiedCommit, null])
    const trips = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'guardrail_tripped' }, select: { payload: true } })
    expect(trips.some((row) => (row.payload as { detail: string }).detail.includes('was accepted as it is'))).toBe(true)
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'workspace_goal_retried' } })).toBe(0)
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

  it('leaves a moved base to the hand merge when the lead\'s worktree is gone, and says why once (task 10 review)', async (): Promise<void> => {
    let repo = ''
    const move = moveBaseOnce(() => repo, 'elsewhere.txt', 'not the lead\'s\n')
    let removed = false
    const f = await seedLead({
      onStart: async (start) => {
        if (!removed && start.kind === 'verification') {
          removed = true
          const turn = await prisma.slaveRun.findFirstOrThrow({ where: { leadTurn: { not: null }, worktreePath: { not: null } } })
          git(['worktree', 'remove', '--force', turn.worktreePath ?? ''], repo)
        }
        await move(start)
      },
    })
    repo = f.repoPath
    const waitsForAHandMerge = async (): Promise<boolean> =>
      (await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'guardrail_tripped' }, select: { payload: true } })).some((row) =>
        (row.payload as { detail: string }).detail.includes('has moved since the goal was cut'),
      )
    await tickUntil(f, waitsForAHandMerge)
    await tick(f.deps)
    await drainPumps()

    const delivery = await leadDelivery(f)
    expect(delivery.mergedAt).toBeNull()
    expect(readLeadProgress(delivery.leadProgress).baseMerges).toBe(0)
    expect(leadTurns(f)).toHaveLength(1)
    expect((await leadNotes(f)).filter((line) => line.startsWith('base_taken:') && line.includes('worktree'))).toHaveLength(1)
  })
})
