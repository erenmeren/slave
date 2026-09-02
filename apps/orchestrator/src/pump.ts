import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { killWithEscalation } from '@ai-team-os/control'
import { toExecutionEvent } from '@ai-team-os/db'
import { Prisma, prisma } from '@ai-team-os/db/client'
import type { AgentId, RunId, TaskId, WorkspaceId } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import {
  classifyGateEvent,
  PERMISSION_DENY_REASON_PREFIX,
  parsePermissionDenyReason,
  type ProviderKind,
  type RunOutcome,
  type RuntimeEvent,
} from '@ai-team-os/providers'

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
 * Whether the runtime this run was SPAWNED with can report SKILL invocations at all (M14
 * §4.1, Decision 4, narrowed by M15 spec §4 -- see below).
 *
 * Keyed on `spawn.provider` -- the same field `recordCursorPauseIfRequested` branches on -- and
 * deliberately NOT on what the stream happened to contain. An empty tally means two different
 * things depending on the runtime, and only one of them is a measurement: on Claude it is "we
 * watched every tool call and none was a `Skill`" (`{}`), on Cursor it is "this runtime never
 * emits one, so we do not know" (`null`). Writing `{}` for Cursor would put a fabricated zero
 * into the Skills page's per-skill run counts.
 *
 * `spawn` absent (a test fixture that never pauses, a caller with no spawn facts) reads as
 * "not Cursor": the only runtime this rule excludes is the one that is named. Every real caller
 * -- `tick`, `planning`, `review` and `resume` -- passes `spawn.provider`, so a genuine Cursor run
 * always reaches this with `'cursor'` in hand.
 *
 * `false` is written as `Prisma.DbNull`, not a bare `null`: on a nullable Json column those are
 * different values, and only the former is SQL NULL.
 *
 * NOT used for `tokensIn`/`tokensOut` (M15 fix round 1): M14's provider-keyed `null` for Cursor
 * tokens is superseded by M15 spec §4 for tokens specifically -- `cursor/stream.ts` now maps
 * Cursor's `result`-line `usage` into `RunOutcome.tokens` under the same billed-input rule as
 * Claude's, and `writeStreamUsage` below persists that figure, for ANY provider, whenever the
 * stream actually reported it (`outcome.tokens` non-null). This function's name describes what
 * it still gates: the skills tally, and only the skills tally.
 */
function runtimeReportsUsage(spawn: PumpRunInput['spawn']): boolean {
  return spawn?.provider !== 'cursor'
}

/**
 * The row's stored tally, read defensively.
 *
 * `skillCalls` is a `Json?` column, so its static type is `JsonValue` and nothing at the database
 * level stops a scalar from being in there. `Object.entries` over a string yields index keys rather
 * than throwing, which would silently corrupt the tally instead of failing, so the shape is checked
 * and non-numeric values are dropped rather than asserted away.
 */
function storedTally(value: unknown): Map<string, number> {
  const tally = new Map<string, number>()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return tally
  for (const [name, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count === 'number' && Number.isFinite(count)) tally.set(name, count)
  }
  return tally
}

/**
 * Records what this pump watched, ONCE, when its stream ends -- however it ended (M14 §4.1/§4.2,
 * Decisions 4 and 5, fix round 1).
 *
 * At the stream's end rather than on the terminal status writes, because **these are facts of the
 * STREAM, and the row's conclusion is a fact of whoever won the race to write it**, and those are
 * not the same event. `packages/control/src/stop.ts` concludes an operator-stopped run from
 * another call path entirely, with no tally or usage in hand, and by `pumpRun`'s own reckoning it
 * normally wins -- so a tally or a token total carried only on this file's status-conditioned
 * writes was measured and then discarded on the single most common way a run is stopped
 * deliberately. A pause is the same shape of loss for the opposite reason: it writes no conclusion
 * at all, so either figure that waited for one lost everything the run did before pausing, and the
 * resume had nothing to continue from.
 *
 * `skillCalls` (unconditional, with no `endedAt`/status filter -- the row may already be
 * terminal, that is the case this exists for, and refusing to write onto a concluded row is
 * precisely the bug) and `tokensIn`/`tokensOut` (below) are two different columns with two
 * different write conditions, because they answer two different questions: "what did THIS pump
 * watch" (always answerable, even by a stream that produced no `result` line -- the answer may be
 * "nothing") versus "what did the `result` line report" (answerable only when there was one).
 *
 * `skillCalls` is MERGED into what the row holds, not overwritten: a resumed run is a SECOND
 * `pumpRun` on the same row, and its own tally Map counts only what it watched. `tokensIn`/
 * `tokensOut` are REPLACED, not merged, the one time they are written at all: a `result` line
 * reports the run's cumulative usage, not a delta, the same way `costUsd` is a replace and not an
 * accumulation.
 */
