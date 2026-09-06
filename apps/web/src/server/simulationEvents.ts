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
  let lastVersion = -1
  let poll: ReturnType<typeof setInterval> | null = null
  let beat: ReturnType<typeof setInterval> | null = null
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (row: { version: number; status: string; simTime: number }): void => {
        if (closed || row.version === lastVersion) return
        lastVersion = row.version
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(row)}\n\n`))
      }
      emit(first)
      poll = setInterval((): void => {
        void prisma.simulationRun.findUnique({ where: { id: options.simulationId }, select }).then((row) => { if (row !== null) emit(row) }).catch(() => undefined)
      }, pollMs)
      beat = setInterval((): void => { if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n')) }, heartbeatMs)
    },
    cancel() {
      closed = true
      if (poll !== null) clearInterval(poll)
      if (beat !== null) clearInterval(beat)
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' } })
}
