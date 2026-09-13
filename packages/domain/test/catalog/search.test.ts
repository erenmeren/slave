import { describe, expect, it } from 'vitest'
import { emptyProfileSpec, type ProfileSpec } from '../../src/profile/spec.js'
import { SEARCH_TEXT_MAX_CHARS, catalogSearchText } from '../../src/catalog/search.js'

const spec = (over: Partial<ProfileSpec> = {}): ProfileSpec => ({
  ...emptyProfileSpec(),
  identity: 'The slave who owns the last mile',
  summary: 'Gets a change out and watches what it does',
  mission: 'Take one change to production at a time',
  capabilities: ['Rollout planning', 'Rollback drills'],
  expertise: ['Reading a dashboard back'],
  operatingPrinciples: ['a principle nobody searches for'],
  constraints: ['a constraint nobody searches for'],
  workflow: ['a workflow step nobody searches for'],
  deliverables: ['a deliverable nobody searches for'],
  successCriteria: ['a criterion nobody searches for'],
  collaborationHints: ['a hint nobody searches for'],
  recommendedSkills: ['writing-plans'],
  body: 'a body nobody searches for',
  ...over,
})

describe('catalogSearchText (R3)', () => {
  it('spells its cap once, beside the function that enforces it', () => {
    expect(SEARCH_TEXT_MAX_CHARS).toBe(2000)
  })

  it('holds the SEVEN fields a catalog row displays, so a search matches what a person can see', () => {
    const text = catalogSearchText({ name: 'Gate Release Steward', description: 'Gets a change out.', spec: spec() })
    expect(text).toContain('gate release steward')
    expect(text).toContain('gets a change out.')
    expect(text).toContain('the slave who owns the last mile')
    expect(text).toContain('gets a change out and watches what it does')
    expect(text).toContain('rollout planning')
    expect(text).toContain('reading a dashboard back')
    expect(text).toContain('writing-plans')
  })

  // The residual R3 states out loud and section 6 carries as item 4.
  it('holds NONE of the other seven, which is the cost this milestone accepts and names', () => {
    const text = catalogSearchText({ name: 'Gate Release Steward', description: 'Gets a change out.', spec: spec() })
    for (const absent of ['a principle', 'a constraint', 'a workflow step', 'a deliverable', 'a criterion', 'a hint', 'a body']) {
      expect(text, absent).not.toContain(absent)
    }
  })

  it('is lower-cased and whitespace-collapsed, so the column and the query fold the same way', () => {
    expect(catalogSearchText({ name: '  Gate   RELEASE\tSteward ', description: '', spec: null })).toBe('gate release steward')
  })

  it('survives a row with no structured profile -- name and description are still searchable', () => {
    expect(catalogSearchText({ name: 'Hand Made', description: 'Typed by a person.', spec: null })).toBe(
      'hand made typed by a person.',
    )
  })

  it('never exceeds the cap, and cuts rather than refusing', () => {
    const long = catalogSearchText({
      name: 'Long One',
      description: 'x'.repeat(500),
      spec: spec({ body: 'y'.repeat(20_000) }),
    })
    expect(long.length).toBeLessThanOrEqual(SEARCH_TEXT_MAX_CHARS)
  })

  it('puts the NAME first, so the cap can only ever cost the tail of the prose', () => {
    const text = catalogSearchText({
      name: 'Findable Name',
      description: 'd'.repeat(3000),
      spec: null,
    })
    expect(text.startsWith('findable name')).toBe(true)
    expect(text).toHaveLength(SEARCH_TEXT_MAX_CHARS)
  })

  it('is deterministic -- the same row always produces the same column', () => {
    const input = { name: 'Same', description: 'Same.', spec: spec() }
    expect(catalogSearchText(input)).toBe(catalogSearchText(input))
  })
})
