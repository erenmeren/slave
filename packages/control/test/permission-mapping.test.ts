import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PERMISSION_DENY_REASON_PREFIX } from '@ai-team-os/providers'
import { PERMISSION_TOOLS, resolveDenyList } from '../src/permission.js'

const PROVIDERS = ['claude_code', 'cursor'] as const

// The wire-level tool name each capability resolves to, per provider -- `[]` for
// `read secrets` (unenforced in v1, spec §2). Kept as a plain table here so each row below
// reads as one fact instead of re-deriving it from `CAPABILITY_TOOLS` (package-private).
const EXPECTED: Record<(typeof PERMISSION_TOOLS)[number], { claude_code: readonly string[]; cursor: readonly string[] }> = {
  'repo read': { claude_code: ['Read'], cursor: ['read'] },
  'source write': { claude_code: ['Write', 'Edit', 'NotebookEdit'], cursor: ['edit'] },
  'run tests': { claude_code: ['Bash'], cursor: ['shell'] },
  'create branch': { claude_code: ['Bash'], cursor: ['shell'] },
  'deploy prod': { claude_code: ['Bash'], cursor: ['shell'] },
  'read secrets': { claude_code: [], cursor: [] },
}

describe('resolveDenyList', () => {
  for (const capability of PERMISSION_TOOLS) {
    for (const provider of PROVIDERS) {
      const expectedTools = EXPECTED[capability][provider]
      it(`resolves '${capability}' deny → ${provider === 'claude_code' ? 'Claude' : 'Cursor'} ${
        expectedTools.length > 0 ? expectedTools.join('/') : '(nothing, unenforced)'
      }`, () => {
        const result = resolveDenyList([{ tool: capability, mode: 'deny' }], provider)
        expect([...result].sort((a, b) => a.tool.localeCompare(b.tool))).toEqual(
          [...expectedTools].sort().map((tool) => ({ tool, capability })),
        )
      })
    }
  }

  it('a deny on both run tests and deploy prod resolves to ONE Bash entry -- the first capability wins', () => {
    const result = resolveDenyList(
      [
        { tool: 'run tests', mode: 'deny' },
        { tool: 'deploy prod', mode: 'deny' },
      ],
      'claude_code',
    )
    expect(result).toEqual([{ tool: 'Bash', capability: 'run tests' }])
  })

  it('the reverse order still keeps the first row seen as the naming capability', () => {
    const result = resolveDenyList(
      [
        { tool: 'deploy prod', mode: 'deny' },
        { tool: 'create branch', mode: 'deny' },
      ],
      'cursor',
    )
    expect(result).toEqual([{ tool: 'shell', capability: 'deploy prod' }])
  })

  it('allow and unset rows are ignored -- only deny rows produce entries', () => {
    const result = resolveDenyList(
      [
        { tool: 'repo read', mode: 'allow' },
        { tool: 'source write', mode: 'deny' },
      ],
      'claude_code',
    )
    expect(result).toEqual([
      { tool: 'Write', capability: 'source write' },
      { tool: 'Edit', capability: 'source write' },
      { tool: 'NotebookEdit', capability: 'source write' },
    ])
  })

  it("a 'read secrets' deny resolves to an empty list -- unenforced in v1", () => {
    expect(resolveDenyList([{ tool: 'read secrets', mode: 'deny' }], 'claude_code')).toEqual([])
    expect(resolveDenyList([{ tool: 'read secrets', mode: 'deny' }], 'cursor')).toEqual([])
  })

  it('an unknown capability string resolves to an empty list (defensive -- the caller may hand rows unvalidated against PERMISSION_TOOLS)', () => {
    expect(resolveDenyList([{ tool: 'launch nukes', mode: 'deny' }], 'claude_code')).toEqual([])
  })

  it('no rows at all resolves to an empty list', () => {
    expect(resolveDenyList([], 'claude_code')).toEqual([])
  })

  // Task 2 creates `scripts/lib/permissions.sh` -- pinned here, byte-equal, against the TS
  // constant so neither spelling can drift alone.
  it('the shell helper spells the deny prefix exactly as the TS constant', () => {
    const lib = readFileSync('scripts/lib/permissions.sh', 'utf8')
    expect(lib).toContain(PERMISSION_DENY_REASON_PREFIX)
  })
})
