import { describe, expect, it } from 'vitest'
import {
  INTAKE_MAX_MODEL_CALLS,
  INTAKE_PER_CALL_CAP_USD,
  INTAKE_ROLES,
  INTAKE_ROLE_LABEL,
  INTAKE_STATUSES,
  INTAKE_STATUS_LABEL,
  INTAKE_STEPS,
  INTAKE_STEP_LABEL,
  SUPERVISOR_PER_CALL_CAP_USD,
} from '../../src/index.js'

describe('the intake vocabulary', () => {
  it('names all eight statuses a conversation can be in', () => {
    expect([...INTAKE_STATUSES]).toEqual([
      'open',
      'awaiting_reply',
      'replying',
      'drafted',
      'creating',
      'created',
      'failed',
      'abandoned',
    ])
  })

  it('has a word a person can read for every status, and never the member itself', () => {
    for (const status of INTAKE_STATUSES) {
      const label = INTAKE_STATUS_LABEL[status]
      expect(label, status).toBeTypeOf('string')
      expect(label.length, status).toBeGreaterThan(0)
      // `docs/ia.md` rule 3: the label is a WORD. A label that is its own key is a bare enum
      // member on a surface, which is the thing the rule forbids.
      expect(label, status).not.toBe(status)
    }
  })

  it('has a word for every role and every accept step', () => {
    expect([...INTAKE_ROLES]).toEqual(['human', 'assistant', 'fact'])
    for (const role of INTAKE_ROLES) expect(INTAKE_ROLE_LABEL[role], role).not.toBe(role)
    expect([...INTAKE_STEPS]).toEqual([
      'init_repository',
      'create_workspace',
      'staff',
      'set_goal',
      'mark_created',
    ])
    for (const step of INTAKE_STEPS) expect(INTAKE_STEP_LABEL[step], step).not.toBe(step)
  })

  it('caps one conversation at twelve calls and one call at the Supervisor own ceiling (R12)', () => {
    expect(INTAKE_MAX_MODEL_CALLS).toBe(12)
    // Not a second number: R12 says the per-call cap IS the Supervisor's, so this is an
    // assignment rather than a coincidence, and the assertion is that they cannot drift.
    expect(INTAKE_PER_CALL_CAP_USD).toBe(SUPERVISOR_PER_CALL_CAP_USD)
  })
})
