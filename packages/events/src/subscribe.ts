import { Client } from 'pg'

export interface EventNotification {
  readonly seq: number
  readonly workspaceId: string
}

export interface EventSubscription {
  close(): Promise<void>
}

const RECONNECT_DELAY_MS = 250

/**
 * Bounds each phase of `open()` — the TCP connect/handshake and the `LISTEN events` query.
 *
 * pg defaults both to "wait forever" (`connectionTimeoutMillis: 0`, no `query_timeout`), which is
 * only survivable while nothing awaits the reconnect loop. `close()` does await it, so an
 * unresponsive-but-reachable server — one that accepts TCP and then never speaks the Postgres
 * protocol, or completes the handshake and then stalls on the query — would park the loop inside
 * `open()` forever and hang `close()` with it, all the way up through Task 11's
 * `createEventStream.close()` and M4's SSE teardown.
 *
 * Both phases need a bound: `connectionTimeoutMillis` covers only connect + handshake, so a server
 * that finishes the handshake and then goes quiet is caught by `query_timeout` instead.
 *
 * 2s is 10-100x the observed cost of a real connect (~10-30ms locally, a few hundred ms
 * cross-region), and the cost of erring short is only a retry 250ms later rather than a surfaced
 * error, so short is the cheap direction.
 *
 * The same budget bounds the `end()` that discards a failed attempt's client, so a worst-case
 * `close()` pays three of these sequentially plus the retry delay: RECONNECT_DELAY_MS, then both
 * of `open()`'s deadlines against a server stalling at the phase boundary, then the discard —
 * ~6.25s, not ~4s. The loop terminates either way, which is the point; the number matters only
 * because M4's SSE teardown budgets against it, so keep it in step with docs/event-model.md.
 */
const OPEN_TIMEOUT_MS = 2_000

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

  /**
   * End a client that is being thrown away, without letting the teardown itself become the
   * failure. Every `detachHandlers` in this file is followed by exactly this, because both of
   * the hazards below apply to all three abandon sites (a failed `open()`, a reconnect that
   * finished after `close()`, and `close()` itself).
   *
   * 1. **The detach removes the only `'error'` listener.** pg wires
   *    `con.on('error', this._handleErrorEvent)` unconditionally (`pg/lib/client.js`), and
   *    `_handleErrorEvent` ends in `this.emit('error', err)`. Any socket error or FATAL
   *    `ErrorResponse` — a Postgres restart, a failover, someone's `pg_terminate_backend` —
   *    arriving between the detach and the socket actually closing therefore reaches a
   *    listener-less EventEmitter, and Node throws out of a socket data callback. That kills the
   *    whole process, not just this subscription, and `close()` is the path an SSE route runs on
   *    every client disconnect. Reproduced end to end (LISTEN, detach, hold the FATAL behind a
   *    proxy, release it while `end()` is in flight): `Unhandled 'error' event`, exit 1. The
   *    no-op sink turns that into nothing at all.
   *
   * 2. **`end()` is only sometimes bounded by pg.** It force-destroys the socket when the client
   *    is no longer `_queryable` (the `connectionTimeoutMillis` path) or still has an active
   *    query (the `query_timeout` path), but takes a graceful branch — send Terminate, then wait
   *    for `'close'` — otherwise. A peer that answers `LISTEN` with `ErrorResponse` +
   *    `ReadyForQuery` and then simply holds the socket open leaves the client `_queryable` with
   *    no active query, so that graceful branch waits forever: measured still pending at 8038ms
   *    against a half-open peer, versus 1ms against a normal one. Racing the same `OPEN_TIMEOUT_MS`
   *    budget and destroying the stream on expiry bounds it without leaking the socket.
   */
  const endDiscardedClient = async (client: Client): Promise<void> => {
    detachHandlers(client)
    client.on('error', () => {})

    let expiry: ReturnType<typeof setTimeout> | undefined
    const bounded = new Promise<void>((resolve) => {
      expiry = setTimeout(() => {
        // The client is being abandoned either way, so there is nothing to preserve by waiting
        // for a graceful goodbye the peer may never answer.
        client.connection.stream.destroy()
        resolve()
      }, OPEN_TIMEOUT_MS)
    })

    try {
      await Promise.race([client.end(), bounded])
    } catch {
      // nothing to salvage from a client that is being discarded
    } finally {
      clearTimeout(expiry)
    }
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
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: OPEN_TIMEOUT_MS,
      query_timeout: OPEN_TIMEOUT_MS,
    })
    attachHandlers(client)
    try {
      await client.connect()
      await client.query('LISTEN events')
    } catch (error) {
      // Leave no debris behind a failed attempt. pg cleans up after the two timeouts differently:
      // a `connectionTimeoutMillis` expiry destroys the socket itself, but a `query_timeout` expiry
      // only rejects the query and leaves the connection open and `_queryable` — so without an
      // `end()` here a stalled server would leak one live socket per retry. `endDiscardedClient`
      // is what makes that `end()` both bounded and safe; pg's own `end()` is bounded only on the
      // two timeout paths, not on every path that can reach this catch.
      await endDiscardedClient(client)
      throw error
    }
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
            await endDiscardedClient(client)
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
        await endDiscardedClient(client)
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
