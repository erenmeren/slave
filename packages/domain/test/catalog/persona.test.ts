import { describe, expect, it } from 'vitest'
import { PROFILE_MAX_CHARS, goalSha256, importedProfilePrefix, parsePersona, personaErrorText, personaToTemplate } from '../../src/index.js'

const GOOD = `---
name: Core Builder
description: Builds the core module and the tests that hold it up.
color: blue
emoji: brick
vibe: Puts the load-bearing parts in first.
tools: Read, Write, Edit
---

# Core Builder

You are **Core Builder**. You write the module everything else stands on, and you write its tests
first.

## How you work
- Small commits, each one green.
`

const MALFORMED = `# Core Builder

There is no front matter here at all, so this file is not a persona.
`

const NO_NAME = `---
description: A persona with no name is not a persona.
---

Body.
`

const IMPORTED_AT = new Date('2026-09-10T08:30:00.000Z')

describe('parsePersona', () => {
  it('reads the name, the description and the body, and keeps every other key in meta', () => {
    const result = parsePersona({ path: 'engineering/core-builder.md', text: GOOD })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.name).toBe('Core Builder')
    expect(result.value.description).toBe('Builds the core module and the tests that hold it up.')
    expect(result.value.meta).toEqual({
      name: 'Core Builder',
      description: 'Builds the core module and the tests that hold it up.',
      color: 'blue',
      emoji: 'brick',
      vibe: 'Puts the load-bearing parts in first.',
      tools: 'Read, Write, Edit',
    })
    // The body is everything after the closing delimiter, trimmed -- and the front matter is NOT
    // part of it: what reaches a prompt is the persona, not its catalog metadata.
    expect(result.value.body.startsWith('# Core Builder')).toBe(true)
    expect(result.value.body).not.toContain('vibe:')
  })

  it('refuses a file with no front matter', () => {
    const result = parsePersona({ path: 'x.md', text: MALFORMED })
    expect(result).toEqual({ ok: false, error: { kind: 'no_front_matter' } })
    expect(personaErrorText({ kind: 'no_front_matter' })).toContain('front matter')
  })

  it('refuses front matter that is never closed', () => {
    const result = parsePersona({ path: 'x.md', text: '---\nname: Half\n' })
    expect(result).toEqual({ ok: false, error: { kind: 'unterminated_front_matter' } })
  })

  it('refuses front matter with no name', () => {
    expect(parsePersona({ path: 'x.md', text: NO_NAME })).toEqual({ ok: false, error: { kind: 'no_name' } })
  })

  it('refuses a persona with front matter and nothing under it', () => {
    expect(parsePersona({ path: 'x.md', text: '---\nname: Empty\n---\n\n   \n' })).toEqual({
      ok: false,
      error: { kind: 'empty_body' },
    })
  })

  it('tolerates a byte-order mark, CRLF line endings and quoted values', () => {
    const result = parsePersona({ path: 'x.md', text: `\u{FEFF}---\r\nname: "Core Builder"\r\n---\r\n\r\nBody.\r\n` })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.name).toBe('Core Builder')
  })
})

