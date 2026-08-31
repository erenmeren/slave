import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { copyGateInto } from './helpers/gate-fixture.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const gatePath = path.join(repoRoot, 'scripts/pause-gate.sh')

interface RunHookOptions {
  readonly flagExists?: boolean
  // Written verbatim as the pause flag file's content -- the hook reads its deny reason from
  // there (Fix Round 1: an environment variable can't carry it, because the child's environment
  // is fixed at spawn time and the reason is only known later, when the operator pauses).
  // Omitted or `undefined` leaves the flag file empty, which is the hook's own fallback to its
  // static default message.
  readonly reason?: string
  // Present with value `undefined` means "unset AITEAMOS_PAUSE_FLAG entirely" -- distinct from
  // omitting the key, which means "use this test's own generated flag path". Detected below via
  // `'flagVar' in options`, not via `options.flagVar === undefined`, so the two are distinguishable.
  readonly flagVar?: string | undefined
  // The script to spawn, when it is deliberately NOT the repo's own copy -- used by the
  // deployment tests below, which need a gate at a path they control.
  readonly gateOverride?: string
  // Written to stdin as the hook payload (`hook_payload=$(cat)`, M18 Task 3). Omitted leaves
  // stdin empty, exactly as every pre-M18 test here already relies on: an empty payload has no
  // `tool_name`, so `read_permission_verdict` allows regardless of what a permissions file says.
  readonly payload?: string
  // Sets AITEAMOS_PERMISSIONS_FILE for the child. Omitted deletes it from the child's environment
  // entirely (not merely "leaves it unset in this test file's own process") -- the permission
  // matrix must stay completely out of the picture for every pre-M18-shaped test in this file.
  readonly permissionsFile?: string
}

interface RunHookResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
}

/**
 * Spawns the real `scripts/pause-gate.sh` directly (not through the `claude` CLI), the same way
 * `preflightGate` in `../src/claude/flags.ts` does, and the same way Claude Code itself would:
 * default piped stdio, closed immediately after writing `options.payload` (if any) so the
 * script's `hook_payload=$(cat)` capture does not hang.
 */
