import type { BreakerLevel } from '../breaker/detect.js'
import type { RunStatus } from '../run/state.js'
import type { SlaveStatus } from '../slave/derived.js'
import type { TaskStatus } from '../task/state.js'

/**
 * The words this product says to a person about what is happening (M44 R4).
 *
 * A PROJECTION, never a replacement: `TaskStatus` (thirteen), `RunStatus` (nine) and
 * `SlaveStatus` (seven) stay exactly as they are, and every surface that renders one of these
 * words keeps the raw value beside it -- in `title`, in a `data-` attribute, or in the expanded
 * view. Backend state fidelity is never weakened for the UI (roadmap, "Rules that apply to every
 * milestone").
 *
 * PURE. No React, no Prisma, no `node:` import: `packages/domain` reaches `apps/web`'s CLIENT
 * bundle, and anything with a runtime dependency here fails `npm run web:build` (M42 erratum E13).
 * The tone and the pulse a pill is painted with are NOT here -- `StatusTone` is declared in
 * `apps/web/src/components/ui/StatusPill.tsx`, and the domain may not import an app (M44 erratum
 * E2). `apps/web/src/lib/tones.ts` keeps that half and reads every LABEL from this file, so the
 * word and the colour cannot drift apart.
 */
export interface UserStatus<S extends string> {
  readonly state: S
  readonly label: string
  /** Whether a person has to do something before this moves. See {@link needsYou}. */
  readonly needsYou: boolean
}

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

export type UserTaskState =
  | 'queued'
  | 'working'
  | 'verifying'
  | 'review'
  | 'merging'
  | 'waiting'
  | 'blocked'
  | 'done'
  | 'integrated'
  | 'failed'
  | 'cancelled'

/**
 * Every `TaskStatus` on exactly one user state. `Record<TaskStatus, UserTaskState>` is
 * load-bearing: a fourteenth status fails the BUILD here rather than becoming a task with no word.
 *
 * The four pre-run statuses collapse into one: a person does not need `backlog` from `ready` from
 * `rework` from `assigned` to know the work has not started. `verifying`, `reviewing` and
 * `merging` stay apart because they are the three different things that can be happening to
 * finished work, and each has a different answer to "what happens next".
 *
 * `done` is refined to `integrated` by {@link userTaskStatus} when the work is actually in the
 * base branch (`Task.integratedAt`); it cannot be decided from the status alone.
 */
export const USER_TASK_STATE_FOR_STATUS: Record<TaskStatus, UserTaskState> = {
  backlog: 'queued',
  ready: 'queued',
  rework: 'queued',
  assigned: 'queued',
  running: 'working',
  verifying: 'verifying',
  reviewing: 'review',
  merging: 'merging',
  waiting: 'waiting',
  blocked: 'blocked',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
}

export const USER_TASK_LABEL: Record<UserTaskState, string> = {
  queued: 'QUEUED',
  working: 'WORKING',
  verifying: 'VERIFYING',
  review: 'IN REVIEW',
  merging: 'MERGING',
  waiting: 'WAITING',
  blocked: 'BLOCKED',
  done: 'DONE',
  integrated: 'INTEGRATED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
}

/**
 * Everything the projection needs that a `TaskStatus` alone cannot say. Only `status` is required:
 * a caller who knows less still gets a correct answer, and every default is the one that does NOT
 * claim a person is needed.
 */
export interface UserTaskFacts {
  readonly status: TaskStatus
  /** `Task.integratedAt !== null`. Default `false`. */
  readonly integrated?: boolean
  /** `Workspace.autoMerge`. Default `true` -- an auto-merge project needs nobody to integrate. */
  readonly autoMerge?: boolean
  /**
   * Who can answer the question this task is waiting on: `'slave'` when a live worker holds it,
   * `'nobody'` for M39's unanswerable case, `null`/absent when the task waits on nothing.
   */
  readonly questionHolder?: 'slave' | 'nobody' | null
  /** A `SupervisorDecision` about this task is `pending` a human's approval. Default `false`. */
  readonly decisionPending?: boolean
}

