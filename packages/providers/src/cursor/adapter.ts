import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import type { RunId } from '@ai-team-os/domain'
import { capabilitiesOf } from '../capabilities.js'
import { AsyncEventQueue } from '../runtime/event-queue.js'
import { clearAndVerifyPauseFlagAbsent } from '../runtime/pause-flag.js'
import { buildChildEnv, permissionsFilePathFor, terminateChild } from '../runtime/process.js'
import { isRecord } from '../runtime/summary.js'
import type { RunOutcome, RuntimeEvent } from '../types.js'
import type { AgentRuntimeAdapter, ProviderCapabilities, RunHandle, StartRunInput } from '../claude/adapter.js'
import type { Checkpoint } from '../claude/checkpoint.js'
import { cursorFlags, cursorPreflightGate } from './flags.js'
import { cursorHooksPath, writeCursorHooksFile } from './hooks.js'
import { parseCursorLine } from './stream.js'

/**
 * The second `AgentRuntimeAdapter` (M12 Task 12, spec §7). It implements the SAME interface
 * `ClaudeCodeAdapter` does -- `id`, `getCapabilities`, `start`, `events`, `cancel`, `resume` --
 * declared in `claude/adapter.ts`, which owns those types for the milestone. Nothing about that
 * interface is Claude-specific; what differs between the two runtimes lives entirely below.
 *
 * WHERE THIS DIVERGES FROM `ClaudeCodeAdapter`, AND WHY (each measured, not assumed):
 *
 * - **Its run files are `.cursor/hooks.json` in the WORKTREE, not a settings file in `runDir`.**
 *   `cursor-agent` has no `--settings`-style flag; it reads hooks from the workspace (Task 11 §3
 *   Q1), so per-run gate isolation comes from the run having its own worktree. `RunHandle.runFiles`
 *   still reports the pair as `{settingsPath, hookPath}` -- those Postgres columns are frozen for
 *   this milestone and Cursor's two files fit the pair exactly (the hooks file, the gate script),
 *   so no interface field had to be generalized.
 *
 * - **The prompt is a POSITIONAL argument, not `-p <prompt>`.** `cursorFlags` returns flags only
 *   and the prompt is appended after them (Task 11 D1).
 *
 * - **`numTurns` is derived HERE.** Cursor's `result` line carries no turn count at all and
 *   `parseCursorLine` is per-line and stateless, so it reports `0` as a documented fidelity gap
 *   (Task 10 R3). This adapter counts `assistant` lines while consuming the stream -- the exact
 *   equivalent of "assistant messages" -- and overwrites the parser's zero before the `terminated`
 *   event leaves `events()`. The parser's `0` must never reach an operator as a figure Cursor
 *   reported.
 *
 * - **`deniedToolUseIds` is populated from the stream** rather than left `[]`; see
 *   `observeRawLine` below for the decision and its cost.
 *
 * - **A zero-line stream is diagnosed, not shrugged at.** See `zeroLineOutcome`.
 *
 * - **The hooks file registers exactly what `getCapabilities()` now claims.** `.cursor/hooks.json`
 *   arms the gate at `preToolUse` as well as `beforeShellExecution`, and `gate` reads `'all-tools'`
 *   because M13 Task 9 measured that `preToolUse` registration refusing both a shell command and a
 *   file write while paused, with the control run (flag absent) showing both succeeding; see
 *   `packages/providers/test/fixtures/cursor/gate/README.md` for the recorded runs, and
 *   `cursor/hooks.ts` for why the registration carries no `matcher`.
 *
 * - **There is no mid-run pause.** `ProviderCapabilities.canPauseMidRun` is `false` for this
 *   runtime: pausing a Cursor run is cancelling its process (`cancel()`) and later `resume()`-ing
 *   the session. The gate this adapter arms is defense-in-depth for the window between a pause
 *   request and the process actually dying (progress.md's 4->12 ruling), which is why this adapter
 *   synthesizes no `hook_denied`/`hook_crashed` events: `classifyGateEvent` never fires for a
 *   Cursor run, by design.
 */
