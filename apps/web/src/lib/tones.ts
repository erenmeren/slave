import { USER_CARD_LABEL, userRunStatus, userSlaveStatus, userTaskStatus, type UserCardState } from '@slave-of-ai/domain'
import type { SlaveStatus, RunStatus, TaskStatus } from '@slave-of-ai/domain'
import type { StatusTone } from '../components/ui/StatusPill'
import { COLUMN_FOR_STATUS, COLUMN_STATE } from './taskColumns'

/**
 * The ten card states, now owned by `packages/domain/src/status/user.ts` (M44 R4). This file keeps
 * the half the domain cannot have: which TONE a state is painted in and whether its dot breathes.
 * `StatusTone` is a `components/ui/StatusPill` type and `packages/domain` may not import an app
 * (M44 erratum E2), so the split runs exactly there -- and every LABEL below is read out of
 * `USER_CARD_LABEL` rather than restated, so the word and the colour cannot drift.
 */
export type CardState = UserCardState

export interface ToneSpec {
  readonly tone: StatusTone
  readonly label: string
  /**
   * Whether the pill's dot breathes. NOT derivable from `tone` alone, which is the whole reason
   * this field exists: `pause_requested` and `waiting` share the amber `waiting` tone, and only
   * the first pulses; `resuming` and `working` share teal, and both do.
   */
  readonly pulse: boolean
}

const TONE_AND_PULSE: Record<CardState, { readonly tone: StatusTone; readonly pulse: boolean }> = {
  working: { tone: 'working', pulse: true },
  planning: { tone: 'planning', pulse: true },
  waiting: { tone: 'waiting', pulse: false },
  review: { tone: 'review', pulse: true },
  paused: { tone: 'paused', pulse: false },
  pause_requested: { tone: 'waiting', pulse: true },
  resuming: { tone: 'working', pulse: true },
  blocked: { tone: 'blocked', pulse: false },
  // M40 §6: a cancelled task is not a broken one. It rides the muted `idle` grey rather than
  // `blocked`'s red, because red is the colour of something that needs an operator and a task
  // somebody took off the board needs nothing at all.
  cancelled: { tone: 'idle', pulse: false },
  idle: { tone: 'idle', pulse: false },
  completed: { tone: 'done', pulse: false },
}

export const CARD_STATE_TONE: Record<CardState, ToneSpec> = Object.fromEntries(
  (Object.keys(TONE_AND_PULSE) as CardState[]).map((state) => [
    state,
    { ...TONE_AND_PULSE[state], label: USER_CARD_LABEL[state] },
  ]),
) as Record<CardState, ToneSpec>

/** A run's own status. `null` means "no live run", which is `idle`. Thin adapter over the domain's
 *  `userRunStatus` -- kept so the ~20 existing call sites read the same as they always did. */
export function cardStateForRun(status: RunStatus | null): CardState {
  return userRunStatus(status).state
}

/** `deriveSlaveStatus`'s output, through the domain. */
export function cardStateForSlave(status: SlaveStatus): CardState {
  return userSlaveStatus(status).state
}

/**
 * `deriveSlaveStatus`'s seven members, as a value (M44 R5). Exported because the Slaves table has
 * to narrow a bare `string` for its LABEL exactly as `toneForStatus` narrows it for its TONE, and
 * two copies of this literal is precisely how the word and the colour drift apart again.
 */
export const KNOWN_SLAVE_STATUSES = ['idle', 'starting', 'working', 'pausing', 'paused', 'resuming', 'stopping'] as const

/**
 * The tone for a worker row's `StatusPill`, from the SAME derivation its label comes from (M44
 * erratum E18). Moved here from `components/SlavesClient.tsx`, whose `SLAVE_STATUS_TONE` was a
 * second status->tone table living beside `CARD_STATE_TONE` -- exactly the drift this file exists
 * to end. `AllSlaveRow` types `status` as a bare `string` (`server/org.ts`) even though it is
 * always `deriveSlaveStatus`'s output, so anything outside the vocabulary falls back to `idle`
 * rather than throwing at render time.
 */
export function toneForStatus(status: string): StatusTone {
  const known = KNOWN_SLAVE_STATUSES.find((member) => member === status)
  return CARD_STATE_TONE[known === undefined ? 'idle' : cardStateForSlave(known)].tone
}

/**
 * The full card state: the slave's own status, with three task facts layered over it.
 *
 * `blocked`, `review` and `completed` are unreachable from `SlaveStatus` alone -- a slave whose
 * task is blocked is simply `idle`, and `idle` is what the card would say without this. The three
 * overrides are exactly the states the handoff's card set has and the slave vocabulary does not.
 */
