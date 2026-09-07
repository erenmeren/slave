import { describe, expect, it } from 'vitest'
import { metricDeltas } from '../src/simulation/read.js'

/**
 * M32 item 6. `SimulationMetrics` used to be typed `Record<string, number>` and was not one: the
 * trade sector's `metrics(...)` also returns `sources` (an object of provenance lists) and a
 * `minCashDay` companion, and control published the lot under a type that said every value was a
 * number. Two `as SimulationMetrics` casts made the compiler believe it.
 *
 * The type is honest now (`Record<string, unknown>`), which moves the question to the one place
 * that does arithmetic on a metric: this function. No database here -- the delta rule is pure, and
 * a fabricated label set is the only way to exercise the non-numeric branch, since both real
 * sectors label numbers only.
 */
describe('metricDeltas', () => {
  const labels = {
    deliveredQty: { label: 'delivered', kind: 'count' as const },
    lateDays: { label: 'late days', kind: 'days' as const },
  }

  it('is b − a over the label keys, and only over them', () => {
    const deltas = metricDeltas(labels, { deliveredQty: 10, lateDays: 4, sources: { deliveredQty: ['x'] } }, { deliveredQty: 25, lateDays: 0 })
    expect(deltas).toEqual({ deliveredQty: 15, lateDays: -4 })
    // `sources` is in the metrics of both sides and is not a labelled key: no delta is invented
    // for it, and nothing tries to subtract one object from another.
    expect(Object.keys(deltas)).toEqual(['deliveredQty', 'lateDays'])
  })

  it('a missing key on either side counts as 0, as it always did', () => {
    expect(metricDeltas(labels, {}, { deliveredQty: 7 })).toEqual({ deliveredQty: 7, lateDays: 0 })
  })

  it('a labelled key that is not a number on either side has NO delta: null, not a guess', () => {
    // `null` rather than `0`: 0 is a measurement, and a page that printed "0" here would be
    // claiming the two runs came out the same on a figure nobody subtracted.
    expect(metricDeltas(labels, { deliveredQty: 'many', lateDays: 4 }, { deliveredQty: 25, lateDays: 0 })).toEqual({ deliveredQty: null, lateDays: -4 })
    expect(metricDeltas(labels, { deliveredQty: 10, lateDays: 4 }, { deliveredQty: { total: 25 }, lateDays: 0 })).toEqual({ deliveredQty: null, lateDays: -4 })
    // NaN is not a number for this purpose either: subtracting it produces NaN, which renders as
    // "NaN" on the page -- the same lie in worse handwriting.
    expect(metricDeltas(labels, { deliveredQty: Number.NaN }, { deliveredQty: 25 })['deliveredQty']).toBeNull()
  })
})
