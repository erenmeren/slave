import type { BreakerLevel, BreakerTripKind } from '../breaker/detect.js'
import type { RankEvidence } from '../capability/rank.js'
import type { CapabilityRecord } from '../capability/taxonomy.js'
import type { PermissionKind } from '../permission/kinds.js'
import type { HandoffContract } from '../handoff/contract.js'
import type { SlaveLifecycle } from '../lifecycle/types.js'
import type { Runbook } from '../runbook/spec.js'
import type { FailureClass } from '../run/failure.js'
import type { RunStatus } from '../run/state.js'
import type { TaskStatus } from '../task/state.js'
import type { ActionKind, DecisionStatus, Tier } from './actions.js'
import { THREAD_MESSAGES_MAX } from './constants.js'
import type { SituationKind } from './situations.js'

/**
 * The task statuses the Supervisor reasons about -- the domain's own `TaskStatus`, aliased rather
 * than re-spelled: a second literal union would be a second thing to keep in step with
 * `packages/db`'s `TASK_STATUSES` and the `TaskStatus` Postgres enum.
 */
export type TaskStatusName = TaskStatus

/**
 * R2: the newest failure on a task -- what a stuck-task remedy is chosen FROM rather than guessed
 * at (Task 3). `at` is epoch ms, the world's own convention.
 *
 * H9 F10: the newest of TWO kinds of row, not one. A `run.failed` is a run that broke; a
 * `task.review_rejected` is a run that finished, passed verify and was judged wrong by a reviewer
 * ({@link rejectedByReview}). Reading `run.failed` alone, a task whose last attempt was rejected
 * for one named defect was diagnosed from an OLDER attempt's timeout -- offered the "went round in
 * circles" steer, and escalated with a story that was not the one that failed it.
 */
export interface TaskFailure {
  /** The kind of run the row names: for a rejection, the `review` run that judged the work. */
  readonly runKind: 'implementation' | 'review' | 'planning'
  /** The run's recorded reason -- for a rejection, the REVIEWER's reason, which is the steer. */
  readonly reason: string
  readonly at: number
  /**
   * H9 F10: this failure is a review REJECTING the work, not a run failing.
   *
   * LOADER CONTRACT: true exactly when the newest of the task's {`run.failed`,
   * `task.review_rejected`} events (by `seq`) is the rejection. `readFailure` reads it as
   * `rejected` before anything else: a reviewer's verdict on finished work is the newest fact, and
   * a refusal or a timeout on an earlier attempt is not why this one stopped.
   */
  readonly rejectedByReview: boolean
  /**
   * WHO ran it -- the `slaveId` of the run that failed, or null when the event did not record one
   * (fix round 1, Important 1).
   *
   * The whole reason it is here: a `retry_task` that bundles a permission grant has to name the
   * worker the grant is for, and there is nowhere else in the world to find it.
   * {@link SupervisorWorld.runs} holds only NON-TERMINAL runs, so a failed task has none there,
   * and {@link SupervisorWorld.denials} is loaded from those same live runs -- so a task whose
   * refused run has ended is in neither. The failure fact is per TASK, which is what makes the
   * pairing exact: this task's newest failure was this worker's run.
   *
   * LOADER CONTRACT: the `slaveId` of the `run.failed` event {@link reason} came from (Task 4).
   */
  readonly slaveId: string | null
  /**
   * H9b R1 (was H4b's `spawnFailed`): whose failure this was. `platform` -- a spawn that never
   * reached the model, a process that died with the daemon, a provider refusal, a timeout decided
   * after the host slept -- is a fact off the row, not a reading of {@link reason}: `readFailure`
   * returns `infrastructure` for it whatever the sentence says, so the remedy is the same run again
   * and never a judgement of work the worker was not allowed to finish.
   *
   * LOADER CONTRACT: `SlaveRun.failureClass` of the run the `run.failed` event names; null for a
   * row written before the column existed, which reads as `worker`.
   */
  readonly failureClass: FailureClass | null
}

/**
 * H9c: one failed run the circuit breaker COUNTED -- what a breaker escalation has to name so a
 * person is not sent to the run log to find out what "three consecutive failed runs" were.
 */
