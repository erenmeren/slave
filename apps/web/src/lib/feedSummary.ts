/**
 * The agent detail panel's live feed line, derived once and shared by both the snapshot side
 * (`server/overview.ts`, which reads `ExecutionEvent` rows out of Postgres) and the client hook
 * (`hooks/useOverview.ts`, which reads `StreamEvent`s off the SSE stream). Pure — no `prisma`
 * import — so the hook can import it without pulling `@ai-team-os/db` into the client bundle
 * (controller ruling R3).
 */

export interface AgentFeedEvent {
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
 * type's expected shape) → the bare type, so the feed never renders an empty line.
 */
export function feedSummary(type: string, payload: Record<string, unknown>): string {
  if (type === 'run.tool_call') {
    const summary = payload['summary']
    return typeof summary === 'string' ? summary : type
  }
  if (type === 'run.output') {
    const text = payload['text']
    return typeof text === 'string' ? text.slice(0, OUTPUT_SUMMARY_LENGTH) : type
  }
  return type
}
