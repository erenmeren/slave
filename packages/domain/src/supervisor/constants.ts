/**
 * The Supervisor's thresholds and caps (M38 §2, plan Global Constraints). Domain constants, not
 * workspace settings: M38 §8 puts "thresholds as workspace settings" out of scope deliberately --
 * every one of these numbers is a judgement about when a situation stops being normal, and a
 * per-workspace dial would make "why did the Supervisor not act" a two-place question before
 * anyone has ever needed a second answer.
 */

/** A question older than this, whose recipient exists, is stale (`waiting_stale`). 30 minutes. */
export const WAITING_STALE_MS = 30 * 60_000

/** A `done` task unmerged for longer than this, with dependents, is stale. 6 hours. */
export const INTEGRATED_STALE_MS = 6 * 3_600_000

/**
 * How long a situation key stays quiet after a decision about it stopped being open. 15 minutes:
 * long enough that a tick loop cannot re-decide the same stuck thing on every pass, short enough
 * that a decision which did not work is retried within the same working hour.
 */
export const COOLDOWN_MS = 15 * 60_000

/** How long a `pending` proposal waits for a human before `expirePendingDecisions` retires it. */
export const PENDING_TTL_MS = 24 * 3_600_000

/**
 * The most model-decided situations one tick may pay for. The rest are not dropped -- they simply
 * wait for the next tick, which is what keeps a workspace that is stuck in ten ways from spending
 * ten model calls a minute on it.
 */
export const SUPERVISOR_MAX_MODEL_DECISIONS_PER_TICK = 3

/** Per-call spend ceiling for a Supervisor model call; an unmeasured call is charged at this. */
export const SUPERVISOR_PER_CALL_CAP_USD = 1

/**
 * The model a Supervisor decision is asked of (spec E3), overridable by
 * `SLAVEOFAI_SUPERVISOR_MODEL` where the decider is wired (the orchestrator -- the domain never
 * reads `process.env`). M31a took its model from the simulation intent, so there was no existing
 * default to reuse.
 */
export const SUPERVISOR_DEFAULT_MODEL = 'claude-sonnet-5'

/**
 * The runtime role `dispatchReview` staffs from (`apps/orchestrator/src/review.ts`) -- `'reviewer'
 * ∈ runtimeRoles`, never `Slave.role`, which since M37 is the profile's title. Named here because
 * `observe` decides "nobody can review" on exactly this string.
 */
export const REVIEWER_ROLE = 'reviewer'

/** The runtime role `runPlanningPass` staffs from (`apps/orchestrator/src/planning.ts`). */
export const MANAGER_ROLE = 'manager'

/**
 * The guardrail `dispatchReview` writes when a task has exhausted its review retries. It is what
 * separates `review_cap_blocked` (a park the Supervisor knows the exit from) from
 * `task_blocked_human` (a park it does not).
 */
export const REVIEW_CAP_GUARDRAIL = 'review_retry_cap_exhausted'
