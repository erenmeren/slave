import { BREAKER_COOLDOWN_MS } from '../breaker/constants.js'
import type { SituationKind } from './situations.js'

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

/**
 * Situations whose cooldown is NOT {@link COOLDOWN_MS} (M51 R3).
 *
 * Fifteen minutes is the right silence for "nobody can review this project" and the wrong silence
 * for a run burning five dollars in three minutes. A table rather than a branch inside
 * `filterFresh`, so the exception is data a reader can enumerate and a seventeenth kind inherits the
 * default by saying nothing.
 */
export const COOLDOWN_BY_KIND: Partial<Record<SituationKind, number>> = {
  run_looping: BREAKER_COOLDOWN_MS,
}

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

/**
 * The longest answer body a Supervisor model call may hand back, and therefore the longest text
 * that can ever reach the world through `answerQuestion` (M39 section 1). Four thousand characters
 * is a long answer to a colleague's question and a short essay -- past it the model has stopped
 * answering and started writing the task.
 */
export const ANSWER_MAX_CHARS = 4_000

/** How much of one thread message the answer prompt quotes. The thread is context, not the
 *  question: ten messages at this cap still leave the question itself the biggest thing in view. */
export const THREAD_BODY_MAX_CHARS = 2_000

/**
 * How many thread messages a question carries into the world, and therefore into the answer call
 * (erratum E9). Forty: nothing bounded the thread before this, and a conversation that had run for
 * a week was a `findMany` with no `take` on the tick's hot path and, past that, a prompt whose size
 * was whatever the workers had typed at each other.
 *
 * The NEWEST forty, by `seq` -- a question is answered from what was said most recently, not from
 * how the thread opened -- and always with the QUESTION itself among them however old it is, since
 * `verifySources` needs it present to refuse a citation of it (E4/E8).
 */
export const THREAD_MESSAGES_MAX = 40

/** How much of the asker run's recorded `RunContext.prompt` the answer prompt quotes. A run
 *  context is the largest single source and the one most likely to hold the answer, so it gets the
 *  most room -- but a bounded amount, so a huge repository brief cannot blow the call's budget. */
export const RUN_PROMPT_MAX_CHARS = 16_000

/** The longest quote a model may cite from a source. A citation is evidence, not a copy: three
 *  hundred characters is a sentence or two, which is what `verifySources` can meaningfully check. */
export const SOURCE_QUOTE_MAX_CHARS = 300

/** The most sources one answer may cite. An answer that needs nine quotes is not sourced, it is
 *  assembled -- and every extra citation is another verbatim check a human has to read back. */
export const SOURCES_MAX = 8

/**
 * How long a RESOLVED `SupervisorDecision` that cost nothing is kept before `pruneDecisions`
 * deletes it (M39 section 2). Thirty days: long enough that a month's worth of "why did the
 * Supervisor do that" is answerable from the rows themselves, short enough that a busy workspace's
 * decision table does not grow without limit.
 *
 * Two kinds of row this age never reaches (erratum E7). Pending rows are never pruned, however old
 * -- an unanswered proposal is not history. And a row with `modelCalled` is never pruned either,
 * whatever its status: `workspaceSpend` sums those rows over ALL time, so deleting one would erase
 * money that was really spent and let a budget halt lift itself after a month.
 */
export const DECISION_RETENTION_MS = 30 * 86_400_000

/** The most rows one prune pass deletes. The pass runs on every supervised tick, so a backlog
 *  drains over several ticks rather than one tick holding a long delete transaction open. */
export const PRUNE_BATCH = 500

/** How long an OBSERVATION candidate may sit unverified before it is clutter rather than a
 *  pending judgement (M49 R2). Twenty-four hours: a task verified the same day answers its own
 *  candidate, and one that never verifies has told us something else. */
export const MEMORY_CANDIDATE_STALE_MS = 24 * 3_600_000

/** How many stale candidates make a situation. Below five it is one task nobody finished; at five
 *  it is a habit, and the Supervisor may say so. */
export const STALE_CANDIDATES_MIN = 5

/**
 * How many times the Supervisor retries ONE task before it stops trying (R3, spec §3's last row).
 *
 * Two, because the two retries are different attempts at different things: the first carries the
 * remedy the diagnosis named (a grant, a steer, the same run again), and the second is the one
 * that says whether the remedy worked. A third would be the same remedy a third time -- "remedies
 * are not working" is itself the finding, and the candidate set becomes `escalate_to_human` alone
 * with the last failure in the summary.
 *
 * Counted on `Task.retries`, which `retryTask` increments -- NOT on `Task.attempt`, which is the
 * work's own attempt counter and is reset by the retry.
 */
