export type PriorityClass = 'external' | 'scheduled' | 'decision' | 'close'

export const PRIORITY_ORDER: Readonly<Record<PriorityClass, number>> = { external: 0, scheduled: 1, decision: 2, close: 3 }

export interface Scheduled<E> {
  readonly time: number
  readonly priority: PriorityClass
  readonly seq: number
  readonly event: E
}

export interface EventQueue<E> {
  readonly items: readonly Scheduled<E>[]
  readonly nextSeq: number
}

export function emptyQueue<E>(): EventQueue<E> {
  return { items: [], nextSeq: 1 }
}

export function enqueue<E>(queue: EventQueue<E>, time: number, priority: PriorityClass, event: E): EventQueue<E> {
  return { items: [...queue.items, { time, priority, seq: queue.nextSeq, event }], nextSeq: queue.nextSeq + 1 }
}

function compare<E>(a: Scheduled<E>, b: Scheduled<E>): number {
  return a.time - b.time || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.seq - b.seq
}

/** Everything due at `time` or earlier, in `(time, priority, seq)` order; the rest untouched. */
export function popDue<E>(queue: EventQueue<E>, time: number): { readonly due: readonly Scheduled<E>[]; readonly rest: EventQueue<E> } {
  const due = queue.items.filter((item) => item.time <= time).sort(compare)
  const rest = queue.items.filter((item) => item.time > time)
  return { due, rest: { items: rest, nextSeq: queue.nextSeq } }
}