/** The three statuses nothing a person does can move any further. */
const TERMINAL_TASK_STATES: readonly UserTaskState[] = ['failed', 'cancelled', 'integrated']

function taskStateOf(facts: UserTaskFacts): UserTaskState {
  const base = USER_TASK_STATE_FOR_STATUS[facts.status]
  return base === 'done' && facts.integrated === true ? 'integrated' : base
}

/**
 * Whether a person has to do something before this task moves (M44 R4).
 *
 * Four rules, and the reason for each:
 *   - `blocked` -- M35 gave that status the meaning "a human must look at this", and `unblock-task`
 *     is its only exit.
 *   - `waiting` with nobody holding the question -- M39's unanswerable case: the worker that was
 *     asked is gone, so the wait resolves only if a person answers it.
 *   - `done` and not integrated on a hand-merge project (`autoMerge === false`) -- the work is
 *     finished and sitting on a branch nothing will merge by itself. "Ready to integrate."
 *   - a pending Supervisor decision, in ANY non-terminal state -- `done` and `blocked` included,
 *     and whatever the project's merge policy says. The spec writes this clause under `waiting`;
 *     a proposal waiting for approval needs a person whatever the task is doing meanwhile, so it
 *     is widened here (M44 plan erratum E4). Only `failed`, `cancelled` and `integrated` are out.
 *
 * `failed` is deliberately NOT `needsYou`. The spec's list is closed, a FAILED task already reads
 * red on every surface, and whether an exhausted task joins a needs-you queue is M45's call.
 */
export function needsYou(facts: UserTaskFacts): boolean {
  const state = taskStateOf(facts)
  if (TERMINAL_TASK_STATES.includes(state)) return false
  // FIRST, and above every other clause: a pending decision needs a person in EVERY non-terminal
  // state, `done` included. Read last it was unreachable from `done` -- that branch returned
  // `autoMerge === false` and stopped, so a proposal waiting for approval on an auto-merge
  // project's finished-but-unintegrated task answered `false` (M44 final review, item I1).
  if (facts.decisionPending === true) return true
  if (state === 'blocked') return true
  if (state === 'done') return facts.autoMerge === false
  return state === 'waiting' && facts.questionHolder === 'nobody'
}

export function userTaskStatus(facts: UserTaskFacts): UserStatus<UserTaskState> {
  const state = taskStateOf(facts)
  return { state, label: USER_TASK_LABEL[state], needsYou: needsYou(facts) }
}

// ---------------------------------------------------------------------------------------------
// Runs and slaves
// ---------------------------------------------------------------------------------------------

/**
 * The card vocabulary a run or a worker reads as. Identical, member for member, to the display
 * vocabulary `apps/web/src/lib/tones.ts` has carried since M14 -- this milestone MOVES it into the
 * domain and leaves the tone table behind (erratum E2), so nothing a person sees changes.
 */
export type UserCardState =
  | 'working'
  | 'planning'
  | 'waiting'
  | 'review'
  | 'paused'
  | 'pause_requested'
  | 'resuming'
  | 'blocked'
  | 'cancelled'
  | 'idle'
  | 'completed'
  // M51 R7: a run the behavioural breaker has spoken to. Not a `RunStatus` -- the run is still
  // WORKING, and that is the point of the word: something is being done about it and nobody has to
  // press anything.
  | 'steered'
  | 'constrained'

export const USER_CARD_LABEL: Record<UserCardState, string> = {
  working: 'WORKING',
  planning: 'PLANNING',
  waiting: 'WAITING',
  review: 'REVIEW',
  paused: 'PAUSED',
  pause_requested: 'PAUSING',
  resuming: 'RESUMING',
  blocked: 'BLOCKED',
  cancelled: 'CANCELLED',
  idle: 'IDLE',
  completed: 'DONE',
  steered: 'STEERED',
  constrained: 'CONSTRAINED',
}

/**
 * Everything the run projection needs that a `RunStatus` alone cannot say (M51 R7).
 *
 * The {@link UserTaskFacts} shape, for its reason: a status is a projection over a column, and the
 * breaker's level is a second column. OPTIONAL as a whole and optional in every field, so the ~20
 * one-argument call sites that reach this through `apps/web/src/lib/tones.ts`'s `cardStateForRun`
 * keep reading exactly as they always did, and every default is the one that says nothing new.
 */