export interface BreakerFailure {
  readonly runId: string
  readonly runKind: 'implementation' | 'review' | 'planning'
  /** The task the run worked on; null for a planning run, which has none. */
  readonly taskTitle: string | null
  /** The newest `run.failed` reason the run recorded, or null when it recorded none. */
  readonly reason: string | null
  /** `SlaveRun.failureClass`; null for a row written before the column, which reads as `worker`. */
  readonly failureClass: FailureClass | null
}

/** A task, flattened to the facts a situation predicate actually reads. */
export interface SupervisorTask {
  readonly id: string
  readonly title: string
  readonly status: TaskStatusName
  readonly attempt: number
  readonly maxAttempts: number
  /**
   * The runtime role a slave must hold to be dispatched this task (M37 §5).
   *
   * LOADER CONTRACT: never null. `Task.requiredRole` is nullable in Prisma, and the scheduler's own
   * loader (`apps/orchestrator/src/world.ts`) DROPS a null-role task rather than inventing a role
   * for it; `loadSupervisorWorld` must do the same. The EMPTY STRING is a different, real value --
   * "any role will do", the case `SchedulableSlave.runtimeRoles` in `../scheduler/decide.ts`
   * reasons about -- and `observe` skips it for `ready_unstaffed` rather than reporting a situation
   * about a role nobody asked for.
   */
  readonly requiredRole: string
  /** Epoch ms of `Task.integratedAt`, or null while the branch has not reached the base branch. */
  readonly integratedAt: number | null
  /**
   * Epoch ms the task entered its current status, derived by the loader from the latest `task.*`
   * `ExecutionEvent` for the task, else `createdAt` (spec erratum E1 -- `Task` has no
   * `statusChangedAt` column and adding one would touch every status write). The domain only
   * READS it; nothing here knows how it was derived.
   */
  readonly statusSince: number
  /** How many other tasks depend on this one -- what makes a dead end everyone else's problem. */
  readonly dependents: number
  readonly dependenciesDone: boolean
  /** The guardrail of the newest `guardrail.tripped` for this task, if any. */
  readonly latestGuardrail: string | null
  /**
   * The goal version the plan that created this task derived from (M40 §1); NULL for a hand-made
   * task, which no plan produced and which therefore can never be "stale" against a goal it was
   * never derived from.
   *
   * Read by {@link summarise}'s `next.stale` count and by the `stale_task` proposals the
   * orchestrator records -- never by a predicate in `observe`, which must not guess that a task
   * behind the current goal version is unwanted (see `SITUATION_KINDS`' `stale_task`).
   */
  readonly goalVersion: number | null
  /**
   * The capabilities this work needs, in the taxonomy's vocabulary (M47 R2/R3) -- the STAFFING key,
   * as opposed to {@link requiredRole}, which stays the dispatch key and is derived from this list
   * when the planner did not name one.
   *
   * LOADER CONTRACT: `Task.requiredCapabilities` verbatim, keys and all -- including a key this
   * workspace's taxonomy no longer has. `observe` reads every one of them against
   * {@link SupervisorWorld.taxonomy} and a key that is not a row projects no role and staffs
   * nobody, which is exactly R1's rule ("nothing matches on a key that is not in the table") rather
   * than something a loader should silently filter.
   */
  readonly requiredCapabilities: readonly string[]
  /**
   * The worker this task is assigned to (M50 R3), or null when nobody on the project holds the role
   * it needs.
   *
   * LOADER CONTRACT: `Task.assigneeId` verbatim. Written since H2: planning names the holder of the
   * task's role when it creates the task, and `startRun` rewrites it to the seat the run went to, so
   * this is no longer null on every planned task. It is read by exactly one predicate,
   * `engagement_over`, which must not release the only worker holding an open task -- a clause H2
   * turned from a quiet one into a live one.
   */
  readonly assigneeId: string | null
  /** M48 R2: the runbook stage this task belongs to, or null for a task planned without one.
   *  A LABEL, never a scheduler input -- `decide()` has never seen it. */
  readonly stage: string | null
  /** M48 R6, plan erratum E6: the `escalation` sentence of {@link stage}, resolved by the loader
   *  through `Workspace.runbookId`, so `observe` can append it to a `task_failed` summary without
   *  knowing what a runbook is. */
  readonly stageEscalation: string | null
  /** R2: the newest failure among this task's runs -- a `run.failed` or (F10) a review's
   *  rejection -- or null for a task that has never failed. What a `task_failed`/`task_blocked_human` remedy is chosen from (Task 3's
   *  `retry_task`/`escalate_to_human` split) rather than guessed at. */
  readonly latestFailure: TaskFailure | null
  /** R2: the distinct `capability` values of `run.tool_denied` events across this task's runs --
   *  EMPTY unless something has actually been refused, the same reading {@link SupervisorDenial}
   *  gives the workspace as a whole. Read by Task 3's cause-remedy bundling: a kind in here that
   *  the task's `requiredPermissions` would have granted carries a `request_permission` alongside
   *  the retry. */
  readonly deniedKinds: readonly string[]
  /** R2: failed IMPLEMENTATION runs on this task -- a coarser count than {@link latestFailure},
   *  which is only the newest. Zero for a task that has never failed. */
  readonly failureCount: number
  /** R3: how many times `retry_task` has already been carried out on this task. A task retried
   *  twice this way is not retried a third time (Task 3): the candidate set becomes
   *  `escalate_to_human` only. `Task.retries` verbatim. */
  readonly retries: number
}

