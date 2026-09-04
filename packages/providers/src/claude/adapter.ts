import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { RunId } from '@ai-team-os/domain'
import { capabilitiesOf } from '../capabilities.js'
import { listClaudeCodeModels, type ModelListing } from '../models.js'
import { AsyncEventQueue } from '../runtime/event-queue.js'
import { clearAndVerifyPauseFlagAbsent } from '../runtime/pause-flag.js'
import { buildChildEnv, permissionsFilePathFor, terminateChild } from '../runtime/process.js'
import { isRecord } from '../runtime/summary.js'
import type { RunOutcome, RuntimeEvent } from '../types.js'
import type { Checkpoint } from './checkpoint.js'
import { claudeFlags, preflightGate } from './flags.js'
import { writeSettingsFile } from './settings.js'
import { parseStreamLine } from './stream.js'

/**
 * What a runtime can promise. Every member has exactly one consumer in the system --
 * a capability nothing reads is a claim nothing checks, so it does not exist here.
 */
export interface ProviderCapabilities {
  /** Consumed by the pause strategy: can this runtime stop between tool calls? */
  readonly canPauseMidRun: boolean
  /** Consumed by the pause strategy: can a stopped session be continued? */
  readonly canResumeSession: boolean
  /** Consumed by gate semantics and the roster's provider mark. */
  readonly gate: 'all-tools' | 'shell-only' | 'none'
  /** Consumed by budget admission: does this runtime report spend in USD? */
  readonly reportsCost: boolean
}

/**
 * Everything the adapter needs to spawn one run (spec §7, ADR 0001 §3/§5.5). `worktreePath` and
 * `pauseFlagPath` are supplied by the caller, already absolute.
 *
 * M12 Decision of Record #1: no caller outside `packages/providers` may know that this runtime
 * keeps a settings file, a hook script, or where either lives -- `settingsPath` and `hookPath` used
 * to live here for exactly that reason, and both are gone now. `runDir` is the one opaque handle
 * the orchestrator still supplies (`packages/control`'s `runFilePaths`, an already-created, empty
 * per-run scratch directory); everything this adapter keeps inside it -- today just the settings
 * file this adapter writes and registers `hookPath` (a `ClaudeCodeAdapterOptions` constructor
 * option now, not a per-run input) into -- is this adapter's own business, reported back to the
 * caller opaquely on `RunHandle.runFiles` for the one thing a caller genuinely needs it for: a
 * resumed run finding the same files.
 */
export interface StartRunInput {
  readonly runId: RunId
  readonly prompt: string
  readonly worktreePath: string
  readonly pauseFlagPath: string
  readonly runDir: string
  /**
   * The permission matrix's resolved deny list for this run (M18 Task 5), already written to disk
   * by the caller as `permissions.json` inside `runDir` (`packages/control`'s
   * `writePermissionsFile`, called once per start AND once per resume) -- this adapter never
   * resolves the matrix itself, only tells the child where to find the resolved file, exactly the
   * way `pauseFlagPath` already works. Required, not optional: every dispatch site writes the file
   * before calling `start()`, even when the resolved deny list is empty.
   */
  readonly permissionsFilePath: string
  readonly gitIdentity: {
    readonly name: string
    readonly email: string
  }
  /**
   * The resolved model override (M10 §6), already the caller's chosen value -- this adapter does
   * not itself consult a worker/roster/template chain, `resolveRuntime` (M12 Task 8; defined in
   * `packages/control/src/runtime.ts` since Task 9, re-exported from
   * `apps/orchestrator/src/model.ts`) does that before calling `start()`. `undefined` means "no override": `--model` is
   * omitted entirely rather than passed with some sentinel, so a legacy run with no override
   * behaves exactly as it did before this field existed.
   */
  readonly model?: string
}

/** What `start()` reports back: enough to find and signal the process later. */
export interface RunHandle {
  readonly runId: RunId
  readonly pid: number
  /**
   * The provider-private files this run needs in order to be resumed later, exactly as this
   * adapter actually wrote them. The orchestrator relays these into the checkpoint verbatim and
   * never interprets them -- only the adapter that produced them reads them back (`resume`, off
   * `Checkpoint.settingsPath`/`Checkpoint.hookPath`). Named `settingsPath`/`hookPath` rather than
   * something provider-neutral on purpose: the Postgres `Checkpoint` columns are frozen under
   * those exact names for this milestone, and a second runtime whose run files do not fit this pair
   * generalizes it in its own task, at the cost of one interface field.
   */
  readonly runFiles: { readonly settingsPath: string; readonly hookPath: string }
}

