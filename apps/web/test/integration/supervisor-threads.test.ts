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
})