export interface CursorAdapterOptions {
  /** The executable to spawn. Real usage: `'cursor-agent'`. Tests: a script that ignores argv. */
  readonly command: string
  /**
   * The `cursor-shell-gate.sh` this adapter registers in every hooks file it writes, and spawns
   * directly for the pre-flight check on every spawn. One adapter instance, one gate script --
   * a fact about this runtime, never something that varies run to run. Must be absolute; enforced
   * before anything is spawned.
   */
  readonly gatePath: string
  /**
   * Arguments placed before the mandatory `cursorFlags`. Real usage: empty. Tests use it to point
   * a generic interpreter at a fixture script.
   */
  readonly extraArgs?: readonly string[]
  /** Grace period between `SIGTERM` and the `SIGKILL` escalation in `cancel()`. Default 5000ms. */
  readonly killGraceMs?: number
}

const DEFAULT_KILL_GRACE_MS = 5_000

/**
 * Substituted for the resume prompt when no instruction is queued. `cursor-agent` in `--print`
 * mode still needs some prompt text -- the prompt is a positional and an empty one leaves the run
 * with nothing to do. Mirrors `ClaudeCodeAdapter`'s constant for the same reason.
 */
const DEFAULT_RESUME_PROMPT = 'Continue the paused run.'

/** How much of the child's stderr is kept for the terminal diagnosis. */
const STDERR_CAP = 4_000

/**
 * How long the stream stays open with no new bytes after `cursor-agent` has exited, before the
 * event queue is closed. See the long note in `spawnChild`: the process's exit is the only
 * trustworthy end-of-stream signal for this runtime, and this window is what makes reading the
 * bytes still in flight at that moment safe. Re-armed by every chunk, so it bounds silence rather
 * than the drain itself.
 */
const STREAM_QUIESCE_MS = 300

interface CursorRunState {
  readonly child: ChildProcess
  readonly queue: AsyncEventQueue<RuntimeEvent>
  /** `assistant` lines seen so far -- the derived `numTurns` (Task 10 R3). */
  assistantLines: number
  /** Every stdout line, parsed or not. Zero is the whole of the trust-refusal diagnosis. */
  stdoutLines: number
  /** `call_id`s whose `completed` line reported a rejected result. See `observeRawLine`. */
  readonly rejectedCallIds: string[]
  /** The head of the child's stderr, capped. Cursor puts the trust refusal here and nowhere else. */
  stderr: string
  /** Set once a `terminated` event has been pushed, so nothing synthesizes a second one. */
  terminated: boolean
  /** Set by `cancel()`, so a killed run is never blamed on workspace trust. */
  cancelled: boolean
}

export class CursorAdapter implements AgentRuntimeAdapter {
  readonly id = 'cursor' as const

  private readonly command: string
  private readonly gatePath: string
  private readonly extraArgs: readonly string[]
  private readonly killGraceMs: number
  private readonly runs = new Map<RunId, CursorRunState>()

  constructor(options: CursorAdapterOptions) {
    this.command = options.command
    this.gatePath = options.gatePath
    this.extraArgs = options.extraArgs ?? []
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  }

  /**
   * Delegated to `capabilitiesOf`, the one capability table (M12 Task 9), for the same reason
   * `ClaudeCodeAdapter` delegates: both budget-admission points read a kind's capabilities with no
   * adapter instance to read them from, and two tables that agree today disagree after the first
   * edit. Cursor's row was verified against the installed binary by this task; the evidence is in
   * the Task 12 report.
   */
  getCapabilities(): ProviderCapabilities {
    return capabilitiesOf('cursor')
  }

