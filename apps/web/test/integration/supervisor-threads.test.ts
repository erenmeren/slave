import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildSupervisorThreads } from '../../src/server/supervisorThreads.js'
import { truncateAll } from './projectFixture.js'

async function seed(): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Threads', repoPath: '/tmp/m57-threads', verifyCommands: ['true'], setupCommands: [] },
  })
  return workspace.id
}

/** `appendEvent` stamps `ts` itself, so a test that needs two DAYS has to move the row afterwards.
 *  One `updateMany` by `seq` is the smallest way to do it and touches nothing else. */
async function backdate(workspaceId: string, seq: number, ts: Date): Promise<void> {
  await prisma.executionEvent.updateMany({ where: { workspaceId, seq }, data: { ts } })
}

/**
 * One row of the conversation, written directly (F R1).
 *
 * `sendSupervisorMessage` stamps `createdAt` from the clock and allocates the `seq` itself, and
 * these cases are about WHERE a row lands among events whose times they also choose -- so the two
 * columns the merge orders by are set here rather than raced against `now()`.
 */
async function chatRow(
  workspaceId: string,
  row: {
    readonly seq: number
    readonly role: 'human' | 'supervisor'
    readonly text: string
    readonly at: Date
    readonly status?: 'sent' | 'answering' | 'answered' | 'failed'
    readonly attachments?: readonly { readonly path: string; readonly name: string; readonly bytes: number; readonly kind: string }[]
    readonly actions?: readonly { readonly action: Record<string, unknown>; readonly decisionId: string; readonly tier: string }[]
    readonly modelCostUsd?: number | null
    readonly sourced?: boolean
    readonly failureReason?: string | null
  },
): Promise<string> {
  const created = await prisma.supervisorMessage.create({
    data: {
      workspaceId,
      seq: row.seq,
      role: row.role,
      status: (row.status ?? (row.role === 'human' ? 'sent' : 'answered')) as never,
      text: row.text,
      attachments: (row.attachments ?? []) as never,
      ...(row.actions === undefined ? {} : { actions: row.actions as never }),
      modelCostUsd: row.modelCostUsd ?? null,
      sourced: row.sourced ?? false,
      failureReason: row.failureReason ?? null,
      createdAt: row.at,
    },
    select: { id: true },
  })
  return created.id
}