export interface SupervisorSlave {
  readonly id: string
  readonly name: string
  /** The profile's TITLE (M37) -- display only. Used by `candidates` for one thing: guessing
   *  which unstaffed worker is the likeliest holder of a missing role. */
  readonly role: string
  /** The roles this slave may be DISPATCHED as. Every staffing predicate reads this, never `role`. */
  readonly runtimeRoles: readonly string[]
  /**
   * What this worker PROVIDES (M47 R2), as opposed to {@link runtimeRoles}, which is what it may be
   * DISPATCHED as. The two are deliberately different facts: a capability is what the specialist
   * can do, a runtime role is a decision about the schedule -- and the gap between them is the
   * whole of the `assign_capability` offer, which gives a worker who already provides a capability
   * the runtime role it projects to.
   */
  readonly capabilities: readonly string[]
  readonly busy: boolean
  /** M50 R1: why this worker exists. A COLUMN -- `permanent` is a roster worker, `project` a
   *  project hire, `ephemeral` a specialist brought in for one assignment. */
  readonly lifecycle: SlaveLifecycle
  /** M50 R2: the ONE assignment an `ephemeral` worker was brought in for, null on everything else.
   *  Read by `engagement_over`, which measures the end of the engagement against that task's own
   *  status. */
  readonly engagementTaskId: string | null
  /** M50 R3: the engagement is over and the worker was released. A released worker holds no runtime
   *  roles -- which is what stops `decide()` picking it, one rule and no second filter -- and it is
   *  excluded from `formTeam`'s roster and from `staffableSlaves` so nothing proposes giving it
   *  roles back. */
  readonly released: boolean
  /**
   * M53 R10 (plan erratum E7): the operations this worker has been REFUSED -- the `deny` rows of
   * `SlavePermission` and only those.
   *
   * Not the allows, and not the unset kinds: `rankCandidates`' permission step asks one question,
   * "is a baseline grant this run kind needs denied to this candidate", and an allow is the answer
   * "no". EMPTY is the ordinary state and is loaded without a query when the project holds no
   * permission row at all.
   */
  readonly deniedKinds: readonly PermissionKind[]
  /** M58 R2: WHO sits in this seat. The identity every other surface joins on -- the name, the
   *  capabilities and the memory are the person's, and the seat is where they sit. */
  readonly personId: string
  /** M53 R1 (plan erratum E7): the catalog persona this person was hired from, or null for a
   *  hand-made one. Half of the PROFILE KEY -- `profileKeyOf` makes `template:<id>` from it and
   *  `slave:<id>` without it -- and the world carries the ingredient rather than the key so nothing
   *  in the domain has to agree on a string format twice. */
  readonly templateId: string | null
  /** M53 R9 (plan erratum E7): the model this worker would actually dispatch with, resolved by the
   *  loader through `Slave.model ?? Person.model ?? SlaveTemplate.defaultModel ?? null` (M58 R7).
   *  Resolved at the EDGE so the pure functions never have to -- a preference may name a model, and
   *  a candidate that cannot say which model it is on cannot be matched against one. */
  readonly model: string | null
}

