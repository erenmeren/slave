import { describe, expect, it } from 'vitest'
import type { TaskStatus } from '@ai-team-os/domain'
import { CARD_STATE_TONE } from '../src/lib/tones.js'
import { BOARD_COLUMNS, COLUMN_FOR_STATUS, COLUMN_STATE, priorityChip } from '../src/lib/taskColumns.js'

const ALL_STATUSES: readonly TaskStatus[] = [
  'backlog', 'ready', 'blocked', 'assigned', 'running',
  'verifying', 'reviewing', 'merging', 'rework', 'done', 'failed', 'cancelled',
]

describe('the board columns', () => {
  it('are the README six, in its order', () => {
    expect(BOARD_COLUMNS).toEqual(['Backlog', 'Todo', 'In Progress', 'Review', 'Blocked', 'Done'])
  })

  it('maps every status exactly as the spec §5.3 table says', () => {
    expect(COLUMN_FOR_STATUS).toEqual({
      backlog: 'Backlog',
      ready: 'Todo',
      // `rework` is a verify failure with attempts remaining — work that is queued again, so it
      // reads as Todo. The card still shows its own `rework` pill.
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
    })
  })

  it('covers every TaskStatus and lands only on the six columns', () => {
    for (const status of ALL_STATUSES) {
      expect(BOARD_COLUMNS).toContain(COLUMN_FOR_STATUS[status])
    }
    expect(Object.keys(COLUMN_FOR_STATUS).sort()).toEqual([...ALL_STATUSES].sort())
  })

  it('resolves every column tone through the one tone table, never its own', () => {
    for (const column of BOARD_COLUMNS) {
      // The assertion that matters is that the state is a KEY of `CARD_STATE_TONE` — i.e. that
      // `lib/tones.ts` is still the only place a colour is chosen.
      expect(Object.keys(CARD_STATE_TONE)).toContain(COLUMN_STATE[column])
    }
    expect(CARD_STATE_TONE[COLUMN_STATE['In Progress']].tone).toBe('working')
    expect(CARD_STATE_TONE[COLUMN_STATE.Done].tone).toBe('done')
  })
})

describe('priorityChip', () => {
  it.each([
    [1, 'LOW'],
    [2, 'MED'],
    [3, 'HIGH'],
    [4, 'URGENT'],
    [9, 'URGENT'],
  ])('renders priority %i as %s', (priority, label) => {
    expect(priorityChip(priority).label).toBe(label)
  })

  it('escalates the tone with the priority', () => {
    expect(priorityChip(1).tone).toBe('idle')
    expect(priorityChip(3).tone).toBe('waiting')
    expect(priorityChip(4).tone).toBe('blocked')
  })
})
