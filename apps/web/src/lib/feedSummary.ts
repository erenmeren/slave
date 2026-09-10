import { readableEventType } from './eventLabels'

/**
 * The slave detail panel's live feed line, derived once and shared by both the snapshot side
 * (`server/overview.ts`, which reads `ExecutionEvent` rows out of Postgres) and the client hook
 * (`hooks/useOverview.ts`, which reads `StreamEvent`s off the SSE stream). Pure — no `prisma`
 * import — so the hook can import it without pulling `@slave-of-ai/db` into the client bundle
 * (controller ruling R3).
 */

export interface SlaveFeedEvent {
  readonly seq: number
  readonly ts: string
  readonly type: string
  readonly summary: string
}

/** First 80 characters of `run.output`'s text; long output is a feed line, not a transcript. */
const OUTPUT_SUMMARY_LENGTH = 80

/**
 * One readable line per event type: `run.tool_call` → its payload summary; `run.output` → the
 * first 80 characters of its text; anything else (including a payload that doesn't match the
 * type's expected shape) → {@link readableEventType} of it, so the feed never renders an empty
 * line and never renders a database identifier either.
 *
 * That fallback USED to be the bare dotted type, which is what put `run.started` and
 * `task.created` in the Overview page's `live events` panel -- caught by
 * `gate:m44-ux-foundation`'s stage 4 (M44 R5/R8). The raw type rides on the row's own `title` at
 * the call site, the way every other R5 fix keeps its raw value.
 */
export function feedSummary(type: string, payload: Record<string, unknown>): string {
  if (type === 'run.tool_call') {
    const summary = payload['summary']
    return typeof summary === 'string' ? summary : readableEventType(type)
  }
  if (type === 'run.output') {
    const text = payload['text']
    return typeof text === 'string' ? text.slice(0, OUTPUT_SUMMARY_LENGTH) : readableEventType(type)
  }
  return readableEventType(type)
}
