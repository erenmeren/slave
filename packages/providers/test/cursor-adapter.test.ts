import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runId as makeRunId, type RunId } from '@ai-team-os/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CursorAdapter } from '../src/cursor/adapter.js'
import type { Checkpoint } from '../src/claude/checkpoint.js'
import type { StartRunInput } from '../src/claude/adapter.js'
import { buildRegistry } from '../src/index.js'
import type { RuntimeEvent } from '../src/types.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const realGate = path.join(repoRoot, 'scripts/cursor-shell-gate.sh')

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

describe('CursorAdapter', () => {
  let worktreePath: string
  let runDir: string
  let gatePath: string
  let input: StartRunInput

  beforeEach(() => {
    worktreePath = mkdtempSync(path.join(tmpdir(), 'aiteamos-cursor-adapter-'))
    runDir = path.join(worktreePath, 'run')
    mkdirSync(runDir)
    // A fresh copy of the real committed gate per test -- the pre-flight spawns it for real, and
    // nothing here has any business mutating the repository's own file.
    gatePath = path.join(worktreePath, 'cursor-shell-gate.sh')
    writeFileSync(gatePath, readFileSync(realGate))
    chmodSync(gatePath, 0o755)
    input = {
      runId: makeRunId('run-1'),
      prompt: 'do the thing',
      worktreePath,
      pauseFlagPath: path.join(worktreePath, 'pause.flag'),
      runDir,
      gitIdentity: { name: 'Test Agent', email: 'agent@example.com' },
    }
  })

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true })
  })

  /** The adapter under test, pointed at a script that stands in for `cursor-agent`. */
  function adapterFor(command: string): CursorAdapter {
    return new CursorAdapter({ command, gatePath })
  }

  it('cannot pause mid-run but can resume a session', () => {
    const adapter = new CursorAdapter({ command: '/bin/true', gatePath })
    expect(adapter.id).toBe('cursor')
    // `gate` stays at spec §7's `'shell-only'`, unraised. Task 12 registered the gate at
    // `preToolUse` as well as `beforeShellExecution` -- so the hooks file is BROADER than this
    // value claims -- but Step 4's two live runs did not produce a measured block, so there is no
    // proof to raise it with, and a capability may only ever be widened by proof. The task report
    // carries the runs and why they were inconclusive.
    expect(adapter.getCapabilities()).toEqual({
      canPauseMidRun: false,
      canResumeSession: true,
      gate: 'shell-only',
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

  it('sets AITEAMOS_PAUSE_FLAG on the child, which is the only channel the gate reads it on', async () => {
    const envOut = path.join(worktreePath, 'env.txt')
    const script = writeScript(
      worktreePath,
      'env-echo.sh',
      `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' "$AITEAMOS_PAUSE_FLAG" "$GIT_AUTHOR_NAME" "$PWD" > ${JSON.stringify(envOut)}\n`,
    )
    const adapter = adapterFor(script)
    await adapter.start(input)
    await drain(adapter, input.runId)

    expect(readFileSync(envOut, 'utf8')).toBe(`${input.pauseFlagPath}\nTest Agent\n${worktreePath}\n`)
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
