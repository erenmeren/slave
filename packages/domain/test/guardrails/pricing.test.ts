import { describe, expect, it } from 'vitest'
import { MODEL_PRICES, PRICE_ALIASES, STREAM_MODEL_PRICES, estimateCostUsd, estimateMessageCostUsd, normaliseModelId, streamModelPrice } from '../../src/guardrails/pricing.js'

describe('normaliseModelId', () => {
  it('strips a context-window suffix -- the CLI reports `claude-opus-5[1m]` and prices the family', () => {
    // MEASURED: `packages/providers/test/fixtures/complete.ndjson`'s result line carries
    // `modelUsage: { "claude-opus-5[1m]": { canonicalModel: "claude-opus-5", ... } }`.
    expect(normaliseModelId('claude-opus-5[1m]')).toBe('claude-opus-5')
  })

  it('trims AFTER the strip, so a space before the bracket does not cost the price', () => {
    // `'claude-opus-5 [1m]'` used to slice to `'claude-opus-5 '`, which misses both tables and
    // prices `null` -- a model that is right there in the table reading as unmeasured.
    expect(normaliseModelId('claude-opus-5 [1m]')).toBe('claude-opus-5')
    expect(normaliseModelId('  opus [1m]  ')).toBe('claude-opus-5')
    expect(estimateCostUsd('claude-opus-5 [1m]', { input: 1_000_000, output: 0 })).toBeCloseTo(5, 10)
  })

  it('is null for a model that is nothing but a bracketed suffix', () => {
    expect(normaliseModelId('[1m]')).toBeNull()
    expect(normaliseModelId('   [1m]')).toBeNull()
  })

  it('resolves the CLI aliases a person may have typed into a model column', () => {
    expect(normaliseModelId('opus')).toBe('claude-opus-5')
    expect(normaliseModelId('sonnet')).toBe('claude-sonnet-5')
    expect(normaliseModelId('haiku')).toBe('claude-haiku-4-5')
    expect(normaliseModelId('fable')).toBe('claude-fable-5-1')
  })

  it('leaves `default` alone -- which family the CLI picks is not knowable from here', () => {
    expect(normaliseModelId('default')).toBe('default')
    expect(MODEL_PRICES['default']).toBeUndefined()
  })

  it('is null for a null or empty model', () => {
    expect(normaliseModelId(null)).toBeNull()
    expect(normaliseModelId('')).toBeNull()
  })
})

describe('estimateCostUsd', () => {
  it('prices a million in and a million out at the table rate', () => {
    expect(estimateCostUsd('claude-opus-5', { input: 1_000_000, output: 1_000_000 })).toBeCloseTo(30, 10)
  })

  it('prices each family differently -- one rate for every model was munder-difflin cost bug #1', () => {
    const million = { input: 1_000_000, output: 0 }
    expect(estimateCostUsd('claude-opus-5', million)).toBeCloseTo(5, 10)
    expect(estimateCostUsd('claude-sonnet-5', million)).toBeCloseTo(2, 10)
    expect(estimateCostUsd('claude-haiku-4-5', million)).toBeCloseTo(1, 10)
    expect(estimateCostUsd('claude-fable-5-1', million)).toBeCloseTo(10, 10)
  })

  it('is null for an unpriced id, a null model and a null token reading -- never 0', () => {
    expect(estimateCostUsd('default', { input: 10, output: 10 })).toBeNull()
    expect(estimateCostUsd('gpt-does-not-exist', { input: 10, output: 10 })).toBeNull()
    expect(estimateCostUsd(null, { input: 10, output: 10 })).toBeNull()
    expect(estimateCostUsd('claude-opus-5', null)).toBeNull()
  })

  it('is a measured zero for a priced model that used no tokens', () => {
    expect(estimateCostUsd('claude-opus-5', { input: 0, output: 0 })).toBe(0)
  })

  it('every alias resolves to a priced id, so an alias can never be silently unpriced', () => {
    for (const [alias, id] of Object.entries(PRICE_ALIASES)) {
      expect(MODEL_PRICES[id], `${alias} -> ${id}`).toBeDefined()
    }
  })
})

describe('estimateMessageCostUsd (live cost)', () => {
  const none = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }

  it('reproduces a recorded result line to the last digit, cache tiers included', () => {
    // MEASURED: `packages/providers/test/fixtures/complete.ndjson`'s result line, `modelUsage` for
    // claude-opus-5[1m] -- these counters, `costUSD: 0.20933900000000003`.
    expect(estimateMessageCostUsd('claude-opus-5[1m]', { input: 4, output: 741, cacheRead: 46_948, cacheWrite5m: 0, cacheWrite1h: 16_732 })).toBeCloseTo(0.209339, 9)
  })

  it('prices each tier apart: read a tenth of input, a 5-minute write 1.25x, a 1-hour write 2x', () => {
    const million = 1_000_000
    expect(estimateMessageCostUsd('claude-opus-5', { ...none, input: million })).toBeCloseTo(5, 10)
    expect(estimateMessageCostUsd('claude-opus-5', { ...none, output: million })).toBeCloseTo(25, 10)
    expect(estimateMessageCostUsd('claude-opus-5', { ...none, cacheRead: million })).toBeCloseTo(0.5, 10)
    expect(estimateMessageCostUsd('claude-opus-5', { ...none, cacheWrite5m: million })).toBeCloseTo(6.25, 10)
    expect(estimateMessageCostUsd('claude-opus-5', { ...none, cacheWrite1h: million })).toBeCloseTo(10, 10)
  })

  it('prices a model the stream names that the roster does not offer, with its own cache-read price', () => {
    // MEASURED 2026-10-05: a lead session with no model picked wrote `claude-opus-5-5` on its lines.
    expect(MODEL_PRICES['claude-opus-5-5']).toBeUndefined()
    expect(STREAM_MODEL_PRICES['claude-opus-5-5']).toEqual({ inputPerMTok: 4, outputPerMTok: 20 })
    expect(estimateMessageCostUsd('claude-opus-5-5', { ...none, input: 1_000_000 })).toBeCloseTo(4, 10)
    expect(estimateMessageCostUsd('claude-opus-5-5', { ...none, cacheRead: 1_000_000 })).toBeCloseTo(0.2, 10)
    expect(estimateMessageCostUsd('claude-fable-5-1', { ...none, cacheRead: 1_000_000 })).toBeCloseTo(0.25, 10)
  })

  it('drops a dated snapshot\u2019s date, and only when the dated id itself has no price', () => {
    expect(streamModelPrice('claude-haiku-4-5-20251001')?.id).toBe('claude-haiku-4-5')
    expect(streamModelPrice('claude-opus-5[1m]')?.id).toBe('claude-opus-5')
  })

  it('is null for a model with no price, a null model and a broken counter -- never a guess', () => {
    expect(estimateMessageCostUsd('some-model-nobody-priced', { ...none, input: 10 })).toBeNull()
    expect(estimateMessageCostUsd('default', { ...none, input: 10 })).toBeNull()
    expect(estimateMessageCostUsd(null, { ...none, input: 10 })).toBeNull()
    expect(estimateMessageCostUsd('claude-opus-5', { ...none, input: Number.NaN })).toBeNull()
    expect(estimateMessageCostUsd('claude-opus-5', { ...none, output: -1 })).toBeNull()
  })

  it('is a measured zero for a priced model that used nothing', () => {
    expect(estimateMessageCostUsd('claude-opus-5', none)).toBe(0)
  })
})
