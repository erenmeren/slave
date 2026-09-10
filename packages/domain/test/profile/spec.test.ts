import { describe, expect, it } from 'vitest'
import {
  PROFILE_FIELD_KIND,
  PROFILE_FIELD_LABEL,
  PROFILE_MAX_CHARS,
  PROFILE_SECTION_PRIORITY,
  PROFILE_SPEC_FIELDS,
  effectiveProfileSpec,
  emptyProfileSpec,
  overriddenFields,
  profileOverridesSchema,
  profileSourceId,
  profileSpecSchema,
  renderProfileSpec,
  type ProfileSpec,
} from '../../src/index.js'

const source = {
  repository: 'catalog-m46',
  path: 'engineering/gate-canonical.md',
  revision: '0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef',
  license: 'MIT',
  importedAt: '2026-09-11T09:00:00.000Z',
  mappingQuality: 'full' as const,
}

const spec = (over: Partial<ProfileSpec> = {}): ProfileSpec => ({
  ...emptyProfileSpec(),
  identity: 'The slave that lays the load-bearing parts first.',
  summary: 'Builds the core module and the tests that hold it up.',
  mission: 'Put the parts everything else stands on in place, tested.',
  runtimeRole: 'engineering',
  capabilities: ['Design the module boundary', 'Write the test before the code'],
  expertise: ['Ten years of load-bearing code'],
  operatingPrinciples: ['Small commits, each one green'],
  constraints: ['You MUST never leave a red test behind'],
  workflow: ['Step 1: read the brief back', 'Step 2: write the failing test'],
  deliverables: ['A module and its tests'],
  successCriteria: ['Every commit green'],
  collaborationHints: ['Hand off to the Gate Verifier when the tests are green'],
  recommendedSkills: ['writing-plans'],
  body: '# Gate Core Builder\n\nYou write the module everything else stands on.',
  source,
  ...over,
})

describe('profileSpecSchema', () => {
  it('accepts a full spec and round-trips it through JSON', () => {
    const parsed = profileSpecSchema.safeParse(JSON.parse(JSON.stringify(spec())))
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.source?.mappingQuality).toBe('full')
  })

  it('accepts a spec with no source at all -- a hand-made template has no upstream', () => {
    expect(profileSpecSchema.safeParse({ ...emptyProfileSpec(), source: null }).success).toBe(true)
  })

  it('refuses a list item over 240 characters and a list over 40 items', () => {
    expect(profileSpecSchema.safeParse(spec({ capabilities: ['x'.repeat(241)] })).success).toBe(false)
    expect(profileSpecSchema.safeParse(spec({ capabilities: Array.from({ length: 41 }, (_, i) => `c${String(i)}`) })).success).toBe(false)
  })

  it('refuses a mapping quality that is not one of the three', () => {
    expect(profileSpecSchema.safeParse(spec({ source: { ...source, mappingQuality: 'partly' as never } })).success).toBe(false)
  })
})

describe('profileOverridesSchema', () => {
  it('accepts a PARTIAL object holding only the fields an operator changed', () => {
    const parsed = profileOverridesSchema.safeParse({ constraints: ['You MUST ship behind a flag'] })
    expect(parsed.success).toBe(true)
  })

  it('accepts the empty object -- "nothing is overridden" is a real state', () => {
    expect(profileOverridesSchema.safeParse({}).success).toBe(true)
  })

  it('refuses a key that is not a profile field, and refuses `source`', () => {
    expect(profileOverridesSchema.safeParse({ nonsense: 'x' }).success).toBe(false)
    expect(profileOverridesSchema.safeParse({ source }).success).toBe(false)
  })
})

