import type { AgentStatus, RunStatus, TaskStatus } from '@ai-team-os/domain'
import type { StatusTone } from '../components/ui/StatusPill'

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
