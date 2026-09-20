/**
 * The bookkeeping every detached-model-call tick does, written once (task 4 fix round 1, I3).
 *
 * `tickIntakes` and `tickSupervisorChat` both start a model call they do NOT await -- the pass that
 * starts a call is not the pass that finishes it -- and both therefore need the same four things:
 * a set of what this process is carrying, how much room is left under the concurrency cap, a way
 * to register a started call, and a drain the daemon awaits at shutdown. The two had that block
 * copied verbatim, down to its comments, which is how a fix made in one of them silently is not
 * made in the other.
 *
 * ONE SET PER TICK, not one shared by all of them: `detachedCalls()` is called once at each tick
 * module's top level and the closure is that tick's own. Two ticks sharing a set would make the
 * intake's concurrency cap count the chat's calls, and a chat drain wait for an intake reply.
 *
 * WHY A MODULE-LEVEL CALL AND NOT AN INSTANCE THREADED THROUGH: it is the daemon PROCESS's set. It
 * must survive from one pass to the next, and there is exactly one daemon per process. Two daemons
 * keep their own sets and cannot see each other's; that is not a hole, because the CLAIM in the
 * database is what keeps two daemons off the same row, and the set only saves THIS process from
 * paying twice for a row its own TTL reclaim handed back to it.
 *
 * `simulation/auto-run.ts` keeps its own copy for now (parked): its set is keyed differently and
 * folding it in is a change to the simulation's concurrency, not a de-duplication.
 */
export interface DetachedCalls {
  /** What this process has started and not yet recorded. A COPY, so a caller cannot mutate the
   *  set the tick reasons about. */
  inFlight: () => ReadonlySet<string>
  /** Whether this id is already being carried -- the check that stops one process paying twice
   *  when a TTL reclaim races its own call still in flight. */
  has: (id: string) => boolean
  /** How many more calls may be started under `max`, floored at zero. */
  room: (max: number) => number
  /**
   * Registers a started call. The promise MUST NOT reject -- every caller's whole body is caught,
   * because a rejection stored here would become an unhandled rejection at drain time -- and the
   * id is removed from the set when it settles, whichever way it settles.
   */
  start: (id: string, settled: Promise<void>) => void
  /** Waits for every detached call to finish RECORDING. The daemon awaits this on shutdown:
   *  recording is a database write for a call the account has already been billed for, so
   *  disconnecting Prisma out from under one would lose exactly the row that must not be lost.
   *  Loops rather than awaiting once, because a call can be started while the drain is waiting. */
  drain: () => Promise<void>
}

export function detachedCalls(): DetachedCalls {
  const inFlight = new Map<string, Promise<void>>()
  return {
    inFlight: (): ReadonlySet<string> => new Set(inFlight.keys()),
    has: (id): boolean => inFlight.has(id),
    room: (max): number => Math.max(0, max - inFlight.size),
    start: (id, settled): void => {
      inFlight.set(
        id,
        settled.finally((): void => {
          inFlight.delete(id)
        }),
      )
    },
    drain: async (): Promise<void> => {
      while (inFlight.size > 0) await Promise.all([...inFlight.values()])
    },
  }
}
