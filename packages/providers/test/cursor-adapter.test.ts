import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runId as makeRunId, type RunId } from '@slave-of-ai/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CursorAdapter } from '../src/cursor/adapter.js'
import type { Checkpoint } from '../src/claude/checkpoint.js'
import type { StartRunInput } from '../src/claude/adapter.js'
import { buildRegistry } from '../src/index.js'
import type { RuntimeEvent } from '../src/types.js'
import { copyGateInto } from './helpers/gate-fixture.js'

/**
 * Every process spawned in this file is REAL -- a small shell script written into the test's own
 * temporary directory, executed by the adapter exactly as `cursor-agent` would be. Nothing here
 * mocks `spawn`, the filesystem, or the gate script: the adapter's whole job is what happens at
 * the process boundary, and a mocked boundary tests nothing about it.
 *
 * The scripts deliberately IGNORE their argv. `cursorFlags` puts `--print --output-format
 * stream-json --trust --force` and the prompt after whatever `extraArgs` supplies, so a real
 * `/bin/sleep` would die on "invalid time interval '--print'" and a test built on it would pass
 * for the wrong reason. A script that ignores argv is what makes `command` genuinely
 * substitutable, which the plan's own sketch depends on.
 */
function writeScript(dir: string, name: string, body: string): string {
  const scriptPath = path.join(dir, name)
  writeFileSync(scriptPath, body)
  chmodSync(scriptPath, 0o755)
  return scriptPath
}

/** A script that writes `lines` to stdout, `stderrText` to stderr, then exits `exitCode`. */
function writeStreamScript(
  dir: string,
  name: string,
  spec: { readonly lines?: readonly string[]; readonly stderrText?: string; readonly exitCode?: number },
): string {
  const ndjsonPath = path.join(dir, `${name}.ndjson`)
  writeFileSync(ndjsonPath, (spec.lines ?? []).map((line) => `${line}\n`).join(''))
  const stderrPath = path.join(dir, `${name}.stderr`)
  writeFileSync(stderrPath, spec.stderrText ?? '')
  return writeScript(
    dir,
    name,
    `#!/bin/sh\ncat ${JSON.stringify(ndjsonPath)}\ncat ${JSON.stringify(stderrPath)} >&2\nexit ${String(spec.exitCode ?? 0)}\n`,
  )
}

/** The pid the quiescence fixture recorded for the grandchild it backgrounded, or `null`. */
function grandchildPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function drain(adapter: CursorAdapter, id: RunId): Promise<RuntimeEvent[]> {
  const seen: RuntimeEvent[] = []
  for await (const event of adapter.events(id)) seen.push(event)
  return seen
}

function terminatedOf(events: readonly RuntimeEvent[]): Extract<RuntimeEvent, { kind: 'terminated' }> {
  const found = events.find((event) => event.kind === 'terminated')
  if (found === undefined || found.kind !== 'terminated') {
    throw new Error(`no terminated event in ${JSON.stringify(events)}`)
  }
  return found
}

const ASSISTANT_LINE = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } })
const RESULT_LINE = JSON.stringify({ type: 'result', subtype: 'success', is_error: false })

/** The measured shape of a hook-rejected tool call's `completed` line (Task 11 §3 Q5). */
function rejectedCompletedLine(callId: string): string {
  return JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: callId,
    tool_call: {
      shellToolCall: {
        result: {
          rejected: {
            command: 'echo epsilon > epsilon.txt',
            reason: 'Command execution was blocked by a hook: Paused by meren.',
          },
        },
      },
      hookAdditionalContexts: [],
    },
  })
}

