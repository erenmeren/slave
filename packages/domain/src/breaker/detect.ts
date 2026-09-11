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
  readonly progress: {
    /** A tool call in this window whose key differs from the trailing one. */
    readonly distinctKey: boolean
    /** `git status --porcelain` + `rev-parse HEAD`, hashed, differs from the previous beat's.
     *  FALSE means "measured, and nothing moved"; the caller passes TRUE when it could not measure,
     *  because no evidence must never be evidence of a loop. */
    readonly worktreeChanged: boolean
    /** A `run.output` row arrived in this window. */
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
}

const HEALTHY: BreakerVerdict = { level: 'none', trip: null }

/**
 * Is this run going in circles (M51 R1)? Pure, total, and with no clock of its own.
 *
 * ## The suppression that comes first
 *
 * A trailing `call` row whose `toolUseId` has no `result` row means a tool is STILL RUNNING, and
 * every arm is suppressed while it is. This is the quiet-long-build rule and it is the reason the
 * milestone persists tool results at all: a twenty-minute `npm run build` produces no new tool
 * calls, no output and no worktree change, and is indistinguishable from a wedged worker by every
 * signal EXCEPT the fact that its last call has not come back. Checked before anything else so no
 * arm can reach past it.
 *
 * ## The three arms, in the order they are consulted
 *
 * 1. **repeated_call** -- the TRAILING run of identical `toolName:argsHash` keys is at least
 *    {@link REPEAT_TRIP_COUNT} long. Trailing, not "anywhere in the window": eight repeats followed
 *    by a different call is a worker that already moved on.
 * 2. **error_storm** -- the trailing run of `outcome: 'error'` results is at least
 *    {@link ERROR_STORM_COUNT} long.
 * 3. **no_progress** -- all three clocks read false AND this makes {@link NO_PROGRESS_BEATS}
 *    consecutive quiet beats.
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
  if (hasRunningCall(window.rows)) return deEscalate(window.level)
  const trip = tripOf(window)
  if (trip === null) return deEscalate(window.level)
  return { level: escalate(window.level, window.steers), trip }
}

/** A `call` with no `result` carrying the same `toolUseId` anywhere after it. Scanned over the
 *  whole window rather than the last row alone: a worker may issue several calls in one turn, and
 *  any one of them still outstanding means a tool is running. */
function hasRunningCall(rows: readonly BreakerRow[]): boolean {
  const answered = new Set<string>()
  for (const row of rows) if (row.kind === 'result') answered.add(row.toolUseId)
  for (const row of rows) if (row.kind === 'call' && !answered.has(row.toolUseId)) return true
  return false
}

function tripOf(window: BreakerWindow): BreakerTrip | null {
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
  if (errors >= ERROR_STORM_COUNT) return { kind: 'error_storm', count: errors, detail: 'error' }

  const quiet = !window.progress.distinctKey && !window.progress.worktreeChanged && !window.progress.output
  // `+ 1` is THIS beat: `quietBeats` is what the caller counted BEFORE it, so two consecutive quiet
  // beats is one stored beat plus this one.
  if (quiet && window.quietBeats + 1 >= NO_PROGRESS_BEATS) {
    const beats = window.quietBeats + 1
    return { kind: 'no_progress', count: beats, detail: `${String(beats)} quiet beats` }
  }
  return null
}

function escalate(level: BreakerLevel, steers: number): BreakerLevel | 'stop' {
  if (level === 'constrained') return 'stop'
  if (level === 'steered') return 'constrained'
  // The skip: a run that has had its steers is not told the sentence a third time.
  return steers >= STEERS_PER_RUN_MAX ? 'constrained' : 'steered'
}

function deEscalate(level: BreakerLevel): BreakerVerdict {
  if (level === 'constrained') return { level: 'steered', trip: null }
  if (level === 'steered') return HEALTHY
  return HEALTHY
}
