import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { copyGateInto } from './helpers/gate-fixture.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const gatePath = path.join(repoRoot, 'scripts/cursor-shell-gate.sh')

interface RunHookOptions {
  readonly flagExists?: boolean
  // Written verbatim as the pause flag file's content -- the gate reads its deny reason from
  // there, exactly as `pause-gate.sh` does, so one paused run says the same thing to the
  // operator whichever runtime it happens to be running on.
  readonly reason?: string
  // Present with value `undefined` means "unset SLAVEOFAI_PAUSE_FLAG entirely" -- distinct from
  // omitting the key, which means "use this test's own generated flag path". Detected below via
  // `'flagVar' in options`, not via `options.flagVar === undefined`, so the two are
  // distinguishable. Mirrors `pause-gate.test.ts`.
  readonly flagVar?: string | undefined
  // The script to spawn, when it is deliberately NOT the repo's own copy -- used by the
  // deployment tests below, which need a gate at a path they control.
  readonly gateOverride?: string
  // Written to stdin as the hook payload (`hook_payload=$(cat)`, M18 Task 4). Omitted leaves
  // stdin empty, exactly as every pre-Task-4 test here already relies on: an empty payload has
  // no `tool_name` and no `command`, so `read_permission_verdict` allows regardless of what a
  // permissions file says.
  readonly payload?: string
  // Sets SLAVEOFAI_PERMISSIONS_FILE for the child. Omitted deletes it from the child's environment
  // entirely (not merely "leaves it unset in this test file's own process") -- the permission
  // matrix must stay completely out of the picture for every pre-Task-4-shaped test in this file.
  readonly permissionsFile?: string
}

interface RunHookResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
}

/**
 * Spawns the real `scripts/cursor-shell-gate.sh` directly (not through `cursor-agent`), the same
 * way `pause-gate.test.ts` spawns Claude's: default piped stdio, closed immediately so the
 * script's `cat > /dev/null` drain does not hang.
 *
 * The real invocation differs in one way this harness deliberately does not imitate: Cursor runs
 * the hook's `command` string through a shell with the payload attached as a heredoc, so the
 * script is `bash -c`'d rather than exec'd, and argv carries whatever extra words the hooks.json
 * `command` string contained. Neither affects this script, which reads no argument.
 */
