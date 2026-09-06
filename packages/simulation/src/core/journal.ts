export type JournalKind = 'decision' | 'action_applied' | 'action_rejected' | 'event' | 'external_event' | 'control'

export interface JournalEntry {
  readonly seq: number
  readonly simTime: number
  readonly kind: JournalKind
  readonly actorRole: string | null
  readonly payload: Readonly<Record<string, unknown>>
}
