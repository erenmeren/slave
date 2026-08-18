import { Client } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { subscribeEvents, type EventNotification, type EventSubscription } from '../../src/subscribe.js'

const url = (): string => process.env['TEST_DATABASE_URL'] ?? ''

let subscription: EventSubscription | null = null

afterEach(async (): Promise<void> => {
  await subscription?.close()
  subscription = null
})

async function notify(payload: string): Promise<void> {
  const client = new Client({ connectionString: url() })
  await client.connect()
  try {
    await client.query('SELECT pg_notify($1, $2)', ['events', payload])
  } finally {
    await client.end()
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
})
