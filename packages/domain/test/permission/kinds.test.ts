import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_GRANTS,
  ENFORCE_BY_PROVIDER,
  MCP_TOOL_PREFIX,
  PERMISSION_KINDS,
  PERMISSION_LABEL,
  PERMISSION_RUN_KINDS,
  TOOLS_BY_KIND,
  TOOL_DENIED_LABEL,
  TOOL_VOCABULARY,
  toolKindFor,
  type PermissionKind,
} from '../../src/permission/kinds.js'

/**
 * The toolbox the REAL `claude` CLI advertised, read out of this repository's own recording rather
 * than typed here (M52 fix round 1, review I1).
 *
 * `system`/`init` is the first line of every Claude stream and carries `tools` -- the whole toolbox
 * the CLI offered that run, which is what `claudeFlags` leaves unrestricted
 * (`packages/providers/src/claude/flags.ts` passes no `--allowedTools`). Derived, so a recaptured
 * fixture that gains a name makes THIS test red instead of silently denying a working run once
 * Task 2 inverts the gate. A hand-typed list could only fail when a name was REMOVED, which is how
 * eighteen ungoverned names got past the first cut of this file.
 */
function advertisedTools(): readonly string[] {
  const first = readFileSync('packages/providers/test/fixtures/complete.ndjson', 'utf8').split('\n')[0] ?? ''
  const init = JSON.parse(first) as { type?: string; subtype?: string; tools?: unknown }
  expect(init.type, 'the fixture\u2019s first line is the system/init line').toBe('system')
  expect(init.subtype).toBe('init')
  expect(Array.isArray(init.tools)).toBe(true)
  return init.tools as readonly string[]
}

describe('PERMISSION_KINDS', () => {
  it('is the closed list of OPERATIONS a worker may be granted, in the order a person grants them', () => {
    expect(PERMISSION_KINDS).toEqual([
      'read_repo',
      'write_repo',
      'run_commands',
      'network_fetch',
      'read_secret',
      'deploy_release',
    ])
  })

  it('has no duplicates -- the list is the union, so a repeat would type-check and lie', () => {
    expect(new Set(PERMISSION_KINDS).size).toBe(PERMISSION_KINDS.length)
  })

  it('gives every kind a word, so no surface ever prints the key (docs/ia.md rule 3)', () => {
    for (const kind of PERMISSION_KINDS) {
      expect(PERMISSION_LABEL[kind], kind).toMatch(/^[A-Z]/u)
      expect(PERMISSION_LABEL[kind], kind).not.toContain('_')
    }
  })

  it('says what each operation IS, not what its key spells', () => {
    expect(PERMISSION_LABEL).toEqual({
      read_repo: 'Read the repository',
      write_repo: 'Write source',
      run_commands: 'Run commands',
      network_fetch: 'Fetch over the network',
      read_secret: 'Read a secret',
      deploy_release: 'Deploy a release',
    })
  })
})

describe('TOOLS_BY_KIND', () => {
  it('names the FULL governed toolbox per kind per provider -- an allowlist, not the old denylist', () => {
    expect(TOOLS_BY_KIND).toEqual({
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
    })
  })

  it('puts the two tools that SPAWN work under the shell grant, not under the read grant', () => {
    // `Task` spawns a worker that has Bash, and `Skill` loads instructions that tell one what to
    // run: a grant that let a worker do either without letting it run a command would be a grant
    // that does not mean what it says (fix round 1, the C1 classification).
    expect(TOOL_VOCABULARY.claude_code['Task']).toBe('run_commands')
    expect(TOOL_VOCABULARY.claude_code['Skill']).toBe('run_commands')
  })

  it('gives the two BROKER-ONLY kinds no vendor tool on either provider, which is why `deploy prod` could never be a tool deny', () => {
    for (const provider of ['claude_code', 'cursor'] as const) {
      expect(TOOLS_BY_KIND.read_secret[provider]).toEqual([])
      expect(TOOLS_BY_KIND.deploy_release[provider]).toEqual([])
    }
  })

  it('never maps one tool to two kinds -- a tool with two governors has no single verdict', () => {
    for (const provider of ['claude_code', 'cursor'] as const) {
      const all = PERMISSION_KINDS.flatMap((kind) => TOOLS_BY_KIND[kind][provider])
      expect(new Set(all).size, provider).toBe(all.length)
    }
  })
})

describe('TOOL_VOCABULARY', () => {
  it('is DERIVED from TOOLS_BY_KIND, never a second list -- tool name to the kind that governs it', () => {
    for (const provider of ['claude_code', 'cursor'] as const) {
      for (const kind of PERMISSION_KINDS) {
        for (const tool of TOOLS_BY_KIND[kind][provider]) {
          expect(TOOL_VOCABULARY[provider][tool], `${provider} ${tool}`).toBe(kind)
        }
      }
    }
  })

  it('holds the three lowercase Cursor names its own recordings carry', () => {
    expect(Object.keys(TOOL_VOCABULARY.cursor).sort()).toEqual(['edit', 'read', 'shell'])
  })
})