function runHook(options: RunHookOptions = {}): Promise<RunHookResult> {
  const dir = mkdtempSync(path.join(tmpdir(), 'slaveofai-cursor-gate-test-'))
  const flagPath = path.join(dir, 'pause.flag')
  const flagExists = options.flagExists ?? true

  if (flagExists) {
    writeFileSync(flagPath, options.reason ?? '')
  }

  const env: Record<string, string | undefined> = { ...process.env }
  if ('flagVar' in options) {
    if (options.flagVar === undefined) {
      delete env['SLAVEOFAI_PAUSE_FLAG']
    } else {
      env['SLAVEOFAI_PAUSE_FLAG'] = options.flagVar
    }
  } else {
    env['SLAVEOFAI_PAUSE_FLAG'] = flagPath
  }
  if (options.permissionsFile === undefined) {
    delete env['SLAVEOFAI_PERMISSIONS_FILE']
  } else {
    env['SLAVEOFAI_PERMISSIONS_FILE'] = options.permissionsFile
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
    // Captured, not discarded, since M13: on exit 2 Cursor builds the operator-facing block reason
    // from stderr when stdout is empty, and the "deployed without its library" refusal lives there.
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
  const dir = mkdtempSync(path.join(tmpdir(), 'slaveofai-cursor-gate-matrix-'))
  const filePath = path.join(dir, 'permissions.json')
  writeFileSync(filePath, JSON.stringify({ version: 1, deny }))
  return filePath
}

describe('cursor-shell-gate.sh', () => {
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
    // A reason beginning with `-` is eaten as a `node` option if the encoder ever passes the
    // operator's text as a bare argv word: `--version` prints node's own version string and exits
    // 0 (a MALFORMED DENY that looks like a well-formed one), and `-e ...` is parsed as inline
    // source and fails with `bad option`. Neither is hypothetical -- both were reproduced against
    // the committed script before this fix.
    '--version',
    '-e x',
  ]

  it.each(REASONS)('produces valid deny JSON for reason %j', async (reason): Promise<void> => {
    const { stdout, code } = await runHook({ flagExists: true, reason })
    const parsed = JSON.parse(stdout) as { permission: string; user_message: string }
    expect(parsed.permission).toBe('deny')
    expect(parsed.user_message).toBe(reason)
    expect(code).toBe(0)
  })

  // MEASURED, and the reason the key is snake_case: the binary reads
  // `response.user_message` (and its own validator accepts exactly
  // `permission` / `user_message` / `slave_message`). A `userMessage` key is
  // simply not read, which would still deny but would throw the operator's
  // message away silently.
  it('names the operator message user_message, not userMessage', async (): Promise<void> => {
    const { stdout } = await runHook({ flagExists: true, reason: 'a reason' })
    const parsed = JSON.parse(stdout) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['permission', 'user_message'])
  })

  it('preserves a trailing newline in the reason rather than stripping it', async (): Promise<void> => {
    const reason = 'reason with trailing newline\n'
    const { stdout } = await runHook({ flagExists: true, reason })
    const parsed = JSON.parse(stdout) as { user_message: string }
    expect(parsed.user_message).toBe(reason)
  })

  it('falls back to a static message when the flag file is empty', async (): Promise<void> => {
    const { stdout } = await runHook({ flagExists: true })
    const parsed = JSON.parse(stdout) as { permission: string; user_message: string }
    expect(parsed.permission).toBe('deny')
    expect(parsed.user_message.length).toBeGreaterThan(0)
  })

  it('emits the deny payload as a single line', async (): Promise<void> => {
    const { stdout } = await runHook({ flagExists: true, reason: 'a\nb\nc' })
    expect(stdout.trimEnd().includes('\n')).toBe(false)
  })

  // The load-bearing divergence from `pause-gate.sh`, and it is MEASURED, not stylistic:
  // Cursor classifies an empty stdout as a hook FAILURE (`errorClass: "empty_stdout"`), not as
  // an allow. Under the `failClosed: true` entry this gate is meant to be registered with, a
  // silent allow would therefore block every single tool call while looking like a working
  // gate. An allow must say so out loud.
  it('emits an explicit allow -- never silence -- when the flag is absent', async (): Promise<void> => {
    const { stdout, code } = await runHook({ flagExists: false })
    expect(code).toBe(0)
    expect(stdout.trim()).not.toBe('')
    const parsed = JSON.parse(stdout) as { permission: string }
    expect(parsed.permission).toBe('allow')
  })

  it('denies loudly when SLAVEOFAI_PAUSE_FLAG is unset', async (): Promise<void> => {
    const { stdout, code } = await runHook({ flagVar: undefined })
    const parsed = JSON.parse(stdout) as { permission: string }
    expect(parsed.permission).toBe('deny')
    expect(code).toBe(0)
  })

  it('denies loudly when SLAVEOFAI_PAUSE_FLAG is empty', async (): Promise<void> => {
    const { stdout, code } = await runHook({ flagVar: '' })
    const parsed = JSON.parse(stdout) as { permission: string }
    expect(parsed.permission).toBe('deny')
    expect(code).toBe(0)
  })

  // Exit 2 is Cursor's own blocking exit code, measured in R5's run 1: a hook that exits 2 stops
  // the tool call outright, while a hook that exits 1 with garbage on stdout lets it through.
  // So a gate that cannot produce a well-formed answer must exit exactly 2 and never 1.
  it('exits 2 with no stdout when the pause flag exists but cannot be read', async (): Promise<void> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'slaveofai-cursor-gate-unreadable-'))
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

  // Was an ALLOW through M12 ("a directory is not a file, so `-f` is false"), pinned because the
  // alternative reading looked like the tempting one. M13 §4.2 rules the other way for both gates:
  // present-but-not-a-regular-file is a broken configuration, and exit 2 is Cursor's own blocking
  // exit code (measured: exit 2 stopped the command outright, while exit 1 with garbage on stdout
  // let it through).
  it('exits 2 when the flag path names a directory rather than a file', async (): Promise<void> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'slaveofai-cursor-gate-dir-'))
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
  // script no longer self-contained, and `SLAVEOFAI_CURSOR_GATE_PATH` lets an operator point this gate at any copy
  // of it. A copy made without the library must therefore REFUSE, loudly and actionably, rather
  // than gate nothing: exit 2 (fail-closed on both runtimes), nothing on stdout, and a stderr
  // message that names the exact path it looked for so the misdeployment is fixable at a glance.
  it('exits 2 and names the missing library when deployed without lib/pause-flag.sh', async (): Promise<void> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'slaveofai-cursor-gate-lonely-'))
    try {
      const lonely = path.join(dir, 'cursor-shell-gate.sh')
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
  // `.claude/cursor-shell-gate.sh` link into a checkout, say) must still find its sibling, and
  // must still deny.
  it('follows a symlink to the real script and still denies', async (): Promise<void> => {
    const realDir = mkdtempSync(path.join(tmpdir(), 'slaveofai-cursor-gate-real-'))
    const linkDir = mkdtempSync(path.join(tmpdir(), 'slaveofai-cursor-gate-link-'))
    try {
      const real = copyGateInto(realDir, 'cursor-shell-gate.sh')
      const link = path.join(linkDir, 'cursor-shell-gate.sh')
      symlinkSync(real, link)
      const flagPath = path.join(linkDir, 'pause.flag')
      writeFileSync(flagPath, 'paused via a symlinked hook')

      const { stdout, code } = await runHook({ gateOverride: link, flagVar: flagPath })
      expect(code).toBe(0)
      const parsed = JSON.parse(stdout) as { permission: string; user_message: string }
      expect(parsed.permission).toBe('deny')
      expect(parsed.user_message).toBe('paused via a symlinked hook')
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
  // exit 0 with `{"permission":"allow"}` on stdout -- an explicit ALLOW.
  // Every status this gate does not recognise must therefore be a deny, not an allow: the `*)` arm
  // is what makes "the gate broke in a way we did not enumerate" fail closed like every other
  // failure here.
  it('exits 2 when the library defines no read_pause_reason, rather than allowing', async (): Promise<void> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'slaveofai-cursor-gate-emptylib-'))
    try {
      const gate = copyGateInto(dir, 'cursor-shell-gate.sh')
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

  // M18 Task 4: this gate now also consumes `read_permission_verdict` (scripts/lib/permissions.sh,
  // shared with pause-gate.sh) against the hook payload it captures on stdin, and refuses a
  // matrix-denied tool via Cursor's own `deny()` shape -- but only once the pause check above has
  // already said "no pause requested" (status 1).
  describe('permission matrix', () => {
    it('denies a matrix-listed preToolUse tool, naming the capability and tool in user_message', async (): Promise<void> => {
      const permissionsFile = writePermissionsFile([{ tool: 'edit', capability: 'source write' }])
      try {
        const { stdout, code } = await runHook({
          flagExists: false,
          payload: JSON.stringify({ tool_name: 'edit', hook_event_name: 'preToolUse' }),
          permissionsFile,
        })
        expect(code).toBe(0)
        const parsed = JSON.parse(stdout) as { permission: string; user_message: string }
        expect(parsed.permission).toBe('deny')
        // The prefix is pinned byte-equal against packages/providers/src/gate.ts's
        // PERMISSION_DENY_REASON_PREFIX by packages/control/test/permission-mapping.test.ts --
        // this assertion is deliberately exact, not `.toContain`, so a drift here is caught here.
        expect(parsed.user_message).toBe("permission matrix denies 'source write' (edit) for this slave")
      } finally {
        rmSync(path.dirname(permissionsFile), { recursive: true, force: true })
      }
    })

    // The mechanism Task 4 adds: `beforeShellExecution`'s real captured payload (measured against
    // fixtures/cursor/gate/run-1-hook.log) carries a top-level `command` string and NO tool-name
    // key at all. The gate passes 'shell' as `default_tool` on every call, and the library's own
    // shape guard (a `command` string present, no `tool_name`) is what makes that substitution
    // fire only for this shape.
    it('denies a beforeShellExecution-shaped payload (no tool_name) via the shell default_tool', async (): Promise<void> => {
      const permissionsFile = writePermissionsFile([{ tool: 'shell', capability: 'run tests' }])
      try {
        const { stdout, code } = await runHook({
          flagExists: false,
          payload: JSON.stringify({ command: 'echo hi', cwd: '/tmp', hook_event_name: 'beforeShellExecution' }),
          permissionsFile,
        })
        expect(code).toBe(0)
        const parsed = JSON.parse(stdout) as { permission: string; user_message: string }
        expect(parsed.permission).toBe('deny')
        expect(parsed.user_message).toBe("permission matrix denies 'run tests' (shell) for this slave")
      } finally {
        rmSync(path.dirname(permissionsFile), { recursive: true, force: true })
      }
    })

    it('allows explicitly when the payload names a tool absent from the deny list', async (): Promise<void> => {
      const permissionsFile = writePermissionsFile([{ tool: 'shell', capability: 'run tests' }])
      try {
        const { stdout, code } = await runHook({
          flagExists: false,
          payload: JSON.stringify({ tool_name: 'read', hook_event_name: 'preToolUse' }),
          permissionsFile,
        })
        expect(code).toBe(0)
        const parsed = JSON.parse(stdout) as { permission: string }
        expect(parsed.permission).toBe('allow')
      } finally {
        rmSync(path.dirname(permissionsFile), { recursive: true, force: true })
      }
    })

    it('lets an operator pause win over a matrix deny on the same tool call', async (): Promise<void> => {
      const permissionsFile = writePermissionsFile([{ tool: 'shell', capability: 'run tests' }])
      try {
        const { stdout, code } = await runHook({
          flagExists: true,
          reason: 'operator paused',
          payload: JSON.stringify({ command: 'echo hi', hook_event_name: 'beforeShellExecution' }),
          permissionsFile,
        })
        expect(code).toBe(0)
        const parsed = JSON.parse(stdout) as { permission: string; user_message: string }
        expect(parsed.permission).toBe('deny')
        // The pause reason, not the matrix's -- proof the matrix check never ran (pause_status 0
        // exits the script from inside the `case`, above the `if read_permission_verdict` line).
        expect(parsed.user_message).toBe('operator paused')
      } finally {
        rmSync(path.dirname(permissionsFile), { recursive: true, force: true })
      }
    })

    it('does not consult the matrix at all when SLAVEOFAI_PERMISSIONS_FILE is unset', async (): Promise<void> => {
      // No `permissionsFile` option: `read_permission_verdict`'s own first branch (unset/missing
      // file) returns allow before it ever looks at the payload -- a tool name that WOULD be
      // denied if a matrix were armed proves the matrix truly played no part.
      const { stdout, code } = await runHook({
        flagExists: false,
        payload: JSON.stringify({ command: 'echo hi', hook_event_name: 'beforeShellExecution' }),
      })
      expect(code).toBe(0)
      const parsed = JSON.parse(stdout) as { permission: string }
      expect(parsed.permission).toBe('allow')
    })

    it('exits 2 and names the gate when the hook payload is not JSON while a permissions file is armed', async (): Promise<void> => {
      const permissionsFile = writePermissionsFile([{ tool: 'shell', capability: 'run tests' }])
      try {
        const { stdout, stderr, code } = await runHook({
          flagExists: false,
          payload: 'not json at all',
          permissionsFile,
        })
        expect(code).toBe(2)
        expect(stdout).toBe('')
        expect(stderr).toContain('cursor-shell-gate.sh')
        expect(stderr).toContain('did not parse as JSON')
      } finally {
        rmSync(path.dirname(permissionsFile), { recursive: true, force: true })
      }
    })
  })
})