export interface UserCardFacts {
  readonly breakerLevel?: BreakerLevel
}

/** A run's own status. `null` means "no live run", which is `idle` -- the same statement
 *  `deriveSlaveStatus(null)` makes. A run never needs a person by itself: what needs a person is
 *  the TASK the run is on, and {@link needsYou} is where that is decided. */
export function userRunStatus(status: RunStatus | null, facts: UserCardFacts = {}): UserStatus<UserCardState> {
  const state = runCardState(status, facts)
  return { state, label: USER_CARD_LABEL[state], needsYou: false }
}

function runCardState(status: RunStatus | null, facts: UserCardFacts): UserCardState {
  if (status === null) return 'idle'
  // The breaker's word speaks ONLY over `working` (decision D6). A paused, pausing, resuming,
  // stopping or terminal run has a status somebody (or something) acted to produce, and overwriting
  // it with `CONSTRAINED` would describe a tool budget nobody is spending.
  if (status === 'working' && facts.breakerLevel !== undefined && facts.breakerLevel !== 'none') {
    return facts.breakerLevel
  }
  switch (status) {
    case 'starting':
      return 'planning'
    case 'working':
      return 'working'
    case 'pause_requested':
      return 'pause_requested'
    case 'paused':
      return 'paused'
    case 'resuming':
      return 'resuming'
    case 'stopping':
      return 'waiting'
    case 'stopped':
      return 'idle'
    case 'succeeded':
      return 'completed'
    case 'failed':
      return 'blocked'
  }
}

/**
 * `deriveSlaveStatus`'s output. Exhaustive over all seven members -- an eighth is a build error
 * here, not a silent fall-through to `idle` at render time.
 *
 * Takes the same optional {@link UserCardFacts} {@link userRunStatus} does, and applies decision D6
 * identically: the breaker's word speaks ONLY over `working`. Both arguments matter, because the
 * two web surfaces that show a WORKER's word (`SlaveCard`, `AllSlavesTable`) start from
 * `deriveSlaveStatus`'s output rather than from a `RunStatus` -- so without this the rule would
 * have to be restated in `apps/web`, where a later change to which states the breaker may speak
 * over would silently not be followed (fix round 1, review Important 3).
 */
export function userSlaveStatus(status: SlaveStatus, facts: UserCardFacts = {}): UserStatus<UserCardState> {
  const state = slaveCardState(status, facts)
  return { state, label: USER_CARD_LABEL[state], needsYou: false }
}

function slaveCardState(status: SlaveStatus, facts: UserCardFacts): UserCardState {
  // The same clause `runCardState` applies, for the same reason: every other word a card can say is
  // one somebody (or something) acted to produce, and overwriting a PAUSED with CONSTRAINED would
  // describe a tool budget nobody is spending.
  if (status === 'working' && facts.breakerLevel !== undefined && facts.breakerLevel !== 'none') {
    return facts.breakerLevel
  }
  switch (status) {
    case 'idle':
      return 'idle'
    case 'starting':
      return 'planning'
    case 'working':
      return 'working'
    case 'pausing':
      return 'pause_requested'
    case 'paused':
      return 'paused'
    case 'resuming':
      return 'resuming'
    case 'stopping':
      return 'waiting'
  }
}

// ---------------------------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------------------------

export type UserWorkspaceState = 'archived' | 'halted' | 'needs_you' | 'working' | 'idle'

export const USER_WORKSPACE_LABEL: Record<UserWorkspaceState, string> = {
  archived: 'ARCHIVED',
  halted: 'HALTED',
  needs_you: 'WAITING FOR YOU',
  working: 'WORKING',
  idle: 'IDLE',
}

export interface UserWorkspaceFacts {
  readonly archived: boolean
  readonly halted: boolean
  /** How many of this project's tasks {@link needsYou} is true for. */
  readonly needsYouCount: number
  readonly tasksActive: number
}

