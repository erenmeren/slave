import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import type { RunId } from '@slave-of-ai/domain'
import { capabilitiesOf } from '../capabilities.js'
import { listClaudeCodeModels, type ModelListing } from '../models.js'
import { AsyncEventQueue } from '../runtime/event-queue.js'
import { preflightTap } from '../runtime/gate-preflight.js'
import { clearAndVerifyPauseFlagAbsent } from '../runtime/pause-flag.js'
import { buildChildEnv, permissionsFilePathFor, terminateChild, toolResultsPathFor } from '../runtime/process.js'
import { isRecord } from '../runtime/summary.js'
import { TOOL_ERROR_CLASSES, type ToolErrorClass } from '../tool-result.js'
import type { RunOutcome, RuntimeEvent } from '../types.js'
import type { Checkpoint } from './checkpoint.js'
import { claudeFlags, preflightGate } from './flags.js'
import { writeSettingsFile } from './settings.js'
import { parseStreamLine, parseStreamResults, parseStreamUsage } from './stream.js'

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
  /**
   * Consumed by M51's behavioural breaker: does this runtime say what came BACK from a tool call?
   *
   * A detector that cannot tell a finished call from a running one has no way to say a quiet
   * twenty-minute build is not a loop, so a runtime answering `false` here would have to be read
   * with the error-storm arm suppressed entirely. Both rows answer `true` today, each by its own
   * proof (`capabilities.ts`) -- this exists so a third runtime that cannot is refused an arm
   * rather than silently mis-judged by it.
   */
  readonly reportsToolResults: boolean
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
export interface SlaveRuntimeAdapter {
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
export interface SlaveRuntimeAdapter {
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
  /**
   * M51 R6: the `PostToolUse` tap script this adapter registers, and pre-flights on `start()`.
   *
   * `hookPath`'s exact shape and for its reason: a fact about this RUNTIME (the orchestrator's own
   * `scripts/tool-result-tap.sh`), never something that varies run to run. OPTIONAL, unlike
   * `hookPath`: a deployment that has not installed the tap runs perfectly well without it -- the
   * stream carries the same facts and the tap only fills a gap -- and making it required would turn
   * an optional measurement into a spawn failure.
   */
  readonly tapPath?: string
}

interface RunState {
  readonly child: ChildProcess
  readonly queue: AsyncEventQueue<RuntimeEvent>
  /**
   * The parsed JSON body of the run's terminal `result` line, kept
   * verbatim -- before `parseStreamLine` normalizes it into `RunOutcome`
   * and drops any field that type does not carry. Test/debug seam only
   * (see `rawTerminalPayload`); it is not part of `SlaveRuntimeAdapter`.
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
  /**
   * M51 R6: `toolUseId`s a `tool_result` has already been pushed for, whichever producer got
   * there first.
   *
   * TWO producers feed one queue -- the stream parser and the PostToolUse tap's tailer -- and
   * `pump.ts` must see exactly one result per call. **The stream wins**, not by priority but by
   * arrival: whichever writes the id first owns it, and in practice that is the stream, because
   * the tap's line has to reach the filesystem and be tailed back. The tap is therefore a GAP
   * FILLER, which is what keeps this spike from changing any behaviour that already works.
   *
   * Bounded by the run's own tool-call count, like `hookBindings` in the pump, and dropped with
   * the run.
   */
  readonly seenToolResults: Set<string>
  /**
   * Stops the tap's tailer after one last drain, or `undefined` for an untapped run. Torn down
   * with the run, in the same place the child's listeners are.
   *
   * Assigned rather than constructed with the rest of the state (fix round 1, review Important 3):
   * the tailer is started only once the run is actually REGISTERED, so every path that abandons the
   * spawn -- a bad command, no pid, no stdout pipe -- leaves nothing polling by construction rather
   * than by remembering to tear it down at three call sites.
   */
  stopTap: (() => Promise<void>) | undefined
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

export class ClaudeCodeAdapter implements SlaveRuntimeAdapter {
  readonly id = 'claude-code' as const

  private readonly command: string
  private readonly extraArgs: readonly string[]
  private readonly killGraceMs: number
  private readonly hookPath: string
  private readonly tapPath: string | undefined
  /** Whether {@link ClaudeCodeAdapter.runPreflightTap}'s downgrade has already been announced. */
  private tapWarned = false
  private readonly runs = new Map<RunId, RunState>()

