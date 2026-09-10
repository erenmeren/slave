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
}

/** A run's own status. `null` means "no live run", which is `idle` -- the same statement
 *  `deriveSlaveStatus(null)` makes. A run never needs a person by itself: what needs a person is
 *  the TASK the run is on, and {@link needsYou} is where that is decided. */
export function userRunStatus(status: RunStatus | null): UserStatus<UserCardState> {
  const state = runCardState(status)
  return { state, label: USER_CARD_LABEL[state], needsYou: false }
}

function runCardState(status: RunStatus | null): UserCardState {
  if (status === null) return 'idle'
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

/** `deriveSlaveStatus`'s output. Exhaustive over all seven members -- an eighth is a build error
 *  here, not a silent fall-through to `idle` at render time. */
export function userSlaveStatus(status: SlaveStatus): UserStatus<UserCardState> {
  const state = slaveCardState(status)
  return { state, label: USER_CARD_LABEL[state], needsYou: false }
}

function slaveCardState(status: SlaveStatus): UserCardState {
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