describe('buildSupervisorThreads', () => {
  beforeEach(async (): Promise<void> => {
    await truncateAll()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('reads a goal request as the OPERATOR s own message, in their own words', async (): Promise<void> => {
    const workspaceId = await seed()
    await appendEvent({
      type: 'workspace.goal_set',
      workspaceId,
      actor: 'human',
      payload: { goal: 'Ship the new checkout', version: 2, sha256: 'abc', request: 'make the cart totals right' },
    })

    const threads = await buildSupervisorThreads(workspaceId)

    expect(threads).toHaveLength(1)
    const [message] = threads[0]?.messages ?? []
    expect(message?.who).toBe('operator')
    expect(message?.text).toBe('make the cart totals right')
  })

  it('reads a goal set with no request as the SUPERVISOR s, not as words nobody typed', async (): Promise<void> => {
    const workspaceId = await seed()
    await appendEvent({
      type: 'workspace.goal_set',
      workspaceId,
      actor: 'system',
      payload: { goal: 'Ship the new checkout', version: 1, sha256: 'abc' },
    })

    const [thread] = await buildSupervisorThreads(workspaceId)

    expect(thread?.messages[0]?.who).toBe('supervisor')
  })

  it('carries a pending proposal as a message with a decision id on it', async (): Promise<void> => {
    const workspaceId = await seed()
    await appendEvent({
      type: 'supervisor.proposed',
      workspaceId,
      actor: 'system',
      payload: {
        decisionId: 'd-1',
        situationKind: 'ready_unstaffed',
        subjectId: 'reviewer',
        action: { kind: 'hire_from_catalog' },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    })

    const [thread] = await buildSupervisorThreads(workspaceId)

    expect(thread?.messages[0]?.who).toBe('supervisor')
    expect(thread?.messages[0]?.decisionId).toBe('d-1')
  })

  it('groups by LOCAL CALENDAR DAY, newest thread first, oldest message first inside one', async (): Promise<void> => {
    const workspaceId = await seed()
    const older = await appendEvent({
      type: 'workspace.goal_set',
      workspaceId,
      actor: 'human',
      payload: { goal: 'a', version: 1, sha256: 'x', request: 'yesterday' },
    })
    const newer = await appendEvent({
      type: 'workspace.goal_set',
      workspaceId,
      actor: 'human',
      payload: { goal: 'b', version: 2, sha256: 'y', request: 'today' },
    })
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    await backdate(workspaceId, Number(older.seq), yesterday)
    void newer

    const threads = await buildSupervisorThreads(workspaceId)

    expect(threads).toHaveLength(2)
    expect(threads[0]?.messages.map((m) => m.text)).toEqual(['today'])
    expect(threads[1]?.messages.map((m) => m.text)).toEqual(['yesterday'])
    // The id IS the day, so a URL or a test can name one without a lookup.
    expect(threads[0]?.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(threads[0]?.id).not.toBe(threads[1]?.id)
  })

  it('reads no other family -- a run starting is not a conversation', async (): Promise<void> => {
    const workspaceId = await seed()
    await appendEvent({
      type: 'workspace.created',
      workspaceId,
      actor: 'human',
      payload: {
        name: 'Threads',
        repoPath: '/tmp/m57-threads',
        baseBranch: 'main',
        verifyCommands: ['true'],
        provider: null,
      },
    })

    expect(await buildSupervisorThreads(workspaceId)).toEqual([])
  })

  it('answers an empty list for a workspace with no history at all', async (): Promise<void> => {
    expect(await buildSupervisorThreads(await seed())).toEqual([])
  })

  /** F R1: the conversation is a TABLE now, and its rows share the day buckets with the six event
   *  families this view has always read. */
  describe('the SupervisorMessage rows', () => {
    it('merges a chat exchange into the same day, in time order with the events', async (): Promise<void> => {
      const workspaceId = await seed()
      const midday = new Date()
      midday.setHours(12, 0, 0, 0)
      await chatRow(workspaceId, { seq: 0, role: 'human', text: 'why is checkout stuck?', at: new Date(midday.getTime() - 60_000) })
      await chatRow(workspaceId, { seq: 1, role: 'supervisor', text: 'nobody holds reviewer', at: new Date(midday.getTime() + 60_000) })
      const event = await appendEvent({
        type: 'supervisor.proposed',
        workspaceId,
        actor: 'system',
        payload: {
          decisionId: 'd-1',
          situationKind: 'no_reviewer',
          subjectId: 'reviewer',
          action: { kind: 'hire_from_catalog' },
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      })
      await backdate(workspaceId, Number(event.seq), midday)

      const threads = await buildSupervisorThreads(workspaceId)

      expect(threads).toHaveLength(1)
      expect(threads[0]?.messages.map((message) => message.text)).toEqual([
        'why is checkout stuck?',
        'Supervisor · proposed',
        'nobody holds reviewer',
      ])
      expect(threads[0]?.messages.map((message) => message.who)).toEqual(['operator', 'supervisor', 'supervisor'])
    })

    /** A question and its reply placeholder are written in ONE transaction and share a `createdAt`
     *  to the millisecond, so the clock alone cannot order them (fix round 1, M2). */
    it('keeps a question above its own reply when the two share a millisecond', async (): Promise<void> => {
      const workspaceId = await seed()
      const at = new Date()
      await chatRow(workspaceId, { seq: 1, role: 'supervisor', text: 'because nobody reviews', at })
      await chatRow(workspaceId, { seq: 0, role: 'human', text: 'why is checkout stuck?', at })

      const [thread] = await buildSupervisorThreads(workspaceId)

      expect(thread?.messages.map((message) => message.text)).toEqual([
        'why is checkout stuck?',
        'because nobody reviews',
      ])
    })

    it('puts a chat row ABOVE an event stamped the same millisecond', async (): Promise<void> => {
      const workspaceId = await seed()
      const event = await appendEvent({
        type: 'workspace.goal_set',
        workspaceId,
        actor: 'system',
        payload: { goal: 'Ship checkout', version: 2, sha256: 'abc' },
      })
      const row = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId, seq: Number(event.seq) } })
      await chatRow(workspaceId, { seq: 0, role: 'human', text: 'change the goal', at: row.ts })

      const [thread] = await buildSupervisorThreads(workspaceId)

      // The message is what CAUSED the event, so it reads first even though neither clock moved.
      expect(thread?.messages.map((message) => message.text)).toEqual(['change the goal', 'Project · goal set'])
    })

    it('gives a chat row an id of its own, prefixed so it can never collide with an event s seq', async (): Promise<void> => {
      const workspaceId = await seed()
      const rowId = await chatRow(workspaceId, { seq: 0, role: 'human', text: 'hello', at: new Date() })

      const [thread] = await buildSupervisorThreads(workspaceId)

      expect(thread?.messages[0]?.id).toBe(`msg:${rowId}`)
      expect(thread?.messages[0]?.messageId).toBe(rowId)
    })

    it('carries the status, the attachments, the actions, the cost and the sourced chip', async (): Promise<void> => {
      const workspaceId = await seed()
      const at = new Date()
      await chatRow(workspaceId, {
        seq: 0,
        role: 'human',
        text: 'read this brief',
        at: new Date(at.getTime() - 1_000),
        attachments: [{ path: 'docs/inbox/2026-09-20-brief.md', name: 'brief.md', bytes: 42, kind: 'text' }],
      })
      await chatRow(workspaceId, {
        seq: 1,
        role: 'supervisor',
        text: 'I will ask the planner to use it',
        at,
        status: 'answered',
        actions: [{ action: { kind: 'note_for_planner', text: 'use the brief' }, decisionId: 'd-9', tier: 'proposed' }],
        modelCostUsd: 0.25,
        sourced: true,
      })

      const [thread] = await buildSupervisorThreads(workspaceId)
      const [person, reply] = thread?.messages ?? []

      expect(person?.status).toBe('sent')
      expect(person?.attachments).toEqual([
        { path: 'docs/inbox/2026-09-20-brief.md', name: 'brief.md', bytes: 42, kind: 'text' },
      ])
      expect(reply?.status).toBe('answered')
      expect(reply?.actions).toEqual([{ decisionId: 'd-9', tier: 'proposed', kind: 'note_for_planner' }])
      // The first action's decision is on `decisionId` too, so the card the panel already matches
      // by that field lands under the reply that asked for it.
      expect(reply?.decisionId).toBe('d-9')
      expect(reply?.costUsd).toBe(0.25)
      expect(reply?.sourced).toBe(true)
      expect(reply?.failureReason).toBeNull()
    })

    it('carries the raw failure reason of a turn nothing answered', async (): Promise<void> => {
      const workspaceId = await seed()
      await chatRow(workspaceId, {
        seq: 0,
        role: 'supervisor',
        text: '',
        at: new Date(),
        status: 'failed',
        failureReason: 'budget_exhausted',
      })

      const [thread] = await buildSupervisorThreads(workspaceId)

      expect(thread?.messages[0]?.status).toBe('failed')
      // RAW, never a sentence: the panel owns the wording, and a reason stored months ago must
      // still be readable by whatever renders it then.
      expect(thread?.messages[0]?.failureReason).toBe('budget_exhausted')
    })

    it('does NOT fold a goal_set into the chat message that asked for it', async (): Promise<void> => {
      const workspaceId = await seed()
      const at = new Date()
      await chatRow(workspaceId, { seq: 0, role: 'human', text: 'make the cart totals right', at })
      await appendEvent({
        type: 'workspace.goal_set',
        workspaceId,
        actor: 'human',
        payload: { goal: 'Ship checkout', version: 2, sha256: 'abc', request: 'make the cart totals right' },
      })

      const [thread] = await buildSupervisorThreads(workspaceId)

      // TWO bubbles with the same words, deliberately: this projection cannot know that one
      // CAUSED the other, and guessing would silently drop a message somebody really sent.
      expect(thread?.messages.map((message) => message.text)).toEqual([
        'make the cart totals right',
        'make the cart totals right',
      ])
      expect(thread?.messages[0]?.messageId).toBeDefined()
      expect(thread?.messages[1]?.messageId).toBeUndefined()
    })

    it('buckets a chat row by its own local day, like every other message', async (): Promise<void> => {
      const workspaceId = await seed()
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      await chatRow(workspaceId, { seq: 0, role: 'human', text: 'yesterday', at: yesterday })
      await chatRow(workspaceId, { seq: 1, role: 'human', text: 'today', at: new Date() })

      const threads = await buildSupervisorThreads(workspaceId)

      expect(threads).toHaveLength(2)
      expect(threads[0]?.when).toBe('today')
      expect(threads[0]?.messages.map((message) => message.text)).toEqual(['today'])
      expect(threads[1]?.when).toBe('yesterday')
    })

    it('leaves an event row without the chat fields at all', async (): Promise<void> => {
      const workspaceId = await seed()
      await appendEvent({
        type: 'workspace.goal_set',
        workspaceId,
        actor: 'human',
        payload: { goal: 'a', version: 1, sha256: 'x', request: 'typed' },
      })

      const [thread] = await buildSupervisorThreads(workspaceId)

      expect(thread?.messages[0]?.status).toBeUndefined()
      expect(thread?.messages[0]?.attachments).toBeUndefined()
      expect(thread?.messages[0]?.actions).toBeUndefined()
      expect(thread?.messages[0]?.costUsd).toBeUndefined()
      expect(thread?.messages[0]?.sourced).toBeUndefined()
      expect(thread?.messages[0]?.refs).toEqual(['v1'])
    })
  })
})
