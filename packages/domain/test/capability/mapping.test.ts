import {
  CAPABILITY_MAP_ANSWER_MARKER,
  CAPABILITY_MAP_MAX_KEYS,
  CAPABILITY_MAP_SENTENCE_CAP,
  buildCapabilityMappingPrompt,
  capabilityMappingHash,
  mappableSentences,
  parseCapabilityMappingAnswer,
  type CapabilityMappingPersona,
  type CapabilityRecord,
} from '@slave-of-ai/domain'
import { describe, expect, it } from 'vitest'

const taxonomy: readonly CapabilityRecord[] = [
  { key: 'marketing.seo', label: 'SEO', domain: 'marketing', role: 'marketing', synonyms: ['search engine optimisation'] },
  { key: 'operations.ci-cd', label: 'CI and CD', domain: 'operations', role: 'operations', synonyms: ['ci/cd'] },
  { key: 'qa.test-automation', label: 'Test automation', domain: 'qa', role: 'qa', synonyms: ['e2e testing'] },
]

const devops: CapabilityMappingPersona = {
  id: 't-devops',
  name: 'DevOps Automator',
  runtimeRole: 'engineering',
  summary: 'Expert DevOps engineer specializing in infrastructure automation',
  identity: 'Infrastructure automation and deployment pipeline specialist',
  capabilities: ['CI/CD Excellence', 'Observability Expertise', '  ', 'Advanced testing automation including chaos engineering'],
}
const seo: CapabilityMappingPersona = {
  id: 't-seo',
  name: 'SEO Strategist',
  runtimeRole: 'marketing',
  summary: 'Grows organic traffic',
  identity: 'Search-first marketer',
  capabilities: ['Technical SEO audits', 'Keyword strategy'],
}

const answer = (personas: unknown): string => `Here you go:\n${JSON.stringify({ personas })}\nDone.`

describe('buildCapabilityMappingPrompt', () => {
  it('names every persona id and every taxonomy key once, and no synonym', () => {
    const prompt = buildCapabilityMappingPrompt([devops, seo], taxonomy)
    expect(prompt.split('t-devops')).toHaveLength(2)
    expect(prompt.split('t-seo')).toHaveLength(2)
    for (const record of taxonomy) expect(prompt.split(record.key)).toHaveLength(2)
    expect(prompt).not.toContain('search engine optimisation')
    expect(prompt).toContain(CAPABILITY_MAP_ANSWER_MARKER)
    expect(prompt).toContain(String(CAPABILITY_MAP_MAX_KEYS))
  })

  it('carries the persona sentences, trimmed and capped, and drops blanks', () => {
    const many = { ...seo, capabilities: Array.from({ length: CAPABILITY_MAP_SENTENCE_CAP + 5 }, (_, i) => `Sentence ${String(i)}`) }
    const prompt = buildCapabilityMappingPrompt([devops, many], taxonomy)
    expect(prompt).toContain('- CI/CD Excellence')
    expect(prompt).not.toContain('-   \n')
    expect(prompt).toContain(`Sentence ${String(CAPABILITY_MAP_SENTENCE_CAP - 1)}`)
    expect(prompt).not.toContain(`Sentence ${String(CAPABILITY_MAP_SENTENCE_CAP)}`)
  })
})

describe('mappableSentences', () => {
  it('trims, drops blanks and caps', () => {
    expect(mappableSentences(['  a ', '', '   ', 'b'])).toEqual(['a', 'b'])
    expect(mappableSentences(Array.from({ length: 50 }, (_, i) => String(i)))).toHaveLength(CAPABILITY_MAP_SENTENCE_CAP)
  })
})

describe('capabilityMappingHash', () => {
  it('is stable for the same persona and taxonomy, and moves when either changes', () => {
    const a = capabilityMappingHash(devops, taxonomy)
    expect(capabilityMappingHash({ ...devops, capabilities: [...devops.capabilities] }, taxonomy)).toBe(a)
    expect(capabilityMappingHash({ ...devops, summary: 'changed' }, taxonomy)).not.toBe(a)
    expect(capabilityMappingHash(devops, taxonomy.slice(1))).not.toBe(a)
    // Synonyms and labels are not in the hash: a relabel does not re-spend a call.
    expect(capabilityMappingHash(devops, taxonomy.map((r) => ({ ...r, label: r.label.toUpperCase(), synonyms: [] })))).toBe(a)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('parseCapabilityMappingAnswer', () => {
  it('accepts the envelope, keeps only taxonomy keys, deduplicates and reports the rest', () => {
    const parsed = parseCapabilityMappingAnswer(
      answer([{ id: 't-devops', keys: ['operations.ci-cd', 'qa.test-automation', 'operations.ci-cd', 'made.up'] }]),
      [devops],
      taxonomy,
    )
    expect(parsed).toEqual([{ id: 't-devops', keys: ['operations.ci-cd', 'qa.test-automation'], dropped: ['made.up'] }])
  })

  it('truncates to the maximum, most central first', () => {
    const big = taxonomy.map((r) => r.key)
    const extra = Array.from({ length: CAPABILITY_MAP_MAX_KEYS + 3 }, (_, i) => ({ key: `x.k${String(i)}`, label: `K${String(i)}`, domain: 'x', role: 'x', synonyms: [] }))
    const wide = [...taxonomy, ...extra]
    const keys = [...big, ...extra.map((r) => r.key)]
    const parsed = parseCapabilityMappingAnswer(answer([{ id: 't-seo', keys }]), [seo], wide)
    expect(parsed?.[0]?.keys).toEqual(keys.slice(0, CAPABILITY_MAP_MAX_KEYS))
  })

  it('leaves an unmentioned persona absent, and keeps an empty answer as empty', () => {
    const parsed = parseCapabilityMappingAnswer(answer([{ id: 't-seo', keys: [] }]), [devops, seo], taxonomy)
    expect(parsed).toEqual([{ id: 't-seo', keys: [], dropped: [] }])
  })

  it('ignores an id that is not in the batch and a malformed entry', () => {
    const parsed = parseCapabilityMappingAnswer(
      answer([{ id: 'stranger', keys: ['marketing.seo'] }, { id: 't-seo', keys: 'marketing.seo' }, { id: 't-devops', keys: ['marketing.seo'] }]),
      [devops, seo],
      taxonomy,
    )
    expect(parsed).toEqual([{ id: 't-devops', keys: ['marketing.seo'], dropped: [] }])
  })

  it('returns null when there is no JSON object or the envelope is wrong', () => {
    expect(parseCapabilityMappingAnswer('no json here', [seo], taxonomy)).toBeNull()
    expect(parseCapabilityMappingAnswer('{"nope": []}', [seo], taxonomy)).toBeNull()
    expect(parseCapabilityMappingAnswer('{"personas": "x"}', [seo], taxonomy)).toBeNull()
  })
})