/**
 * M58 R16: somebody who already works here and holds NO open seat on this project -- the second
 * place the Supervisor looks. Loaded only when the board actually asks for a capability.
 */
export interface SupervisorPoolPerson {
  readonly personId: string
  readonly name: string
  readonly capabilities: readonly string[]
  /** M53 R1 (plan erratum E7): the persona behind this person. NULL for somebody made from nothing
   *  (`Person.templateId` is nullable since M58 R1), in which case the profile key falls back to
   *  the person themself rather than to a template a preference could match. */
  readonly templateId: string | null
}

/**
 * A catalog template, with what it provides (R4) -- the third place. `recommended` is R5's advisory
 * tie-break: some worker already here has a profile that recommends pairing with it.
 */
export interface SupervisorCatalogEntry {
  readonly templateId: string
  readonly name: string
  readonly capabilities: readonly string[]
  readonly division: string | null
  readonly recommended: boolean
  /** M53 R9 (plan erratum E7): `SlaveTemplate.defaultModel` -- what a template candidate's `model`
   *  IS, since nobody has hired it and there is no worker row to resolve through. */
  readonly defaultModel: string | null
}

/**
 * One message of the question's thread, oldest first (M39 section 3).
 *
 * LOADER CONTRACT: `kind` is the THREE-way shape the Supervisor reasons about, not `MessageKind`
 * itself -- a `question` is what was asked, an `answer` is a reply, and everything else a workspace
 * can send (`information`, `blocker`, `handoff`) is a `note`: context worth quoting, but not part
 * of the ask-and-answer pair. `body` arrives already capped at {@link THREAD_BODY_MAX_CHARS}; the
 * prompt builder caps it again rather than trusting that, since the cap is what bounds the call.
 */
export interface ThreadMessage {
  readonly messageId: string
  readonly kind: 'question' | 'answer' | 'note'
  /** Null for a message the system itself wrote (a Supervisor answer, an operator's note). */
  readonly senderSlaveId: string | null
  readonly body: string
  readonly createdAt: number
}

/**
 * A question still waiting for an answer -- control's `stillPendingQuestion` semantics, resolved
 * by the loader; the domain never re-derives "is it answered".
 *
 * Everything below `createdAt` is what M39 added so the Supervisor can ANSWER rather than just
 * notice: the question itself, and the four sources an answer may be quoted from (the asking task,
 * the workspace goal on {@link SupervisorWorld}, the asker run's recorded context, and the thread).
 * `verifySources` reads exactly these fields -- a source the loader did not fill is a source no
 * answer can cite, which is why every one of them is explicitly nullable rather than defaulted.
 */