  /**
   * Arms the gate, writes the hooks file into the worktree, then spawns -- in that order, and the
   * order matters: `runPreflightGate` validates `this.gatePath` itself, so there is nothing to gain
   * by writing a hooks file that registers a script already known to be broken. A run whose gate
   * does not discriminate never gets a `RunHandle` or a registered state at all, so a later
   * `cancel()` against its `runId` fails loudly with "no run found" rather than silently
   * controlling a process that was never spawned.
   */
  async start(input: StartRunInput): Promise<RunHandle> {
    await this.runPreflightGate(this.gatePath, input.runId)
    const hooksPath = cursorHooksPath(input.worktreePath)
    writeCursorHooksFile({ hooksPath, gatePath: this.gatePath })

    const args = [
      ...this.extraArgs,
      ...cursorFlags({ model: input.model }),
      // Positional, last, and never handed to `--resume`: `--resume [chatId]` takes an OPTIONAL
      // argument, so a bare `--resume` would swallow this string as a chat id and leave the run
      // with no prompt at all (Task 11 R2). `cursorFlags` can never emit a bare `--resume`.
      input.prompt,
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
      runFiles: { settingsPath: hooksPath, hookPath: this.gatePath },
    })
  }

  /**
   * Continues a paused session with a new process (`--resume <sessionId>`), which is the whole of
   * Cursor's pause/resume story: with `canPauseMidRun: false` there is no live process to un-pause,
   * only a session id to pick back up.
   *
   * The step order mirrors `ClaudeCodeAdapter.resume` deliberately, including the two orderings
   * that task paid for in production incidents:
   *
   * 1. Re-arm the gate at `checkpoint.hookPath` -- a gate script that lost its exec bit or was
   *    pruned with a stale worktree between pause and resume must fail loudly here, at spawn time,
   *    not silently produce a resumed run with no gate.
   * 2. Rewrite the hooks file at `checkpoint.settingsPath`. A resume is a spawn, and the file the
   *    resumed process reads must be the file this adapter believes it wrote.
   * 3. Refuse to clobber a still-live process already registered under `runId`; close a dead one's
   *    queue so a consumer still iterating it is woken rather than stranded.
   * 4. ONLY THEN clear and verify the pause flag. Never before step 3: a resume refused for a live
   *    child must not un-gate the very process it just declined to adopt.
   *
   * Resuming a `runId` this adapter instance never `start()`-ed is the normal case, not an error --
   * that is what surviving a daemon restart means. `checkpoint` carries everything the spawn needs.
   */
  async resume(runId: RunId, checkpoint: Checkpoint, queuedInstruction: string | null): Promise<RunHandle> {
    await this.runPreflightGate(checkpoint.hookPath, runId)
    writeCursorHooksFile({ hooksPath: checkpoint.settingsPath, gatePath: checkpoint.hookPath })

    const existing = this.runs.get(runId)
    if (existing !== undefined) {
      if (existing.child.exitCode === null && existing.child.signalCode === null) {
        throw new Error(
          `CursorAdapter: refusing to resume run ${runId} -- its previous process ` +
            `(pid ${String(existing.child.pid)}) is still running. resume() does not kill a live ` +
            "child on the caller's behalf; cancel() it first if that is what was intended.",
        )
      }
      existing.queue.close()
    }

    await clearAndVerifyPauseFlagAbsent({
      flagPath: checkpoint.pauseFlagPath,
      runId,
      adapterName: 'CursorAdapter',
      gateNoun: 'gate',
    })

    const args = [
      ...this.extraArgs,
      ...cursorFlags({
        // Carried forward from the checkpoint, never re-resolved: the run continues with the SAME
        // model it started with (M10 §6), independently of any `setAgentModel` since.
        model: checkpoint.model,
        // Never `--continue`: that picks "the previous session" by the CLI's own reckoning rather
        // than by id, which is not the same thing when a worktree has hosted more than one run.
        resume: { sessionId: checkpoint.sessionId },
      }),
      queuedInstruction ?? DEFAULT_RESUME_PROMPT,
    ]

    return this.spawnChild({
      runId,
      args,
      cwd: checkpoint.worktreePath,
      env: buildChildEnv({
        gitIdentity: { name: checkpoint.gitAuthorName, email: checkpoint.gitAuthorEmail },
        pauseFlagPath: checkpoint.pauseFlagPath,
        // Re-derived, not carried on `checkpoint` -- see `ClaudeCodeAdapter.resume`'s identical
        // derivation and its docstring for why `Checkpoint` gains no field here. `pauseFlagPath` is
        // the one field guaranteed to live in the run's `runDir` on THIS provider too: Cursor's own
        // `checkpoint.settingsPath` is `.cursor/hooks.json` in the WORKTREE (this adapter's own
        // docstring, above), not `runDir`, so deriving from it the way the Claude adapter derives
        // `runDir` from `settingsPath` would recover the wrong directory here. `permissionsFilePathFor`
        // (M18 Task 5 fix round 1) is the ONE definition of the filename itself, shared with the
        // Claude adapter and `writePermissionsFile` -- never joined as a literal here.
        permissionsFilePath: permissionsFilePathFor(dirname(checkpoint.pauseFlagPath)),
      }),
      runFiles: { settingsPath: checkpoint.settingsPath, hookPath: checkpoint.hookPath },
    })
  }

  events(runId: RunId): AsyncIterable<RuntimeEvent> {
    return this.mustGetRun(runId).queue
  }

  async cancel(runId: RunId): Promise<void> {
    const state = this.mustGetRun(runId)
    // Recorded BEFORE the signal, so the terminal diagnosis below can tell an operator's cancel
    // apart from a runtime that died on its own having written nothing.
    state.cancelled = true
    await terminateChild(state.child, this.killGraceMs)
  }

  /**
   * The pre-flight gate, run on every spawn rather than once per run -- `resume()` carries
   * `hookPath` across a process boundary precisely so a gate that broke between pause and resume
   * fails here instead of silently. Wrapped so the failure names the run and this adapter: a bare
   * `cursorPreflightGate` message would not say which of two runtimes produced it.
   */
  private async runPreflightGate(gatePath: string, runId: RunId): Promise<void> {
    if (!isAbsolute(gatePath)) {
      throw new Error(`CursorAdapter: gatePath must be absolute, got ${JSON.stringify(gatePath)}`)
    }
    try {
      await cursorPreflightGate({ gatePath })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`CursorAdapter: pause-gate preflight failed for run ${runId}: ${message}`)
    }
  }

  private spawnChild(spec: {
    readonly runId: RunId
    readonly args: readonly string[]
    readonly cwd: string
    readonly env: NodeJS.ProcessEnv
    readonly runFiles: RunHandle['runFiles']
  }): Promise<RunHandle> {
    return new Promise<RunHandle>((resolve, reject) => {
      const child = spawn(this.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const queue = new AsyncEventQueue<RuntimeEvent>()
      const state: CursorRunState = {
        child,
        queue,
        assistantLines: 0,
        stdoutLines: 0,
        rejectedCallIds: [],
        stderr: '',
        terminated: false,
        cancelled: false,
      }
      let settled = false

      // Attached first, before the `pid` check: a bad command or a missing `cwd` is reported by
      // the OS on a later tick, and an 'error' event with no listener is an uncaught exception
      // that takes down the whole orchestrator for what is an ordinary per-run failure.
      child.once('error', (error: Error) => {
        if (!settled) {
          settled = true
          reject(new Error(`CursorAdapter: failed to spawn "${this.command}" for run ${spec.runId}: ${error.message}`))
          return
        }
        queue.close()
      })

      if (child.pid === undefined) {
        if (!settled) {
          settled = true
          reject(new Error(`CursorAdapter: failed to spawn "${this.command}" for run ${spec.runId}`))
        }
        return
      }
      if (child.stdout === null || child.stderr === null) {
        settled = true
        reject(new Error(`CursorAdapter: run ${spec.runId} has no stdio pipes`))
        return
      }

      this.runs.set(spec.runId, state)

      // stderr is CAPTURED here, not merely drained as `ClaudeCodeAdapter` drains it, and that is
      // the difference that makes the zero-line diagnosis possible at all: an untrusted workspace
      // puts its entire explanation on stderr and writes nothing to stdout, so a reader that
      // discards stderr has, quite literally, nothing to tell the operator. Capped, and still
      // consumed after the cap so the child never stalls on backpressure.
      child.stderr.on('data', (chunk: Buffer) => {
        if (state.stderr.length < STDERR_CAP) {
          state.stderr = (state.stderr + chunk.toString('utf8')).slice(0, STDERR_CAP)
        }
      })

      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line: string) => {
        state.stdoutLines += 1
        observeRawLine(state, line)
        const event = parseCursorLine(line)
        if (event.kind === 'terminated') {
          state.terminated = true
          queue.push({ kind: 'terminated', outcome: withDerivedFields(state, event.outcome) })
          return
        }
        queue.push(event)
      })

      // --- Ending the stream. MEASURED, and the measurement overturned the obvious design. -----
      //
      // `ClaudeCodeAdapter` ends its event stream when readline reports the child's stdout closed.
      // **That is unsafe for `cursor-agent`, and this task measured it hanging.** A real run
      // (Task 12 Step 4, run A) left behind a detached `worker-server` AND a
      // `typescript-language-server` / `tsserver` / `typingsInstaller` family that `cursor-agent`
      // had spawned for the workspace -- every one of them holding an inherited DUP OF THE
      // STDOUT WRITE END (`/proc/<pid>/fd/63 -> pipe:[…]`, verified directly). `cursor-agent`
      // itself exited; the pipe did not close, because a pipe closes when the LAST writer does.
      // So readline's `'close'` never fired, the child's own `'close'` (which also waits on stdio)
      // never fired, and `events()` never ended: a finished run whose pump waits forever. Killing
      // the fd holders by hand released it, which is what identified the cause.
      //
      // So the stream ends on the CHILD'S OWN `'exit'` instead -- the one signal that means
      // "cursor-agent is gone" regardless of what inherited its file descriptors -- followed by a
      // short quiescence window during which any bytes still sitting in the pipe are delivered as
      // ordinary lines. The window is re-armed by every chunk, so a big final burst is drained in
      // full rather than truncated by a fixed deadline; the writer is already dead by then, so
      // silence for `STREAM_QUIESCE_MS` means there is nothing left to read.
      //
      // `'close'` is still honoured, and for a well-behaved child (every test in this file's
      // suite, and any runtime that does not leak its stdout) it arrives first and finalizes
      // immediately, so the quiescence delay costs those runs nothing.
      let finalized = false
      let quiesceTimer: NodeJS.Timeout | undefined

      const finalize = (): void => {
        if (finalized) return
        finalized = true
        if (quiesceTimer !== undefined) clearTimeout(quiesceTimer)
        // Releases this process's ends of the pipes. Without it the fds stay open for as long as
        // the leaked grandchildren live, which for a language server is "indefinitely".
        child.stdout?.destroy()
        child.stderr?.destroy()
        if (!state.terminated && state.stdoutLines === 0 && !state.cancelled && child.signalCode === null) {
          queue.push({ kind: 'terminated', outcome: zeroLineOutcome(state, child.exitCode) })
          state.terminated = true
        }
        queue.close()
      }

      const armQuiesce = (): void => {
        if (finalized) return
        if (quiesceTimer !== undefined) clearTimeout(quiesceTimer)
        quiesceTimer = setTimeout(finalize, STREAM_QUIESCE_MS)
        // Never keeps the process alive on its own account: this timer exists to bound a wait,
        // not to give the orchestrator a reason to stay up.
        quiesceTimer.unref()
      }

      child.once('exit', armQuiesce)
      // Re-arms the window on every chunk, so quiescence means "nothing more is arriving", not
      // "some fixed time has passed since the process died".
      child.stdout.on('data', () => {
        if (quiesceTimer !== undefined) armQuiesce()
      })
      child.once('close', finalize)

      settled = true
      resolve({ runId: spec.runId, pid: child.pid, runFiles: spec.runFiles })
    })
  }

  private mustGetRun(runId: RunId): CursorRunState {
    const state = this.runs.get(runId)
    if (state === undefined) {
      throw new Error(`CursorAdapter: no run found for ${runId}`)
    }
    return state
  }
}

