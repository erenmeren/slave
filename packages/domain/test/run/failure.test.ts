import { describe, expect, it } from 'vitest'
import {
  PROVIDER_BACKOFF_ROWS,
  PROVIDER_ERROR_BACKOFF_MAX_MS,
  PROVIDER_ERROR_BACKOFF_MS,
  providerBackoffUntil,
  providerErrorBackoffMs,
} from '../../src/run/failure.js'

const at = (seconds: number): Date => new Date(Date.UTC(2026, 8, 25, 12, 0, seconds))

describe('providerErrorBackoffMs (H9b R1, F5)', () => {
  it('is nothing without a refusal, sixty seconds after one, and doubles to a ten-minute ceiling', () => {
    expect(providerErrorBackoffMs(0)).toBe(0)
    expect([1, 2, 3, 4, 5, 6].map(providerErrorBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
    expect(providerErrorBackoffMs(500)).toBe(PROVIDER_ERROR_BACKOFF_MAX_MS)
  })

  it('reaches the ceiling within the rows a loader reads', () => {
    expect(providerErrorBackoffMs(PROVIDER_BACKOFF_ROWS)).toBe(PROVIDER_ERROR_BACKOFF_MAX_MS)
  })
})

describe('providerBackoffUntil (H9b R1, F5)', () => {
  it('holds nothing back when there is no run, or the newest one was not refused', () => {
    expect(providerBackoffUntil([])).toBeNull()
    expect(
      providerBackoffUntil([
        { providerError: false, concludedAt: at(30) },
        { providerError: true, concludedAt: at(0) },
      ]),
    ).toBeNull()
  })

  it('counts only the unbroken head of refusals, from the newest one', () => {
    const until = providerBackoffUntil([
      { providerError: true, concludedAt: at(40) },
      { providerError: true, concludedAt: at(20) },
      { providerError: false, concludedAt: at(10) },
      { providerError: true, concludedAt: at(0) },
    ])
    expect(until?.getTime()).toBe(at(40).getTime() + 2 * PROVIDER_ERROR_BACKOFF_MS)
  })
})
