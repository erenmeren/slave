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

/** `rules` decides from the observation by policy; `recorded` answers from a journal (replay);
 *  `llm` answers from envelopes a model produced and `parseEnvelopes` already validated — the
 *  model call and the parsing both happen outside the engine, so `decide` stays this same
 *  synchronous, pre-parsed shape for every kind. */
export interface DecisionProvider {
  readonly kind: 'rules' | 'recorded' | 'llm'
  /** When a provider routes different roles to different underlying providers (the composite),
   *  `kindFor` reports which one ACTUALLY answered a given role; `step` prefers this over the
   *  constant `kind` so the journal names the real source per decision point. */
  kindFor?(role: RoleDefinition): 'rules' | 'recorded' | 'llm'
  decide(request: DecisionRequest): readonly ActionEnvelope[]
}
