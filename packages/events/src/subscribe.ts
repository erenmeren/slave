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
  // The reconnect loop's own promise, tracked so close() can await it. Without this, close() could
  // resolve while the loop was still parked in its retry delay, promising a fully quiescent
  // subscription while a Client was about to be opened moments later — a false contract for a
  // caller (Task 11's createEventStream, and eventually an SSE teardown path) that trusts close()
  // to mean "no more network I/O from this subscription".
  let reconnectPromise: Promise<void> | null = null

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
    reconnectPromise = (async (): Promise<void> => {
      while (!closed) {
        await delay(RECONNECT_DELAY_MS)
        // Recheck immediately after the delay, before opening anything: close() may have run
        // while this loop was parked, and there is no reason to dial Postgres and issue LISTEN
        // for a subscription that is already torn down. This closes the window rather than
        // surviving it — previously the loop would proceed straight to open() here regardless.
        if (closed) break
        try {
          const client = await open()
          if (closed) {
            // close() ran while `open()` itself was in flight (connect + LISTEN). The client is
            // not reachable from anywhere else yet, so end it here rather than leaving it
            // orphaned and listening.
            detachHandlers(client)
            await client.end()
          } else {
            current = client
          }
          break
        } catch {
          // keep retrying until close() is called
        }
      }
      reconnecting = false
      reconnectPromise = null
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
      // Await whatever reconnect loop is in flight so this promise cannot resolve while the
      // subscription is still doing network I/O in the background. The guard above (`reconnecting`)
      // guarantees there is at most one such loop.
      const pending = reconnectPromise
      if (pending !== null) {
        await pending
      }
    },
  }
}
