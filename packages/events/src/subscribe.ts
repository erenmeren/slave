import { Client } from 'pg'

export interface EventNotification {
  readonly seq: number
  readonly workspaceId: string
}

export interface EventSubscription {
  close(): Promise<void>
}

const RECONNECT_DELAY_MS = 250

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A notification is a wake-up, not a delivery. Its payload carries ids only — Postgres NOTIFY has
 * an 8KB limit that a large tool output would exceed — and a malformed one is dropped rather than
 * allowed to kill the listener, because the consumer's catch-up read is driven by `seq` and will
 * pick up anything a dropped notification would have announced.
 */
function parseNotification(payload: string | undefined): EventNotification | null {
  if (payload === undefined) return null

  try {
    const value: unknown = JSON.parse(payload)
    if (typeof value !== 'object' || value === null) return null

    const record = value as Record<string, unknown>
    const seq = record['seq']
    const workspaceId = record['workspaceId']
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return null
    if (typeof workspaceId !== 'string' || workspaceId === '') return null

    return { seq, workspaceId }
  } catch {
    return null
  }
}

export async function subscribeEvents(
  connectionString: string,
  onNotification: (notification: EventNotification) => void,
): Promise<EventSubscription> {
  let closed = false
  let current: Client | null = null

  const scheduleReconnect = (): void => {
    if (closed) return
    current = null
    void (async (): Promise<void> => {
      while (!closed) {
        await delay(RECONNECT_DELAY_MS)
        try {
          await open()
          return
        } catch {
          // keep retrying until close() is called
        }
      }
    })()
  }

  const open = async (): Promise<void> => {
    const client = new Client({ connectionString })
    client.on('notification', (message) => {
      const parsed = parseNotification(message.payload)
      if (parsed !== null) onNotification(parsed)
    })
    client.on('error', scheduleReconnect)
    client.on('end', scheduleReconnect)

    await client.connect()
    await client.query('LISTEN events')
    current = client
  }

  await open()

  return {
    async close(): Promise<void> {
      closed = true
      const client = current
      current = null
      if (client !== null) {
        client.removeAllListeners('end')
        client.removeAllListeners('error')
        await client.end()
      }
    },
  }
}