/**
 * The two figures this adapter fills in that `parseCursorLine` cannot, applied to the outcome on
 * its way out of `events()`.
 */
function withDerivedFields(state: CursorRunState, outcome: RunOutcome): RunOutcome {
  return { ...outcome, numTurns: state.assistantLines, deniedToolUseIds: [...state.rejectedCallIds] }
}

/**
 * Reads the two cross-line facts off a raw stdout line, before the parser normalizes it away.
 *
 * **`assistant` lines are counted**, not `text` events, and the distinction is not pedantry: the
 * parser folds a multi-block assistant message into `unparsable` and a zero-block one into
 * `ignored`, so counting events would undercount exactly the messages that are hardest to see.
 * Counting lines is the exact equivalent of "assistant messages" (Task 10 §5(d)).
 *
 * **`deniedToolUseIds` IS populated, from `tool_call`/`completed` lines whose result is
 * `rejected`** -- Task 11 §8(c) reopened this as a deliberate decision rather than a consequence,
 * and this is the decision. The reasoning, and its cost:
 *
 * - The information genuinely exists (Task 11 §3 Q5 measured the shape), and `[]` in the presence
 *   of real denials is the same class of untruth as reporting an unmeasured cost as `0`. The field
 *   means "what the agent was about to do and was stopped from doing"; a rejected call is exactly
 *   that.
 * - `pump.ts` treats a non-empty `deniedToolUseIds` as a FAILED run even when `is_error` is false,
 *   and names the ids in the operator's `run.failed` reason. That is the consequence of this
 *   choice and it is the intended one: a Cursor run that reached its terminal line having had its
 *   own pause gate block calls did not do its job, and reporting it as a clean success is the lie
 *   the guardrail exists to prevent.
 * - **Only `result.rejected` is read, never `result.error`.** A `failClosed` block surfaces on
 *   `result.error.modelVisibleError` (Task 11 §3 Q6) -- but so, as far as anyone has measured,
 *   does an ordinary tool error, and nothing measured distinguishes them. Counting ordinary tool
 *   errors as denials would fail healthy runs and corrupt the very list an operator reads to learn
 *   what was blocked. The cost is stated plainly: a run stopped by a fail-closed gate failure is
 *   NOT counted here. It is not lost -- the reason still reaches the operator through the
 *   `result` line's own text -- but it is not in this list.
 *
 * Never throws: a line this cannot understand simply contributes nothing, and `parseCursorLine`
 * remains the one place a malformed line is classified.
 */