export interface SupervisorQuestion {
  readonly messageId: string
  readonly askerSlaveId: string
  readonly recipientRole: string | null
  readonly recipientSlaveId: string | null
  readonly createdAt: number
  /**
   * What was asked. The critical lexicon reads THIS, never the thread or the summary -- and reads
   * ALL of it.
   *
   * LOADER CONTRACT: uncapped, deliberately, unlike the same message's copy in {@link thread}. A
   * truncated body would let a question whose "api key" or "force-push" wording falls past the cap
   * slip the E2 short-circuit entirely. The cap that bounds a model call is applied where the call
   * is built (`buildAnswerPrompt`), which is the only place it means anything.
   */
  readonly body: string
  /** The task the asking run was working on, if it had one -- the `task` source's identity. */
  readonly taskId: string | null
  readonly taskTitle: string | null
  readonly taskDescription: string | null
  /** M48 R4: the asking task's typed handoff, when it has one. The Supervisor answers from the same
   *  row the worker reads, and everything shown here is QUOTABLE (plan erratum E8).
   *
   *  LOADER CONTRACT: `null` for a task with no contract AND for one whose stored contract will not
   *  parse -- a malformed handoff must not take the mailbox down. */
  readonly taskHandoff: HandoffContract | null
  /** The asker's run, whose recorded `RunContext.prompt` is the `run_context` source. */
  readonly senderRunId: string | null
  readonly threadId: string
  /**
   * The thread this question belongs to, oldest first, INCLUDING the question itself.
   *
   * LOADER CONTRACT: at most {@link THREAD_MESSAGES_MAX} messages -- the NEWEST that many by `seq`,
   * with the question kept whatever its age (erratum E9). {@link boundThread} is the rule, applied
   * by the loader and again where the prompt is built.
   */
  readonly thread: readonly ThreadMessage[]
  /** The asker run's recorded run context, capped at {@link RUN_PROMPT_MAX_CHARS} by the loader;
   *  null when the run recorded none (a pre-M37 run, or a run that never started). */
  readonly askerRunPrompt: string | null
  /**
   * The slave ids that may answer this question TODAY, resolved by the loader so the domain never
   * re-derives "who could take this" from the roster. A re-address is offered only to somebody on
   * this list, and `mayAnswer` (`./policy.js`) re-checks the same rule the loader applied.
   *
   * LOADER CONTRACT (M39 Task 3 implements it), and the two cases are NOT the same:
   * - **Role-addressed** (`recipientRole !== null`): every slave whose `runtimeRoles` include that
   *   role. Nobody else can be dispatched the question, so nobody else is a holder -- which is why
   *   an `unanswerable_question` about a role has an EMPTY list by construction (that is the
   *   predicate) and is fixed by a staffing proposal rather than a re-address.
   * - **Slave-addressed** (`recipientSlaveId !== null`): the addressed slave, PLUS every slave
   *   whose `runtimeRoles` include the asker task's `requiredRole`. A colleague who could be
   *   dispatched the asking task can answer a question about it, which is what makes re-addressing
   *   a question away from a busy or departed slave possible at all. A null or empty
   *   `requiredRole` adds nobody: there is no role to match on.
   *
   * The ASKER is never here (erratum E8), on either branch. It holds the asking task's role by
   * construction and would otherwise be counted among the workers who could answer -- making the
   * panel say "2 could answer it" about a question one worker can answer, and offering a
   * re-address the `reassign_not_permitted` rule refuses. Nobody answers their own question.
   *
   * A slave who has left the workspace is never here, so an id in this list is always in
   * `SupervisorWorld.slaves`.
   */
  readonly holders: readonly string[]
}

/** A recent `SupervisorDecision`, as much of it as {@link filterFresh} and {@link summarise} need. */
export interface SupervisorDecisionRecord {
  readonly situationKind: SituationKind
  readonly subjectId: string
  /**
   * WHAT was decided, as opposed to what it was decided ABOUT (M39 Task 1 review ruling).
   *
   * The situation alone cannot tell an answer the Supervisor drafted from a re-address or an
   * escalation on the very same question, and {@link summarise}'s mailbox counts are exactly that
   * distinction -- "the Supervisor answered eleven questions today" must not silently include the
   * ones it merely handed to somebody else.
   *
   * LOADER CONTRACT: the `kind` off the row's stored `action`. A row whose action names something
   * today's catalogue no longer has (an M38 `nudge_answer`, a hand-edited column) is reported as
   * `no_action` -- true of it in the only sense that still matters, and cheaper than crashing a
   * tick over history nobody can read any more.
   */
  readonly actionKind: ActionKind
  readonly status: DecisionStatus
  /** The tier the decision was recorded under -- what tells an escalation from a routine apply
   *  after the fact, since both can sit in `pending`. */
  readonly tier: Tier
  readonly createdAt: number
  /** Epoch ms a `pending` decision left that state; null for one still open AND for the
   *  `applied`/`failed` rows that were never pending -- see {@link filterFresh}'s cooldown anchor. */
  readonly resolvedAt: number | null
}

/**
 * One LIVE run, as the Supervisor sees it (M51 R3, plan erratum E9).
 *
 * Until this milestone the world held no runs at all: `SupervisorSlave.busy` was
 * `row.runs.length > 0` and was the only run-derived fact anywhere in it. `run_looping` is about a
 * run, so the run has to be in the world -- and the alternative, deriving it in `apps/orchestrator`
 * and passing a situation in, is exactly the shape `stale_task` is the one deliberate exception to.
 *
 * `trip`/`detail`/`count` are the newest `run.breaker` row's, loaded only when some run is at a
 * level above `none` (the loader pays for nothing a healthy board does not need). All three are
 * null together or non-null together; the predicate checks all three anyway, because a log the
 * loader could not read is a real state and a half-read trip is not a sentence.
 */
