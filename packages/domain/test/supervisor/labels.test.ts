import { describe, expect, it } from 'vitest'
import {
  ACTION_KINDS,
  DECIDERS,
  DECIDER_LABEL,
  DECISION_STATUSES,
  DECISION_STATUS_LABEL,
  SITUATION_KINDS,
  SITUATION_LABEL,
  TIERS,
  TIER_LABEL,
} from '../../src/index.js'

describe('every union a person reads has a label (M44 R5)', () => {
  it('covers every situation kind, with no key that is not one', () => {
    expect(Object.keys(SITUATION_LABEL).sort()).toEqual([...SITUATION_KINDS].sort())
    for (const kind of SITUATION_KINDS) {
      expect(SITUATION_LABEL[kind].length).toBeGreaterThan(0)
      // A label that is the key with the underscores taken out is not a label.
      expect(SITUATION_LABEL[kind]).not.toBe(kind.replace(/_/g, ' '))
    }
  })

  // M50 R3: the fifteenth kind, asserted BY NAME -- the coverage check above would pass on
  // `engagement_over: 'engagement over'`, and rule 3 is about what a person reads.
  it('names the fifteenth situation the way a person says it', () => {
    expect(SITUATION_LABEL.engagement_over).toBe('Engagement over')
  })

  // M51 R3: the sixteenth kind, asserted BY NAME for `engagement_over`'s own reason -- and it is
  // deliberately the words `GUARDRAIL_LABEL.behavioural_loop` uses, because one phenomenon gets one
  // phrase wherever a person meets it.
  it('names the sixteenth situation the way a person says it', () => {
    expect(SITUATION_LABEL.run_looping).toBe('Going in circles')
  })

  // M51 R3: the sixteenth action. `ACTION_KINDS` has no Postgres enum of its own (an `Action` lives
  // inside a JSONB column), so this count is the only thing that notices a kind added to the union
  // and forgotten in the list the event payloads validate against.
  it('carries the sixteen action kinds, `steer_run` among them', () => {
    expect(ACTION_KINDS).toHaveLength(16)
    expect(ACTION_KINDS).toContain('steer_run')
  })

  it('covers every tier, decision status and decider', () => {
    expect(Object.keys(TIER_LABEL).sort()).toEqual([...TIERS].sort())
    expect(Object.keys(DECISION_STATUS_LABEL).sort()).toEqual([...DECISION_STATUSES].sort())
    expect(Object.keys(DECIDER_LABEL).sort()).toEqual([...DECIDERS].sort())
  })

  it('never lets a label carry the underscore that gives an enum away', () => {
    for (const label of [
      ...Object.values(SITUATION_LABEL),
      ...Object.values(TIER_LABEL),
      ...Object.values(DECISION_STATUS_LABEL),
    ]) {
      expect(label).not.toContain('_')
    }
  })
})
