import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { killWithEscalation } from '@ai-team-os/control'
import { prisma } from '@ai-team-os/db/client'
import type { AgentId, RunId, TaskId, WorkspaceId } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import { classifyGateEvent, type ProviderKind, type RunOutcome, type RuntimeEvent } from '@ai-team-os/providers'

/**
 * The cap on a single `run.output` payload (spec §9: the agent's text output "with a truncation
 * cap"). It protects an append-only log first and, from M4, a screen -- one runaway paste from a
 * model that decided to echo a file back is otherwise a row nobody can read and nobody can delete.
 */
const execFileAsync = promisify(execFile)

export const OUTPUT_CAP = 4_000

export interface PumpRunInput {
  readonly runId: RunId
  /** `null` for a task-less `planning` run (M8b) -- it has no `attempt` counter to increment. */
  readonly taskId: TaskId | null
  readonly agentId: AgentId
  readonly workspaceId: WorkspaceId
  readonly events: AsyncIterable<RuntimeEvent>
  /**
   * The caller's binding of the adapter's `cancel(runId)`. Required, not optional: the pump reacts
   * to a gate failure by stopping the run, and a pump that can be constructed without the ability
   * to stop one is a pump that can silently leave an ungated agent running.
   */
  readonly cancel: () => Promise<void>
  /**
   * The spawn-critical facts a resumed run cannot rediscover, written into the `Checkpoint` row
   * when this run pauses.
   *
   * Nothing else can supply them. The adapter's `Checkpoint` interface exists precisely because a
   * *fresh process* -- one that never called this run's `start()` -- has no other source for the
   * settings file, the hook path or the git identity: identity is supplied per-process by design,
   * so it cannot be recovered from shared repo state. The tick knows them at spawn; this is the
   * component that knows *when* the pause happened. Optional so a caller that never pauses (a test
   * with a fixed event array) need not invent them.
   */
  /**
   * True when this pump is continuing a run rather than starting one.
   *
   * The stream cannot tell the difference -- a resumed process emits `system/init` exactly as a
   * fresh one does -- so a resumed run produced a *second* `run.started`, which is an illegal
   * transition from `working` for anything replaying through `applyRunEvent`. The caller knows,
   * and it is the caller that emits `run.resumed`.
   */
  readonly resumed?: boolean
  readonly spawn?: {
    readonly settingsPath: string
    readonly pauseFlagPath: string
    readonly hookPath: string
    readonly gitIdentity: { readonly name: string; readonly email: string }
    /**
     * The model this run was actually spawned with (M10 §6), resolved once at spawn time by
     * `resolveRuntime` -- recorded into the checkpoint verbatim so `resume()` replays the SAME model
     * rather than re-resolving the chain, which could have moved since (a `setAgentModel` call
     * between pause and resume affects only the run's NEXT dispatch, never this one).
     */
    readonly model?: string
    /**
     * The provider this run was actually spawned with (M12 Task 6/8), beside `model` for the same
     * reason -- recorded into the checkpoint verbatim so a resumed run continues with the pair it
     * started with (spec §4), never re-resolved. Optional for the same reason `model` is: a test
     * fixture that never pauses need not invent one, and `writeCheckpoint`'s own early return
     * already refuses to record half a checkpoint when `spawn` is absent at all.
     */
    readonly provider?: ProviderKind
  }
}

/**
 * `actor` says who the event is *about*, not who wrote the row -- every row here is written by the
 * orchestrator. `agent` is the agent's own activity as observed on the stream; `system` is the
 * orchestrator's judgement about it. A reader filtering for what the agent did wants the first
 * without the second.
 */
type Actor = 'agent' | 'system'

/** The name `pause` wrote into the flag file, if it is still there. Provenance, never required. */
function readPauseRequester(pauseFlagPath: string | undefined): string | null {
  if (pauseFlagPath === undefined) return null
  try {
    const who = readFileSync(pauseFlagPath, 'utf8').trim()
    return who === '' ? null : who
  } catch {
    return null
  }
}

/**
 * Persists everything a *fresh process* needs to continue this run.
 *
 * Written when the pause is recorded, because that is the only moment all of it is known at once:
 * the session id and the last tool call come from the stream, the spawn-critical paths come from
 * whoever started the run, and the working tree state has to be read while it still reflects the
 * pause. Without this row `resume` has nothing to resume from -- the adapter's `resume()` takes a
 * checkpoint precisely because a process that never called `start()` cannot rediscover any of it.
 */
