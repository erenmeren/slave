import { prisma } from '@ai-team-os/db/client'
import type { ExecutionEvent } from '@ai-team-os/domain'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../src/append.js'
import { readEventsSince } from '../../src/read.js'
import { createEventStream, DEFAULT_POLL_INTERVAL_MS, type EventStreamHandle } from '../../src/stream.js'

const url = (): string => process.env['TEST_DATABASE_URL'] ?? ''

let stream: EventStreamHandle | null = null

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent" RESTART IDENTITY CASCADE')
})

afterEach(async (): Promise<void> => {
  await stream?.close()
  stream = null
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('readEventsSince', () => {
  it('returns only later events, in ascending seq order', async () => {
    const first = await appendEvent({
      type: 'task.created', workspaceId: 'w1', actor: 'human', payload: { title: 'a' },
    })
    const second = await appendEvent({
      type: 'task.created', workspaceId: 'w1', actor: 'human', payload: { title: 'b' },
    })
    const third = await appendEvent({
      type: 'task.created', workspaceId: 'w1', actor: 'human', payload: { title: 'c' },
    })

    const events = await readEventsSince(first.seq)
    expect(events.map((e) => e.seq)).toEqual([second.seq, third.seq])
  })

  it('throws rather than silently skipping a row the domain cannot parse', async () => {
    await prisma.executionEvent.create({
      data: { type: 'task_created', workspaceId: 'w1', actor: 'system', payload: { wrong: true } },
    })

    await expect(readEventsSince(0)).rejects.toThrow()
  })
})

describe('createEventStream', () => {
  it('delivers an event appended after the stream started', async () => {
    const seen: ExecutionEvent[] = []
    stream = await createEventStream({
      connectionString: url(),
      fromSeq: 0,
      onEvent: (event) => seen.push(event),
    })

    await appendEvent({ type: 'task.started', workspaceId: 'w1', actor: 'system', payload: { title: 'a' } })

    await expect.poll(() => seen.map((e) => e.type)).toEqual(['task.started'])
  })

  it('delivers an event that was never announced, via the fallback poll', async () => {
    const seen: ExecutionEvent[] = []
    stream = await createEventStream({
      connectionString: url(),
      fromSeq: 0,
      onEvent: (event) => seen.push(event),
      pollIntervalMs: 300,
    })

    // Written directly, bypassing appendEvent — so no NOTIFY is ever issued for this row.
    await prisma.executionEvent.create({
      data: { type: 'task_done', workspaceId: 'w1', actor: 'system', payload: { branch: 'aiteamos/x' } },
    })

    await expect.poll(() => seen.map((e) => e.type), { timeout: 5000, interval: 100 }).toEqual(['task.done'])
  })

  it('defaults the poll interval to five seconds, too slow to be the transport', () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(5000)
  })
})
