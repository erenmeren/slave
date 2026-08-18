import type { ExecutionEvent } from '@ai-team-os/domain'
import { readEventsSince } from './read.js'
import { subscribeEvents, type EventSubscription } from './subscribe.js'

export const DEFAULT_POLL_INTERVAL_MS = 5000

export interface EventStreamOptions {
  readonly connectionString: string
  readonly fromSeq: number
  readonly onEvent: (event: ExecutionEvent) => void
  readonly pollIntervalMs?: number
  /**
   * Called with whatever a failed catch-up read threw (an unparseable row, a transient database
   * error, ...). Without one, the error is dropped and the stream keeps polling — dropping is
   * bad, but leaving the caller unable to observe stream failure at all is worse, and letting a
   * rejection escape the internal chain is worse still (see the comment on `running` below).
   */
  readonly onError?: (error: unknown) => void
}

export interface EventStreamHandle {
  close(): Promise<void>
}

/**
 * Notification-driven with a slow poll behind it. The poll exists only for the case of a dropped
 * notification followed by silence; its interval is deliberately far above M6's one-second
 * requirement so it cannot become the mechanism the system relies on.
 */
export async function createEventStream(options: EventStreamOptions): Promise<EventStreamHandle> {
  let lastSeq = options.fromSeq
  let closed = false
  let running: Promise<void> = Promise.resolve()

  const catchUp = (): Promise<void> => {
    running = running.then(async (): Promise<void> => {
      if (closed) return
      // A failed read must not poison `running`. `running` is a chain every future notification
      // and poll tick appends to, and `close()` awaits it: if a rejection were allowed to
      // propagate, every later `catchUp()` would inherit an already-rejected promise and never
      // run again (silently disabling the fallback poll at exactly the moment it is needed most),
      // each `void catchUp()` call site would mint a fresh unhandled rejection, and `close()`
      // itself would reject and throw out of the caller's teardown. Catching here keeps the chain
      // permanently resolved so the next tick always gets a fair attempt, and routes the failure
      // to `onError` instead of losing it.
      try {
        const events = await readEventsSince(lastSeq)
        for (const event of events) {
          // Safe only under the single-writer rule: `seq` is assigned at INSERT but a row is
          // visible only at COMMIT, so a lower-`seq` transaction that commits after a higher-`seq`
          // one would be skipped forever by `seq > lastSeq`. That can only happen with concurrent
          // writers; `appendEvent` is the only write path and the orchestrator writes serially, so
          // commit order matches `seq` order. See design spec
          // packages/domain/src/docs/superpowers/specs/2026-08-18-m2-persistence-and-events-design.md
          // §6.4, and the parent spec's single-writer rule at §3.1. This assumption is silent and
          // load-bearing — a second writer breaks it with no error and no failing test.
          //
          // Deliberately advance *before* delivering, not after. Both orderings lose something:
          // advance-then-deliver permanently skips an event whose `onEvent` throws (an SSE
          // `res.write` onto a half-closed socket is the realistic case), while
          // deliver-then-advance re-delivers that event on every subsequent notification and poll
          // tick, forever, against a consumer that is permanently failing. A stuck stream that
          // never makes progress is the worse failure, and the consumer — not this layer — is the
          // only party that can know whether its own write failure is retryable, so the skip is
          // the cost we accept. A consumer that cannot afford to lose an event must not throw out
          // of `onEvent`; it should catch, and resume from its own last-delivered `seq`.
          lastSeq = Math.max(lastSeq, event.seq)
          options.onEvent(event)
        }
      } catch (error) {
        options.onError?.(error)
      }
    })
    return running
  }

  const subscription: EventSubscription = await subscribeEvents(options.connectionString, () => {
    void catchUp()
  })

  const timer = setInterval(() => void catchUp(), options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  timer.unref()

  await catchUp()

  return {
    async close(): Promise<void> {
      closed = true
      clearInterval(timer)
      await subscription.close()
      await running
    },
  }
}