export const RETRIES_MAX = 2

/**
 * How much of a failure reason a situation's summary and a remedy's own reason may carry.
 *
 * A `run.failed` reason is whatever the run wrote -- a sentence, or a stderr dump with a stack in
 * it -- and both places this bounds are read by a person and sent to a model: the summary goes
 * into the decision prompt and onto the stored row, and the reason rides on the action. Three
 * hundred characters is {@link SOURCE_QUOTE_MAX_CHARS}' own bound, for the same reason: it is
 * enough to say what broke and not enough to be a log.
 */
export const FAILURE_REASON_MAX_CHARS = 300

/**
 * A failure reason, bounded and ellipsised, for the places a person and a model read one: a
 * situation's summary, a situation's facts and a remedy's own reason (R3).
 *
 * Beside the constant rather than in `observe.ts`, where it was first written (fix round 1): both
 * `observe` and `candidates` bound a reason, `candidates` already imports `observe`, and a
 * function the two share belongs in the file neither of them is.
 */
export function boundReason(reason: string): string {
  const trimmed = reason.trim()
  if (trimmed.length <= FAILURE_REASON_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, FAILURE_REASON_MAX_CHARS)}\u2026`
}

/**
 * How long the Supervisor waits before it may clear the same workspace's halt again (R4).
 *
 * One hour, and it is a bound on SPEND rather than on noise: clearing a breaker halt lets the
 * project start runs again, so a Supervisor that cleared every halt the moment it saw one would
 * turn the breaker into a speed bump. `Workspace.haltClearedAt` is the stamp -- the same column
 * `clearHalt` writes, so an operator's own clear starts the hour too -- and the rule is enforced
 * TWICE: the candidate is not offered inside the window (this file's own rule, `candidates.ts`),
 * and `carryOut` refuses it inside the window as well (Task 4), because a decision can be approved
 * by a person an hour after it was proposed.
 */
export const HALT_CLEAR_INTERVAL_MS = 3_600_000

/**
 * How much text one of the two OPERATOR-REQUEST actions may carry (Supervisor chat R3).
 *
 * Both are strings a model wrote from what a person typed, and both outlive the turn: a
 * `request_goal_change.request` becomes a goal-change request a person reads and approves, and a
 * `note_for_planner.text` is COMMITTED to `docs/inbox/NOTES.md` for the next planner to read. Two
 * thousand characters is {@link RATIONALE_MAX_CHARS}' own bound -- a paragraph or three, enough to
 * say what is wanted and not enough to be a document -- and it is applied where the action is
 * VALIDATED as well as where it is built, the `steer_run.text` precedent: a stored row is read
 * back, printed and acted on, so the bound belongs on the boundary too.
 */
export const OPERATOR_REQUEST_MAX_CHARS = 2000

/**
 * THE ALLOW-LIST for what a person may attach to a message (Supervisor chat R6), and the kind each
 * extension gets in the prompt.
 *
 * `text` is inlined under its own path (up to `CHAT_ATTACHMENT_CHARS`); `image` is named by path
 * and size and may be OPENED by a read-only turn (R7); `binary` is named and read later by a
 * worker whose provider can read it. An extension that is not a key here cannot be attached -- an
 * allow-list, never a deny-list, because the question is what this system can honestly do
 * something with rather than what somebody thought to forbid.
 *
 * In the DOMAIN rather than beside `storeSupervisorUploads`, which is the only writer: the
 * refusal vocabulary prints the list of what CAN be attached (a person told ".exe is not allowed"
 * has to guess what is), and `packages/control/src/refusal.ts` must stay free of the Prisma and
 * `node:fs` imports the upload verb carries.
 *
 * Typed against `ChatAttachment['kind']` through {@link AttachmentKind} rather than by importing
 * `chatPrompt.ts`, which imports this file: one union, spelt where nothing else depends on it.
 */
export type AttachmentKind = 'text' | 'image' | 'binary'

export const ATTACHMENT_KIND_BY_EXTENSION: Readonly<Record<string, AttachmentKind>> = {
  md: 'text',
  txt: 'text',
  csv: 'text',
  json: 'text',
  yaml: 'text',
  yml: 'text',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  pdf: 'binary',
}
