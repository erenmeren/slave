import { prisma } from '@ai-team-os/db/client'
import type { ExecutionEvent } from '@ai-team-os/domain'
import { Client } from 'pg'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../src/append.js'
import { readEventsSince } from '../../src/read.js'
import { createEventStream, DEFAULT_POLL_INTERVAL_MS, type EventStreamHandle } from '../../src/stream.js'

const url = (): string => process.env['TEST_DATABASE_URL'] ?? ''

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Embeds `application_name` in the connection string so a probe can find this stream's own backend. */
function withAppName(base: string, appName: string): string {
  const target = new URL(base)
  target.searchParams.set('application_name', appName)
  return target.toString()
}

async function countBackendsForAppName(appName: string): Promise<number> {
  const probe = new Client({ connectionString: url() })
  await probe.connect()
  try {
    const result = await probe.query<{ pid: number }>(
      'SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()',
      [appName],
    )
    return result.rowCount ?? 0
  } finally {
    await probe.end()
  }
}

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
  it('delivers an event appended after the stream started, exactly once after settling', async () => {
    const seen: ExecutionEvent[] = []
    // A fast poll is deliberate here: the point of this test is that a notification-delivered
    // event is not *also* redelivered by a later poll tick. With the default 5s interval the test
    // would finish long before a second tick could ever prove that either way.
    stream = await createEventStream({
      connectionString: url(),
      fromSeq: 0,
      onEvent: (event) => seen.push(event),
      pollIntervalMs: 100,
    })

    await appendEvent({ type: 'task.started', workspaceId: 'w1', actor: 'system', payload: { title: 'a' } })

    await expect.poll(() => seen.length, { timeout: 5000, interval: 50 }).toBeGreaterThan(0)
    // Settle past several more poll ticks before asserting the exact, final array. An
    // `expect.poll(...).toEqual(...)` resolves at the *first* matching observation, so it would
    // never see a duplicate arrive on a later tick — this fixed wait is what makes that visible.
    await wait(500)
    expect(seen.map((e) => e.type)).toEqual(['task.started'])
  }, 10_000)

  it('delivers an event that was never announced, via the fallback poll, exactly once after settling', async () => {
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

    await expect.poll(() => seen.length, { timeout: 5000, interval: 100 }).toBeGreaterThan(0)
    // Settle past at least two more 300ms ticks so a duplicate delivery has time to show up.
    await wait(700)
    expect(seen.map((e) => e.type)).toEqual(['task.done'])
  }, 10_000)

  it('defaults the poll interval to five seconds, too slow to be the transport', () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(5000)
  })
})

describe('createEventStream teardown', () => {
  it('close() stops the fallback poll: nothing is delivered after close, even past two poll intervals', async () => {
    const seen: ExecutionEvent[] = []
    stream = await createEventStream({
      connectionString: url(),
      fromSeq: 0,
      onEvent: (event) => seen.push(event),
      pollIntervalMs: 100,
    })

    await stream.close()
    stream = null

    // Written directly, bypassing appendEvent — no NOTIFY, so only a live poll could ever surface
    // this row. If the poll is still running after close(), it will.
    await prisma.executionEvent.create({
      data: { type: 'task_done', workspaceId: 'w1', actor: 'system', payload: { branch: 'aiteamos/x' } },
    })

    await wait(350) // > 2 poll intervals past close()

    expect(seen).toEqual([])
  })

  it("close() ends the subscription's own Postgres backend", async () => {
    const appName = `task11-close-backend-${process.pid}-${Date.now()}`
    stream = await createEventStream({
      connectionString: withAppName(url(), appName),
      fromSeq: 0,
      onEvent: () => {},
    })

    expect(await countBackendsForAppName(appName)).toBe(1)

    await stream.close()
    stream = null

    expect(await countBackendsForAppName(appName)).toBe(0)
  })
})

describe('createEventStream error handling', () => {
  it('routes a failed catch-up read to onError, produces no unhandled rejections, and close() resolves cleanly', async () => {
    const seen: ExecutionEvent[] = []
    const errors: unknown[] = []
    const unhandled: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      stream = await createEventStream({
        connectionString: url(),
        fromSeq: 0,
        onEvent: (event) => seen.push(event),
        onError: (error) => errors.push(error),
        pollIntervalMs: 100,
      })

      // Written directly (no NOTIFY) so the poll is what keeps hitting it, the same way a real
      // fallback-poll tick would keep retrying a transient read failure.
      await prisma.executionEvent.create({
        data: { type: 'task_created', workspaceId: 'w1', actor: 'system', payload: { wrong: true } },
      })

      // A valid event above the bad row's seq — still unreachable while the bad row blocks the
      // cursor, but its presence is what proves the stream isn't just idle.
      await appendEvent({ type: 'task.started', workspaceId: 'w1', actor: 'system', payload: { title: 'a' } })

      await expect.poll(() => errors.length, { timeout: 3000, interval: 100 }).toBeGreaterThan(0)
      // Let several more poll ticks pass so a poisoned chain (which would stop retrying and mint
      // unhandled rejections instead) has every chance to show itself.
      await wait(500)

      // The valid event cannot arrive while the bad row sits below the cursor — readEventsSince
      // throws rather than skips, by design, so the stream is fail-closed on corruption.
      expect(seen).toEqual([])
      expect(unhandled).toEqual([])

      await expect(stream.close()).resolves.toBeUndefined()
      stream = null
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  }, 10_000)

  it('recovers once the bad row is removed: a later valid event is delivered', async () => {
    const seen: ExecutionEvent[] = []
    const errors: unknown[] = []
    stream = await createEventStream({
      connectionString: url(),
      fromSeq: 0,
      onEvent: (event) => seen.push(event),
      onError: (error) => errors.push(error),
      pollIntervalMs: 100,
    })

    const badRow = await prisma.executionEvent.create({
      data: { type: 'task_created', workspaceId: 'w1', actor: 'system', payload: { wrong: true } },
    })

    await expect.poll(() => errors.length, { timeout: 3000, interval: 100 }).toBeGreaterThan(0)

    await prisma.executionEvent.delete({ where: { seq: badRow.seq } })

    await appendEvent({
      type: 'task.started', workspaceId: 'w1', actor: 'system', payload: { title: 'recovered' },
    })

    await expect
      .poll(() => seen.map((e) => e.type), { timeout: 5000, interval: 100 })
      .toEqual(['task.started'])
  }, 10_000)
})
