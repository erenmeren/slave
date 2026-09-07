import { actionEnvelopeSchema, type ActionEnvelope } from '../core/action.js'
import type { RoleDefinition } from '../core/sector.js'
import type { DecisionProvider, DecisionRequest } from './provider.js'

const FENCED_JSON = /```json\s*([\s\S]*?)```/g

/** Pulls a JSON array out of a model's free-form answer and validates each element as an
 *  `ActionEnvelope`. A real answer carries tool-call noise and prose around the array (the r4
 *  shape: `<function_calls>…</function_calls>` then prose then a fenced block then more prose) —
 *  so this prefers the LAST ```json fenced block if one is present, else the substring from the
 *  first `[` to the matching last `]`. Pure: no I/O, the model call happens outside this module. */
export function parseEnvelopes(text: string, maxActions: number): { readonly envelopes: readonly ActionEnvelope[] } | { readonly parseError: string } {
  const fenced = [...text.matchAll(FENCED_JSON)]
  let candidate: string
  if (fenced.length > 0) {
    candidate = (fenced[fenced.length - 1]?.[1] ?? '').trim()
  } else {
    const first = text.indexOf('[')
    const last = text.lastIndexOf(']')
    if (first === -1 || last === -1 || last < first) return { parseError: 'no JSON array found in the answer' }
    candidate = text.slice(first, last + 1)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch (error) {
    return { parseError: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!Array.isArray(parsed)) return { parseError: 'the parsed JSON value is not an array' }

  const envelopes: ActionEnvelope[] = []
  for (let i = 0; i < parsed.length; i++) {
    const result = actionEnvelopeSchema.safeParse(parsed[i])
    if (!result.success) return { parseError: `element ${i}: ${result.error.issues.map((issue) => issue.message).join('; ')}` }
    envelopes.push(result.data)
  }
  return { envelopes: envelopes.slice(0, maxActions) }
}

/** Answers each decision point from a pre-parsed envelope map, keyed by role name. The model
 *  call and the parsing (`parseEnvelopes`) both happen outside the engine, before this provider
 *  is constructed — `decide` here is synchronous and never invents an answer: a role with no
 *  entry gets `[]`, same as a role rules chooses not to act for. */
export class LlmDecisionProvider implements DecisionProvider {
  readonly kind = 'llm' as const
  constructor(private readonly answers: ReadonlyMap<string, readonly ActionEnvelope[]>) {}

  decide(request: DecisionRequest): readonly ActionEnvelope[] {
    return this.answers.get(request.role.name) ?? []
  }
}

/** Routes each role to the llm provider or the rules provider by name. `kind` is fixed for the
 *  engine's `provider.kind` fallback; `kindFor` is what the engine actually records per decision
 *  point (`step` reads `provider.kindFor?.(role) ?? provider.kind`) so the journal shows which
 *  provider ACTUALLY answered a given role, not a constant. */
export class CompositeDecisionProvider implements DecisionProvider {
  readonly kind = 'llm' as const
  constructor(private readonly input: { readonly llmRoles: readonly string[]; readonly llm: DecisionProvider; readonly rules: DecisionProvider }) {}

  private routeFor(role: RoleDefinition): DecisionProvider {
    return this.input.llmRoles.includes(role.name) ? this.input.llm : this.input.rules
  }

  decide(request: DecisionRequest): readonly ActionEnvelope[] {
    return this.routeFor(request.role).decide(request)
  }

  kindFor(role: RoleDefinition): 'rules' | 'recorded' | 'llm' {
    const provider = this.routeFor(role)
    return provider.kindFor?.(role) ?? provider.kind
  }
}
