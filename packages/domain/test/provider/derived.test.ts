import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ENFORCE_BY_PROVIDER,
  PERMISSION_KINDS,
  PERMISSION_PROVIDERS,
  TOOLS_BY_KIND,
  TOOL_VOCABULARY,
  toolKindFor,
} from '../../src/permission/kinds.js'
import { PROVIDER_KINDS } from '../../src/provider/kind.js'
import { manifestFor } from '../../src/provider/manifest.js'

/** The goldens `scripts/fixtures/m56a-goldens/` captured from the tree BEFORE this milestone
 *  edited anything. Read from disk rather than transcribed, so this file cannot drift from the
 *  bytes the gate compares against. */
const golden = (name: string): unknown => JSON.parse(readFileSync(`scripts/fixtures/m56a-goldens/${name}`, 'utf8'))

describe('PERMISSION_PROVIDERS (R2)', () => {
  it('is the same list under the same name -- `enum-parity.test.ts` still reads it', () => {
    expect(PERMISSION_PROVIDERS).toEqual(['claude_code', 'cursor'])
  })

  it('IS `PROVIDER_KINDS`, not a list that agrees with it', () => {
    expect(PERMISSION_PROVIDERS).toBe(PROVIDER_KINDS)
  })
})

describe('TOOLS_BY_KIND (R5)', () => {
  it('is byte for byte the table this milestone found', () => {
    expect(TOOLS_BY_KIND).toEqual(golden('tools-by-kind.json'))
  })

  it('holds each manifest’s OWN array, so a vocabulary cannot be edited in two places', () => {
    for (const kind of PERMISSION_KINDS) {
      for (const provider of PROVIDER_KINDS) {
        expect(TOOLS_BY_KIND[kind][provider], `${kind}.${provider}`).toBe(manifestFor(provider).toolVocabulary[kind])
      }
    }
  })

  it('keeps its shape: every permission kind, every provider, in both directions', () => {
    expect(Object.keys(TOOLS_BY_KIND).sort()).toEqual([...PERMISSION_KINDS].sort())
    for (const kind of PERMISSION_KINDS) {
      expect(Object.keys(TOOLS_BY_KIND[kind]).sort(), kind).toEqual([...PROVIDER_KINDS].sort())
    }
  })
})

describe('TOOL_VOCABULARY and toolKindFor (R5: untouched, and asserted so)', () => {
  it('still derives from TOOLS_BY_KIND and still answers for every governed name', () => {
    for (const provider of PROVIDER_KINDS) {
      for (const kind of PERMISSION_KINDS) {
        for (const tool of TOOLS_BY_KIND[kind][provider]) {
          expect(TOOL_VOCABULARY[provider][tool], `${provider}.${tool}`).toBe(kind)
          expect(toolKindFor(provider, tool), `${provider}.${tool}`).toBe(kind)
        }
      }
    }
  })

  it('still resolves an MCP name by prefix on both providers, and an unknown one to null', () => {
    for (const provider of PROVIDER_KINDS) {
      expect(toolKindFor(provider, 'mcp__acme__search')).toBe('network_fetch')
      expect(toolKindFor(provider, 'SomethingNobodyGoverns')).toBeNull()
    }
  })
})

describe('ENFORCE_BY_PROVIDER (R5)', () => {
  it('is the table this milestone found', () => {
    expect(ENFORCE_BY_PROVIDER).toEqual(golden('enforce-by-provider.json'))
    expect(ENFORCE_BY_PROVIDER).toEqual({ claude_code: 'all-tools', cursor: 'known-tools' })
  })

  it('is the manifest’s own answer, one field away', () => {
    for (const provider of PROVIDER_KINDS) {
      expect(ENFORCE_BY_PROVIDER[provider], provider).toBe(manifestFor(provider).toolRestrictions.enforce)
    }
  })
})
