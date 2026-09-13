import { describe, expect, it } from 'vitest'
import { PROVIDER_KINDS, PROVIDER_LABEL, type ProviderKind } from '../../src/provider/kind.js'
import { RUNTIME_EVENT_KINDS, type RuntimeEventKind } from '../../src/provider/events.js'
import type { ModelOption } from '../../src/provider/models.js'

describe('ProviderKind (R2)', () => {
  it('is exactly the two configured provider kinds, in the Postgres enum order', () => {
    // The same two members, in the same order, as `packages/db/prisma/schema.prisma`'s
    // `enum ProviderKind` -- `enum-parity.test.ts` compares the SORTED lists, and this pins the
    // spelling a reviewer reads in a diff (the reason `packages/providers/test/types.test.ts:11`
    // gives for its own copy of this line, which stays where it is).
    expect(PROVIDER_KINDS).toEqual(['claude_code', 'cursor'])
  })

  it('gives every kind a WORD, and never the key itself (docs/ia.md rule 3)', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(PROVIDER_LABEL[kind], kind).toBeTruthy()
      expect(PROVIDER_LABEL[kind], kind).not.toBe(kind)
    }
    expect(PROVIDER_LABEL).toEqual({ claude_code: 'Claude Code', cursor: 'Cursor' })
  })

  it('is a total record, so a third kind is a build error here rather than a bare enum member on a card', () => {
    const labels: Record<ProviderKind, string> = PROVIDER_LABEL
    expect(Object.keys(labels).sort()).toEqual([...PROVIDER_KINDS].sort())
  })
})

describe('RuntimeEventKind (erratum E1)', () => {
  it('is the thirteen variants of `RuntimeEvent`, in the union’s own order', () => {
    expect(RUNTIME_EVENT_KINDS).toEqual([
      'session_started',
      'tool_call',
      'tool_result',
      'usage',
      'text',
      'hook_started',
      'hook_denied',
      'hook_crashed',
      'hook_failed_open',
      'permission_denied',
      'terminated',
      'ignored',
      'unparsable',
    ])
  })

  it('carries the two that are PARSER artefacts and not a vendor’s events', () => {
    // `ignored` is a recognised line this parser does not act on and `unparsable` is one it could
    // not read at all (`packages/providers/src/types.ts:73-77`). No manifest may list either --
    // `manifest.test.ts` asserts that from the other side -- but the union has to carry them,
    // because `RuntimeEvent['kind']` does and this list is pinned to it.
    expect(RUNTIME_EVENT_KINDS).toContain('ignored')
    expect(RUNTIME_EVENT_KINDS).toContain('unparsable')
  })

  it('has no duplicate member', () => {
    expect(new Set<RuntimeEventKind>(RUNTIME_EVENT_KINDS).size).toBe(RUNTIME_EVENT_KINDS.length)
  })
})

describe('ModelOption (erratum E2)', () => {
  it('is the three fields the providers package declared, and nothing else', () => {
    // A structural assertion, because the type is erased: a fourth REQUIRED field would fail to
    // compile here, which is the point -- `packages/providers/src/models.ts` re-exports this type
    // and `ModelListing.models` is an array of it.
    const option: ModelOption = { id: 'default', label: "default (the CLI's current default)", default: true }
    const minimal: ModelOption = { id: 'opus', label: 'opus (latest Opus)' }
    expect(Object.keys(option).sort()).toEqual(['default', 'id', 'label'])
    expect(Object.keys(minimal).sort()).toEqual(['id', 'label'])
  })
})
