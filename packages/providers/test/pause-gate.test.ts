import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const gatePath = path.join(repoRoot, 'scripts/pause-gate.sh')

interface RunHookOptions {
  readonly flagExists?: boolean
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
    writeFileSync(flagPath, '')
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
  if (options.reason !== undefined) {
    env['AITEAMOS_PAUSE_REASON'] = options.reason
  } else {
    delete env['AITEAMOS_PAUSE_REASON']
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
})
