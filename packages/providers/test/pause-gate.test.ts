import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'

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
}

interface RunHookResult {
  readonly stdout: string
  readonly code: number | null
}

/**
 * Spawns the real `scripts/pause-gate.sh` directly (not through the `claude` CLI), the same way
 * `preflightGate` in `../src/claude/flags.ts` does, and the same way Claude Code itself would:
 * default piped stdio, closed immediately so the script's `cat > /dev/null` drain does not hang.
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
    // Drained, not asserted on -- a write-failure crash reports its reason on stderr, but this
    // suite's verdict is stdout shape + exit code, and the write-failure path is re-verified
    // separately against /dev/full (see the task report).
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
})
