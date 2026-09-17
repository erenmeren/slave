import { describe, expect, it } from 'vitest'
import { capabilityGrantDelta, effectiveCapabilities } from '../../src/persons/capabilities.js'

/**
 * Final review, Important 2. The two pure halves of the baseline/grant split, unit-tested here so
 * the control-layer writers (`syncPersonPool`, `setPersonCapabilities`, `hireFromTemplate`) all
 * read the SAME rule and cannot drift into three answers for "what does this person provide".
 */
describe('effectiveCapabilities', () => {
  it('is the union of the template baseline and the explicit grants, sorted and deduplicated', () => {
    expect(effectiveCapabilities(['backend.services', 'backend.api-design'], ['design.visual'])).toEqual([
      'backend.api-design',
      'backend.services',
      'design.visual',
    ])
  })

  it('drops a key the template no longer carries, which is the whole reason for two columns', () => {
    // The person was granted nothing; the baseline shrank; the effective set shrinks with it.
    expect(effectiveCapabilities(['backend.services'], [])).toEqual(['backend.services'])
  })

  it('keeps a grant the template never carried, and a grant that DUPLICATES the baseline only once', () => {
    expect(effectiveCapabilities(['backend.services'], ['backend.services', 'qa.automation'])).toEqual([
      'backend.services',
      'qa.automation',
    ])
  })

  it('is the empty set when neither half has anything, rather than anything invented', () => {
    expect(effectiveCapabilities([], [])).toEqual([])
  })
})

describe('capabilityGrantDelta', () => {
  it('is what was requested BEYOND the baseline: a baseline key is never recorded as a grant', () => {
    expect(capabilityGrantDelta(['backend.services', 'design.visual'], ['backend.services'])).toEqual(['design.visual'])
  })

  it('is empty when the request asks for exactly the baseline, or less than it', () => {
    expect(capabilityGrantDelta(['backend.services'], ['backend.services', 'backend.api-design'])).toEqual([])
    expect(capabilityGrantDelta([], ['backend.services'])).toEqual([])
  })

  it('sorts and deduplicates, so the stored column is the same for any order the caller asked in', () => {
    expect(capabilityGrantDelta(['qa.automation', 'design.visual', 'qa.automation'], [])).toEqual([
      'design.visual',
      'qa.automation',
    ])
  })
})
