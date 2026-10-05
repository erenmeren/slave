import { describe, expect, it } from 'vitest'
import { OUTPUT_CHARS_PER_TOKEN, createCallRoots, createLiveCostMeter, parseRunCostEstimate, type LiveMessage } from '../../src/guardrails/liveCost.js'

const message = (over: Partial<LiveMessage> & { readonly id: string }): LiveMessage => ({ model: 'claude-opus-5', input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, contentChars: 0, rootCallId: null, ...over })

describe('createLiveCostMeter', () => {
  it('counts a message once however many lines repeat it, and raises its output to the larger reading', () => {
    const meter = createLiveCostMeter(null)
    // One message on three lines: the same input and cache counters each time, output growing.
    meter.add(message({ id: 'msg_1', input: 1_000_000, cacheRead: 1_000_000, output: 2 }))
    meter.add(message({ id: 'msg_1', input: 1_000_000, cacheRead: 1_000_000, output: 400_000 }))
    meter.add(message({ id: 'msg_1', input: 1_000_000, cacheRead: 1_000_000, output: 100 }))
    const estimate = meter.snapshot()
    expect(estimate.messages).toBe(1)
    // 5 (input) + 0.5 (cache read) + 400,000 x 25 / 1M = 10 (output), not three times the input.
    expect(estimate.usd).toBeCloseTo(15.5, 6)
    expect(estimate.own).toBeCloseTo(15.5, 6)
  })

  it('takes output as what the message visibly wrote when its lines report less', () => {
    const meter = createLiveCostMeter(null)
    // Two lines, two content blocks: the characters add up, the token counter does not.
    meter.add(message({ id: 'msg_1', output: 2, contentChars: 2_000_000 }))
    meter.add(message({ id: 'msg_1', output: 2, contentChars: 2_000_000 }))
    expect(meter.snapshot().usd).toBeCloseTo((4_000_000 / OUTPUT_CHARS_PER_TOKEN) * 25 / 1_000_000, 6)
  })

  it('keeps each helper’s part by the call that started it, apart from the session’s own', () => {
    const meter = createLiveCostMeter(null)
    meter.add(message({ id: 'lead-1', input: 1_000_000 }))
    meter.add(message({ id: 'helper-a-1', input: 2_000_000, rootCallId: 'toolu_a' }))
    meter.add(message({ id: 'helper-a-2', input: 1_000_000, rootCallId: 'toolu_a' }))
    meter.add(message({ id: 'helper-b-1', model: 'claude-haiku-4-5', input: 1_000_000, rootCallId: 'toolu_b' }))
    const estimate = meter.snapshot()
    expect(estimate.own).toBeCloseTo(5, 6)
    expect(estimate.byCall).toEqual({ toolu_a: 15, toolu_b: 1 })
    expect(estimate.usd).toBeCloseTo(21, 6)
    expect(estimate.models).toEqual({ 'claude-opus-5': 20, 'claude-haiku-4-5': 1 })
    expect(estimate.messages).toBe(4)
  })

  it('counts a message of an unpriced model and names the model, without a figure for it', () => {
    const meter = createLiveCostMeter(null)
    meter.add(message({ id: 'a', model: 'some-model-nobody-priced', input: 1_000_000 }))
    meter.add(message({ id: 'b', model: null, input: 1_000_000 }))
    meter.add(message({ id: 'c', input: 1_000_000 }))
    const estimate = meter.snapshot()
    expect(estimate.usd).toBeCloseTo(5, 6)
    expect(estimate.messages).toBe(3)
    expect(estimate.unpricedMessages).toBe(2)
    expect(estimate.unpriced).toEqual(['some-model-nobody-priced', 'unknown'])
  })

  it('continues from what the row held: a resumed run adds to its first half', () => {
    const first = createLiveCostMeter(null)
    first.add(message({ id: 'lead-1', input: 1_000_000 }))
    first.add(message({ id: 'helper-1', input: 1_000_000, rootCallId: 'toolu_a' }))
    const held = first.snapshot()

    const second = createLiveCostMeter(held)
    expect(second.snapshot()).toEqual(held)
    second.add(message({ id: 'lead-2', input: 1_000_000 }))
    second.add(message({ id: 'helper-2', input: 1_000_000, rootCallId: 'toolu_a' }))
    second.add(message({ id: 'helper-3', input: 1_000_000, rootCallId: 'toolu_b' }))
    const estimate = second.snapshot()
    expect(estimate.own).toBeCloseTo(10, 6)
    expect(estimate.byCall).toEqual({ toolu_a: 10, toolu_b: 5 })
    expect(estimate.usd).toBeCloseTo(25, 6)
    expect(estimate.messages).toBe(5)
  })

  it('is all zeroes before anything was seen', () => {
    expect(createLiveCostMeter(null).snapshot()).toEqual({ usd: 0, own: 0, byCall: {}, messages: 0, unpricedMessages: 0, models: {}, unpriced: [] })
  })
})

describe('parseRunCostEstimate', () => {
  it('reads back what a meter wrote', () => {
    const meter = createLiveCostMeter(null)
    meter.add(message({ id: 'a', input: 1_000_000, rootCallId: 'toolu_a' }))
    const written: unknown = JSON.parse(JSON.stringify(meter.snapshot()))
    expect(parseRunCostEstimate(written)).toEqual(meter.snapshot())
  })

  it('is null for an empty column and for anything that is not an estimate', () => {
    expect(parseRunCostEstimate(null)).toBeNull()
    expect(parseRunCostEstimate(undefined)).toBeNull()
    expect(parseRunCostEstimate({ usd: 'much' })).toBeNull()
    expect(parseRunCostEstimate({ usd: -1, own: 0, byCall: {}, messages: 0, unpricedMessages: 0, models: {} })).toBeNull()
  })
})

describe('createCallRoots', () => {
  it('names the top-level call for a helper\u2019s line, and for a helper of a helper', () => {
    const roots = createCallRoots()
    roots.call('toolu_top', null)
    roots.call('toolu_step', 'toolu_top')
    roots.call('toolu_inner', 'toolu_top')
    roots.call('toolu_inner_step', 'toolu_inner')
    roots.call('toolu_deepest', 'toolu_inner_step')
    expect(roots.rootOf(null)).toBeNull()
    expect(roots.rootOf('toolu_top')).toBe('toolu_top')
    expect(roots.rootOf('toolu_inner')).toBe('toolu_top')
    expect(roots.rootOf('toolu_inner_step')).toBe('toolu_top')
    expect(roots.rootOf('toolu_deepest')).toBe('toolu_top')
  })

  it('keeps a parent nobody saw as its own root', () => {
    expect(createCallRoots().rootOf('toolu_unseen')).toBe('toolu_unseen')
  })
})
