import net from 'node:net'
import { Client } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { subscribeEvents, type EventNotification, type EventSubscription } from '../../src/subscribe.js'

const url = (): string => process.env['TEST_DATABASE_URL'] ?? ''

/**
 * A TCP proxy in front of the real Postgres that can be switched, mid-test, into a "reachable but
 * unresponsive" server. That is the failure mode a plain `pg_terminate_backend` cannot produce —
 * the backend kill makes the server go away, these modes make it go quiet, which is what leaves
 * `open()` hanging. Two flavours, because `open()` has two phases that hang independently:
 *
 * - `goSilent()` — accept the TCP connection and never speak the protocol at all (hangs connect).
 * - `goSilentAfterHandshake()` — connect and authenticate normally, then swallow the first query
 *   and answer nothing (hangs `LISTEN events`).
 *
 * It can also *delay* the server rather than silence it — see
 * `holdServerMessagesUntilTerminate()`, which is what turns "a FATAL arrives at exactly the wrong
 * moment" from a race into a deterministic test.
 */
interface StallableProxy {
  readonly port: number
  goSilent(): void
  goSilentAfterHandshake(): void
  /**
   * Stop forwarding what the server says and buffer it instead, then release the whole backlog at
   * the instant the client sends its Terminate ('X') message — i.e. from inside `client.end()`.
   *
   * This exists to place a server-sent error in one specific window: after `close()` has detached
   * the subscription's `'error'` handler, but before the socket has finished closing. Left to
   * real timing, a `pg_terminate_backend`'s FATAL almost always lands *before* `close()` runs,
   * where the still-attached handler makes it harmless, so the dangerous ordering is not
   * reachable by racing alone.
   */
  holdServerMessagesUntilTerminate(): void
  /** How many server messages are currently parked by the call above. */
  heldCount(): number
  /** Resolves the first time a connection is stalled by either mode above. */
  stalled(): Promise<void>
  close(): Promise<void>
}

type ProxyMode = 'forward' | 'silent' | 'silent-after-handshake'

const QUERY_MESSAGE_TAG = 0x51 // 'Q' — the first byte of a simple-query protocol message
const TERMINATE_MESSAGE_TAG = 0x58 // 'X' — what pg writes from inside `client.end()`

