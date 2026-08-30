import { describe, expect, it } from 'vitest'
import { CARD_STATE_TONE, cardStateFor, cardStateForAgent, cardStateForRun, cardStateForTask, type CardState } from '../src/lib/tones.js'
import { COLUMN_FOR_STATUS, COLUMN_STATE } from '../src/lib/taskColumns.js'
import type { AgentStatus, RunStatus, TaskStatus } from '@ai-team-os/domain'
import { TASK_STATUSES } from '@ai-team-os/db'

// The mockup's own table (`AI Team OS Mockups.dc.html:912-923`), transcribed. Colour is checked
// through the tone name rather than the hex, because `globals.css` owns the hex and a tone is how
// this codebase names one.
const EXPECTED: Record<CardState, { tone: string; label: string; pulse: boolean }> = {
  working: { tone: 'working', label: 'WORKING', pulse: true },
  planning: { tone: 'planning', label: 'PLANNING', pulse: true },
  waiting: { tone: 'waiting', label: 'WAITING', pulse: false },
  review: { tone: 'review', label: 'REVIEW', pulse: true },
  paused: { tone: 'paused', label: 'PAUSED', pulse: false },
  pause_requested: { tone: 'waiting', label: 'PAUSING', pulse: true },
  resuming: { tone: 'working', label: 'RESUMING', pulse: true },
  blocked: { tone: 'blocked', label: 'BLOCKED', pulse: false },
  idle: { tone: 'idle', label: 'IDLE', pulse: false },
  completed: { tone: 'done', label: 'DONE', pulse: false },
}

describe('CARD_STATE_TONE', () => {
  it('carries the mockup table verbatim for all ten states', () => {
    expect(CARD_STATE_TONE).toEqual(EXPECTED)
  })

  it('pulses exactly the five in-flight states the spec names', () => {
    const pulsing = (Object.keys(CARD_STATE_TONE) as CardState[]).filter((s) => CARD_STATE_TONE[s].pulse).sort()
    expect(pulsing).toEqual(['pause_requested', 'planning', 'resuming', 'review', 'working'].sort())
  })
})

describe('cardStateForRun', () => {
  const cases: ReadonlyArray<readonly [RunStatus | null, CardState]> = [
    [null, 'idle'],
    ['starting', 'planning'],
    ['working', 'working'],
    ['pause_requested', 'pause_requested'],
    ['paused', 'paused'],
    ['resuming', 'resuming'],
    ['stopping', 'waiting'],
    ['stopped', 'idle'],
    ['succeeded', 'completed'],
    ['failed', 'blocked'],
  ]

  it.each(cases)('maps %s to %s', (status, expected) => {
    expect(cardStateForRun(status)).toBe(expected)
  })

  it('covers every RunStatus -- a tenth member would leave a hole here', () => {
    const covered = cases.map(([status]) => status).filter((s): s is RunStatus => s !== null)
    expect(new Set(covered).size).toBe(9)
  })
})

describe('cardStateForAgent', () => {
  const cases: ReadonlyArray<readonly [AgentStatus, CardState]> = [
    ['idle', 'idle'],
    ['starting', 'planning'],
    ['working', 'working'],
    ['pausing', 'pause_requested'],
    ['paused', 'paused'],
    ['resuming', 'resuming'],
    ['stopping', 'waiting'],
  ]

  it.each(cases)('maps %s to %s', (status, expected) => {
    expect(cardStateForAgent(status)).toBe(expected)
  })

  it('covers every AgentStatus', () => {
    expect(new Set(cases.map(([s]) => s)).size).toBe(7)
  })
})

describe('cardStateFor', () => {
  it("lets a blocked task override the agent's own idleness", () => {
    expect(cardStateFor('idle', 'blocked')).toBe('blocked')
  })

  it('reads a task under review or in the merge queue as review, whatever the agent is doing', () => {
    expect(cardStateFor('working', 'reviewing')).toBe('review')
    expect(cardStateFor('idle', 'merging')).toBe('review')
  })

  it('reads a done task with no live run as completed', () => {
    expect(cardStateFor('idle', 'done')).toBe('completed')
  })

  it('defers to the agent everywhere else', () => {
    expect(cardStateFor('working', 'running')).toBe('working')
    expect(cardStateFor('paused', 'running')).toBe('paused')
    expect(cardStateFor('idle', null)).toBe('idle')
  })

  it('covers every TaskStatus', () => {
    // `TASK_STATUSES` (`@ai-team-os/db`'s `enums.ts`) is type-pinned complete and sound against
    // the domain's `TaskStatus` union by its own `_TaskStatusesComplete`/`_TaskStatusesSound`
    // assertions -- iterating it here, rather than a hardcoded array of literals plus a
    // `toHaveLength`, means a thirteenth `TaskStatus` moves this test's coverage (and hits
    // `cardStateFor`'s own `never` guard) automatically, with nothing in this file to remember
    // to update.
    for (const task of TASK_STATUSES) expect(typeof cardStateFor('idle', task)).toBe('string')
  })
})

// M14 fix wave, review I2. The defect this pins: a card in the teal IN PROGRESS column whose own
// pill read a grey IDLE, because every task-only surface went through `cardStateFor('idle', s)`
// and five statuses fell through that to the agent's own idleness.
describe('cardStateForTask', () => {
  const cases: ReadonlyArray<readonly [TaskStatus, CardState]> = [
    ['backlog', 'idle'],
    ['ready', 'planning'],
    ['rework', 'planning'],
    ['assigned', 'working'],
    ['running', 'working'],
    ['verifying', 'working'],
    ['reviewing', 'review'],
    ['merging', 'review'],
    ['blocked', 'blocked'],
    ['done', 'completed'],
    ['failed', 'blocked'],
    ['cancelled', 'blocked'],
  ]

  it.each(cases)('maps %s to %s', (status, expected) => {
    expect(cardStateForTask(status)).toBe(expected)
  })

  it('covers every TaskStatus -- a thirteenth is a hole here and a build error in the source', () => {
    expect(new Set(cases.map(([s]) => s))).toEqual(new Set(TASK_STATUSES))
  })

  it("is the column's state for every status except the two ends that are not completions", () => {
    for (const status of TASK_STATUSES) {
      const columnState = COLUMN_STATE[COLUMN_FOR_STATUS[status]]
      if (status === 'failed' || status === 'cancelled') {
        // Both sit on the Done column, and neither is done. The card says what happened.
        expect(COLUMN_FOR_STATUS[status]).toBe('Done')
        expect(cardStateForTask(status)).toBe('blocked')
      } else {
        expect(cardStateForTask(status)).toBe(columnState)
      }
    }
  })

  it('reads a running task as working, never as idle -- the pill agrees with the column head', () => {
    expect(CARD_STATE_TONE[cardStateForTask('running')].label).toBe('WORKING')
    expect(CARD_STATE_TONE[cardStateFor('idle', 'running')].label).toBe('IDLE')
  })
})