async function writeStreamUsage(input: {
  readonly runId: RunId
  readonly tally: ReadonlyMap<string, number>
  readonly spawn: PumpRunInput['spawn']
  readonly outcome: RunOutcome | null
}): Promise<void> {
  const reportsSkillCalls = runtimeReportsUsage(input.spawn)

  if (!reportsSkillCalls) {
    // Stated, not merely left alone: this runtime cannot report skill use, and `Prisma.DbNull` is
    // SQL NULL -- the "we do not know" of Decision 4, never the `{}` that would claim a
    // measurement nobody made.
    await prisma.agentRun.updateMany({ where: { id: input.runId }, data: { skillCalls: Prisma.DbNull } })
  } else {
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: input.runId } })
    const merged = storedTally(row.skillCalls)
    for (const [name, count] of input.tally) merged.set(name, (merged.get(name) ?? 0) + count)
    // A plain object, never the `Map` -- Prisma writes the latter as `{}`.
    await prisma.agentRun.updateMany({ where: { id: input.runId }, data: { skillCalls: Object.fromEntries(merged) } })
  }

  // Tokens are a fact of the `result` line, not of the stream ending: a pause or an operator's
  // kill produces no `result` line at all (`outcome` stays `null`), and writing `null` onto the
  // row then would erase a total an earlier pump of this same run already wrote (a resume that
  // itself pauses again). So, unlike `skillCalls` above, this write only happens when THIS
  // stream's `outcome` is not `null`.
  if (input.outcome === null) return
  await prisma.agentRun.updateMany({
    where: { id: input.runId },
    data: {
      // NOT gated on `runtimeReportsUsage`/`reportsSkillCalls` (M15 fix round 1): that function
      // governs the skills tally only. `outcome.tokens` is written whenever it is NON-NULL, for
      // ANY provider -- a non-null `tokens` is a measurement the stream actually reported
      // (`cursor/stream.ts`'s `tokensFromUsage` already degrades a malformed or absent `usage`
      // to `null` before this ever sees it), and M15 spec §4 supersedes M14's provider-keyed
      // `null` for tokens specifically. When `outcome.tokens` is `null` -- Cursor result lines
      // with no usable `usage`, or any provider's degraded reading -- both columns stay `null`.
      tokensIn: input.outcome.tokens?.input ?? null,
      tokensOut: input.outcome.tokens?.output ?? null,
    },
  })
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
 * review I2, made real by M15). The check reads `input.denied`, the pump's own tally built while
 * reading the stream -- as of M15 that tally fills for Cursor too, because a `tool_call/completed`
 * line whose result is `rejected` now parses to `permission_denied` (`cursor/stream.ts`) and lands
 * in `denied` the same way any other mid-stream denial does. `outcome.deniedToolUseIds` sees the
 * same Cursor denial too -- `cursor/adapter.ts`'s `withDerivedFields` derives it from the identical
 * `result.rejected` lines (`observeRawLine`) -- so this is not about one field seeing what the other
 * cannot. The check reads `input.denied` specifically because that is the exact value the checkpoint
 * write below also uses (`deniedToolUseIds: [...input.denied]`): deciding off the same source the
 * checkpoint records keeps the two from ever disagreeing. On a Cursor run the ONLY thing that
 * produces a rejection is this system's own `beforeShellExecution` hook -- which denies only while
 * the pause flag exists -- so a
 * non-empty `denied` is not incidental to the pause: it is evidence the pause was in flight and
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
  //
  // `input.denied`, not `input.outcome.deniedToolUseIds`: both see a Cursor denial (the adapter
  // derives `outcome.deniedToolUseIds` from the same `result.rejected` lines, `cursor/adapter.ts`'s
  // `withDerivedFields`), so this is not a matter of one field being blind. `input.denied` is read
  // here because it is the exact value the checkpoint below is written from -- deciding off the
  // source the checkpoint also uses keeps the decision and the record from disagreeing.
  if (input.outcome !== null && !input.outcome.isError && input.denied.length === 0) return false

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

  // Status first, then the checkpoint, then the event -- the two pause routes deliberately DIFFER
  // in ordering as of M13, and the difference is not drift. The gate path writes the checkpoint,
  // kills the child, and only then writes `paused` (Decision 1: a run is paused when its process
  // is dead). This path runs after the stream has already ended, i.e. after the child is already
  // gone, so the claim IS the moment the run became paused and there is nothing left to kill --
  // see this function's "No kill here" note above.
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

  let lastToolUse: { readonly id: string; readonly name: string } | null = null
  /**
   * M21 C1: `hook_id` -> the tool_use its PreToolUse hook serves. Bound when the hook STARTS --
   * immediately after the tool_use it belongs to, before any later tool_call -- and only when the
   * hook's tool name matches the last tool_call (the B2 cross-check, kept). A later `hook_denied`
   * carrying that id resolves here, so the out-of-order RESPONSE the real capture recorded
   * (`permission-matrix-deny.ndjson` line 24 answering line 15 after an unrelated Bash deny) no
   * longer matters, and B2's over-fail (a deny answered after a differently named call) is closed.
   * Residual limit, measured and unfixable from the stream: parallel same-named tool_use blocks in
   * ONE assistant message start their hooks after the whole message, so both bind to the last
   * block; `hook_started` carries no tool_use_id. Entries are consumed on resolution.
   */
  const hookBindings = new Map<string, { readonly toolUseId: string; readonly toolName: string }>()
  const denied: string[] = []
  /**
   * M18 Task 6 fix round 1 (review Critical 1): the tool-use ids this pump itself routed to
   * `run.tool_denied` rather than the pause protocol or the permission-mode guardrail. The real
   * CLI (measured: `hook-deny.ndjson` carries the denied id in the terminal `result`'s
   * `permission_denials`; Cursor's adapter pushes any rejected `call_id` into
   * `RunOutcome.deniedToolUseIds` the same reason-blind way, `cursor/adapter.ts`'s
   * `rejectedCallIds`) reports EVERY denied call there, a matrix refusal included -- it has no
   * concept of "the matrix said no but the run is fine". Without this set, the failure check below
   * (`outcome.deniedToolUseIds.length > 0`) would fail a run this very function just finished
   * proving survived a matrix refusal, silently undoing Task 6's own routing work at the one place
   * that concludes the run. Populated at the two sites that already know a denial was a matrix one
   * (the `tool_denied` `GateOutcome` case below, and `permission_denied`'s matrix branch above) --
   * an ordinary pause deny or permission-mode denial is never added, so it keeps failing the run
   * exactly as it always has.
   */
  const matrixDeniedToolUseIds = new Set<string>()
  /**
   * B1 (M19): seeded on resume from the run's own prior `run.tool_denied` events, not left at the
   * empty set above. A prior pump on this run confirmed these ids as matrix denies -- it emitted
   * `run.tool_denied` for each, `toolUseId` included -- but that confirmation lived only in THIS
   * function's local `Set`, gone the moment the process paused. The real recorded matrix-deny run
   * (`permission-matrix-deny.ndjson`, Task 1's capture) shows the CLI echoing a denied id in the
   * terminal `result`'s `permission_denials` regardless of why the hook denied it; whether a
   * RESUMED session's terminal result also echoes a denial from BEFORE the pause was not directly
   * measured (that capture never paused and resumed). This seed is fail-safe hardening against
   * that possibility either way: if the resumed session's echo does carry a pre-pause id, an empty
   * set would count an already-survived denial as a fresh failure at the `nonMatrixDeniedToolUseIds`
   * filter below; if it never does, the seed is a no-op. The read goes through the typed mapper now
   * that the schema declares the field (M21 C2); the previous raw-column cast is gone.
   */
  if (input.resumed === true) {
    const prior = await prisma.executionEvent.findMany({ where: { runId, type: 'run_tool_denied' } })
    for (const row of prior) {
      const parsed = toExecutionEvent(row)
      if (!parsed.ok) throw new Error(`event log contains an unparseable run.tool_denied row at seq ${String(row.seq)}: ${parsed.error}`)
      if (parsed.value.type === 'run.tool_denied' && typeof parsed.value.payload.toolUseId === 'string') {
        matrixDeniedToolUseIds.add(parsed.value.payload.toolUseId)
      }
    }
  }
  // Seeded from the row, not from zero, for the same reason the column is incremented: on a resume
  // this pump is continuing a run that already made tool calls, and `pausedAtStep` should say
  // where the *run* is, not where this pump started reading.
  const startingRow = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
  let toolCalls = startingRow.toolCalls
  /**
   * Skills invoked during THIS pump, tallied from the `tool_call` events the loop already sees
   * (M14 §4.1, Decision 5).
   *
   * Empty, deliberately: this is what THIS pump watched, not the run's running total. The total is
   * formed at the write, by merging this into whatever the row already holds -- so a resumed run's
   * second pump adds to its first half instead of replacing it, and a merge cannot double-count a
   * seed it also started from.
   */
  const skillCalls = new Map<string, number>()
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
        if (event.toolName === 'Skill') {
          // `summary` is `"Skill <name>"` (`summaryFor` with `CLAUDE_SUMMARY_ARG_KEYS`'s leading
          // `'skill'` key, M14 Task 4) -- the name is everything after the first space. A `Skill`
          // call whose `input.skill` was missing or unreadable summarizes to the bare tool name,
          // and is counted under the sentinel below rather than dropped: a skill call that
          // happened is a fact, even when the CLI did not say which skill.
          const name = event.summary.startsWith('Skill ') ? event.summary.slice('Skill '.length) : '<unnamed>'
          skillCalls.set(name, (skillCalls.get(name) ?? 0) + 1)
        }
        lastToolUse = { id: event.toolUseId, name: event.toolName }
        await prisma.agentRun.updateMany({ where: { id: runId, endedAt: null }, data: { toolCalls: { increment: 1 } } })
        // `summary` is the readable form the parser derives from the tool_use block's `input`
        // (M4 spec §1) -- e.g. `Write note3.txt` rather than the opaque `toolUseId`. It falls
        // back to the bare tool name when no known argument key is present.
        await emit('run.tool_call', 'agent', { name: event.toolName, summary: event.summary })
        break
      }

      case 'hook_started': {
        // M21 C1: bind while adjacency is still true. The parser emits this for `PreToolUse` only,
        // and its `hookName` is `PreToolUse:<tool>` -- the tool the hook is about to gate. Nothing
        // is bound unless that name matches the last `tool_call`: `hook_started` carries no
        // `tool_use_id` of its own, so adjacency is the only evidence there is, and B2's
        // cross-check is what keeps a hook that cannot be placed from being placed anyway.
        const tool = event.hookName.startsWith('PreToolUse:') ? event.hookName.slice('PreToolUse:'.length) : null
        if (tool !== null && lastToolUse !== null && lastToolUse.name === tool) {
          hookBindings.set(event.hookId, { toolUseId: lastToolUse.id, toolName: lastToolUse.name })
        }
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
        //
        // M18 Task 6: Cursor's OWN denial echo carries the SAME permission-matrix reason Claude's
        // `hook_denied` does, when it was the matrix (not Cursor's shell gate's own pause) that
        // refused the call -- `reason` is optional because Claude's permission-mode denial and an
        // ordinary Cursor shell-gate pause report none. A matrix-prefixed reason here is routed to
        // the identical `run.tool_denied` handling `hook_denied` gets below, and -- unlike an
        // ordinary permission-mode refusal -- does NEITHER of the two things below: it does not
        // `denied.push`, because `denied` is exactly what `recordCursorPauseIfRequested` (:397)
        // reads to decide whether a clean-terminal Cursor run was actually paused, and a matrix
        // refusal on an otherwise-clean run poisoning that array would misclassify it as paused;
        // and it does not emit `guardrail.tripped`, because a matrix deny is a fact the run
        // survives, not an observation of the agent being refused by the permission MODE.
        //
        // Fix round 1 (review Important 4, controller ruling): routed only on a FULL parse, the
        // same rule `classifyGateEvent` now applies on the Claude side -- fail-safe is treating an
        // unparseable prefixed reason as an ORDINARY permission-mode denial (falls through below),
        // never as a matrix refusal this pump cannot actually name the tool/capability for.
        if (event.reason !== undefined && event.reason.startsWith(PERMISSION_DENY_REASON_PREFIX)) {
          const parsed = parsePermissionDenyReason(event.reason)
          if (parsed !== null) {
            // Review Critical 1: `event.toolUseId` is the exact `call_id` `cursor/adapter.ts`'s
            // `rejectedCallIds` (hence `RunOutcome.deniedToolUseIds`) also records for this same
            // rejection -- recorded here so the terminal failure check below can tell this denial
            // apart from a genuine one.
            matrixDeniedToolUseIds.add(event.toolUseId)
            await emit('run.tool_denied', 'agent', { tool: parsed.tool, capability: parsed.capability, toolUseId: event.toolUseId })
            break
          }
        }
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
        // M18 Task 6: `hook_denied` alone can also classify to a THIRD outcome, `tool_denied` --
        // `classifyGateEvent` reads the matrix prefix off `event.reason` to tell a permission-matrix
        // refusal (the run survives) from an actual pause deny (below) before this switch ever sees
        // it, so the three-label `case` above stays accurate: it is still exactly the `RuntimeEvent`
        // kinds `classifyGateEvent` maps, one of which now maps to two different outcomes.
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
            // Once only, and claimed BEFORE any of the work below (M13 Decision 1). The real CLI does not
            // exit promptly on the SIGTERM further down -- the live-gate trace that motivated this file's
            // kill call shows a second deny arriving after the first pause -- and with the status write now
            // at the END of this branch, `paused` is the only thing standing between that second deny and a
            // duplicate checkpoint write, a duplicate multi-second kill and a duplicate `run.paused`.
            if (paused) break
            paused = true

            // 1. The checkpoint, still before the kill (M13 Decision 2): killing first risks losing the
            // resume point if the checkpoint write fails partway through.
            await writeCheckpoint({
              runId,
              sessionId,
              toolCalls,
              lastToolUseId: lastToolUse?.id ?? null,
              lastToolName: lastToolUse?.name ?? null,
              denied,
              spawn: input.spawn,
              pauseReason: gateOutcome.reason,
              // Who asked, when the flag file says. §6 lists it as provenance and nothing wrote it.
              requestedBy: readPauseRequester(input.spawn?.pauseFlagPath),
            })

            // 2. The kill. Unconditional on whether a checkpoint actually got written: a run with no spawn
            // facts or no session id cannot be resumed by anyone (`writeCheckpoint`'s own early return) --
            // but that is a reason to kill, not a reason not to. `killWithEscalation` SIGKILLs at the grace
            // deadline, so on return the pid is gone.
            await killWithEscalation(startingRow.pid)

            // 3. Only now is the run PAUSED (M13 Decision 1). Every consumer of this status -- the orphan
            // sweep, `requestResume`, the operator's panel -- may rely on the pid being gone. Until this
            // write lands, the row reads whatever it read before (`pause_requested` when an operator asked),
            // which is exactly the honest answer during the grace window.
            //
            // `endedAt: null`, deliberately NOT narrowed to `status: 'pause_requested'`: a deny that arrives
            // on a `working` run (no operator asked; the domain machine does not admit it as `paused`) is
            // still reported as what the runtime did, exactly as before this reordering. Only the ordering
            // moved.
            await prisma.agentRun.updateMany({
              where: { id: runId, endedAt: null },
              data: { status: 'paused', pausedAtStep: toolCalls },
            })

            // 4. And only now is it announced.
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
              data: {
                status: 'failed',
                terminalAt: now,
                endedAt: now,
              },
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

          case 'tool_denied': {
            // M18 Task 6: a permission-MATRIX refusal, not a pause -- `classifyGateEvent` only
            // reaches this kind on a FULL parse of `hook_denied.reason` (fix round 1, review
            // Important 4 controller ruling: a prefixed-but-malformed reason stays `stopped_by_gate`
            // above -- fail-safe is pausing, not silently trusting an unparseable matrix claim). One
            // event, exactly once per refusal, and nothing else: no `paused`, no checkpoint, no
            // `killWithEscalation`. The run is still working; the agent is free to try something
            // else, the same way ADR 0001 measured a permission-mode denial leaving it free to.
            // B2 (M19): "the last tool_call this pump saw" is not, on its own, proof this deny
            // belongs to it. Task 1's REAL capture (`permission-matrix-deny.ndjson`) measured hook
            // responses arriving OUT OF ADJACENCY ORDER -- a second `PreToolUse:Read` response
            // landed after a Bash tool_use, after that Bash call's own deny, and after the deny's
            // tool_result. "Last tool_call seen" was the right id in that recording by luck, not by
            // contract. B2 narrowed that to the denies whose reason names the same tool as the last
            // tool_call (`gateOutcome.tool`, from `parsePermissionDenyReason`), and paid for it with
            // an over-fail: a REAL matrix deny answered after a differently NAMED later call failed
            // the check too, so `associated` was `null` for a legitimate survivable refusal.
            //
            // M21 C1 closes that over-fail. The binding above -- made when the hook STARTED, while
            // adjacency was still true -- is consulted FIRST, so an out-of-order response resolves
            // by its own `hook_id` rather than by whatever happened to be last. B2's name rule stays
            // as the fallback for a deny with no `hook_id` (an older CLI, another runtime) and for
            // one whose id never bound. The residual limit is the parallel same-message case:
            // several same-named `tool_use` blocks in ONE assistant message have their hooks start
            // after the whole message, and `hook_started` carries no `tool_use_id`, so they all bind
            // to the last block. Fail-safe is unchanged in both fallbacks: when neither the binding
            // nor the name rule can vouch for an id, `associated` is `null` and nothing below
            // launders that id out of the terminal failure check.
            const bound = gateOutcome.hookId === undefined ? undefined : hookBindings.get(gateOutcome.hookId)
            // Consumed on resolution: a hook_id answers exactly once, and a map that only grows
            // would keep a stale binding alive for a whole run.
            if (gateOutcome.hookId !== undefined) hookBindings.delete(gateOutcome.hookId)
            const associated =
              bound !== undefined
                ? bound.toolUseId
                : lastToolUse !== null && lastToolUse.name === gateOutcome.tool
                  ? lastToolUse.id
                  : null
            await emit('run.tool_denied', 'agent', {
              tool: gateOutcome.tool,
              capability: gateOutcome.capability,
              toolUseId: associated,
            })
            // Review Critical 1, narrowed by B2: the CLI reports this same denial in the terminal
            // result's `permission_denials` regardless of WHY the hook denied it (measured:
            // `hook-deny.ndjson`'s pause deny lands there too), and this Set is what the terminal
            // failure check excludes from `outcome.deniedToolUseIds` (`nonMatrixDeniedToolUseIds`)
            // -- so a wrongly-associated id here would not just mislabel one event, it would launder
            // that id out of the failure check for the rest of this pump's run AND get persisted
            // into `run.tool_denied`'s own payload, ready to be re-seeded into every subsequent
            // resume of this run (the seed at this Set's declaration reads exactly that payload
            // back). On a name mismatch `associated` is `null` above, so nothing is added here --
            // the mismatched id stays in `outcome.deniedToolUseIds` unexcluded, and a run that
            // terminal-echoes it still fails, exactly as fail-safe requires.
            if (associated !== null) matrixDeniedToolUseIds.add(associated)
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

  // The stream is over, whatever ended it: a terminal result, a bare end, an operator's kill, or a
  // pause the loop kept reading past. Every `return` below this point is downstream of it, and
  // there is no `return` above it inside the loop -- so this runs exactly once per pump, on every
  // path, which is the whole point of it being here rather than on the conclusions.
  await writeStreamUsage({ runId, tally: skillCalls, spawn: input.spawn, outcome })

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
      lastToolUseId: lastToolUse?.id ?? null,
      lastToolName: lastToolUse?.name ?? null,
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
      data: {
        status: 'stopped',
        terminalAt: now,
        endedAt: now,
      },
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
      data: {
        status: 'failed',
        terminalAt: now,
        endedAt: now,
      },
    })
    if (concluded.count > 0) {
      // Names this writer, deliberately: `sweep.ts`'s timeout/tool-cap claim writes no terminal
      // status of its own (see the `stopClaimed` comment above) -- THIS branch is what concludes
      // a guardrail-cancelled run to `failed`, and it races that same sweep's own
      // `guardrail.tripped` append. Both are triggered by the same child dying, but through two
      // DIFFERENT, unordered listeners (`child.exit` drives the sweep's `cancel`; `child.stdout`'s
      // `close` drives this branch), so there is no guarantee the guardrail event has committed
      // by the time this write lands. Flake 2 (M17): an observer polling for `status === 'failed'`
      // alone can see it before the event that explains it exists. This line makes that ordering
      // legible in daemon output rather than a status flip with no visible cause yet.
      console.warn(
        `[pump] run ${runId} concluded 'failed': the output stream ended with no terminal result. ` +
          'If a guardrail sweep claimed this run into `stopping` moments earlier, its own ' +
          '`guardrail.tripped` append is a separate write racing this one and may still be in flight.',
      )
      await emit('run.failed', 'system', { reason })
    }
    return null
  }

  // A clean completion with denials is a failure. ADR 0001 measured a run reporting
  // `is_error: false` while landing nothing, detectable only through `permission_denials` -- so the
  // terminal flag alone is not what decides this.
  //
  // M18 Task 6 fix round 1 (review Critical 1): `outcome.deniedToolUseIds` is the CLI's own account
  // of every call it denied, a permission-matrix refusal included -- measured on both providers.
  // Claude's terminal `result` line lists a hook-denied id in `permission_denials` regardless of
  // WHY the hook denied it (`hook-deny.ndjson`'s pause deny is there too, alongside every
  // hook_crash/fail-open denial); Cursor's adapter pushes any rejected `call_id` into
  // `rejectedCallIds` -> `deniedToolUseIds` the same reason-blind way (`cursor/adapter.ts`'s
  // `observeRawLine`, which reads only `result.rejected`, never the reason inside it). Trusting this
  // field unfiltered would fail every matrix-denied run this very function just finished routing to
  // `run.tool_denied` -- undoing Task 6's own work at the one place that concludes the run.
  // `matrixDeniedToolUseIds` is exactly (and only) the ids this pump itself confirmed, via a FULL
  // parse of a matrix-prefixed reason, were a survivable refusal rather than a pause or an ordinary
  // permission-mode denial -- or that a prior pump on this run confirmed and recorded the same way,
  // read back on resume (see the resume seed at the Set's declaration) -- so excluding them here
  // still fails a genuine pause/permission-mode denial byte-identically to before this fix.
  const nonMatrixDeniedToolUseIds = outcome.deniedToolUseIds.filter((id) => !matrixDeniedToolUseIds.has(id))
  const failed = outcome.isError || nonMatrixDeniedToolUseIds.length > 0
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
    // Named from the FILTERED list, not `outcome.deniedToolUseIds` raw: a matrix-excused id
    // contributed nothing to `failed` above, and naming it here as if it had would misdescribe why
    // an `isError` run actually failed.
    const denied =
      nonMatrixDeniedToolUseIds.length > 0
        ? ` ${nonMatrixDeniedToolUseIds.length} tool call(s) were denied: ${nonMatrixDeniedToolUseIds.join(', ')}`
        : ''
    await emit('run.failed', 'system', { reason: `${outcome.terminalReason}.${denied}`.trim() })
  } else {
    await emit('run.succeeded', 'system', { numTurns: outcome.numTurns, costUsd: outcome.costUsd })
  }

  return outcome
}
