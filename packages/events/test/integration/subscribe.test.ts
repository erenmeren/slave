import { Client } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { subscribeEvents, type EventNotification, type EventSubscription } from '../../src/subscribe.js'

const url = (): string => process.env['TEST_DATABASE_URL'] ?? ''

let subscription: EventSubscription | null = null

afterEach(async (): Promise<void> => {
  await subscription?.close()
  subscription = null
})

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function notify(payload: string): Promise<void> {
  const client = new Client({ connectionString: url() })
  await client.connect()
  try {
    await client.query('SELECT pg_notify($1, $2)', ['events', payload])
  } finally {
    await client.end()
  }
}

async function killListeners(): Promise<void> {
  const killer = new Client({ connectionString: url() })
  await killer.connect()
  try {
    await killer.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE query LIKE 'LISTEN events%' AND pid <> pg_backend_pid()`,
    )
  } finally {
    await killer.end()
  }
}

describe('subscribeEvents', () => {
  it('receives a notification on the events channel', async () => {
    const seen: EventNotification[] = []
    subscription = await subscribeEvents(url(), (n) => seen.push(n))

    await notify(JSON.stringify({ seq: 7, workspaceId: 'w1' }))
    await expect.poll(() => seen).toEqual([{ seq: 7, workspaceId: 'w1' }])
  })

  it('ignores a malformed payload and stays alive for the next valid one', async () => {
    const seen: EventNotification[] = []
    subscription = await subscribeEvents(url(), (n) => seen.push(n))

    await notify('not json at all')
    await notify(JSON.stringify({ seq: 9, workspaceId: 'w2' }))

    await expect.poll(() => seen).toEqual([{ seq: 9, workspaceId: 'w2' }])
  })

  it('re-listens after its connection is terminated', async () => {
    const seen: EventNotification[] = []
    subscription = await subscribeEvents(url(), (n) => seen.push(n))

    await killListeners()

    await expect
      .poll(
        async () => {
          await notify(JSON.stringify({ seq: 11, workspaceId: 'w3' }))
          return seen.length
        },
        { timeout: 10_000, interval: 500 },
      )
      .toBeGreaterThan(0)
  })

  it(
    'delivers exactly one notification per event across a reconnect',
    async () => {
      const seen: EventNotification[] = []
      subscription = await subscribeEvents(url(), (n) => seen.push(n))

      await killListeners()

      // A disconnect can fire `error` twice and `end` once. If the reconnect path fails to dedupe
      // those, more than one replacement client can end up LISTENing at once, and every
      // notification after that point is delivered more than once. Confirm the subscriber is back
      // up first — same technique as the "re-listens" test.
      await expect
        .poll(
          async () => {
            await notify(JSON.stringify({ seq: 30, workspaceId: 'warmup' }))
            return seen.some((n) => n.seq === 30)
          },
          { timeout: 10_000, interval: 500 },
        )
        .toBe(true)

      // Give a second, orphaned reconnect loop (the bug this test targets) time to finish its own
      // LISTEN too, so it has every chance to be in place before the assertion below.
      await wait(1_000)

      await notify(JSON.stringify({ seq: 31, workspaceId: 'w-single' }))
      await wait(1_000)

      expect(seen.filter((n) => n.seq === 31)).toHaveLength(1)
    },
    15_000,
  )
})
