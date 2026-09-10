import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_KEY_PATTERN,
  capabilityLabel,
  normaliseCapabilities,
  normaliseCapabilityText,
  projectRoles,
  type CapabilityRecord,
} from '../../src/capability/taxonomy.js'

const TAXONOMY: readonly CapabilityRecord[] = [
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'backend', synonyms: ['api architecture', 'rest design'] },
  { key: 'security.application', label: 'Application security', domain: 'security', role: 'security', synonyms: ['appsec', 'secure code review'] },
  { key: 'review.code-review', label: 'Code review', domain: 'review', role: 'reviewer', synonyms: [] },
]

describe('normaliseCapabilityText', () => {
  it('lowercases, collapses whitespace and treats separators as spaces', () => {
    expect(normaliseCapabilityText('  API   Design ')).toBe('api design')
    expect(normaliseCapabilityText('secure_code-review')).toBe('secure code review')
    expect(normaliseCapabilityText('Application security.')).toBe('application security')
  })

  // A dotted KEY has to survive the same normaliser, or an exact key match could never happen.
  it('keeps a dotted key recognisable by mapping its dot to a space too', () => {
    expect(normaliseCapabilityText('backend.api-design')).toBe('backend api design')
  })
})

describe('normaliseCapabilities', () => {
  it('resolves an exact key, a label and a synonym, and keeps everything else unresolved', () => {
    const out = normaliseCapabilities(
      ['backend.api-design', 'Application security', 'appsec', 'Vibes and enthusiasm'],
      TAXONOMY,
    )
    // `appsec` is a second spelling of a key already resolved: the keys are a SET, in first-seen
    // order, so a persona that says the same thing twice does not get the capability twice.
    expect(out.keys).toEqual(['backend.api-design', 'security.application'])
    expect(out.unresolved).toEqual(['Vibes and enthusiasm'])
  })

  it('never matches on a substring', () => {
    const out = normaliseCapabilities(['Threat modelling for application security reviews'], TAXONOMY)
    expect(out.keys).toEqual([])
    expect(out.unresolved).toEqual(['Threat modelling for application security reviews'])
  })

  it('drops blank entries rather than reporting them as unresolved', () => {
    expect(normaliseCapabilities(['   ', ''], TAXONOMY)).toEqual({ keys: [], unresolved: [] })
  })
})

describe('projectRoles', () => {
  it('is the roles of the known keys, deduplicated and sorted', () => {
    expect(projectRoles(['review.code-review', 'backend.api-design', 'security.application'], TAXONOMY)).toEqual([
      'backend',
      'reviewer',
      'security',
    ])
  })

  it('ignores a key the taxonomy does not have', () => {
    expect(projectRoles(['nope.nothing'], TAXONOMY)).toEqual([])
  })
})

describe('capabilityLabel', () => {
  it('falls back to the key itself, so a surface never renders an empty chip', () => {
    expect(capabilityLabel('backend.api-design', TAXONOMY)).toBe('API design')
    expect(capabilityLabel('nope.nothing', TAXONOMY)).toBe('nope.nothing')
  })
})

describe('CAPABILITY_KEY_PATTERN', () => {
  it('is <domain>.<name>, both dash-separated lower case', () => {
    expect(CAPABILITY_KEY_PATTERN.test('backend.api-design')).toBe(true)
    expect(CAPABILITY_KEY_PATTERN.test('Backend.API')).toBe(false)
    expect(CAPABILITY_KEY_PATTERN.test('backend')).toBe(false)
    expect(CAPABILITY_KEY_PATTERN.test('backend.api.design')).toBe(false)
  })
})
