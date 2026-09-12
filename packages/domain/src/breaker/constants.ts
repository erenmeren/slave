import type { BreakerTrip, BreakerTripKind } from './detect.js'

/**
 * The behavioural breaker's numbers (M51 R1/R2/R3).
 *
 * DOMAIN CONSTANTS, NOT WORKSPACE SETTINGS -- the rule `../supervisor/constants.ts` opens with, and
 * M38 section 8's deliberate scope line. A per-workspace threshold turns one rule into as many rules
 * as there are projects, and the first support question about it is unanswerable.
 *
 * Every one of them is pinned by `test/breaker/constants.test.ts`, which is what stands between a
 * number and a silent edit.
 */

/**
 * How many of the run's most recent `run.tool_call` / `run.tool_result` / `run.output` rows the
 * detector reads. Sixty is roughly a quarter of the default 200-call ceiling -- long enough to hold
 * an eight-deep repeat with its results and some output around it, short enough that the read is
 * one indexed page rather than the run's whole history.
 */
export const BREAKER_WINDOW = 60

/**
 * The same `toolName:argsHash` key this many times in a row, with no intervening distinct key.
 *
 * Eight, not three: a worker reading eight files in a loop is working, and the key includes the
 * ARGUMENTS, so eight identical keys means eight byte-identical calls. Borrowed as a finding from a
 * harness that ran this arm at the same default in production.
 */
export const REPEAT_TRIP_COUNT = 8

/** This many consecutive `outcome: 'error'` results, whatever the tools were. */
export const ERROR_STORM_COUNT = 5

/**
 * How many CONSECUTIVE beats every progress clock must read false before `no_progress` trips.
 *
 * Two, because one is a pause. A single quiet beat is what a compile, a test run or a slow network
 * call looks like from outside; two in a row, with a finished tool call at the end of the window,
 * is a worker that has stopped.
 */
export const NO_PROGRESS_BEATS = 2

/**
 * The minimum gap between two breaker evaluations OF ONE RUN.
 *
 * The daemon ticks about once a second. Without this, a tripping run would climb steer -> constrain
 * -> stop in three seconds, which is not a ladder -- it is a kill with two extra events. One minute
 * gives a steered worker a real chance to read the sentence and change course before the next rung.
 */
export const BREAKER_BEAT_MS = 60_000

/**
 * `run_looping`'s own cooldown, replacing `COOLDOWN_MS` for that kind alone (M51 R3).
 *
 * The Supervisor's standing cooldown is fifteen minutes, which is right for "nobody can review" and
 * far too coarse for a loop that burns five dollars in three minutes. Two minutes is twice the beat,
 * so a run that keeps tripping gets one steer offered per two rungs at most.
 */
export const BREAKER_COOLDOWN_MS = 120_000

/**
 * What a CONSTRAIN rung leaves the run: its current `toolCalls` plus this many.
 *
 * A relative grace, never an absolute cap, because the run has already spent an unknown amount of
 * its budget and an absolute number would either refund a long run or kill a short one instantly.
 * Thirty calls is enough to write a report and stop, and not enough to start again.
 */
export const CONSTRAIN_GRACE_CALLS = 30

/**
 * How many SENTENCES one run may be sent, ever.
 *
 * De-escalation is what makes this cap necessary rather than decorative: a run that trips, is
 * steered, recovers for a beat and trips again is back at level `none` with a fresh rung available.
 * `SlaveRun.breakerSteers` does not reset on the way down, so the third trip skips the sentence it
 * has already been told twice and constrains instead.
 *
 * **A CONSTRAIN rung spends one too** (final wave, M3). `constrainRun` sends the same sentence
 * before it writes the cap -- spec R3: a constrained worker that was never told why would hit the
 * ceiling in silence -- and it sends it through `steerRun`, which increments the counter. So this
 * is a bound on what the run has been TOLD and not on how many times the STEER rung was climbed,
 * and a run that trips three times can legitimately reach `constrained` on the second. That is the
 * behaviour, said out loud here rather than left as an inference from two files: the worker really
 * has been interrupted twice, and a third interruption is the one this cap exists to refuse.
 */
export const STEERS_PER_RUN_MAX = 2

/**
 * The steer sentence, per trip kind (M51 R3).
 *
 * **System-authored, never a model's words.** This is the whole reason `steer_run` can be an
 * `applied` action at all: `../supervisor/policy.ts`'s rule is that anything putting a MODEL's text
 * in front of a running worker is a proposal, and these sentences are constants in a source file
 * that no model has ever seen. The only thing interpolated is an integer the detector counted.
 *
 * All three say the same three things, in the same order, because the worker is being interrupted
 * and the instruction has to survive being skim-read: what we observed, stop, and then either change
 * approach or say why you cannot. The third clause is what keeps a steer from being a dead end --
 * a worker that genuinely cannot proceed should say so and conclude, which is a `failed` run a
 * person can read rather than a run that loops until the ceiling.
 */
export const BREAKER_STEER_TEXT: Record<BreakerTripKind, (count: number) => string> = {
  repeated_call: (count) =>
    `You have made the same tool call ${String(count)} times with no new result. Stop, say in one ` +
    'paragraph what you are stuck on, and either change approach or report why you cannot.',
  error_storm: (count) =>
    `Your last ${String(count)} tool calls all failed. Stop, say in one paragraph what is failing ` +
    'and why, and either change approach or report why you cannot.',
  no_progress: (count) =>
    `Nothing has changed in your worktree, your tool calls or your output for ${String(count)} ` +
    'checks. Stop, say in one paragraph what you are stuck on, and either change approach or ' +
    'report why you cannot.',
}

/**
 * The sentence for one trip.
 *
 * `trip.detail` is deliberately NOT interpolated: it is a `toolName:argsHash` or an error class --
 * an identifier, not a sentence, and `docs/ia.md` rule 3 applies to a worker's prompt as much as to
 * a page. The detail is on the `run.breaker` event for a person to read.
 */
export function steerTextFor(trip: BreakerTrip): string {
  return BREAKER_STEER_TEXT[trip.kind](trip.count)
}
