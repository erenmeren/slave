import { z } from 'zod'
import { estimateMessageCostUsd, streamModelPrice, type MessageTokens } from './pricing.js'

/**
 * A run's LIVE cost estimate, as `SlaveRun.costEstimate` holds it.
 *
 * ## Why it exists
 *
 * The runtime reports what a session cost on its terminal `result` line -- for a lead, when a TURN
 * ends, and a turn can run for an hour with every helper inside it. Until then `costUsd` is null
 * and a person watching sees nothing spent. This is the figure for that gap, built from the usage
 * each assistant message carries on the stream.
 *
 * ## The rule it lives under
 *
 * `./pricing.ts`'s: AN ESTIMATE IS NEVER WRITTEN OVER A REPORTED FIGURE AND NEVER ADDED INTO ONE.
 * It has its own column, no guardrail, budget or limit reads it, and every screen that shows it
 * says "about" and "estimate".
 *
 * ## What it measures, and what it cannot
 *
 * Each message is counted ONCE, by its id: the stream emits one line per content block and every
 * line repeats the message's usage, which is why a per-line sum of the cache counters doubles (the
 * 126,830 against 63,684 `packages/providers/src/claude/stream.ts` records). Input, cache read and
 * both cache-write tiers are exact per message. OUTPUT is not: a line's `output_tokens` is the
 * count at the START of the message (2 and 3 against a billed 741 on `complete.ndjson`), so output
 * is taken as the larger of that and what the message visibly wrote at
 * {@link OUTPUT_CHARS_PER_TOKEN}. Thinking the model does not show is on no line and is not
 * counted -- so the estimate is UNDER the reported figure by the hidden output, and rises to it.
 */
export interface RunCostEstimate {
  /** Everything: the session's own part and every helper's. */
  readonly usd: number
  /** The session's own messages (no parent call). */
  readonly own: number
  /** Each helper's part, by the id of the top-level call that started it. */
  readonly byCall: Readonly<Record<string, number>>
  /** Messages counted, each once. */
  readonly messages: number
  /** Messages whose model has no price: counted, and worth nothing in `usd`. */
  readonly unpricedMessages: number
  /** The estimate by model. */
  readonly models: Readonly<Record<string, number>>
  /** The models nothing here could price, by the name the stream gave. */
  readonly unpriced: readonly string[]
}

/** Characters of visible content per output token: the usual rough figure for English and code. */
export const OUTPUT_CHARS_PER_TOKEN = 4

const usd = z.number().finite().nonnegative()
const runCostEstimateSchema = z.object({
  usd,
  own: usd,
  byCall: z.record(usd),
  messages: z.number().int().nonnegative(),
  unpricedMessages: z.number().int().nonnegative(),
  models: z.record(usd),
  unpriced: z.array(z.string()).default([]),
})

/** The column's value, or null for anything that is not one (an empty column included). */
export function parseRunCostEstimate(value: unknown): RunCostEstimate | null {
  const parsed = runCostEstimateSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** One line's reading of one message, with the helper it belongs to already resolved. */
export interface LiveMessage extends MessageTokens {
  readonly id: string
  readonly model: string | null
  /** How much THIS line's content says; summed over the message's lines. */
  readonly contentChars: number
  /** The top-level call whose helper wrote it; null for the session's own. */
  readonly rootCallId: string | null
}

export interface LiveCostMeter {
  /** Count a line's message: a new id is added, a seen id is raised to the larger reading. */
  readonly add: (message: LiveMessage) => void
  /** What the column should hold now: the seed and everything added since. */
  readonly snapshot: () => RunCostEstimate
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6

/**
 * Accumulates one pump's messages on top of what the row already held.
 *
 * `seed` is the row's figure when the pump began -- a resumed run is a second pump on the same row,
 * and its estimate continues instead of starting over. A message id is new to each pump: a resumed
 * session writes new messages.
 */
export function createLiveCostMeter(seed: RunCostEstimate | null): LiveCostMeter {
  interface Seen { model: string | null; root: string | null; input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; chars: number }
  const seen = new Map<string, Seen>()
  return {
    add(message) {
      const found = seen.get(message.id)
      if (found === undefined) {
        seen.set(message.id, { model: message.model, root: message.rootCallId, input: message.input, output: message.output, cacheRead: message.cacheRead, cacheWrite5m: message.cacheWrite5m, cacheWrite1h: message.cacheWrite1h, chars: message.contentChars })
        return
      }
      // The same message on a later line: its counters are the same request's, so the larger
      // reading stands (output grows), and only what the line SAYS is new.
      found.input = Math.max(found.input, message.input)
      found.output = Math.max(found.output, message.output)
      found.cacheRead = Math.max(found.cacheRead, message.cacheRead)
      found.cacheWrite5m = Math.max(found.cacheWrite5m, message.cacheWrite5m)
      found.cacheWrite1h = Math.max(found.cacheWrite1h, message.cacheWrite1h)
      found.chars += message.contentChars
      found.model ??= message.model
    },
    snapshot() {
      let own = seed?.own ?? 0
      let unpricedMessages = seed?.unpricedMessages ?? 0
      const byCall = new Map(Object.entries(seed?.byCall ?? {}))
      const models = new Map(Object.entries(seed?.models ?? {}))
      const unpriced = new Set(seed?.unpriced ?? [])
      for (const message of seen.values()) {
        const output = Math.max(message.output, Math.ceil(message.chars / OUTPUT_CHARS_PER_TOKEN))
        const cost = estimateMessageCostUsd(message.model, { ...message, output })
        if (cost === null) {
          unpricedMessages += 1
          unpriced.add(message.model ?? 'unknown')
          continue
        }
        const model = streamModelPrice(message.model)?.id ?? 'unknown'
        models.set(model, (models.get(model) ?? 0) + cost)
        if (message.root === null) own += cost
        else byCall.set(message.root, (byCall.get(message.root) ?? 0) + cost)
      }
      const calls = Object.fromEntries([...byCall].map(([id, value]) => [id, round(value)]))
      return {
        usd: round(own + [...byCall.values()].reduce((total, value) => total + value, 0)),
        own: round(own),
        byCall: calls,
        messages: (seed?.messages ?? 0) + seen.size,
        unpricedMessages,
        models: Object.fromEntries([...models].map(([id, value]) => [id, round(value)])),
        unpriced: [...unpriced].sort(),
      }
    },
  }
}

/**
 * Which top-level call a helper's line belongs to.
 *
 * A helper's lines carry the id of the call that started ITS session as their parent; a helper of a
 * helper carries the inner call's id, and counts for the helper the session itself started
 * (`projectPeople`'s rule, so the two agree). Fed every tool call in order; a parent nobody saw is
 * its own root, so its cost is still kept under a name.
 */
export interface CallRoots {
  readonly call: (toolUseId: string, parentToolUseId: string | null) => void
  readonly rootOf: (parentToolUseId: string | null) => string | null
}

export function createCallRoots(): CallRoots {
  const roots = new Map<string, string>()
  return {
    call(toolUseId, parentToolUseId) {
      if (parentToolUseId !== null) roots.set(toolUseId, roots.get(parentToolUseId) ?? parentToolUseId)
    },
    rootOf(parentToolUseId) {
      return parentToolUseId === null ? null : (roots.get(parentToolUseId) ?? parentToolUseId)
    },
  }
}