describe('personaToTemplate', () => {
  const mapping = { catalog: 'catalog-m42', division: 'engineering', slug: 'core-builder', text: GOOD, importedAt: IMPORTED_AT }

  it("maps a persona onto a template draft, labelling the text as the persona's own", () => {
    const parsed = parsePersona({ path: 'engineering/core-builder.md', text: GOOD })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const result = personaToTemplate(parsed.value, mapping)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sourceId).toBe('catalog-m42/engineering/core-builder')
    expect(result.value.name).toBe('Core Builder')
    // The role is the division: only `manager` and `reviewer` are load-bearing at dispatch, and
    // nothing is inferred from a persona's name (R3).
    expect(result.value.role).toBe('engineering')
    expect(result.value.sourceDivision).toBe('engineering')
    expect(result.value.description).toBe('Builds the core module and the tests that hold it up.')
    expect(result.value.profile.startsWith(importedProfilePrefix('catalog-m42/engineering/core-builder', IMPORTED_AT))).toBe(true)
    expect(result.value.profile).toContain('You write the module everything else stands on')
    expect(result.value.sourceSha256).toBe(goalSha256(GOOD))
    expect(result.value.profileSha256).toBe(goalSha256(result.value.profile))
  })

  it('translates the role through a role map', () => {
    const parsed = parsePersona({ path: 'x.md', text: GOOD })
    if (!parsed.ok) throw new Error('fixture')
    const result = personaToTemplate(parsed.value, { ...mapping, roleMap: { engineering: 'backend' } })
    expect(result.ok && result.value.role).toBe('backend')
  })

  it('falls back to vibe when there is no description', () => {
    const text = GOOD.replace('description: Builds the core module and the tests that hold it up.\n', '')
    const parsed = parsePersona({ path: 'x.md', text })
    if (!parsed.ok) throw new Error('fixture')
    const result = personaToTemplate(parsed.value, { ...mapping, text })
    expect(result.ok && result.value.description).toBe('Puts the load-bearing parts in first.')
  })

  it('refuses a persona whose COMPOSED profile is over the cap, and measures the composed length', () => {
    // The cap is the one `buildRunContext` re-checks at dispatch against the STORED text, prefix
    // line included -- a body that only just fits under 16k would otherwise import cleanly and make
    // every worker materialised from it undispatchable (erratum E3).
    const filler = 'The core module holds the rest of the system up. '
    const body = filler.repeat(Math.ceil(PROFILE_MAX_CHARS / filler.length))
    const text = `---\nname: Long One\n---\n\n${body}`
    const parsed = parsePersona({ path: 'x.md', text })
    if (!parsed.ok) throw new Error('fixture')

    const result = personaToTemplate(parsed.value, { ...mapping, slug: 'long-one', text })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('profile_too_long')
    expect(result.error.limit).toBe(PROFILE_MAX_CHARS)
    expect(result.error.length).toBeGreaterThan(PROFILE_MAX_CHARS)
    expect(result.error.length).toBeGreaterThan(parsed.value.body.length)
  })

  it('accepts a composed profile of EXACTLY the cap, and refuses one character over it', () => {
    // The comparison is `> PROFILE_MAX_CHARS`, not `>=` -- a persona whose composed profile lands
    // on the cap exactly is not over it. Built from the real prefix rather than a hand-counted
    // constant: `importedProfilePrefix`'s length depends on the sourceId and the date, and a
    // hand-counted body would silently drift the moment either changed.
    const build = (targetLength: number, slug: string): ReturnType<typeof personaToTemplate> => {
      const sourceId = `${mapping.catalog}/${mapping.division}/${slug}`
      const prefixLength = importedProfilePrefix(sourceId, mapping.importedAt).length
      const bodyLength = targetLength - prefixLength - '\n\n'.length
      const body = 'x'.repeat(bodyLength)
      const text = `---\nname: Boundary\n---\n\n${body}`
      const parsed = parsePersona({ path: 'x.md', text })
      if (!parsed.ok) throw new Error('fixture')
      return personaToTemplate(parsed.value, { ...mapping, slug, text })
    }

    const atCap = build(PROFILE_MAX_CHARS, 'boundary-at-cap')
    expect(atCap.ok).toBe(true)
    if (atCap.ok) expect(atCap.value.profile.length).toBe(PROFILE_MAX_CHARS)

    const overCap = build(PROFILE_MAX_CHARS + 1, 'boundary-over-cap')
    expect(overCap.ok).toBe(false)
    if (!overCap.ok) {
      expect(overCap.error.kind).toBe('profile_too_long')
      expect(overCap.error.length).toBe(PROFILE_MAX_CHARS + 1)
    }
  })
})