export interface SupervisorRun {
  readonly id: string
  readonly taskId: string | null
  readonly slaveId: string
  readonly status: RunStatus
  readonly toolCalls: number
  /** `SlaveRun.toolCallCap` -- null until a CONSTRAIN rung wrote one. */
  readonly toolCallCap: number | null
  readonly breakerLevel: BreakerLevel
  readonly breakerTrips: number
  readonly breakerSteers: number
  readonly trip: BreakerTripKind | null
  readonly detail: string | null
  readonly count: number | null
}

/**
 * One wall a worker keeps meeting (M52 R5, plan erratum E9).
 *
 * Loaded by `packages/control/src/supervisorWorld.ts` from ONE grouped read of `run.tool_denied`
 * over `PERMISSION_DENIAL_WINDOW_MS`, the way `loadLatestGuardrails` reads the newest guardrail per
 * task -- the world holds no events, and a predicate that counted them itself would be the
 * Supervisor reading the log.
 *
 * `kind` is a `PermissionKind` in every row the current gate writes, but is typed `string` because
 * the payload's own field is: a database holding pre-M52 rows carries `'run tests'`, and a denial
 * of `ungoverned_tool` carries a reason no grant can fix. `observe` filters both out.
 */
export interface SupervisorDenial {
  readonly slaveId: string
  readonly kind: string
  readonly count: number
  readonly latestRunId: string | null
}

/** M53 R9: one staffing decision a person took about this project, as the world sees it. The LABEL
 *  rides beside the key because the rationale sentence a decision row stores is read a year later
 *  (`docs/ia.md` rule 3), and `packages/domain` cannot resolve a label without the taxonomy table.
 *  `setBy` is a `User.id` and stays one -- every visible surface resolves it to a username at its
 *  own boundary (M52 erratum E18). */
export interface SupervisorStaffingPreference {
  readonly capability: string
  readonly capabilityLabel: string
  readonly templateId: string | null
  readonly model: string | null
  readonly setBy: string | null
}

/** M53 R3/R8: one profile's record, as the RANKER reads it. `RankEvidence` plus the key it is
 *  looked up by -- the world holds no `EvidenceRecord` rows, only the grouped counts, for the
 *  reason `staleMemoryCandidates` holds a count and not the memories (M49 plan erratum E11). */
export interface SupervisorProfileEvidence extends RankEvidence {
  readonly profileKey: string
}

/**
 * Everything the Supervisor is allowed to know about a workspace at one instant (M38 §3), built
 * by `packages/control/src/supervisorWorld.ts` from Prisma (spec E2) and handed to the pure
 * functions here. No Prisma types, no `Date` objects (epoch ms throughout, so a fixture is a
 * literal), no I/O.
 */