function runHook(options: RunHookOptions = {}): Promise<RunHookResult> {
  const dir = mkdtempSync(path.join(tmpdir(), 'aiteamos-pause-gate-test-'))
  const flagPath = path.join(dir, 'pause.flag')
  const flagExists = options.flagExists ?? true

  if (flagExists) {
    writeFileSync(flagPath, options.reason ?? '')
  }

  const env: Record<string, string | undefined> = { ...process.env }
  if ('flagVar' in options) {
    if (options.flagVar === undefined) {
      delete env['AITEAMOS_PAUSE_FLAG']
    } else {
      env['AITEAMOS_PAUSE_FLAG'] = options.flagVar
    }
  } else {
    env['AITEAMOS_PAUSE_FLAG'] = flagPath
  }
  if (options.permissionsFile === undefined) {
    delete env['AITEAMOS_PERMISSIONS_FILE']
  } else {
    env['AITEAMOS_PERMISSIONS_FILE'] = options.permissionsFile
  }

  return new Promise((resolve, reject) => {
    const child = spawn(options.gateOverride ?? gatePath, [], { env, stdio: ['pipe', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    let settled = false

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      rmSync(dir, { recursive: true, force: true })
      reject(error)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    // Captured, not discarded, since M13: the "deployed without its library" refusal and the
    // not-a-regular-file refusal both put their whole operator-facing reason here, and exit 2 is
    // all stdout carries.
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.once('error', fail)
    child.once('close', (code: number | null) => {
      if (settled) return
      settled = true
      rmSync(dir, { recursive: true, force: true })
      resolve({ stdout, stderr, code })
    })

    if (options.payload !== undefined) {
      child.stdin.write(options.payload)
    }
    child.stdin.end()
  })
}

/** Writes `{"version":1,"deny":[...]}` to a fresh temp file and returns its path. */
function writePermissionsFile(deny: ReadonlyArray<{ readonly tool: string; readonly capability: string }>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'aiteamos-pause-gate-matrix-'))
  const filePath = path.join(dir, 'permissions.json')
  writeFileSync(filePath, JSON.stringify({ version: 1, deny }))
  return filePath
}

describe('pause-gate.sh', () => {
  beforeEach(() => {
    expect(existsSync(gatePath)).toBe(true)
  })

  const REASONS = [
    'plain reason',
    'has "double quotes"',
    'has \\ backslash',
    'has\nnewline',
    'has\ttab',
    'unicode ünïcödé and emoji 🚀',
    // A reason beginning with `-` is eaten as a `node` option if the encoder passes the operator's
    // text as a bare argv word: `--version` prints node's own version string and exits 0 (a
    // MALFORMED DENY that looks like a well-formed one), and `-e ...` is parsed as inline source
    // and fails with `bad option`. `cursor-shell-gate.sh` closed this on its own copy in M12;
    // M13 closes it in the shared encoder, so both gates are covered by one fix.
    '--version',
    '-e x',
  ]

  it.each(REASONS)('produces valid JSON for reason %j', async (reason): Promise<void> => {
    const { stdout } = await runHook({ flagExists: true, reason })
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
    }
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe(reason)
  })

  // Fix Round 1: the reason travels in the flag file's own contents now, not an environment
  // variable, and it must survive the trip byte-for-byte -- neither gaining nor losing trailing
  // whitespace depending on how the caller wrote it (`printf '%s'` vs. `echo`).
  it('preserves a trailing newline in the reason rather than stripping it', async (): Promise<void> => {
    const reason = 'reason with trailing newline\n'
    const { stdout } = await runHook({ flagExists: true, reason })
    const parsed = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecisionReason: string } }
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe(reason)
  })

  it('emits nothing and exits 0 when the flag is absent', async (): Promise<void> => {
    const { stdout, code } = await runHook({ flagExists: false })
    expect(stdout).toBe('')
    expect(code).toBe(0)
  })

  it('denies loudly when AITEAMOS_PAUSE_FLAG is unset', async (): Promise<void> => {
    const { stdout, code } = await runHook({ flagVar: undefined })
    const parsed = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } }
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(code).toBe(0)
  })

  // Fix Round 1's other requirement: a flag file that exists but cannot be read is the same class
  // of failure as a write failure, and must get the same response -- exit 2, never an exit 0 with
  // no body (which would read as allow).
  it('exits 2 when the pause flag exists but cannot be read', async (): Promise<void> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiteamos-pause-gate-unreadable-'))
    const flagPath = path.join(dir, 'pause.flag')
    writeFileSync(flagPath, 'secret')
    chmodSync(flagPath, 0o000)

    try {
      const { stdout, code } = await runHook({ flagVar: flagPath })
      expect(code).toBe(2)
      expect(stdout).toBe('')
    } finally {
      chmodSync(flagPath, 0o600)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // M13 §4.2 closes M12's deferred "a directory is an allow": a path that is present but is not a
  // regular file is a broken configuration, and a gate that allows on it stops gating the moment
  // someone `mkdir`s the flag path. Exit 2 is the measured fail-closed code for a PreToolUse hook
  // (exit codes 1, 126 and 127 all fail OPEN).
  it('exits 2 when the flag path names a directory rather than a file', async (): Promise<void> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiteamos-pause-gate-dir-'))
    try {
      const { stdout, code } = await runHook({ flagVar: dir })
      expect(code).toBe(2)
      expect(stdout).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  // M13 §4.2 moved `json_string` and the pause-flag read into `scripts/lib/pause-flag.sh`, which
  // this gate sources from a `lib/` directory beside its own resolved location. That makes the
  // script no longer self-contained, and `AITEAMOS_HOOK_PATH` lets an operator point this gate at any copy
  // of it. A copy made without the library must therefore REFUSE, loudly and actionably, rather
  // than gate nothing: exit 2 (fail-closed on both runtimes), nothing on stdout, and a stderr
  // message that names the exact path it looked for so the misdeployment is fixable at a glance.
  it('exits 2 and names the missing library when deployed without lib/pause-flag.sh', async (): Promise<void> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiteamos-pause-gate-lonely-'))
    try {
      const lonely = path.join(dir, 'pause-gate.sh')
      copyFileSync(gatePath, lonely)
      chmodSync(lonely, 0o755)
      const flagPath = path.join(dir, 'pause.flag')
      writeFileSync(flagPath, 'should never be read')

      const { stdout, stderr, code } = await runHook({ gateOverride: lonely, flagVar: flagPath })
      expect(code).toBe(2)
      expect(stdout).toBe('')
      // NOT `toContain('lib/pause-flag.sh')`: bash's own `...: No such file or directory` line
      // already contains that path, so such an assertion stays green even if the gate's whole
      // actionable message is deleted. This phrase is the gate's OWN words, which bash never emits.
      expect(stderr).toContain('deployed without its library')
      expect(stderr).toContain('lib/pause-flag.sh')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The library lives beside the REAL script, not beside a symlink to it, so the source path is
  // resolved with `readlink -f` before its directory is taken. A hook deployed as a symlink (a
  // `.claude/pause-gate.sh` link into a checkout, say) must still find its sibling and still deny.
  it('follows a symlink to the real script and still denies', async (): Promise<void> => {
    const realDir = mkdtempSync(path.join(tmpdir(), 'aiteamos-pause-gate-real-'))
    const linkDir = mkdtempSync(path.join(tmpdir(), 'aiteamos-pause-gate-link-'))
    try {
      const real = copyGateInto(realDir, 'pause-gate.sh')
      const link = path.join(linkDir, 'pause-gate.sh')
      symlinkSync(real, link)
      const flagPath = path.join(linkDir, 'pause.flag')
      writeFileSync(flagPath, 'paused via a symlinked hook')

      const { stdout, code } = await runHook({ gateOverride: link, flagVar: flagPath })
      expect(code).toBe(0)
      const parsed = JSON.parse(stdout) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
      }
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe('paused via a symlinked hook')
    } finally {
      rmSync(realDir, { recursive: true, force: true })
      rmSync(linkDir, { recursive: true, force: true })
    }
  })
  // A library that is PRESENT and parses but defines nothing -- an empty file, or a copy truncated
  // at a function boundary -- sources cleanly, so the `.` succeeds and the missing-library refusal
  // never fires. `read_pause_reason` is then an unknown command: bash returns 127, and a `case`
  // with arms for only 0 and 2 falls straight through to the allow below it. Measured before the
  // default arm existed, with a POPULATED flag file (an operator actively pausing):
  // exit 0 with empty stdout, which is precisely how Claude spells an ALLOW.
  // Every status this gate does not recognise must therefore be a deny, not an allow: the `*)` arm
  // is what makes "the gate broke in a way we did not enumerate" fail closed like every other
  // failure here.
  it('exits 2 when the library defines no read_pause_reason, rather than allowing', async (): Promise<void> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiteamos-pause-gate-emptylib-'))
    try {
      const gate = copyGateInto(dir, 'pause-gate.sh')
      // Sources cleanly, defines nothing.
      writeFileSync(path.join(dir, 'lib', 'pause-flag.sh'), '')
      const flagPath = path.join(dir, 'pause.flag')
      writeFileSync(flagPath, 'an operator is actively pausing this run')

      const { stdout, stderr, code } = await runHook({ gateOverride: gate, flagVar: flagPath })
      expect(code).toBe(2)
      expect(stdout).toBe('')
      expect(stderr).toContain('read_pause_reason')
      expect(stderr).toContain('unexpected status')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // M18 Task 3: the gate now also consumes `read_permission_verdict` (scripts/lib/permissions.sh,
  // Task 2) against the hook payload it captures on stdin, and refuses a matrix-denied tool by
  // name -- but only once the pause check above has already said "no pause requested" (status 1).
  describe('permission matrix', () => {
    it('denies a matrix-listed tool, naming the capability and the tool in the reason', async (): Promise<void> => {
      const permissionsFile = writePermissionsFile([{ tool: 'Bash', capability: 'run tests' }])
      try {
        const { stdout, code } = await runHook({
          flagExists: false,
          payload: JSON.stringify({ tool_name: 'Bash' }),
          permissionsFile,
        })
        expect(code).toBe(0)
        const parsed = JSON.parse(stdout) as {
          hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
        }
        expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
        // The prefix is pinned byte-equal against packages/providers/src/gate.ts's
        // PERMISSION_DENY_REASON_PREFIX by packages/control/test/permission-mapping.test.ts --
        // this assertion is deliberately exact, not `.toContain`, so a drift here is caught here.
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe(
          "permission matrix denies 'run tests' (Bash) for this agent",
        )
      } finally {
        rmSync(path.dirname(permissionsFile), { recursive: true, force: true })
      }
    })

    it('allows silently when the payload names a tool absent from the deny list', async (): Promise<void> => {
      const permissionsFile = writePermissionsFile([{ tool: 'Bash', capability: 'run tests' }])
      try {
        const { stdout, code } = await runHook({
          flagExists: false,
          payload: JSON.stringify({ tool_name: 'Read' }),
          permissionsFile,
        })
        expect(stdout).toBe('')
        expect(code).toBe(0)
      } finally {
        rmSync(path.dirname(permissionsFile), { recursive: true, force: true })
      }
    })

    it('lets an operator pause win over a matrix deny on the same tool call', async (): Promise<void> => {
      const permissionsFile = writePermissionsFile([{ tool: 'Bash', capability: 'run tests' }])
      try {
        const { stdout, code } = await runHook({
          flagExists: true,
          reason: 'operator paused',
          payload: JSON.stringify({ tool_name: 'Bash' }),
          permissionsFile,
        })
        expect(code).toBe(0)
        const parsed = JSON.parse(stdout) as {
          hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
        }
        expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
        // The pause reason, not the matrix's -- proof the matrix check never ran (pause_status 0
        // exits the script from inside the `case`, above the `if read_permission_verdict` line).
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe('operator paused')
      } finally {
        rmSync(path.dirname(permissionsFile), { recursive: true, force: true })
      }
    })

    it('does not consult the matrix at all when AITEAMOS_PERMISSIONS_FILE is unset', async (): Promise<void> => {
      // No `permissionsFile` option: `read_permission_verdict`'s own first branch (unset/missing
      // file) returns allow before it ever looks at the payload -- a tool name that WOULD be
      // denied if a matrix were armed proves the matrix truly played no part.
      const { stdout, code } = await runHook({ flagExists: false, payload: JSON.stringify({ tool_name: 'Bash' }) })
      expect(stdout).toBe('')
      expect(code).toBe(0)
    })

    it('exits 2 and names the gate when the hook payload is not JSON while a permissions file is armed', async (): Promise<void> => {
      const permissionsFile = writePermissionsFile([{ tool: 'Bash', capability: 'run tests' }])
      try {
        const { stdout, stderr, code } = await runHook({
          flagExists: false,
          payload: 'not json at all',
          permissionsFile,
        })
        expect(code).toBe(2)
        expect(stdout).toBe('')
        expect(stderr).toContain('pause-gate.sh')
        expect(stderr).toContain('did not parse as JSON')
      } finally {
        rmSync(path.dirname(permissionsFile), { recursive: true, force: true })
      }
    })
  })
})
