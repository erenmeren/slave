import { spawn, type ChildProcess } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import type { RunId } from '@ai-team-os/domain'
import type { RunOutcome, RuntimeEvent } from '../types.js'
import { claudeFlags, preflightGate } from './flags.js'
import { isPreToolUseHookResponseLine, parseStreamLine } from './stream.js'

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
  /**
   * The `PreToolUse` hook script `settingsPath` registers, already
   * absolute -- `start()` (Task 8) spawns this directly, once, via
   * `preflightGate` before the run is considered pausable. Writing the
   * settings file itself remains a provisioning-time concern outside this
   * adapter (Task 6 report, concern 5); this is only what `start()` needs
   * to check that whatever was registered actually discriminates.
   */
  readonly hookPath: string
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

/**
 * What `awaitPause` resolves to (spec §5.5, ADR 0001 §5). Three outcomes,
 * never conflated:
 *  - `paused`: a `hook_denied` event was observed and the process has
 *    actually exited as a result -- the deterministic pause point.
 *  - `finished_first`: the run's terminal `result` line arrived with no
 *    `hook_denied` and no `hook_failed_open` observed since the flag was
 *    written. Benign -- the hook is only consulted when a tool call is
 *    pending, and none was.
 *  - `gate_failed`: a `hook_failed_open` event was observed since the flag
 *    was written, with no `hook_denied` in between -- spec §5.5's runtime
 *    backstop. The tool ran anyway; the control surface, not the work,
 *    failed.
 */
export type PauseOutcome = 'paused' | 'finished_first' | 'gate_failed'

/**
 * `requestPause` / `awaitPause` (Task 8), declared here as a second
 * declaration of `AgentRuntimeAdapter` -- TypeScript merges interface
 * declarations of the same name in the same module, so this extends the
 * Task 6 interface above rather than replacing it. Kept as a separate
 * block, not folded into the original, so the diff that added it stays
 * legible against Task 6's own history.
 */
export interface AgentRuntimeAdapter {
  /**
   * Writes `reason` into the run's pause flag file (spec §5.5, ADR 0001
   * §5 -- the checkpoint's `pauseReason` has no other door into the
   * system). The reason travels in the flag file's own contents, not an
   * environment variable: the child's environment is fixed at spawn time,
   * before the operator has chosen a reason to pause for.
   * `scripts/pause-gate.sh` (Task 7) reads it back byte-for-byte and falls
   * back to its own static message when the file is empty; this only has
   * to write it.
   */
  requestPause(runId: RunId, reason: string): Promise<void>
  /**
   * Resolves once this run's pause outcome is known, or rejects once
   * `options.deadlineMs` elapses first -- "the pause request carries a
   * deadline rather than waiting indefinitely" (spec §5.5). A timeout is
   * deliberately a rejection, not a fourth `PauseOutcome` value: which of
   * the three real outcomes an unresolved wait represents is unknown, and
   * inventing a value for "we don't know" is exactly the conflation this
   * milestone's measurements exist to prevent.
   */
  awaitPause(runId: RunId, options: { readonly deadlineMs: number }): Promise<PauseOutcome>
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

/**
 * A promise together with the means to settle it from outside its own
 * executor. `AsyncEventQueue` above solves the equivalent problem for a
 * stream of many values with per-`waiter` callbacks; `PauseState.outcome`
 * below needs exactly one value, settled from whichever of several places
 * in the stream-reading code determines it first -- a `Deferred` is the
 * smaller tool for that smaller job.
 */
interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve
  })
  // The executor above runs synchronously inside `new Promise`, so
  // `resolveFn` is always assigned by the time this line runs.
  return { promise, resolve: (value: T): void => resolveFn?.(value) }
}

/**
 * Per-run pause bookkeeping, updated from the same synchronous line-by-line
 * handler that feeds `events()` -- see the single-consumer note on
 * `handlePauseTracking` below for why it lives there rather than being
 * derived by a second reader of the shared queue.
 */