  constructor(options: ClaudeCodeAdapterOptions) {
    this.command = options.command
    this.extraArgs = options.extraArgs ?? []
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    this.hookPath = options.hookPath
    this.tapPath = options.tapPath
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
    const tapPath = await this.runPreflightTap(input.runId)
    const settingsPath = join(input.runDir, 'settings.json')
    writeSettingsFile({ settingsPath, hookPath: this.hookPath, ...tapSettings(tapPath) })
    return this.spawnRun(input, settingsPath, tapPath)
  }

  /**
   * The tap's pre-flight (M51 R6, plan erratum E11), beside `runPreflightGate` and on every spawn
   * for its reason -- a tap that lost its exec bit between pause and resume records nothing, and
   * silently.
   *
   * **Returns the tap path this spawn should actually use, and a failure DOWNGRADES the spawn to no
   * tap rather than failing it** (M51 Task 4 fix round 1, Important 4). This is the opposite of
   * `runPreflightGate` below, deliberately: a slave running with no gate cannot be stopped, so a
   * broken gate must stop the spawn -- while the tap fills a gap only in a DEGRADED Claude stream
   * (`reportsToolResults` is true on the stream alone, and the R6 spike measured the tap filling no
   * gap at all on a healthy one). A present-but-broken script -- the likely shape after an edit, a
   * shell change or a partial deploy -- would otherwise stop a whole fleet over a mechanism nothing
   * downstream depends on.
   *
   * Warned ONCE per adapter rather than once per spawn: a broken tap is a standing condition, and a
   * line printed on every run of every workspace buries whatever the operator was reading. Same
   * reasoning as the tailer's own `warned` flag.
   */
  private async runPreflightTap(runId: RunId): Promise<string | undefined> {
    const tapPath = this.tapPath
    if (tapPath === undefined) return undefined
    try {
      await preflightTap({ tapPath })
      return tapPath
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!this.tapWarned) {
        this.tapWarned = true
        console.warn(
          `ClaudeCodeAdapter: tool-result tap preflight failed for run ${runId}: ${message} -- ` +
            'continuing WITHOUT the tap; tool results will come from the stream alone',
        )
      }
      return undefined
    }
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

