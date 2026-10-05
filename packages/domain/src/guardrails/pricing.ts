/**
 * A FALLBACK-ONLY per-model price table (M51 R5, plan erratum E1).
 *
 * ## What this is for, and the one rule that governs it
 *
 * `SlaveRun.costUsd` is what a provider REPORTED, and it is the only figure any guardrail believes
 * (`packages/control/src/spend.ts`'s `workspaceSpend`, unchanged by this milestone). This table
 * exists for the OTHER case: a run that left tokens behind and no cost -- a Cursor run, a degraded
 * Claude `result` line, a run still in flight -- where a person looking at the project deserves an
 * order-of-magnitude answer rather than a dash.
 *
 * **The estimate may never overwrite a reported figure.** Every caller checks `costUsd !== null`
 * first ({@link costProvenanceOf} in `./spend.ts` is that check, written once). The cost of getting
 * this wrong is the failure mode this table is copied from: one harness priced every model at its
 * Sonnet rate, which undercosted Opus work by roughly five times, and because the wrong number
 * overwrote the right one nobody could tell.
 *
 * It lives in `packages/domain` and not in `packages/providers` (erratum E1): three of its four
 * consumers are in `apps/web`, which does not depend on the providers package at all -- that
 * package's entry re-exports `claude/adapter.ts`, which imports `node:child_process`, so a client
 * component touching it would fail at bundle time. Pure data and one pure arithmetic function have
 * no business behind that door. The alias table is spelled out below rather than imported from
 * `CLAUDE_CODE_MODELS` for exactly the same reason.
 *
 * ## Provenance of the numbers
 *
 * List prices per MILLION tokens for the Anthropic first-party API, as published at the pin date
 * 2026-06-24. They are pinned BY HAND, the way `packages/providers/src/models.ts`'s
 * `CLAUDE_CODE_MODELS` is pinned by hand, and they are updated with it -- `source: 'static'` is the
 * honest word for both. Cache-tier rates are deliberately NOT modelled by {@link estimateCostUsd}:
 * see the billed-input note below. {@link estimateMessageCostUsd}, at the foot of this file, is the
 * one function that models them, for a single message whose counters are known apart.
 *
 * ## Which token figure this multiplies, said out loud
 *
 * `RunOutcome.tokens.input` folds `input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens` together, deliberately, FOR COST
 * (`packages/providers/src/types.ts:53-63`) -- and that is the figure this function is fed. A token
 * BUDGET would want the opposite: cache READ re-bills a fixed context on every request, so counting
 * it turns a token cap into a session-length timer. Both readings are right and they answer
 * different questions; M51 estimates COST, so it uses the folded figure, and applying one blended
 * rate to it slightly OVER-states a heavily-cached run (cache reads bill at a fraction of fresh
 * input). Over-stating an estimate that no guardrail reads is the safe direction, and it is named
 * here rather than left for a reader to discover.
 */
export interface ModelPrice {
  readonly inputPerMTok: number
  readonly outputPerMTok: number
}

/** Keyed by the FULL model id the CLI accepts. Aliases resolve through {@link PRICE_ALIASES}. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
}

/**
 * The CLI's family aliases (`claude --help`, mirrored by `CLAUDE_CODE_MODELS`), resolved to the
 * model each one currently names.
 *
 * `default` is deliberately ABSENT. Which model the CLI picks when no `--model` is passed is the
 * CLI's own current choice and is not knowable from inside this repository; guessing it here would
 * put a confident wrong price on the majority of runs, since `default` is exactly what a workspace
 * that never chose a model records. An unpriced id estimates `null`, which is the true answer.
 */
export const PRICE_ALIASES: Readonly<Record<string, string>> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
}

/**
 * The id {@link MODEL_PRICES} is keyed by, from whatever was stored on the run.
 *
 * Two normalisations, both measured rather than assumed. A trailing bracketed suffix is a CONTEXT
 * WINDOW variant, not a different model: the fixture's own `result` line reports
 * `modelUsage: { "claude-opus-5[1m]": { canonicalModel: "claude-opus-5", ... } }`, so the family
 * price is the right price for it. An alias is resolved after the suffix is stripped, so
 * `opus[1m]` works too, and the remainder is trimmed again so `claude-opus-5 [1m]` prices as well.
 * A string that is nothing but a suffix is `null`, the same answer an empty model gets.
 */
export function normaliseModelId(model: string | null): string | null {
  if (model === null) return null
  const trimmed = model.trim()
  if (trimmed === '') return null
  const bracket = trimmed.indexOf('[')
  // Trimmed AGAIN after the slice, not only before it: `'claude-opus-5 [1m]'` is a shape a person
  // can type into a model column, and `'claude-opus-5 '` matches neither table -- a model that is
  // in the table would have priced `null` for a space.
  const base = (bracket === -1 ? trimmed : trimmed.slice(0, bracket)).trim()
  if (base === '') return null
  return PRICE_ALIASES[base] ?? base
}

