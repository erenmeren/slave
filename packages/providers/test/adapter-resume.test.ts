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
    // resume() against the same runId. Not load-bearing for resume() itself (fix round 1: it no
    // longer reads anything back off this adapter's memory of `start()`), only so a run's own
    // stdout is fully consumed before the next thing touches it.
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
      // Equal to `input`'s own values here, deliberately -- these tests exercise other parts of
      // the contract. The divergence test below ("resumes using the checkpoint's own spawn
      // fields...") is the one that sets these to something different from `input` and proves
      // which source actually reached the spawned process.
      settingsPath: input.settingsPath,
      hookPath: input.hookPath,
      gitAuthorName: input.gitIdentity.name,
      gitAuthorEmail: input.gitIdentity.email,
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

  it("resumes using the checkpoint's own spawn fields, not the adapter's memory of the original start()", async (): Promise<void> => {
    // Deliberately different from `input`'s own settingsPath/gitIdentity, and absolute (required
    // by `claudeFlags`) -- if `resume()` still read `settingsPath`/`gitAuthorName`/
    // `gitAuthorEmail` off `mustGetRun(runId).startInput` the way it did before fix round 1, the
    // spawned process would show `input`'s values here instead, and this test would fail. Every
    // other test in this file leaves the checkpoint's four fields equal to `input`'s own (set in
    // `beforeEach`), which is exactly why none of them can tell the two sources apart -- only
    // this divergence proves which one `resume()` actually used.
    const divergentCheckpoint: Checkpoint = {
      ...checkpoint,
      settingsPath: path.join(worktreePath, 'divergent-settings.json'),
      gitAuthorName: 'Divergent Author',
      gitAuthorEmail: 'divergent@example.com',
    }

    const handle = await adapter.resume(input.runId, divergentCheckpoint, 'do the other thing')
    const args = await spawnedArgsFor(handle)
    const payload = adapter.rawTerminalPayload(handle.runId)
    const env = z.record(z.string(), z.string().optional()).parse(payload?.['env'])

    const settingsIndex = args.indexOf('--settings')
    expect(settingsIndex).toBeGreaterThanOrEqual(0)
    expect(args[settingsIndex + 1]).toBe(divergentCheckpoint.settingsPath)
    expect(args[settingsIndex + 1]).not.toBe(input.settingsPath)

    expect(env['GIT_AUTHOR_NAME']).toBe('Divergent Author')
    expect(env['GIT_AUTHOR_EMAIL']).toBe('divergent@example.com')
    expect(env['GIT_COMMITTER_NAME']).toBe('Divergent Author')
    expect(env['GIT_COMMITTER_EMAIL']).toBe('divergent@example.com')
    expect(env['GIT_AUTHOR_NAME']).not.toBe(input.gitIdentity.name)
    expect(env['GIT_AUTHOR_EMAIL']).not.toBe(input.gitIdentity.email)
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

function neverStartedRunId(): RunId {
  return makeRunId('run-resume-never-started')
}

/**
 * Fix round 1 inverts this describe block's whole contract. Before the fix, `resume()` read
 * `settingsPath`/`hookPath`/`gitIdentity` off `this.mustGetRun(runId).startInput` -- this adapter
 * instance's own memory of a prior `start()` call against `runId` -- so a `runId` with no such
 * memory had to reject: there was nowhere else to get those fields from. Now that `Checkpoint`
 * itself carries them, that lookup is gone, and resuming a `runId` this adapter instance never
 * `start()`-ed is the *normal* case, not an error: it is exactly what surviving a daemon restart
 * looks like from a fresh adapter instance's point of view -- the checkpoint was written by a
 * process that no longer exists, and everything `resume()` needs travels in `checkpoint` instead
 * of in this instance's memory. A future reader must not "restore" the old rejecting assertion
 * below; the old test was pinning a limitation this fix deliberately removed, not a contract that
 * still holds.
 */
describe('ClaudeCodeAdapter.resume against a runId this adapter instance never started', () => {
  it('resumes successfully, and afterwards events()/cancel() work against the resumed run', async (): Promise<void> => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), 'aiteamos-adapter-resume-unknown-'))
    try {
      const hookPath = path.join(worktreePath, 'pause-gate.sh')
      writeFileSync(hookPath, readFileSync(realGate))
      chmodSync(hookPath, 0o755)

      // A fresh adapter instance, deliberately -- never handed this runId to `start()`, matching
      // what a daemon restart actually looks like: a new process with no memory of prior runs.
      const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'env-echo'] })
      const runId = neverStartedRunId()
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
        settingsPath: path.join(worktreePath, 'settings.json'),
        hookPath,
        gitAuthorName: 'Orphan Author',
        gitAuthorEmail: 'orphan@example.com',
      }

      const handle = await adapter.resume(runId, checkpoint, null)
      expect(handle.runId).toBe(runId)

      // events() works against the resumed run: spawnChild registered a fresh RunState under
      // `runId`, so this is not an "untracked" process despite no prior start() on this instance.
      const seen: string[] = []
      for await (const event of adapter.events(runId)) {
        seen.push(event.kind)
      }
      expect(seen.length).toBeGreaterThan(0)

      // cancel() works too, for the same reason -- and resolves cleanly even though env-echo has
      // already exited by this point (terminateChild is a no-op once the child already exited).
      await expect(adapter.cancel(runId)).resolves.toBeUndefined()
    } finally {
      rmSync(worktreePath, { recursive: true, force: true })
    }
  })
})
