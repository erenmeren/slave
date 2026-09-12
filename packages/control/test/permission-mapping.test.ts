import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MCP_TOOL_PREFIX,
  PERMISSION_KINDS,
  PERMISSION_RUN_KINDS,
  type PermissionKind,
  type PermissionProvider,
  type PermissionRunKind,
} from '@slave-of-ai/domain'
import { PERMISSION_DENY_REASON_PREFIX } from '@slave-of-ai/providers'
import { writePermissionsFile } from '../src/permission.js'

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

/** The v2 verdict `writePermissionsFile` wrote, read straight back off disk. */
interface Verdict {
  readonly version: number
  readonly runId: string
  readonly tokenHash: string
  readonly enforce: string
  readonly grants: readonly string[]
  readonly allow: readonly { readonly tool: string; readonly kind: string }[]
  readonly vocabulary: Readonly<Record<string, string>>
  readonly prefixes: readonly { readonly prefix: string; readonly kind: string }[]
}

const TOKEN = 'f'.repeat(64)

function write(
  rows: readonly { readonly kind: string; readonly mode: 'allow' | 'deny' }[],
  provider: PermissionProvider,
  runKind: PermissionRunKind = 'implementation',
): { readonly verdict: Verdict; readonly path: string } {
  const runDir = mkdtempSync(join(tmpdir(), 'slaveofai-permissions-v2-'))
  const path = writePermissionsFile(runDir, { rows, provider, runKind, runId: 'run-1', runToken: TOKEN })
  return { verdict: JSON.parse(readFileSync(path, 'utf8')) as Verdict, path }
}

// M52 R2: the file is an ALLOW list, so the per-kind fact this file has always pinned is now read
// off the DENIED direction of it -- a denied kind takes exactly its own tools off the list, and
// nothing else moves. The table above is the same table; only the assertion's side changed.
describe('writePermissionsFile: which tools each operation covers, per provider', () => {
  for (const kind of PERMISSION_KINDS) {
    for (const provider of PROVIDERS) {
      const expectedTools = EXPECTED[kind][provider]
      it(`'${kind}' denied → ${provider === 'claude_code' ? 'Claude' : 'Cursor'} loses ${
        expectedTools.length > 0 ? expectedTools.join('/') : '(nothing -- a broker grant, not a tool grant)'
      }`, () => {
        // Everything granted, then this one kind refused: the difference between the two allow
        // lists is exactly the tools this kind covers.
        const allKinds = PERMISSION_KINDS.map((k) => ({ kind: k, mode: 'allow' as const }))
        const withAll = write(allKinds, provider).verdict
        const withoutOne = write(
          allKinds.map((row) => (row.kind === kind ? { kind, mode: 'deny' as const } : row)),
          provider,
        ).verdict
        const lost = withAll.allow.filter((entry) => !withoutOne.allow.some((kept) => kept.tool === entry.tool))
        const byTool = (a: { tool: string }, b: { tool: string }): number => a.tool.localeCompare(b.tool)
        expect([...lost].sort(byTool)).toEqual([...expectedTools].map((tool) => ({ tool, kind })).sort(byTool))
        // And the kind itself leaves the granted set, which is what the gate actually decides on.
        expect(withAll.grants).toContain(kind)
        expect(withoutOne.grants).not.toContain(kind)
      })
    }
  }

  it('a deny on run_commands denies the whole shell, and deploy_release is no longer part of it', () => {
    // M52 R1: the three shell-backed rows collapsed onto `Bash` and could not be told apart. There
    // is one shell row now, and `deploy_release` is a BROKER grant that names no tool -- which is
    // exactly why `deploy prod` could never be expressed as a tool deny.
    const denied = write([{ kind: 'run_commands', mode: 'deny' }], 'claude_code').verdict
    const tools = denied.allow.map((entry) => entry.tool)
    expect(tools).not.toContain('Bash')
    expect(tools).not.toContain('BashOutput')
    expect(tools).not.toContain('KillShell')
    // Fix round 1 (the C1 classification): `Task` and `Skill` are the same power as the shell -- a
    // subagent has one, and a skill is instructions about what to run -- so the shell grant covers
    // them and denying it denies them too.
    expect(tools).not.toContain('Task')
    expect(tools).not.toContain('Skill')
    // The read tools are untouched: a denied kind takes its own tools and no others.
    expect(tools).toContain('Read')
    // `deploy_release` grants no tool however it resolves, so granting it changes no allow list.
    const withDeploy = write([{ kind: 'deploy_release', mode: 'allow' }], 'claude_code').verdict
    const baseline = write([], 'claude_code').verdict
    expect(withDeploy.allow).toEqual(baseline.allow)
    expect(withDeploy.grants).toContain('deploy_release')
  })

  it('names each allowed tool ONCE, in a deterministic order, whatever order the rows arrive in', () => {
    const forwards = write(
      [
        { kind: 'run_commands', mode: 'allow' },
        { kind: 'read_repo', mode: 'allow' },
      ],
      'cursor',
    ).verdict
    const backwards = write(
      [
        { kind: 'read_repo', mode: 'allow' },
        { kind: 'run_commands', mode: 'allow' },
      ],
      'cursor',
    ).verdict
    // BYTE-EQUAL either way round, not merely the same set: `resolveGrants` walks
    // `PERMISSION_KINDS` and then `TOOLS_BY_KIND`, never the rows, so the same matrix produces the
    // same file however Postgres returned them.
    expect(backwards.allow).toEqual(forwards.allow)
    expect(new Set(forwards.allow.map((entry) => entry.tool)).size).toBe(forwards.allow.length)
  })

  it('a deny beats an allow for the same kind, in either row order', () => {
    for (const rows of [
      [
        { kind: 'run_commands', mode: 'allow' as const },
        { kind: 'run_commands', mode: 'deny' as const },
      ],
      [
        { kind: 'run_commands', mode: 'deny' as const },
        { kind: 'run_commands', mode: 'allow' as const },
      ],
    ]) {
      const verdict = write(rows, 'claude_code').verdict
      expect(verdict.grants).not.toContain('run_commands')
      expect(verdict.allow.map((entry) => entry.tool)).not.toContain('Bash')
    }
  })

  it('a read_secret grant puts no tool on the list -- it is a broker grant, and always was', () => {
    for (const provider of PROVIDERS) {
      const verdict = write([{ kind: 'read_secret', mode: 'allow' }], provider).verdict
      expect(verdict.allow.some((entry) => entry.kind === 'read_secret')).toBe(false)
      expect(verdict.grants).toContain('read_secret')
    }
  })

  it('an unknown kind string contributes nothing (defensive -- rows may arrive unvalidated)', () => {
    const verdict = write([{ kind: 'launch nukes', mode: 'allow' }], 'claude_code').verdict
    expect(verdict.allow).toEqual(write([], 'claude_code').verdict.allow)
    expect(verdict.grants).toEqual(write([], 'claude_code').verdict.grants)
  })
})

