import { prisma } from '@slave-of-ai/db/client'

/** The simulation page's live signal (M30 §6): a poll of the run's own `version` by primary key,
 *  emitted over SSE when it changes. Not the event log's stream -- the journal is a different
 *  table with no `pg_notify`, and a one-row read a second is honest and cheap. */
export async function createSimulationSse(options: { readonly simulationId: string; readonly pollMs?: number; readonly heartbeatMs?: number }): Promise<Response> {
  const pollMs = options.pollMs ?? 1000
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const select = { version: true, status: true, simTime: true } as const
  const first = await prisma.simulationRun.findUnique({ where: { id: options.simulationId }, select })
  if (first === null) return new Response('no such simulation', { status: 404 })
  const encoder = new TextEncoder()
  let lastEmitted: string | null = null
  let poll: ReturnType<typeof setInterval> | null = null
  let beat: ReturnType<typeof setInterval> | null = null
  let closed = false
  // Set inside start() (below) and called from cancel() too, so both paths -- an enqueue that
  // discovers the consumer is gone, and an explicit reader.cancel() -- converge on one place that
  // clears both intervals and closes the controller exactly once.
  let close: (() => void) | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Mirrors server/sse.ts's close(): a write can fail (the consumer went away) before
      // cancel() is ever observed, so every enqueue below routes a failure back here rather than
      // trusting `closed` alone -- `closed` guards against enqueuing after we already know the
      // stream is done, this guards against the enqueue itself being the thing that finds out.
      close = (): void => {
        if (closed) return
        closed = true
        if (poll !== null) clearInterval(poll)
        if (beat !== null) clearInterval(beat)
        try {
          controller.close()
        } catch {
          // already closed by the consumer
        }
      }
      // Fix wave, Important #1: keyed on the composite, not `version` alone -- `setStatus`,
      // `startAutoRun`, `stopAutoRun` and `haltUnparsed` change `status` (or `simTime`) without
      // ever bumping `version`, so an auto-run's error halt or a CLI pause/halt/stop-auto-run
      // would otherwise leave an open page stale until reload.
      const emit = (row: { version: number; status: string; simTime: number }): void => {
        const composite = `${row.version}|${row.status}|${row.simTime}`
        if (closed || composite === lastEmitted) return
        lastEmitted = composite
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(row)}\n\n`))
        } catch {
          close?.()
        }
      }
      emit(first)
      poll = setInterval((): void => {
        void prisma.simulationRun.findUnique({ where: { id: options.simulationId }, select }).then((row) => { if (row !== null) emit(row) }).catch(() => undefined)
      }, pollMs)
      poll.unref?.()
      beat = setInterval((): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          close?.()
        }
      }, heartbeatMs)
      beat.unref?.()
    },
    cancel() {
      close?.()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' } })
}
