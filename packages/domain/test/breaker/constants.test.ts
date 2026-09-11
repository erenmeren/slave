import { describe, expect, it } from 'vitest'
import {
  BREAKER_BEAT_MS,
  BREAKER_COOLDOWN_MS,
  BREAKER_STEER_TEXT,
  BREAKER_WINDOW,
  CONSTRAIN_GRACE_CALLS,
  ERROR_STORM_COUNT,
  NO_PROGRESS_BEATS,
  REPEAT_TRIP_COUNT,
  STEERS_PER_RUN_MAX,
  steerTextFor,
} from '../../src/breaker/constants.js'
import { BREAKER_TRIP_KINDS } from '../../src/breaker/detect.js'
import { COOLDOWN_MS } from '../../src/supervisor/constants.js'

// Pinned the way `SUPERVISOR_PER_CALL_CAP_USD` is pinned by
// `packages/domain/test/supervisor/constants.test.ts`: these are DOMAIN constants, not workspace
// settings (M38 section 8), so the only thing standing between a number and a silent edit is a test
// that says what it is.
describe('the breaker constants', () => {
  it('reads sixty rows of the run and no more', () => {
    expect(BREAKER_WINDOW).toBe(60)
  })

  it('trips a repeat at eight, an error storm at five, and no-progress after two beats', () => {
    expect(REPEAT_TRIP_COUNT).toBe(8)
    expect(ERROR_STORM_COUNT).toBe(5)
    expect(NO_PROGRESS_BEATS).toBe(2)
  })

  it('beats once a minute, so a one-second tick loop cannot climb the ladder in three seconds', () => {
    expect(BREAKER_BEAT_MS).toBe(60_000)
  })

  it('gives a constrained run thirty more calls and a run at most two steers', () => {
    expect(CONSTRAIN_GRACE_CALLS).toBe(30)
    expect(STEERS_PER_RUN_MAX).toBe(2)
  })

  it('cools this situation down in two minutes, not the Supervisor’s fifteen', () => {
    expect(BREAKER_COOLDOWN_MS).toBe(120_000)
    // The reason the override exists, asserted rather than described: fifteen minutes is far too
    // coarse for a loop that burns five dollars in three.
    expect(BREAKER_COOLDOWN_MS).toBeLessThan(COOLDOWN_MS)
  })
})

describe('the steer text', () => {
  it('has a sentence for every trip kind -- a kind with no words could never be steered', () => {
    for (const kind of BREAKER_TRIP_KINDS) {
      expect(typeof BREAKER_STEER_TEXT[kind], kind).toBe('function')
    }
  })

  it('interpolates the trip’s own integer and says the same three things every time', () => {
    const text = steerTextFor({ kind: 'repeated_call', count: 8, detail: 'Bash:abc' })
    expect(text).toContain('8 times')
    expect(text).toContain('one paragraph')
    expect(text).toContain('change approach')
  })

  it('never carries the trip’s detail -- a hash is not a sentence a worker can read', () => {
    expect(steerTextFor({ kind: 'repeated_call', count: 8, detail: 'Bash:deadbeef' })).not.toContain('deadbeef')
  })

  it('is the same sentence for the same trip, so a re-sent steer is byte-identical', () => {
    const trip = { kind: 'error_storm', count: 5, detail: 'api_error' } as const
    expect(steerTextFor(trip)).toBe(steerTextFor(trip))
  })
})
