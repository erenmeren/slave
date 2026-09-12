import { ERROR_STORM_COUNT, NO_PROGRESS_BEATS, REPEAT_TRIP_COUNT, STEERS_PER_RUN_MAX } from './constants.js'

/**
 * How loudly the breaker is currently speaking to one run (M51 R2).
 *
 * THREE members, and `stopped` is deliberately not one of them: a stopped run has a terminal
 * `RunStatus`, and a level that duplicated it would be a second place to ask whether a run is over.
 * The ladder's top rung is an ACT -- the sweep cancels the run and writes `guardrail.tripped` --
 * not a state the row sits in.
 */
export const BREAKER_LEVELS = ['none', 'steered', 'constrained'] as const

export type BreakerLevel = (typeof BREAKER_LEVELS)[number]

/** `docs/ia.md` rule 3. The run card's own word comes from `USER_CARD_LABEL`; this table is for
 *  anywhere a level is shown as itself (the drawer, the activity card's chip title). */
export const BREAKER_LEVEL_LABEL: Record<BreakerLevel, string> = {
  none: 'Healthy',
  steered: 'Steered',
  constrained: 'Constrained',
}

/** What the detector SAW. Three arms and no more -- each is a different kind of stuck. */
export const BREAKER_TRIP_KINDS = ['repeated_call', 'error_storm', 'no_progress'] as const

export type BreakerTripKind = (typeof BREAKER_TRIP_KINDS)[number]

export const BREAKER_TRIP_LABEL: Record<BreakerTripKind, string> = {
  repeated_call: 'Same call over and over',
  error_storm: 'Everything is failing',
  no_progress: 'Nothing is changing',
}

/**
 * One trip: which arm fired, the integer it fired on, and the one identifier a person would want.
 *
 * `count` exists because the steer sentence interpolates it and because the `run.breaker` event
 * should say eight rather than "several" (decision D4). `detail` is a `toolName:argsHash`, an error
 * class, or a beat count -- an identifier, never prose, and never the arguments themselves.
 */
export interface BreakerTrip {
  readonly kind: BreakerTripKind
  readonly count: number
  readonly detail: string
}

/**
 * One row of the run's persisted stream, flattened to what the detector reads.
 *
 * `key` is `toolName:argsHash` -- the ONLY thing the repeat arm compares, and the reason
 * `run.tool_call` gained two fields. The arguments are not here and are not anywhere: the event log
 * is not a transcript (`RunContext.prompt` remains the only place a prompt is stored).
 */
export type BreakerRow =
  | { readonly kind: 'call'; readonly seq: number; readonly toolUseId: string; readonly key: string }
  | {
      readonly kind: 'result'
      readonly seq: number
      readonly toolUseId: string
      readonly outcome: 'ok' | 'error'
      /**
       * `run.tool_result.errorClass` -- the normalised token (`api_error`, `timeout`, `not_found`,
       * `permission`, `other`), `null` on an `ok` result and on any error nothing classified.
       *
       * Carried into the window rather than flattened away because it is the ONLY thing an
       * `error_storm` trip can put in its `detail`: without it the event, the `run_looping` facts
       * and the drawer all read the bare word "error", which tells a person nothing they did not
       * already know from the trip's own kind.
       */
      readonly errorClass: string | null
    }
  | { readonly kind: 'output'; readonly seq: number }

/**
 * Everything {@link detectBehaviour} decides on -- and the whole of it.
 *
 * `rows` are the run's last `BREAKER_WINDOW` call/result/output rows, OLDEST FIRST (the order
 * `ExecutionEvent.seq` gives). `progress` is measured by the CALLER, because two of its three
 * clocks are not in the event log: `worktreeChanged` costs a subprocess and `distinctKey`/`output`
 * are windows over rows the caller already holds. Passing the triple in is what keeps this function
 * pure, clock-free and testable from three booleans.
 *
 * `quietBeats` is the caller's count of CONSECUTIVE beats whose progress triple was all-false,
 * NOT INCLUDING this one -- the debounce `no_progress` needs and a pure function cannot remember.
 */