async function writeCheckpoint(input: {
  readonly runId: RunId
  readonly sessionId: string | null
  readonly toolCalls: number
  readonly lastToolUseId: string | null
  readonly lastToolName: string | null
  readonly denied: readonly string[]
  readonly spawn: PumpRunInput['spawn']
  readonly pauseReason: string
  readonly requestedBy: string | null
}): Promise<void> {
  if (input.spawn === undefined || input.sessionId === null) {
    // No session id means the run never reached `system/init`, so there is nothing to `--resume`.
    // No spawn facts means the caller cannot support a resume anyway; recording half a checkpoint
    // would be worse than none, because `resume()` would then fail at the spawn rather than here.
    console.warn(`[pump] not writing a checkpoint for ${input.runId}: nothing could resume it`)
    return
  }

  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: input.runId } })
  const worktreePath = run.worktreePath ?? ''
  const headCommit = worktreePath === '' ? '' : await gitOutput(worktreePath, ['rev-parse', 'HEAD'])
  const dirtyFiles =
    worktreePath === ''
      ? []
      : (await gitOutput(worktreePath, ['status', '--porcelain'])).split('\n').filter((line) => line !== '')

  await prisma.checkpoint.upsert({
    where: { runId: input.runId },
    // Upsert, not create: a run can be paused, resumed and paused again, and the second pause is
    // the one an operator would be looking at.
    create: {
      runId: input.runId,
      sessionId: input.sessionId,
      worktreePath,
      pauseFlagPath: input.spawn.pauseFlagPath,
      settingsPath: input.spawn.settingsPath,
      hookPath: input.spawn.hookPath,
      gitAuthorName: input.spawn.gitIdentity.name,
      gitAuthorEmail: input.spawn.gitIdentity.email,
      model: input.spawn.model ?? null,
      // M12 Task 8: written only in `create`, mirroring `model` immediately above -- a checkpoint
      // written on a SECOND pause of an already-resumed run is fed the same `spawn.provider` it
      // was started (or resumed) with, so leaving `update` untouched records the identical value
      // rather than a redundant rewrite of it.
      provider: input.spawn.provider ?? null,
      lastToolUseId: input.lastToolUseId,
      lastToolName: input.lastToolName,
      numTurns: input.toolCalls,
      deniedToolUseIds: [...input.denied],
      headCommit,
      dirtyFiles,
      // AgentRun.costUsd (M12 Task 6) is written only once, at the run's terminal conclusion --
      // mid-run, before that write happens, it is null, not the run's true accrued cost. A
      // checkpoint is written mid-run (on pause), so this is always the null case in practice; `??
      // 0` here targets Checkpoint.cumulativeCostUsd specifically, a column this task's migration
      // does not touch and which stays NOT NULL @default(0) -- unlike AgentRun.costUsd, it was
      // never meant to distinguish "zero" from "not yet known".
      // SETTLED (M12 Task 9, ruling R4): `Checkpoint.cumulativeCostUsd` STAYS NOT NULL, and no
      // migration touches it. The question routed here from Task 6 was whether it needed to
      // distinguish unknown from zero the way `AgentRun.costUsd` now does, and the answer is that
      // nothing reads it for a money decision: its only reader is `resume.ts`, which carries it
      // into the resumed run's checkpoint shape -- no sum, no comparison, no guardrail. It is
      // checkpoint bookkeeping, not spend the budget believes, so `?? 0` here is not the lie
      // Decision 6 is about. The cost if this is wrong is that a paused unmeasured run's
      // bookkeeping figure reads 0 instead of unknown, and no decision anywhere consumes it.
      cumulativeCostUsd: run.costUsd ?? 0,
      pauseReason: input.pauseReason,
      requestedBy: input.requestedBy,
    },
    update: {
      // `sessionId` is deliberately absent: it is written once at run start and never rewritten
      // (ADR 0001 §5, and the adapter's own `Checkpoint` docstring). A plain `--resume` reports the
      // same UUID, so rewriting it adds a failure mode for no benefit.
      lastToolUseId: input.lastToolUseId,
      lastToolName: input.lastToolName,
      numTurns: input.toolCalls,
      deniedToolUseIds: [...input.denied],
      headCommit,
      dirtyFiles,
      // Settled with the `create` branch above (M12 Task 9, ruling R4): NOT NULL stays, because
      // nothing consumes this figure for a money decision.
      cumulativeCostUsd: run.costUsd ?? 0,
      pauseReason: input.pauseReason,
      requestedBy: input.requestedBy,
    },
  })
}