/**
 * The provider-neutral contract every runtime adapter implements (spec §7).
 *
 * Built incrementally across M3. This task (M3 Task 6) contributes `id`,
 * `getCapabilities`, `start`, `events` and `cancel`. `resume` /
 * `sendInstruction` (Task 9) extends this interface by TypeScript
 * declaration merging when that task lands -- this file deliberately does
 * not stub it ahead of that work.
 *
 * `requestPause` and `awaitPause` (M3 Task 8) briefly lived here too and are
 * gone (M12 Task 4, controller ruling). They only ever worked for a run
 * registered in *this adapter instance's own in-memory state*, but pause is
 * a cross-process control signal -- a CLI invocation, a web request and the
 * daemon each call it from a process that never called this run's
 * `start()` -- so nothing could ever call them for real (M12 Task 3 proved
 * this). Pause is a stateless flag-file write instead
 * (`packages/providers`'s `signalPause`); the adapter itself has no pause
 * method at all.
 */
export interface AgentRuntimeAdapter {
  readonly id: string
  getCapabilities(): ProviderCapabilities
  /**
   * The models an operator can pick for this provider (M25 §5.1) -- `listProviderModels(kind)`
   * gives the same answer without an adapter.
   */
  listModels(): Promise<ModelListing>
  start(input: StartRunInput): Promise<RunHandle>
  events(runId: RunId): AsyncIterable<RuntimeEvent>
  cancel(runId: RunId): Promise<void>
}

/**
 * `resume` (Task 9), declared here as a third declaration-merged block for the same reason the
 * pause block above is separate from Task 6's -- so the diff that added it stays legible against
 * this interface's own history.
 */
export interface AgentRuntimeAdapter {
  /**
   * Clears `checkpoint.pauseFlagPath`, **verifies it is actually absent**, then spawns
   * `claude -p "<prompt>" --resume <checkpoint.sessionId>` in `checkpoint.worktreePath`, with the
   * same `--settings` and permission posture the paused run used (ADR 0001 §5.7/§6). The
   * verification is the point of the step, not ceremony: a flag file that survives the clear
   * attempt makes the hook deny the resumed run's first tool call, and every one after it -- a
   * resumed run that looks, from the outside, exactly like a run stuck in a pause loop, with no
   * error anywhere to say why. `resume` never rewrites `checkpoint.sessionId` (ADR 0001 §5: a
   * plain `--resume` reports the same UUID) and never passes `--fork-session`, which would mint a
   * new one.
   *
   * `queuedInstruction` becomes the resume prompt verbatim when supplied. The CLI has no notion
   * that a resume follows a pause -- it treats the prompt as an ordinary next turn (ADR 0001 §6).
   * When `null` (no instruction queued), a generic continuation prompt is substituted: `-p` still
   * needs *some* text in headless mode, and there is no queued operator instruction to supply it.
   *
   * Resuming a `runId` this adapter instance never itself `start()`-ed is the normal case, not an
   * error -- that is exactly what surviving a daemon restart means (fix round 1). `checkpoint`
   * alone carries everything the spawn needs (`settingsPath`, `hookPath`, `gitAuthorName`,
   * `gitAuthorEmail`, alongside `worktreePath`/`pauseFlagPath`/`sessionId`), so `resume` does not
   * look up any prior in-memory record of `runId` before spawning. `spawnChild` (below) registers
   * a fresh `RunState` under `runId` regardless of whether one already existed, which is what
   * makes `events()`/`cancel()` work against the resumed run afterwards -- the process is tracked
   * from the moment it is spawned, not "untracked" for having no prior `start()` on this instance.
   */
  resume(runId: RunId, checkpoint: Checkpoint, queuedInstruction: string | null): Promise<RunHandle>
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
  /**
   * The `PreToolUse` hook script this adapter registers in every settings file it writes
   * (`start`/`resume`), and spawns directly for the Task 6 preflight gate on every `start()` call.
   * One adapter instance, one hook script -- moved here from a per-run `StartRunInput` field (M12
   * Task 2): the hook is a fact about this *runtime*, the orchestrator's own copy of
   * `scripts/pause-gate.sh`, never something that varies run to run. Must be absolute; enforced by
   * `runPreflightGate` before anything is spawned.
   */
  readonly hookPath: string
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
  /**
   * The `StartRunInput` this run's current process was actually spawned with -- from `start()`
   * the first time, or from the `StartRunInput`-shaped object `resume()` builds each time after.
   * Record-keeping only as of fix round 1: `resume()` no longer reads this back (`Checkpoint` now
   * carries `settingsPath`/`hookPath`/`gitAuthorName`/`gitAuthorEmail` itself, precisely so a
   * fresh adapter instance with no memory of this run's `start()` can still resume it), but
   * `spawnChild` still records it uniformly for both callers rather than special-casing which one
   * needs it kept, the same reasoning `rawResultPayload` is stored unconditionally for.
   */
  readonly startInput: StartRunInput
}

