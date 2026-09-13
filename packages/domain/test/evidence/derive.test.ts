import { describe, expect, it } from 'vitest'
import type { CapabilityRecord } from '../../src/capability/taxonomy.js'
import {
  actualCostFrom,
  attemptFrom,
  domainsFor,
  durationMsFrom,
  humanInterventionsFrom,
  isBespokeProfileKey,
  normaliseRepositoryKey,
  profileKeyOf,
  recoveriesFrom,
  reviewRejectedFrom,
  reworkCyclesFrom,
  verifiedFirstPassFrom,
} from '../../src/evidence/derive.js'

const TAXONOMY: readonly CapabilityRecord[] = [
  { key: 'backend.services', label: 'Services', domain: 'backend', role: 'developer', synonyms: [] },
  { key: 'qa.test-automation', label: 'Test automation', domain: 'qa', role: 'reviewer', synonyms: [] },
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'developer', synonyms: [] },
]

describe('profileKeyOf (R1)', () => {
  it('keys a hired worker on the TEMPLATE it came from, so one persona has one record', () => {
    expect(profileKeyOf({ slaveId: 's1', hiredFromTemplateId: 't7' })).toBe('template:t7')
  })

  it('keys a hand-made worker on ITSELF -- there is always a profile and the tuple is never null', () => {
    expect(profileKeyOf({ slaveId: 's1', hiredFromTemplateId: null })).toBe('slave:s1')
  })

  it('tells the two apart, which is what the Bespoke chip renders from', () => {
    expect(isBespokeProfileKey('slave:s1')).toBe(true)
    expect(isBespokeProfileKey('template:t7')).toBe(false)
  })
})

describe('normaliseRepositoryKey (R1)', () => {
  it('strips trailing separators, so two projects on one checkout share a record', () => {
    expect(normaliseRepositoryKey('/home/meren/projects/app/')).toBe('/home/meren/projects/app')
    expect(normaliseRepositoryKey('/home/meren/projects/app///')).toBe('/home/meren/projects/app')
    expect(normaliseRepositoryKey('/home/meren/projects/app')).toBe('/home/meren/projects/app')
  })

  it('never strips the root itself to nothing', () => {
    expect(normaliseRepositoryKey('/')).toBe('/')
  })

  it('is idempotent -- the snapshot written at conclusion and the one written by the backfill agree', () => {
    const once = normaliseRepositoryKey('/srv/repo/')
    expect(normaliseRepositoryKey(once)).toBe(once)
  })
})

describe('attemptFrom (R4)', () => {
  it('is one when nothing has been reworked before this run started', () => {
    expect(attemptFrom([], 100n)).toBe(1)
  })

  it('counts only the reworks BELOW this run own `run.started`, never the ones after it', () => {
    expect(attemptFrom([10n, 20n, 300n], 100n)).toBe(3)
  })

  it('is one for a run with no `run.started` at all -- a count over nothing IS zero (R7)', () => {
    expect(attemptFrom([10n, 20n], null)).toBe(1)
  })

  it('is one for a run with no task, which is every planning run (M8b)', () => {
    expect(attemptFrom([], 1n)).toBe(1)
  })
})

describe('verifiedFirstPassFrom (R4)', () => {
  it('is true only for a PASS on the first attempt', () => {
    expect(verifiedFirstPassFrom('passed', 1)).toBe(true)
  })

  it('is false for a pass on the third attempt, which is the whole point of the column', () => {
    expect(verifiedFirstPassFrom('passed', 3)).toBe(false)
  })

  it('is false for a failed verify, whatever the attempt', () => {
    expect(verifiedFirstPassFrom('failed', 1)).toBe(false)
    expect(verifiedFirstPassFrom('failed', 2)).toBe(false)
  })
})

describe('reviewRejectedFrom (R4)', () => {
  it('is true when the rejection names THIS run attempt', () => {
    expect(reviewRejectedFrom('rejected', 2, 2)).toBe(true)
  })

  it('is false when the rejection names an older attempt -- somebody else own row carries it', () => {
    expect(reviewRejectedFrom('rejected', 1, 2)).toBe(false)
  })

  it('is false on an approval', () => {
    expect(reviewRejectedFrom('approved', null, 1)).toBe(false)
  })

  it('is false when the rejection carries no attempt at all, rather than guessing it is this one', () => {
    expect(reviewRejectedFrom('rejected', null, 1)).toBe(false)
  })
})

describe('reworkCyclesFrom (R4)', () => {
  it('counts the reworks appended AFTER this run started', () => {
    expect(reworkCyclesFrom([10n, 300n, 400n], 100n)).toBe(2)
  })

  it('is zero for a run whose stream carries none -- an Int, not a Boolean, so a 2 can say so', () => {
    expect(reworkCyclesFrom([10n], 100n)).toBe(0)
  })

  it('is zero when the run has no `run.started` (R7) rather than counting the whole task history', () => {
    expect(reworkCyclesFrom([10n, 300n], null)).toBe(0)
  })
})