/**
 * The `Checkpoint.pauseReason` recorded when a Cursor run is paused. Not a gate's deny message --
 * there is no deny to quote, because there was no gate decision: the process was ended.
 */
const CURSOR_PAUSE_REASON =
  'paused by cancelling the process (cursor has no mid-run gate; canPauseMidRun: false)'

/**
 * Records the pause of a Cursor run whose stream has just ended, and reports whether it did.
 *
 * **Why this branch exists at all.** Claude pauses through its gate: the hook denies a tool call,
 * the pump sees `hook_denied` -> `stopped_by_gate` mid-stream, and the `paused` row and checkpoint
 * are written there, long before the stream ends. Cursor has no such mechanism
 * (`canPauseMidRun: false`) -- `signalPause('cursor', …)` ENDS THE PROCESS, so the only thing the
 * pump ever observes is the stream stopping. Without this, that ending fell through to the
 * "died without reporting" path: the operator's deliberate pause was recorded as `failed`, no
 * checkpoint was written, `run.paused` never fired, and nothing could resume it. The run was
 * killed exactly as asked and the system reported it as a crash.
 *
 * **Why it is scoped to `provider === 'cursor'`, and not to `pause_requested` alone.** For Claude,
 * a stream that ends with no terminal event genuinely IS a dead run -- its pause would have fired
 * mid-stream if it were a pause -- so treating a `pause_requested` Claude run's silent ending as a
 * successful pause would reclassify every Claude crash that happened to race an operator's pause
 * request. Series A freezes Claude's behaviour and this keeps that promise by construction:
 * `claude_code` cannot enter this function's body at all.
 *
 * **Why a CLEAN terminal result wins over the pause request** (fix round 2). The row status alone is
 * not the discriminator: `signalPause('cursor')` kills by pid, and a child that had already exited
 * makes that a quiet no-op (ESRCH), so a run can finish perfectly while its row still reads
 * `pause_requested`. That is the `finished_first` case the milestone's pause strategy names, and a
 * pause that arrives after the work is done is not a pause -- there is nothing left to interrupt
 * and nothing to resume. Recording it as `paused` would take a SUCCESSFUL run non-terminal forever:
 * no `terminalAt`, no `endedAt`, a scheduler that never advances the task, and an operator invited
 * to resume a session with nothing left to do. So a run that produced `isError: false` falls
 * through to the terminal path below and is recorded as the success it was. A run that produced no
 * terminal result, or an errored one, is the genuine pause: the kill is exactly what caused it.
 *
 * **...unless the clean result was only reached because the pause gate denied a call** (final
 * review I2). `deniedToolUseIds` is populated from `tool_call/completed` lines whose result is
 * `rejected`, and on a Cursor run the ONLY thing that produces a rejection is this system's own
 * `beforeShellExecution` hook -- which denies only while the pause flag exists. So a non-empty
 * `deniedToolUseIds` is not incidental to the pause: it is evidence the pause was in flight and
 * working. The sequence is `signalPause` writes the flag, SIGTERMs with a 2 s grace, the agent
 * starts one more shell command inside that window, the gate denies it (the entire purpose of
 * writing the flag before the kill), and `cursor-agent` treats the denial as an ordinary tool error
 * and still reaches `result` with `is_error: false`. Letting that "success" win recorded a pause
 * that worked exactly as designed as a FAILURE -- no checkpoint, no `run.paused`, nothing to
 * resume, and (via `verifyConcludedRun`) an attempt burned. Hence the early return needs all three:
 * a terminal result, not an error, AND nothing denied.
 *
 * **No kill here**, unlike the gate path's `killWithEscalation`. The process is already gone; that
 * is why this code is running.
 */
