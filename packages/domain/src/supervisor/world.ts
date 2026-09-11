import type { CapabilityRecord } from '../capability/taxonomy.js'
import type { HandoffContract } from '../handoff/contract.js'
import type { SlaveLifecycle } from '../lifecycle/types.js'
import type { Runbook } from '../runbook/spec.js'
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
   * The worker a task is HAND-assigned to (M50 R3), or null.
   *
   * LOADER CONTRACT: `Task.assigneeId` verbatim. Nothing in the pipeline writes this column -- a run
   * is linked to its worker through `SlaveRun.slaveId` -- so it is null on every task this product
   * plans. It is read by exactly one predicate, `engagement_over`, which must not release the only
   * worker holding a hand-assigned task.
   */
  readonly assigneeId: string | null
  /** M48 R2: the runbook stage this task belongs to, or null for a task planned without one.
   *  A LABEL, never a scheduler input -- `decide()` has never seen it. */
  readonly stage: string | null
  /** M48 R6, plan erratum E6: the `escalation` sentence of {@link stage}, resolved by the loader
   *  through `Workspace.runbookId`, so `observe` can append it to a `task_failed` summary without
   *  knowing what a runbook is. */
  readonly stageEscalation: string | null
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
}

/**
 * A company roster worker who is NOT already on this project (R4) -- the second place the
 * Supervisor looks. Loaded only when the board actually asks for a capability.
 */
export interface SupervisorCompanyWorker {
  readonly companySlaveId: string
  readonly name: string
  readonly capabilities: readonly string[]
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
 * Everything the Supervisor is allowed to know about a workspace at one instant (M38 §3), built
 * by `packages/control/src/supervisorWorld.ts` from Prisma (spec E2) and handed to the pure
 * functions here. No Prisma types, no `Date` objects (epoch ms throughout, so a fixture is a
 * literal), no I/O.
 */
export interface SupervisorWorld {
  readonly workspaceId: string
  /** Epoch ms. Passed in, never read from the clock -- every staleness predicate is a function
   *  of this, which is what makes `observe` testable and a decision reproducible. */
  readonly now: number
  readonly goal: string | null
  /** `Workspace.goalVersion` (M40 §1): which `GoalVersion` the `goal` above IS. 0 means the goal
   *  was never set, which is also the only state in which it is null. */
  readonly goalVersion: number
  /** Non-null while the budget/failure guardrail has halted scheduling. */
  readonly halted: { readonly reason: string } | null
  readonly budgetExhausted: boolean
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
  /** The company roster this project could be staffed from, minus whoever is already on it (R4).
   *  EMPTY unless some task on the board actually asks for a capability -- the loader does not pay
   *  for a roster query nobody's plan needs. */
  readonly company: readonly SupervisorCompanyWorker[]
  /** The catalog templates that provide something, bounded by the loader (R4). Empty under the
   *  same condition as {@link company}. */
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
