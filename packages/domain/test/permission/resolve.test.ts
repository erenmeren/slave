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
      { tool: 'ToolSearch', kind: 'read_repo' },
      { tool: 'TaskOutput', kind: 'read_repo' },
      { tool: 'ListAgents', kind: 'read_repo' },
      { tool: 'Monitor', kind: 'read_repo' },
      { tool: 'LSP', kind: 'read_repo' },
      { tool: 'ListMcpResourcesTool', kind: 'read_repo' },
      { tool: 'ReadMcpResourceTool', kind: 'read_repo' },
      { tool: 'ReadMcpResourceDirTool', kind: 'read_repo' },
      { tool: 'Write', kind: 'write_repo' },
      { tool: 'Edit', kind: 'write_repo' },
      { tool: 'NotebookEdit', kind: 'write_repo' },
      { tool: 'Bash', kind: 'run_commands' },
      { tool: 'BashOutput', kind: 'run_commands' },
      { tool: 'KillShell', kind: 'run_commands' },
      { tool: 'Task', kind: 'run_commands' },
      { tool: 'TaskStop', kind: 'run_commands' },
      { tool: 'Skill', kind: 'run_commands' },
      { tool: 'Workflow', kind: 'run_commands' },
      { tool: 'SendMessage', kind: 'run_commands' },
      { tool: 'EnterWorktree', kind: 'run_commands' },
      { tool: 'ExitWorktree', kind: 'run_commands' },
      { tool: 'EnterPlanMode', kind: 'run_commands' },
      { tool: 'ExitPlanMode', kind: 'run_commands' },
      { tool: 'CronCreate', kind: 'run_commands' },
      { tool: 'CronDelete', kind: 'run_commands' },
      { tool: 'CronList', kind: 'run_commands' },
      { tool: 'ScheduleWakeup', kind: 'run_commands' },
      { tool: 'RemoteTrigger', kind: 'run_commands' },
      { tool: 'PushNotification', kind: 'run_commands' },
      { tool: 'ReportFindings', kind: 'run_commands' },
      { tool: 'DesignSync', kind: 'run_commands' },
    ])
  })

  it('gives a planning run READS only -- no Write, no Bash, and no Task or Skill either', () => {
    const tools = resolveGrants([], 'claude_code', 'planning').map((entry) => entry.tool)
    expect(tools).toContain('Read')
    expect(tools).toContain('TaskOutput')
    expect(tools).not.toContain('Write')
    expect(tools).not.toContain('Bash')
    // Fix round 1 (the C1 classification): a subagent has a shell and a skill says what to run, so
    // neither is a read. A planning run that could spawn one would have the shell by the back door.
    expect(tools).not.toContain('Task')
    expect(tools).not.toContain('Skill')
  })

  it('gives a review run reads and commands, and no write', () => {
    const tools = resolveGrants([], 'claude_code', 'review').map((entry) => entry.tool)
    expect(tools).toContain('Bash')
    expect(tools).not.toContain('Write')
  })

  it('adds an allowed kind on top of the baseline', () => {
    const tools = resolveGrants([{ kind: 'network_fetch', mode: 'allow' }], 'claude_code', 'planning').map((e) => e.tool)
    expect(tools).toEqual([
      'Read',
      'Glob',
      'Grep',
      'NotebookRead',
      'TodoWrite',
      'ToolSearch',
      'TaskOutput',
      'ListAgents',
      'Monitor',
      'LSP',
      'ListMcpResourcesTool',
      'ReadMcpResourceTool',
      'ReadMcpResourceDirTool',
      'WebFetch',
      'WebSearch',
    ])
  })

  it('does NOT enumerate the mcp tools a network_fetch grant also opens -- a prefix is not a list', () => {
    // Fix round 1, rule (c): `toolKindFor` governs `mcp__*` by PREFIX, so a granted `network_fetch`
    // opens every MCP server without any of them appearing here. Task 2's gate therefore decides
    // through `toolKindFor`, never by membership of this list alone -- see the hand-off.
    const tools = resolveGrants([{ kind: 'network_fetch', mode: 'allow' }], 'claude_code', 'planning').map((e) => e.tool)
    expect(tools.some((tool) => tool.startsWith('mcp__'))).toBe(false)
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
    expect(tools).toHaveLength(36)
  })

  it('ignores a row whose kind is not one of the six -- the column is typed, a hand-written row is not', () => {
    expect(resolveGrants([{ kind: 'launch_nukes', mode: 'allow' } as never], 'claude_code', 'planning')).toHaveLength(13)
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

  // Fix round 1 (review m7): two rules the report claimed were pinned and were not.
  it('lets the DENY win when two rows name one kind -- a state @@unique forbids, read the safe way', () => {
    const row = grantsFor(
      [
        { kind: 'network_fetch', mode: 'allow', grantedBy: 'someone', grantedAt: '2026-09-12T09:00:00.000Z' },
        { kind: 'network_fetch', mode: 'deny', grantedBy: 'meren', grantedAt: '2026-09-12T10:00:00.000Z' },
      ],
      'implementation',
    ).find((entry) => entry.kind === 'network_fetch')
    expect(row).toEqual({
      kind: 'network_fetch',
      mode: 'deny',
      source: 'refused',
      by: 'meren',
      at: '2026-09-12T10:00:00.000Z',
    })
    // …and the reverse order answers the same thing, which is what "deny wins" has to mean.
    const reversed = grantsFor(
      [
        { kind: 'network_fetch', mode: 'deny', grantedBy: 'meren', grantedAt: '2026-09-12T10:00:00.000Z' },
        { kind: 'network_fetch', mode: 'allow', grantedBy: 'someone', grantedAt: '2026-09-12T09:00:00.000Z' },
      ],
      'implementation',
    ).find((entry) => entry.kind === 'network_fetch')
    expect(reversed?.source).toBe('refused')
  })

  it('calls a deny on a kind the baseline never granted REFUSED, not NEVER -- a person still decided', () => {
    const row = grantsFor([{ kind: 'network_fetch', mode: 'deny' }], 'planning').find(
      (entry) => entry.kind === 'network_fetch',
    )
    expect(row).toEqual({ kind: 'network_fetch', mode: 'deny', source: 'refused', by: null, at: null })
    // …and it takes nothing away, because the baseline had not granted it: a planning run still
    // resolves to exactly its read toolbox.
    expect(resolveGrants([{ kind: 'network_fetch', mode: 'deny' }], 'claude_code', 'planning')).toHaveLength(13)
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
