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
  read_repo: {
    claude_code: [
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
    ],
    cursor: ['read'],
  },
  write_repo: { claude_code: ['Write', 'Edit', 'NotebookEdit'], cursor: ['edit'] },
  run_commands: {
    claude_code: [
      'Bash',
      'BashOutput',
      'KillShell',
      'Task',
      'TaskStop',
      'Skill',
      'Workflow',
      'SendMessage',
      'EnterWorktree',
      'ExitWorktree',
      'EnterPlanMode',
      'ExitPlanMode',
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
      'RemoteTrigger',
      'PushNotification',
      'ReportFindings',
      'DesignSync',
    ],
    cursor: ['shell'],
  },
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
        // ONE comparator on both sides. `localeCompare` and `Array.sort`'s default code-unit order
        // disagree on names like `LSP` / `ListAgents` / `ListMcpResourcesTool`, which the fix-round
        // toolbox introduced -- a mismatch that made a correct resolver look wrong.
        const byTool = (a: { tool: string }, b: { tool: string }) => a.tool.localeCompare(b.tool)
        const result = resolveDenyList([{ kind: capability, mode: 'deny' }], provider)
        expect([...result].sort(byTool)).toEqual(
          expectedTools.map((tool) => ({ tool, capability })).sort(byTool),
        )
      })
    }
  }

  it('a deny on run_commands denies the whole shell, and deploy_release is no longer part of it', () => {
    // M52 R1: the three shell-backed rows collapsed onto `Bash` and could not be told apart. There
    // is one shell row now, and `deploy_release` is a BROKER grant that names no tool -- which is
    // exactly why `deploy prod` could never be expressed as a tool deny.
    const denied = resolveDenyList([{ kind: 'run_commands', mode: 'deny' }], 'claude_code').map((e) => e.tool)
    expect(denied).toContain('Bash')
    expect(denied).toContain('BashOutput')
    expect(denied).toContain('KillShell')
    // Fix round 1 (the C1 classification): `Task` and `Skill` are the same power as the shell -- a
    // subagent has one, and a skill is instructions about what to run -- so the shell grant covers
    // them and denying it denies them too.
    expect(denied).toContain('Task')
    expect(denied).toContain('Skill')
    expect(resolveDenyList([{ kind: 'deploy_release', mode: 'deny' }], 'claude_code')).toEqual([])
  })

  it('names each denied tool ONCE, whatever order the rows arrive in', () => {
    // M52 fix round 1 (review m2). The old case paired `deploy prod` with `create branch`, two
    // capabilities that both resolved to the shell -- a collision the kinds vocabulary no longer
    // has, since no two kinds share a tool. What is still worth pinning is that the output is a MAP
    // keyed by tool name walked in table order, so two denies produce one entry per tool and the
    // same list either way round. Two rows that really differ, so the assertion can fail.
    const forwards = resolveDenyList(
      [
        { kind: 'run_commands', mode: 'deny' },
        { kind: 'read_repo', mode: 'deny' },
      ],
      'cursor',
    )
    const backwards = resolveDenyList(
      [
        { kind: 'read_repo', mode: 'deny' },
        { kind: 'run_commands', mode: 'deny' },
      ],
      'cursor',
    )
    const byTool = (entries: readonly { tool: string; capability: string }[]) =>
      [...entries].sort((a, b) => a.tool.localeCompare(b.tool))
    expect(byTool(forwards)).toEqual([
      { tool: 'read', capability: 'read_repo' },
      { tool: 'shell', capability: 'run_commands' },
    ])
    // The LIST's order follows the rows (this resolver walks them, not `PERMISSION_KINDS` -- that
    // is `resolveGrants`' property and Task 2's), so the set is what is pinned here, and that each
    // tool appears exactly once.
    expect(byTool(backwards)).toEqual(byTool(forwards))
    expect(new Set(backwards.map((e) => e.tool)).size).toBe(backwards.length)
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
