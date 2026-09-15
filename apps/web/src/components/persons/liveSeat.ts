import type { PersonDetail } from '../../server/persons'
import type { SlaveCardData } from '../../server/overview'

export function personOf(detail: unknown): PersonDetail | null {
  return detail !== null && typeof detail === 'object' && 'personId' in detail && typeof (detail as { personId: unknown }).personId === 'string'
    ? (detail as PersonDetail)
    : null
}

/** The Team band's own cards, as `/overview` already publishes them. `id` is the seat. */
export function cardsOf(snapshot: unknown): readonly SlaveCardData[] {
  if (snapshot === null || typeof snapshot !== 'object' || !('slaves' in snapshot)) return []
  const slaves = (snapshot as { slaves: unknown }).slaves
  return Array.isArray(slaves) ? (slaves as SlaveCardData[]) : []
}

export function liveSeatOf(cards: readonly SlaveCardData[], slaveId: string, personId: string): SlaveCardData | null {
  return cards.find((card) => card.id === slaveId) ?? cards.find((card) => card.personId === personId) ?? null
}

export function haltedReasonOf(snapshot: unknown): string | null {
  if (snapshot === null || typeof snapshot !== 'object' || !('workspace' in snapshot)) return null
  const workspace = (snapshot as { workspace: unknown }).workspace
  if (workspace === null || typeof workspace !== 'object' || !('haltedReason' in workspace)) return null
  const reason = (workspace as { haltedReason: unknown }).haltedReason
  return typeof reason === 'string' ? reason : null
}
