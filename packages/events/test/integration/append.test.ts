import { prisma } from '@ai-team-os/db/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../src/append.js'
import { subscribeEvents, type EventNotification, type EventSubscription } from '../../src/subscribe.js'

const url = (): string => process.env['TEST_DATABASE_URL'] ?? ''

let subscription: EventSubscription | null = null

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent" RESTART IDENTITY CASCADE')
})

afterEach(async (): Promise<void> => {
  await subscription?.close()
  subscription = null
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('appendEvent', () => {
  it('writes a valid event and returns it parsed', async () => {
    const event = await appendEvent({
      type: 'task.created',
      workspaceId: 'w1',
      taskId: 'task-1',
      actor: 'human',
      payload: { title: 'Add checkout retry' },
    })

    expect(event.type).toBe('task.created')
    expect(typeof event.seq).toBe('number')
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(await prisma.executionEvent.count()).toBe(1)
  })

  it('leaves no row when the payload does not match the event type', async () => {
    await expect(
      appendEvent({
        type: 'task.created',
        workspaceId: 'w1',
        actor: 'human',
        payload: { nonsense: true },
      }),
    ).rejects.toThrow()

    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('notifies a subscriber with the seq and workspace id', async () => {
    const seen: EventNotification[] = []
    subscription = await subscribeEvents(url(), (n) => seen.push(n))

    const event = await appendEvent({
      type: 'run.started',
      workspaceId: 'w1',
      runId: 'run-1',
      actor: 'system',
      payload: { sessionId: 'sess-1' },
    })

    await expect.poll(() => seen).toEqual([{ seq: event.seq, workspaceId: 'w1' }])
  })

  it('delivers no notification when the write is rolled back', async () => {
    const seen: EventNotification[] = []
    subscription = await subscribeEvents(url(), (n) => seen.push(n))

    await expect(
      appendEvent({ type: 'task.created', workspaceId: 'w1', actor: 'human', payload: { nope: 1 } }),
    ).rejects.toThrow()

    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(seen).toEqual([])
  })
})
