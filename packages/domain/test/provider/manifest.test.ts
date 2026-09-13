import { describe, expect, it } from 'vitest'
import { PERMISSION_KINDS } from '../../src/permission/kinds.js'
import { PROVIDER_KINDS, type ProviderKind } from '../../src/provider/kind.js'
import { PARSER_EVENT_KINDS, RUNTIME_EVENT_KINDS } from '../../src/provider/events.js'
import {
  PROVIDER_MANIFESTS,
  SKILL_TOOL,
  manifestFor,
  providerManifestSchema,
  providerRunsSkills,
} from '../../src/provider/manifest.js'
import { CLAUDE_CODE_MODELS } from '../../src/provider/claude-code.js'

const AXES = [
  'kind',
  'invocation',
  'modelDiscovery',
  'resume',
  'pause',
  'events',
  'structuredOutput',
  'toolRestrictions',
  'toolVocabulary',
  'usageCost',
  'hooks',
  'runFiles',
  'measured',
  'differences',
] as const

describe('PROVIDER_MANIFESTS (R3)', () => {
  it('has exactly the members of PROVIDER_KINDS, so a third provider is a build error here first', () => {
    expect(Object.keys(PROVIDER_MANIFESTS).sort()).toEqual([...PROVIDER_KINDS].sort())
  })

  it('carries all fourteen axes on every row, and no fifteenth', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(Object.keys(PROVIDER_MANIFESTS[kind]).sort(), kind).toEqual([...AXES].sort())
    }
  })

  it('validates against its own schema, which is what the gate re-runs from the built module', () => {
    for (const kind of PROVIDER_KINDS) {
      const parsed = providerManifestSchema.safeParse(PROVIDER_MANIFESTS[kind])
      expect(parsed.success, `${kind}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true)
    }
  })

  it('says which kind it is, in its own row, so a copied row cannot pass for another', () => {
    for (const kind of PROVIDER_KINDS) expect(manifestFor(kind).kind).toBe(kind)
  })

  it('states at least one limitation per provider -- one with none is one nobody measured', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(manifestFor(kind).differences.length, kind).toBeGreaterThan(0)
      for (const sentence of manifestFor(kind).differences) expect(sentence.trim(), kind).not.toBe('')
    }
  })

  it('records the binary VERSION every row was measured against, which is the rule the widening one rests on', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(manifestFor(kind).measured.version, kind).toMatch(/\S/)
      expect(manifestFor(kind).measured.date, kind).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('names a binary and never holds a path or a secret', () => {
    for (const kind of PROVIDER_KINDS) {
      const { binary, binEnvVar, argsEnvVar } = manifestFor(kind).invocation
      expect(binary, kind).not.toContain('/')
      // The `SLAVEOFAI_<PROVIDER>_BIN` convention, declared ONCE here instead of being spelled at
      // four sites in three files (R6). The pair always agree on their stem, which is what lets
      // `buildAdapterRegistry`'s loop read both off the manifest.
      expect(binEnvVar, kind).toMatch(/^SLAVEOFAI_[A-Z]+_BIN$/)
      expect(argsEnvVar, kind).toBe(binEnvVar.replace(/_BIN$/, '_ARGS'))
    }
  })

  it('declares a tool vocabulary for every permission kind, and none for the two broker grants', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(Object.keys(manifestFor(kind).toolVocabulary).sort(), kind).toEqual([...PERMISSION_KINDS].sort())
      expect(manifestFor(kind).toolVocabulary.read_secret, kind).toEqual([])
      expect(manifestFor(kind).toolVocabulary.deploy_release, kind).toEqual([])
    }
  })

  it('produces only real event kinds, and never a parser artefact', () => {
    for (const kind of PROVIDER_KINDS) {
      for (const produced of manifestFor(kind).events.produces) {
        expect(RUNTIME_EVENT_KINDS, `${kind}: ${produced}`).toContain(produced)
        expect(PARSER_EVENT_KINDS as readonly string[], `${kind}: ${produced}`).not.toContain(produced)
      }
    }
  })

  it('declares exactly two run-file channels, both persisted, until Checkpoint gains a Json column (R7)', () => {
    for (const kind of PROVIDER_KINDS) {
      const runFiles = manifestFor(kind).runFiles
      expect(runFiles.channels, kind).toHaveLength(2)
      expect(runFiles.persisted, kind).toHaveLength(2)
      for (const name of runFiles.persisted) expect(runFiles.channels, kind).toContain(name)
    }
  })

  it('cites an ADR anchor for its pause rung, and never invents a fourth rung', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(['hook', 'signal', 'none'], kind).toContain(manifestFor(kind).pause.rung)
      expect(manifestFor(kind).pause.adr, kind).toMatch(/^docs\/decisions\/0001-pause-semantics\.md#[a-z0-9-]+$/)
    }
  })

  it('refuses a kind nothing declares, rather than answering undefined', () => {
    expect(() => manifestFor('codex' as ProviderKind)).toThrow(/codex/)
  })
})

describe('the Claude Code row (R3)', () => {
  const manifest = manifestFor('claude_code')

  it('is `claude`, prompted by a flag, with the two flags ADR 0001 forbids named as forbidden', () => {
    expect(manifest.invocation.binary).toBe('claude')
    expect(manifest.invocation.binEnvVar).toBe('SLAVEOFAI_CLAUDE_BIN')
    expect(manifest.invocation.argsEnvVar).toBe('SLAVEOFAI_CLAUDE_ARGS')
    expect(manifest.invocation.promptDelivery).toBe('flag')
    expect(manifest.invocation.headlessFlags).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--include-hook-events',
    ])
    expect(manifest.invocation.neverPass).toEqual(['--no-session-persistence', '--fork-session'])
    expect(manifest.invocation.cwd).toBe('worktree')
    expect(manifest.invocation.envAllowlist).toBe('CHILD_ENV_ALLOW')
  })

  it('configures its models rather than listing them, and the table is the one the CLI accepts', () => {
    expect(manifest.modelDiscovery.mode).toBe('configured')
    if (manifest.modelDiscovery.mode !== 'configured') throw new Error('unreachable')
    expect(manifest.modelDiscovery.options).toBe(CLAUDE_CODE_MODELS)
    expect(manifest.modelDiscovery.options.map((model) => model.id).slice(0, 5)).toEqual([
      'default',
      'fable',
      'opus',
      'sonnet',
      'haiku',
    ])
  })

  it('resumes by session id, on --resume, and never forks one', () => {
    expect(manifest.resume).toEqual({ mode: 'session_id', flag: '--resume', neverPass: ['--fork-session'] })
  })

  it('sits on ADR 0001’s hook rung, produces eleven kinds, and reports what it spent', () => {
    expect(manifest.pause.rung).toBe('hook')
    expect(manifest.events.transport).toBe('stream_json')
    expect([...manifest.events.produces].sort()).toEqual(
      [...RUNTIME_EVENT_KINDS].filter((kind) => !(PARSER_EVENT_KINDS as readonly string[]).includes(kind)).sort(),
    )
    expect(manifest.usageCost).toBe('reported')
  })

  it('gates every tool through a hook and enforces the whole matrix', () => {
    expect(manifest.toolRestrictions).toEqual({ mechanism: 'hook_gate', enforce: 'all-tools' })
    expect(manifest.hooks).toEqual(['pre_tool_use', 'post_tool_use'])
  })

  it('gets a schema-conformant answer by ASKING for one, like everything else in this tree (R8)', () => {
    expect(manifest.structuredOutput).toBe('prompted')
  })
})

describe('the Cursor row (R3)', () => {
  const manifest = manifestFor('cursor')

  it('is `cursor-agent`, prompted positionally, with six flags that look safe and are not', () => {
    expect(manifest.invocation.binary).toBe('cursor-agent')
    expect(manifest.invocation.binEnvVar).toBe('SLAVEOFAI_CURSOR_BIN')
    expect(manifest.invocation.argsEnvVar).toBe('SLAVEOFAI_CURSOR_ARGS')
    expect(manifest.invocation.promptDelivery).toBe('positional')
    expect(manifest.invocation.headlessFlags).toEqual(['--print', '--output-format', 'stream-json', '--trust', '--force'])
    expect(manifest.invocation.neverPass).toEqual([
      '-w',
      '--worktree',
      '--stream-partial-output',
      '--yolo',
      '--plan',
      '--mode',
    ])
  })

  it('lists its models from the account, by running `cursor-agent models`', () => {
    expect(manifest.modelDiscovery.mode).toBe('listed')
    if (manifest.modelDiscovery.mode !== 'listed') throw new Error('unreachable')
    expect(manifest.modelDiscovery.argv).toEqual(['models'])
  })

  it('resumes by session id and never by "the previous session"', () => {
    expect(manifest.resume).toEqual({ mode: 'session_id', flag: '--resume', neverPass: ['--continue'] })
  })

  it('sits on the signal rung, produces six kinds, and reports no cost at all', () => {
    expect(manifest.pause.rung).toBe('signal')
    expect(manifest.events.transport).toBe('stream_json')
    expect([...manifest.events.produces].sort()).toEqual(
      ['permission_denied', 'session_started', 'terminated', 'text', 'tool_call', 'tool_result'].sort(),
    )
    expect(manifest.events.produces).not.toContain('usage')
    for (const hookEvent of ['hook_started', 'hook_denied', 'hook_crashed', 'hook_failed_open']) {
      expect(manifest.events.produces, hookEvent).not.toContain(hookEvent)
    }
    expect(manifest.usageCost).toBe('unmeasured')
  })

  it('gates through a hook and can only enforce the names it can trust', () => {
    expect(manifest.toolRestrictions).toEqual({ mechanism: 'hook_gate', enforce: 'known-tools' })
    expect(manifest.hooks).toEqual(['pre_tool_use', 'before_shell_execution'])
  })

  it('says in words that its refusal is a BUDGET refusal and not an output-shape one (R8)', () => {
    expect(manifest.structuredOutput).toBe('prompted')
    expect(manifest.differences.join(' ')).toContain('it reports no cost, so a cap cannot be enforced')
  })
})

describe('providerRunsSkills (erratum E7)', () => {
  it('is true for the provider whose governed toolbox names the Skill tool, and false for the other', () => {
    expect(SKILL_TOOL).toBe('Skill')
    expect(providerRunsSkills('claude_code')).toBe(true)
    expect(providerRunsSkills('cursor')).toBe(false)
  })

  it('is the manifest’s own answer, not a second list of the two', () => {
    expect(providerRunsSkills('claude_code')).toBe(
      manifestFor('claude_code').toolVocabulary.run_commands.includes(SKILL_TOOL),
    )
  })
})
