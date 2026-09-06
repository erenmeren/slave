import type { ActionEnvelope } from '../core/action.js'
import type { RoleDefinition } from '../core/sector.js'

export interface DecisionRequest {
  readonly day: number
  readonly role: RoleDefinition
  /** Only what `role.observes` allows — the sector filters; the provider never sees the world. */
  readonly observation: Readonly<Record<string, unknown>>
  /** The decision point's index within the day (one per role in `roleOrder`). */
  readonly index: number
}

/** `rules` decides from the observation by policy; `recorded` answers from a journal (replay). An
 *  `llm` kind arrives in M31 with an asynchronous shape — this synchronous one is the M29 contract. */
export interface DecisionProvider {
  readonly kind: 'rules' | 'recorded'
  decide(request: DecisionRequest): readonly ActionEnvelope[]
}
