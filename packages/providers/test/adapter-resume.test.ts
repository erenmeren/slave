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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Polls for `filePath` to exist, up to `timeoutMs` -- used to observe a grandchild process's pid
 * written by the throwaway orphan-holding script below, which happens asynchronously relative to
 * `start()`/`resume()` returning. */
async function waitForFile(filePath: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(filePath)) {
    if (Date.now() > deadline) {
      throw new Error(`waitForFile: ${filePath} did not appear within ${String(timeoutMs)}ms`)
    }
    await sleep(10)
  }
}

/**
 * Waits for `filePath` (a grandchild's pid, written by the throwaway orphan-holding script below)
 * and pushes it into `pids` -- but the push happens in a `finally` around the wait, not after it,
 * so a `waitForFile` timeout does not skip tracking (fix round 3, finding 1). The grandchild's own
 * `spawn()` call already returned by the time its script starts running at all, so the process
 * exists well before its pid file does; if the file simply had not appeared yet when this test's
 * patience ran out, the process is still real and still needs killing.
 */
async function capturePidFile(filePath: string, pids: number[], timeoutMs = 2000): Promise<void> {
  try {
    await waitForFile(filePath, timeoutMs)
  } finally {
    if (existsSync(filePath)) {
      pids.push(Number(readFileSync(filePath, 'utf8')))
    }
  }
}

