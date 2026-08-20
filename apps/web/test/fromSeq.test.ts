import { describe, expect, it } from 'vitest'
import { parseFromSeq } from '../src/server/fromSeq.js'

describe('parseFromSeq', () => {
  it('accepts a non-negative integer watermark', (): void => {
    expect(parseFromSeq('0')).toBe(0)
    expect(parseFromSeq('42')).toBe(42)
  })

  it('treats an absent value as "from now"', (): void => {
    expect(parseFromSeq(null)).toBeNull()
  })

  it('rejects the empty string instead of reading it as 0', (): void => {
    // `Number('') === 0` — an empty `?from=` or empty Last-Event-ID header would otherwise
    // replay the entire event log from seq 0.
    expect(parseFromSeq('')).toBeNull()
    expect(parseFromSeq('   ')).toBeNull()
  })

  it('rejects values that are not a non-negative integer', (): void => {
    expect(parseFromSeq('-1')).toBeNull()
    expect(parseFromSeq('1.5')).toBeNull()
    expect(parseFromSeq('NaN')).toBeNull()
    expect(parseFromSeq('Infinity')).toBeNull()
    expect(parseFromSeq('abc')).toBeNull()
  })
})
