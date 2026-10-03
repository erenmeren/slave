import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  TIMELINE_LIMIT_DEFAULT,
  TIMELINE_LIMIT_MAX,
  buildSupervisorTimeline,
  memoryStatusOf,
  retryCauseOf,
} from '../../src/server/timeline.js'
import { buildActivityHistory } from '../../src/server/activity.js'
import { EMPTY_ACTIVITY_FILTERS } from '../../src/lib/activityFilters.js'
import { handOffSender } from '../../src/lib/handOffSender.js'
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

  // M48 R7: the one entry that says how this project decided to WORK. The NAME, never the key --
  // this line is read on the PLAN CHANGE lane beside every re-plan.
  it('says which runbook was adopted, and which one was stopped', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({})
    await appendEvent({
      type: 'workspace.runbook_adopted',
      workspaceId,
      actor: 'human',
      payload: { runbookId: 'rb-1', key: 'feature-delivery', name: 'Feature delivery' },
    })
    await appendEvent({
      type: 'workspace.runbook_adopted',
      workspaceId,
      actor: 'human',
      payload: { runbookId: 'rb-1', key: 'feature-delivery', name: 'Feature delivery', cleared: true },
    })

    const entries = await buildSupervisorTimeline(workspaceId)

    expect(entries[0]?.lane).toBe('plan_change')
    expect(entries[0]?.title).toBe('stopped following Feature delivery')
    expect(entries[1]?.title).toBe('adopted Feature delivery as the way this project works')
    // Never the key, on either line.
    expect(entries.map((entry) => entry.title).join(' ')).not.toContain('feature-delivery')
  })

  // Final wave M5: the goal pass's retry of a version whose branch moved is not the person's.
  it('puts a person\'s retry-goal on USER REQUEST and a branch-moved retry on WORK IN PROGRESS', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({})
    await appendEvent({ type: 'workspace.goal_retried', workspaceId, actor: 'human', payload: { version: 1, round: 3 } })
    await appendEvent({ type: 'workspace.goal_retried', workspaceId, actor: 'system', payload: { version: 1, round: 4, cause: 'branch_moved' } })

    const entries = await buildSupervisorTimeline(workspaceId)

    expect(entries.map((entry) => [entry.lane, entry.title])).toEqual([
      ['work', 'goal v1 went back to verification'],
      ['user_request', 'retried goal v1'],
    ])
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

  // Human cards plan B D9: a worker's note is information on the WORK lane, its words the second line.
  it('shows a package note on WORK IN PROGRESS, its words as the detail and nothing waiting on a person', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({})
    const note = 'VENDOR_LICENSE_PUBLIC_KEYS is a placeholder; the vendor runs the keygen offline.'
    await appendEvent({ type: 'workspace.package_noted', workspaceId, runId: 'r1', actor: 'slave', payload: { version: 2, packageKey: 'identity-access', runId: 'r1', note } })

    const entries = await buildSupervisorTimeline(workspaceId)

    expect(entries.map((entry) => [entry.lane, entry.title, entry.detail, entry.eventType])).toEqual([
      ['work', 'goal v2: identity-access left a note', note, 'workspace.package_noted'],
    ])
  })

  // Pre-flight F65 / section (e) carry: a package-less hand-off is named as the goal report and the
  // workers' prompts name it (`handOffViews` + `handOffFromName`) -- never "the conductor" for all.
  it('names who a package-less hand-off came from: the operator, a worker by its seat, the conductor', async (): Promise<void> => {
    const { workspaceId, slaveId } = await seedWorkspace({})
    const lateAnswer = await prisma.slaveMessage.create({ data: { workspaceId, slaveId, threadId: 't', kind: 'answer', body: 'rename it', actor: 'slave' } })
    const rows: readonly (readonly [string, 'person' | 'answer' | 'report', string, string | null])[] = [
      ['h-person', 'person', 'person:card1:0', null],
      ['h-late', 'answer', `late:${lateAnswer.id}:0`, null],
      ['h-conductor', 'answer', 'answer:d1:0', null],
      ['h-report', 'report', 'report:r1:0', 'report'],
    ]
    for (const [id, source, sourceKey, fromPackageKey] of rows) {
      await prisma.packageHandOff.create({
        data: { id, workspaceId, goalVersion: 1, source, sourceKey, fromRunId: 'r1', fromPackageKey, toPackageKey: 'skeleton', path: 'scripts/verify.sh', change: 'x', fingerprint: id, status: 'pending' },
      })
    }
    const handedOff = (handOffId: string, source: string, fromPackage: string | null) =>
      appendEvent({
        type: 'workspace.package_handed_off',
        workspaceId,
        actor: source === 'person' ? 'human' : 'system',
        payload: { version: 1, handOffId, source, fromPackage, toPackage: 'skeleton', path: 'scripts/verify.sh', package: null, delivery: 'prompt', change: 'x' },
      })
    for (const [id, source, , fromPackageKey] of rows) await handedOff(id, source, fromPackageKey)
    // A row that is gone (its workspace's rows cleaned up by hand): the event's own source still names a person.
    await handedOff('h-gone-person', 'person', null)
    await handedOff('h-gone-answer', 'answer', null)

    const entries = await buildSupervisorTimeline(workspaceId)

    expect(entries.map((entry) => entry.title).reverse()).toEqual([
      'goal v1: the operator handed work to skeleton',
      'goal v1: Alex (dev) handed work to skeleton',
      'goal v1: the conductor handed work to skeleton',
      'goal v1: report handed work to skeleton',
      'goal v1: the operator handed work to skeleton',
      'goal v1: the conductor handed work to skeleton',
    ])

    // Plan B Task 8 carry: the activity page's rows carry the same server-side name, so the card
    // and the timeline name each sender alike -- a late answer by its seat, never "the conductor".
    const page = await buildActivityHistory(workspaceId, EMPTY_ACTIVITY_FILTERS, {})
    const handOffs = [...(page?.events ?? [])].reverse().filter((event) => event.type === 'workspace.package_handed_off')
    expect(handOffs.map((event) => handOffSender(event.payload, event.handOffFrom))).toEqual([
      'the operator',
      'Alex (dev)',
      'the conductor',
      'report',
      'the operator',
      'the conductor',
    ])
    // Named by the server only where the event alone cannot say it: the three package-less rows that exist.
    expect(handOffs.map((event) => event.handOffFrom ?? null)).toEqual(['the operator', 'Alex (dev)', 'the conductor', null, null, null])
  })
})