/**
 * Substituted for `resume()`'s `-p` prompt when `queuedInstruction` is `null` -- headless mode
 * still needs *some* prompt text, and there is no queued operator instruction to supply it. Its
 * exact wording is not part of the resume contract (ADR 0001 does not specify one; only that a
 * queued instruction, when present, becomes the prompt verbatim), only that resuming without a
 * queued instruction does not crash or silently pass an empty string.
 */
const DEFAULT_RESUME_PROMPT = 'Continue the paused run.'

const DEFAULT_KILL_GRACE_MS = 5_000

export class ClaudeCodeAdapter implements AgentRuntimeAdapter {
  readonly id = 'claude-code' as const

  private readonly command: string
  private readonly extraArgs: readonly string[]
  private readonly killGraceMs: number
  private readonly hookPath: string
  private readonly runs = new Map<RunId, RunState>()

  constructor(options: ClaudeCodeAdapterOptions) {
    this.command = options.command
    this.extraArgs = options.extraArgs ?? []
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    this.hookPath = options.hookPath
  }

  /**
   * Delegated to `capabilitiesOf`, the one capability table (M12 Task 9): a capability is a fact
   * about a KIND, and both budget-admission points have to read it without an adapter instance to
   * read it from. ADR 0001's measured values for this adapter live there now, unchanged -- what
   * moved is where they are written down, not what they say. Keeping a second copy here would
   * mean the pause strategy and the budget check could silently come to disagree.
   */
  getCapabilities(): ProviderCapabilities {
    return capabilitiesOf('claude_code')
  }

  listModels(): Promise<ModelListing> {
    return Promise.resolve(listClaudeCodeModels())
  }

  /**
   * Runs the Task 6 pre-flight gate against `this.hookPath` before spawning anything (spec §5.5:
   * "a written settings file is not an armed gate"). A run whose hook does not discriminate never
   * gets a `RunHandle` or a registered `RunState` at all -- `cancel` against its `runId` then fails
   * loudly with "no run found" instead of silently controlling a process that was never spawned.
   * `runPreflightGate` below is shared with `resume()` (fix round 2, finding B): the gate must be
   * re-armed on every spawn, not just the first one.
   *
   * M12 Task 2: this is also where the settings file itself gets written now, into
   * `input.runDir` -- a provisioning-time concern that used to live outside this adapter (Task 6
   * report, concern 5; M12's Decision of Record #1 is what closes it). `runPreflightGate` runs
   * first regardless: it validates `this.hookPath`, not anything derived from `input`, so there is
   * nothing to gain by writing the settings file before knowing the hook it points at actually
   * works.
   */
  async start(input: StartRunInput): Promise<RunHandle> {
    await this.runPreflightGate(this.hookPath, input.runId)
    const settingsPath = join(input.runDir, 'settings.json')
    writeSettingsFile({ settingsPath, hookPath: this.hookPath })
    return this.spawnRun(input, settingsPath)
  }

