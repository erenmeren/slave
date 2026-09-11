/**
 * Every guardrail this codebase can trip, as data (M51 R4).
 *
 * Until this milestone `GuardrailBreach.guardrail` was a bare `string` and sixteen spellings lived
 * as literals across nine production files -- `evaluate.ts` (six), `apps/orchestrator/src/sweep.ts`
 * (`run_timeout`, `tool_call_ceiling`), `pump.ts` (`pause_gate`, `permission_mode`), `planning.ts`
 * (`no_planner`), `review.ts` (`no_reviewer`, `review_retry_cap_exhausted`), `merge.ts`
 * (`merge_failure`), `tick.ts` (`budget_warning`), `packages/control/src/emergency.ts`
 * (`emergency_stop`) and `scripts/gate-m38-supervisor.mjs` (`verify_could_not_run`,
 * `verify_failed`). One typo among them produced a breach nobody could filter for and nobody could
 * label, and `REVIEW_CAP_GUARDRAIL` (`../supervisor/constants.ts`) was the only one of the sixteen
 * that had ever been given a name.
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
] as const

export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number]

/**
 * What each guardrail is called when a person reads it (`docs/ia.md` rule 3).
 *
 * `Record<GuardrailKind, string>` is load-bearing: an eighteenth kind fails the build here rather
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
}
