import { describe, expect, it } from 'vitest'
import { formatAgo, formatMinutes, formatUsd, percentOf, plural, spendLine, timeLine } from '../src/lib/format'

describe('the figures a person reads (lead UX design)', () => {
  it('says dollars with cents only when there are cents', () => {
    expect(formatUsd(20)).toBe('$20')
    expect(formatUsd(4.2)).toBe('$4.20')
    expect(formatUsd(0.005)).toBe('$0.01')
  })

  it('says the spend against the budget, "at least" when part of it was not measured', () => {
    expect(spendLine(4.2, false, 20)).toBe('$4.20 of $20')
    expect(spendLine(4.2, true, 20)).toBe('at least $4.20 of $20')
    expect(spendLine(4.2, false, null)).toBe('$4.20, no budget')
  })

  it('says working time in minutes and hours, and against the limit', () => {
    expect(formatMinutes(0)).toBe('0 min')
    expect(formatMinutes(30_000)).toBe('under a minute')
    expect(formatMinutes(38 * 60_000)).toBe('38 min')
    expect(formatMinutes(90 * 60_000)).toBe('1 h 30 min')
    expect(formatMinutes(120 * 60_000)).toBe('2 h')
    expect(timeLine(38 * 60_000, 90 * 60_000)).toBe('38 min of 1 h 30 min')
    expect(timeLine(38 * 60_000, null)).toBe('38 min, no time limit')
  })

  it('says how long ago', () => {
    const now = Date.parse('2026-10-05T12:00:00Z')
    expect(formatAgo('2026-10-05T11:59:30Z', now)).toBe('just now')
    expect(formatAgo('2026-10-05T11:57:00Z', now)).toBe('3 min ago')
    expect(formatAgo('2026-10-05T10:00:00Z', now)).toBe('2 h ago')
    expect(formatAgo('2026-10-01T12:00:00Z', now)).toBe('4 days ago')
  })

  it('measures a bar against its whole, clamped, and draws none without a whole', () => {
    expect(percentOf(5, 20)).toBe(25)
    expect(percentOf(30, 20)).toBe(100)
    expect(percentOf(5, null)).toBeNull()
    expect(percentOf(5, 0)).toBeNull()
  })

  it('counts a noun', () => {
    expect(plural(1, 'time')).toBe('1 time')
    expect(plural(2, 'time')).toBe('2 times')
  })
})
