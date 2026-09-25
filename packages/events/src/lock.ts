import { Client } from 'pg'

/**
 * A Postgres SESSION advisory lock, held on a connection of its own for as long as the holder lives
 * (H9b R4, F3).
 *
 * Here and not beside Prisma for `subscribe.ts`'s reason: a session lock belongs to ONE backend, and
 * Prisma's pool hands every query whichever connection is free, so a lock taken through it would be
 * held by a connection the next query may never see again -- and released only when the pool
 * happens to close it. This package already owns the one other long-lived dedicated connection the
 * system opens (the `LISTEN` subscription), so the second one lives beside it.
 *
 * The lock dies with the session, which is the property the daemon relies on: a daemon killed with
 * SIGKILL has its socket closed by the kernel, the backend sees the end of the stream, and the lock
 * is free for the next daemon without anybody releasing it.
 */
export interface SessionLock {
  /** Releases the lock and closes its connection. Idempotent; never throws. */
  release(): Promise<void>
}

export interface AcquireSessionLockOptions {
  /**
   * How long to keep trying before reporting the lock as held elsewhere. The default is a few
   * seconds, not zero: a daemon restarted by a supervisor starts while the backend of the one it
   * replaces may still be noticing that its client went away, and refusing in that window would
   * turn every quick restart into an outage.
   */
  readonly waitMs?: number
  /**
   * Called once if the connection holding the lock is lost -- the database restarted, the network
   * dropped. The lock went with the session, so the holder no longer has it; what to do about that
   * is the caller's decision.
   */
  readonly onLost?: (error: unknown) => void
}

/** The default of {@link AcquireSessionLockOptions.waitMs}. */
export const SESSION_LOCK_WAIT_MS = 5_000

const POLL_MS = 250
const CONNECT_TIMEOUT_MS = 5_000

/**
 * Takes `pg_try_advisory_lock(key)` on a new connection to `connectionString`, trying for up to
 * `waitMs`. Resolves the held lock, or `null` when another session holds it for the whole wait.
 * Rejects only when the database cannot be reached at all.
 *
 * Advisory locks are per DATABASE, which is exactly the scope the daemon needs: two daemons on two
 * databases on one server never meet here, two on one database always do.
 */
export async function acquireSessionLock(
  connectionString: string,
  key: bigint,
  options: AcquireSessionLockOptions = {},
): Promise<SessionLock | null> {
  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, keepAlive: true })
  let released = false
  let lostReported = false
  const lost = (error: unknown): void => {
    if (released || lostReported) return
    lostReported = true
    options.onLost?.(error)
  }
  // Attached before `connect()`: an error event with no listener is an uncaught exception, and a
  // connection that drops a day from now must reach `onLost`, not take the process down.
  client.on('error', lost)
  client.on('end', () => lost(new Error('the connection holding the lock ended')))

  await client.connect()
  const deadline = Date.now() + (options.waitMs ?? SESSION_LOCK_WAIT_MS)
  try {
    for (;;) {
      const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key.toString()])
      if (result.rows[0]?.locked === true) break
      if (Date.now() >= deadline) {
        released = true
        await client.end().catch(() => undefined)
        return null
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  } catch (error) {
    released = true
    await client.end().catch(() => undefined)
    throw error
  }

  return {
    release: async (): Promise<void> => {
      if (released) return
      released = true
      // Ending the session releases every lock it holds; the explicit unlock is only for a reader of
      // `pg_locks` who looks in the moment between the two.
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [key.toString()]).catch(() => undefined)
      await client.end().catch(() => undefined)
    },
  }
}
