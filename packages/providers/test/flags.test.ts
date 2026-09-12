import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeFlags, preflightGate } from '../src/claude/flags.js'
import { copyGateInto } from './helpers/gate-fixture.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const realGate = path.join(repoRoot, 'scripts/pause-gate.sh')

// preflightGate mints its own temporary flag file internally (see flags.ts) rather than
// taking a caller-supplied path, so a leftover-file check has to look at its known prefix
// in the OS temp directory rather than at a path the tests control.
const PREFLIGHT_TMP_PREFIX = 'slaveofai-preflight-'

function preflightTmpDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(PREFLIGHT_TMP_PREFIX))
}

describe('claudeFlags', () => {
  it('includes every mandatory flag and neither forbidden one', () => {
    const flags = claudeFlags({ settingsPath: '/abs/s.json' })
    expect(flags).toEqual(
      expect.arrayContaining([
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
        '--settings',
        '/abs/s.json',
        '--include-hook-events',
      ]),
    )
    expect(flags).not.toContain('--no-session-persistence')
    expect(flags).not.toContain('--fork-session')
  })

  it('refuses a relative settings path', () => {
    expect(() => claudeFlags({ settingsPath: 'rel/s.json' })).toThrow(/absolute/)
  })
})

describe('preflightGate', () => {
  let dir: string
  let hookPath: string
  let alwaysDenyHook: string

  beforeEach(() => {
    expect(existsSync(realGate)).toBe(true)
    dir = mkdtempSync(path.join(tmpdir(), 'slaveofai-preflight-fixture-'))

    // A fresh executable copy of the real gate, per test -- some tests
    // mutate its permissions, and the repo's own copy of the script must
    // not be touched by that. The helper copies `scripts/lib/pause-flag.sh`
    // into `<dir>/lib/` too: M13 §4.2 moved the JSON encoder and the pause-flag
    // read there, and a gate copied without its library refuses to run at all.
    hookPath = copyGateInto(dir, 'pause-gate.sh')

    alwaysDenyHook = path.join(dir, 'always-deny.sh')
    writeFileSync(
      alwaysDenyHook,
      [
        '#!/usr/bin/env bash',
        'cat > /dev/null',
        'printf \'%s\\n\' \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"nope"}}\'',
        'exit 0',
        '',
      ].join('\n'),
    )
    chmodSync(alwaysDenyHook, 0o755)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('preflight rejects a hook path that does not exist', async (): Promise<void> => {
    await expect(preflightGate({ hookPath: '/nope/hook.sh' })).rejects.toThrow()
  })

  it('preflight rejects a hook that is present but not executable', async (): Promise<void> => {
    chmodSync(hookPath, 0o644)
    await expect(preflightGate({ hookPath })).rejects.toThrow()
  })

  it('preflight rejects a hook that denies unconditionally', async (): Promise<void> => {
    // Both directions, not one. The real pause-gate.sh emits deny JSON and exits 0 when
    // SLAVEOFAI_PAUSE_FLAG is unset -- its deliberate loud-misconfiguration path -- so a
    // check asserting only "flag present => deny" passes a hook that gates nothing through
    // by denying everything, and the run accomplishes nothing while looking armed.
    await expect(preflightGate({ hookPath: alwaysDenyHook })).rejects.toThrow()
  })

  it('preflight accepts a hook that discriminates', async (): Promise<void> => {
    await expect(preflightGate({ hookPath })).resolves.toBeUndefined()
  })

  // preflightGate's signature no longer accepts a caller-supplied flag path at all
  // (see flags.ts) -- passing one is now a compile error, verified by `tsc --build` on
  // every run of this suite, not by a runtime assertion here.

  // M52 erratum E1, the load-bearing one: under default-deny, a permissions file in the
  // ORCHESTRATOR's own environment would answer the pre-flight's disarmed probe with a DENY, the
  // pre-flight would read that as "this hook denies unconditionally", and every spawn on the
  // machine would fail. `runGateScript` deletes the variable (and the run token with it), so the
  // probe measures the pause gate and nothing else -- whatever an operator's shell exported.
  it('passes with a permissions file armed in this process that would deny everything', async (): Promise<void> => {
    const permissionsFile = path.join(dir, 'permissions.json')
    writeFileSync(
      permissionsFile,
      JSON.stringify({
        version: 2,
        runId: 'someone-elses-run',
        tokenHash: 'f'.repeat(64),
        enforce: 'all-tools',
        grants: [],
        allow: [],
        vocabulary: {},
        prefixes: [],
      }),
    )
    const previousFile = process.env['SLAVEOFAI_PERMISSIONS_FILE']
    const previousToken = process.env['SLAVEOFAI_RUN_TOKEN']
    process.env['SLAVEOFAI_PERMISSIONS_FILE'] = permissionsFile
    process.env['SLAVEOFAI_RUN_TOKEN'] = 'a'.repeat(64)
    try {
      await expect(preflightGate({ hookPath })).resolves.toBeUndefined()
    } finally {
      if (previousFile === undefined) delete process.env['SLAVEOFAI_PERMISSIONS_FILE']
      else process.env['SLAVEOFAI_PERMISSIONS_FILE'] = previousFile
      if (previousToken === undefined) delete process.env['SLAVEOFAI_RUN_TOKEN']
      else process.env['SLAVEOFAI_RUN_TOKEN'] = previousToken
    }
  })

  it('leaves no temp directory behind, in success and in every rejection path', async (): Promise<void> => {
    const before = preflightTmpDirs()

    await preflightGate({ hookPath })
    await expect(preflightGate({ hookPath: '/nope/hook.sh' })).rejects.toThrow()
    await expect(preflightGate({ hookPath: alwaysDenyHook })).rejects.toThrow()

    expect(preflightTmpDirs()).toEqual(before)
  })
})