describe('humanInterventionsFrom (R5)', () => {
  it('counts a pause request, a resume request and an OPERATOR stop, and nothing else', () => {
    expect(
      humanInterventionsFrom({ pauseRequested: 2, resumeRequested: 1, operatorStopped: true }),
    ).toBe(4)
  })

  it('does not count a sweep own stop -- `stopRequestedBy` null is the discriminator', () => {
    expect(
      humanInterventionsFrom({ pauseRequested: 0, resumeRequested: 0, operatorStopped: false }),
    ).toBe(0)
  })
})

describe('recoveriesFrom (R5)', () => {
  it('counts ONE for a run the sweep concluded -- known from the caller, never from reason text', () => {
    expect(recoveriesFrom({ recoveredBySweep: true, unblockedAfterStart: 0 })).toBe(1)
  })

  it('counts every `task.unblocked` appended after this run started', () => {
    expect(recoveriesFrom({ recoveredBySweep: false, unblockedAfterStart: 2 })).toBe(2)
  })

  it('adds the two rather than picking one', () => {
    expect(recoveriesFrom({ recoveredBySweep: true, unblockedAfterStart: 2 })).toBe(3)
  })

  it('is zero for an ordinary run -- a breaker de-escalation is SILENT and is not one of these (M51 R2)', () => {
    expect(recoveriesFrom({ recoveredBySweep: false, unblockedAfterStart: 0 })).toBe(0)
  })
})

describe('durationMsFrom', () => {
  it('is the span between the two stamps', () => {
    expect(durationMsFrom(new Date(1_000), new Date(4_500))).toBe(3_500)
  })

  it('is null when either stamp is missing -- never a zero standing in for a gap', () => {
    expect(durationMsFrom(null, new Date(4_500))).toBeNull()
    expect(durationMsFrom(new Date(1_000), null)).toBeNull()
  })

  it('is null for a negative span, the same guard the analytics aggregate already applies', () => {
    expect(durationMsFrom(new Date(4_500), new Date(1_000))).toBeNull()
  })
})

describe('actualCostFrom (R6)', () => {
  it('takes the REPORTED figure, always and first', () => {
    expect(
      actualCostFrom({ costUsd: 0.42, provider: 'claude_code', status: 'succeeded', tokensIn: 10, tokensOut: 20, model: 'claude-opus-4-20250514' }),
    ).toEqual({ actualCostUsd: 0.42, costProvenance: 'reported' })
  })

  it('estimates from tokens under a priced model when nothing was reported', () => {
    const derived = actualCostFrom({
      costUsd: null,
      provider: 'claude_code',
      status: 'succeeded',
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
      // `claude-sonnet-4-20250514` (the brief's spelling) is not a key of `MODEL_PRICES`, and an
      // unpriced model is the case BELOW. The priced sonnet id is what makes this case the one it
      // says it is.
      model: 'claude-sonnet-5',
    })
    expect(derived.costProvenance).toBe('estimated')
    expect(derived.actualCostUsd).not.toBeNull()
    expect(derived.actualCostUsd).toBeGreaterThan(0)
  })

  it('is NULL and never 0 when nothing can be measured -- a zero is a figure a reader believes', () => {
    expect(
      actualCostFrom({ costUsd: null, provider: 'cursor', status: 'succeeded', tokensIn: null, tokensOut: null, model: null }),
    ).toEqual({ actualCostUsd: null, costProvenance: 'unmeasured' })
  })

  it('is unmeasured under an UNPRICED model, which is the carried-backlog item M53 makes load-bearing', () => {
    expect(
      actualCostFrom({ costUsd: null, provider: 'claude_code', status: 'succeeded', tokensIn: 10, tokensOut: 20, model: 'a-model-nobody-priced' }),
    ).toEqual({ actualCostUsd: null, costProvenance: 'unmeasured' })
  })
})

describe('domainsFor (R2)', () => {
  it('resolves each required capability to its taxonomy domain, deduplicated and sorted', () => {
    expect(domainsFor(['backend.services', 'qa.test-automation'], TAXONOMY)).toEqual(['backend', 'qa'])
  })

  it('collapses two capabilities of one domain into one entry -- ONE row, never one per pair', () => {
    expect(domainsFor(['backend.services', 'backend.api-design'], TAXONOMY)).toEqual(['backend'])
  })

  it('answers the reserved `general` domain for a task that asked for nothing', () => {
    expect(domainsFor([], TAXONOMY)).toEqual(['general'])
  })

  it('answers `general` for a key the taxonomy does not have, rather than inventing a domain', () => {
    expect(domainsFor(['nowhere.at-all'], TAXONOMY)).toEqual(['general'])
  })

  it('drops the unresolvable key and keeps the resolvable one, without falling back to general', () => {
    expect(domainsFor(['backend.services', 'nowhere.at-all'], TAXONOMY)).toEqual(['backend'])
  })

  it('is never empty, which is what lets the column be NOT NULL', () => {
    for (const input of [[], ['nowhere.at-all'], ['backend.services']]) {
      expect(domainsFor(input, TAXONOMY).length, JSON.stringify(input)).toBeGreaterThan(0)
    }
  })

  it('answers `general` against an empty taxonomy -- a database whose taxonomy was never synced', () => {
    expect(domainsFor(['backend.services'], [])).toEqual(['general'])
  })
})
