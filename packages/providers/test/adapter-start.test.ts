import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runId, type RunId } from '@ai-team-os/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ClaudeCodeAdapter, type StartRunInput } from '../src/claude/adapter.js'
import type { RuntimeEvent } from '../src/types.js'
import { copyGateInto } from './helpers/gate-fixture.js'

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))

/**
 * Drains the run's normalized event stream (proving `events()` still works
 * end to end for this fixture, and that it does not hang), then reads the
 * child's echoed environment back off the adapter's raw-payload seam --
 * `RunOutcome` carries no `env` field, so the normalized stream alone
 * cannot answer "did the spawned process actually receive this variable".
 */
async function collectEnvFrom(adapter: ClaudeCodeAdapter, id: RunId): Promise<Record<string, string>> {
  for await (const _event of adapter.events(id)) {
    void _event // drain to completion
  }
  const payload = adapter.rawTerminalPayload(id)
  if (payload === undefined) {
    throw new Error('collectEnvFrom: no terminal result payload observed')
  }
  return z.record(z.string()).parse(payload.env)
}

describe('ClaudeCodeAdapter', () => {
  let worktreePath: string
  let input: StartRunInput
  let hookPath: string

  beforeEach(() => {
    worktreePath = mkdtempSync(path.join(tmpdir(), 'aiteamos-adapter-'))
    // start() (Task 8) now runs the Task 6 pre-flight gate against
    // hookPath before spawning anything, so every test here needs a real
    // discriminating hook script even though most of them never touch
    // pause behavior directly. A fresh copy per test, not the repo's own
    // file, since nothing here has any business mutating that.
    // Copies `scripts/lib/pause-flag.sh` alongside as well -- since M13 §4.2 the gate sources it
    // from a `lib/` directory beside itself, and a lone copy refuses to run.
    hookPath = copyGateInto(worktreePath, 'pause-gate.sh')
    input = {
      runId: runId('run-1'),
      prompt: 'do the thing',
      worktreePath,
      pauseFlagPath: path.join(worktreePath, 'pause.flag'),
      // M12 Task 2: the run's own scratch directory, not a settings path -- the adapter derives
      // and writes `settings.json` inside it. Reusing `worktreePath` here (rather than a separate
      // directory) keeps this file's assertions unchanged from before the refactor.
      runDir: worktreePath,
      gitIdentity: { name: 'Test Agent', email: 'agent@example.com' },
    }
  })

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true })
  })

  it('streams normalized events and reports the pid', async (): Promise<void> => {
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'], hookPath })
    const handle = await adapter.start(input)
    expect(handle.pid).toBeGreaterThan(0)

    const seen: RuntimeEvent[] = []
    for await (const event of adapter.events(input.runId)) seen.push(event)

    expect(seen[0]).toEqual({ kind: 'session_started', sessionId: expect.any(String) })
    const terminatedIndex = seen.findIndex((e) => e.kind === 'terminated')
    expect(terminatedIndex).toBeGreaterThanOrEqual(0)
    // The real `complete` capture's own final line is a routine `Stop` hook
    // response, which arrives *after* the terminal `result` line (ADR 0001:
    // "every one of the four captures ends with a routine Stop hook"). A
    // reader that stopped at `result` would never see it -- asserting more
    // events follow the terminated one is what proves this reader does not.
    expect(seen.length).toBeGreaterThan(terminatedIndex + 1)
    expect(seen.some((e) => e.kind === 'unparsable')).toBe(false)
  })

  it('sets git identity in the child environment and never writes git config', async (): Promise<void> => {
    // fixture 'env-echo' prints process.env keys as a result payload
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'env-echo'], hookPath })
    await adapter.start(input)
    const env = await collectEnvFrom(adapter, input.runId)
    expect(env['GIT_AUTHOR_NAME']).toBe(input.gitIdentity.name)
    expect(env['GIT_AUTHOR_EMAIL']).toBe(input.gitIdentity.email)
    expect(env['GIT_COMMITTER_NAME']).toBe(input.gitIdentity.name)
    expect(env['GIT_COMMITTER_EMAIL']).toBe(input.gitIdentity.email)
    expect(env['AITEAMOS_PAUSE_FLAG']).toBe(input.pauseFlagPath)
  })

  it('appends --model to the spawned args when input.model is set', async (): Promise<void> => {
    // fixture 'env-echo' also carries the child's own process.argv in its terminal result payload.
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'env-echo'], hookPath })
    await adapter.start({ ...input, model: 'test-model-a' })
    for await (const _event of adapter.events(input.runId)) {
      void _event // drain to completion
    }
    const payload = adapter.rawTerminalPayload(input.runId)
    const argv = z.array(z.string()).parse(payload?.['argv'])
    const modelIndex = argv.indexOf('--model')
    expect(modelIndex).toBeGreaterThanOrEqual(0)
    expect(argv[modelIndex + 1]).toBe('test-model-a')
  })

  it('omits --model entirely when input.model is not set (the legacy no-override path)', async (): Promise<void> => {
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'env-echo'], hookPath })
    await adapter.start(input) // `input` carries no `model` field
    for await (const _event of adapter.events(input.runId)) {
      void _event // drain to completion
    }
    const payload = adapter.rawTerminalPayload(input.runId)
    const argv = z.array(z.string()).parse(payload?.['argv'])
    expect(argv).not.toContain('--model')
  })

  it('reports the ADR 0001 capability profile verbatim', () => {
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'], hookPath })
    expect(adapter.getCapabilities()).toEqual({
      canPauseMidRun: true,
      canResumeSession: true,
      gate: 'all-tools',
      reportsCost: true,
    })
  })

  it('cancels a hung run: the process no longer exists after cancel() resolves', async (): Promise<void> => {
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'hang'], killGraceMs: 500, hookPath })
    const handle = await adapter.start(input)
    expect(isAlive(handle.pid)).toBe(true)

    await adapter.cancel(input.runId)

    expect(isAlive(handle.pid)).toBe(false)
  })

  it('spawns the child with cwd set to the worktree path', async (): Promise<void> => {
    // fixture 'env-echo' also carries the child's process.cwd() in its
    // terminal result payload, alongside process.env.
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'env-echo'], hookPath })
    await adapter.start(input)
    for await (const _event of adapter.events(input.runId)) {
      void _event // drain to completion
    }
    const payload = adapter.rawTerminalPayload(input.runId)
    expect(payload?.cwd).toBe(worktreePath)
  })

  it('a spawn failure rejects start() without an uncaught exception', async (): Promise<void> => {
    // Reproduces the two cases the reviewer found: a command that does not
    // exist, and (separately, see the next test) a worktreePath that does
    // not exist. Both report their OS-level ENOENT asynchronously, on a
    // later tick than `start()` itself rejects -- the exact window where an
    // 'error' listener attached too late used to become an uncaught
    // exception that killed the whole process, not just this run.
    let uncaught: unknown
    const onUncaughtException = (error: unknown): void => {
      uncaught = error
    }
    process.once('uncaughtException', onUncaughtException)
    try {
      const adapter = new ClaudeCodeAdapter({ command: '/nope/does-not-exist-claude-binary', hookPath })
      await expect(adapter.start(input)).rejects.toThrow(/failed to spawn/)
      // Give the asynchronous OS-level error room to surface as an
      // uncaught exception if it were going to.
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      process.removeListener('uncaughtException', onUncaughtException)
    }
    expect(uncaught).toBeUndefined()
  })

  it('a spawn failure from a nonexistent worktreePath also rejects cleanly', async (): Promise<void> => {
    let uncaught: unknown
    const onUncaughtException = (error: unknown): void => {
      uncaught = error
    }
    process.once('uncaughtException', onUncaughtException)
    try {
      const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'], hookPath })
      const badInput: StartRunInput = { ...input, worktreePath: path.join(worktreePath, 'does-not-exist') }
      await expect(adapter.start(badInput)).rejects.toThrow(/failed to spawn/)
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      process.removeListener('uncaughtException', onUncaughtException)
    }
    expect(uncaught).toBeUndefined()
  })
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
