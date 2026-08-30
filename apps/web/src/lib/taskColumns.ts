import type { TaskStatus } from '@ai-team-os/domain'
import type { StatusTone } from '../components/ui/StatusPill'
import type { CardState } from './tones'

export type BoardColumn = 'Backlog' | 'Todo' | 'In Progress' | 'Review' | 'Blocked' | 'Done'

/** The design README §3a.3's six columns, in its order. */
export const BOARD_COLUMNS: readonly BoardColumn[] = ['Backlog', 'Todo', 'In Progress', 'Review', 'Blocked', 'Done']

/**
 * Every `TaskStatus` on exactly one column (spec §5.3). `Record<TaskStatus, BoardColumn>` is
 * load-bearing: a thirteenth status added to the domain fails the BUILD here rather than becoming
 * a task nobody can see on any column.
 *
 * `failed` and `cancelled` share the `Done` column with `done` and carry their own pill on the
 * card — the board's columns are phases, and both of those are the end of one.
 */
export const COLUMN_FOR_STATUS: Record<TaskStatus, BoardColumn> = {
  backlog: 'Backlog',
  ready: 'Todo',
  rework: 'Todo',
  assigned: 'In Progress',
  running: 'In Progress',
  verifying: 'In Progress',
  reviewing: 'Review',
  merging: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Done',
  cancelled: 'Done',
}

/**
 * The `CardState` each column reads as — the source of its 5px head dot (design README §3a.3).
 *
 * Deliberately a state, not a tone: `lib/tones.ts`'s `CARD_STATE_TONE` is the ONE table that
 * assigns a tone, a label and a pulse (Decision 2, "anatomy is written once"), and a second
 * `Record<BoardColumn, StatusTone>` here would be a second place for the palette to drift. Every
 * consumer reads `CARD_STATE_TONE[COLUMN_STATE[column]].tone`.
 */
export const COLUMN_STATE: Record<BoardColumn, CardState> = {
  Backlog: 'idle',
  Todo: 'planning',
  'In Progress': 'working',
  Review: 'review',
  Blocked: 'blocked',
  Done: 'completed',
}

/** `Task.priority` is an integer; the handoff's card shows a word. Four buckets, escalating tone.
 *  Anything above 4 is still `URGENT` — there is no fifth word to reach for. */
export function priorityChip(priority: number): { readonly label: string; readonly tone: StatusTone } {
  if (priority >= 4) return { label: 'URGENT', tone: 'blocked' }
  if (priority === 3) return { label: 'HIGH', tone: 'waiting' }
  if (priority === 2) return { label: 'MED', tone: 'idle' }
  return { label: 'LOW', tone: 'idle' }
}
