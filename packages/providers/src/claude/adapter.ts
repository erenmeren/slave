import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { RunId } from '@ai-team-os/domain'
import type { RuntimeEvent } from '../types.js'
import { claudeFlags } from './flags.js'
import { parseStreamLine } from './stream.js'

/**
 * The provider-neutral capability profile a runtime adapter reports (spec
 * §7). Queried, never assumed -- the orchestrator degrades per-field
 * rather than assuming uniform capability across providers.
 */
export interface ProviderCapabilities {
  readonly canPauseMidRun: boolean
  readonly canResumeSession: boolean
  readonly supportsHooks: boolean
  readonly streamsToolCalls: boolean
  readonly reportsTokenUsage: boolean
  readonly supportsCustomSystemPrompt: boolean
  readonly enforcesToolPermissions: boolean
}

/**
 * Everything the adapter needs to spawn one run (spec §7, ADR 0001 §3/§5.5).
 * `settingsPath` and `pauseFlagPath` are supplied by the caller, already
 * absolute -- the adapter refuses to spawn with a relative `settingsPath`
 * (see `claudeFlags`) but does not itself derive either path.
 */
export interface StartRunInput {
  readonly runId: RunId
  readonly prompt: string
  readonly worktreePath: string
  readonly pauseFlagPath: string
  readonly settingsPath: string
  readonly gitIdentity: {
    readonly name: string
    readonly email: string
  }
}

/** What `start()` reports back: enough to find and signal the process later. */
export interface RunHandle {
  readonly runId: RunId
  readonly pid: number
}

/**
 * The provider-neutral contract every runtime adapter implements (spec §7).
 *
 * Built incrementally across M3. This task (M3 Task 6) contributes `id`,
 * `getCapabilities`, `start`, `events` and `cancel`. `requestPause` /
 * `awaitPause` (Task 8) and `resume` / `sendInstruction` (Task 9) extend
 * this interface by TypeScript declaration merging when those tasks land --
 * this file deliberately does not stub them ahead of that work.
 */
export interface AgentRuntimeAdapter {
  readonly id: string
  getCapabilities(): ProviderCapabilities
  start(input: StartRunInput): Promise<RunHandle>
  events(runId: RunId): AsyncIterable<RuntimeEvent>
  cancel(runId: RunId): Promise<void>
}

export interface ClaudeCodeAdapterOptions {
  /** The executable to spawn. Real usage: `'claude'`. Tests: `'node'` running the fake CLI. */
  readonly command: string
  /**
   * Arguments placed before the mandatory `claudeFlags`. Real usage: empty.
   * Tests use this to point `command: 'node'` at the fake CLI script and
   * select its fixture, e.g. `[FAKE, '--fixture', 'complete']`.
   */
  readonly extraArgs?: readonly string[]
  /** Grace period between `SIGTERM` and the `SIGKILL` escalation in `cancel()`. Default 5000ms. */
  readonly killGraceMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A single-producer, single-consumer async queue backing `events()`.
 * Buffers pushed items until something iterates; never drops one. Closing
 * it ends the iteration for whoever is currently waiting (or will next
 * call `next()`), without discarding anything already buffered.
 */
class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T, undefined>) => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter({ value: item, done: false })
    } else {
      this.buffered.push(item)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    return {
      next: (): Promise<IteratorResult<T, undefined>> => {
        if (this.buffered.length > 0) {
          // Length just checked above; shift() cannot return undefined here.
          const value = this.buffered.shift() as T
          return Promise.resolve({ value, done: false })
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve)
        })
      },
    }
  }
}

interface RunState {
  readonly child: ChildProcess
  readonly queue: AsyncEventQueue<RuntimeEvent>
  /**
   * The parsed JSON body of the run's terminal `result` line, kept
   * verbatim -- before `parseStreamLine` normalizes it into `RunOutcome`
   * and drops any field that type does not carry. Test/debug seam only
   * (see `rawTerminalPayload`); it is not part of `AgentRuntimeAdapter`.
   */
  rawResultPayload: Record<string, unknown> | undefined
}

/**
 * Sets the environment the child process is spawned with (ADR 0001,
 * "Concurrency and the git common directory"). Identity is supplied
 * per-process rather than by writing `git config`: two concurrent M0 agents
 * both hit the same missing-identity failure, and the one that recovered
 * with an unscoped `git config user.name/user.email` wrote into the
 * repo-wide `.git/config`, which every worktree shares. Environment
 * variables are per-process, write no file, and cannot leak to a sibling
 * worktree's run.
 */
function buildChildEnv(input: StartRunInput): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: input.gitIdentity.name,
    GIT_AUTHOR_EMAIL: input.gitIdentity.email,
    GIT_COMMITTER_NAME: input.gitIdentity.name,
    GIT_COMMITTER_EMAIL: input.gitIdentity.email,
    AITEAMOS_PAUSE_FLAG: input.pauseFlagPath,
  }
}

/** ADR 0001's measured `ProviderCapabilities` for the Claude Code adapter, verbatim. */
const CLAUDE_CODE_CAPABILITIES: ProviderCapabilities = {
  canPauseMidRun: true,
  canResumeSession: true,
  supportsHooks: true,
  streamsToolCalls: true,
  reportsTokenUsage: true,
  supportsCustomSystemPrompt: false,
  enforcesToolPermissions: true,
}

