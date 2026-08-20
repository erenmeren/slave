import { prisma } from '@ai-team-os/db/client'
import { createEventStream, type EventStreamHandle } from '@ai-team-os/events'

export const DEFAULT_HEARTBEAT_MS = 15_000

export interface EventSseOptions {
  readonly workspaceId: string
  /** Resume point (exclusive). null = "from now" (current max seq). */
  readonly fromSeq: number | null
  readonly connectionString: string
  /** For tests; default 15_000. */
  readonly heartbeatMs?: number
}

/** SSE response whose body streams this workspace's events. Closing the body releases the LISTEN. */
export async function createEventSse(options: EventSseOptions): Promise<Response> {
  // "From now": the current max seq, so a fresh page sees only what happens after it opened.
  // The snapshot it just fetched already carries the past.
  const fromSeq =
    options.fromSeq ??
    Number((await prisma.executionEvent.aggregate({ _max: { seq: true } }))._max.seq ?? 0n)

  let lastSeen = fromSeq
  let handle: EventStreamHandle | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      let closed = false
      const close = (): void => {
        if (closed) return
        closed = true
        if (heartbeat !== null) clearInterval(heartbeat)
        // Fire-and-forget: close() awaits in-flight delivery internally; the response stream is
        // already done with this connection either way.
        void handle?.close()
        try {
          controller.close()
        } catch {
          // already closed by the consumer
        }
      }

      // createEventStream's contract: onEvent must never throw, or the event is skipped forever.
      // A failed enqueue means the consumer is gone — close and let EventSource reconnect with
      // Last-Event-ID; the replay covers the gap (spec §4).
      handle = await createEventStream({
        connectionString: options.connectionString,
        fromSeq,
        onEvent: (event): void => {
          lastSeen = Math.max(lastSeen, event.seq)
          if (event.workspaceId !== options.workspaceId) return
          try {
            controller.enqueue(encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`))
          } catch {
            close()
          }
        },
        onError: (error): void => {
          console.error('[sse] event stream error:', error)
        },
      })

      // Id-only frame: updates the client's Last-Event-ID without dispatching an event, which is
      // what advances the watermark across filtered spans AND keeps proxies from reaping the
      // idle connection (spec §4).
      heartbeat = setInterval((): void => {
        try {
          controller.enqueue(encoder.encode(`id: ${lastSeen}\n\n`))
        } catch {
          close()
        }
      }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)
      heartbeat.unref?.()
    },
    cancel(): void {
      if (heartbeat !== null) clearInterval(heartbeat)
      void handle?.close()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}