export interface BreakerWindow {
  readonly level: BreakerLevel
  /** `SlaveRun.breakerTrips` -- every rung this run has ever climbed. Read for the event's own
   *  bookkeeping, never by a trip rule. */
  readonly trips: number
  /** `SlaveRun.breakerSteers`. Never reset by de-escalation, which is why the cap works. */
  readonly steers: number
  readonly quietBeats: number
  readonly rows: readonly BreakerRow[]
  /**
   * The three clocks, measured BY THE CALLER OVER THIS BEAT -- rows written since
   * `SlaveRun.breakerBeatAt`, never over the whole of {@link BreakerWindow.rows}.
   *
   * The scope is the contract, and it is beat-scoped for a reason the window-scoped reading gets
   * exactly backwards. A wedged run emits no new rows, so its sixty-row window FREEZES: if it holds
   * one older `run.output` row or one older distinct key -- which any run that did real work before
   * wedging does -- a window-scoped `distinctKey`/`output` would read true on every beat forever
   * and the second consecutive quiet beat would never arrive. The clocks would be brightest exactly
   * where the arm they feed is needed most.
   *
   * So the detector TRUSTS these three booleans as given and never re-derives them from `rows`;
   * `rows` exist for the two arms that genuinely need history (the trailing repeat run and the
   * trailing error run) and for the mid-call check. `breakerBeatAt` (erratum E5) is the boundary
   * that makes the beat-scoped reading computable, so this costs the sweep a `ts >` filter over
   * rows it already holds, not a column.
   */
  readonly progress: {
    /** A tool call SINCE THE LAST BEAT whose key differs from the trailing one. */
    readonly distinctKey: boolean
    /** `git status --porcelain` + `rev-parse HEAD`, hashed, differs from the previous beat's.
     *  FALSE means "measured, and nothing moved"; the caller passes TRUE when it could not measure,
     *  because no evidence must never be evidence of a loop. */
    readonly worktreeChanged: boolean
    /** A `run.output` row arrived SINCE THE LAST BEAT. */
    readonly output: boolean
  }
}

/**
 * What the breaker wants to happen next.
 *
 * `level` is the level the run should be AT after this beat -- one rung up on an escalation, one
 * rung down on a healthy beat, or the pseudo-level `'stop'`, which is not a `BreakerLevel` because
 * it is not a state: it is the sweep's instruction to cancel the run (decision D5).
 *
 * `trip` is non-null exactly when this verdict is an ESCALATION. A de-escalation and a steady
 * healthy beat both carry null, which is what lets the caller write "if the trip is null, write the
 * level and nothing else".
 */
export interface BreakerVerdict {
  readonly level: BreakerLevel | 'stop'
  readonly trip: BreakerTrip | null
  /**
   * All three clocks read false on THIS beat, and the beat was not suppressed.
   *
   * The sweep increments `SlaveRun.breakerQuietBeats` on `true` and RESETS it to zero on `false`
   * with `suppressed` also false. It is returned rather than left for the caller to re-derive
   * because the conjunction that owns the column must have exactly one definition: two copies drift,
   * and the copy that drifts is the one deciding whether a twenty-minute build's beats were quiet --
   * which, counted wrongly, fires `no_progress` on the first beat AFTER the build finishes, with a
   * large `count`, on a run that was never stuck.
   */
  readonly quiet: boolean
  /**
   * A tool call was in flight when this beat ran, so every arm was suppressed.
   *
   * Neither quiet nor progress: the sweep leaves `breakerQuietBeats` exactly as it found it. A long
   * build must not accumulate quiet beats, and it must not throw away the ones a genuinely wedged
   * run had already accumulated before it made its last call either.
   */
  readonly suppressed: boolean
}

/**
 * Is this run going in circles (M51 R1)? Pure, total, and with no clock of its own.
 *
 * ## The suppression that comes first
 *
 * The NEWEST `call` row having no `result` row for its `toolUseId` means a tool is running right
 * now, and every arm is suppressed while one is. This is the quiet-long-build rule and it is the
 * reason the milestone persists tool results at all: a twenty-minute `npm run build` produces no
 * new tool calls, no output and no worktree change, and is indistinguishable from a wedged worker
 * by every signal EXCEPT the fact that its last call has not come back. Checked before anything
 * else so no arm can reach past it -- and scoped to the newest call alone, because an orphan from
 * earlier in the run would otherwise silence the breaker permanently ({@link isMidCall}).
 *
 * Such a beat is reported `suppressed`, which is neither quiet nor progress: the sweep leaves
 * `breakerQuietBeats` exactly as it found it, and the verdict's own `level` is the STORED one,
 * unchanged -- a beat that measured nothing proposes no rung, up or down (final wave, M1).
 *
 * ## The three arms, in the order they are consulted
 *
 * 1. **repeated_call** -- the TRAILING run of identical `toolName:argsHash` keys is at least
 *    {@link REPEAT_TRIP_COUNT} long. Trailing, not "anywhere in the window": eight repeats followed
 *    by a different call is a worker that already moved on.
 * 2. **error_storm** -- the trailing run of `outcome: 'error'` results is at least
 *    {@link ERROR_STORM_COUNT} long. Its `detail` is the `errorClass` most of that run carried.
 * 3. **no_progress** -- all three of the CALLER's beat-scoped clocks read false AND this makes
 *    {@link NO_PROGRESS_BEATS} consecutive quiet beats. The clocks are trusted exactly as passed
 *    and never re-derived from `rows` -- see {@link BreakerWindow.progress} for why that scope is
 *    the difference between an arm that fires on a wedged run and one that never fires at all.
 *
 * One beat names ONE trip, in that order, because one rung gets one event and an event with two
 * reasons is an event a person has to choose between.
 *
 * ## The ladder
 *
 * A trip asks for ONE rung above the stored level -- never two, and the top rung is `'stop'`. A
 * run that has used its {@link STEERS_PER_RUN_MAX} steers skips the steer rung, because it has
 * already been told the sentence twice. No trip steps the stored level DOWN one rung and carries no
 * trip, so a run that recovers is not left constrained for the rest of its life.
 */
