import { describe, expect, it } from 'vitest'
import { NON_TERMINAL_RUN_STATUSES, type RunStatus } from '../../src/run/state.js'
import {
  BESPOKE_PROFILE_LABEL,
  EVIDENCE_OUTCOMES,
  EVIDENCE_OUTCOME_LABEL,
  INSUFFICIENT_EVIDENCE,
  MODEL_NOT_RECORDED_LABEL,
  evidenceOutcomeOf,
} from '../../src/evidence/outcome.js'

const EVERY_RUN_STATUS: readonly RunStatus[] = [
  'starting',
  'working',
  'pause_requested',
  'paused',
  'resuming',
  'stopping',
  'stopped',
  'succeeded',
  'failed',
]

describe('EVIDENCE_OUTCOMES', () => {
  it('is exactly the three TERMINAL members of RunStatus, closed (R3)', () => {
    expect(EVIDENCE_OUTCOMES).toEqual(['succeeded', 'failed', 'stopped'])
  })

  it('is RunStatus minus every non-terminal status -- derived here, pinned against Postgres in enum-parity', () => {
    const terminal = EVERY_RUN_STATUS.filter(
      (status) => !(NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(status),
    )
    expect([...EVIDENCE_OUTCOMES].toSorted()).toEqual(terminal.toSorted())
  })

  it('gives every member a word, so no table cell ever prints the key (docs/ia.md rule 3)', () => {
    for (const outcome of EVIDENCE_OUTCOMES) {
      expect(EVIDENCE_OUTCOME_LABEL[outcome], outcome).toMatch(/^[A-Z]/u)
      expect(EVIDENCE_OUTCOME_LABEL[outcome], outcome).not.toBe(outcome)
    }
  })

  it('says what each outcome IS rather than what its key spells', () => {
    expect(EVIDENCE_OUTCOME_LABEL).toEqual({
      succeeded: 'Finished',
      failed: 'Failed',
      stopped: 'Stopped by somebody',
    })
  })
})

describe('evidenceOutcomeOf', () => {
  it('maps each terminal status to itself', () => {
    expect(evidenceOutcomeOf('succeeded')).toBe('succeeded')
    expect(evidenceOutcomeOf('failed')).toBe('failed')
    expect(evidenceOutcomeOf('stopped')).toBe('stopped')
  })

  it('answers null for every non-terminal status -- a live run is not evidence about anything (R3)', () => {
    for (const status of NON_TERMINAL_RUN_STATUSES) {
      expect(evidenceOutcomeOf(status), status).toBeNull()
    }
  })
})

describe('the three words a surface says instead of a number or a key (R11, R12)', () => {
  it('spells "Insufficient evidence" once, so the page and the gate cannot disagree about it', () => {
    expect(INSUFFICIENT_EVIDENCE).toBe('Insufficient evidence')
  })

  it('names the null model group in words -- the ranker skips it, and a reader still sees it (R1)', () => {
    expect(MODEL_NOT_RECORDED_LABEL).toBe('Model not recorded')
  })

  it('has a chip word for a profile that is one worker rather than a catalog persona (R1)', () => {
    expect(BESPOKE_PROFILE_LABEL).toBe('Bespoke')
  })

  it('none of the three is a dash, a zero or an empty string -- R11 rejected all three', () => {
    for (const word of [INSUFFICIENT_EVIDENCE, MODEL_NOT_RECORDED_LABEL, BESPOKE_PROFILE_LABEL]) {
      expect(word.trim().length).toBeGreaterThan(2)
      expect(word).not.toMatch(/^[—\-0]/u)
    }
  })
})