async function recordCursorPauseIfRequested(input: {
  readonly runId: RunId
  readonly sessionId: string | null
  readonly toolCalls: number
  readonly lastToolUseId: string | null
  readonly lastToolName: string | null
  readonly denied: readonly string[]
  /** The run's own terminal result, when it produced one. See the docstring's fix-round-2 note. */
  readonly outcome: RunOutcome | null
  readonly spawn: PumpRunInput['spawn']
  readonly emit: (
    type: Parameters<typeof appendEvent>[0]['type'],
    actor: Actor,
    payload: unknown,
  ) => Promise<void>
}): Promise<boolean> {
  if (input.spawn?.provider !== 'cursor') return false
  // A run that reported a clean terminal result AND had nothing denied finished; the pause request
  // lost the race and does not get to reclassify it. Everything else -- no terminal result, an
  // errored one, or a clean one whose calls this system's own pause gate blocked -- reaches the
  // pause below. See the docstring's two "clean terminal" paragraphs.
  if (input.outcome !== null && !input.outcome.isError && input.outcome.deniedToolUseIds.length === 0) return false

  // Claimed, not written, and the claim is what makes this idempotent: `pause_requested` is the
  // one status that means "an operator asked and the signal was sent". A run that reached here in
  // any other state ended for its own reasons and must keep the conclusion that state implies.
  // `endedAt: null` for the usual reason -- an operator's `cancel` or the sweep may already have
  // concluded this run, and their decision stands.
  const claimed = await prisma.agentRun.updateMany({
    where: { id: input.runId, endedAt: null, status: 'pause_requested' },
    data: { status: 'paused', pausedAtStep: input.toolCalls },
  })
  if (claimed.count === 0) return false

  // Status first, then the checkpoint, then the event -- the same order the gate path uses, so the
  // two pause routes cannot drift into different crash-window behaviours.
  await writeCheckpoint({
    runId: input.runId,
    sessionId: input.sessionId,
    toolCalls: input.toolCalls,
    lastToolUseId: input.lastToolUseId,
    lastToolName: input.lastToolName,
    denied: input.denied,
    spawn: input.spawn,
    pauseReason: CURSOR_PAUSE_REASON,
    requestedBy: readPauseRequester(input.spawn.pauseFlagPath),
  })
  await input.emit('run.paused', 'system', { atStep: input.toolCalls })
  return true
}

/**
 * Git, read-only, in the run's worktree.
 *
 * Asynchronous, and bounded. This is awaited inside the pump's `for await`, so a synchronous call
 * here stalls every *other* run's pump, the tick timer and the notification handler along with it --
 * and an unbounded one (a contended `index.lock`) stalls them indefinitely. A failure must not take
 * the pause down with it, but it must also not be silent, because an empty `dirtyFiles` reads as a
 * clean tree.
 */
async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return stdout.trim()
  } catch (error) {
    console.warn(`[pump] git ${args.join(' ')} failed in ${cwd}: ${String(error)}`)
    return ''
  }
}

/**
 * Consumes one run's `RuntimeEvent` stream, writes the domain events it implies, and keeps the
 * run's own row in step with it.
 *
 * One pump per run, concurrent with the tick rather than inside it (spec §5.6): M6 requires events
 * visible within a second, and draining them on the tick period forfeits that by construction.
 * `appendEvent` is transactional, so an individual append is atomic, and this function awaits one
 * per event. Spec §5.6 concludes from that that a slow database applies backpressure to the child's
 * stdout; today it does not, and the comment is written this way rather than repeating the claim.
 * The adapter's event queue buffers without bound and nothing pauses the reader over the child's
 * stdout, so a slow database grows an in-memory array instead of slowing the agent. Nothing is
 * lost, which is the property that matters here -- but the backpressure is not real until that
 * queue gains a high-water mark, and that is Task 6's code, not this file's.
 *
 * This function owns the `AgentRun` row's live columns, because it is the only thing that watches
 * the stream: `sessionId` (spec §5.4, written in the same step as `run.started`), `toolCalls` (the
 * count §3.3's ceiling is read from), and the terminal `status`/`costUsd`/`terminalAt`. Task 13
 * writes the row at spawn and never sees it end.
 *
 * Returns the run's normalized outcome, or `null` when there was not one -- a gate failure, a
 * pause, or a stream that ended without a terminal event. A `null` is never a success.
 */