  private spawnRun(input: StartRunInput, settingsPath: string, tapPath: string | undefined): Promise<RunHandle> {
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
        // Only when THIS SPAWN actually registered a tap: the variable is the channel, and an armed
        // channel with no hook writing to it is a tailer watching a file nothing creates. The path
        // is the pre-flight's answer, not the adapter's field, so a spawn that was downgraded to no
        // tap (fix round 1, Important 4) arms nothing.
        ...(tapPath === undefined ? {} : { toolResultsPath: toolResultsPathFor(input.runDir) }),
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
      const seenToolResults = new Set<string>()
      // The tap's own file lives in the run's scratch directory, which is exactly what the child
      // was told (`SLAVEOFAI_TOOL_RESULTS`, set by `buildChildEnv` from the same helper) -- read
      // back off the env rather than re-derived, so the writer and the tailer cannot disagree
      // about which file this run is tapped into.
      const resultsPath = spec.env['SLAVEOFAI_TOOL_RESULTS']
      const state: RunState = {
        child,
        queue,
        rawResultPayload: undefined,
        startInput: spec.startInput,
        seenToolResults,
        // Started below, after `this.runs.set` -- see the field's own docstring.
        stopTap: undefined,
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
        // stream simply ending is -- close the queue, do not crash. The tailer goes with it (fix
        // round 1, review Important 3): `timer.unref()` keeps a stray interval from holding the
        // process open, not from polling a worktree that may already be gone, once per errored run,
        // for the life of the daemon.
        void state.stopTap?.()
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

      // The tailer starts HERE and not with the state above: every rejection path between the two
      // returns without a run, and none of them now has an interval to forget.
      if (resultsPath !== undefined && resultsPath !== '') {
        state.stopTap = startTapTailer({ resultsPath, queue, seen: seenToolResults })
      }

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
        //
        // M51 R6: the stream is one of TWO producers of `tool_result`, and it wins by arrival --
        // check-and-add before pushing, exactly as the tailer does, so the pump sees one result per
        // call whichever got there first.
        if (event.kind === 'tool_result') {
          // Fix round 1 (review Important 4): a `user` line can carry SEVERAL `tool_result` blocks
          // -- Claude batches the results of parallel tool calls onto one line -- and
          // `parseStreamLine` returns only the first, because one line is one event. The array is
          // pushed INSTEAD of `event`, never as well as it: `parseStreamResults(line)[0]` IS
          // `event` for any line that produced one, so this is the one arrangement of the two calls
          // that cannot double-push the first block.
          //
          // A `user` line whose FIRST block is unreadable still reports `unparsable` through
          // `parseStreamLine` and reaches the `else` below, taking its readable siblings with it.
          // That is the parser's existing posture for a line it could not understand, and it is
          // strictly better than before, when the whole line was dropped either way.
          for (const result of parseStreamResults(line)) {
            if (seenToolResults.has(result.toolUseId)) continue
            seenToolResults.add(result.toolUseId)
            queue.push(result)
          }
        } else {
          queue.push(event)
        }
        // M51 R5 / plan erratum E4: the SECOND pure function over the same line, called here rather
        // than folded into `parseStreamLine` -- a turn's `usage` rides the same `assistant` line as
        // its `tool_use` block, and that parser returns exactly one event per line. Pushed AFTER
        // the line's own event: the meter reports on the turn that just happened.
        const usage = parseStreamUsage(line)
        if (usage !== null) queue.push({ kind: 'usage', input: usage.input, output: usage.output })
      })
      lines.once('close', () => {
        // One last drain before the queue closes: the tap's final line may still be in flight
        // between the hook's `>>` and the tailer's next poll, and closing the queue on top of it
        // would drop the result of the run's last tool call.
        const stop = state.stopTap
        if (stop === undefined) {
          queue.close()
          return
        }
        void stop().finally(() => queue.close())
      })

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
   * See the `SlaveRuntimeAdapter.resume` docstring for the contract. This implementation, in
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
    const tapPath = await this.runPreflightTap(runId)
    writeSettingsFile({
      settingsPath: checkpoint.settingsPath,
      hookPath: checkpoint.hookPath,
      ...tapSettings(tapPath),
    })

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
      // Its tailer with it: a poll timer left running against a finished run's file is a handle
      // this map no longer holds, writing into a queue nobody can reach.
      void existing.stopTap?.()
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
      // an operator's `setSlaveModel` has set since. `undefined` on a legacy checkpoint behaves
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
        // The resumed run's scratch directory is the ORIGINAL one (`resumedInput.runDir`, recovered
        // from `checkpoint.settingsPath`), so a resumed run appends to the same file its first half
        // wrote. What makes that safe is `startTapTailer`'s own rule -- it starts at the file's
        // CURRENT SIZE, never at zero (see its docstring) -- and NOT the dedupe set, which is fresh
        // for every spawn (`spawnChild` mints a new `Set` per `RunState`). The pre-pause lines were
        // already delivered to the previous pump by the run segment that wrote them; replaying them
        // into a set that has never seen them would write a second `run.tool_result` row for every
        // call the run made before it paused.
        ...(tapPath === undefined ? {} : { toolResultsPath: toolResultsPathFor(resumedInput.runDir) }),
      }),
      startInput: resumedInput,
      runFiles: { settingsPath: checkpoint.settingsPath, hookPath: checkpoint.hookPath },
    })
  }

  /**
   * Test/debug seam, not part of `SlaveRuntimeAdapter`: the parsed JSON
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

/**
 * How often the tap's file is re-read while a run is live (M51 R6).
 *
 * Short enough that a result is not held back behind a poll a person would notice, long enough that
 * a run making a tool call a second costs one `stat` per poll and nothing else. It is also the
 * whole reason **the stream wins**: a stream line is read the instant the child writes it, while a
 * tap line has to reach the filesystem and then wait for the next tick of this timer.
 */
const TAP_POLL_MS = 25

/**
 * Tails the tap's NDJSON file into the run's own queue, as a SECOND producer of `tool_result`
 * (M51 R6) that `pump.ts` cannot tell from the first.
 *
 * Starts at the file's CURRENT size, never at zero. A resumed run appends to the same
 * `tool-results.ndjson` its first half wrote (the scratch directory is the original one), and those
 * lines were already reported by the previous pump's stream -- re-reading them would write a second
 * `run.tool_result` row for every call the run made before it paused. Tailing means tailing.
 *
 * Every failure is silent and non-fatal, which is the tap's whole posture: a missing file is a run
 * whose hook has not fired yet, an unreadable one is a gap the stream already fills, and neither is
 * worth a word in a run's event log.
 */
/** `{ tapPath }` or `{}` -- spread, so `exactOptionalPropertyTypes` sees an absent key, not one
 *  present and undefined, which is the same distinction the settings file itself makes. Takes the
 *  path THIS SPAWN resolved rather than reading the adapter's field, so a downgraded spawn writes a
 *  settings file with no `PostToolUse` registration in it at all. */
function tapSettings(tapPath: string | undefined): { readonly tapPath?: string } {
  return tapPath === undefined ? {} : { tapPath }
}

