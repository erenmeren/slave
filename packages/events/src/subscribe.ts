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
 * The same budget bounds every `end()` that discards a client this file abandons — both the one at
 * the top of each reconnect pass (`endDiscardedClient(stale)`, discarding whatever `current` held
 * on entry) and the one that discards a failed attempt's client. That makes `close()`'s true worst
 * case ~6.0s, not the ~8.25s an earlier pass computed here — that number wrongly summed every phase
 * below as if a single `close()` could pay all of them in one call, which the loop's control flow
 * does not allow. There are two mutually exclusive places `close()` can land inside an in-flight
 * reconnect, and the ceiling is the larger of the two:
 *
 * - **Mid-`open()`.** A single failing attempt can burn up to both of its own deadlines
 *   sequentially — connect succeeding just under its 2000ms budget, then `LISTEN events` stalling
 *   out its own 2000ms — before the query timeout is what finally rejects it (4000ms of stall),
 *   plus the failed attempt's own client being discarded through this same bounded `end()`
 *   (2000ms more) = 6000ms. `close()` landing here just marks `closed`; the loop's `catch` re-arms
 *   `reconnectRequested` as usual, but `while (!closed && reconnectRequested)` now reads `closed`
 *   as true and exits immediately — no top-of-pass discard or RECONNECT_DELAY_MS stacks on top.
 * - **Top of a pass**, before `open()` is even called again: the stale-client discard
 *   (`endDiscardedClient(stale)`, up to 2000ms) then `RECONNECT_DELAY_MS` (250ms) = 2250ms, because
 *   `if (closed) break` (see `scheduleReconnect`) fires right after and the pass never reaches
 *   `open()` at all.
 *
 * max(6000, 2250) = 6.0s. The loop terminates either way, which is the point; the number matters
 * only because M4's SSE teardown budgets against it, so keep it in step with docs/event-model.md.
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
  //
  // `reconnecting` alone still had a hole: the loop sets `current = client` and only *then* clears
  // `reconnecting`. A disconnect landing in that window — or at any point after `open()` succeeded
  // but before the flag clears — hit `if (closed || reconnecting) return` and was dropped, leaving
  // the subscription holding a dead client forever. `reconnectRequested` closes it: every call
  // records the request before checking `reconnecting`, and the loop re-reads it before it is
  // allowed to end, so a disconnect can be coalesced into an in-flight loop but never discarded.
  let reconnecting = false
  let reconnectRequested = false
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

  /**
   * `isInitial` is true only for the very first call, at the bottom of this function — never for a
   * call the reconnect loop makes on its own. It exists to close one specific hole: `attachHandlers`
   * wires `client.on('error', scheduleReconnect)` before `connect()` even starts, and a connection
   * that dies mid-`LISTEN` reaches both that listener and this function's own `catch` — confirmed
   * against a real socket teardown during the query: `error` fires once, then the awaited
   * `client.query()` itself rejects. Inside the loop that double delivery is harmless, because
   * `scheduleReconnect` sees `reconnecting` already true and just re-arms `reconnectRequested`,
   * which the catch below sets anyway. On the *first* call there is no loop yet: the `error` listener
   * still fires and starts one (`reconnecting = true`, parked in its `RECONNECT_DELAY_MS` wait) before
   * this catch gets a chance to run, but `subscribeEvents` is about to reject from the `throw` below,
   * so nothing will ever hold a handle to close that loop — it would keep dialing Postgres and
   * LISTENing forever, unowned. Marking `closed` here, before the loop's delay resolves, makes its
   * `if (closed) break` (see `scheduleReconnect`) catch it on the very next tick instead.
   */
  const open = async (isInitial = false): Promise<Client> => {
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
      if (isInitial) closed = true
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
    if (closed) return
    // Never drop a disconnect: even while a loop is already in flight for an earlier one, this
    // call is recorded here and the loop re-checks it before it is allowed to end.
    reconnectRequested = true
    if (reconnecting) return
    reconnecting = true
    reconnectPromise = (async (): Promise<void> => {
      while (!closed && reconnectRequested) {
        reconnectRequested = false
        // Whatever `current` holds at the top of a pass is either the already-dying client that
        // caused this pass to run, or — on a pass this loop was re-armed into by a disconnect that
        // landed right after the previous pass's `current = client` — the client that disconnect
        // was reported on. Either way it is not usable going forward, so it is discarded the same
        // way every other abandoned client in this file is.
        const stale = current
        current = null
        if (stale !== null) await endDiscardedClient(stale)
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
            break
          }
          current = client
          // A disconnect reported anywhere from here back to the top of this pass — including one
          // that lands in the instant after the assignment above, before `while` is re-evaluated —
          // set `reconnectRequested` again instead of being dropped, so the loop does not exit here.
        } catch {
          // keep retrying until close() is called
          reconnectRequested = true
        }
      }
      reconnecting = false
      reconnectPromise = null
    })()
  }

  current = await open(true)

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
