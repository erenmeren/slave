import type { TaskStatus } from '@slave-of-ai/domain'
import type { StatusTone } from '../components/ui/StatusPill'
import type { CardState } from './tones'

export type BoardColumn = 'Queued' | 'In progress' | 'Review' | 'Blocked' | 'Done'

/** The handoff README's five columns, in its order (M57 R10). Six became five when `Backlog` and
 *  `Todo` folded together: a person does not need `backlog` from `ready` from `rework` from
 *  `assigned` to know the work has not started, which is the same collapse
 *  `packages/domain/src/status/user.ts`'s `USER_TASK_STATE_FOR_STATUS` already made for the WORD on
 *  the card. `docs/ia.md`'s line about the board keeping its own vocabulary in M44 is rewritten by
 *  this milestone: the card's pill is `USER_TASK_LABEL` now, and the column is a phase. */
export const BOARD_COLUMNS: readonly BoardColumn[] = ['Queued', 'In progress', 'Review', 'Blocked', 'Done']

/**
 * Every `TaskStatus` on exactly one column. `Record<TaskStatus, BoardColumn>` is load-bearing and
 * is the whole reason this table is worth having: a fourteenth status added to the domain fails the
 * BUILD here rather than becoming a task nobody can see on any column.
 *
 * `waiting` is `In progress` and not `Blocked`, which was true before M57 and is still true: a
 * waiting task is mid-flight — its slave is paused inside a live session holding the worktree, and
 * the answer that releases it comes from another slave, not from the human the `Blocked` column is
 * addressed to. Its card keeps its own amber WAITING pill.
 *
 * `failed` and `cancelled` share `Done` with `done` and carry their own pill: the column is a
 * phase, and both of those are the end of one.
 */
export const COLUMN_FOR_STATUS: Record<TaskStatus, BoardColumn> = {
  backlog: 'Queued',
  ready: 'Queued',
  rework: 'Queued',
  assigned: 'Queued',
  running: 'In progress',
  verifying: 'In progress',
  waiting: 'In progress',
  reviewing: 'Review',
  merging: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Done',
  cancelled: 'Done',
}

/**
 * The `CardState` each column reads as — the source of its head dot.
 *
 * Deliberately a STATE, not a tone: `lib/tones.ts`'s `CARD_STATE_TONE` is the ONE table that
 * assigns a tone, a label and a pulse, and a second `Record<BoardColumn, StatusTone>` here would be
 * a second place for the palette to drift. `'completed'` is that union's spelling for finished work
 * (`lib/tones.ts:20`, `UserCardState`), not `'done'`.
 */
export const COLUMN_STATE: Record<BoardColumn, CardState> = {
  Queued: 'planning',
  'In progress': 'working',
  Review: 'review',
  Blocked: 'blocked',
  Done: 'completed',
}

/** `Task.priority` is an integer; the detail panel's header shows a word (M24 §5.4). Four buckets, escalating tone.
 *  Anything above 4 is still `URGENT` — there is no fifth word to reach for. */
export function priorityChip(priority: number): { readonly label: string; readonly tone: StatusTone } {
  if (priority >= 4) return { label: 'URGENT', tone: 'blocked' }
  if (priority === 3) return { label: 'HIGH', tone: 'waiting' }
  if (priority === 2) return { label: 'MED', tone: 'idle' }
  return { label: 'LOW', tone: 'idle' }
}
