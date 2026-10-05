import { readFileSync } from 'node:fs'
import { createCallRoots, createLiveCostMeter, type RunCostEstimate } from '@slave-of-ai/domain'
import { describe, expect, it } from 'vitest'
import { parseStreamLine, parseStreamUsage } from '../src/claude/stream.js'

/**
 * How close the live cost estimate comes to what the CLI then REPORTED, measured on the recordings
 * (live cost, step 4). The meter is the one the pump runs; the lines go through the parser the
 * adapter runs. `only` restricts the count to some message ids, for the one fixture that needs it.
 */
function estimateOf(fixture: string, only?: readonly string[]): { readonly estimate: RunCostEstimate; readonly reportedUsd: number } {
  const lines = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8').split('\n').filter((line) => line !== '')
  const meter = createLiveCostMeter(null)
  const roots = createCallRoots()
  let reportedUsd = Number.NaN
  for (const line of lines) {
    const event = parseStreamLine(line)
    if (event.kind === 'tool_call') roots.call(event.toolUseId, event.parentToolUseId ?? null)
    if (event.kind === 'terminated' && event.outcome.costUsd !== null) reportedUsd = event.outcome.costUsd
    const message = parseStreamUsage(line)?.message
    if (message === undefined || (only !== undefined && !only.includes(message.id))) continue
    meter.add({ ...message, rootCallId: roots.rootOf(message.parentToolUseId) })
  }
  return { estimate: meter.snapshot(), reportedUsd }
}

describe('the live cost estimate against what the CLI reported', () => {
  /**
   * MEASURED on four genuine captures that carry both per-message usage and a reported cost.
   * Every ratio is UNDER one, and for one reason: an assistant line's `output_tokens` is the count
   * at the START of its message (22 against a billed 486 here), and the model's hidden thinking is
   * on no line at all. Input and the cache tiers are exact, so the shortfall is the hidden output
   * and nothing else -- small where a run mostly reads (these), larger where it mostly writes.
   * The tolerance is there to make a regression visible, not to excuse one: a change that counts a
   * message twice lands near 2, and one that drops the cache tiers lands near 0.
   */
  it.each([
    ['hook-crash.ndjson', 0.2428725, 0.948],
    ['hook-deny.ndjson', 0.21690299999999998, 0.958],
    ['permission-matrix-deny.ndjson', 0.0741884, 0.966],
    ['claude/skill-tool-use.ndjson', 0.42269600000000007, 0.991],
  ])('%s: the estimate is a little under the reported figure', (fixture, reported, ratio) => {
    const { estimate, reportedUsd } = estimateOf(fixture)
    expect(reportedUsd).toBe(reported)
    expect(estimate.unpricedMessages).toBe(0)
    expect(estimate.usd / reportedUsd).toBeGreaterThan(ratio - 0.02)
    expect(estimate.usd / reportedUsd).toBeLessThan(ratio + 0.02)
    expect(estimate.usd).toBeLessThanOrEqual(reportedUsd)
  })

  /**
   * `complete.ndjson` needs saying out loud, because read whole it OVER-states by 1.8 and the reason
   * is the fixture, not the meter. Its four assistant lines carry four different message ids, so
   * there is nothing to dedupe -- but its `result` line accounts for only TWO of them: the result's
   * cache write, 16,732, is the first line's 15,148 plus the last line's 1,584, and its cache read,
   * 46,948, is their 15,900 plus 31,048. The middle two lines (a `Bash` call writing `gamma.txt`,
   * where the result's own text says `beta.txt`) come from another recording of the same prompt,
   * spliced in to give the replay a second tool call. Both readings are pinned: the whole file as
   * the replay modes will see it, and the two messages the reported figure is actually about.
   */
  it('complete.ndjson: 0.91 on the two messages its result line accounts for, 1.80 read whole (a spliced recording)', () => {
    const own = estimateOf('complete.ndjson', ['msg_011CeAiWoz1djsMBzDUS5dbS', 'msg_011CeAiXQJWZ8SCmdiqGqE5h'])
    expect(own.reportedUsd).toBe(0.20933900000000003)
    expect(own.estimate.messages).toBe(2)
    expect(own.estimate.usd / own.reportedUsd).toBeGreaterThan(0.90)
    expect(own.estimate.usd / own.reportedUsd).toBeLessThan(0.94)

    const whole = estimateOf('complete.ndjson')
    expect(whole.estimate.messages).toBe(4)
    expect(whole.estimate.usd / whole.reportedUsd).toBeGreaterThan(1.78)
    expect(whole.estimate.usd / whole.reportedUsd).toBeLessThan(1.84)
  })

  it('counts a message once where the recording repeats its id on several lines', () => {
    // `permission-matrix-deny.ndjson`: four assistant lines, two messages.
    expect(estimateOf('permission-matrix-deny.ndjson').estimate.messages).toBe(2)
  })
})
