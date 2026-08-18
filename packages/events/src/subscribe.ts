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
  // A single disconnect can fire `error` twice and then `end` once (confirmed against real
  // Postgres via `pg_terminate_backend`). Without this guard, each of those three events would
  // start its own reconnect loop, and more than one could complete `open()` — leaving an orphaned,
  // still-listening `Client` that `close()` never sees (it only knows about `current`) and that
  // delivers every subsequent notification a second time. `reconnecting` makes "a reconnect is
  // already in flight" a single piece of state so at most one loop, and at most one new `Client`,
  // is ever created per disconnect.
  let reconnecting = false

  const detachHandlers = (client: Client): void => {
    client.removeAllListeners('notification')
    client.removeAllListeners('error')
    client.removeAllListeners('end')
  }

  const attachHandlers = (client: Client): void => {
    client.on('notification', (message) => {
      const parsed = parseNotification(message.payload)
      if (parsed !== null) onNotification(parsed)
    })
    client.on('error', scheduleReconnect)
    client.on('end', scheduleReconnect)
  }

  const open = async (): Promise<Client> => {
    const client = new Client({ connectionString })
    attachHandlers(client)
    await client.connect()
    await client.query('LISTEN events')
    return client
  }

  function scheduleReconnect(): void {
    if (closed || reconnecting) return
    reconnecting = true
    current = null
    void (async (): Promise<void> => {
      while (!closed) {
        await delay(RECONNECT_DELAY_MS)
        try {
          const client = await open()
          if (closed) {
            // close() ran while this reconnect was in flight. current is already what close()
            // acted on (null, at this point), so this freshly opened client is not reachable from
            // anywhere else — end it here rather than leaving it orphaned and listening.
            detachHandlers(client)
            await client.end()
          } else {
            current = client
          }
          reconnecting = false
          return
        } catch {
          // keep retrying until close() is called
        }
      }
      reconnecting = false
    })()
  }

  current = await open()

  return {
    async close(): Promise<void> {
      closed = true
      const client = current
      current = null
      if (client !== null) {
        detachHandlers(client)
        await client.end()
      }
      // Any reconnect loop currently in flight observes `closed` on its next wake (after its
      // delay, or immediately after its pending `open()` resolves) and ends the client it opened
      // itself — see the `if (closed)` branch in scheduleReconnect above. There is no window in
      // which a racing loop's client becomes reachable without `close()` having a chance to react
      // to it, by construction of the single `reconnecting` guard.
    },
  }
}
