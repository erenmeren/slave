import { prisma } from '@slave-of-ai/db/client'
import { RUN_UNMEASURED_CAP_USD, SUPERVISOR_PER_CALL_CAP_USD } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildProjectBrief } from '../../src/server/brief.js'
import { seedPendingDecision, seedTask, seedWorkspace, truncateAll } from './projectFixture.js'

/**
 * The eight facts a person needs to understand a project in about ten seconds (M45 R1): objective,
 * Supervisor state, current work, team, needs-you, latest verified result, cost, recent changes.
 */
describe('buildProjectBrief', () => {
  beforeEach(async (): Promise<void> => {
    await truncateAll()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('answers the eight questions off one project', async (): Promise<void> => {
    const fixture = await seedWorkspace({
      autoMerge: false,
      goal: 'Ship the checkout flow',
      budgetUsd: 25,
    })
    const { workspaceId, slaveId } = fixture
    const task = await seedTask(workspaceId, { title: 'Add Apple Pay', status: 'running' })
    // A worker is on a task because it holds a live RUN on it -- the same fact the Overview's own
    // slave cards read. `Task.assigneeId` is written by nothing in the pipeline.
    await prisma.slaveRun.create({ data: { slaveId, taskId: task.id, status: 'working' } })
    await appendEvent({ type: 'task.integrated', workspaceId, taskId: task.id, actor: 'system', payload: {} })
    await appendEvent({
      type: 'workspace.settings_changed',
      workspaceId,
      actor: 'human',
      payload: { field: 'budgetUsd', from: 10, to: 25 },
    })

    const brief = await buildProjectBrief(workspaceId)
    expect(brief).not.toBeNull()
    if (brief === null) return

    expect(brief.objective.text).toBe('Ship the checkout flow')
    expect(brief.objective.version).toBeGreaterThanOrEqual(0)
    expect(brief.supervisor.label).toMatch(/^(WORKING|WATCHING|IDLE|ANSWERING|OFF|HALTED, NEEDS YOU|\d+ DECISIONS? WAITING)$/u)
    expect(brief.work.working).toBe(1)
    expect(brief.team.map((member) => member.slaveId)).toContain(slaveId)
    expect(brief.team[0]?.taskTitle).toBe('Add Apple Pay')
    // The projected WORD, never the raw run status (`docs/ia.md` rule 3).
    expect(brief.team[0]?.status).toBe('WORKING')
    expect(brief.latestVerified).toEqual({ taskTitle: 'Add Apple Pay', kind: 'integrated', at: expect.any(String) })
    expect(brief.cost.budgetUsd).toBe(25)
    expect(brief.cost.spentUsd).toBeGreaterThanOrEqual(brief.cost.measuredUsd)
    expect(brief.cost.unmeasuredRuns).toBe(0)
    expect(brief.recentChanges.length).toBeGreaterThan(0)
    expect(brief.recentChanges.length).toBeLessThanOrEqual(6)
    // The family said out loud, never the dotted type.
    expect(brief.recentChanges[0]?.summary).not.toContain('workspace.settings_changed')
    expect(brief.recentChanges[0]?.summary).toBe('Project · settings changed')
  })

  it('carries the same needs-you queue the tile counts', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({ autoMerge: false })
    const blocked = await seedTask(workspaceId, { title: 'Wire the webhook', status: 'blocked' })

    const brief = await buildProjectBrief(workspaceId)

    expect(brief?.needsYou.map((item) => item.taskId)).toEqual([blocked.id])
    expect(brief?.supervisor.needsYou).toBe(false)
  })

  it('says a decision is waiting, in the Supervisor word', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({})
    await prisma.supervisorDecision.create({
      data: {
        workspaceId,
        situationKind: 'no_reviewer',
        subjectId: 'reviewer',
        situation: { kind: 'no_reviewer', subjectId: 'reviewer', summary: 'nobody holds reviewer', facts: {} },
        candidates: [],
        chosenIndex: 0,
        action: { kind: 'escalate_to_human', summary: 'nobody holds reviewer' },
        rationale: 'no holder',
        tier: 'proposed',
        status: 'pending',
        decidedBy: 'rules',
        modelCalled: false,
      },
    })

    const brief = await buildProjectBrief(workspaceId)

    expect(brief?.supervisor.state).toBe('decisions')
    expect(brief?.supervisor.label).toBe('1 DECISION WAITING')
    expect(brief?.supervisor.needsYou).toBe(true)
  })

  it('prefers an integration over an approval over a verify pass', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({})
    const task = await seedTask(workspaceId, { title: 'Add the banner', status: 'done' })
    await appendEvent({ type: 'task.verify_passed', workspaceId, taskId: task.id, actor: 'slave', payload: { branch: 'b' } })
    expect((await buildProjectBrief(workspaceId))?.latestVerified?.kind).toBe('verified')
    await appendEvent({ type: 'task.review_approved', workspaceId, taskId: task.id, actor: 'slave', payload: { reason: 'ok' } })
    expect((await buildProjectBrief(workspaceId))?.latestVerified?.kind).toBe('approved')
    await appendEvent({ type: 'task.integrated', workspaceId, taskId: task.id, actor: 'system', payload: {} })
    expect((await buildProjectBrief(workspaceId))?.latestVerified?.kind).toBe('integrated')

    // ... and the preference holds when NEWER events of the less-preferred kinds land on top of
    // it: the one read behind this is a `DISTINCT ON (type)` page, not "the newest three rows".
    await appendEvent({ type: 'task.verify_passed', workspaceId, taskId: task.id, actor: 'slave', payload: { branch: 'c' } })
    await appendEvent({ type: 'task.review_approved', workspaceId, taskId: task.id, actor: 'slave', payload: { reason: 'again' } })
    await appendEvent({ type: 'task.verify_passed', workspaceId, taskId: task.id, actor: 'slave', payload: { branch: 'd' } })
    expect((await buildProjectBrief(workspaceId))?.latestVerified?.kind).toBe('integrated')
  })

  it('says nothing is verified yet rather than inventing a result', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({})

    expect((await buildProjectBrief(workspaceId))?.latestVerified).toBeNull()
  })

  /**
   * The two holes are DIFFERENT facts and are never added together (fix round 1, review
   * Important 1): a Supervisor call whose cost never came back is charged at the cap and IS inside
   * `spentUsd`; a run that spawned, finished and left no figure behind is in no total at all.
   */
  it('counts an unmeasured RUN apart from an unmeasured CALL, and only the call is in the total', async (): Promise<void> => {
    const { workspaceId, slaveId } = await seedWorkspace({ budgetUsd: 25 })
    await prisma.slaveRun.create({
      data: { slaveId, status: 'succeeded', costUsd: 2, provider: 'claude_code', terminalAt: new Date(), endedAt: new Date() },
    })
    // A run that spawned, finished, and left no figure behind: real money nobody can name.
    await prisma.slaveRun.create({
      data: { slaveId, status: 'failed', costUsd: null, provider: 'claude_code', terminalAt: new Date(), endedAt: new Date() },
    })

    const runsOnly = await buildProjectBrief(workspaceId)

    expect(runsOnly?.cost.spentUsd).toBe(2)
    expect(runsOnly?.cost.measuredUsd).toBe(2)
    expect(runsOnly?.cost.unmeasuredRuns).toBe(1)
    // The unmeasured RUN did not move the total, and did not become a "call".
    expect(runsOnly?.cost.unmeasuredCalls).toBe(0)

    // A Supervisor call that was MADE and reported nothing: charged at the cap, inside the total.
    await seedPendingDecision(workspaceId, { subjectId: 'reviewer' })
    await prisma.supervisorDecision.updateMany({
      where: { workspaceId },
      data: { modelCalled: true, modelCostUsd: null },
    })

    const withCall = await buildProjectBrief(workspaceId)
    expect(withCall).not.toBeNull()
    if (withCall === null) return

    expect(withCall.cost.unmeasuredCalls).toBe(1)
    expect(withCall.cost.unmeasuredRuns).toBe(1)
    expect(withCall.cost.measuredUsd).toBe(2)
    // Charged at `SUPERVISOR_PER_CALL_CAP_USD`, so the total moved by the cap and by nothing else.
    expect(withCall.cost.spentUsd - 2).toBeCloseTo(SUPERVISOR_PER_CALL_CAP_USD, 10)

    // M51 R5, through the real read model (fix round 1, review Important 2). `actual` is the same
    // sum `measured` is; the bound charges the one unmeasured RUN at its cap and nothing else.
    expect(withCall.cost.actualUsd).toBe(withCall.cost.measuredUsd)
    expect(withCall.cost.upperBoundUsd - withCall.cost.spentUsd).toBeCloseTo(RUN_UNMEASURED_CAP_USD, 10)
    // Nothing is priceable yet, so the estimate is the total with no hole filled in.
    expect(withCall.cost.estimatedUsd).toBeCloseTo(withCall.cost.spentUsd, 10)
    expect(withCall.cost.upperBoundUsd).toBeGreaterThanOrEqual(withCall.cost.estimatedUsd)
  })

  /**
   * M51 R5's ESTIMATE, over the three columns the widened select reads (plan erratum E14), and the
   * three rules that make it honest: a reported figure is never replaced by its estimate, a run
   * nobody can price contributes nothing rather than a zero somebody would believe, and neither
   * `spentUsd` nor `actualUsd` moves by a cent.
   */
  it('prices the runs that reported nothing, and leaves the guardrail’s number where it was', async (): Promise<void> => {
    const { workspaceId, slaveId } = await seedWorkspace({ budgetUsd: 25 })
    // REPORTED, and carrying tokens that would price at $10.00 if the estimate ever spoke over it.
    await prisma.slaveRun.create({
      data: {
        slaveId, status: 'succeeded', costUsd: 2, provider: 'claude_code', model: 'claude-opus-5',
        tokensIn: 2_000_000, tokensOut: 0, terminalAt: new Date(), endedAt: new Date(),
      },
    })
    // ESTIMATED: nothing reported, a priced model, one megatoken of input = $5.00.
    await prisma.slaveRun.create({
      data: {
        slaveId, status: 'succeeded', costUsd: null, provider: 'claude_code', model: 'claude-opus-5',
        tokensIn: 1_000_000, tokensOut: 0, terminalAt: new Date(), endedAt: new Date(),
      },
    })
    // UNMEASURED: spawned, concluded, no figure and nothing to price it with.
    await prisma.slaveRun.create({
      data: { slaveId, status: 'failed', costUsd: null, provider: 'claude_code', terminalAt: new Date(), endedAt: new Date() },
    })
    // LIVE, and already expensive: two megatokens = $10.00. It is in the ESTIMATE (a run in flight
    // has an honest estimate) and in NO version of `unknownRuns`, which counts concluded runs only
    // -- so before the final wave's I3 it was a figure the "upper bound" beside it did not cover.
    await prisma.slaveRun.create({
      data: {
        slaveId, status: 'working', costUsd: null, provider: 'claude_code', model: 'claude-opus-5',
        tokensIn: 2_000_000, tokensOut: 0,
      },
    })

    const brief = await buildProjectBrief(workspaceId)
    expect(brief).not.toBeNull()
    if (brief === null) return

    // The guardrail's number and the reported sum: the two measured runs' $2.00, untouched.
    expect(brief.cost.spentUsd).toBe(2)
    expect(brief.cost.actualUsd).toBe(2)
    expect(brief.cost.measuredUsd).toBe(2)
    // $2.00 reported + $5.00 priced + $0 for the run nobody can price + $10.00 for the live one. The
    // reported run contributes its REPORTED figure, not the $10.00 its own tokens would estimate.
    expect(brief.cost.estimatedUsd).toBeCloseTo(17, 10)
    // TWO concluded runs nobody measured (final wave, M6): `sumSpend` counts a null `costUsd` on a
    // spawned, concluded run, and being priceable is not being measured -- so the estimable run is
    // one of them too. The live run is not: a run in flight is unfinished, not unmeasured.
    expect(brief.cost.unmeasuredRuns).toBe(2)
    // The bound, over the SAME rows the estimate sums (final wave, I3/E20): per row with no
    // reported cost, whichever is larger of the concluded-unmeasured cap and the row's own
    // estimate. $2.00 reported + max($1, $5) + max($1, $0) + max($0, $10).
    expect(brief.cost.upperBoundUsd).toBeCloseTo(2 + 5 + RUN_UNMEASURED_CAP_USD + 10, 10)
    // The invariant the whole fix exists for: no figure on this tile may exceed the bound beside it.
    expect(brief.cost.upperBoundUsd).toBeGreaterThanOrEqual(brief.cost.estimatedUsd)
  })

  it('answers null for a project that does not exist', async (): Promise<void> => {
    expect(await buildProjectBrief('00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})