function startTapTailer(spec: {
  readonly resultsPath: string
  readonly queue: AsyncEventQueue<RuntimeEvent>
  readonly seen: Set<string>
}): () => Promise<void> {
  let offset = currentSizeOf(spec.resultsPath)
  // A multi-byte character can straddle a read boundary, and so can a line: the decoder holds the
  // half-character, `carry` holds the half-line.
  const decoder = new StringDecoder('utf8')
  let carry = ''
  let draining = false

  // One line on stderr per run, not per poll: a broken tap is a standing condition, and a 25 ms
  // timer would turn it into a flood that buries whatever the operator was actually reading.
  let warned = false

  const drain = async (): Promise<void> => {
    // Re-entrancy guard, not a lock: two overlapping drains would both read from the same `offset`
    // and push every line twice -- which the dedupe set would then swallow, hiding the bug.
    if (draining) return
    draining = true
    try {
      let handle
      try {
        handle = await open(spec.resultsPath, 'r')
      } catch {
        return
      }
      try {
        const stat = await handle.stat()
        if (stat.size <= offset) return
        const length = stat.size - offset
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        offset += bytesRead
        carry += decoder.write(buffer.subarray(0, bytesRead))
      } finally {
        await handle.close()
      }
      const parts = carry.split('\n')
      // The last part is whatever came after the final newline -- an unfinished line, or the empty
      // string. Held back rather than parsed: one `printf` of a bounded line to a file opened
      // `O_APPEND` is atomic, but a READ can still land mid-line.
      carry = parts.pop() ?? ''
      for (const line of parts) {
        const event = parseTapLine(line)
        if (event === null) continue
        if (spec.seen.has(event.toolUseId)) continue
        spec.seen.add(event.toolUseId)
        spec.queue.push(event)
      }
    } catch (error) {
      // A TAP MUST NEVER INTERFERE, and an unhandled rejection is the loudest interference there is
      // (fix round 1, review Important 2). `open` is guarded above; `stat`, `read` and `close` were
      // not, and `setInterval(() => { void drain() })` attaches no handler -- so on Node >= 15 one
      // transient read error in a gap-filling tap took the whole orchestrator down, which is the
      // opposite of everything else in this file. Swallowed here, said once, and the poll continues:
      // the stream carries the same facts, so a tap that cannot read is a gap and not a failure.
      if (!warned) {
        warned = true
        console.warn(
          `ClaudeCodeAdapter: tool-result tap at ${spec.resultsPath} could not be read ` +
            `(${error instanceof Error ? error.message : String(error)}). The run continues on the ` +
            'stream alone; this is reported once per run.',
        )
      }
    } finally {
      draining = false
    }
  }

  const timer = setInterval(() => {
    void drain()
  }, TAP_POLL_MS)
  // The tailer must never be the reason this process stays alive: it watches a file, and a file
  // has nothing to say once the run that was writing it is over.
  timer.unref()

  return async () => {
    clearInterval(timer)
    // `drain` swallows its own failures (above), so this can only reject if that guarantee is
    // broken -- and the caller (`lines.close`) closes the queue in a `.finally`, which would drop
    // the close on the floor if it did.
    await drain()
  }
}

function currentSizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * One line of `tool-results.ndjson` as a `tool_result` event, or `null` for anything this reader
 * cannot make four good fields out of.
 *
 * Hand-rolled rather than a zod schema, and deliberately: this file is written by a shell script
 * this repo owns and pre-flights (`preflightTap`), so the shape is not untrusted input so much as
 * a contract already checked before the run started -- and a parser that DROPS a bad line is the
 * only behaviour a tap may have, where a schema's job is usually to say loudly that something is
 * wrong.
 *
 * An `errorClass` this version has never heard of reads as `other` rather than as a refusal: the
 * closed union types the producers (plan erratum E17), and a class from a newer tap arriving in an
 * older adapter is still evidence that the call failed.
 */
function parseTapLine(line: string): Extract<RuntimeEvent, { kind: 'tool_result' }> | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  const { toolUseId, toolName, outcome, errorClass } = raw
  if (typeof toolUseId !== 'string' || toolUseId === '') return null
  if (typeof toolName !== 'string') return null
  if (outcome !== 'ok' && outcome !== 'error') return null
  if (outcome === 'ok') return { kind: 'tool_result', toolUseId, toolName, outcome, errorClass: null }
  const known = TOOL_ERROR_CLASSES.find((candidate): candidate is ToolErrorClass => candidate === errorClass)
  return { kind: 'tool_result', toolUseId, toolName, outcome, errorClass: known ?? 'other' }
}
