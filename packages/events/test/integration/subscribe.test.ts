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

async function countListenBackends(probe: Client): Promise<number> {
  const rows = await probe.query(
    `SELECT pid FROM pg_stat_activity WHERE query LIKE 'LISTEN events%' AND pid <> pg_backend_pid()`,
  )
  return rows.rowCount ?? 0
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

  it(
    'close() waits for an in-flight reconnect to fully stop before resolving',
    async () => {
      subscription = await subscribeEvents(url(), () => {})

      const probe = new Client({ connectionString: url() })
      await probe.connect()
      try {
        const before = await probe.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE query LIKE 'LISTEN events%' AND pid <> pg_backend_pid()`,
        )
        expect(before.rows).toHaveLength(1)
        const originalRow = before.rows[0]
        if (originalRow === undefined) {
          throw new Error('expected exactly one LISTEN events backend before the kill')
        }

        await probe.query('SELECT pg_terminate_backend($1)', [originalRow.pid])

        // Give the disconnect a moment to reach the subscription's socket and start its reconnect
        // loop, which then parks in a 250ms retry delay before opening anything. close() is called
        // here while the loop should still be inside that delay — well under the 250ms.
        await wait(50)

        const closeStarted = Date.now()
        await subscription.close()
        const closeElapsedMs = Date.now() - closeStarted
        subscription = null

        // A close() that does not wait for the in-flight loop has nothing else to do at this point
        // (`current` is already null — scheduleReconnect cleared it the moment it started) and so
        // returns almost immediately, in single-digit milliseconds. A close() that correctly awaits
        // the loop can only resolve once that loop's own retry delay has elapsed and it has
        // rechecked `closed`, so it necessarily takes a large fraction of the remaining delay. This
        // is the same signal the reviewer used to find the bug in the first place (close()
        // resolving at +88ms while the loop was still parked, versus the loop only waking at
        // +308ms) — measuring how long close() itself takes to resolve, not database-visible state,
        // because the window during which a reconnect attempt is visible in pg_stat_activity is a
        // single synchronous JS turn (LISTEN succeeds, then the loop's own closed-check ends the
        // client in the same tick) and is not reliably observable by polling.
        expect(closeElapsedMs).toBeGreaterThanOrEqual(120)

        // Secondary, coarser check: no new LISTEN backend should be observable for a full retry
        // interval and margin beyond close(). This does not on its own prove the timing contract
        // above (a self-terminating reconnect attempt can come and go between polls), but it is
        // still a legitimate check that nothing is left running.
        const watchUntil = Date.now() + 600
        while (Date.now() < watchUntil) {
          expect(await countListenBackends(probe)).toBe(0)
          await wait(25)
        }
      } finally {
        await probe.end()
      }
    },
    15_000,
  )
})
