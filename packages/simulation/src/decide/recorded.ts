import { actionEnvelopeSchema, type ActionEnvelope } from '../core/action.js'
import type { JournalEntry } from '../core/journal.js'
import type { DecisionProvider, DecisionRequest } from './provider.js'

export class ReplayDivergence extends Error {
  constructor(detail: string) {
    super(`replay_divergence: ${detail}`)
  }
}

/** Answers each decision point with the envelopes the journal recorded for `(day, role, index)`.
 *  It never invents one: a missing record is a divergence, not an empty decision. */
export class RecordedDecisionProvider implements DecisionProvider {
  readonly kind = 'recorded' as const
  private readonly byPoint = new Map<string, readonly ActionEnvelope[]>()

  constructor(entries: readonly JournalEntry[]) {
    for (const entry of entries) {
      if (entry.kind !== 'decision') continue
      const raw = entry.payload['actions']
      const actions = Array.isArray(raw) ? raw.map((a) => actionEnvelopeSchema.parse(a)) : []
      this.byPoint.set(`${entry.simTime}:${String(entry.actorRole)}:${String(entry.payload['index'])}`, actions)
    }
  }

  decide(request: DecisionRequest): readonly ActionEnvelope[] {
    const key = `${request.day}:${request.role.name}:${request.index}`
    const actions = this.byPoint.get(key)
    if (actions === undefined) throw new ReplayDivergence(`no recorded decision for ${key}`)
    return actions
  }
}