function observeRawLine(state: CursorRunState, line: string): void {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return
  }
  if (!isRecord(raw)) return

  if (raw['type'] === 'assistant') {
    state.assistantLines += 1
    return
  }

  if (raw['type'] !== 'tool_call' || raw['subtype'] !== 'completed') return
  const callId = raw['call_id']
  if (typeof callId !== 'string') return
  const toolCall = raw['tool_call']
  if (!isRecord(toolCall)) return
  // The tool's name is the KEY of the `tool_call` object, not a field (Task 10's first trap), so
  // the rejection is found by looking under every key rather than under a known one.
  for (const value of Object.values(toolCall)) {
    if (!isRecord(value)) continue
    const result = value['result']
    if (isRecord(result) && isRecord(result['rejected'])) {
      state.rejectedCallIds.push(callId)
      return
    }
  }
}

/**
 * The terminal outcome for a run that exited having written NOTHING to stdout.
 *
 * Task 10 measured what this is: `cursor-agent` in a directory the operator has not trusted exits
 * 1 with a completely empty stdout -- no `system`/`init` line, no `result` line -- and prints
 * "Workspace Trust Required" to stderr only. Every worktree this system creates is exactly such a
 * directory. A pump that reads stdout alone sees silence and reports a runtime that died for
 * unknown reasons, which turns a one-flag problem into an hour of an operator's time.
 *
 * So this names the known cause and hands over the stderr that settles it, rather than asserting
 * a diagnosis it cannot prove: the captured text is the binary's own, and if the cause is
 * something else entirely the operator is reading that instead of a guess.
 *
 * Deliberately NOT synthesized when the run was cancelled or died on a signal: a killed process
 * has written nothing for an entirely ordinary reason, and blaming workspace trust for an
 * operator's own cancel would be a fabricated diagnosis. Those runs end with no terminal event at
 * all, which is the case `pump.ts` already handles.
 */
function zeroLineOutcome(state: CursorRunState, exitCode: number | null): RunOutcome {
  const stderr = state.stderr.trim()
  return {
    isError: true,
    terminalReason:
      `cursor-agent exited ${exitCode === null ? 'without an exit code' : String(exitCode)} having written ` +
      'nothing at all to stdout -- no session line, no result line. The measured cause of an empty ' +
      'Cursor stream is the workspace-trust refusal: an untrusted directory makes cursor-agent exit ' +
      '1 in silence and print "Workspace Trust Required" to stderr only. This adapter always passes ' +
      '--trust, so if that is the message below, the flag did not reach the process. ' +
      `Captured stderr: ${stderr === '' ? '(the process wrote nothing to stderr either)' : stderr}`,
    stopReason: null,
    numTurns: state.assistantLines,
    // Unknown is not zero (spec Decision 6): zero is a figure the budget guardrail believes.
    costUsd: null,
    deniedToolUseIds: [...state.rejectedCallIds],
    // Cursor reports no usage of any kind (M14 Decision 4), and this run wrote no result line at
    // all.
    tokens: null,
  }
}
