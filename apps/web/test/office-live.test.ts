import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveOffice, boardFromOverview, liveSlavesOf, liveStatusOf, type LiveSlave, type LiveStatus } from '../src/lib/office/liveOffice.js'
import type { OverviewSnapshot, SlaveCardData } from '../src/server/overview.js'

function card(over: Partial<SlaveCardData> = {}): SlaveCardData {
  return {
    id: 's1', name: 'Alex', role: 'backend', provider: null, gate: null, status: 'idle', taskTitle: null, taskId: null,
    taskStatus: null, progressPct: 0, stepLabel: null, skill: null, actionLine: null, runId: null, queuedMessage: null,
    resumeRequestedAt: null, recentEvents: [], costUsd: null, toolCalls: 0, pausedAtStep: null, ...over,
  }
}

function overview(over: Partial<OverviewSnapshot> = {}): OverviewSnapshot {
  return {
    workspace: {
      id: 'w1', name: 'Checkout', haltedReason: null, haltedAt: null, budgetUsd: null, spentUsd: 0, unmeasuredRuns: 0, goal: null,
      provider: null, costBlindBudgeted: false, maxConcurrentRuns: 3, runTimeoutMs: 1000, maxAttempts: 3,
    } as OverviewSnapshot['workspace'],
    slaves: [],
    tasks: { active: 2, ready: 3, blocked: 1, done: 4, failed: 0 } as OverviewSnapshot['tasks'],
    blocked: [],
    liveEvents: [],
    mergeQueue: [],
    ...over,
  } as OverviewSnapshot
}

const ROSTER = [
  { teamId: 't1', name: 'Engineering', color: '#2ee6cf', slaves: [{ slaveId: 's1', name: 'Alex', role: 'backend', color: '#2ee6cf' }, { slaveId: 's2', name: 'Maya', role: 'qa', color: '#7b8cff' }] },
  { teamId: 't2', name: 'Product', color: '#7b8cff', slaves: [{ slaveId: 's3', name: 'John', role: 'analyst', color: '#c084fc' }] },
]

function live(status: LiveStatus, over: Partial<LiveSlave> = {}): LiveSlave {
  return { slaveId: 's1', status, taskTitle: status === 'idle' ? null : 'Add the thing', stepLabel: 'verifying', progressPct: 40, runId: status === 'idle' ? null : 'r1', ...over }
}

function office(): LiveOffice {
  const o = new LiveOffice(ROSTER)
  o.setWallClock(10)
  return o
}

/** Ticks until every slave is seated again (a transition walk takes a few seconds of world time). */
function settle(o: LiveOffice, seconds = 30): void {
  for (let i = 0; i < seconds * 20; i++) o.tick(0.05)
}

afterEach(() => vi.restoreAllMocks())

describe('liveStatusOf', () => {
  it.each(['idle', 'starting', 'working', 'pausing', 'paused', 'resuming', 'stopping'] as const)('passes %s through', (status) => {
    expect(liveStatusOf(card({ status }), new Set())).toBe(status)
  })
  it('is blocked when the task is blocked or the run is in the blocked list', () => {
    expect(liveStatusOf(card({ status: 'working', taskStatus: 'blocked' }), new Set())).toBe('blocked')
    expect(liveStatusOf(card({ status: 'working', runId: 'r1' }), new Set(['r1']))).toBe('blocked')
    expect(liveStatusOf(card({ status: 'working', runId: 'r2' }), new Set(['r1']))).toBe('working')
  })
})

describe('liveSlavesOf / boardFromOverview', () => {
  it('keys cards by slave id, reading the blocked run rows', () => {
    const o = overview({
      slaves: [card({ id: 's1', status: 'working', runId: 'r1', taskTitle: 'Ship it', stepLabel: 'verifying', progressPct: 55 }), card({ id: 's2' })],
      blocked: [{ kind: 'run', id: 'r1', title: 'x', detail: 'y', action: 'resume', runId: 'r1' }] as OverviewSnapshot['blocked'],
    })
    const m = liveSlavesOf(o)
    expect(m.get('s1')).toEqual({ slaveId: 's1', status: 'blocked', taskTitle: 'Ship it', stepLabel: 'verifying', progressPct: 55, runId: 'r1' })
    expect(m.get('s2')?.status).toBe('idle')
  })
  it('maps the task counts onto the board columns', () => {
    expect(boardFromOverview(overview({ mergeQueue: [{ id: 'm1', title: 't', hasApproval: false }] as OverviewSnapshot['mergeQueue'] }))).toEqual({ todo: 3, doing: 2, review: 1, done: 4 })
  })
})

