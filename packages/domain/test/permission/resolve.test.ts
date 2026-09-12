import { describe, expect, it } from 'vitest'
import { grantsFor, resolveGrants } from '../../src/permission/resolve.js'

const NOBODY: readonly { readonly kind: 'read_repo'; readonly mode: 'allow' }[] = []

describe('resolveGrants', () => {
  it('gives a fresh implementation run exactly the baseline toolbox, with nobody having decided anything', () => {
    expect(resolveGrants([], 'claude_code', 'implementation')).toEqual([
      { tool: 'Read', kind: 'read_repo' },
      { tool: 'Glob', kind: 'read_repo' },
      { tool: 'Grep', kind: 'read_repo' },
      { tool: 'NotebookRead', kind: 'read_repo' },
      { tool: 'TodoWrite', kind: 'read_repo' },
      { tool: 'Task', kind: 'read_repo' },
      { tool: 'Skill', kind: 'read_repo' },
      { tool: 'Write', kind: 'write_repo' },
      { tool: 'Edit', kind: 'write_repo' },
      { tool: 'NotebookEdit', kind: 'write_repo' },
      { tool: 'Bash', kind: 'run_commands' },
      { tool: 'BashOutput', kind: 'run_commands' },
      { tool: 'KillShell', kind: 'run_commands' },
    ])
  })

  it('gives a planning run READS only -- no Write, no Bash', () => {
    const tools = resolveGrants([], 'claude_code', 'planning').map((entry) => entry.tool)
    expect(tools).toContain('Read')
    expect(tools).not.toContain('Write')
    expect(tools).not.toContain('Bash')
  })

  it('gives a review run reads and commands, and no write', () => {
    const tools = resolveGrants([], 'claude_code', 'review').map((entry) => entry.tool)
    expect(tools).toContain('Bash')
    expect(tools).not.toContain('Write')
  })

  it('adds an allowed kind on top of the baseline', () => {
    const tools = resolveGrants([{ kind: 'network_fetch', mode: 'allow' }], 'claude_code', 'planning').map((e) => e.tool)
    expect(tools).toEqual(['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'Task', 'Skill', 'WebFetch', 'WebSearch'])
  })

  it('DENY WINS over the baseline -- a refusal is a person overruling the default, not a no-op', () => {
    const tools = resolveGrants([{ kind: 'run_commands', mode: 'deny' }], 'claude_code', 'implementation').map((e) => e.tool)
    expect(tools).not.toContain('Bash')
    expect(tools).toContain('Write')
  })

  it('deny wins over an allow row for the same kind, whatever order the rows arrive in', () => {
    const rows = [
      { kind: 'run_commands', mode: 'allow' },
      { kind: 'run_commands', mode: 'deny' },
    ] as const
    expect(resolveGrants(rows, 'claude_code', 'implementation').map((e) => e.tool)).not.toContain('Bash')
    expect(resolveGrants([...rows].reverse(), 'claude_code', 'implementation').map((e) => e.tool)).not.toContain('Bash')
  })

  it('resolves the Cursor vocabulary, lowercase, for the same rows', () => {
    expect(resolveGrants([], 'cursor', 'implementation')).toEqual([
      { tool: 'read', kind: 'read_repo' },
      { tool: 'edit', kind: 'write_repo' },
      { tool: 'shell', kind: 'run_commands' },
    ])
  })

  it('puts NO tool on the list for the two broker grants, granted or not -- they are not tool grants', () => {
    const tools = resolveGrants(
      [
        { kind: 'read_secret', mode: 'allow' },
        { kind: 'deploy_release', mode: 'allow' },
      ],
      'claude_code',
      'implementation',
    ).map((entry) => entry.tool)
    expect(tools).toHaveLength(13)
  })

  it('ignores a row whose kind is not one of the six -- the column is typed, a hand-written row is not', () => {
    expect(resolveGrants([{ kind: 'launch_nukes', mode: 'allow' } as never], 'claude_code', 'planning')).toHaveLength(7)
  })

  it('is order-stable: the same rows in any order produce a byte-equal list', () => {
    const a = resolveGrants(
      [
        { kind: 'network_fetch', mode: 'allow' },
        { kind: 'write_repo', mode: 'deny' },
      ],
      'claude_code',
      'implementation',
    )
    const b = resolveGrants(
      [
        { kind: 'write_repo', mode: 'deny' },
        { kind: 'network_fetch', mode: 'allow' },
      ],
      'claude_code',
      'implementation',
    )
    expect(a).toEqual(b)
  })

  it('takes no rows at all and still resolves -- an empty table is every fresh install', () => {
    expect(resolveGrants(NOBODY, 'claude_code', 'review').length).toBeGreaterThan(0)
  })
})

describe('grantsFor', () => {
  it('answers all six kinds, in PERMISSION_KINDS order, whatever rows exist', () => {
    const rows = grantsFor([], 'implementation')
    expect(rows.map((row) => row.kind)).toEqual([
      'read_repo',
      'write_repo',
      'run_commands',
      'network_fetch',
      'read_secret',
      'deploy_release',
    ])
  })

  it('calls a baseline kind BASELINE, with no person and no date -- nobody decided it', () => {
    const row = grantsFor([], 'implementation').find((entry) => entry.kind === 'run_commands')
    expect(row).toEqual({ kind: 'run_commands', mode: null, source: 'baseline', by: null, at: null })
  })

  it('calls a kind outside the baseline with no row NEVER -- the third glyph, and the honest one', () => {
    const row = grantsFor([], 'planning').find((entry) => entry.kind === 'run_commands')
    expect(row).toEqual({ kind: 'run_commands', mode: null, source: 'never', by: null, at: null })
  })

  it('names who granted and when', () => {
    const row = grantsFor(
      [{ kind: 'network_fetch', mode: 'allow', grantedBy: 'meren', grantedAt: '2026-09-12T10:00:00.000Z' }],
      'implementation',
    ).find((entry) => entry.kind === 'network_fetch')
    expect(row).toEqual({
      kind: 'network_fetch',
      mode: 'allow',
      source: 'granted',
      by: 'meren',
      at: '2026-09-12T10:00:00.000Z',
    })
  })

  it('names a REFUSAL as a refusal even when the baseline would have granted it -- the person overruled the default', () => {
    const row = grantsFor(
      [{ kind: 'run_commands', mode: 'deny', grantedBy: 'meren', grantedAt: '2026-09-12T10:00:00.000Z' }],
      'implementation',
    ).find((entry) => entry.kind === 'run_commands')
    expect(row?.source).toBe('refused')
    expect(row?.mode).toBe('deny')
  })

  it('agrees with resolveGrants on every kind: granted or baseline iff the kind put tools on the list', () => {
    const rows = [
      { kind: 'network_fetch', mode: 'allow' },
      { kind: 'write_repo', mode: 'deny' },
    ] as const
    const allowed = new Set(resolveGrants(rows, 'claude_code', 'implementation').map((entry) => entry.kind))
    for (const row of grantsFor(rows, 'implementation')) {
      const effective = row.source === 'granted' || row.source === 'baseline'
      const hasTools = allowed.has(row.kind)
      // The two broker kinds put no tool on the list however they resolve, so they are exempt from
      // this correspondence and asserted separately above.
      if (row.kind !== 'read_secret' && row.kind !== 'deploy_release') {
        expect(hasTools, row.kind).toBe(effective)
      }
    }
  })
})
