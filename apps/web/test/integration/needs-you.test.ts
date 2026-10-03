import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DRAFT_PREVIEW_MAX_CHARS, buildNeedsYou } from '../../src/server/needsYou.js'
import {
  seedPendingDecision,
  seedTask,
  seedUnanswerableQuestion,
  seedWorkspace,
  truncateAll,
} from './projectFixture.js'

/**
 * The queue of things waiting on a person (M45 R1, plan erratum E20): FOUR sources, joined once and
 * de-duplicated per task, so the tile's count and the DECISION REQUIRED lane's list can never
 * disagree about how much is waiting.
 */
describe('buildNeedsYou', () => {
  beforeEach(async (): Promise<void> => {
    await truncateAll()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('lists a blocked task, a pending decision, an unanswerable question and un-integrated work', async (): Promise<void> => {
    const fixture = await seedWorkspace({ autoMerge: false })
    const { workspaceId } = fixture
    const blocked = await seedTask(workspaceId, {
      title: 'Wire the webhook',
      status: 'blocked',
      lastRejectionReason: 'no credentials',
    })
    const finished = await seedTask(workspaceId, { title: 'Add the banner', status: 'done', integratedAt: null })
    const decision = await seedPendingDecision(workspaceId, { subjectId: 'reviewer' })
    const question = await seedUnanswerableQuestion(fixture, { body: 'Which gateway?' })

    const items = await buildNeedsYou(workspaceId)

    expect(items.map((item) => item.kind).sort()).toEqual(['blocked_task', 'decision', 'integrate', 'question'])
    const byKind = Object.fromEntries(items.map((item) => [item.kind, item]))
    expect(byKind['blocked_task']?.title).toContain('Wire the webhook')
    expect(byKind['blocked_task']?.title).toContain('no credentials')
    expect(byKind['blocked_task']?.href).toBe(`/w/${workspaceId}/tasks?task=${blocked.id}`)
    expect(byKind['blocked_task']?.taskId).toBe(blocked.id)
    expect(byKind['decision']?.decisionId).toBe(decision.id)
    // The LABEL, never the enum member (`docs/ia.md` rule 3).
    expect(byKind['decision']?.title).toContain('No reviewer')
    expect(byKind['decision']?.title).not.toContain('no_reviewer')
    expect(byKind['question']?.messageId).toBe(question.messageId)
    expect(byKind['question']?.title).toContain('Which gateway?')
    // Ruling F17 (plan B Task 7): the `#decision-` / `#question-` anchors live only in the activity
    // page's timeline, where a question card's decisions render -- so that is where the links go.
    expect(byKind['decision']?.href).toBe(`/w/${workspaceId}/activity#decision-${decision.id}`)
    expect(byKind['question']?.href).toBe(`/w/${workspaceId}/activity#question-${question.messageId}`)
    // E11: there is no web integration verb, so the item LINKS to the task on the board.
    expect(byKind['integrate']?.taskId).toBe(finished.id)
    expect(byKind['integrate']?.href).toBe(`/w/${workspaceId}/tasks?task=${finished.id}`)
    for (const item of items) expect(Date.parse(item.since)).not.toBeNaN()
  })

  it('does not ask for an integration on a project that merges by itself', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({ autoMerge: true })
    await seedTask(workspaceId, { title: 'Add the banner', status: 'done', integratedAt: null })

    expect(await buildNeedsYou(workspaceId)).toEqual([])
  })

  it('counts a blocked task with a pending decision about it ONCE, as the decision', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({ autoMerge: false })
    const blocked = await seedTask(workspaceId, { title: 'Wire the webhook', status: 'blocked' })
    await seedPendingDecision(workspaceId, {
      subjectId: blocked.id,
      situationKind: 'task_blocked_human',
      summary: 'the webhook task has been blocked for two days',
    })

    const items = await buildNeedsYou(workspaceId)

    // ONE entry for one task. Two would double-count the same piece of work in the tile's number
    // and put two rows in front of a person for one thing to decide (plan erratum E20).
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('decision')
    expect(items[0]?.taskId).toBeNull()
    // Human cards H4: merged into the card's row, not dropped -- the row leads to the task too.
    expect(items[0]?.mergedIds).toEqual([blocked.id])
    expect(items[0]?.merged.map((item) => [item.kind, item.href])).toEqual([['blocked_task', `/w/${workspaceId}/tasks?task=${blocked.id}`]])
    expect(items[0]?.blocking).toBe(true)
  })

  it('is oldest first -- the thing that has waited longest is the thing to do', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({ autoMerge: false })
    const older = await seedTask(workspaceId, {
      title: 'Older',
      status: 'blocked',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    })
    await seedTask(workspaceId, {
      title: 'Newer',
      status: 'blocked',
      createdAt: new Date('2026-09-09T00:00:00.000Z'),
    })

    const items = await buildNeedsYou(workspaceId)

    expect(items[0]?.taskId).toBe(older.id)
  })

  it('answers an empty list for a project where nothing is waiting', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({ autoMerge: false })

    expect(await buildNeedsYou(workspaceId)).toEqual([])
  })

  it('answers an empty list for a project that does not exist', async (): Promise<void> => {
    expect(await buildNeedsYou('00000000-0000-0000-0000-000000000000')).toEqual([])
  })
})