export function cardStateFor(slave: SlaveStatus, task: TaskStatus | null): CardState {
  if (task === null) return cardStateForSlave(slave)
  switch (task) {
    case 'blocked':
      return 'blocked'
    // M36 t2: the slave's own run IS paused, but nobody asked it to pause -- it is waiting for
    // another slave's answer, and PAUSED would invite an operator to resume something that is
    // resolving itself.
    case 'waiting':
      return 'waiting'
    case 'reviewing':
    case 'merging':
      return 'review'
    case 'failed':
      return 'blocked'
    case 'cancelled':
      return 'cancelled'
    case 'done':
      // Only when nobody is still working on it: a `done` task whose slave is mid-run means the
      // slave has moved on and the snapshot has not caught up, and the SLAVE is what this card
      // is about.
      return slave === 'idle' ? 'completed' : cardStateForSlave(slave)
    case 'backlog':
    case 'ready':
    case 'assigned':
    case 'running':
    case 'verifying':
    case 'rework':
      return cardStateForSlave(slave)
    default: {
      // The `capabilitiesOf` idiom (`packages/providers/src/capabilities.ts:29-38`). `tsconfig.base`
      // sets `strict` but not `noImplicitReturns`, so a fourteenth `TaskStatus` added later would
      // otherwise fall out of this switch with no compile error, silently landing on whatever
      // `cardStateForSlave(slave)` returns -- exactly the "a status silently defaults" failure this
      // file exists to rule out. Binding `task` to `never` makes that a BUILD failure naming the
      // unhandled member.
      const unhandled: never = task
      throw new Error(`cardStateFor: unhandled TaskStatus ${JSON.stringify(unhandled)}`)
    }
  }
}

/**
 * A TASK's own card state, with no slave in play (M14 fix wave, review I2).
 *
 * `COLUMN_STATE[COLUMN_FOR_STATUS[status]]` -- the state of the board column the task sits in,
 * which is the one thing a task card, a dependency node and an execution node all already agree
 * on. Every task-only surface used to call `cardStateFor('idle', status)`, borrowing the SLAVE
 * derivation and passing a fake idle slave; for `running`, `assigned`, `verifying`, `ready` and
 * `backlog` that fell through to `cardStateForSlave('idle')` and painted a grey **IDLE** pill on a
 * card sitting under the teal **IN PROGRESS** column head. One card, two answers.
 *
 * `failed` and `cancelled` are two of the exceptions, and they are deliberate: `COLUMN_FOR_STATUS`
 * puts both on the `Done` column (a column is a phase, and both of those end one), but neither is a
 * completed task -- `failed` keeps the `blocked` state `cardStateFor` gives it, and `cancelled`
 * takes the muted state of its own (M40 §6), so the card says what happened while the board still
 * files it where it belongs.
 *
 * `cardStateFor(slave, task)` stays the SLAVE-first derivation: `SlaveCard` is about a slave that
 * happens to hold a task, and this function is about a task that may have no slave at all. The two
 * agree on `cancelled` (M40 §6, fix round 1): a slave holding a cancelled task must not read
 * BLOCKED on its card while the same task reads CANCELLED on the board.
 */
export function cardStateForTask(status: TaskStatus): CardState {
  switch (status) {
    case 'failed':
      return 'blocked'
    // M40 §6, the fourth exception: `cancelled` sits on the Done column (a column is a phase, and
    // this ends one) and used to share `failed`'s BLOCKED red. A task a human or a re-plan took off
    // the board is not a failure and needs nobody, so it gets the muted `cancelled` state instead.
    case 'cancelled':
      return 'cancelled'
    // M36 t2, the third exception to "a task reads as its column": `waiting` sits on the In
    // Progress column because the work is in flight, but the card must not say WORKING -- nothing
    // is being worked on while the slave waits for an answer. `waiting` is the handoff's own amber,
    // un-pulsed state for exactly this.
    case 'waiting':
      return 'waiting'
    case 'backlog':
    case 'ready':
    case 'rework':
    case 'assigned':
    case 'running':
    case 'verifying':
    case 'reviewing':
    case 'merging':
    case 'blocked':
    case 'done':
      return COLUMN_STATE[COLUMN_FOR_STATUS[status]]
    default: {
      // The same `never` guard `cardStateFor` carries, for the same reason: `noImplicitReturns` is
      // off, so a fourteenth `TaskStatus` would otherwise fall out of this switch as `undefined`
      // and render an empty pill. This makes it a BUILD failure naming the unhandled member.
      const unhandled: never = status
      throw new Error(`cardStateForTask: unhandled TaskStatus ${JSON.stringify(unhandled)}`)
    }
  }
}

/**
 * The WORD a task's pill reads, from the domain (M44 erratum E3's deferred half, delivered here).
 *
 * M44 kept the board's pill on `cardStateForTask`'s column vocabulary and said so; M45 R4 is where
 * that changes. The TONE still comes from the column state -- that is the board's own grouping,
 * with its four documented exceptions, and it decides which colour a card is, not what it says.
 * The word comes from `userTaskStatus`, which is the one vocabulary `docs/ia.md` rule 3 names, so
 * a `failed` task reads FAILED under a red pill instead of borrowing `blocked`'s word for its
 * colour's sake. The raw status stays on the card's `data-status`, where it always was.
 */
export function taskStatusWord(status: TaskStatus, integrated: boolean): string {
  return userTaskStatus({ status, integrated }).label
}

/**
 * The single source for `TaskCard.tsx`'s four `TASK_STATUS_*` tables (M19 C7). A status's tone is
 * always its card state's own tone -- `cardStateForTask` into `CARD_STATE_TONE`, the same two
 * calls a `TaskCard` render makes for its pill. `TaskCard.tsx` builds each of its four
 * `Record<TaskStatus, string>` exports by looping every `TaskStatus` through this into one of
 * `StatusPill`'s own `TONE_*` tables, rather than hand-maintaining a second `TaskStatus`-keyed
 * mapping that can drift from this one (the defect M16 Task 8 fix round 1 partially caught: only
 * `reviewing`'s `TASK_STATUS_TEXT` entry got fixed, not the mapping itself).
 */
export function toneForTaskStatus(status: TaskStatus): StatusTone {
  return CARD_STATE_TONE[cardStateForTask(status)].tone
}