export interface SupervisorWorld {
  readonly workspaceId: string
  /**
   * R1: the one switch. `propose` is today's behaviour -- every situation's tier is the per-kind
   * rule below. `act` makes `tierOf` apply everything the escalate/noop/halted checks do not
   * already answer, whatever situation offered it and whatever the action itself is; a workspace
   * setting can only turn the Supervisor OFF (widen what a human must approve), never grant it
   * anything the rules below do not already allow under `propose`.
   */
  readonly autonomy: 'propose' | 'act'
  /** Epoch ms. Passed in, never read from the clock -- every staleness predicate is a function
   *  of this, which is what makes `observe` testable and a decision reproducible. */
  readonly now: number
  readonly goal: string | null
  /** `Workspace.goalVersion` (M40 §1): which `GoalVersion` the `goal` above IS. 0 means the goal
   *  was never set, which is also the only state in which it is null. */
  readonly goalVersion: number
  /** Non-null while the budget/failure guardrail has halted scheduling. */
  readonly halted: { readonly reason: string } | null
  /**
   * R4: epoch ms of `Workspace.haltClearedAt` -- when this workspace's halt was last retracted, by
   * an operator's `clear-halt` or by the Supervisor's own `clear_halt`. Null on a workspace whose
   * halt has never been cleared.
   *
   * Read by exactly one rule: the `clear_halt` candidate is not offered again inside
   * `HALT_CLEAR_INTERVAL_MS` of it. The world carries the STAMP rather than the answer
   * because `carryOut` re-checks the same window at apply time (a proposal can be approved an hour
   * after it was made) and the two must be reading one fact.
   */
  readonly haltClearedAt: number | null
  /**
   * H9c: the failed runs the circuit breaker counted, newest first -- what the `workspace_halted`
   * summary names, and what decides whether approving its escalation lifts the halt (F5b).
   *
   * LOADER CONTRACT: `breakerCountedFailures` (packages/control) -- the SAME streak
   * `stats.consecutiveFailures` counts -- and EMPTY unless {@link halted} is the derived
   * `circuit_breaker`.
   */
  readonly breakerFailures: readonly BreakerFailure[]
  readonly budgetExhausted: boolean
  /**
   * H4a: does this project have a runtime at all? EXACTLY ONE `ProviderConfiguration` row, which is
   * `workspaceDefaultProvider`'s own rule -- none and every model call in the project fails before
   * it is made, two and there is no resolvable default, and both read as `false` here.
   *
   * The fact the 2026-09-21 incident turned on: a project created with no runtime failed planning
   * twice in the same second, spent its retries and went silent. Nothing in the world said so.
   *
   * LOADER CONTRACT: `packages/control/src/supervisorWorld.ts` reads it through
   * `workspaceDefaultProvider` inside the world's own snapshot.
   */
  readonly runtimeConfigured: boolean
  /**
   * H4a: how many `planning` runs have FAILED since the latest `workspace.goal_set` or
   * `workspace.planning_reset` event, whichever is later -- the count `dispatchPlanning` stops at
   * {@link PLANNING_RETRY_CAP}, read by the one predicate that can say so out loud.
   *
   * The reset event is why "whichever is later": `retry_planning` writes one, and from that moment
   * the cap is counted from zero again -- otherwise the remedy would be spent the instant it was
   * applied.
   *
   * LOADER CONTRACT: 0 unless the board is behind the goal (see {@link livePlanning}). H4b: a run
   * that failed for the PLATFORM (`SlaveRun.failureClass`, H9b R1 -- a spawn that never reached the
   * model, a daemon crash, a provider refusal) is NOT counted -- that is infrastructure, not a
   * planner that cannot plan -- and the count is `planningCountSince`'s, the one reading
   * `dispatchPlanning` stops at too.
   */
  readonly planningFailuresSinceGoal: number
  /**
   * H4a: how many times the planning cap has already been given back for THIS goal version --
   * `workspace.planning_reset` events whose `version` is {@link goalVersion}.
   *
   * Read by `tierOf` and by `candidates`, which between them make the retry a once-per-version
   * move: the cap exists to stop a planner being asked forever, and a Supervisor that could reset
   * it on every cooldown would have removed the cap rather than answered it. The second reset for
   * one goal is a person's call.
   */
  readonly planningResetsThisVersion: number
  /**
   * H4a: is a `planning` run in flight right now? Planning that is RUNNING is not planning that
   * cannot start, whatever else is wrong, so this is the precondition on the whole situation.
   *
   * LOADER CONTRACT: a non-terminal `planning` run of this workspace. Deliberately one fact where
   * `dispatchPlanning` reads two -- it also holds an in-process registry of runs whose pump has not
   * finished concluding, which no loader can see. The window that leaves open is milliseconds wide
   * and closes by itself: the board stops being empty the moment the graph is written.
   */
  readonly livePlanning: boolean
  readonly tasks: readonly SupervisorTask[]
  readonly slaves: readonly SupervisorSlave[]
  /** PENDING questions only. */
  readonly questions: readonly SupervisorQuestion[]
  /** Recent decisions -- the window {@link filterFresh} needs to honour the cooldown and
   *  {@link summarise} counts. Not the whole history. */
  readonly decisions: readonly SupervisorDecisionRecord[]
  /**
   * The taxonomy this workspace's capabilities are read against (R1). Empty is a real state -- a
   * database whose taxonomy has never been synced -- and every capability rule is a no-op under it,
   * which is exactly right: nothing matches on a key that is not a row.
   */
  readonly taxonomy: readonly CapabilityRecord[]
  /** M58 R16: the people this project could be staffed from, minus whoever already holds an open
   *  seat on it (R4). EMPTY unless some task on the board actually asks for a capability -- the
   *  loader does not pay for a query nobody's plan needs. */
  readonly pool: readonly SupervisorPoolPerson[]
  /** The catalog templates that provide something, bounded by the loader (R4). Empty under the
   *  same condition as {@link pool}. */
  readonly catalog: readonly SupervisorCatalogEntry[]
  /** The runbook this workspace has adopted (R5), or null. Loaded whenever `Workspace.runbookId`
   *  is set -- the Overview, verify and the escalation sentence all read the same row. */
  readonly runbook: Runbook | null
  /** The runbooks this workspace COULD adopt (R5). EMPTY unless `runbook_recommended` could fire
   *  -- the loader does not pay for a table scan on a project that has already chosen. */
  readonly runbooks: readonly Runbook[]
  /**
   * How many OBSERVATION candidates in this workspace are older than
   * `MEMORY_CANDIDATE_STALE_MS` (M49 R2). A COUNT and never the memories themselves (plan erratum
   * E11): this world holds no unbounded list, the only predicate that reads it asks "how many",
   * and one `count` over the index costs a tick nothing and returns no rows.
   */
  readonly staleMemoryCandidates: number
  /** Non-terminal runs of this workspace (M51 R3). Bounded by the concurrency guardrail: a
   *  workspace may have `maxConcurrentRuns` of them, three by default. */
  readonly runs: readonly SupervisorRun[]
  /** M52 R5: how often each worker has been refused each operation lately. EMPTY unless some run
   *  has been denied in the window -- the loader does not pay for a grouped event scan on a project
   *  where nothing has been refused. */
  readonly denials: readonly SupervisorDenial[]
  /** M53 R9: what a person asked for, per capability. EMPTY unless some staffable task asks for a
   *  capability -- the same gate {@link pool} and {@link catalog} wait on. */
  readonly staffingPreferences: readonly SupervisorStaffingPreference[]
  /** M53 R3/R8: the record of every candidate profile -- seated, pooled and catalog --
   *  and of nobody else. EMPTY under the same gate, and bounded by the CANDIDATE SET rather than
   *  by a window: `WHERE profileKey = ANY(...)` is an index probe on
   *  `(profileKey, model, repositoryKey)` (plan erratum E8). */
  readonly evidence: readonly SupervisorProfileEvidence[]
}