/** A task stamped with a goal version, the column a question card's and a task card's version read. */
async function versionedTask(workspaceId: string, data: { readonly title: string; readonly status: string; readonly goalVersion: number; readonly createdAt?: Date }): Promise<string> {
  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: data.title,
      description: 'seeded by the H4 queue test',
      status: data.status as never,
      requiredRole: 'dev',
      maxAttempts: 3,
      goalVersion: data.goalVersion,
      ...(data.createdAt === undefined ? {} : { createdAt: data.createdAt }),
    },
  })
  return task.id
}

/** A pending card with its own kind, subject, action and draft, and its own `createdAt`. */
async function card(
  workspaceId: string,
  options: {
    readonly situationKind: string
    readonly subjectId: string
    readonly createdAt: Date
    readonly action?: Record<string, unknown>
    readonly draftBody?: string | null
    readonly facts?: Record<string, unknown>
  },
): Promise<string> {
  const action = options.action ?? { kind: 'escalate_to_human', summary: 'a person decides' }
  const row = await prisma.supervisorDecision.create({
    data: {
      workspaceId,
      situationKind: options.situationKind as never,
      subjectId: options.subjectId,
      situation: { kind: options.situationKind, subjectId: options.subjectId, summary: `about ${options.subjectId}`, facts: (options.facts ?? {}) as never },
      candidates: [],
      chosenIndex: 0,
      action: action as never,
      ...(options.draftBody === undefined
        ? {}
        : { draft: { body: options.draftBody, sources: [], rejectedSources: [], critical: { lexicon: [], model: false }, confidence: 'interpretation' } }),
      rationale: 'seeded',
      tier: 'proposed',
      status: 'pending',
      decidedBy: 'rules',
      modelCalled: false,
      createdAt: options.createdAt,
    },
  })
  return row.id
}

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 3, 8, minute))

/**
 * Human cards H4 (plan B D8, Task 9): one queue per goal version. Spec H4: "Cards are listed per
 * goal version. Within a version, those blocking it (a paused run, `needs_human`) come first. Cards
 * on one subject -- the same question, task, package or file -- merge into one card."
 */