/**
 * One word for a whole project (M44 R4).
 *
 * The order is the order a person reads it in: an archived project is archived whatever else is
 * true of it; a halted one is halted; then "does this want me", then "is anything happening", then
 * nothing is. An archived project never says WAITING FOR YOU -- nothing in it is going to move,
 * and inviting somebody into it would be a lie.
 */
export function userWorkspaceStatus(facts: UserWorkspaceFacts): UserStatus<UserWorkspaceState> {
  const state: UserWorkspaceState = facts.archived
    ? 'archived'
    : facts.halted
      ? 'halted'
      : facts.needsYouCount > 0
        ? 'needs_you'
        : facts.tasksActive > 0
          ? 'working'
          : 'idle'
  return {
    state,
    label: USER_WORKSPACE_LABEL[state],
    needsYou: state === 'halted' || state === 'needs_you',
  }
}

// ---------------------------------------------------------------------------------------------
// The Supervisor
// ---------------------------------------------------------------------------------------------

export type UserSupervisorState =
  | 'halted'
  | 'off'
  | 'decisions'
  | 'answering'
  | 'working'
  | 'watching'
  | 'idle'

/**
 * The facts one word about the Supervisor is decided from (M45 R1).
 *
 * A FACT BAG, not a `SupervisorReport`. `report.supervisor.pending` counts only the decisions
 * inside `loadSupervisorWorld`'s `DECISION_WINDOW_MS` window, so a proposal older than that window
 * -- still open, still waiting on a person -- would not be counted, and the word would be wrong in
 * exactly the case it matters most (M45 plan erratum E3). `pendingDecisions` is the length of
 * `listDecisions(workspaceId, { pending: true })`, which has no window.
 *
 * `tasksActive` is the same widened list `server/overview.ts` counts (`ready`, `running`,
 * `verifying`, `reviewing`, `merging`, `rework`, `waiting`); `tasksOpen` is every non-terminal
 * task, which is what tells "watching a board that has work left" from "nothing to watch".
 */
export interface UserSupervisorFacts {
  readonly halted: boolean
  /** `Workspace.supervisorEnabled`. False means "it reports but decides nothing". */
  readonly enabled: boolean
  readonly pendingDecisions: number
  readonly pendingQuestions: number
  readonly tasksActive: number
  readonly tasksOpen: number
}

/** The six fixed words. `decisions` is absent because its label carries a count. */
export const USER_SUPERVISOR_LABEL: Record<Exclude<UserSupervisorState, 'decisions'>, string> = {
  halted: 'HALTED, NEEDS YOU',
  off: 'OFF',
  answering: 'ANSWERING',
  working: 'WORKING',
  watching: 'WATCHING',
  idle: 'IDLE',
}

/**
 * One word for what the Supervisor is doing (M45 R1).
 *
 * The order is the spec's precedence, and each step is a different question: is this project
 * stopped; is the Supervisor switched off; is it waiting on ME; is it waiting on an answer; is
 * anything running; is there anything left to watch. `watching` is the state the spec's own
 * precedence chain omitted (plan erratum E3) -- enabled, nothing active, a board that still has
 * work on it -- and it is the difference between a quiet project and a finished one.
 *
 * `needsYou` is true for exactly two of the seven: a halted project needs a person to release it,
 * and a pending decision needs a person to answer it. A switched-off Supervisor needs nothing:
 * somebody already decided that.
 */
export function userSupervisorStatus(facts: UserSupervisorFacts): UserStatus<UserSupervisorState> {
  const state: UserSupervisorState = facts.halted
    ? 'halted'
    : !facts.enabled
      ? 'off'
      : facts.pendingDecisions > 0
        ? 'decisions'
        : facts.pendingQuestions > 0
          ? 'answering'
          : facts.tasksActive > 0
            ? 'working'
            : facts.tasksOpen > 0
              ? 'watching'
              : 'idle'
  const label =
    state === 'decisions'
      ? `${String(facts.pendingDecisions)} DECISION${facts.pendingDecisions === 1 ? '' : 'S'} WAITING`
      : USER_SUPERVISOR_LABEL[state]
  return { state, label, needsYou: state === 'halted' || state === 'decisions' }
}
