import type { RoleDefinition } from '../core/sector.js'
import type { ActionDoc } from '../trade/action-docs.js'

/** The prompt a model sees for one decision point. Plain text, no markdown headings: a role
 *  line, the actions it may propose, its observation, the JSON-only contract, and the reminder
 *  that this is a synthetic simulation, not a real company. Pure — no I/O, no model call. */
export function buildDecisionPrompt(input: {
  readonly role: RoleDefinition
  readonly observation: Readonly<Record<string, unknown>>
  readonly actionDocs: readonly ActionDoc[]
  readonly day: number
  readonly currency: string
  readonly maxActions: number
}): string {
  const { role, observation, actionDocs, day, currency, maxActions } = input
  const lines: string[] = []
  lines.push(`You are ${role.slaveName}, playing the role of ${role.name}: ${role.purpose}.`)
  lines.push(`Day ${day}. Currency: ${currency}.`)
  lines.push('You may propose these actions:')
  for (const doc of actionDocs) lines.push(`${doc.type} ${doc.params} — ${doc.when}`)
  lines.push('Observation (JSON):')
  lines.push(JSON.stringify(observation))
  lines.push(`Respond with ONLY a JSON array of at most ${maxActions} action envelopes, each shaped { type, params, rationale, refs }. No prose, no markdown, no explanation — ONLY a JSON array.`)
  lines.push("This is a synthetic simulation; the numbers are not a real company's.")
  return lines.join('\n')
}
