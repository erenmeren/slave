import { appendFileSync, chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runId, type RunId } from '@slave-of-ai/domain'
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
    worktreePath = mkdtempSync(path.join(tmpdir(), 'slaveofai-adapter-'))
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
      // M18 Task 5: the resolved permission matrix's path, written by the caller before `start()`
      // -- see `permissionsFilePath`'s own docstring on `StartRunInput`. No file need actually
      // exist at this path for these tests (the adapter never reads it, only tells the child where
      // it is), matching how `pauseFlagPath` above is exercised the same way.
      permissionsFilePath: path.join(worktreePath, 'permissions.json'),
      gitIdentity: { name: 'Test Slave', email: 'slave@example.com' },
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
    expect(env['SLAVEOFAI_PAUSE_FLAG']).toBe(input.pauseFlagPath)
  })

  it('sets SLAVEOFAI_PERMISSIONS_FILE in the child environment (M18 Task 5)', async (): Promise<void> => {
    // fixture 'env-echo' prints process.env keys as a result payload -- the same fixture and
    // pattern the git-identity/pause-flag test above uses.
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'env-echo'], hookPath })
    await adapter.start(input)
    const env = await collectEnvFrom(adapter, input.runId)
    expect(env['SLAVEOFAI_PERMISSIONS_FILE']).toBe(input.permissionsFilePath)
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
      reportsToolResults: true,
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