describe('ClaudeCodeAdapter.resume', () => {
  let worktreePath: string
  let hookPath: string
  let alwaysDenyHookPath: string
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

    // The same non-discriminating-hook fixture `flags.test.ts`'s `preflightGate` tests already
    // use (finding B's ruling: reuse it, do not invent a second one) -- replicated here rather
    // than imported, since it is a small `beforeEach`-local literal in that file too, not
    // something it exports.
    alwaysDenyHookPath = path.join(worktreePath, 'always-deny.sh')
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

  it('rejects when checkpoint.hookPath is relative', async (): Promise<void> => {
    // Finding B: resume() must run the same absolute-path check start() does, against
    // checkpoint.hookPath -- otherwise the field travels in the checkpoint and is read by
    // nothing, which is the whole defect this finding exists to close.
    await expect(
      adapter.resume(input.runId, { ...checkpoint, hookPath: 'relative/pause-gate.sh' }, null),
    ).rejects.toThrow(/absolute/)
  })

  it('rejects when the hook at checkpoint.hookPath does not discriminate', async (): Promise<void> => {
    // Finding B: the same preflightGate() call start() makes, run against checkpoint.hookPath.
    // alwaysDenyHookPath (beforeEach) is the identical non-discriminating fixture flags.test.ts's
    // preflightGate tests already use -- a hook that denies unconditionally gates nothing, and a
    // resumed run spawned against it would look armed while doing nothing.
    await expect(
      adapter.resume(input.runId, { ...checkpoint, hookPath: alwaysDenyHookPath }, null),
    ).rejects.toThrow()
  })

  it('surfaces the hookPath error before the pause-flag error when both are wrong, pinning runPreflightGate before clearAndVerifyPauseFlagAbsent', async (): Promise<void> => {
    // Pins the order the M5 live-gate fix put in place: runPreflightGate must run before
    // clearAndVerifyPauseFlagAbsent -- not just for finding A's liveness-check timing (see the
    // comment at resume()'s own ordering site), but as its own, separately-swappable pair of lines.
    // No other test in this file gives both checks something to fail on at the same time, so
    // swapping these two lines would stay green everywhere else; this one deliberately hands both
    // a reason to fail and asserts on which error actually surfaces. (Before the M5 fix this order
    // was reversed -- the pause-flag error surfaced first -- because clearAndVerifyPauseFlagAbsent
    // ran first; it was moved after the live-pid check, which itself sits after runPreflightGate.)
    const blockedFlagPath = path.join(worktreePath, 'stuck-pause-order.flag')
    mkdirSync(blockedFlagPath)

    await expect(
      adapter.resume(
        input.runId,
        { ...checkpoint, pauseFlagPath: blockedFlagPath, hookPath: 'relative/pause-gate.sh' },
        null,
      ),
    ).rejects.toThrow(/absolute/)
  })

  it('refuses to resume a runId whose previous process is still running, and does not kill it', async (): Promise<void> => {
    // Finding A, live-child branch: 'hang' never exits on its own, so this process is
    // deliberately still alive when resume() is called -- the case awaitPause resolving
    // gate_failed, or a deadline rejection, would otherwise leave reachable and unmanaged.
    const liveRunId = makeRunId('run-resume-live-child')
    const liveInput: StartRunInput = {
      ...input,
      runId: liveRunId,
      pauseFlagPath: path.join(worktreePath, 'live-pause.flag'),
    }
    const liveAdapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'hang'] })
    // Every pid this test's adapter spawns, tracked the moment it exists -- not only the pid the
    // passing behaviour expects. Fix round 3, finding 1: under a regression, `resume()` below
    // resolves instead of rejecting, spawning a *second* real process for `liveRunId`; the
    // previous version of this test discarded that handle via `await expect(...).rejects`, which
    // throws away a resolved value entirely, leaking the exact process this test exists to prove
    // is never orphaned. A pid is pushed here at the moment it can exist, not at the moment a
    // passing run expects it to.
    const pids: number[] = []

    try {
      const handle = await liveAdapter.start(liveInput)
      pids.push(handle.pid)
      expect(isAlive(handle.pid)).toBe(true)

      const liveCheckpoint: Checkpoint = {
        ...checkpoint,
        worktreePath: liveInput.worktreePath,
        pauseFlagPath: liveInput.pauseFlagPath,
        settingsPath: liveInput.settingsPath,
        hookPath: liveInput.hookPath,
      }

      // A plain try/catch, not `await expect(...).rejects.toThrow(...)`: the latter's whole
      // mechanism is discarding a resolved value, which is precisely what leaked the second
      // process before. Whichever way `resume()` settles, its result is captured and the
      // resolved pid (if any) is recorded before any assertion runs.
      let rejection: unknown
      try {
        const resumedHandle = await liveAdapter.resume(liveRunId, liveCheckpoint, null)
        pids.push(resumedHandle.pid)
      } catch (error) {
        rejection = error
      }

      expect(rejection).toBeInstanceOf(Error)
      expect((rejection as Error).message).toMatch(/still running/)

      // The point of the guard: resume() refusing must not itself have killed the process it
      // declined to adopt. Asserted on the process, not only on the throw.
      expect(isAlive(handle.pid)).toBe(true)
    } finally {
      // This test deliberately leaves a child alive mid-test -- clean up every pid tracked above,
      // regardless of whether the assertions passed. Killed directly by pid, not via
      // `liveAdapter.cancel(liveRunId)`: under a regression `this.runs` now points at the *new*
      // process, and cancel() would kill only that one, not necessarily the original -- direct
      // pid tracking is what makes cleanup independent of the very bookkeeping under test. No
      // assertion in this block, deliberately: a failed cleanup must never mask an earlier
      // assertion failure by throwing over it in `finally`.
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  })

  it('leaves the pause flag in place when a resume is refused for a live pid', async (): Promise<void> => {
    // M5 live-gate finding 1: clearing the flag before the live-pid refusal opens the gate for a
    // still-live child the refusal just declined to adopt -- a refused resume must not un-gate
    // anything. Same live-child setup as the test above, but this one writes a real pause flag
    // file first and asserts on *its* survival, not just the process's.
    const liveRunId = makeRunId('run-resume-live-child-flag')
    const liveFlagPath = path.join(worktreePath, 'live-pause-flag-order.flag')
    const liveInput: StartRunInput = {
      ...input,
      runId: liveRunId,
      pauseFlagPath: liveFlagPath,
    }
    const liveAdapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'hang'] })
    const pids: number[] = []

    try {
      const handle = await liveAdapter.start(liveInput)
      pids.push(handle.pid)
      expect(isAlive(handle.pid)).toBe(true)

      writeFileSync(liveFlagPath, 'operator pause\n')
      expect(existsSync(liveFlagPath)).toBe(true)

      const liveCheckpoint: Checkpoint = {
        ...checkpoint,
        worktreePath: liveInput.worktreePath,
        pauseFlagPath: liveInput.pauseFlagPath,
        settingsPath: liveInput.settingsPath,
        hookPath: liveInput.hookPath,
      }

      let rejection: unknown
      try {
        const resumedHandle = await liveAdapter.resume(liveRunId, liveCheckpoint, null)
        pids.push(resumedHandle.pid)
      } catch (error) {
        rejection = error
      }

      expect(rejection).toBeInstanceOf(Error)
      expect((rejection as Error).message).toMatch(/still running/)

      // The point of this test: a refused resume must not have cleared the flag on its way to
      // refusing. The still-live child's next tool call must still see it and stay gated.
      expect(existsSync(liveFlagPath)).toBe(true)
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  })

  it("closes the previous run's event queue when its process is dead, so a consumer already waiting on it terminates instead of hanging", async (): Promise<void> => {
    // Finding A, dead-child branch. A process's own death does not guarantee its stdout stream
    // ever closes on its own: Node's 'exit' event can fire before every process holding the
    // pipe's write end has released it, and `claude` itself spawning tool subprocesses that
    // inherit that fd is exactly this shape in production. This throwaway script reproduces it
    // deterministically -- it spawns a detached grandchild that inherits its own stdout and
    // hangs indefinitely (holding the pipe open no matter how long anything waits), writes that
    // grandchild's pid to AITEAMOS_TEST_ORPHAN_PID_FILE so this test can kill it explicitly
    // afterward, then hangs itself until signaled. Without resume()'s explicit close() call on
    // the old queue, a consumer already sitting in `for await` over it -- registered before
    // resume() is even called, matching "the orchestrator's pump" finding A describes -- would
    // wait on that queue forever, because nothing else will ever close it.
    const orphanScript = path.join(worktreePath, 'hang-with-orphan.mjs')
    writeFileSync(
      orphanScript,
      [
        "import { spawn } from 'node:child_process'",
        "import { writeFileSync } from 'node:fs'",
        '',
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 3600000)'], {",
        "  stdio: ['ignore', 'inherit', 'ignore'],",
        '  detached: true,',
        '})',
        'grandchild.unref()',
        "writeFileSync(process.env['AITEAMOS_TEST_ORPHAN_PID_FILE'], String(grandchild.pid))",
        '',
        'setInterval(() => {}, 3600000)',
        '',
      ].join('\n'),
    )

    const orphanRunId = makeRunId('run-resume-dead-not-closed')
    const orphanInput: StartRunInput = {
      ...input,
      runId: orphanRunId,
      pauseFlagPath: path.join(worktreePath, 'orphan-pause.flag'),
    }
    const orphanAdapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [orphanScript] })
    const startPidFile = path.join(worktreePath, 'start-grandchild.pid')
    const resumePidFile = path.join(worktreePath, 'resume-grandchild.pid')
    const grandchildPids: number[] = []
    const immediatePids: number[] = []
    const previousOrphanEnv = process.env['AITEAMOS_TEST_ORPHAN_PID_FILE']

    try {
      process.env['AITEAMOS_TEST_ORPHAN_PID_FILE'] = startPidFile
      const handle = await orphanAdapter.start(orphanInput)
      immediatePids.push(handle.pid)
      await capturePidFile(startPidFile, grandchildPids)

      // Registered before resume() is called, over the queue that -- without the fix -- would
      // never close: this run's own process never writes anything either, so nothing is ever
      // pushed to wake it that way.
      let drained = false
      const consumerDone = (async (): Promise<void> => {
        for await (const _event of orphanAdapter.events(orphanRunId)) {
          void _event
        }
        drained = true
      })()

      // Kills the immediate process only -- exitCode/signalCode become non-null, but the
      // grandchild keeps holding the pipe open, so the readline `close` this queue is waiting on
      // still never fires on its own.
      await orphanAdapter.cancel(orphanRunId)
      expect(isAlive(handle.pid)).toBe(false)

      const orphanCheckpoint: Checkpoint = {
        ...checkpoint,
        worktreePath: orphanInput.worktreePath,
        pauseFlagPath: orphanInput.pauseFlagPath,
        settingsPath: orphanInput.settingsPath,
        hookPath: orphanInput.hookPath,
      }
      process.env['AITEAMOS_TEST_ORPHAN_PID_FILE'] = resumePidFile
      const resumedHandle = await orphanAdapter.resume(orphanRunId, orphanCheckpoint, null)
      immediatePids.push(resumedHandle.pid)
      expect(resumedHandle.runId).toBe(orphanRunId)
      await capturePidFile(resumePidFile, grandchildPids)

      // Race the stuck consumer against a timeout: without resume()'s explicit close() on the
      // old queue, consumerDone never settles and this assertion is what turns that into a
      // failing test rather than an actually-hanging one.
      const timedOut = Symbol('timed out')
      const raced = await Promise.race([
        consumerDone.then(() => 'drained' as const),
        sleep(3000).then(() => timedOut),
      ])
      expect(raced).toBe('drained')
      expect(drained).toBe(true)

      await orphanAdapter.cancel(orphanRunId)
    } finally {
      if (previousOrphanEnv === undefined) {
        delete process.env['AITEAMOS_TEST_ORPHAN_PID_FILE']
      } else {
        process.env['AITEAMOS_TEST_ORPHAN_PID_FILE'] = previousOrphanEnv
      }
      // A last sweep, on top of capturePidFile's own retry above: by the time cleanup runs,
      // several more seconds have passed (the rest of the try body, including a 3s race), which
      // is enough time for a pid file that had not yet appeared during capturePidFile's own
      // window to exist now. Checked again here rather than assumed already caught -- the same
      // "track it the moment it can exist" reasoning applied at the last moment this test gets to
      // apply it.
      for (const pidFile of [startPidFile, resumePidFile]) {
        if (existsSync(pidFile)) {
          const pid = Number(readFileSync(pidFile, 'utf8'))
          if (!grandchildPids.includes(pid)) {
            grandchildPids.push(pid)
          }
        }
      }
      // Killed directly by pid, not relied on solely via the cancel() calls above: if an
      // assertion in the try block had failed partway through, a cancel() call might never have
      // run, and the immediate processes would otherwise leak. The grandchildren are detached and
      // outlive cancel() by design regardless, so they always need killing here. No assertions in
      // this block, deliberately -- a failed cleanup must never mask an earlier assertion failure
      // by throwing over it in `finally`. Best-effort: a pid already gone throws, which is fine.
      for (const pid of [...immediatePids, ...grandchildPids]) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
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