describe('effectiveProfileSpec', () => {
  it('returns the upstream spec untouched when nothing is overridden', () => {
    expect(effectiveProfileSpec(spec(), {})).toEqual(spec())
  })

  it('REPLACES an overridden list rather than merging into it', () => {
    const merged = effectiveProfileSpec(spec(), { capabilities: ['One capability only'] })
    expect(merged.capabilities).toEqual(['One capability only'])
    expect(merged.expertise).toEqual(['Ten years of load-bearing code'])
  })

  it('keeps the upstream source even when every other field is overridden', () => {
    const merged = effectiveProfileSpec(spec(), { identity: 'mine', summary: 'mine', body: 'mine' })
    expect(merged.source).toEqual(source)
    expect(merged.identity).toBe('mine')
  })

  it('treats a null upstream as the empty spec, so overrides alone still render', () => {
    const merged = effectiveProfileSpec(null, { mission: 'Only this' })
    expect(merged.mission).toBe('Only this')
    expect(merged.capabilities).toEqual([])
    expect(merged.source).toBeNull()
  })

  it('names the overridden fields in PROFILE_SPEC_FIELDS order', () => {
    expect(overriddenFields({ body: 'x', identity: 'y' })).toEqual(['identity', 'body'])
    expect(overriddenFields(null)).toEqual([])
  })
})

describe('renderProfileSpec', () => {
  it('opens with the imported prefix line and carries every section under its label', () => {
    const text = renderProfileSpec(spec())
    expect(text.startsWith('Imported from catalog-m46/engineering/gate-canonical on 2026-09-11;')).toBe(true)
    expect(text).toContain('## Capabilities\n- Design the module boundary')
    expect(text).toContain('## Constraints\n- You MUST never leave a red test behind')
    expect(text).toContain('## In their own words\n# Gate Core Builder')
  })

  it('never prints the suggested runtime role -- that is catalog metadata, not a claim to a model (E3)', () => {
    expect(renderProfileSpec(spec({ runtimeRole: 'wildcard-role' }))).not.toContain('wildcard-role')
  })

  it('writes no prefix line and no heading for a spec with no source and empty fields', () => {
    expect(renderProfileSpec({ ...emptyProfileSpec(), summary: 'Just a line.' })).toBe('## In one line\nJust a line.')
  })

  it('is byte-stable: the same spec renders the same text twice', () => {
    expect(renderProfileSpec(spec())).toBe(renderProfileSpec(spec()))
  })

  it('drops WHOLE sections from the end of the priority order until it fits the cap', () => {
    const huge = 'w'.repeat(240)
    const text = renderProfileSpec(
      spec({
        body: 'b'.repeat(PROFILE_MAX_CHARS),
        collaborationHints: Array.from({ length: 40 }, () => huge),
        recommendedSkills: Array.from({ length: 40 }, () => huge),
      }),
    )
    expect(text.length).toBeLessThanOrEqual(PROFILE_MAX_CHARS)
    // `body` is the LAST entry of the priority order, so it is the first thing to go.
    expect(text).not.toContain('## In their own words')
    // ...and identity, the FIRST entry, survives.
    expect(text).toContain('## Who you are')
  })

  it('hard-slices at the cap when the highest-priority section alone is too long', () => {
    const text = renderProfileSpec({ ...emptyProfileSpec(), identity: 'i'.repeat(PROFILE_MAX_CHARS + 500) })
    expect(text.length).toBe(PROFILE_MAX_CHARS)
  })
})

describe('the label tables', () => {
  it('names every field once, and the priority order is a permutation of the rendered fields', () => {
    expect(Object.keys(PROFILE_FIELD_LABEL).sort()).toEqual([...PROFILE_SPEC_FIELDS].sort())
    expect(Object.keys(PROFILE_FIELD_KIND).sort()).toEqual([...PROFILE_SPEC_FIELDS].sort())
    // `runtimeRole` is a field but not a rendered section (E3): the priority order is the other 13.
    expect([...PROFILE_SECTION_PRIORITY].sort()).toEqual([...PROFILE_SPEC_FIELDS].filter((f) => f !== 'runtimeRole').sort())
  })

  it('builds a source id from the repository and the path', () => {
    expect(profileSourceId(source)).toBe('catalog-m46/engineering/gate-canonical')
  })
})