/**
 * M49 t1 fix round 1, item 3. `TimelineSubject.memoryStatus` exists for ONE event type (plan
 * erratum E5), and this builder used to stamp it from any payload carrying a string `status`. Pure,
 * so the narrowing is provable without a row: it is a reading of the payload, not of the database.
 */
describe('retryCauseOf', () => {
  it('reads the cause of a workspace.goal_retried and of nothing else', () => {
    expect(retryCauseOf('workspace.goal_retried', { version: 1, round: 2, cause: 'branch_moved' })).toBe('branch_moved')
    expect(retryCauseOf('workspace.goal_retried', { version: 1, round: 2 })).toBeNull()
    expect(retryCauseOf('workspace.goal_retried', { cause: 'nonsense' })).toBeNull()
    expect(retryCauseOf('workspace.goal_set', { cause: 'branch_moved' })).toBeNull()
  })
})

describe('memoryStatusOf', () => {
  it('reads the status of a memory.recorded and of nothing else', () => {
    expect(memoryStatusOf('memory.recorded', { status: 'verified' })).toBe('verified')
    expect(memoryStatusOf('memory.recorded', { status: 'candidate' })).toBe('candidate')
  })

  it('answers null for another type that happens to carry a status', () => {
    // A run event's subject carries no memory status, however its payload is shaped.
    expect(memoryStatusOf('run.output', { status: 'verified' })).toBeNull()
    expect(memoryStatusOf('task.done', { status: 'verified' })).toBeNull()
  })

  it('answers null for a memory.recorded whose status is not one', () => {
    expect(memoryStatusOf('memory.recorded', { status: 'nonsense' })).toBeNull()
    expect(memoryStatusOf('memory.recorded', {})).toBeNull()
    expect(memoryStatusOf('memory.recorded', { status: 3 })).toBeNull()
  })
})