describe('writePermissionsFile: the file IS the verdict (M52 R2/R4)', () => {
  it('writes version 2 with the run, its token hash, the granted kinds, the vocabulary and the prefixes', () => {
    const { verdict } = write([], 'claude_code')
    expect(verdict.version).toBe(2)
    expect(verdict.runId).toBe('run-1')
    // The HASH, never the plaintext (erratum E7): the token exists in exactly one child's
    // environment and nowhere on disk.
    expect(verdict.tokenHash).toBe(createHash('sha256').update(TOKEN).digest('hex'))
    expect(JSON.stringify(verdict)).not.toContain(TOKEN)
    expect(verdict.enforce).toBe('all-tools')
    expect(verdict.vocabulary['Bash']).toBe('run_commands')
    // The one name family no allow list can enumerate (erratum E16): one `network_fetch` grant has
    // to open every MCP tool, and a prefix entry is how the shell can answer that.
    expect(verdict.prefixes).toEqual([{ prefix: MCP_TOOL_PREFIX, kind: 'network_fetch' }])
    expect(verdict.allow.some((entry) => entry.tool.startsWith(MCP_TOOL_PREFIX))).toBe(false)
  })

  it("says 'known-tools' for Cursor, which is the measured limitation stated in data (E3)", () => {
    expect(write([], 'cursor').verdict.enforce).toBe('known-tools')
    expect(Object.keys(write([], 'cursor').verdict.vocabulary).sort()).toEqual(['edit', 'read', 'shell'])
  })

  it('resolves a different baseline per run kind, and says so in `grants`', () => {
    expect(write([], 'claude_code', 'implementation').verdict.grants).toEqual([
      'read_repo',
      'write_repo',
      'run_commands',
    ])
    expect(write([], 'claude_code', 'review').verdict.grants).toEqual(['read_repo', 'run_commands'])
    expect(write([], 'claude_code', 'planning').verdict.grants).toEqual(['read_repo'])
    // A planning run cannot spawn a subagent: `Task` and `Skill` are `run_commands` (fix round 1),
    // which the planning baseline does not carry.
    const planning = write([], 'claude_code', 'planning').verdict.allow.map((entry) => entry.tool)
    expect(planning).not.toContain('Task')
    expect(planning).not.toContain('Skill')
    expect(planning).toContain('Read')
  })

  it('covers every run kind -- a fourth one would fail this loop rather than resolve silently', () => {
    for (const runKind of PERMISSION_RUN_KINDS) {
      expect(write([], 'claude_code', runKind).verdict.grants.length).toBeGreaterThan(0)
    }
  })

  it('writes the file 0600 -- the verdict that governs a worker is not world-readable (D15)', () => {
    expect(statSync(write([], 'claude_code').path).mode & 0o777).toBe(0o600)
  })

  it('every tool on the allow list carries the kind the vocabulary says governs it', () => {
    const verdict = write(
      PERMISSION_KINDS.map((kind) => ({ kind, mode: 'allow' as const })),
      'claude_code',
    ).verdict
    for (const entry of verdict.allow) {
      expect(verdict.vocabulary[entry.tool], entry.tool).toBe(entry.kind)
      expect(verdict.grants, entry.tool).toContain(entry.kind)
    }
  })
})

describe('the shell twin', () => {
  // The deny prefix, pinned byte-equal against the TS constant so neither spelling can drift alone.
  it('the shell helper spells the deny prefix exactly as the TS constant', () => {
    const lib = readFileSync('scripts/lib/permissions.sh', 'utf8')
    expect(lib).toContain(PERMISSION_DENY_REASON_PREFIX)
  })
})