interface PauseState {
  readonly flagPath: string
  /** `undefined` until `requestPause` writes the flag; set once, never cleared. */
  requestedAt: number | undefined
  /** Guards the kill from firing more than once if a second deny is somehow observed. */
  killTriggered: boolean
  /**
   * Set once any `tool_call` event is observed while armed. Together with
   * `sawPreToolUseHookResponseSincePause` below, this is fix round 1's
   * finding 3: the runtime backstop's other shape, where the `PreToolUse`
   * hook was never invoked at all (wrong matcher, unloaded settings) --
   * `hook_failed_open` alone cannot see this, because that event kind only
   * exists when the hook *did* run.
   */
  sawToolCallSincePause: boolean
  /**
   * Set once any `PreToolUse` `hook_response` is observed while armed --
   * deny, crash, fail-open, *or* a plain allow (folded into `ignored` by
   * `parseStreamLine`, with no distinguishing `RuntimeEvent` field; see
   * `isPreToolUseHookResponseLine` for how the allow case is still
   * detected here from the raw line `ignored` still carries).
   */
  sawPreToolUseHookResponseSincePause: boolean
  readonly outcome: Deferred<PauseOutcome>
}

interface RunState {
  readonly child: ChildProcess
  readonly queue: AsyncEventQueue<RuntimeEvent>
  readonly pause: PauseState
  /**
   * Set the moment the run's own genuine terminal `result` line is parsed,
   * independently of whether pause was ever requested. Lets `requestPause`
   * (fix round 1, finding 4) recognize "pause requested against a run that
   * already ended" -- ADR 0001's normal "finished anyway" case, reached
   * here because no further line will ever arrive to resolve it any other
   * way -- and resolve immediately instead of leaving `awaitPause` to
   * reject at the deadline with the flag file still on disk.
   */
  runEnded: boolean
  /**
   * The parsed JSON body of the run's terminal `result` line, kept
   * verbatim -- before `parseStreamLine` normalizes it into `RunOutcome`
   * and drops any field that type does not carry. Test/debug seam only
   * (see `rawTerminalPayload`); it is not part of `AgentRuntimeAdapter`.
   */
  rawResultPayload: Record<string, unknown> | undefined
}

/**
 * The `RunOutcome` carried by the synthetic `terminated` event pushed the
 * moment a `hook_denied` is observed (see `handlePauseTracking`). The real
 * CLI never writes this `result` line for a killed run -- the process is
 * terminated before it gets the chance -- so this is the only account of
 * the run's end a killed run's `events()` consumer ever sees.
 *
 * `isError: false`: a pause the operator asked for and the gate delivered
 * is not a failure of the run. `terminalReason` embeds the hook's own
 * echoed deny reason (`pause-gate.sh` reads it back from the flag file
 * `requestPause` wrote, byte for byte) so a consumer sees the operator's
 * actual words, not a generic placeholder.
 */
