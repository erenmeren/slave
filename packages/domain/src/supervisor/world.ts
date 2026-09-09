import type { TaskStatus } from '../task/state.js'
import type { DecisionStatus, Tier } from './actions.js'
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
}

export interface SupervisorSlave {
  readonly id: string
  readonly name: string
  /** The profile's TITLE (M37) -- display only. Used by `candidates` for one thing: guessing
   *  which unstaffed worker is the likeliest holder of a missing role. */
  readonly role: string
  /** The roles this slave may be DISPATCHED as. Every staffing predicate reads this, never `role`. */
  readonly runtimeRoles: readonly string[]
  readonly busy: boolean
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
  /** What was asked. The critical lexicon reads THIS, never the thread or the summary. */
  readonly body: string
  /** The task the asking run was working on, if it had one -- the `task` source's identity. */
  readonly taskId: string | null
  readonly taskTitle: string | null
  readonly taskDescription: string | null
  /** The asker's run, whose recorded `RunContext.prompt` is the `run_context` source. */
  readonly senderRunId: string | null
  readonly threadId: string
  /** The thread this question belongs to, oldest first, INCLUDING the question itself. */
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
   * A slave who has left the workspace is never here, so an id in this list is always in
   * `SupervisorWorld.slaves`.
   */
  readonly holders: readonly string[]
}

/** A recent `SupervisorDecision`, as much of it as {@link filterFresh} and {@link summarise} need. */
export interface SupervisorDecisionRecord {
  readonly situationKind: SituationKind
  readonly subjectId: string
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
}
