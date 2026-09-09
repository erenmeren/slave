import { describe, expect, it } from 'vitest'
import {
  ANSWER_MAX_CHARS,
  COOLDOWN_MS,
  DECISION_RETENTION_MS,
  INTEGRATED_STALE_MS,
  PENDING_TTL_MS,
  PRUNE_BATCH,
  RUN_PROMPT_MAX_CHARS,
  SOURCES_MAX,
  SOURCE_QUOTE_MAX_CHARS,
  SUPERVISOR_DEFAULT_MODEL,
  SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK,
  SUPERVISOR_PER_CALL_CAP_USD,
  THREAD_BODY_MAX_CHARS,
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

  // The mailbox's caps (M39). Same reason: nothing in this task reads `DECISION_RETENTION_MS` or
  // `PRUNE_BATCH` -- control's prune pass does -- and a retention window spelt in hours rather than
  // days would delete a month of decisions with nothing to catch it.
  it('are the mailbox caps the milestone specifies', () => {
    expect(ANSWER_MAX_CHARS).toBe(4000)
    expect(THREAD_BODY_MAX_CHARS).toBe(2000)
    expect(RUN_PROMPT_MAX_CHARS).toBe(16000)
    expect(SOURCE_QUOTE_MAX_CHARS).toBe(300)
    expect(SOURCES_MAX).toBe(8)
    expect(DECISION_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000)
    expect(PRUNE_BATCH).toBe(500)
  })
})
