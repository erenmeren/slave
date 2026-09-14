import { describe, expect, it } from 'vitest'
// `@slave-of-ai/db`, NOT the domain (scan finding 19): `TASK_STATUSES` is at
// `packages/db/src/enums.ts:81` and no such export exists under `packages/domain/src`. The file
// this extends already imports it — as `ALL_STATUSES` — so REUSE THE EXISTING BINDING rather than
// adding a second import of the same array under a second name.
import { TASK_STATUSES as ALL_STATUSES } from '@slave-of-ai/db'
import { CARD_STATE_TONE } from '../src/lib/tones.js'
import { BOARD_COLUMNS, COLUMN_FOR_STATUS, COLUMN_STATE, priorityChip } from '../src/lib/taskColumns.js'

describe('the board columns', () => {
  it('is the README s five, in its order (M57 R10)', () => {
    expect(BOARD_COLUMNS).toEqual(['Queued', 'In progress', 'Review', 'Blocked', 'Done'])
  })

  it('maps every TaskStatus onto exactly one of them, by the README s table', () => {
    expect(COLUMN_FOR_STATUS).toEqual({
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
    })
  })

  it('leaves no status without a column -- the Record s totality is the build-time guard', () => {
    for (const status of ALL_STATUSES) {
      expect(BOARD_COLUMNS, status).toContain(COLUMN_FOR_STATUS[status])
    }
  })

  it('gives each column one CardState, spelled the way lib/tones.ts spells it (erratum E6)', () => {
    expect(COLUMN_STATE).toEqual({
      Queued: 'planning',
      'In progress': 'working',
      Review: 'review',
      Blocked: 'blocked',
      Done: 'completed',
    })
  })

  it('resolves every column tone through the one tone table, never its own', () => {
    for (const column of BOARD_COLUMNS) {
      // The assertion that matters is that the state is a KEY of `CARD_STATE_TONE` -- i.e. that
      // `lib/tones.ts` is still the only place a colour is chosen.
      expect(Object.keys(CARD_STATE_TONE)).toContain(COLUMN_STATE[column])
    }
    expect(CARD_STATE_TONE[COLUMN_STATE['In progress']].tone).toBe('working')
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