describe('the tripwire: every tool the recording advertises is governed (fix round 1, I1)', () => {
  it('reads a toolbox of 68 names out of the fixture, so the assertions below are about real data', () => {
    expect(advertisedTools().length).toBeGreaterThan(0)
  })

  it('governs EVERY non-mcp name the real CLI offered -- an ungoverned one is a wall Task 2 would build', () => {
    // The failure this replaces: a hand-typed five-name list stayed green while eighteen advertised
    // names -- `TaskOutput` among them, without which a `Task` call cannot be read back -- were
    // governed by nothing at all.
    const ungoverned = advertisedTools()
      .filter((tool) => !tool.startsWith(MCP_TOOL_PREFIX))
      .filter((tool) => TOOL_VOCABULARY.claude_code[tool] === undefined)
    expect(ungoverned, 'add each to TOOLS_BY_KIND, or rule on it deliberately').toEqual([])
  })

  it('resolves EVERY mcp name through the PREFIX rule rather than through 41 literals', () => {
    const mcp = advertisedTools().filter((tool) => tool.startsWith(MCP_TOOL_PREFIX))
    expect(mcp.length).toBeGreaterThan(0)
    for (const tool of mcp) {
      expect(toolKindFor('claude_code', tool), tool).toBe('network_fetch')
      // and NOT by being in the table: a future MCP server must be governed without a table edit.
      expect(TOOL_VOCABULARY.claude_code[tool], tool).toBeUndefined()
    }
  })

  it('resolves every advertised name to SOME kind, which is the whole property R1 states', () => {
    for (const tool of advertisedTools()) {
      expect(toolKindFor('claude_code', tool), tool).not.toBeNull()
    }
  })
})

describe('toolKindFor', () => {
  it('answers the table first, for both providers', () => {
    expect(toolKindFor('claude_code', 'Bash')).toBe('run_commands')
    expect(toolKindFor('claude_code', 'Read')).toBe('read_repo')
    expect(toolKindFor('cursor', 'shell')).toBe('run_commands')
  })

  it('answers `network_fetch` for anything under the mcp prefix, on either provider', () => {
    expect(toolKindFor('claude_code', 'mcp__anything__at_all')).toBe('network_fetch')
    expect(toolKindFor('cursor', 'mcp__anything__at_all')).toBe('network_fetch')
  })

  it('answers a server nobody has ever installed, which is the point of a prefix rule', () => {
    expect(toolKindFor('claude_code', 'mcp__from_the_future__do_a_thing')).toBe('network_fetch')
  })

  it('answers null for a tool nobody governs -- the `ungoverned_tool` reason, not a kind', () => {
    expect(toolKindFor('claude_code', 'SomethingNobodyMapped')).toBeNull()
    expect(toolKindFor('claude_code', '')).toBeNull()
  })

  it('does not treat a name that merely CONTAINS the prefix as an mcp tool', () => {
    expect(toolKindFor('claude_code', 'Notmcp__x')).toBeNull()
  })

  it('agrees with TOOL_VOCABULARY on every governed name, for both providers', () => {
    for (const provider of ['claude_code', 'cursor'] as const) {
      for (const [tool, kind] of Object.entries(TOOL_VOCABULARY[provider])) {
        expect(toolKindFor(provider, tool), `${provider} ${tool}`).toBe(kind)
      }
    }
  })
})

describe('PERMISSION_RUN_KINDS (fix round 1, m6)', () => {
  it('is the three run kinds a baseline is keyed on, in the Prisma enum\u2019s own order', () => {
    expect(PERMISSION_RUN_KINDS).toEqual(['implementation', 'review', 'planning'])
  })

  it('is exactly what BASELINE_GRANTS answers for -- a fourth member with no list would be a deny-all baseline', () => {
    expect(Object.keys(BASELINE_GRANTS).sort()).toEqual([...PERMISSION_RUN_KINDS].sort())
    for (const runKind of PERMISSION_RUN_KINDS) {
      expect(BASELINE_GRANTS[runKind], runKind).toBeDefined()
    }
  })
})

describe('BASELINE_GRANTS', () => {
  it('is what a run of each kind may do before anybody has decided anything', () => {
    expect(BASELINE_GRANTS).toEqual({
      implementation: ['read_repo', 'write_repo', 'run_commands'],
      review: ['read_repo', 'run_commands'],
      planning: ['read_repo'],
    })
  })

  it('never contains a broker-only kind -- a baseline is about TOOLS, and a credential is never a default', () => {
    for (const kinds of Object.values(BASELINE_GRANTS)) {
      expect(kinds).not.toContain('read_secret')
      expect(kinds).not.toContain('deploy_release')
    }
  })

  it('is ordered as PERMISSION_KINDS is, so a resolved allow list is byte-equal run to run', () => {
    for (const [runKind, kinds] of Object.entries(BASELINE_GRANTS)) {
      const indexes = kinds.map((kind) => PERMISSION_KINDS.indexOf(kind as PermissionKind))
      expect([...indexes].sort((a, b) => a - b), runKind).toEqual(indexes)
    }
  })
})

describe('ENFORCE_BY_PROVIDER', () => {
  it('enforces every tool on Claude and only the ones it can NAME on Cursor (plan erratum E3)', () => {
    expect(ENFORCE_BY_PROVIDER).toEqual({ claude_code: 'all-tools', cursor: 'known-tools' })
  })
})

describe('TOOL_DENIED_LABEL', () => {
  it('gives every kind AND the ungoverned-tool reason a word -- the card prints this, never the key', () => {
    for (const kind of PERMISSION_KINDS) expect(TOOL_DENIED_LABEL[kind]).toBe(PERMISSION_LABEL[kind])
    expect(TOOL_DENIED_LABEL.ungoverned_tool).toBe('A tool nobody governs')
  })
})
