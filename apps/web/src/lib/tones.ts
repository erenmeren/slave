import type { SlaveStatus, RunStatus, TaskStatus } from '@slave-of-ai/domain'
import type { StatusTone } from '../components/ui/StatusPill'
import { COLUMN_FOR_STATUS, COLUMN_STATE } from './taskColumns'

/**
 * The handoff's ten card states (`design_handoff_ai_team_os/mockups/Slave of AI Mockups.dc.html`
 * lines 912-923, `Component.meta`). This is a DISPLAY vocabulary, not a domain one: the domain
 * has `RunStatus` (nine), `SlaveStatus` (seven) and `TaskStatus` (thirteen), and none of them is
 * this list. The three derivations below are the only sanctioned way into it -- a page that
 * hand-maps a status to a tone is the defect Decision 2 forbids.
 */
export type CardState =
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

export const CARD_STATE_TONE: Record<CardState, ToneSpec> = {
  working: { tone: 'working', label: 'WORKING', pulse: true },
  planning: { tone: 'planning', label: 'PLANNING', pulse: true },
  waiting: { tone: 'waiting', label: 'WAITING', pulse: false },
  review: { tone: 'review', label: 'REVIEW', pulse: true },
  paused: { tone: 'paused', label: 'PAUSED', pulse: false },
  pause_requested: { tone: 'waiting', label: 'PAUSING', pulse: true },
  resuming: { tone: 'working', label: 'RESUMING', pulse: true },
  blocked: { tone: 'blocked', label: 'BLOCKED', pulse: false },
  // M40 §6: a cancelled task is not a broken one. It rides the muted `idle` grey rather than
  // `blocked`'s red, because red is the colour of something that needs an operator and a task
  // somebody took off the board needs nothing at all. Its own CARD STATE rather than a second
  // `idle` spelling, so the pill still says what happened; no new `StatusTone`, because the tone
  // set is the handoff's palette and this is a new state in it, not a new colour.
  cancelled: { tone: 'idle', label: 'CANCELLED', pulse: false },
  idle: { tone: 'idle', label: 'IDLE', pulse: false },
  completed: { tone: 'done', label: 'DONE', pulse: false },
}

/** A run's own status. `null` means "no live run", which is `idle` -- the same statement
 *  `deriveSlaveStatus(null)` makes. */
export function cardStateForRun(status: RunStatus | null): CardState {
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

/** `deriveSlaveStatus`'s output. Exhaustive over all seven members -- a new one is a build error
 *  here, not a silent fall-through to `idle` at render time. */
export function cardStateForSlave(status: SlaveStatus): CardState {
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
 * `cardStateFor(slave, task)` is untouched and stays the SLAVE-first derivation: `SlaveCard` is
 * about a slave that happens to hold a task, and this function is about a task that may have no
 * slave at all.
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