describe('buildNeedsYou: one queue per goal version (human cards H4)', () => {
  beforeEach(async (): Promise<void> => {
    await truncateAll()
  })

  it('lists v2 first with its blocking card, then v1 with what blocks it, and a task\'s card and the blocked task as one row', async (): Promise<void> => {
    const fixture = await seedWorkspace({ autoMerge: false })
    const { workspaceId } = fixture
    // v1: an old card that blocks nothing (a verification round that failed), and a task that is
    // blocked with a task_failed card about it -- newer, but blocking.
    const oldCard = await card(workspaceId, { situationKind: 'verification_failed', subjectId: `${workspaceId}:v1:r1`, createdAt: at(0) })
    const blockedTask = await versionedTask(workspaceId, { title: 'Wire the webhook', status: 'blocked', goalVersion: 1, createdAt: at(1) })
    const failed = await card(workspaceId, { situationKind: 'task_failed', subjectId: blockedTask, createdAt: at(20), action: { kind: 'retry_task', taskId: blockedTask, title: 'Wire the webhook', reason: 'try again' } })
    // v2: a question its asker is parked on, with an escalation card -- the newest of all.
    const askingTask = await versionedTask(workspaceId, { title: 'Pick the gateway', status: 'waiting', goalVersion: 2 })
    const question = await seedUnanswerableQuestion(fixture, { taskId: askingTask, body: 'Which gateway?' })
    const escalation = await card(workspaceId, { situationKind: 'unanswerable_question', subjectId: question.messageId, createdAt: at(30) })

    const items = await buildNeedsYou(workspaceId)

    expect(items.map((item) => ({ id: item.id, kind: item.kind, goalVersion: item.goalVersion, blocking: item.blocking, oneClick: item.oneClick, mergedIds: item.mergedIds }))).toEqual([
      { id: escalation, kind: 'decision', goalVersion: 2, blocking: true, oneClick: false, mergedIds: [] },
      { id: failed, kind: 'decision', goalVersion: 1, blocking: true, oneClick: true, mergedIds: [blockedTask] },
      { id: oldCard, kind: 'decision', goalVersion: 1, blocking: false, oneClick: true, mergedIds: [] },
    ])
    // A question with an open card is listed once, as the card -- never beside it.
    expect(items.some((item) => item.kind === 'question')).toBe(false)
    expect(items.flatMap((item) => [item, ...item.merged]).some((item) => item.messageId === question.messageId)).toBe(false)
    // The card is a question card; the merged task is the task's own row, still reachable.
    expect(items[0]?.questionCard).toBe(true)
    expect(items[0]?.groupKey).toBe(`question:${question.messageId}`)
    expect(items[1]?.groupKey).toBe(`task:${blockedTask}`)
    expect(items[1]?.merged[0]?.href).toBe(`/w/${workspaceId}/tasks?task=${blockedTask}`)
    expect(items[1]?.merged[0]?.blocking).toBe(true)
  })

  it('heads a merged row with its card even when the task waited longer (pre-flight F27)', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({ autoMerge: false })
    const task = await versionedTask(workspaceId, { title: 'Wire the webhook', status: 'blocked', goalVersion: 3, createdAt: at(0) })
    const stale = await card(workspaceId, { situationKind: 'task_blocked_human', subjectId: task, createdAt: at(40) })

    const items = await buildNeedsYou(workspaceId)

    expect(items.map((item) => [item.kind, item.id, item.mergedIds])).toEqual([['decision', stale, [task]]])
  })

  it('lists a bare unanswerable question once, blocking when its asker is parked, under its version', async (): Promise<void> => {
    const fixture = await seedWorkspace({ autoMerge: false })
    const task = await versionedTask(fixture.workspaceId, { title: 'Pick the gateway', status: 'waiting', goalVersion: 4 })
    const question = await seedUnanswerableQuestion(fixture, { taskId: task })

    const items = await buildNeedsYou(fixture.workspaceId)

    expect(items.map((item) => [item.kind, item.id, item.goalVersion, item.blocking, item.oneClick, item.questionCard])).toEqual([
      ['question', question.messageId, 4, true, false, false],
    ])
  })

  it('bounds the draft a row previews, cut on a whole character (fix round 1)', async (): Promise<void> => {
    const fixture = await seedWorkspace({ autoMerge: false })
    const question = await seedUnanswerableQuestion(fixture, { body: 'long?' })
    const long = `${'é'.repeat(DRAFT_PREVIEW_MAX_CHARS)}tail`
    await card(fixture.workspaceId, { situationKind: 'conductor_question', subjectId: question.messageId, createdAt: at(1), action: { kind: 'answer_question', messageId: question.messageId }, draftBody: long })

    const [row] = await buildNeedsYou(fixture.workspaceId)

    expect([...(row?.draftPreview ?? '')]).toHaveLength(DRAFT_PREVIEW_MAX_CHARS)
    expect(row?.draftPreview?.endsWith('…')).toBe(true)
    expect(row?.draftPreview?.includes('tail')).toBe(false)
    // Fix round 2: a draft the row cannot show whole has no one click -- it is read on the card.
    expect(row?.draftPreviewCut).toBe(true)
    expect(row?.oneClick).toBe(false)
  })

  it('puts project-level items after every version', async (): Promise<void> => {
    const { workspaceId } = await seedWorkspace({ autoMerge: false })
    const project = await seedPendingDecision(workspaceId, { subjectId: 'reviewer' })
    const versioned = await card(workspaceId, { situationKind: 'verification_failed', subjectId: `${workspaceId}:v1:r2`, createdAt: new Date() })

    const items = await buildNeedsYou(workspaceId)

    expect(items.map((item) => [item.id, item.goalVersion])).toEqual([
      [versioned, 1],
      [project.id, null],
    ])
  })

  it('offers no one click on a question card that does not offer send_answer, and sends it where it does', async (): Promise<void> => {
    const fixture = await seedWorkspace({ autoMerge: false })
    const { workspaceId } = fixture
    const draftless = await seedUnanswerableQuestion(fixture, { body: 'first?' })
    const drafted = await seedUnanswerableQuestion(fixture, { body: 'second?' })
    const readdress = await seedUnanswerableQuestion(fixture, { body: 'third?' })
    const draftlessCard = await card(workspaceId, {
      situationKind: 'conductor_question',
      subjectId: draftless.messageId,
      createdAt: at(1),
      action: { kind: 'answer_question', messageId: draftless.messageId },
      draftBody: null,
    })
    const draftedCard = await card(workspaceId, {
      situationKind: 'conductor_question',
      subjectId: drafted.messageId,
      createdAt: at(2),
      action: { kind: 'answer_question', messageId: drafted.messageId },
      draftBody: 'Use Stripe.',
    })
    const readdressCard = await card(workspaceId, {
      situationKind: 'unanswerable_question',
      subjectId: readdress.messageId,
      createdAt: at(3),
      action: { kind: 'reassign_question', messageId: readdress.messageId, toSlaveId: fixture.slaveId },
    })

    const items = await buildNeedsYou(workspaceId)
    const byId = new Map(items.map((item) => [item.id, item]))

    expect([byId.get(draftlessCard)?.oneClick, byId.get(draftedCard)?.oneClick, byId.get(readdressCard)?.oneClick]).toEqual([false, true, false])
    // Fix round 1: the words the one click sends ride on its row; none where there is no one click.
    expect([byId.get(draftlessCard)?.draftPreview, byId.get(draftedCard)?.draftPreview, byId.get(readdressCard)?.draftPreview]).toEqual([null, 'Use Stripe.', null])
    expect(byId.get(draftedCard)?.draftPreviewCut).toBe(false)
    expect(items.every((item) => item.questionCard)).toBe(true)
    expect(items).toHaveLength(3)
  })
})
