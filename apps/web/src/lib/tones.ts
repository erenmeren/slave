import type { AgentStatus, RunStatus, TaskStatus } from '@ai-team-os/domain'
import type { StatusTone } from '../components/ui/StatusPill'
import { COLUMN_FOR_STATUS, COLUMN_STATE } from './taskColumns'

/**
 * The handoff's ten card states (`design_handoff_ai_team_os/mockups/AI Team OS Mockups.dc.html`
 * lines 912-923, `Component.meta`). This is a DISPLAY vocabulary, not a domain one: the domain
 * has `RunStatus` (nine), `AgentStatus` (seven) and `TaskStatus` (twelve), and none of them is
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
  idle: { tone: 'idle', label: 'IDLE', pulse: false },
  completed: { tone: 'done', label: 'DONE', pulse: false },
}

/** A run's own status. `null` means "no live run", which is `idle` -- the same statement
 *  `deriveAgentStatus(null)` makes. */
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

/** `deriveAgentStatus`'s output. Exhaustive over all seven members -- a new one is a build error
 *  here, not a silent fall-through to `idle` at render time. */
export function cardStateForAgent(status: AgentStatus): CardState {
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
 * The full card state: the agent's own status, with three task facts layered over it.
 *
 * `blocked`, `review` and `completed` are unreachable from `AgentStatus` alone -- an agent whose
 * task is blocked is simply `idle`, and `idle` is what the card would say without this. The three
 * overrides are exactly the states the handoff's card set has and the agent vocabulary does not.
 */
export function cardStateFor(agent: AgentStatus, task: TaskStatus | null): CardState {
  if (task === null) return cardStateForAgent(agent)
  switch (task) {
    case 'blocked':
      return 'blocked'
    case 'reviewing':
    case 'merging':
      return 'review'
    case 'failed':
    case 'cancelled':
      return 'blocked'
    case 'done':
      // Only when nobody is still working on it: a `done` task whose agent is mid-run means the
      // agent has moved on and the snapshot has not caught up, and the AGENT is what this card
      // is about.
      return agent === 'idle' ? 'completed' : cardStateForAgent(agent)
    case 'backlog':
    case 'ready':
    case 'assigned':
    case 'running':
    case 'verifying':
    case 'rework':
      return cardStateForAgent(agent)
    default: {
      // The `capabilitiesOf` idiom (`packages/providers/src/capabilities.ts:29-38`). `tsconfig.base`
      // sets `strict` but not `noImplicitReturns`, so a thirteenth `TaskStatus` added later would
      // otherwise fall out of this switch with no compile error, silently landing on whatever
      // `cardStateForAgent(agent)` returns -- exactly the "a status silently defaults" failure this
      // file exists to rule out. Binding `task` to `never` makes that a BUILD failure naming the
      // unhandled member.
      const unhandled: never = task
      throw new Error(`cardStateFor: unhandled TaskStatus ${JSON.stringify(unhandled)}`)
    }
  }
}

/**
 * A TASK's own card state, with no agent in play (M14 fix wave, review I2).
 *
 * `COLUMN_STATE[COLUMN_FOR_STATUS[status]]` -- the state of the board column the task sits in,
 * which is the one thing a task card, a dependency node and an execution node all already agree
 * on. Every task-only surface used to call `cardStateFor('idle', status)`, borrowing the AGENT
 * derivation and passing a fake idle agent; for `running`, `assigned`, `verifying`, `ready` and
 * `backlog` that fell through to `cardStateForAgent('idle')` and painted a grey **IDLE** pill on a
 * card sitting under the teal **IN PROGRESS** column head. One card, two answers.
 *
 * `failed` and `cancelled` are the two exceptions, and they are deliberate: `COLUMN_FOR_STATUS`
 * puts both on the `Done` column (a column is a phase, and both of those end one), but a failed
 * task is not a completed one -- they keep the `blocked` state `cardStateFor` already gave them,
 * so the card says what happened while the board still files it where it belongs.
 *
 * `cardStateFor(agent, task)` is untouched and stays the AGENT-first derivation: `AgentCard` is
 * about an agent that happens to hold a task, and this function is about a task that may have no
 * agent at all.
 */
export function cardStateForTask(status: TaskStatus): CardState {
  switch (status) {
    case 'failed':
    case 'cancelled':
      return 'blocked'
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
      // off, so a thirteenth `TaskStatus` would otherwise fall out of this switch as `undefined`
      // and render an empty pill. This makes it a BUILD failure naming the unhandled member.
      const unhandled: never = status
      throw new Error(`cardStateForTask: unhandled TaskStatus ${JSON.stringify(unhandled)}`)
    }
  }
}