  /**
   * The Task 6 pre-flight gate itself, factored out so `start()` and `resume()` (fix round 2,
   * finding B) run the identical check rather than duplicating it. Checked on every spawn, not
   * once per run: `resume()` carries `hookPath` across a process boundary specifically so a hook
   * that lost its exec bit or was pruned with a stale worktree between pause and resume fails
   * loudly here, at spawn time, instead of silently -- the resumed process would otherwise spawn
   * clean, and a real pause request afterward would write a flag no hook ever reads, with nothing
   * naming the dead gate.
   */
  private async runPreflightGate(hookPath: string, runId: RunId): Promise<void> {
    if (!isAbsolute(hookPath)) {
      throw new Error(`ClaudeCodeAdapter: hookPath must be absolute, got ${JSON.stringify(hookPath)}`)
    }
    try {
      await preflightGate({ hookPath })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`ClaudeCodeAdapter: pause-gate preflight failed for run ${runId}: ${message}`)
    }
  }

  private spawnRun(input: StartRunInput, settingsPath: string): Promise<RunHandle> {
    const args = [
      ...this.extraArgs,
      ...claudeFlags({ settingsPath }),
      '-p',
      input.prompt,
      // Omitted entirely, not passed with a sentinel, when unset -- a legacy run with no override
      // anywhere in the chain must spawn with exactly the args it always has.
      ...(input.model !== undefined ? ['--model', input.model] : []),
    ]
    return this.spawnChild({
      runId: input.runId,
      args,
      cwd: input.worktreePath,
      env: buildChildEnv({
        gitIdentity: input.gitIdentity,
        pauseFlagPath: input.pauseFlagPath,
        permissionsFilePath: input.permissionsFilePath,
      }),
      startInput: input,
      runFiles: { settingsPath, hookPath: this.hookPath },
    })
  }

  /**
   * The child-process bootstrapping both `start()` (via `spawnRun` above) and `resume()` share --
   * spawn, wire up a fresh `RunState`, and pump stdout into `events()`. Parameterized on
   * `args`/`cwd`/`env` rather than on `StartRunInput` directly so `resume()` can supply its own
   * (same worktree, same settings and posture, plus `--resume <sessionId>`) without duplicating
   * everything below it. `spec.startInput` is recorded on the resulting `RunState` regardless of
   * which caller this is -- see that field's own docstring for what it is kept for as of fix
   * round 1.
   */
  private spawnChild(spec: {
    readonly runId: RunId
    readonly args: readonly string[]
    readonly cwd: string
    readonly env: NodeJS.ProcessEnv
    readonly startInput: StartRunInput
    readonly runFiles: RunHandle['runFiles']
  }): Promise<RunHandle> {
    return new Promise<RunHandle>((resolve, reject) => {
      const child = spawn(this.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const queue = new AsyncEventQueue<RuntimeEvent>()
      const state: RunState = {
        child,
        queue,
        rawResultPayload: undefined,
        startInput: spec.startInput,
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
            new Error(`ClaudeCodeAdapter: failed to spawn "${this.command}" for run ${spec.runId}: ${error.message}`),
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
          reject(new Error(`ClaudeCodeAdapter: failed to spawn "${this.command}" for run ${spec.runId}`))
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
        reject(new Error(`ClaudeCodeAdapter: run ${spec.runId} has no stdout pipe`))
        return
      }

      this.runs.set(spec.runId, state)

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
      })
      lines.once('close', () => queue.close())

      settled = true
      resolve({ runId: spec.runId, pid: child.pid, runFiles: spec.runFiles })
    })
  }

  events(runId: RunId): AsyncIterable<RuntimeEvent> {
    return this.mustGetRun(runId).queue
  }

  async cancel(runId: RunId): Promise<void> {
    const { child } = this.mustGetRun(runId)
    await terminateChild(child, this.killGraceMs)
  }

  /**
   * See the `AgentRuntimeAdapter.resume` docstring for the contract. This implementation, in
   * order (fix round 2 added steps 1 and 2; the M5 live-gate fix reordered step 3 below step 2;
   * the order itself is deliberate, not incidental):
   *
   * 1. Re-arms the pause gate at `checkpoint.hookPath` (`runPreflightGate`, shared with `start()`)
   *    -- finding B: without this, `hookPath` travels in the checkpoint and is read by nothing,
   *    and a hook that lost its exec bit or was pruned between pause and resume spawns silently
   *    instead of failing loudly here. First, so its delay (it spawns the hook script twice) has
   *    already run by the time step 2 below reads the child's liveness.
   * 2. Refuses to clobber a still-live process already registered under `runId` -- finding A:
   *    `spawnChild`'s `this.runs.set` is unconditional, and `resume()` makes an already-registered
   *    `runId` the *expected* input rather than a caller error, so a live entry left behind by an
   *    earlier `resume()` call this one is retrying, or a `start()` whose caller never called
   *    `cancel()`, would otherwise become unreachable -- its queue stranded, its pause flag file
   *    fought over by two processes. A *dead*-child entry is not an error: its queue is closed here, before
   *    `spawnChild` replaces the map entry, so a consumer still `for await`-ing the old queue (the
   *    orchestrator's pump) is woken with `done: true` instead of hanging on an object `events()`
   *    will never hand out again.
   * 3. Clears and verifies `checkpoint.pauseFlagPath` (`clearAndVerifyPauseFlagAbsent`, shared with
   *    `CursorAdapter` in `runtime/pause-flag.ts`) -- moved here, *after* step 2, by the M5
   *    live-gate fix (finding 1): a refused resume must not open the gate for the live child it
   *    just declined to adopt. Before this change the flag was cleared first, unconditionally, so
   *    a resume refused for a live pid still un-gated it --
   *    live in production, the refused resume let a still-running real CLI keep writing under a
   *    run already marked `failed`. Defence in depth: the pump now kills the child before a
   *    checkpoint's pause is ever recorded (see `apps/orchestrator/src/pump.ts`'s `hook_denied`
   *    handling), so by the time any resume reaches here the pid should already be dead and step 2
   *    should never throw in practice -- this ordering is what keeps the guarantee true regardless.
   * 4. Builds a fresh `StartRunInput`-shaped object entirely from `checkpoint` and the arguments
   *    given -- `gitIdentity` (reassembled from `checkpoint.gitAuthorName`/
   *    `checkpoint.gitAuthorEmail`) comes from the checkpoint itself (fix round 1), not from any
   *    prior in-memory record of `runId`, which is what makes resuming a `runId` this adapter
   *    instance never `start()`-ed work. The checkpoint's worktree and pause-flag path are its
   *    authoritative view of "where this run currently lives"; the resume prompt replaces the
   *    original one; everything else carries forward -- then spawns it through the exact same
   *    `spawnChild` pipeline `start()` uses, with `--resume <sessionId>` appended.
   *
   * M12 Task 2: the settings file is rewritten here too (`writeSettingsFile`, straight after the
   * preflight gate below), at `checkpoint.settingsPath`, registering `checkpoint.hookPath` -- the
   * exact pair `start()` originally wrote. This is not "the file might be missing" defensiveness so
   * much as symmetry: `start()` writes on every spawn, and `resume()` is a spawn. The content is
   * unchanged from what was already there (a paused run's `runDir` still holds the original file),
   * so this never changes what a resumed run sees, only who last touched it.
   */
  async resume(runId: RunId, checkpoint: Checkpoint, queuedInstruction: string | null): Promise<RunHandle> {
    await this.runPreflightGate(checkpoint.hookPath, runId)
    writeSettingsFile({ settingsPath: checkpoint.settingsPath, hookPath: checkpoint.hookPath })

    // Fix round 3, the coordinator's ruling, still true after the M5 reorder above: this order is
    // load-bearing for the live-child check just below, not merely convenient. Probed 200 times
    // against a real child process: readline's `'close'` on `child.stdout` fires *before* the
    // child's own `'exit'` event in 200/200 runs, and at that exact instant
    // `child.exitCode === null && child.signalCode === null` still holds -- meaning the liveness
    // predicate below does not mean "the process is dead", it means "Node has observed the stream
    // end", and a caller that drains `events()` to completion and calls `resume()` immediately
    // afterward is inside a real, measured false-positive window where the predicate would wrongly
    // read "still alive". `runPreflightGate` above (spawns the hook script twice, tens of
    // milliseconds) is what closes that window before the check below ever runs -- by the time
    // control reaches here, enough real wall-clock time has elapsed that the false positive has
    // already resolved itself. Finding B's preflight fix is thus load-bearing for finding A's
    // correctness, not just its own concern: moving the check below ahead of `runPreflightGate`
    // (or dropping the preflight entirely) would reopen a real spurious "still running" throw
    // against a run that has, in fact, already finished. Do not reorder these two steps without
    // re-measuring this.
    const existing = this.runs.get(runId)
    if (existing !== undefined) {
      if (existing.child.exitCode === null && existing.child.signalCode === null) {
        // Not terminated on the caller's behalf -- resume() adopting a kill it was never asked
        // to perform would paper over a caller bug with an implicit side effect, and this
        // adapter's whole design is that outcomes are explicit (cancel() exists for exactly
        // this). After a daemon restart `this.runs` is empty, so the normal cross-restart case
        // never reaches this branch at all -- that is the point.
        throw new Error(
          `ClaudeCodeAdapter: refusing to resume run ${runId} -- its previous process ` +
            `(pid ${String(existing.child.pid)}) is still running. resume() does not kill a live ` +
            'child on the caller\'s behalf; cancel() it first if that is what was intended.',
        )
      }
      // The previous process has already exited or been signalled -- close its queue before
      // `spawnChild` (below) overwrites this `runId`'s `RunState` with a new one. Without this, a
      // consumer already sitting in `for await` over the old queue would wait forever: `events()`
      // now hands out a different `AsyncEventQueue` object, so the old iteration can never be
      // woken by anything that happens to the new one.
      existing.queue.close()
    }

    // M5 live-gate finding 1: after the live-pid check above, never before it -- see the docstring
    // above `resume()` for why this ordering itself is the fix.
    await clearAndVerifyPauseFlagAbsent({
      flagPath: checkpoint.pauseFlagPath,
      runId,
      adapterName: 'ClaudeCodeAdapter',
      gateNoun: 'hook',
    })

    const resumedInput: StartRunInput = {
      runId,
      prompt: queuedInstruction ?? DEFAULT_RESUME_PROMPT,
      worktreePath: checkpoint.worktreePath,
      pauseFlagPath: checkpoint.pauseFlagPath,
      // Not a fresh `runFilePaths()` call -- the checkpoint's `settingsPath` already names the
      // run's own scratch directory (`start()` wrote it as `join(runDir, 'settings.json')`), and
      // this is that same directory recovered from it, purely to keep `resumedInput` a genuine
      // `StartRunInput` for `RunState.startInput`'s record-keeping. Nothing below reads it back:
      // the settings file itself was already (re)written above, at `checkpoint.settingsPath`
      // directly, and `args` below points `--settings` at that same path, not at anything derived
      // from `runDir` a second time.
      runDir: dirname(checkpoint.settingsPath),
      // Re-derived, not carried on `checkpoint`: `Checkpoint` (this package's own interface, not
      // the Prisma model) deliberately gains no field with no matching persisted column (see
      // `writePermissionsFile`'s docstring in `packages/control`). `permissions.json` always sits
      // beside `pause.flag` in the run's own scratch directory (`runFilePaths`'s `runDir`), for
      // every provider, so `dirname(checkpoint.pauseFlagPath)` recovers that directory exactly the
      // way `resumedInput.runDir` above recovers it from `settingsPath` for THIS provider only --
      // `pauseFlagPath` is the one field guaranteed to live in `runDir` on every adapter (Cursor's
      // own `settingsPath` is a hooks file in the WORKTREE, not `runDir`). `permissionsFilePathFor`
      // (this package's own `runtime/process.js`, M18 Task 5 fix round 1) is the ONE definition of
      // the filename itself -- called here rather than joined again, so this can never drift from
      // what `writePermissionsFile` wrote. The orchestrator rewrites the file at this same path
      // immediately before calling `resume()` (`apps/orchestrator/src/resume.ts`'s
      // `executeResume`), so the two never disagree.
      permissionsFilePath: permissionsFilePathFor(dirname(checkpoint.pauseFlagPath)),
      gitIdentity: { name: checkpoint.gitAuthorName, email: checkpoint.gitAuthorEmail },
      // Carried forward from the checkpoint, never re-resolved: the run must continue with the SAME
      // model it started with (M10 §6, the `Checkpoint.model` docstring), independently of whatever
      // an operator's `setAgentModel` has set since. `undefined` on a legacy checkpoint behaves
      // exactly as no override ever did.
      ...(checkpoint.model !== undefined ? { model: checkpoint.model } : {}),
    }

    const args = [
      ...this.extraArgs,
      ...claudeFlags({ settingsPath: checkpoint.settingsPath }),
      '-p',
      resumedInput.prompt,
      // Never `--fork-session`: that would mint a new session id on resume
      // (ADR 0001 §3, §5, findings 2.3). `--resume` alone reports the same
      // one `checkpoint.sessionId` already carries.
      '--resume',
      checkpoint.sessionId,
      ...(resumedInput.model !== undefined ? ['--model', resumedInput.model] : []),
    ]

    return this.spawnChild({
      runId,
      args,
      cwd: resumedInput.worktreePath,
      env: buildChildEnv({
        gitIdentity: resumedInput.gitIdentity,
        pauseFlagPath: resumedInput.pauseFlagPath,
        permissionsFilePath: resumedInput.permissionsFilePath,
      }),
      startInput: resumedInput,
      runFiles: { settingsPath: checkpoint.settingsPath, hookPath: checkpoint.hookPath },
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
