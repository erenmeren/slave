import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PERMISSION_KINDS, type PermissionKind } from '@slave-of-ai/domain'
import { PERMISSION_DENY_REASON_PREFIX } from '@slave-of-ai/providers'
import { resolveDenyList } from '../src/permission.js'

const PROVIDERS = ['claude_code', 'cursor'] as const

// The wire-level tool names each OPERATION covers, per provider -- `[]` for the two BROKER grants,
// which name no vendor tool on either provider (M52 R1/R3). Kept as a plain table here so each row
// below reads as one fact instead of re-deriving it from the domain's `TOOLS_BY_KIND`.
const EXPECTED: Record<PermissionKind, { claude_code: readonly string[]; cursor: readonly string[] }> = {
  read_repo: { claude_code: ['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'Task', 'Skill'], cursor: ['read'] },
  write_repo: { claude_code: ['Write', 'Edit', 'NotebookEdit'], cursor: ['edit'] },
  run_commands: { claude_code: ['Bash', 'BashOutput', 'KillShell'], cursor: ['shell'] },
  network_fetch: { claude_code: ['WebFetch', 'WebSearch'], cursor: [] },
  read_secret: { claude_code: [], cursor: [] },
  deploy_release: { claude_code: [], cursor: [] },
}

describe('resolveDenyList', () => {
  for (const capability of PERMISSION_KINDS) {
    for (const provider of PROVIDERS) {
      const expectedTools = EXPECTED[capability][provider]
      it(`resolves '${capability}' deny → ${provider === 'claude_code' ? 'Claude' : 'Cursor'} ${
        expectedTools.length > 0 ? expectedTools.join('/') : '(nothing -- a broker grant, not a tool grant)'
      }`, () => {
        const result = resolveDenyList([{ kind: capability, mode: 'deny' }], provider)
        expect([...result].sort((a, b) => a.tool.localeCompare(b.tool))).toEqual(
          [...expectedTools].sort().map((tool) => ({ tool, capability })),
        )
      })
    }
  }

  it('a deny on run_commands denies the whole shell, and deploy_release is no longer part of it', () => {
    // M52 R1: the three shell-backed rows collapsed onto `Bash` and could not be told apart. There
    // is one shell row now, and `deploy_release` is a BROKER grant that names no tool -- which is
    // exactly why `deploy prod` could never be expressed as a tool deny.
    expect(resolveDenyList([{ kind: 'run_commands', mode: 'deny' }], 'claude_code')).toEqual([
      { tool: 'Bash', capability: 'run_commands' },
      { tool: 'BashOutput', capability: 'run_commands' },
      { tool: 'KillShell', capability: 'run_commands' },
    ])
    expect(resolveDenyList([{ kind: 'deploy_release', mode: 'deny' }], 'claude_code')).toEqual([])
  })

  it('the reverse order still keeps the first row seen as the naming capability', () => {
    // Two kinds that share no tool cannot collide any more, so the "first capability wins" rule is
    // exercised where it still has a job: one kind named twice.
    const result = resolveDenyList(
      [
        { kind: 'run_commands', mode: 'deny' },
        { kind: 'run_commands', mode: 'deny' },
      ],
      'cursor',
    )
    expect(result).toEqual([{ tool: 'shell', capability: 'run_commands' }])
  })

  it('allow and unset rows are ignored -- only deny rows produce entries', () => {
    const result = resolveDenyList(
      [
        { kind: 'read_repo', mode: 'allow' },
        { kind: 'write_repo', mode: 'deny' },
      ],
      'claude_code',
    )
    expect(result).toEqual([
      { tool: 'Write', capability: 'write_repo' },
      { tool: 'Edit', capability: 'write_repo' },
      { tool: 'NotebookEdit', capability: 'write_repo' },
    ])
  })

  it('a read_secret deny resolves to an empty list -- it is a broker grant, and always was', () => {
    expect(resolveDenyList([{ kind: 'read_secret', mode: 'deny' }], 'claude_code')).toEqual([])
    expect(resolveDenyList([{ kind: 'read_secret', mode: 'deny' }], 'cursor')).toEqual([])
  })

  it('an unknown kind string resolves to an empty list (defensive -- the caller may hand rows unvalidated against PERMISSION_KINDS)', () => {
    expect(resolveDenyList([{ kind: 'launch nukes', mode: 'deny' }], 'claude_code')).toEqual([])
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
