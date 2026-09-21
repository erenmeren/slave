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
  it('carries the twenty-four action kinds, `steer_run` among them', () => {
    expect(ACTION_KINDS).toHaveLength(24)
    expect(ACTION_KINDS).toContain('steer_run')
  })

  // M52 R5: the seventeenth situation, asserted BY NAME for `engagement_over`'s own reason. The
  // words are what is STUCK -- not the kind, and not the operation's own label, which the
  // situation's summary carries beside it.
  it('names the seventeenth situation the way a person says it', () => {
    expect(SITUATION_LABEL.permission_blocked).toBe('Blocked by a permission')
  })

  // M52 R5: the seventeenth action, held by the same count that caught `steer_run`.
  it('carries request_permission, the seventeenth action kind', () => {
    expect(ACTION_KINDS).toContain('request_permission')
  })

  // Self-running-project R3/R4: the eighteenth through twentieth actions -- the diagnosed
  // remedies, held by the same count that caught `steer_run` and `request_permission`.
  it('carries retry_task, retry_review and clear_halt, the eighteenth through twentieth action kinds', () => {
    expect(ACTION_KINDS).toContain('retry_task')
    expect(ACTION_KINDS).toContain('retry_review')
    expect(ACTION_KINDS).toContain('clear_halt')
  })

  // Supervisor chat R3: the eighteenth situation and the two actions that join the catalogue with
  // it, held by the same coverage check and the same count. The label says what HAPPENED -- a
  // person asked for something -- rather than naming the conversation it arrived through.
  it('names the eighteenth situation the way a person says it, and carries its two actions', () => {
    expect(SITUATION_LABEL.operator_request).toBe('Something you asked for')
    expect(ACTION_KINDS).toContain('request_goal_change')
    expect(ACTION_KINDS).toContain('note_for_planner')
  })

  // H4a: the nineteenth situation and the two actions that join the catalogue with it, held by the
  // same coverage check and the same count. The label says what is STUCK in the words a person uses
  // -- the reason (no runtime, no planner, the retries are gone) rides on the situation's summary.
  it('names the nineteenth situation the way a person says it, and carries its two actions', () => {
    expect(SITUATION_LABEL.planning_stalled).toBe('Planning cannot start')
    expect(ACTION_KINDS).toContain('configure_runtime')
    expect(ACTION_KINDS).toContain('retry_planning')
  })

  // H4a: `no_planner` is RETIRED, not removed -- `observe` stops emitting it and a Postgres enum
  // value is never taken away, so a decision row written before this hotfix still reads back with
  // the words it was shown under.
  it('keeps the retired no_planner kind and its label, for the rows that already carry it', () => {
    expect(SITUATION_KINDS).toContain('no_planner')
    expect(SITUATION_LABEL.no_planner).toBe('No planner')
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