describe('ClaudeCodeAdapter and the tool-result tap (M51 R6)', () => {
  let worktreePath: string
  let input: StartRunInput
  let hookPath: string
  const TAP = fileURLToPath(new URL('../../../scripts/tool-result-tap.sh', import.meta.url))
  // The fixture's own two `tool_use` ids (`test/fixtures/complete.ndjson`), which the stream
  // reports a `tool_result` for on its `user` lines.
  const STREAM_ID = 'toolu_01M5xAnwBpu86mkKoXF5sYV3'

  const tapLine = (toolUseId: string, toolName: string): string =>
    `${JSON.stringify({ toolUseId, toolName, outcome: 'ok', errorClass: null })}\n`

  beforeEach(() => {
    worktreePath = mkdtempSync(path.join(tmpdir(), 'slaveofai-adapter-tap-'))
    hookPath = copyGateInto(worktreePath, 'pause-gate.sh')
    input = {
      runId: runId('run-tap-1'),
      prompt: 'do the thing',
      worktreePath,
      pauseFlagPath: path.join(worktreePath, 'pause.flag'),
      runDir: worktreePath,
      permissionsFilePath: path.join(worktreePath, 'permissions.json'),
      gitIdentity: { name: 'Test Slave', email: 'slave@example.com' },
    }
  })

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true })
  })

  async function drain(adapter: ClaudeCodeAdapter, id: RunId): Promise<readonly RuntimeEvent[]> {
    const events: RuntimeEvent[] = []
    for await (const event of adapter.events(id)) events.push(event)
    return events
  }

  it('tells the child where to write, and only when a tap is configured', async (): Promise<void> => {
    const tapped = new ClaudeCodeAdapter({
      command: 'node',
      extraArgs: [FAKE, '--fixture', 'env-echo'],
      hookPath,
      tapPath: TAP,
    })
    await tapped.start(input)
    const withTap = await collectEnvFrom(tapped, input.runId)
    expect(withTap['SLAVEOFAI_TOOL_RESULTS']).toBe(path.join(worktreePath, 'tool-results.ndjson'))

    const untapped = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'env-echo'], hookPath })
    const second: StartRunInput = { ...input, runId: runId('run-tap-2') }
    await untapped.start(second)
    const withoutTap = await collectEnvFrom(untapped, second.runId)
    // Absent, not empty: an armed channel with no hook writing to it is a tailer watching a file
    // nothing creates.
    expect('SLAVEOFAI_TOOL_RESULTS' in withoutTap).toBe(false)
  })

  it('fills a gap the stream left -- a result only the tap reported still reaches the queue', async (): Promise<void> => {
    const adapter = new ClaudeCodeAdapter({
      command: 'node',
      extraArgs: [FAKE, '--fixture', 'complete'],
      hookPath,
      tapPath: TAP,
    })
    await adapter.start(input)
    // Written by hand rather than by the real hook: the fake CLI replays a recording and invokes
    // no hooks at all, so this stands in for the PostToolUse invocation a real run would make.
    // What is under test is the ADAPTER's half -- the tailer, the queue and the dedupe.
    appendFileSync(path.join(worktreePath, 'tool-results.ndjson'), tapLine('toolu_gap', 'Bash'))

    const results = (await drain(adapter, input.runId)).filter((event) => event.kind === 'tool_result')
    expect(results.map((event) => event.toolUseId)).toContain('toolu_gap')
    // With its tool NAME, which is the thing the stream's own `tool_result` line cannot say.
    expect(results.find((event) => event.toolUseId === 'toolu_gap')?.toolName).toBe('Bash')
  })

  it('keeps the FIRST arrival for a contested id, so the pump sees exactly one result for it', async (): Promise<void> => {
    // FIRST ARRIVAL, not producer priority -- and the difference is worth stating, because the race
    // is genuine. The tap's line has to reach the filesystem and wait for the tailer's next poll,
    // so in an unloaded run the stream is first; under load (the whole providers suite at once) the
    // tap was MEASURED winning it. Either way the invariant this test exists for holds: one call,
    // one event. Determinism here comes from writing the tap's line only once the stream's own has
    // already been observed, rather than from betting on the race.
    const adapter = new ClaudeCodeAdapter({
      command: 'node',
      extraArgs: [FAKE, '--fixture', 'complete'],
      hookPath,
      tapPath: TAP,
    })
    await adapter.start(input)

    const events: RuntimeEvent[] = []
    let written = false
    for await (const event of adapter.events(input.runId)) {
      events.push(event)
      if (!written && event.kind === 'tool_result' && event.toolUseId === STREAM_ID) {
        written = true
        appendFileSync(path.join(worktreePath, 'tool-results.ndjson'), tapLine(STREAM_ID, 'Write'))
      }
    }
    expect(written).toBe(true)

    const contested = events.filter(
      (event): event is Extract<RuntimeEvent, { kind: 'tool_result' }> =>
        event.kind === 'tool_result' && event.toolUseId === STREAM_ID,
    )
    // ONE. Two producers, one queue, and `pump.ts` must never write two `run.tool_result` rows for
    // one call.
    expect(contested).toHaveLength(1)
    // The stream's, because it got there first: Claude's `tool_result` block names the id, not the
    // tool, so an empty `toolName` is the stream's signature and `Write` would have been the tap's.
    expect(contested[0]?.toolName).toBe('')
  })

  it('records nothing extra for an untapped run -- every result is the stream’s', async (): Promise<void> => {
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'], hookPath })
    await adapter.start(input)
    const results = (await drain(adapter, input.runId)).filter((event) => event.kind === 'tool_result')
    expect(results).toHaveLength(2)
    for (const event of results) expect(event.toolName).toBe('')
    expect(existsSync(path.join(worktreePath, 'tool-results.ndjson'))).toBe(false)
  })

  it('refuses to spawn when the configured tap is broken', async (): Promise<void> => {
    // A tap is only ever CONFIGURED by a deployment that wants it, and a configured-but-broken tap
    // is the one state nothing downstream can tell from "the tap filled no gap".
    const broken = path.join(worktreePath, 'broken-tap.sh')
    writeFileSync(broken, '#!/usr/bin/env bash\ncat > /dev/null\nexit 0\n')
    chmodSync(broken, 0o755)
    const adapter = new ClaudeCodeAdapter({
      command: 'node',
      extraArgs: [FAKE, '--fixture', 'complete'],
      hookPath,
      tapPath: broken,
    })
    await expect(adapter.start(input)).rejects.toThrow(/tool-result tap preflight failed/u)
  })

  it('emits mid-run usage events, whose output sum is a FLOOR under the terminal figure', async (): Promise<void> => {
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'], hookPath })
    await adapter.start(input)
    const events = await drain(adapter, input.runId)
    const usage = events.filter((event) => event.kind === 'usage')
    expect(usage).toHaveLength(4)
    const output = usage.reduce((total, event) => total + event.output, 0)
    const terminated = events.find((event) => event.kind === 'terminated')
    expect(output).toBe(27)
    expect(terminated?.outcome.tokens?.output).toBe(741)
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