const DEFAULT_KILL_GRACE_MS = 5_000

export class ClaudeCodeAdapter implements AgentRuntimeAdapter {
  readonly id = 'claude-code' as const

  private readonly command: string
  private readonly extraArgs: readonly string[]
  private readonly killGraceMs: number
  private readonly runs = new Map<RunId, RunState>()

  constructor(options: ClaudeCodeAdapterOptions) {
    this.command = options.command
    this.extraArgs = options.extraArgs ?? []
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  }

  getCapabilities(): ProviderCapabilities {
    return CLAUDE_CODE_CAPABILITIES
  }

  start(input: StartRunInput): Promise<RunHandle> {
    const args = [...this.extraArgs, ...claudeFlags({ settingsPath: input.settingsPath }), '-p', input.prompt]

    return new Promise<RunHandle>((resolve, reject) => {
      const child = spawn(this.command, args, {
        cwd: input.worktreePath,
        env: buildChildEnv(input),
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const queue = new AsyncEventQueue<RuntimeEvent>()
      const state: RunState = { child, queue, rawResultPayload: undefined }
      let settled = false

      // Attached immediately, before anything else -- including the `pid`
      // check just below. A bad command (`ENOENT`) or a `worktreePath`
      // that does not exist is reported by the OS asynchronously, on a
      // later tick than this `spawn()` call returns; `child.pid` is
      // already `undefined` by the time control returns here in both
      // cases (confirmed directly against Node), but the *event* still
      // fires later regardless. Without a listener already registered,
      // that later 'error' event has no handler and Node treats it as an
      // uncaught exception -- taking down the whole orchestrator process
      // for what is an ordinary per-run failure (a stale worktree, a
      // `claude` binary missing from `PATH`). Reproduced by the reviewer
      // for both a bad command and a missing `worktreePath`.
      child.once('error', (error: Error) => {
        if (!settled) {
          settled = true
          reject(
            new Error(`ClaudeCodeAdapter: failed to spawn "${this.command}" for run ${input.runId}: ${error.message}`),
          )
          return
        }
        // The run already started successfully; a later spawn-layer error
        // (e.g. failing to signal the child) is handled the same way the
        // stream simply ending is -- close the queue, do not crash.
        queue.close()
      })

      if (child.pid === undefined) {
        // Handled by the 'error' listener above in the cases actually
        // observed (bad command, bad cwd); this is a fallback for a
        // platform where `pid` is unset with no 'error' event forthcoming.
        if (!settled) {
          settled = true
          reject(new Error(`ClaudeCodeAdapter: failed to spawn "${this.command}" for run ${input.runId}`))
        }
        return
      }
      if (child.stdout === null) {
        // Cannot happen with the fixed `stdio: ['ignore', 'pipe', 'pipe']`
        // above, but the type is `Readable | null` regardless -- checked
        // rather than cast away, so a future stdio change fails loudly
        // here instead of readline receiving a value it was never typed
        // to accept.
        settled = true
        reject(new Error(`ClaudeCodeAdapter: run ${input.runId} has no stdout pipe`))
        return
      }

      this.runs.set(input.runId, state)

      // stderr is drained, not surfaced as a RuntimeEvent: the normalized
      // vocabulary comes entirely from stdout's NDJSON stream (spec §5.4).
      // Draining avoids backpressure stalling the child if it writes a lot.
      child.stderr?.resume()

      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line: string) => {
        captureRawResultPayload(state, line)
        // Read every line, including anything after the terminal `result`
        // line -- ADR 0001 records an async hook reporting late, as the
        // final line of a real capture. A reader that stops at `result`
        // loses it.
        queue.push(parseStreamLine(line))
      })
      lines.once('close', () => queue.close())

      settled = true
      resolve({ runId: input.runId, pid: child.pid })
    })
  }

  events(runId: RunId): AsyncIterable<RuntimeEvent> {
    return this.mustGetRun(runId).queue
  }

  async cancel(runId: RunId): Promise<void> {
    const { child } = this.mustGetRun(runId)
    if (child.exitCode !== null || child.signalCode !== null) return

    await new Promise<void>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        child.kill('SIGKILL')
      }, this.killGraceMs)

      child.once('exit', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      })

      child.kill('SIGTERM')
    })
  }

  /**
   * Test/debug seam, not part of `AgentRuntimeAdapter`: the parsed JSON
   * body of the run's terminal `result` line, before normalization strips
   * fields `RuntimeEvent`/`RunOutcome` do not carry -- notably `env`, which
   * the fake CLI's `env-echo` fixture uses to prove the spawned child's
   * environment (git identity, the pause flag path) without inventing a
   * new field on the shared `RuntimeEvent` union for a test-only need.
   */
  rawTerminalPayload(runId: RunId): Record<string, unknown> | undefined {
    return this.mustGetRun(runId).rawResultPayload
  }

  private mustGetRun(runId: RunId): RunState {
    const state = this.runs.get(runId)
    if (state === undefined) {
      throw new Error(`ClaudeCodeAdapter: no run found for ${runId}`)
    }
    return state
  }
}

function captureRawResultPayload(state: RunState, line: string): void {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return
  }
  if (isRecord(raw) && raw.type === 'result') {
    state.rawResultPayload = raw
  }
}
