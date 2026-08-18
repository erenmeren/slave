import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runId, type RunId } from '@ai-team-os/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter, type StartRunInput } from '../src/claude/adapter.js'
import type { RuntimeEvent } from '../src/types.js'

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
const FIXTURES_DIR = path.join(path.dirname(FAKE), 'fixtures')
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const realGate = path.join(repoRoot, 'scripts/pause-gate.sh')

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Polls up to `timeoutMs` for the process to actually be gone. `events()`
 * closes the moment the child's stdout pipe reaches EOF, which -- measured
 * directly against Node here -- can land a handful of milliseconds before
 * the OS has finished reaping the process, so `process.kill(pid, 0)`
 * checked in the same tick `events()` finishes draining can still observe
 * "alive" for a killed process. `awaitPause`'s own "paused" resolution does
 * not have this race (it waits on the child's `exit` event directly, not
 * on the stdout pipe) -- this helper exists only for the test that checks
 * `events()` and process liveness without going through `awaitPause`.
 */
async function eventuallyDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await sleep(10)
  }
  return !isAlive(pid)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('ClaudeCodeAdapter pause protocol', () => {
  let worktreePath: string
  let hookPath: string
  let input: StartRunInput

  beforeEach(() => {
    expect(existsSync(realGate)).toBe(true)
    worktreePath = mkdtempSync(path.join(tmpdir(), 'aiteamos-adapter-pause-'))

    // A fresh executable copy of the real gate, per test -- the
    // non-discriminating-hook test mutates a hook's permissions/content,
    // and the repo's own copy must never be touched by that.
    hookPath = path.join(worktreePath, 'pause-gate.sh')
    writeFileSync(hookPath, readFileSync(realGate))
    chmodSync(hookPath, 0o755)

    input = {
      runId: runId('run-pause-1'),
      prompt: 'do the thing',
      worktreePath,
      pauseFlagPath: path.join(worktreePath, 'pause.flag'),
      settingsPath: path.join(worktreePath, 'settings.json'),
      hookPath,
      gitIdentity: { name: 'Test Agent', email: 'agent@example.com' },
    }
  })

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true })
  })

  it('kills the process on the first observed hook deny, not on the model stopping', async (): Promise<void> => {
    const adapter = new ClaudeCodeAdapter({
      command: 'node',
      extraArgs: [FAKE, '--fixture', 'hook-deny'],
      killGraceMs: 300,
    })
    const handle = await adapter.start(input)
    await adapter.requestPause(input.runId, 'operator pause')

    const seen: RuntimeEvent[] = []
    for await (const event of adapter.events(input.runId)) seen.push(event)

    const denyIndex = seen.findIndex((e) => e.kind === 'hook_denied')
    expect(denyIndex).toBeGreaterThanOrEqual(0)
    // Nothing after the deny except the terminal event: the process was
    // killed, it did not run to the fixture's natural end -- which would
    // have produced a `text` line and a real `result` line reporting
    // "completed".
    expect(seen.slice(denyIndex + 1).filter((e) => e.kind === 'tool_call')).toEqual([])

    const terminated = seen[denyIndex + 1]
    expect(terminated?.kind).toBe('terminated')
    if (terminated === undefined || terminated.kind !== 'terminated') {
      throw new Error('unreachable: asserted above')
    }
    // The load-bearing check. If the deny were only observed and not acted
    // on, this fixture would run to its own natural end and report
    // terminalReason "completed" -- exactly what removing the kill
    // produces (see the report's mutation-testing section). A synthetic
    // outcome that instead names the pause is the proof the kill fired.
    expect(terminated.outcome.terminalReason).not.toBe('completed')
    expect(terminated.outcome.terminalReason).toMatch(/pause/i)
    expect(terminated.outcome.isError).toBe(false)

    expect(await eventuallyDead(handle.pid, 1000)).toBe(true)
  })

  it('awaitPause resolves "paused" once the killed process actually exits, and clears the flag', async (): Promise<void> => {
    const adapter = new ClaudeCodeAdapter({
      command: 'node',
      extraArgs: [FAKE, '--fixture', 'hook-deny'],
      killGraceMs: 300,
    })
    const handle = await adapter.start(input)
    await adapter.requestPause(input.runId, 'operator pause')
    expect(existsSync(input.pauseFlagPath)).toBe(true)

    // Deliberately does not touch events() at all -- awaitPause must not
    // require a second consumer of the shared queue to make progress.
    const outcome = await adapter.awaitPause(input.runId, { deadlineMs: 2000 })

    expect(outcome).toBe('paused')
    expect(existsSync(input.pauseFlagPath)).toBe(false)
    expect(isAlive(handle.pid)).toBe(false)
  })

  it('treats "pause requested, run finished anyway" as a normal outcome', async (): Promise<void> => {
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'] })
    await adapter.start(input)
    await adapter.requestPause(input.runId, 'operator pause')

    const outcome = await adapter.awaitPause(input.runId, { deadlineMs: 2000 })

    expect(outcome).toBe('finished_first')
    expect(existsSync(input.pauseFlagPath)).toBe(false)
  })

  it('reports gate_failed, not finished_first, when tool calls proceed after the flag is written', async (): Promise<void> => {
    // Ground truth, read independently of the adapter under test: this
    // fixture's failed-open tool call really did proceed -- a PostToolUse
    // line follows the exit-126 PreToolUse failure. The brief flags that
    // the sibling fake-claude.test.ts assertion for this fixture never
    // checks this positively (it only checks the terminal aggregates); the
    // distinction between "nothing denied it" and "it actually ran" is the
    // entire point of gate_failed, so this test asserts the ground truth
    // directly rather than only inferring it from an absence.
    const fixtureRaw = readFileSync(path.join(FIXTURES_DIR, 'hook-fail-open.ndjson'), 'utf8')
    expect(fixtureRaw).toContain('"hook_event":"PostToolUse"')

    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'hook-fail-open'] })
    await adapter.start(input)
    await adapter.requestPause(input.runId, 'operator pause')

    const outcome = await adapter.awaitPause(input.runId, { deadlineMs: 2000 })

    expect(outcome).toBe('gate_failed')
    expect(existsSync(input.pauseFlagPath)).toBe(false)
  })

  it('uses a per-run flag path so pausing one run cannot freeze another', async (): Promise<void> => {
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'hang'] })

    const worktreeB = mkdtempSync(path.join(tmpdir(), 'aiteamos-adapter-pause-b-'))
    try {
      const runIdA = runId('run-pause-a')
      const runIdB = runId('run-pause-b')
      const inputA: StartRunInput = { ...input, runId: runIdA }
      const inputB: StartRunInput = {
        ...input,
        runId: runIdB,
        worktreePath: worktreeB,
        pauseFlagPath: path.join(worktreeB, 'pause.flag'),
        settingsPath: path.join(worktreeB, 'settings.json'),
      }

      const handleA = await adapter.start(inputA)
      const handleB = await adapter.start(inputB)

      try {
        await adapter.requestPause(runIdA, 'operator pause')

        expect(existsSync(inputA.pauseFlagPath)).toBe(true)
        expect(existsSync(inputB.pauseFlagPath)).toBe(false)
      } finally {
        // `hang` never exits on its own -- this must run even if an
        // assertion above throws, or a failing run of this exact test
        // leaks a real background process that outlives the test file.
        await adapter.cancel(runIdA)
        await adapter.cancel(runIdB)
      }
      expect(isAlive(handleA.pid)).toBe(false)
      expect(isAlive(handleB.pid)).toBe(false)
    } finally {
      rmSync(worktreeB, { recursive: true, force: true })
    }
  })

  it('refuses to start a run whose hook does not discriminate (Task 6 preflightGate wired in)', async (): Promise<void> => {
    const alwaysDenyHookPath = path.join(worktreePath, 'always-deny.sh')
    writeFileSync(
      alwaysDenyHookPath,
      [
        '#!/usr/bin/env bash',
        'cat > /dev/null',
        'printf \'%s\\n\' \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"nope"}}\'',
        'exit 0',
        '',
      ].join('\n'),
    )
    chmodSync(alwaysDenyHookPath, 0o755)

    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'] })
    const badInput: StartRunInput = { ...input, hookPath: alwaysDenyHookPath }

    await expect(adapter.start(badInput)).rejects.toThrow(/preflight/i)
    // No run was ever registered: requestPause against it must fail loudly
    // rather than silently look armed.
    await expect(adapter.requestPause(badInput.runId, 'operator pause')).rejects.toThrow()
  })
})
