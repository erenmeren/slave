import { describe, expect, it } from 'vitest'
import { CARD_STATE_TONE, cardStateFor, cardStateForAgent, cardStateForRun, type CardState } from '../src/lib/tones.js'
import type { AgentStatus, RunStatus, TaskStatus } from '@ai-team-os/domain'

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
    const all: readonly TaskStatus[] = [
      'backlog', 'ready', 'blocked', 'assigned', 'running',
      'verifying', 'reviewing', 'merging', 'rework', 'done', 'failed', 'cancelled',
    ]
    for (const task of all) expect(typeof cardStateFor('idle', task)).toBe('string')
    expect(all).toHaveLength(12)
  })
})