describe('LiveOffice', () => {
  it('uses the real slave ids and the roster order, and reports live data back', () => {
    const o = office()
    expect(o.slaves.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    expect(o.departments.map((d) => d.name)).toEqual(['Engineering', 'Product'])
    o.apply(new Map([['s1', live('working')]]), { todo: 0, doing: 0, review: 0, done: 0 })
    expect(o.liveOf('s1')?.runId).toBe('r1')
    expect(o.liveOf('s9')).toBeNull()
  })

  it.each([
    ['working', 'work'],
    ['blocked', 'blocked'],
    ['pausing', 'paused'],
    ['paused', 'paused'],
    ['idle', 'sit'],
  ] as const)('seats a %s slave in state %s with the real task and progress', (status, state) => {
    const o = office()
    o.apply(new Map([['s1', live(status)]]), { todo: 0, doing: 0, review: 0, done: 0 })
    o.tick(0.05)
    const alex = o.slaves[0]!
    expect(alex.state).toBe(state)
    if (status === 'idle') {
      expect(alex.task).toBeNull()
      expect(alex.progress).toBe(0)
    } else {
      expect(alex.task).toEqual(expect.objectContaining({ key: 'verifying', title: 'Add the thing' }))
      expect(alex.progress).toBe(40)
    }
  })

  it('never advances progress on its own', () => {
    const o = office()
    o.apply(new Map([['s1', live('working', { progressPct: 40 })]]), { todo: 0, doing: 0, review: 0, done: 0 })
    settle(o, 10)
    expect(o.slaves[0]!.progress).toBe(40)
    o.apply(new Map([['s1', live('working', { progressPct: 41 })]]), { todo: 0, doing: 0, review: 0, done: 0 })
    o.tick(0.05)
    expect(o.slaves[0]!.progress).toBe(41)
  })

  it.each(['starting', 'resuming'] as const)('walks a %s slave to the board once, then it works at its desk', (status) => {
    const o = office()
    o.apply(new Map([['s1', live(status)]]), { todo: 0, doing: 0, review: 0, done: 0 })
    o.tick(0.05)
    const alex = o.slaves[0]!
    expect(alex.state).toBe('walk')
    expect(alex.next).toBe('grab')
    settle(o)
    expect(alex.state).toBe('work')
    const seat = o.seat(alex)
    expect([alex.x, alex.y]).toEqual([seat.x, seat.y])
    o.apply(new Map([['s1', live(status)]]), { todo: 0, doing: 0, review: 0, done: 0 })
    o.tick(0.05)
    expect(alex.state).toBe('work') // the same status again does not restart the walk
  })

  it('walks a stopping slave to the board once, then it sits idle', () => {
    const o = office()
    o.apply(new Map([['s1', live('stopping')]]), { todo: 0, doing: 0, review: 0, done: 0 })
    o.tick(0.05)
    const alex = o.slaves[0]!
    expect(alex.next).toBe('deliver')
    settle(o)
    expect(alex.state).toBe('sit')
  })

  it('lets only idle slaves wander, and always back to the desk', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1) // < .18 → the arcade
    const o = office()
    o.apply(new Map([['s1', live('idle')], ['s2', live('working', { slaveId: 's2' })]]), { todo: 0, doing: 0, review: 0, done: 0 })
    settle(o, 5)
    const [alex, maya] = o.slaves as [typeof o.slaves[0], typeof o.slaves[0]]
    expect(['walk', 'arcade']).toContain(alex.state)
    expect(maya.state).toBe('work')
    settle(o, 30)
    expect(['sit', 'walk', 'arcade']).toContain(alex.state)
    expect(maya.state).toBe('work')
  })

  it('draws the board from the counts, capped at six cards a column', () => {
    const o = office()
    o.apply(new Map(), { todo: 9, doing: 2, review: 0, done: 4 })
    expect(o.board.todo).toHaveLength(6)
    expect(o.board.doing).toHaveLength(2)
    expect(o.board.review).toHaveLength(0)
    expect(o.board.done).toHaveLength(4)
  })

  it('keeps the wall clock unless an hour is locked', () => {
    const o = office()
    o.setWallClock(14.5)
    o.tick(0.05)
    expect(o.hour).toBe(14.5)
    o.hourLock = 3
    o.tick(0.05)
    expect(o.hour).toBe(3)
    o.hourLock = null
    o.tick(0.05)
    expect(o.hour).toBe(14.5)
  })

  it('celebrates a slave whose task finished', () => {
    const o = office()
    o.apply(new Map([['s1', live('working', { progressPct: 100 })]]), { todo: 0, doing: 0, review: 0, done: 0 })
    o.tick(0.05)
    o.apply(new Map([['s1', live('idle')]]), { todo: 0, doing: 0, review: 0, done: 0 })
    expect(o.events[0]).toEqual(expect.objectContaining({ type: 'task.done', slave: 'Alex' }))
  })
})