/**
 * What this many tokens would have cost on this model, or `null` when that cannot be said.
 *
 * `null` in three cases and never `0` for any of them, for `SlaveRun.costUsd`'s own reason: a zero
 * is a figure a reader believes. Unknown model, unpriced model, unmeasured tokens -- all `null`. A
 * PRICED model that really used no tokens estimates `0`, which is a measurement (decision D3).
 */
export function estimateCostUsd(
  model: string | null,
  tokens: { readonly input: number; readonly output: number } | null,
): number | null {
  if (tokens === null) return null
  const id = normaliseModelId(model)
  if (id === null) return null
  const price = MODEL_PRICES[id]
  if (price === undefined) return null
  if (!Number.isFinite(tokens.input) || !Number.isFinite(tokens.output)) return null
  return (tokens.input * price.inputPerMTok + tokens.output * price.outputPerMTok) / 1_000_000
}

/**
 * Prices for models a session's own STREAM names that {@link MODEL_PRICES} does not carry (live
 * cost estimate).
 *
 * A separate table on purpose. `MODEL_PRICES` is pinned to the roster a person can pick from
 * (`packages/providers/test/models.test.ts` holds the two together), and what the CLI actually runs
 * when nobody picked is its own choice: MEASURED 2026-10-05, a lead session started with no model
 * wrote `"model": "claude-opus-5-5"` on every assistant line, an id the roster does not offer. An
 * estimate that prices by what the stream SAYS needs that id priced; the roster does not need it
 * selectable.
 *
 * Anthropic first-party list prices per MILLION tokens, as published at the pin date 2026-09-25,
 * pinned by hand like the table above.
 */
export const STREAM_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
}

/**
 * The cache tiers, as multiples of a model's input price.
 *
 * MEASURED, not read off a page: `packages/providers/test/fixtures/complete.ndjson`'s result line
 * reports, for claude-opus-5, input 4, output 741, cache read 46,948 and a one-hour cache write of
 * 16,732 at a cost of 0.209339 -- which is input x $5/M + output x $25/M + read x 0.1 x $5/M +
 * write x 2 x $5/M to the last digit. The five-minute write tier is the published 1.25.
 */
export const CACHE_READ_MULTIPLIER = 0.1
export const CACHE_WRITE_5M_MULTIPLIER = 1.25
export const CACHE_WRITE_1H_MULTIPLIER = 2

/**
 * Models whose cache READ price is not {@link CACHE_READ_MULTIPLIER} of their input price, per
 * million tokens (published at the pin date 2026-09-25).
 */
export const CACHE_READ_PER_MTOK: Readonly<Record<string, number>> = {
  'claude-fable-5-1': 0.25,
  'claude-opus-5-5': 0.2,
}

/** One message's five token counters, as its stream line reports them. */
export interface MessageTokens {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite5m: number
  readonly cacheWrite1h: number
}

/** The price row a stream's model id names, or null: suffix and alias resolved, then a dated snapshot's date dropped. */
export function streamModelPrice(model: string | null): { readonly id: string; readonly price: ModelPrice } | null {
  const id = normaliseModelId(model)
  if (id === null) return null
  for (const candidate of [id, id.replace(/-\d{8}$/, '')]) {
    const price = MODEL_PRICES[candidate] ?? STREAM_MODEL_PRICES[candidate]
    if (price !== undefined) return { id: candidate, price }
  }
  return null
}

/**
 * What ONE message would cost on this model, cache tiers included, or `null` when the model has no
 * price (live cost estimate).
 *
 * `null` and never a guess, for the reason {@link estimateCostUsd} gives: a figure is believed. A
 * caller counts such a message as unpriced and says so.
 *
 * AN ESTIMATE, under the rule at the top of this file: it is shown beside a reported figure and is
 * never written over one or added into one. No guardrail, budget or limit reads it.
 */
export function estimateMessageCostUsd(model: string | null, tokens: MessageTokens): number | null {
  const found = streamModelPrice(model)
  if (found === null) return null
  const counters = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite5m, tokens.cacheWrite1h]
  if (counters.some((value) => !Number.isFinite(value) || value < 0)) return null
  const { inputPerMTok, outputPerMTok } = found.price
  const readPerMTok = CACHE_READ_PER_MTOK[found.id] ?? inputPerMTok * CACHE_READ_MULTIPLIER
  return (
    (tokens.input * inputPerMTok +
      tokens.output * outputPerMTok +
      tokens.cacheRead * readPerMTok +
      tokens.cacheWrite5m * inputPerMTok * CACHE_WRITE_5M_MULTIPLIER +
      tokens.cacheWrite1h * inputPerMTok * CACHE_WRITE_1H_MULTIPLIER) /
    1_000_000
  )
}