export async function pumpRun(input: PumpRunInput): Promise<RunOutcome | null> {
  const { runId, taskId, agentId, workspaceId } = input

  const emit = async (
    type: Parameters<typeof appendEvent>[0]['type'],
    actor: Actor,
    payload: unknown,
  ): Promise<void> => {
    await appendEvent({ type, workspaceId, taskId, agentId, runId, actor, payload })
  }

  let outcome: RunOutcome | null = null

  let lastToolUseId: string | null = null
  let lastToolName: string | null = null
  const denied: string[] = []
  // Seeded from the row, not from zero, for the same reason the column is incremented: on a resume
  // this pump is continuing a run that already made tool calls, and `pausedAtStep` should say
  // where the *run* is, not where this pump started reading.
  const startingRow = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
  let toolCalls = startingRow.toolCalls
  // Seeded from the row for the same reason the counter is: a resumed pump is continuing a run that
  // already has a session. Without this, a resumed run that pauses again bails with "nothing could
  // resume it" and silently leaves the *previous*, now-stale checkpoint for the next resume to use.
  let sessionId: string | null = startingRow.sessionId
  let unparsableLines = 0
  let paused = false
  let gateFailed = false

  for await (const event of input.events) {
    switch (event.kind) {
      case 'session_started': {
        // Spec §5.4: not at spawn. `run.started`'s payload carries the session id, and there is no
        // session id until this line -- a run that dies before it produces `run.failed` instead,
        // which is the accurate account of what happened.
        // Conditional, like every other write in this file that moves the run: an operator's
        // `cancel` concludes the run and kills the child, and the stream's remaining lines must not
        // walk a terminal run back to `working`.
        //
        // The status half is a second, more narrowly conditioned write, split out from the
        // sessionId write: a stop claimed *before* this event arrives (`requestStop` marks
        // `stopping` ahead of its kill -- M5 live-gate finding 2) must not be walked back to
        // `working` by a `session_started` line the dying child still had buffered. `sessionId`
        // itself has no such hazard -- it is written once and never contradicts a later status --
        // so it stays unconditioned beyond `endedAt: null`.
        //
        // `{ in: ['starting', 'resuming'] }`, not just `'starting'`: this is the ONLY write of the
        // domain's `resuming --resumed--> working` edge (tick.ts claims paused->resuming;
        // resume.ts writes only pid/pauseReason/pausedAtStep, never the status itself). Narrowing
        // this to `'starting'` alone -- gate-fix B review round 1, Critical 1 -- stranded every
        // resumed run in `resuming` for its whole remaining life, because a resumed pump's stream
        // opens with `session_started` exactly like a fresh one's.
        await prisma.agentRun.updateMany({
          where: { id: runId, endedAt: null },
          data: { sessionId: event.sessionId },
        })
        await prisma.agentRun.updateMany({
          where: { id: runId, endedAt: null, status: { in: ['starting', 'resuming'] } },
          data: { status: 'working' },
        })
        sessionId = event.sessionId
        if (input.resumed !== true) await emit('run.started', 'agent', { sessionId: event.sessionId })
        break
      }

      case 'tool_call': {
        // `increment`, never an absolute local count. A resumed run is a *second* `pumpRun` on the
        // same row -- the adapter closes the old queue and `events()` hands out a new one (Task
        // 6/9) -- so writing a count that starts at zero refunds the tool-call budget every time
        // an agent pauses. Task 15's §3.3 ceiling reads this column.
        toolCalls += 1
        lastToolUseId = event.toolUseId
        lastToolName = event.toolName
        await prisma.agentRun.updateMany({ where: { id: runId, endedAt: null }, data: { toolCalls: { increment: 1 } } })
        // `summary` is the readable form the parser derives from the tool_use block's `input`
        // (M4 spec §1) -- e.g. `Write note3.txt` rather than the opaque `toolUseId`. It falls
        // back to the bare tool name when no known argument key is present.
        await emit('run.tool_call', 'agent', { name: event.toolName, summary: event.summary })
        break
      }

      case 'text': {
        // Truncated from the end, and *said* to be truncated: the beginning is what a reader
        // wants, and a sentence that simply stops reads as the agent having stopped.
        const text =
          event.text.length > OUTPUT_CAP ? `${event.text.slice(0, OUTPUT_CAP - 1)}…` : event.text
        await emit('run.output', 'agent', { text })
        break
      }

      case 'permission_denied': {
        // A permission-mode denial is *not* a pause. The pause protocol is a hook deny, which
        // removes the agent's ability to act; this is one tool refused, with the agent free to
        // try another -- and ADR 0001 measured it doing exactly that. Reporting it as `run.paused`
        // would tell an operator a run had stopped when it had not.
        denied.push(event.toolUseId)
        await emit('guardrail.tripped', 'system', {
          guardrail: 'permission_mode',
          detail: `${event.toolName} was denied by the permission mode (${event.toolUseId})`,
        })
        break
      }

      case 'hook_denied':
      case 'hook_crashed':
      case 'hook_failed_open': {
        // The pause protocol and the workspace-halting circuit breaker, both driven from here --
        // but by the outcome the write gate actually produced, never by which of these three
        // Claude-shaped `RuntimeEvent` variants arrived. `classifyGateEvent`
        // (`@ai-team-os/providers`) is the one place left that still knows that mapping; everything
        // below asks only `gateOutcome.kind`. This is the seam M12 Task 4 exists for: a runtime
        // whose gate produces differently-shaped events still drives both mechanisms below, as long
        // as its adapter's own `classifyGateEvent`-equivalent maps them the same way.
        //
        // `permission_denied` is deliberately not one of this case's labels -- see its own case
        // above and `classifyGateEvent`'s docstring (controller ruling, M12 Task 4) for why: it is
        // a guardrail observation, not a pause-protocol signal, and has no `reason` to source
        // `stopped_by_gate` from.
        const gateOutcome = classifyGateEvent(event)
        // Unreachable in practice -- `classifyGateEvent` maps exactly these three `RuntimeEvent`
        // kinds to a non-null `GateOutcome`. Guarded rather than asserted so a future change to
        // that mapping fails here, loudly, instead of silently doing nothing.
        if (gateOutcome === null) {
          console.warn(`[pump] ${event.kind} produced no GateOutcome on run ${runId}; ignoring`)
          break
        }

        switch (gateOutcome.kind) {
          case 'stopped_by_gate': {
            // Once only (fix round 1, M5 gate-fix A review). The real CLI does not exit promptly
            // on the SIGTERM below -- the live-gate trace that motivated this file's kill call
            // shows a *second* deny arriving after the first `run.paused` (`run.paused (atStep 5)`
            // -> another Bash call -> `run.paused (atStep 6)`) -- and that second deny stays
            // reachable for as long as `killWithEscalation`'s grace window is open. Recording the
            // pause and killing the child are both idempotent in effect (the row is already
            // `paused`; the pid is already signalled or dead), so re-running them costs real
            // things for no benefit: a second checkpoint write, a second multi-second
            // `killWithEscalation` sleep, and a duplicate `run.paused` in the operator's
            // transcript. The whole branch is a no-op on a repeat -- `paused` is exactly the
            // run-level fact that distinguishes "first deny" from "still gated, denied again"
            // here, matching the sibling `gateFailed` guard in the `gate_failed` branch below.
            if (paused) break

            // The pause gate doing its job. The adapter kills the process after the deny (Task 8),
            // so the stream ends here -- and recording the pause is what stops Task 15's orphan
            // sweep seeing a `working` run with a dead pid and failing it. The domain's state
            // machine only admits `paused` from `pause_requested`; the pump reports what the
            // runtime did rather than adjudicating that, because the alternative to an unexpected
            // `paused` row is a killed process still recorded as working.
            paused = true
            await prisma.agentRun.updateMany({
              where: { id: runId, endedAt: null },
              data: { status: 'paused', pausedAtStep: toolCalls },
            })
            await writeCheckpoint({
              runId,
              sessionId,
              toolCalls,
              lastToolUseId,
              lastToolName,
              denied,
              spawn: input.spawn,
              pauseReason: gateOutcome.reason,
              // Who asked, when the flag file says. §6 lists it as provenance and nothing wrote it.
              requestedBy: readPauseRequester(input.spawn?.pauseFlagPath),
            })

            // The real CLI does not exit on a hook deny (M5 live-gate finding 1): it treats the
            // deny as an ordinary tool error and keeps working -- retrying the denied write,
            // reaching for an un-gated tool like Read, arguing in its own transcript that the
            // block "may be transient". Nothing else in this process's path kills it: pause is a
            // stateless flag-file write (`packages/providers`'s `signalPause`, M12 Task 3), not a
            // call into an adapter instance -- the adapter's own former kill-on-deny path required
            // its now-retired `requestPause` to arm it (M12 Task 4) and never armed for a
            // daemon-driven pause even before that. This is the only place left that observes the
            // deny and can act on it. Kill only now, after the checkpoint write above has landed
            // (or declined to, just below): killing first would risk losing the resume point if
            // the checkpoint write itself failed partway through.
            //
            // Unconditional on whether a checkpoint actually got written. A run with no spawn facts
            // or no session id cannot be resumed by anyone (`writeCheckpoint`'s own early return) --
            // but that is a reason to kill, not a reason not to: a run nobody can resume is a run an
            // operator can only wait out or kill by hand, and a live, ungated child left running
            // under it is strictly worse than a dead one, resumable or not.
            await killWithEscalation(startingRow.pid)
            await emit('run.paused', 'system', { atStep: toolCalls })
            break
          }

          case 'gate_failed': {
            // Once only. The stream keeps being read after this (see the end of the loop), so a
            // second gate event must not cancel twice or count a second attempt against the task.
            if (gateFailed) break
            gateFailed = true

            // Cancel first, and do not wait for the stream to end. A gate failure that waits for
            // `terminated` is a gate failure that never fires, because the run whose gate has
            // failed is precisely the run that may never stop on its own (spec §13.1, behaviour 1).
            //
            // A cancel that *rejects* must make this louder, never quieter. Letting it propagate --
            // which it did until this was measured -- skipped behaviours 2 to 4 entirely: no halt,
            // no events, an attempt uncounted and the row still reading `working`. That is an agent
            // running with no gate, a kill that did not land, and a scheduler still free to start
            // more of them; the one case where the halt matters most was the one case it did not
            // happen.
            let cancelError: unknown = null
            try {
              await input.cancel()
            } catch (error) {
              cancelError = error
            }

            const reason =
              gateOutcome.detail +
              (cancelError === null
                ? ''
                : ` -- AND THE CANCEL FAILED (${String(cancelError)}): the process may still be running.`)

            // The halt goes first among the writes. Each of these is its own transaction, so their
            // order is the only lever there is, and a crash between them has to leave the
            // recoverable things undone rather than this one: a missing run row or attempt is Task
            // 15's sweep to repair, while a missing halt means the scheduler keeps starting runs
            // against a hook that is still broken -- the exact recurrence §13.1 exists to bound.
            // §13.1 lists the halt fourth, but that list is the operator's narrative, not a
            // durability order.
            //
            // Conditional on `haltedReason` still being null: the *earliest* gate failure is the
            // one that explains the workspace's state, and `haltedAt` is the moment of the
            // transition. Overwriting would walk that timestamp forward for as long as runs keep
            // failing, so a halt an operator has been ignoring for an hour would read as one
            // second old. `updateMany` because a conditional update needs a filter on a non-unique
            // column; under read committed a concurrent pump blocks on the row and then re-checks
            // the predicate, so two simultaneous gate failures cannot both write.
            await prisma.workspace.updateMany({
              where: { id: workspaceId, haltedReason: null },
              data: { haltedReason: reason, haltedAt: new Date() },
            })

            const now = new Date()
            await prisma.agentRun.updateMany({
              where: { id: runId, endedAt: null },
              data: { status: 'failed', terminalAt: now, endedAt: now },
            })
            // The attempt counts, so a task cannot loop forever against a gate that stays broken.
            // A task-less `planning` run (M8b) has no attempt counter to increment.
            if (taskId !== null) {
              await prisma.task.update({ where: { id: taskId }, data: { attempt: { increment: 1 } } })
            }

            // Two events, because the run failed *and* a guardrail is what failed it (§13.1).
            await emit('run.failed', 'system', { reason })
            await emit('guardrail.tripped', 'system', { guardrail: 'pause_gate', detail: reason })
            break
          }
        }
        break
      }

      case 'terminated': {
        outcome = event.outcome
        break
      }

      case 'unparsable': {
        // Spec §13: dropped and recorded, the run continues -- safe only because a dropped line is
        // never a gate signal, which is Task 4's `hook_response` guard. Recorded out of band on
        // purpose: spec §9 adds exactly nine catalogue types and invents no names, none of the
        // nineteen means "the orchestrator could not read a line", and folding it into
        // `run.output` would put orchestrator diagnostics into the stream M4 renders as the agent
        // speaking.
        unparsableLines += 1
        console.warn(`[pump] unparsable stream line on run ${runId}: ${event.line}`)
        break
      }

      case 'ignored':
        break
    }

  }

  if (gateFailed || paused) return null

  // The Cursor half of the pause protocol (M12 Task 12 fix round 1). Placed here, after the loop
  // and ahead of BOTH terminal paths below, because either can be how a killed Cursor run ends: the
  // kill may land before the CLI writes its `result` line (no terminal event) or after it (a
  // terminated event reporting an error). `outcome` is passed in rather than ignored (fix round 2)
  // -- a CLEAN terminal result means the run finished before the pause reached it, and that run is
  // a success, not a pause. See the function's docstring.
  if (
    await recordCursorPauseIfRequested({
      runId,
      sessionId,
      toolCalls,
      lastToolUseId,
      lastToolName,
      denied,
      outcome,
      spawn: input.spawn,
      emit,
    })
  ) {
    return null
  }

  if (outcome === null) {
    const now = new Date()
    // `stopping` alone is not enough to conclude `stopped` here (gate-fix B review round 1,
    // Critical 2): the guardrail sweep (`sweep.ts`) claims the SAME `stopping` status ahead of its
    // own `adapter.cancel`, for a timed-out or over-the-tool-cap run, and writes no terminal row of
    // its own -- it relies on this branch, which before this fix always concluded `failed`.
    // Matching `stopping` alone would silently reclassify every guardrail kill as `stopped`, which
    // `world.ts` reads as `terminal_uncounted`: those runs would stop counting toward
    // `consecutiveFailures`, and a workspace whose gate keeps timing out or blowing the tool cap
    // would never halt.
    //
    // `stopRequestedAt` is the discriminator: only `requestStop` (an operator's web/CLI stop)
    // writes it, in the same conditioned update that claims `stopping`, before its kill (M5
    // live-gate finding 2). In the CLI, `requestStop` owns this pump and always reaches its own
    // `stopped` write first, so this branch rarely observes the intent record there either; under
    // a daemon, a web stop's kill lands in another process and can wake this stream before
    // `requestStop`'s own conclusion runs. Either way, when the intent record is present the row
    // must read `stopped`, and this is the side that has to write it when it wins that race.
    const stopClaimed = await prisma.agentRun.updateMany({
      where: { id: runId, endedAt: null, status: 'stopping', stopRequestedAt: { not: null } },
      data: { status: 'stopped', terminalAt: now, endedAt: now },
    })
    if (stopClaimed.count > 0) {
      // Read back who asked. Safe after the fact: nothing else can still be writing this row --
      // every other writer's own update is conditioned on `endedAt: null`, which this call just
      // set.
      const stopped = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
      await emit('run.stopped', 'system', {
        reason:
          stopped.stopRequestedBy === null
            ? 'cancelled by an operator'
            : `cancelled by ${stopped.stopRequestedBy}`,
      })
      return null
    }

    // The stream ended with no terminal event and no recorded stop intent: the child died without
    // reporting. Not a success, and not silent.
    const reason = `the run's output stream ended without a terminal result${
      unparsableLines > 0 ? ` (${unparsableLines} unparsable line(s) were dropped first)` : ''
    }`
    // Conditional on the run not already being terminal. An operator's `cancel` writes `stopped`
    // and kills the child; the stream then ends without a terminal event and this branch used to
    // overwrite that with `failed`, emitting a spurious `run.failed` after `run.stopped` -- which
    // under a daemon is what happens on *every* cancel.
    const concluded = await prisma.agentRun.updateMany({
      where: { id: runId, endedAt: null },
      data: { status: 'failed', terminalAt: now, endedAt: now },
    })
    if (concluded.count > 0) await emit('run.failed', 'system', { reason })
    return null
  }

  // A clean completion with denials is a failure. ADR 0001 measured a run reporting
  // `is_error: false` while landing nothing, detectable only through `permission_denials` -- so the
  // terminal flag alone is not what decides this.
  const failed = outcome.isError || outcome.deniedToolUseIds.length > 0
  const terminalNow = new Date()
  const concluded = await prisma.agentRun.updateMany({
    where: { id: runId, endedAt: null },
    data: {
      status: failed ? 'failed' : 'succeeded',
      costUsd: outcome.costUsd,
      terminalAt: terminalNow,
      endedAt: terminalNow,
    },
  })
  // An already-terminal run was concluded by someone else -- an operator's `cancel`, or the sweep.
  // Their decision stands, and announcing this one would contradict it.
  if (concluded.count === 0) return outcome

  if (failed) {
    const denied =
      outcome.deniedToolUseIds.length > 0
        ? ` ${outcome.deniedToolUseIds.length} tool call(s) were denied: ${outcome.deniedToolUseIds.join(', ')}`
        : ''
    await emit('run.failed', 'system', { reason: `${outcome.terminalReason}.${denied}`.trim() })
  } else {
    await emit('run.succeeded', 'system', { numTurns: outcome.numTurns, costUsd: outcome.costUsd })
  }

  return outcome
}