/**
 * The last {@link THREAD_MESSAGES_MAX} messages of a thread, oldest first, with the QUESTION kept
 * however old it is (erratum E9).
 *
 * Nothing bounded a thread before this: a conversation two workers had been having for a week went
 * into the world entire and from there into an answer call, so the size of the prompt was whatever
 * they had typed at each other. The newest messages are the ones an answer is built from, which is
 * why the window is taken from the END.
 *
 * The question is the exception, and it is not cosmetic: `verifySources` refuses a citation of the
 * question by looking it up IN the thread, so a window that dropped it would quietly re-open the
 * hole erratum E4 closed. When it falls outside the window it takes the place of the oldest message
 * that would have been kept, so the length is still the cap and the order is still oldest-first.
 *
 * Applied by the loader (`packages/control/src/supervisorWorld.ts`) and AGAIN by
 * `buildAnswerPrompt`, for the same reason the body cap is applied twice: the cap that bounds a
 * model call belongs where the call is built, not upstream of it.
 */
export function boundThread(
  thread: readonly ThreadMessage[],
  questionMessageId: string,
): readonly ThreadMessage[] {
  if (thread.length <= THREAD_MESSAGES_MAX) return thread
  const kept = thread.slice(thread.length - THREAD_MESSAGES_MAX)
  if (kept.some((message) => message.messageId === questionMessageId)) return kept
  const question = thread.find((message) => message.messageId === questionMessageId)
  // A thread that does not contain its own question is a loader bug, not a state to repair here:
  // the window stands as it is, and `verifySources` rejects a citation of a question it cannot find
  // exactly as it rejects any other unknown ref.
  if (question === undefined) return kept
  return [question, ...kept.slice(1)]
}
