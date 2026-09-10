import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  TIMELINE_LIMIT_DEFAULT,
  TIMELINE_LIMIT_MAX,
  buildSupervisorTimeline,
} from '../../src/server/timeline.js'
import {
  seedPendingDecision,
  seedTask,
  seedUnanswerableQuestion,
  seedWorkspace,
  truncateAll,
} from './projectFixture.js'

/**
 * The project's story in six lanes (M45 R2): the organisational events, plus the three kinds of
 * row that are still waiting on a person (a pending decision, an unanswerable question, a blocked
 * task). Model chatter -- `run.tool_call`, `run.output` -- never appears; the Activity page keeps
 * every event and is one link away.
 */
describe('buildSupervisorTimeline', () => {
  beforeEach(async (): Promise<void> => {
    await truncateAll()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('classifies the seeded story into its lanes, newest first', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({})
    const task = await seedTask(workspaceId, { title: 'Add Apple Pay', status: 'running' })
    await appendEvent({
      type: 'workspace.goal_set',
      workspaceId,
      actor: 'human',
      payload: { goal: 'Ship it', version: 2, sha256: 'a', request: 'Add Apple Pay' },
    })
    await appendEvent({
      type: 'workspace.replan_started',
      workspaceId,
      actor: 'slave',
      payload: { version: 2, runId: 'r-1' },
    })
    await appendEvent({
      type: 'workspace.replanned',
      workspaceId,
      actor: 'slave',
      payload: { version: 2, runId: 'r-1', added: [task.id], proposedCancellations: [], droppedCancellations: [] },
    })
    await appendEvent({
      type: 'task.created',
      workspaceId,
      taskId: task.id,
      actor: 'slave',
      payload: { title: 'Add Apple Pay', goalVersion: 2 },
    })
    await appendEvent({
      type: 'task.started',
      workspaceId,
      taskId: task.id,
      actor: 'slave',
      payload: { title: 'Add Apple Pay' },
    })
    await appendEvent({
      type: 'task.verify_passed',
      workspaceId,
      taskId: task.id,
      actor: 'slave',
      payload: { branch: 'feature/apple-pay' },
    })
    // Model chatter, which must not appear.
    await appendEvent({
      type: 'run.tool_call',
      workspaceId,
      taskId: task.id,
      actor: 'slave',
      payload: { name: 'Read', summary: 'src/pay.ts' },
    })

    const entries = await buildSupervisorTimeline(workspaceId)

    expect(entries.map((entry) => entry.lane)).not.toContain(null)
    expect(entries.some((entry) => entry.eventType === 'run.tool_call')).toBe(false)
    expect(entries.some((entry) => entry.eventType === 'run.output')).toBe(false)
    // Newest first, pairwise -- comparing only the ends would pass on a list that is out of order
    // in the middle (fix round 1, review minor 7).
    for (let index = 1; index < entries.length; index += 1) {
      expect(Date.parse(entries[index - 1]!.at)).toBeGreaterThanOrEqual(Date.parse(entries[index]!.at))
    }

    const byType = Object.fromEntries(
      entries.filter((entry) => entry.eventType !== null).map((entry) => [entry.eventType, entry]),
    )
    expect(byType['workspace.goal_set']?.lane).toBe('user_request')
    // R3: when a person asked for a change, the request IS the entry.
    expect(byType['workspace.goal_set']?.title).toBe('Add Apple Pay')
    expect(byType['workspace.replan_started']?.lane).toBe('interpretation')
    expect(byType['workspace.replan_started']?.title).toBe('reading the change to v2')
    expect(byType['workspace.replanned']?.lane).toBe('interpretation')
    // The delta IS the interpretation, with the ids resolved to titles by this read model (E21).
    expect(byType['workspace.replanned']?.title).toBe('understood v2: +Add Apple Pay; 1 kept')
    expect(byType['task.created']?.lane).toBe('plan_change')
    expect(byType['task.started']?.lane).toBe('work')
    expect(byType['task.started']?.taskTitle).toBe('Add Apple Pay')
    expect(byType['task.verify_passed']?.lane).toBe('verified')
    // The raw type stays on the entry (`docs/ia.md` rule 3), and every entry names its lane.
    expect(byType['task.verify_passed']?.laneLabel).toBe('VERIFIED RESULT')
  })

  it('puts a task a HUMAN created on the USER REQUEST lane, not the plan', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({})
    const task = await seedTask(workspaceId, { title: 'Add the banner', status: 'backlog' })
    await appendEvent({
      type: 'task.created',
      workspaceId,
      taskId: task.id,
      actor: 'human',
      payload: { title: 'Add the banner' },
    })

    const entries = await buildSupervisorTimeline(workspaceId)

    expect(entries[0]?.lane).toBe('user_request')
  })

  it('shows a goal set with no request as the goal it set', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({})
    await appendEvent({
      type: 'workspace.goal_set',
      workspaceId,
      actor: 'human',
      payload: { goal: 'Ship the checkout flow', version: 1, sha256: 'a' },
    })

    const entries = await buildSupervisorTimeline(workspaceId)

    expect(entries[0]?.lane).toBe('user_request')
    expect(entries[0]?.title).toBe('set the goal to v1')
    expect(entries[0]?.detail).toBe('Ship the checkout flow')
  })

  /** M45 final wave, I3: a request's entry used to carry the WHOLE composed goal document as its
   *  second line -- every earlier request, every heading, in a river of one-line entries. The
   *  request is already the title; the version is the one fact the title does not carry. */
  it('does not put the whole goal document under a request entry', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({})
    const goal = 'Ship the checkout flow.\n\n## Requested changes\n\n- 2026-09-09: Add Apple Pay\n'
    await appendEvent({
      type: 'workspace.goal_set',
      workspaceId,
      actor: 'human',
      payload: { goal, version: 2, sha256: 'b', request: 'Add Apple Pay' },
    })

    const entries = await buildSupervisorTimeline(workspaceId)

    expect(entries[0]?.title).toBe('Add Apple Pay')
    expect(entries[0]?.detail).toBe('v2')
    expect(entries[0]?.detail).not.toContain('Requested changes')
    expect(entries[0]?.detail).not.toContain('Ship the checkout flow')
  })

  it('puts every pending decision in the DECISION REQUIRED lane with its row attached', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({})
    const decision = await seedPendingDecision(workspaceId, { subjectId: 'reviewer' })

    const entries = await buildSupervisorTimeline(workspaceId)

    const row = entries.find((entry) => entry.decision !== null)
    expect(row?.lane).toBe('decision')
    expect(row?.laneLabel).toBe('DECISION REQUIRED')
    expect(row?.decision?.id).toBe(decision.id)
    expect(row?.key).toBe(`decision-${decision.id}`)
    // Still waiting on a person, so it is not rendered as a decision already taken.
    expect(row?.resolved).toBe(false)
  })

  it('keeps a decision a person already took on the same lane, marked resolved', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({})
    await appendEvent({
      type: 'supervisor.resolved',
      workspaceId,
      actor: 'human',
      payload: { decisionId: 'd-1', outcome: 'approved', reason: null },
    })

    const entries = await buildSupervisorTimeline(workspaceId)

    // Erratum E27: a decision a person took leaves its trace where it was asked.
    expect(entries[0]?.lane).toBe('decision')
    expect(entries[0]?.resolved).toBe(true)
    expect(entries[0]?.decision).toBeNull()
  })

  it('puts an unanswerable question and a blocked task on the DECISION REQUIRED lane too', async (): Promise<void> => {
    const fixture = await seedWorkspace({})
    const blocked = await seedTask(fixture.workspaceId, {
      title: 'Wire the webhook',
      status: 'blocked',
      lastRejectionReason: 'no credentials',
    })
    const question = await seedUnanswerableQuestion(fixture, { body: 'Which gateway?' })

    const entries = await buildSupervisorTimeline(fixture.workspaceId)

    const questionEntry = entries.find((entry) => entry.messageId === question.messageId)
    expect(questionEntry?.lane).toBe('decision')
    expect(questionEntry?.key).toBe(`question-${question.messageId}`)
    expect(questionEntry?.title).toContain('Which gateway?')
    expect(questionEntry?.resolved).toBe(false)

    const blockedEntry = entries.find((entry) => entry.key === `blocked-${blocked.id}`)
    expect(blockedEntry?.lane).toBe('decision')
    expect(blockedEntry?.taskId).toBe(blocked.id)
    expect(blockedEntry?.title).toContain('Wire the webhook')
  })

  it('collapses a task chatty with messages to its latest, and counts the rest', async (): Promise<void> => {
    const fixture = await seedWorkspace({})
    const task = await seedTask(fixture.workspaceId, { title: 'Add Apple Pay', status: 'running' })
    for (const body of ['first', 'second', 'third']) {
      await appendEvent({
        type: 'slave.message_sent',
        workspaceId: fixture.workspaceId,
        taskId: task.id,
        slaveId: fixture.slaveId,
        actor: 'slave',
        payload: { body, kind: 'information' },
      })
    }

    const entries = await buildSupervisorTimeline(fixture.workspaceId)

    const messages = entries.filter((entry) => entry.eventType === 'slave.message_sent')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.detail).toContain('third')
    expect(messages[0]?.collapsedCount).toBe(2)
  })

  it('caps the page it reads, at the default and at the ceiling', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({})
    // More rows than either cap, so both assertions below are about a real truncation. Inserted
    // in bulk rather than through `appendEvent`, which serialises every append process-wide: this
    // builder reads the stored rows and validates no payload, so the rows are all it needs.
    await prisma.executionEvent.createMany({
      data: Array.from({ length: TIMELINE_LIMIT_MAX + 10 }, () => ({
        workspaceId,
        type: 'task_started' as const,
        actor: 'slave' as const,
        payload: { title: 'Add Apple Pay' },
      })),
    })

    expect(await prisma.executionEvent.count({ where: { workspaceId } })).toBe(TIMELINE_LIMIT_MAX + 10)
    expect(await buildSupervisorTimeline(workspaceId)).toHaveLength(TIMELINE_LIMIT_DEFAULT)
    expect(await buildSupervisorTimeline(workspaceId, { limit: 1_000 })).toHaveLength(TIMELINE_LIMIT_MAX)
  })

  it('answers an empty list for a project that does not exist', async (): Promise<void> => {
    expect(await buildSupervisorTimeline('00000000-0000-0000-0000-000000000000')).toEqual([])
  })
})