async function startStallableProxy(target: URL): Promise<StallableProxy> {
  let mode: ProxyMode = 'forward'
  let holding = false
  const held: Buffer[] = []
  let onStall: () => void = (): void => {}
  const firstStall = new Promise<void>((resolve) => {
    onStall = resolve
  })
  const sockets = new Set<net.Socket>()

  const track = (socket: net.Socket): void => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  }

  const server = net.createServer((down: net.Socket): void => {
    track(down)
    if (mode === 'silent') {
      onStall()
      return
    }

    const up = net.createConnection({ host: target.hostname, port: Number(target.port) })
    track(up)
    let upClosed = false
    up.on('close', () => {
      upClosed = true
      // While holding, the whole point is that the client must not learn the server is gone until
      // it sends Terminate, so the downstream socket is left alive until the backlog is released.
      if (!holding) down.destroy()
    })
    down.on('close', () => up.destroy())

    let stalled = false
    down.on('data', (chunk: Buffer) => {
      if (stalled) return
      if (mode === 'silent-after-handshake' && chunk[0] === QUERY_MESSAGE_TAG) {
        stalled = true
        onStall()
        return
      }
      if (holding && chunk[0] === TERMINATE_MESSAGE_TAG) {
        holding = false
        for (const buffered of held) down.write(buffered)
        held.length = 0
        // The backend is already gone in this scenario, so nothing upstream will ever close the
        // downstream socket for us. Send the FIN ourselves, after the released bytes, so the
        // client's own `end()` completes instead of waiting on a peer that no longer exists.
        if (upClosed) {
          down.end()
          return
        }
      }
      if (up.writable) up.write(chunk)
    })
    up.on('data', (chunk: Buffer) => {
      if (stalled) return
      if (holding) held.push(chunk)
      else down.write(chunk)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('proxy did not bind to a TCP port')
  }

  return {
    port: address.port,
    goSilent: (): void => {
      mode = 'silent'
    },
    goSilentAfterHandshake: (): void => {
      mode = 'silent-after-handshake'
    },
    holdServerMessagesUntilTerminate: (): void => {
      holding = true
    },
    heldCount: (): number => held.length,
    stalled: (): Promise<void> => firstStall,
    close: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

let subscription: EventSubscription | null = null
let proxy: StallableProxy | null = null

afterEach(async (): Promise<void> => {
  // The proxy goes first: if a test left the subscription's reconnect loop parked inside a stalled
  // `open()`, destroying its socket is what lets that loop finish, so closing the proxy first keeps
  // this hook from inheriting the very hang the test was about.
  await proxy?.close()
  proxy = null
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
    'recovers when a second disconnect lands right after a reconnect settles',
    async () => {
      // Two kills back to back: the second lands while the first's reconnect loop may still be
      // inside its settlement window (`current` set, `reconnecting` not yet cleared). Before the
      // fix, a disconnect in that window was dropped and the subscription held a dead client.
      const seen: EventNotification[] = []
      subscription = await subscribeEvents(url(), (n) => seen.push(n))

      await killListeners()
      await killListeners() // no wait between them — the second must not be droppable

      // The subscription must still converge to a live LISTEN and deliver new events exactly once.
      await expect
        .poll(
          async () => {
            await notify(JSON.stringify({ seq: 41, workspaceId: 'w-race' }))
            return seen.some((n) => n.seq === 41)
          },
          { timeout: 10_000, interval: 500 },
        )
        .toBe(true)
      await wait(1_000)
      await notify(JSON.stringify({ seq: 42, workspaceId: 'w-race' }))
      await wait(1_000)
      expect(seen.filter((n) => n.seq === 42)).toHaveLength(1)
    },
    20_000,
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

  // `open()` can hang in two places, and only a bound on both makes `close()` — which awaits the
  // reconnect loop — bounded. Each case parks the loop in one of them and times `close()`.
  const stallCases = [
    {
      name: 'never speaks the protocol',
      phase: 'connect',
      stall: (p: StallableProxy): void => p.goSilent(),
    },
    {
      name: 'completes the handshake and then stalls the query',
      phase: 'LISTEN events',
      stall: (p: StallableProxy): void => p.goSilentAfterHandshake(),
    },
  ] as const

  const pidsForApp =
    'SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()'

  for (const stallCase of stallCases) {
    it(
      `close() stays bounded when a reconnect is stuck in ${stallCase.phase} against a server that ${stallCase.name}`,
      async () => {
        const target = new URL(url())
        const activeProxy = await startStallableProxy(target)
        proxy = activeProxy

        // `application_name` rides along in the connection string, which lets this test find and
        // kill exactly its own backend instead of every `LISTEN events` backend on the server.
        const appName = `task9-bounded-close-${process.pid}`
        const proxyUrl =
          `postgresql://${target.username}:${target.password}` +
          `@127.0.0.1:${activeProxy.port}${target.pathname}?application_name=${appName}`

        const probe = new Client({ connectionString: url() })
        await probe.connect()
        try {
          subscription = await subscribeEvents(proxyUrl, () => {})

          const before = await probe.query<{ pid: number }>(pidsForApp, [appName])
          expect(before.rows).toHaveLength(1)
          const own = before.rows[0]
          if (own === undefined) {
            throw new Error('expected the subscription to have exactly one backend behind the proxy')
          }

          // From here the proxy goes quiet. Killing the backend makes the subscription reconnect
          // straight into that dead end: nothing errors — TCP still connects, and in the second
          // case the handshake still completes — so `open()` simply never returns unless bounded.
          stallCase.stall(activeProxy)
          await probe.query('SELECT pg_terminate_backend($1)', [own.pid])

          // Wait for the loop to actually reach the stalled phase (plus a margin), so `close()`
          // lands inside the in-flight `open()` window rather than the retry delay the earlier
          // test covers.
          await activeProxy.stalled()
          await wait(150)

          const closeStarted = Date.now()
          await subscription.close()
          const closeElapsedMs = Date.now() - closeStarted
          subscription = null

          // The upper bound is the point of the test: unbounded, this never resolves at all (the
          // reviewer measured >8s still pending; a mutation run here hit the 30s test timeout).
          // Bounded, the loop's `open()` gives up ~2s after it stalled and `close()` follows it
          // out, so ~1.85s here — 6s leaves wide margin without being "forever".
          expect(closeElapsedMs).toBeLessThan(6_000)
          // The lower bound keeps the test honest about *which* window it is in: a `close()` that
          // resolved quickly would mean the loop was parked in its retry delay (already covered
          // above) rather than stuck inside `open()`, and the upper bound would then pass
          // vacuously.
          expect(closeElapsedMs).toBeGreaterThanOrEqual(1_000)

          // And the abandoned attempt leaves nothing behind. This bites in the second case, where
          // the handshake did reach the real server: pg does not close the socket when a query
          // times out, so a `Client` that is not explicitly ended keeps that backend alive.
          await expect
            .poll(
              async () => (await probe.query(pidsForApp, [appName])).rowCount ?? 0,
              { timeout: 3_000, interval: 50 },
            )
            .toBe(0)
        } finally {
          await probe.end()
        }
      },
      30_000,
    )
  }

  it(
    'close() survives a FATAL error that lands while the connection is being ended',
    async () => {
      const target = new URL(url())
      const activeProxy = await startStallableProxy(target)
      proxy = activeProxy

      const appName = `teardown-fatal-${process.pid}-${Date.now()}`
      const proxyUrl =
        `postgresql://${target.username}:${target.password}` +
        `@127.0.0.1:${activeProxy.port}${target.pathname}?application_name=${appName}`

      // A listener-less `Client` that emits `error` throws out of a socket callback, which is an
      // uncaught exception, not a rejected promise — so this is what has to be observed. Node
      // would take the whole process down with it if nothing were listening.
      const uncaught: unknown[] = []
      const onUncaught = (error: unknown): void => {
        uncaught.push(error)
      }
      process.on('uncaughtException', onUncaught)

      const probe = new Client({ connectionString: url() })
      await probe.connect()
      try {
        subscription = await subscribeEvents(proxyUrl, () => {})

        const before = await probe.query<{ pid: number }>(pidsForApp, [appName])
        expect(before.rows).toHaveLength(1)
        const own = before.rows[0]
        if (own === undefined) {
          throw new Error('expected the subscription to have exactly one backend behind the proxy')
        }

        // Park the server's side of the wire, then kill the backend. Postgres answers the kill
        // with a FATAL ErrorResponse ("terminating connection due to administrator command"),
        // which now sits in the proxy instead of reaching the subscription.
        activeProxy.holdServerMessagesUntilTerminate()
        await probe.query('SELECT pg_terminate_backend($1)', [own.pid])
        await expect
          .poll(() => activeProxy.heldCount(), { timeout: 5_000, interval: 25 })
          .toBeGreaterThan(0)

        // `close()` detaches every handler and calls `end()`; `end()` writes Terminate; the proxy
        // releases the FATAL on seeing it. The error therefore arrives in the one window where
        // the subscription's own `'error'` handler is already gone — the window a Postgres
        // restart or failover during an SSE disconnect lands in for real.
        await subscription.close()
        subscription = null
        await wait(200)

        // Without the no-op sink `close()` installs, this is
        // `Unhandled 'error' event ... terminating connection due to administrator command`,
        // thrown from pg's parser and fatal to the process — verified by removing the sink.
        expect(uncaught).toEqual([])

        // And the teardown still did its job: nothing is left connected.
        expect((await probe.query(pidsForApp, [appName])).rowCount ?? 0).toBe(0)
      } finally {
        process.off('uncaughtException', onUncaught)
        await probe.end()
      }
    },
    20_000,
  )
})
