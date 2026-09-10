import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildProjectBrief } from '../../src/server/brief.js'
import { seedTask, seedWorkspace, truncateAll } from './projectFixture.js'

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
  })

  it('says nothing is verified yet rather than inventing a result', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({})

    expect((await buildProjectBrief(workspaceId))?.latestVerified).toBeNull()
  })

  it('shows the measured and unmeasured halves of one total, never a second total', async (): Promise<void> => {
    const { workspaceId, slaveId } = await seedWorkspace({ budgetUsd: 25 })
    await prisma.slaveRun.create({
      data: { slaveId, status: 'succeeded', costUsd: 2, provider: 'claude_code', terminalAt: new Date(), endedAt: new Date() },
    })
    // A run that spawned, finished, and left no figure behind: real money nobody can name.
    await prisma.slaveRun.create({
      data: { slaveId, status: 'failed', costUsd: null, provider: 'claude_code', terminalAt: new Date(), endedAt: new Date() },
    })

    const brief = await buildProjectBrief(workspaceId)

    expect(brief?.cost.spentUsd).toBe(2)
    expect(brief?.cost.measuredUsd).toBe(2)
    expect(brief?.cost.unmeasuredCalls).toBe(1)
  })

  it('answers null for a project that does not exist', async (): Promise<void> => {
    expect(await buildProjectBrief('00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})
