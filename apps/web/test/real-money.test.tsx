// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { formatUsd } from '../src/lib/realMoney'

describe('formatUsd', () => {
  it('is two decimal places with a leading dollar', () => {
    expect(formatUsd(3.5)).toBe('$3.50')
    expect(formatUsd(0)).toBe('$0.00')
  })

  it('is an em dash for a figure nobody has, never $0.00', () => {
    // The whole reason this file exists: `.toFixed(2)` on a null yields "$NaN" and `?? 0` yields
    // "$0.00", which is a measurement nobody made -- the lie `SlaveRun.costUsd`'s nullability was
    // introduced to stop (M12 Task 6).
    expect(formatUsd(null)).toBe('—')
  })

  it('says `<$0.01` rather than `$0.00` for a real figure that rounds to nothing', () => {
    expect(formatUsd(0.004)).toBe('<$0.01')
  })

  it('is an em dash for a figure that is not a number at all', () => {
    // A NaN reaches this from a division nobody guarded, and `$NaN` on a money surface is worse
    // than saying nothing: it looks like a bug in the bill rather than a gap in the data.
    expect(formatUsd(Number.NaN)).toBe('—')
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('rounds a real figure the way every money surface already did', () => {
    expect(formatUsd(0.005)).toBe('$0.01')
    expect(formatUsd(12.345)).toBe('$12.35')
    expect(formatUsd(1)).toBe('$1.00')
  })
})
