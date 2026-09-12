import { describe, expect, it } from 'vitest'
import {
  BASELINE_GRANTS,
  ENFORCE_BY_PROVIDER,
  PERMISSION_KINDS,
  PERMISSION_LABEL,
  TOOLS_BY_KIND,
  TOOL_DENIED_LABEL,
  TOOL_VOCABULARY,
  type PermissionKind,
} from '../../src/permission/kinds.js'

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
        claude_code: ['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'Task', 'Skill'],
        cursor: ['read'],
      },
      write_repo: { claude_code: ['Write', 'Edit', 'NotebookEdit'], cursor: ['edit'] },
      run_commands: { claude_code: ['Bash', 'BashOutput', 'KillShell'], cursor: ['shell'] },
      network_fetch: { claude_code: ['WebFetch', 'WebSearch'], cursor: [] },
      read_secret: { claude_code: [], cursor: [] },
      deploy_release: { claude_code: [], cursor: [] },
    })
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

  it('holds exactly the tool names the fixtures actually observe for Claude, so a vendor tool nobody mapped is a RED TEST and not a silent hole', () => {
    // MEASURED, not assumed: these are the `tool_use` names present in the checked-in recordings
    // under `packages/providers/test/fixtures/` (`complete.ndjson`'s Write and Bash,
    // `permission-matrix-deny.ndjson`'s Read and Bash, `claude/skill-tool-use.ndjson`'s Skill).
    // A recording that one day carries a seventh name fails HERE, at a list a person can extend,
    // rather than silently denying a working run once Task 2 inverts the gate.
    for (const observed of ['Read', 'Write', 'Edit', 'Bash', 'Skill']) {
      expect(Object.keys(TOOL_VOCABULARY.claude_code), observed).toContain(observed)
    }
  })

  it('holds the three lowercase Cursor names its own recordings carry', () => {
    expect(Object.keys(TOOL_VOCABULARY.cursor).sort()).toEqual(['edit', 'read', 'shell'])
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
