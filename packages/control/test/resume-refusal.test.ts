import { PROVIDER_KINDS, capabilitiesOf } from '@slave-of-ai/providers'
import { describe, expect, it } from 'vitest'
import { resumeRefusal } from '../src/resume.js'

/**
 * `canResumeSession`, made load-bearing (final review I1, spec §4).
 *
 * The predicate is tested rather than `requestResume` itself, and nothing is mocked: both shipped
 * providers declare `canResumeSession: true`, so the refusal has no reachable database state that
 * produces it today. Faking `capabilitiesOf` to manufacture one would test the fake. What CAN be
 * asserted without lying is the relationship -- for every kind in the table, the guard refuses
 * exactly when the capability says the session cannot be continued -- and that is the property a
 * third provider's row will be read through on the day it is added.
 */
describe('resumeRefusal', () => {
  for (const kind of PROVIDER_KINDS) {
    const { canResumeSession } = capabilitiesOf(kind)

    it(`${canResumeSession ? 'admits' : 'refuses'} a ${kind} run, following canResumeSession: ${canResumeSession}`, () => {
      const refusal = resumeRefusal('run-1', kind)

      expect(refusal === null).toBe(canResumeSession)
      if (refusal !== null) {
        expect(refusal.kind).toBe('provider_cannot_resume')
      }
    })
  }

  it('names the run and the provider, so the refusal says which runtime declined and for which run', () => {
    // Asserted structurally over the same table: whichever kinds refuse must carry both facts,
    // because the operator reading this refusal has neither in front of them.
    for (const kind of PROVIDER_KINDS) {
      const refusal = resumeRefusal('run-1', kind)
      if (refusal === null) continue
      expect(refusal).toEqual({ kind: 'provider_cannot_resume', runId: 'run-1', provider: kind })
    }
  })
})