export function detectBehaviour(window: BreakerWindow): BreakerVerdict {
  const suppressed = isMidCall(window.rows)
  // The stored level, UNCHANGED -- never `deEscalate` (final wave, M1). A suppressed beat measured
  // nothing, and the rung it leaves behind has to be the one it found: the sweep's own
  // `!verdict.suppressed` guard already refused to write a de-escalated level here, so the contract
  // held by the caller's grace rather than at the source that states it. Saying it here is what
  // makes a second caller safe.
  if (suppressed) return { level: window.level, trip: null, quiet: false, suppressed: true }
  const quiet = !window.progress.distinctKey && !window.progress.worktreeChanged && !window.progress.output
  const trip = tripOf(window, quiet)
  if (trip === null) return { level: deEscalate(window.level), trip: null, quiet, suppressed: false }
  return { level: escalate(window.level, window.steers), trip, quiet, suppressed: false }
}

/**
 * Is a tool running RIGHT NOW -- that is, does the NEWEST `call` row in the window have no `result`
 * row carrying its `toolUseId`?
 *
 * The newest call and no other, which is the whole of the rule. Asking instead whether ANY call in
 * the window is unanswered reads well and is wrong in a way that gets worse with time: an orphaned
 * call cannot age out of a window that has stopped growing, so one call that never reported would
 * suppress every arm for the rest of the run. And orphans are not hypothetical -- a pause SIGTERMs
 * the child mid-work (`apps/orchestrator/src/pump.ts`, "cursor has no mid-run gate"), and M51's own
 * steer rung pauses and resumes the run, so the first steer could make the constrain and stop rungs
 * unreachable.
 *
 * A result is matched by `toolUseId` wherever it sits in the window, not only after its call: the
 * ids are unique, so position adds nothing but a way to be wrong about a window that starts
 * mid-turn.
 */
function isMidCall(rows: readonly BreakerRow[]): boolean {
  let newestCall: string | null = null
  for (const row of rows) if (row.kind === 'call') newestCall = row.toolUseId
  if (newestCall === null) return false
  for (const row of rows) if (row.kind === 'result' && row.toolUseId === newestCall) return false
  return true
}

function tripOf(window: BreakerWindow, quiet: boolean): BreakerTrip | null {
  const calls = window.rows.filter((row): row is Extract<BreakerRow, { kind: 'call' }> => row.kind === 'call')
  const lastKey = calls.at(-1)?.key
  if (lastKey !== undefined) {
    let repeats = 0
    for (let i = calls.length - 1; i >= 0 && calls[i]?.key === lastKey; i -= 1) repeats += 1
    if (repeats >= REPEAT_TRIP_COUNT) return { kind: 'repeated_call', count: repeats, detail: lastKey }
  }

  const results = window.rows.filter((row): row is Extract<BreakerRow, { kind: 'result' }> => row.kind === 'result')
  let errors = 0
  for (let i = results.length - 1; i >= 0 && results[i]?.outcome === 'error'; i -= 1) errors += 1
  if (errors >= ERROR_STORM_COUNT) {
    return { kind: 'error_storm', count: errors, detail: commonestClass(results.slice(results.length - errors)) }
  }

  // `+ 1` is THIS beat: `quietBeats` is what the caller counted BEFORE it, so two consecutive quiet
  // beats is one stored beat plus this one. `quiet` is the caller's triple as
  // {@link detectBehaviour} read it, and it is false on a suppressed beat, so this arm can only
  // fire on a beat that really was silent.
  if (quiet && window.quietBeats + 1 >= NO_PROGRESS_BEATS) {
    const beats = window.quietBeats + 1
    return { kind: 'no_progress', count: beats, detail: `${String(beats)} quiet beats` }
  }
  return null
}

/**
 * What the trailing error run was mostly ABOUT: the `errorClass` most of its results carried.
 *
 * Most frequent rather than most recent, and ties go to the one that appeared first, so the answer
 * is deterministic and says what the storm IS rather than what its last gasp happened to be. A run
 * whose results all classified themselves `null` -- a provider that reports no class, or a
 * pre-M51 row -- falls back to the bare word, which is still true.
 */
function commonestClass(run: readonly Extract<BreakerRow, { kind: 'result' }>[]): string {
  const counts = new Map<string, number>()
  for (const row of run) {
    if (row.errorClass === null) continue
    counts.set(row.errorClass, (counts.get(row.errorClass) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [errorClass, count] of counts) {
    if (count > bestCount) {
      best = errorClass
      bestCount = count
    }
  }
  return best ?? 'error'
}

function escalate(level: BreakerLevel, steers: number): BreakerLevel | 'stop' {
  if (level === 'constrained') return 'stop'
  if (level === 'steered') return 'constrained'
  // The skip: a run that has had its steers is not told the sentence a third time.
  return steers >= STEERS_PER_RUN_MAX ? 'constrained' : 'steered'
}

function deEscalate(level: BreakerLevel): BreakerLevel {
  if (level === 'constrained') return 'steered'
  return 'none'
}
