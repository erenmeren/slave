import { describe, expect, it } from 'vitest'
import {
  COOLDOWN_MS,
  INTEGRATED_STALE_MS,
  PENDING_TTL_MS,
  SUPERVISOR_DEFAULT_MODEL,
  SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK,
  SUPERVISOR_PER_CALL_CAP_USD,
  WAITING_STALE_MS,
} from '../../src/supervisor/constants.js'

// Four of these are read by nothing in this task -- `PENDING_TTL_MS` by control's expiry pass, the
// cap and the model by the orchestrator's decision loop. Until those land, a slipped unit (hours
// where minutes were meant) would sit here undetected, so each is pinned against the same duration
// spelt a different way than the source spells it.
describe('supervisor constants', () => {
  it('are the durations and caps the milestone specifies', () => {
    expect(WAITING_STALE_MS).toBe(30 * 60 * 1000)
    expect(INTEGRATED_STALE_MS).toBe(6 * 60 * 60 * 1000)
    expect(COOLDOWN_MS).toBe(15 * 60 * 1000)
    expect(PENDING_TTL_MS).toBe(24 * 60 * 60 * 1000)
    expect(SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK).toBe(3)
    expect(SUPERVISOR_PER_CALL_CAP_USD).toBe(1)
    expect(SUPERVISOR_DEFAULT_MODEL).toBe('claude-sonnet-5')
  })
})
