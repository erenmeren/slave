import { describe, expect, it } from 'vitest'
import { recommendRunbooks } from '../../src/runbook/recommend.js'
import type { Runbook } from '../../src/runbook/spec.js'
import type { CapabilityRecord } from '../../src/capability/taxonomy.js'

const TAXONOMY: readonly CapabilityRecord[] = [
  { key: 'security.application', label: 'Application security', domain: 'security', role: 'security', synonyms: [] },
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'backend', synonyms: [] },
  { key: 'review.code-review', label: 'Code review', domain: 'review', role: 'reviewer', synonyms: [] },
]

const runbook = (overrides: Partial<Runbook> & { key: string }): Runbook => ({
  id: `rb-${overrides.key}`,
  name: overrides.key,
  description: 'a runbook',
  keywords: [],
  requiredCapabilities: [],
  optionalCapabilities: [],
  stages: [
    { key: 'only', title: 'Only', objective: 'Do it', capabilities: [], dependsOn: [], expectedOutputs: [], gates: [], retry: null, escalation: null },
  ],
  source: 'seed',
  sourceTemplateId: null,
  ...overrides,
})

describe('recommendRunbooks', () => {
  it('scores keyword hits ten apiece, adds covered required capabilities and subtracts missing ones', () => {
    const feature = runbook({ key: 'feature-delivery', keywords: ['feature', 'endpoint'], requiredCapabilities: ['backend.api-design', 'review.code-review'] })
    const out = recommendRunbooks('Ship the endpoint as a new feature', [feature], ['backend.api-design'], TAXONOMY)
    expect(out).toHaveLength(1)
    expect(out[0]?.matchedKeywords).toEqual(['endpoint', 'feature'])
    expect(out[0]?.coveredRequired).toEqual(['backend.api-design'])
    expect(out[0]?.missingRequired).toEqual(['review.code-review'])
    expect(out[0]?.score).toBe(20)
  })

  it('says nothing at all when no keyword is in the goal -- silence beats noise', () => {
    expect(recommendRunbooks('Ship the endpoint', [runbook({ key: 'bug-fix', keywords: ['bug'] })], [], TAXONOMY)).toEqual([])
  })

  it('matches whole words only, so "debugging" is not "bug"', () => {
    expect(recommendRunbooks('Finish the debugging', [runbook({ key: 'bug-fix', keywords: ['bug'] })], [], TAXONOMY)).toEqual([])
  })

  it('matches a multi-word keyword as a phrase, and ignores case and punctuation', () => {
    const out = recommendRunbooks('A security review, please.', [runbook({ key: 'security-review', keywords: ['security review'] })], [], TAXONOMY)
    expect(out.map((r) => r.runbook.key)).toEqual(['security-review'])
  })

  it('orders by score descending and breaks ties on key ascending, at most three', () => {
    const runbooks = [
      runbook({ key: 'zeta', keywords: ['ship'] }),
      runbook({ key: 'alpha', keywords: ['ship'] }),
      runbook({ key: 'mid', keywords: ['ship'] }),
      runbook({ key: 'best', keywords: ['ship', 'endpoint'] }),
    ]
    expect(recommendRunbooks('ship the endpoint', runbooks, [], TAXONOMY).map((r) => r.runbook.key)).toEqual([
      'best',
      'alpha',
      'mid',
    ])
  })

  it('writes a rationale in the taxonomy WORDS, never in its keys', () => {
    const out = recommendRunbooks(
      'ship the endpoint',
      [runbook({ key: 'feature-delivery', name: 'Feature delivery', keywords: ['endpoint'], requiredCapabilities: ['backend.api-design', 'security.application'] })],
      ['backend.api-design'],
      TAXONOMY,
    )
    expect(out[0]?.rationale).toBe(
      'The goal says "endpoint". Your team already covers API design; it is missing Application security.',
    )
    expect(out[0]?.rationale).not.toContain('backend.api-design')
  })
})
