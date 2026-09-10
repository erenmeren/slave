import { describe, expect, it } from 'vitest'
import {
  MAPPING_QUALITY_LABEL,
  PROFILE_FIELD_KIND,
  PROFILE_FIELD_LABEL,
  PROFILE_MAX_CHARS,
  PROFILE_OVERRIDABLE_FIELDS,
  PROFILE_SECTION_PRIORITY,
  PROFILE_SPEC_FIELDS,
  effectiveProfileSpec,
  emptyProfileSpec,
  importedProfilePrefix,
  overriddenFields,
  profileOverridesSchema,
  profileSourceId,
  profileSpecSchema,
  renderProfileSpec,
  sliceCodePoints,
  type ProfileOverrides,
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

  it('refuses an importedAt that is not an ISO datetime -- the renderer turns it into a date (E21)', () => {
    expect(profileSpecSchema.safeParse(spec({ source: { ...source, importedAt: 'yesterday' } })).success).toBe(false)
    expect(profileSpecSchema.safeParse(spec({ source: { ...source, importedAt: '2026-09-11' } })).success).toBe(false)
    expect(profileSpecSchema.safeParse(spec({ source: { ...source, importedAt: new Date().toISOString() } })).success).toBe(true)
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

  it('refuses `runtimeRole` as an unrecognised key -- it is catalog metadata, not a control (E21)', () => {
    const parsed = profileOverridesSchema.safeParse({ runtimeRole: 'engineering' })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.code).toBe('unrecognized_keys')
    }
    expect(PROFILE_OVERRIDABLE_FIELDS).not.toContain('runtimeRole')
    expect([...PROFILE_OVERRIDABLE_FIELDS]).toEqual([...PROFILE_SPEC_FIELDS].filter((f) => f !== 'runtimeRole'))
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

  it('IGNORES a runtimeRole smuggled into a hand-edited overrides column (E21)', () => {
    const merged = effectiveProfileSpec(spec(), { runtimeRole: 'wildcard' } as unknown as ProfileOverrides)
    expect(merged.runtimeRole).toBe('engineering')
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

  // The docblock's own claim, pinned (final wave, deferred minor): a spec with nothing at all in
  // it renders the source's prefix line and stops. There are no words to withhold, and the line
  // naming the file is still true.
  it('renders the lone prefix line for a blank spec that has a source, and nothing at all without one', () => {
    expect(renderProfileSpec({ ...emptyProfileSpec(), source })).toBe(
      importedProfilePrefix(profileSourceId(source), new Date(source.importedAt)),
    )
    expect(renderProfileSpec(emptyProfileSpec())).toBe('')
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
    expect(text).toContain('## Who you are')
  })

  it('NEVER returns an empty string when a section that is not the first one overflows (E21)', () => {
    // `mission` is third in the priority order and the only field with anything in it. The old
    // prefix-keep loop answered this with '': an empty prompt where a persona should be.
    const missionOnly = renderProfileSpec({ ...emptyProfileSpec(), mission: 'm'.repeat(PROFILE_MAX_CHARS + 500) })
    expect(missionOnly.length).toBe(PROFILE_MAX_CHARS)
    expect(missionOnly.startsWith('## Mission')).toBe(true)

    const withSource = renderProfileSpec(
      spec({
        ...emptyProfileSpec(),
        mission: 'm'.repeat(PROFILE_MAX_CHARS + 500),
        source,
      }),
    )
    expect(withSource.length).toBe(PROFILE_MAX_CHARS)
    expect(withSource.startsWith('Imported from catalog-m46/')).toBe(true)
    // Not just the prefix line: the persona's own words have to reach the model too.
    expect(withSource).toContain('## Mission')
  })

  it('SKIPS one oversized mid-priority section and keeps the shorter ones beneath it (E21)', () => {
    const text = renderProfileSpec(
      spec({
        constraints: ['c'.repeat(PROFILE_MAX_CHARS)],
        successCriteria: ['Every commit green'],
        recommendedSkills: ['writing-plans'],
        body: 'A short closing word.',
      }),
    )
    expect(text.length).toBeLessThanOrEqual(PROFILE_MAX_CHARS)
    expect(text).not.toContain('## Constraints')
    expect(text).toContain('## Who you are')
    expect(text).toContain('## Success criteria\n- Every commit green')
    expect(text).toContain('## Recommended skills\n- writing-plans')
    expect(text).toContain('## In their own words\nA short closing word.')
  })

  it('cuts on a code-point boundary, so a hard slice never leaves half an emoji (E21)', () => {
    // The 16 000th code UNIT lands between the two halves of the emoji.
    const identity = `${'i'.repeat(PROFILE_MAX_CHARS - '## Who you are\n'.length - 1)}\u{1F600}tail`
    const text = renderProfileSpec({ ...emptyProfileSpec(), identity })
    expect(text.length).toBe(PROFILE_MAX_CHARS - 1)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false)
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false)
  })
})

describe('sliceCodePoints', () => {
  it('leaves a string under the limit alone and never splits a surrogate pair', () => {
    expect(sliceCodePoints('short', 10)).toBe('short')
    expect(sliceCodePoints('abcdef', 3)).toBe('abc')
    // 'ab' + a 2-unit emoji: a cut at 3 would keep only the high surrogate.
    expect(sliceCodePoints('ab\u{1F600}cd', 3)).toBe('ab')
    expect(sliceCodePoints('ab\u{1F600}cd', 4)).toBe('ab\u{1F600}')
  })
})

describe('the label tables', () => {
  it('names every field once, and the priority order is a permutation of the rendered fields', () => {
    expect(Object.keys(PROFILE_FIELD_LABEL).sort()).toEqual([...PROFILE_SPEC_FIELDS].sort())
    expect(Object.keys(PROFILE_FIELD_KIND).sort()).toEqual([...PROFILE_SPEC_FIELDS].sort())
    // `runtimeRole` is a field but not a rendered section (E3): the priority order is the other 13.
    expect([...PROFILE_SECTION_PRIORITY].sort()).toEqual([...PROFILE_SPEC_FIELDS].filter((f) => f !== 'runtimeRole').sort())
  })

  it('fixes the thirteen rendered sections in one written-down order', () => {
    // Written out rather than derived: the ORDER is the argument (what a worker cannot do its job
    // without), so a reordering has to be a deliberate edit to this line.
    expect([...PROFILE_SECTION_PRIORITY]).toEqual([
      'identity',
      'summary',
      'mission',
      'constraints',
      'operatingPrinciples',
      'capabilities',
      'expertise',
      'workflow',
      'deliverables',
      'successCriteria',
      'collaborationHints',
      'recommendedSkills',
      'body',
    ])
  })

  it('gives every field the editor its shape needs, and every mapping quality a sentence', () => {
    expect(PROFILE_FIELD_KIND).toEqual({
      identity: 'text',
      summary: 'text',
      mission: 'text',
      runtimeRole: 'text',
      capabilities: 'list',
      expertise: 'list',
      operatingPrinciples: 'list',
      constraints: 'list',
      workflow: 'list',
      deliverables: 'list',
      successCriteria: 'list',
      collaborationHints: 'list',
      recommendedSkills: 'list',
      body: 'text',
    })
    // docs/ia.md rule 3: never a bare enum member on a surface.
    expect(MAPPING_QUALITY_LABEL).toEqual({ full: 'mapped in full', partial: 'partly mapped', none: 'not mapped' })
    for (const label of Object.values(MAPPING_QUALITY_LABEL)) expect(label).not.toMatch(/^(full|partial|none)$/)
    expect(PROFILE_FIELD_LABEL.body).toBe('In their own words')
  })

  it('builds a source id from the repository and the path', () => {
    expect(profileSourceId(source)).toBe('catalog-m46/engineering/gate-canonical')
  })
})
