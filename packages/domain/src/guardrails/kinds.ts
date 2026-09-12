/**
 * Every guardrail this codebase can trip, as data (M51 R4).
 *
 * Until this milestone `GuardrailBreach.guardrail` was a bare `string` and seventeen spellings
 * lived as literals across ten production files -- `evaluate.ts` (six),
 * `apps/orchestrator/src/sweep.ts` (`run_timeout`, `tool_call_ceiling`), `pump.ts` (`pause_gate`,
 * `permission_mode`), `planning.ts` (`no_planner`), `review.ts` (`no_reviewer`,
 * `review_retry_cap_exhausted`), `merge.ts` (`merge_failure`), `tick.ts` (`budget_warning`),
 * `verify.ts` (`verify_could_not_run`, `verify_not_configured`) and
 * `packages/control/src/emergency.ts` (`emergency_stop`), with `verify_failed` spelled only in
 * `scripts/gate-m38-supervisor.mjs`. One typo among them produced a breach nobody could filter for
 * and nobody could label, and `REVIEW_CAP_GUARDRAIL` (`../supervisor/constants.ts`) was the only
 * one of them that had ever been given a name.
 *
 * The first cut of this list was written from an inventory that MISSED `verify_not_configured`
 * (final wave, I1/E21): a live spelling outside the list is one the activity card prints raw and
 * `gate:m44`'s derived blocklist cannot see, because the blocklist is derived from this list. The
 * remedy that makes the omission impossible to repeat is not vigilance but `satisfies
 * GuardrailKind` at every `guardrail.tripped` payload site, which is now there -- see the note
 * below about typing WRITERS rather than the log.
 *
 * The order is the one a reader meets them in: the workspace-wide stops first, then the two
 * breakers, then the per-run ceilings, then the gate and the staffing holes, then verify.
 *
 * THE LIST TYPES PRODUCERS, NOT THE LOG. `guardrail.tripped`'s payload stays `z.string()`
 * deliberately (R4): `packages/events/src/read.ts:23-26` THROWS on a row the domain cannot parse,
 * so a `z.enum` here would make the entire forward read of any database holding a spelling this
 * list forgot unreadable -- the whole activity stream down, for a name. A closed union types the
 * WRITERS, where a mistake is a build error; the log stays forgiving.
 */
export const GUARDRAIL_KINDS = [
  'emergency_stop',
  'concurrency',
  'global_concurrency',
  'budget_exhausted',
  'budget_warning',
  /** The FAILURE-STREAK breaker (M12): `consecutiveFailures >= consecutiveFailureLimit`, per
   *  workspace. Nothing behavioural -- it counts terminal `failed` runs in a row. */
  'circuit_breaker',
  /** M51 R3: the BEHAVIOURAL breaker's top rung -- this one run is going in circles and the
   *  backend stopped it. Its stop becomes a `failed` run, so it then counts toward
   *  `circuit_breaker` above, which is how the two compose. */
  'behavioural_loop',
  'run_timeout',
  'tool_call_ceiling',
  'pause_gate',
  'permission_mode',
  'no_planner',
  'no_reviewer',
  'review_retry_cap_exhausted',
  'merge_failure',
  'verify_could_not_run',
  'verify_failed',
  /** The eighteenth (final wave, I1): `apps/orchestrator/src/verify.ts` writes it when the
   *  WORKSPACE configured no verify commands at all -- a halt that affects every task here, not
   *  this run's environment, which is what `verify_could_not_run` above means. Last in the list
   *  because it was added last; the order is the one a reader met them in. */
  'verify_not_configured',
] as const

export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number]

/**
 * What each guardrail is called when a person reads it (`docs/ia.md` rule 3).
 *
 * `Record<GuardrailKind, string>` is load-bearing: a nineteenth kind fails the build here rather
 * than turning up on the activity feed as an identifier. Every label is a SENTENCE FRAGMENT about
 * what happened, not a restatement of the key -- the breach's own `detail` carries the numbers.
 */
export const GUARDRAIL_LABEL: Record<GuardrailKind, string> = {
  emergency_stop: 'Emergency stop',
  concurrency: 'Too many runs at once',
  global_concurrency: 'Too many runs everywhere',
  budget_exhausted: 'Budget spent',
  budget_warning: 'Budget nearly spent',
  circuit_breaker: 'Too many failed runs',
  behavioural_loop: 'Going in circles',
  run_timeout: 'Run took too long',
  tool_call_ceiling: 'Too many tool calls',
  pause_gate: 'Pause gate broken',
  permission_mode: 'Permission mode wrong',
  no_planner: 'Nobody can plan',
  no_reviewer: 'Nobody can review',
  review_retry_cap_exhausted: 'Review attempts used up',
  merge_failure: 'Merge failed',
  verify_could_not_run: 'Verify could not run',
  verify_failed: 'Verify failed',
  verify_not_configured: 'Verify not configured',
}