function pausedOutcome(hookDenyReason: string): RunOutcome {
  return {
    isError: false,
    terminalReason: `paused: hook denied a tool call (${hookDenyReason})`,
    stopReason: null,
    numTurns: 0,
    costUsd: 0,
    deniedToolUseIds: [],
  }
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

  /**
   * Runs the Task 6 pre-flight gate against `input.hookPath` before
   * spawning anything (spec §5.5: "a written settings file is not an armed
   * gate"). A run whose hook does not discriminate never gets a `RunHandle`
   * or a registered `RunState` at all -- `requestPause` against its
   * `runId` then fails loudly with "no run found" instead of silently
   * writing a flag file nothing will ever read.
   */
  async start(input: StartRunInput): Promise<RunHandle> {
    if (!isAbsolute(input.hookPath)) {
      throw new Error(`ClaudeCodeAdapter: hookPath must be absolute, got ${JSON.stringify(input.hookPath)}`)
    }
    try {
      await preflightGate({ hookPath: input.hookPath })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`ClaudeCodeAdapter: pause-gate preflight failed for run ${input.runId}: ${message}`)
    }
    return this.spawnRun(input)
  }

  private spawnRun(input: StartRunInput): Promise<RunHandle> {
    const args = [...this.extraArgs, ...claudeFlags({ settingsPath: input.settingsPath }), '-p', input.prompt]

    return new Promise<RunHandle>((resolve, reject) => {
      const child = spawn(this.command, args, {
        cwd: input.worktreePath,
        env: buildChildEnv(input),
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const queue = new AsyncEventQueue<RuntimeEvent>()
      const state: RunState = {
        child,
        queue,
        pause: {
          flagPath: input.pauseFlagPath,
          requestedAt: undefined,
          killTriggered: false,
          sawToolCallSincePause: false,
          sawPreToolUseHookResponseSincePause: false,
          outcome: createDeferred<PauseOutcome>(),
        },
        runEnded: false,
        rawResultPayload: undefined,
      }
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
        const event = parseStreamLine(line)
        // Read every line, including anything after the terminal `result`
        // line -- ADR 0001 records an async hook reporting late, as the
        // final line of a real capture. A reader that stops at `result`
        // loses it.
        queue.push(event)
        if (event.kind === 'terminated') {
          // The run's own genuine terminal line -- never true for the
          // synthetic `terminated` pushed by `handlePauseTracking` below,
          // which bypasses this per-line dispatch entirely. Tracked
          // unconditionally (not just while pause is armed) so a
          // `requestPause` arriving *after* this already happened -- ADR
          // 0001's normal "finished anyway" case -- can be recognized as
          // such (fix round 1, finding 4) instead of waiting forever for a
          // line that will never come.
          state.runEnded = true
        }
        // Pause tracking runs *after* the real event is queued, and
        // *inside* this same synchronous line handler rather than as a
        // second consumer of `events()` -- see `handlePauseTracking`'s own
        // comment for why. Ordering matters here specifically: it is what
        // guarantees the synthetic `terminated` event `handlePauseTracking`
        // may push lands immediately after the `hook_denied` that caused
        // it, before any later line -- including a genuinely slower one --
        // can be processed.
        this.handlePauseTracking(state, event)
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
    await this.terminateChild(child)
  }

  /**
   * Writes `reason` into this run's pause flag file, byte for byte --
   * `scripts/pause-gate.sh` reads it back the same way (Task 7). Marking
   * `pause.requestedAt` is what turns on `handlePauseTracking`'s
   * observation of the stream below; before this call it does nothing,
   * because a `hook_denied` or `hook_failed_open` from *before* the
   * operator ever asked for a pause is not a pause-protocol event at all.
   *
   * Fix round 1, finding 4: if the run's own terminal line already arrived
   * -- `state.runEnded` -- no further line will ever come to resolve the
   * outcome through `handlePauseTracking`, and without this check
   * `awaitPause` would wait out its full deadline and reject, leaving the
   * flag file just written on disk for Task 9's `resume` to trip over.
   * ADR 0001 calls "pause requested, run finished anyway" a normal outcome
   * regardless of which side of the request the finish landed on, so this
   * resolves the same way the in-flight case does: `finished_first`.
   */
  async requestPause(runId: RunId, reason: string): Promise<void> {
    const state = this.mustGetRun(runId)
    await writeFile(state.pause.flagPath, reason, 'utf8')
    state.pause.requestedAt = Date.now()
    if (state.runEnded) {
      state.pause.outcome.resolve('finished_first')
    }
  }

  /**
   * Resolves once `handlePauseTracking` (or the `requestPause`-after-the-
   * fact case above) has determined this run's `PauseOutcome`, or rejects
   * once `deadlineMs` elapses first. The flag file is removed on **every**
   * exit path -- success or the deadline rejection alike (fix round 1,
   * finding 4: a leaked flag file on the reject path arms a trap for the
   * next process Task 9's `resume` spawns at the same `pauseFlagPath`) --
   * via `finally`, once the outcome is settled one way or another rather
   * than eagerly at `requestPause` time, which would disarm the gate
   * before its one observation (the deny, or its absence) has happened.
   */
  async awaitPause(runId: RunId, options: { readonly deadlineMs: number }): Promise<PauseOutcome> {
    const state = this.mustGetRun(runId)
    try {
      return await raceWithDeadline(state.pause.outcome.promise, options.deadlineMs, runId)
    } finally {
      await rm(state.pause.flagPath, { force: true })
    }
  }

  /**
   * The kill protocol and the runtime backstop, both spec §5.5, run from
   * here -- inside the same synchronous callback that already parses every
   * line for `events()`, not as a second reader of the shared queue.
   *
   * `events()` hands out one `AsyncEventQueue` per run and that queue is
   * single-consumer: a second `for await` over it would split the stream
   * with whatever already iterates it (the orchestrator's pump, in later
   * milestones). `awaitPause` still needs to observe the same events the
   * pump may already be draining, without stealing any of them. The fix
   * here is to not make `awaitPause` a consumer of `events()` at all --
   * `handlePauseTracking` observes every parsed `RuntimeEvent` at its
   * single point of origin, before it is ever pushed to a queue anyone
   * iterates, and updates `state.pause` directly. `awaitPause` then only
   * awaits `state.pause.outcome.promise`, a plain `Deferred` nothing else
   * reads from. Consumption of `events()` (zero readers, one, or the
   * pump's own future concurrent one) cannot affect this in either
   * direction.
   *
   * The cost: two independent pieces of code now derive meaning from
   * `RuntimeEvent`s -- `events()`'s consumers on one side, this state
   * machine on the other -- rather than the pause outcome being computable
   * by watching the public stream. A future change to what `parseStreamLine`
   * classifies as `hook_denied` / `hook_failed_open` has to be walked
   * through both call sites, not just one, and nothing enforces that
   * mechanically today. Threading pause state through a second consumer of
   * the same `AsyncEventQueue` (e.g. a tee) would avoid that duplication,
   * at the cost of building and testing fan-out machinery `events()`
   * deliberately does not have. For one run's pause outcome -- three
   * possible values, decided by three event kinds -- the duplication is
   * the cheaper of the two costs.
   *
   * Fix round 1, findings 1 and 2: once the kill has been triggered, the
   * outcome is `paused`, full stop -- no later line may resolve it to
   * anything else. Reproduced by the reviewer against a busy event loop
   * (the `hook-deny` fixture at its normal 2ms line delay, with 200ms of
   * synchronous work between `requestPause` and the next drain -- exactly
   * what Task 12's pump does while writing to Postgres): every line still
   * buffered in the pipe when the deny is processed is delivered in the
   * *same* readline turn, including the fixture's own genuine `result`
   * line, well before the async `terminateChild().then()` below ever gets
   * a turn to run. `Deferred.resolve` is idempotent -- first call wins --
   * so whichever branch runs *first* decides the outcome, and without an
   * explicit guard the synchronous `finished_first` (or `gate_failed`) from
   * a still-buffered line wins that race every time, silently discarding
   * the correct `paused` the moment it finally arrives. The fix is not two
   * `if (killTriggered) return` guards bolted onto the two paths the
   * reviewer happened to reproduce -- it is the property that after the
   * kill, the outcome is decided, enforced once, for every branch below it.
   */
  private handlePauseTracking(state: RunState, event: RuntimeEvent): void {
    if (state.pause.requestedAt === undefined) return

    if (event.kind === 'hook_denied') {
      if (state.pause.killTriggered) return
      state.pause.killTriggered = true
      // Pushed synchronously, before the SIGTERM below is even sent: the
      // real CLI never writes a `result` line for a killed run, so this is
      // the only terminal account of the run's end `events()` will ever
      // carry. Pushing it now (rather than waiting for the child to
      // actually exit) is what guarantees it lands immediately after the
      // `hook_denied` that caused it and before anything the child might
      // still manage to write in the window before the signal lands.
      state.queue.push({ kind: 'terminated', outcome: pausedOutcome(event.reason) })
      void this.terminateChild(state.child).then(() => {
        // Resolved only once the process has actually exited (spec §5.5
        // step 3: "on process exit..."), independently of the queue push
        // above -- `awaitPause` callers care that the agent is gone, not
        // merely that a deny was observed.
        state.pause.outcome.resolve('paused')
      })
      return
    }

    // Authoritative once the kill has been triggered (see the method
    // comment above): nothing arriving after this point -- including a
    // line already sitting in the stdout pipe and delivered in the same
    // synchronous readline burst as the deny itself -- may resolve the
    // outcome to anything other than `paused`.
    if (state.pause.killTriggered) return

    if (event.kind === 'tool_call') {
      state.pause.sawToolCallSincePause = true
    }
    if (
      event.kind === 'hook_crashed' ||
      event.kind === 'hook_failed_open' ||
      (event.kind === 'ignored' && isPreToolUseHookResponseLine(event.line))
    ) {
      state.pause.sawPreToolUseHookResponseSincePause = true
    }

    if (event.kind === 'hook_failed_open') {
      // The runtime backstop's first shape (spec §5.5): this event kind
      // exists only for a `PreToolUse` response whose tool call proceeded
      // (exit code 1, 126 or 127 -- `hook_crashed`'s exit-2 is the other,
      // blocking, shape and never reaches this branch). Its mere presence
      // after the flag was written is the whole signal; no separate
      // bookkeeping of which tool call it belongs to is needed. Resolved
      // immediately rather than waiting for the terminal event, matching
      // spec §5.5's "reads the live stream" framing for the backstop.
      state.pause.outcome.resolve('gate_failed')
      return
    }

    if (event.kind === 'terminated') {
      // The run's own genuine terminal `result` line (this branch is never
      // reached for the synthetic one pushed above -- that bypasses this
      // handler entirely).
      if (state.pause.sawToolCallSincePause && !state.pause.sawPreToolUseHookResponseSincePause) {
        // The runtime backstop's other shape (fix round 1, finding 3): a
        // tool call proceeded and *no* `PreToolUse` hook_response of any
        // kind -- not a deny, not a crash, not a fail-open, not even a
        // plain allow -- was ever observed since the flag was written. The
        // hook was never invoked at all: wrong matcher, a settings file
        // that never loaded. `preflightGate` proves the script
        // discriminates; it cannot prove Claude Code actually invokes it
        // (its own docstring says so), so this is the only defence against
        // that failure mode, and it can only be evaluated once the run is
        // over -- a `hook_response` reporting late (ADR 0001) would make an
        // earlier per-line verdict wrong.
        state.pause.outcome.resolve('gate_failed')
        return
      }
      // Nothing since the flag was written resolved the outcome any other
      // way, so the run simply had no more tool calls pending when the
      // operator asked to pause -- spec §5.5's "pause requested, run
      // finished anyway" normal outcome.
      state.pause.outcome.resolve('finished_first')
    }
  }

  /** Shared by `cancel()` and the deny-triggered kill above: SIGTERM, escalating to SIGKILL after `killGraceMs`. */
  private terminateChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

    return new Promise<void>((resolve) => {
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

/**
 * Awaits `promise`, but rejects once `deadlineMs` elapses first --
 * `awaitPause`'s "the pause request carries a deadline rather than waiting
 * indefinitely" (spec §5.5). `promise` (a `Deferred`'s) is never abandoned;
 * this only stops *waiting* on it, so a late resolution after the deadline
 * has passed is simply never observed by this call, not any kind of error.
 */
function raceWithDeadline<T>(promise: Promise<T>, deadlineMs: number, runId: RunId): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`ClaudeCodeAdapter: awaitPause for run ${runId} did not resolve within ${deadlineMs}ms`))
    }, deadlineMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
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
