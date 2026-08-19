import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runId as makeRunId, type RunId } from '@ai-team-os/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ClaudeCodeAdapter, type RunHandle, type StartRunInput } from '../src/claude/adapter.js'
import type { Checkpoint } from '../src/claude/checkpoint.js'

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const realGate = path.join(repoRoot, 'scripts/pause-gate.sh')

describe('ClaudeCodeAdapter.resume', () => {
  let worktreePath: string
  let hookPath: string
  let input: StartRunInput
  let adapter: ClaudeCodeAdapter
  let checkpoint: Checkpoint

  /**
   * Drains this run's event stream (so its process's terminal `result` line -- the fake CLI's
   * `env-echo` fixture -- has actually been read) and pulls the spawned argv back off the
   * adapter's raw-payload seam. Read externally, off the child's own echoed `process.argv`,
   * rather than trusted from the adapter's internal bookkeeping of what it thinks it spawned --
   * the same "ground truth is the child, not the caller's memory of it" convention `env-echo`
   * already established for git identity and cwd in adapter-start.test.ts.
   */
  async function spawnedArgsFor(handle: RunHandle): Promise<readonly string[]> {
    for await (const _event of adapter.events(handle.runId)) {
      void _event // drain to completion
    }
    const payload = adapter.rawTerminalPayload(handle.runId)
    if (payload === undefined) {
      throw new Error('spawnedArgsFor: no terminal result payload observed')
    }
    return z.array(z.string()).parse(payload['argv'])
  }

  beforeEach(async (): Promise<void> => {
    expect(existsSync(realGate)).toBe(true)
    worktreePath = mkdtempSync(path.join(tmpdir(), 'aiteamos-adapter-resume-'))

    hookPath = path.join(worktreePath, 'pause-gate.sh')
    writeFileSync(hookPath, readFileSync(realGate))
    chmodSync(hookPath, 0o755)

    input = {
      runId: makeRunId('run-resume-1'),
      prompt: 'do the thing',
      worktreePath,
      pauseFlagPath: path.join(worktreePath, 'pause.flag'),
      settingsPath: path.join(worktreePath, 'settings.json'),
      hookPath,
      gitIdentity: { name: 'Test Agent', email: 'agent@example.com' },
    }

    // env-echo both completes immediately (nothing lingers for afterEach to clean up) and, after
    // this change, echoes the spawned argv -- exactly what resume()'s own spawn needs proven too.
    adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'env-echo'] })
    await adapter.start(input)
    // Drain the initial run so its process has fully exited before any test below calls
    // resume() against the same runId -- resume() reuses the adapter's own bookkeeping
    // (settingsPath, hookPath, gitIdentity) recorded at start() time.
    for await (const _event of adapter.events(input.runId)) {
      void _event
    }

    checkpoint = {
      sessionId: 'fake-session-abc123',
      worktreePath: input.worktreePath,
      pauseFlagPath: input.pauseFlagPath,
      lastToolUseId: 'toolu_01ABC',
      lastToolName: 'Edit',
      numTurns: 3,
      deniedToolUseIds: ['toolu_01DEF'],
      headCommit: 'deadbeefcafef00d',
      dirtyFiles: ['src/index.ts'],
      cumulativeCostUsd: 0.42,
      cumulativeTokens: 1234,
    }
  })

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true })
  })

  it('refuses to resume while the pause flag still exists', async (): Promise<void> => {
    // A directory, not a plain file, at the checkpoint's pauseFlagPath. `resume()` must attempt
    // to clear the flag with a plain (non-recursive) removal, matching what it would do for an
    // ordinary flag file -- and a non-recursive removal of a directory fails without removing
    // it (Node: EISDIR), leaving it present exactly as ADR 0001 describes a surviving flag. This
    // is the realistic shape of "clearing failed silently but nobody checked": a naive
    // fire-and-forget `rm` would swallow the EISDIR and sail on, spawning a resumed run whose
    // hook denies every tool call from the first line.
    const blockedFlagPath = path.join(worktreePath, 'stuck-pause.flag')
    mkdirSync(blockedFlagPath)
    expect(existsSync(blockedFlagPath)).toBe(true)

    await expect(
      adapter.resume(input.runId, { ...checkpoint, pauseFlagPath: blockedFlagPath }, null),
    ).rejects.toThrow(/pause flag/)

    // The directory itself is untouched -- refusing to resume must not have escalated to
    // recursively deleting it either.
    expect(existsSync(blockedFlagPath)).toBe(true)
  })

  it('clears an ordinary, existing pause flag file and resumes successfully', async (): Promise<void> => {
    writeFileSync(checkpoint.pauseFlagPath, 'operator pause')
    expect(existsSync(checkpoint.pauseFlagPath)).toBe(true)

    await adapter.resume(input.runId, checkpoint, 'name the class MathKit')

    expect(existsSync(checkpoint.pauseFlagPath)).toBe(false)
  })

  it('resumes with the same session id and never mints a new one', async (): Promise<void> => {
    const handle = await adapter.resume(input.runId, checkpoint, 'name the class MathKit')
    const args = await spawnedArgsFor(handle)

    expect(args).toContain('--resume')
    expect(args).toContain(checkpoint.sessionId)
    expect(args).not.toContain('--fork-session')
  })

  it('passes the queued instruction as the prompt', async (): Promise<void> => {
    const handle = await adapter.resume(input.runId, checkpoint, 'do the other thing')
    const args = await spawnedArgsFor(handle)

    expect(args).toContain('-p')
    expect(args).toContain('do the other thing')
  })

  it('spawns in the checkpoint worktree with the same settings and permission posture', async (): Promise<void> => {
    const handle = await adapter.resume(input.runId, checkpoint, 'do the other thing')
    const args = await spawnedArgsFor(handle)
    const payload = adapter.rawTerminalPayload(handle.runId)

    // Same posture: the mandatory flags claudeFlags() always emits, unchanged by resume.
    expect(args).toContain('--permission-mode')
    expect(args).toContain('bypassPermissions')
    expect(args).toContain('--settings')
    expect(args).toContain(input.settingsPath)
    // Same worktree: cwd, echoed by the fake CLI's env-echo fixture.
    expect(payload?.['cwd']).toBe(checkpoint.worktreePath)
  })

  it('falls back to a default continuation prompt when no instruction is queued', async (): Promise<void> => {
    const handle = await adapter.resume(input.runId, checkpoint, null)
    const args = await spawnedArgsFor(handle)

    const pIndex = args.indexOf('-p')
    expect(pIndex).toBeGreaterThanOrEqual(0)
    const prompt = args[pIndex + 1]
    expect(prompt).toBeTruthy()
    expect(prompt).not.toBe('null')
  })

  it('registers the resumed run under the same runId, so events()/cancel() keep working', async (): Promise<void> => {
    const handle = await adapter.resume(input.runId, checkpoint, 'do the other thing')
    expect(handle.runId).toBe(input.runId)

    const seen: string[] = []
    for await (const event of adapter.events(input.runId)) {
      seen.push(event.kind)
    }
    expect(seen.length).toBeGreaterThan(0)
  })
})

function nonExistentRunId(): RunId {
  return makeRunId('run-resume-never-started')
}

describe('ClaudeCodeAdapter.resume against an unknown run', () => {
  it('rejects rather than silently starting a fresh, untracked process', async (): Promise<void> => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), 'aiteamos-adapter-resume-unknown-'))
    try {
      const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'env-echo'] })
      const checkpoint: Checkpoint = {
        sessionId: 'fake-session-orphan',
        worktreePath,
        pauseFlagPath: path.join(worktreePath, 'pause.flag'),
        lastToolUseId: null,
        lastToolName: null,
        numTurns: 0,
        deniedToolUseIds: [],
        headCommit: 'deadbeef',
        dirtyFiles: [],
        cumulativeCostUsd: 0,
        cumulativeTokens: 0,
      }
      await expect(adapter.resume(nonExistentRunId(), checkpoint, null)).rejects.toThrow()
    } finally {
      rmSync(worktreePath, { recursive: true, force: true })
    }
  })
})
