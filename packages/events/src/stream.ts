import type { ExecutionEvent } from '@ai-team-os/domain'
import { readEventsSince } from './read.js'
import { subscribeEvents, type EventSubscription } from './subscribe.js'

export const DEFAULT_POLL_INTERVAL_MS = 5000

export interface EventStreamOptions {
  readonly connectionString: string
  readonly fromSeq: number
  readonly onEvent: (event: ExecutionEvent) => void
  readonly pollIntervalMs?: number
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
      const events = await readEventsSince(lastSeq)
      for (const event of events) {
        lastSeq = Math.max(lastSeq, event.seq)
        options.onEvent(event)
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