/**
 * The `tool_call`/`completed` lines a REAL `cursor-agent` run produced when the pause flag was set
 * (M13 Task 9's recorded evidence, committed under `fixtures/cursor/gate/` with its provenance),
 * not synthesized ones. `observeRawLine` reads the rejection out of
 * `tool_call.<name>ToolCall.result.rejected` -- where the tool's NAME is the KEY of the `tool_call`
 * object rather than a field -- and `rejectedCompletedLine` above proves only that this test file
 * agrees with itself about that shape.
 *
 * The recording already caught one way that self-agreement goes stale. `rejectedCompletedLine`'s
 * reason text (`'Command execution was blocked by a hook: ...'`) is M12's, measured against
 * `cursor-agent` 2026.08.11-e8db854; under 2026.08.25-3e8eec8 the recorded reason is instead the
 * gate's own `user_message` verbatim followed by an agent-facing note. The adapter is indifferent
 * to that -- it keys on the PRESENCE of `result.rejected` and never on the reason's wording -- and
 * these two tests exist to keep it that way by pinning it to bytes the binary actually emitted.
 */
const RECORDED_DENY_LINES: readonly string[] = readFileSync(
  new URL('./fixtures/cursor/gate/run-2-flag-present.ndjson', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((line) => line.includes('"rejected"'))

describe('CursorAdapter', () => {
  let worktreePath: string
  let runDir: string
  let gatePath: string
  let input: StartRunInput

  beforeEach(() => {
    worktreePath = mkdtempSync(path.join(tmpdir(), 'slaveofai-cursor-adapter-'))
    runDir = path.join(worktreePath, 'run')
    mkdirSync(runDir)
    // A fresh copy of the real committed gate per test -- the pre-flight spawns it for real, and
    // nothing here has any business mutating the repository's own file. The helper brings
    // `scripts/lib/pause-flag.sh` into `<dir>/lib/` with it: since M13 §4.2 the gate sources its
    // encoder from there, and a copy without the library refuses to run.
    gatePath = copyGateInto(worktreePath, 'cursor-shell-gate.sh')
    input = {
      runId: makeRunId('run-1'),
      prompt: 'do the thing',
      worktreePath,
      pauseFlagPath: path.join(worktreePath, 'pause.flag'),
      runDir,
      // M18 Task 5: the resolved permission matrix's path, written by the caller before `start()`
      // -- see `permissionsFilePath`'s own docstring on `StartRunInput`. No file need actually
      // exist here (the adapter never reads it, only tells the child where it is), matching how
      // `pauseFlagPath` above is exercised the same way.
      permissionsFilePath: path.join(runDir, 'permissions.json'),
      gitIdentity: { name: 'Test Agent', email: 'agent@example.com' },
    }
  })

  afterEach(() => {
    // The quiescence fixture deliberately leaves a 30-second `sleep` alive; nothing else in this
    // file spawns a grandchild, so a missing pid file is the ordinary case rather than a failure.
    const pid = grandchildPid(path.join(runDir, 'grandchild.pid'))
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone -- nothing to clean up.
      }
    }
    rmSync(worktreePath, { recursive: true, force: true })
  })

  /** The adapter under test, pointed at a script that stands in for `cursor-agent`. */
  function adapterFor(command: string): CursorAdapter {
    return new CursorAdapter({ command, gatePath })
  }

  it('cannot pause mid-run but can resume a session', () => {
    const adapter = new CursorAdapter({ command: '/bin/true', gatePath })
    expect(adapter.id).toBe('cursor')
    // `gate` reads `'all-tools'`, measured, not assumed (M13 Task 9/10). The recorded run at
    // `packages/providers/test/fixtures/cursor/gate/run-2-flag-present.ndjson` shows the
    // `preToolUse` registration refusing both a shell command and a file write while the pause
    // flag was present, with the control run (flag absent) showing both succeeding.
    expect(adapter.getCapabilities()).toEqual({
      canPauseMidRun: false,
      canResumeSession: true,
      gate: 'all-tools',
      reportsCost: false,
    })
  })

  it('is what buildRegistry resolves the cursor kind to, once given cursor options', () => {
    const registry = buildRegistry({ cursor: { command: 'cursor-agent', gatePath } })
    expect(registry.resolve('cursor').id).toBe('cursor')
  })

  it("writes .cursor/hooks.json into the worktree, fail-closed, at every step it registers", async () => {
    const adapter = adapterFor(writeStreamScript(runDir, 'quiet.sh', { lines: [RESULT_LINE] }))
    const handle = await adapter.start(input)
    await drain(adapter, input.runId)

    const hooksPath = path.join(worktreePath, '.cursor', 'hooks.json')
    expect(handle.runFiles).toEqual({ settingsPath: hooksPath, hookPath: gatePath })

    const parsed: unknown = JSON.parse(readFileSync(hooksPath, 'utf8'))
    expect(parsed).toEqual({
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: `'${gatePath}'`, failClosed: true }],
        preToolUse: [{ command: `'${gatePath}'`, failClosed: true }],
      },
    })
  })

  it('refuses to spawn anything when the registered gate does not discriminate', async () => {
    // A hook that allows with the pause flag PRESENT is not a gate, it is a green light wearing a
    // gate's name. `start()` must fail before a process exists, not after one is already writing.
    const deadGate = writeScript(worktreePath, 'dead-gate.sh', '#!/bin/sh\ncat > /dev/null\necho \'{"permission":"allow"}\'\n')
    const adapter = new CursorAdapter({ command: '/bin/true', gatePath: deadGate })

    await expect(adapter.start(input)).rejects.toThrow(/preflight/i)
    expect(() => adapter.events(input.runId)).toThrow(/no run found/)
  })

  it('refuses to invent a worktree that has gone missing', async () => {
    const adapter = adapterFor('/bin/true')
    const missing = { ...input, worktreePath: path.join(worktreePath, 'pruned') }

    // Not "mkdir -p and carry on": that would spawn cleanly in a brand-new empty directory and
    // report a healthy run that worked against nothing.
    await expect(adapter.start(missing)).rejects.toThrow(/not an existing directory/)
  })

  it('cancels the process, which is the whole of a Cursor pause (canPauseMidRun: false)', async () => {
    const adapter = adapterFor(writeScript(worktreePath, 'sleeper.sh', '#!/bin/sh\nexec sleep 30\n'))
    const handle = await adapter.start(input)
    expect(isAlive(handle.pid)).toBe(true)

    await adapter.cancel(input.runId)

    expect(isAlive(handle.pid)).toBe(false)
    // The queue must end too, or the pump waits forever on a process that is already gone.
    await drain(adapter, input.runId)
  })

  it('sets SLAVEOFAI_PAUSE_FLAG on the child, which is the only channel the gate reads it on', async () => {
    const envOut = path.join(worktreePath, 'env.txt')
    const script = writeScript(
      worktreePath,
      'env-echo.sh',
      `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' "$SLAVEOFAI_PAUSE_FLAG" "$GIT_AUTHOR_NAME" "$PWD" > ${JSON.stringify(envOut)}\n`,
    )
    const adapter = adapterFor(script)
    await adapter.start(input)
    await drain(adapter, input.runId)

    expect(readFileSync(envOut, 'utf8')).toBe(`${input.pauseFlagPath}\nTest Agent\n${worktreePath}\n`)
  })

  it('sets SLAVEOFAI_PERMISSIONS_FILE on the child (M18 Task 5)', async () => {
    const envOut = path.join(worktreePath, 'permissions-env.txt')
    const script = writeScript(
      worktreePath,
      'permissions-env-echo.sh',
      `#!/bin/sh\nprintf '%s\\n' "$SLAVEOFAI_PERMISSIONS_FILE" > ${JSON.stringify(envOut)}\n`,
    )
    const adapter = adapterFor(script)
    await adapter.start(input)
    await drain(adapter, input.runId)

    expect(readFileSync(envOut, 'utf8')).toBe(`${input.permissionsFilePath}\n`)
  })

  it('ends the stream when the child exits, even while a grandchild holds its stdout open', async () => {
    // THE ONLY SCENARIO THE QUIESCENCE MECHANISM EXISTS FOR, and until this test nothing exercised
    // it: every other script here is well-behaved, so `child.once('close', finalize)` always won
    // and `armQuiesce` was never what ended a stream.
    //
    // MEASURED against the real binary (Task 12 §4): `cursor-agent` leaves detached helpers -- a
    // worker daemon and a typescript-language-server family -- holding an inherited dup of its
    // stdout write end. A pipe closes when the LAST writer does, so neither readline's 'close' nor
    // the child's own 'close' ever fires, and a reader waiting on either hangs forever on a run
    // that has already finished. `sleep 30 &` reproduces exactly that: the backgrounded child
    // inherits this script's stdout and outlives it.
    const ndjson = path.join(runDir, 'grandchild.ndjson')
    writeFileSync(ndjson, `${ASSISTANT_LINE}\n${RESULT_LINE}\n`)
    const pidFile = path.join(runDir, 'grandchild.pid')
    const script = writeScript(
      runDir,
      'grandchild.sh',
      `#!/bin/sh\nsleep 30 &\necho $! > ${JSON.stringify(pidFile)}\ncat ${JSON.stringify(ndjson)}\nexit 0\n`,
    )
    const adapter = adapterFor(script)
    await adapter.start(input)

    const startedAt = Date.now()
    const events = await drain(adapter, input.runId)
    const elapsedMs = Date.now() - startedAt

    // The stream ended at all -- the assertion that would have failed before the exit-based
    // finalize, by hanging until vitest's own timeout rather than by reporting anything.
    expect(terminatedOf(events).outcome.numTurns).toBe(1)
    // And it ended promptly, on the child's exit plus the quiescence window, rather than waiting
    // out the grandchild that is still holding the pipe.
    expect(elapsedMs).toBeLessThan(10_000)
    expect(grandchildPid(pidFile)).not.toBeNull()
  })

  it('derives numTurns by counting assistant lines, overriding the parser documented zero', async () => {
    const adapter = adapterFor(
      writeStreamScript(runDir, 'turns.sh', { lines: [ASSISTANT_LINE, ASSISTANT_LINE, ASSISTANT_LINE, RESULT_LINE] }),
    )
    await adapter.start(input)

    const outcome = terminatedOf(await drain(adapter, input.runId)).outcome
    expect(outcome.numTurns).toBe(3)
    // The figures Cursor genuinely does not report stay unreported.
    expect(outcome.costUsd).toBeNull()
    expect(outcome.stopReason).toBeNull()
  })

  it('reports the tool calls its own gate rejected, read off the completed line', async () => {
    const adapter = adapterFor(
      writeStreamScript(runDir, 'denied.sh', {
        lines: [rejectedCompletedLine('call-a'), rejectedCompletedLine('call-b'), RESULT_LINE],
      }),
    )
    await adapter.start(input)

    expect(terminatedOf(await drain(adapter, input.runId)).outcome.deniedToolUseIds).toEqual(['call-a', 'call-b'])
  })

  it('reads the recorded gate denials off the real stream, not a synthesized one', async () => {
    expect(RECORDED_DENY_LINES.length).toBeGreaterThan(0)

    const adapter = adapterFor(
      writeStreamScript(runDir, 'recorded-denied.sh', { lines: [...RECORDED_DENY_LINES, RESULT_LINE] }),
    )
    await adapter.start(input)

    const outcome = terminatedOf(await drain(adapter, input.runId)).outcome
    const recordedIds = RECORDED_DENY_LINES.map((line) => (JSON.parse(line) as { call_id: string }).call_id)
    expect(outcome.deniedToolUseIds).toEqual(recordedIds)
    // A denied run is a failed run to `pump.ts` even when `is_error` is false -- the list has to be
    // non-empty for that to fire, and the recorded `result` line's subtype IS `success`.
    expect(outcome.deniedToolUseIds.length).toBeGreaterThan(0)
  })

  it('recorded a refused file WRITE alongside the refused shell command', () => {
    // The capability question M13 §5 exists to settle: the gate stops an edit, not only a shell
    // call. `editToolCall` is the key Cursor used for the write, `shellToolCall` for the command,
    // and both carry a `rejected` result in the same recorded run -- in which neither `write.txt`
    // nor `shell.txt` was left on disk. Asserting the KEYS rather than a reason string is the
    // durable half: the reason's wording changed between two binary versions, the keys did not.
    const rejectedToolKeys = RECORDED_DENY_LINES.flatMap((line) => {
      const parsed = JSON.parse(line) as {
        tool_call: Record<string, { result?: { rejected?: unknown } }>
      }
      return Object.entries(parsed.tool_call)
        .filter(([, call]) => call?.result?.rejected !== undefined)
        .map(([key]) => key)
    })
    expect(rejectedToolKeys).toContain('editToolCall')
    expect(rejectedToolKeys).toContain('shellToolCall')
  })

  it('carries the pause gate own deny message into the recorded rejection reason', () => {
    const reasons = RECORDED_DENY_LINES.flatMap((line) => {
      const parsed = JSON.parse(line) as {
        tool_call: Record<string, { result?: { rejected?: { reason?: string } } }>
      }
      return Object.values(parsed.tool_call).map((call) => call?.result?.rejected?.reason ?? '')
    }).filter((reason) => reason !== '')

    // The reason is the gate's `user_message` verbatim -- NOT a fixed `Command execution was
    // blocked by a hook: ` prefix, which is what the older binary emitted and what
    // `rejectedCompletedLine` still hard-codes. Nothing in the adapter may depend on either
    // spelling; this asserts what was measured so that a future change to it is visible here.
    expect(reasons.length).toBe(RECORDED_DENY_LINES.length)
    expect(reasons.every((reason) => reason.startsWith('Paused by the M13 gate evidence run.'))).toBe(true)
  })

  it('names the workspace-trust refusal, with the captured stderr, when the stream is empty', async () => {
    const adapter = adapterFor(
      writeStreamScript(runDir, 'untrusted.sh', {
        lines: [],
        stderrText: '⚠ Workspace Trust Required\n\n  Do you trust the contents of this directory?\n',
        exitCode: 1,
      }),
    )
    await adapter.start(input)

    const outcome = terminatedOf(await drain(adapter, input.runId)).outcome
    expect(outcome.isError).toBe(true)
    expect(outcome.terminalReason).toMatch(/workspace[- ]trust/i)
    expect(outcome.terminalReason).toContain('Workspace Trust Required')
    expect(outcome.terminalReason).toContain('--trust')
  })

  it('leaves a cancelled run to the pump rather than blaming workspace trust for a kill', async () => {
    const adapter = adapterFor(writeScript(worktreePath, 'sleeper2.sh', '#!/bin/sh\nexec sleep 30\n'))
    await adapter.start(input)
    await adapter.cancel(input.runId)

    expect((await drain(adapter, input.runId)).find((event) => event.kind === 'terminated')).toBeUndefined()
  })

  describe('resume', () => {
    function checkpointFor(): Checkpoint {
      return {
        sessionId: 's-1',
        worktreePath,
        pauseFlagPath: input.pauseFlagPath,
        lastToolUseId: null,
        lastToolName: null,
        numTurns: 1,
        deniedToolUseIds: [],
        headCommit: 'abc123',
        dirtyFiles: [],
        cumulativeCostUsd: 0,
        cumulativeTokens: 0,
        settingsPath: path.join(worktreePath, '.cursor', 'hooks.json'),
        hookPath: gatePath,
        gitAuthorName: 'Test Agent',
        gitAuthorEmail: 'agent@example.com',
        provider: 'cursor',
      }
    }

    it('continues a session, passing --resume with its id attached', async () => {
      // `/bin/echo` makes the spawned argv observable: the adapter's own stdout carries it. It is
      // not JSON, so it arrives as `unparsable` -- which is the honest classification and exactly
      // what proves the parser is wired in rather than bypassed.
      const adapter = new CursorAdapter({ command: '/bin/echo', gatePath })
      await adapter.resume(input.runId, checkpointFor(), null)

      const argv = (await drain(adapter, input.runId))
        .map((event) => (event.kind === 'unparsable' ? event.line : ''))
        .join(' ')
      expect(argv).toContain('--resume s-1')
      expect(argv).toContain('--trust')
      // Never `-w`: Cursor's own worktree feature would split the run across two trees.
      expect(argv).not.toContain(' -w ')
    })

    it('makes the queued instruction the resume prompt, verbatim', async () => {
      const adapter = new CursorAdapter({ command: '/bin/echo', gatePath })
      await adapter.resume(input.runId, checkpointFor(), 'stop rewriting the tests')

      const argv = (await drain(adapter, input.runId))
        .map((event) => (event.kind === 'unparsable' ? event.line : ''))
        .join(' ')
      expect(argv).toContain('stop rewriting the tests')
    })

    it('sets SLAVEOFAI_PERMISSIONS_FILE on the child at resume, derived from the checkpoint (M18 Task 5 fix round 1)', async () => {
      // A `pauseFlagPath` in a DIFFERENT directory from `checkpointFor()`'s own `settingsPath`
      // (`worktreePath/.cursor/hooks.json`) and from `input.pauseFlagPath` -- in the default
      // checkpoint these all resolve to `worktreePath`, so a `permissionsFilePath` derivation
      // that accidentally read `checkpoint.settingsPath`'s directory (Cursor's hooks file, in the
      // WORKTREE -- see this adapter's own docstring) instead of `checkpoint.pauseFlagPath`'s
      // would still land on the right answer by coincidence. This directory makes that
      // coincidence impossible, the same reasoning `adapter-resume.test.ts`'s divergent-checkpoint
      // test uses for the Claude adapter.
      const divergentPauseDir = path.join(worktreePath, 'resume-pause-dir')
      mkdirSync(divergentPauseDir)
      const checkpoint: Checkpoint = { ...checkpointFor(), pauseFlagPath: path.join(divergentPauseDir, 'pause.flag') }

      const envOut = path.join(worktreePath, 'resume-permissions-env.txt')
      const script = writeScript(
        worktreePath,
        'resume-permissions-env-echo.sh',
        `#!/bin/sh\nprintf '%s\\n' "$SLAVEOFAI_PERMISSIONS_FILE" > ${JSON.stringify(envOut)}\n`,
      )
      const adapter = adapterFor(script)
      await adapter.resume(input.runId, checkpoint, null)
      await drain(adapter, input.runId)

      expect(readFileSync(envOut, 'utf8')).toBe(`${path.join(divergentPauseDir, 'permissions.json')}\n`)
    })

    it('rewrites the hooks file and clears the pause flag before spawning', async () => {
      writeFileSync(input.pauseFlagPath, 'paused by an operator\n')
      const adapter = new CursorAdapter({ command: '/bin/echo', gatePath })

      await adapter.resume(input.runId, checkpointFor(), null)
      await drain(adapter, input.runId)

      const parsed = JSON.parse(readFileSync(path.join(worktreePath, '.cursor', 'hooks.json'), 'utf8')) as {
        hooks: { beforeShellExecution: readonly { failClosed: boolean }[] }
      }
      expect(parsed.hooks.beforeShellExecution[0]?.failClosed).toBe(true)
      expect(() => readFileSync(input.pauseFlagPath)).toThrow()
    })

    it('refuses to resume while the pause flag survives the clear attempt', async () => {
      // A directory at the flag path cannot be removed by a non-recursive `rm`, so the flag is
      // still there afterwards -- and a resumed run whose gate denies every call looks exactly
      // like one stuck in a pause loop, with nothing anywhere saying why.
      mkdirSync(input.pauseFlagPath)
      const adapter = new CursorAdapter({ command: '/bin/echo', gatePath })

      await expect(adapter.resume(input.runId, checkpointFor(), null)).rejects.toThrow(/pause flag/)
    })
  })
})
