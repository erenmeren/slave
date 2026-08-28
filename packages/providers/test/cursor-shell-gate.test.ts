import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const gatePath = path.join(repoRoot, 'scripts/cursor-shell-gate.sh')

interface RunHookOptions {
  readonly flagExists?: boolean
  // Written verbatim as the pause flag file's content -- the gate reads its deny reason from
  // there, exactly as `pause-gate.sh` does, so one paused run says the same thing to the
  // operator whichever runtime it happens to be running on.
  readonly reason?: string
  // Present with value `undefined` means "unset AITEAMOS_PAUSE_FLAG entirely" -- distinct from
  // omitting the key, which means "use this test's own generated flag path". Detected below via
  // `'flagVar' in options`, not via `options.flagVar === undefined`, so the two are
  // distinguishable. Mirrors `pause-gate.test.ts`.
  readonly flagVar?: string | undefined
}

interface RunHookResult {
  readonly stdout: string
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
  const dir = mkdtempSync(path.join(tmpdir(), 'aiteamos-cursor-gate-test-'))
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

  return new Promise((resolve, reject) => {
    const child = spawn(gatePath, [], { env, stdio: ['pipe', 'pipe', 'pipe'] })

    let stdout = ''
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
    // Drained, not asserted on -- the exit-2 paths report their reason on stderr, and Cursor
    // turns that stderr into the operator-facing block reason, but this suite's verdict is
    // stdout shape + exit code, matching the script's documented contract.
    child.stderr.resume()

    child.once('error', fail)
    child.once('close', (code: number | null) => {
      if (settled) return
      settled = true
      rmSync(dir, { recursive: true, force: true })
      resolve({ stdout, code })
    })

    child.stdin.end()
  })
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
  // `permission` / `user_message` / `agent_message`). A `userMessage` key is
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

  it('denies loudly when AITEAMOS_PAUSE_FLAG is unset', async (): Promise<void> => {
    const { stdout, code } = await runHook({ flagVar: undefined })
    const parsed = JSON.parse(stdout) as { permission: string }
    expect(parsed.permission).toBe('deny')
    expect(code).toBe(0)
  })

  it('denies loudly when AITEAMOS_PAUSE_FLAG is empty', async (): Promise<void> => {
    const { stdout, code } = await runHook({ flagVar: '' })
    const parsed = JSON.parse(stdout) as { permission: string }
    expect(parsed.permission).toBe('deny')
    expect(code).toBe(0)
  })

  // Exit 2 is Cursor's own blocking exit code, measured in R5's run 1: a hook that exits 2 stops
  // the tool call outright, while a hook that exits 1 with garbage on stdout lets it through.
  // So a gate that cannot produce a well-formed answer must exit exactly 2 and never 1.
  it('exits 2 with no stdout when the pause flag exists but cannot be read', async (): Promise<void> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiteamos-cursor-gate-unreadable-'))
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

  // A directory is not a file, so `-f` is false and this is an ALLOW, not a read failure. Pinned
  // because the alternative reading -- "something is there, deny" -- is the tempting one.
  it('allows when the flag path names a directory rather than a file', async (): Promise<void> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiteamos-cursor-gate-dir-'))
    try {
      const { stdout, code } = await runHook({ flagVar: dir })
      expect(code).toBe(0)
      expect((JSON.parse(stdout) as { permission: string }).permission).toBe('allow')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
