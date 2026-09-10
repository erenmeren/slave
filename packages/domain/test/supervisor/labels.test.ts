import { describe, expect, it } from 'vitest'
import {
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
