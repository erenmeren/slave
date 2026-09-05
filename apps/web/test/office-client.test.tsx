// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeSnapshot } from '../src/server/office.js'
import type { OverviewSnapshot, SlaveCardData } from '../src/server/overview.js'

// A world the client can drive without a canvas: three seated slaves, the fields the client reads.
const stubSlaves = [
  { id: 's1', name: 'Alex', role: 'backend', color: '#2ee6cf', dept: 0, state: 'work', task: { key: 'verifying', title: 'Add the thing' }, progress: 40 },
  { id: 's2', name: 'Maya', role: 'qa', color: '#7b8cff', dept: 0, state: 'sit', task: null, progress: 0 },
  { id: 's3', name: 'John', role: 'analyst', color: '#c084fc', dept: 1, state: 'paused', task: { key: '', title: 'Plan' }, progress: 10 },
]
const applied: unknown[] = []
const stubWorld = {
  slaves: stubSlaves,
  departments: [{ name: 'Engineering' }, { name: 'Product' }],
  view: { S: 1, ox: 0, oy: 0, w: 100, h: 100, levels: [1, 2, 3, 4], li: 0 },
  viewHits: [] as { id: string; x: number; y: number; w: number; h: number }[],
  focusId: null as string | null,
  hour: 10,
  hourLock: null as number | null,
  t: 0,
  events: [],
  tick: vi.fn(),
  apply: vi.fn((...args: unknown[]) => applied.push(args)),
  setWallClock: vi.fn(),
  liveOf: (id: string) => liveById[id] ?? null,
  status: (s: { state: string }) => ({ work: 'working', sit: 'idle', paused: 'paused', blocked: 'blocked' })[s.state] ?? 'idle',
  clock: () => '10:00',
}
const liveById: Record<string, { slaveId: string; status: string; taskTitle: string | null; stepLabel: string | null; progressPct: number; runId: string | null }> = {
  s1: { slaveId: 's1', status: 'working', taskTitle: 'Add the thing', stepLabel: 'verifying', progressPct: 40, runId: 'r1' },
  s3: { slaveId: 's3', status: 'paused', taskTitle: 'Plan', stepLabel: null, progressPct: 10, runId: 'r3' },
}

vi.mock('../src/lib/office/liveOffice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/office/liveOffice.js')>()
  return { ...actual, LiveOffice: vi.fn(() => stubWorld) }
})
vi.mock('../src/lib/office/engine.js', () => ({
  renderIsoE: vi.fn(),
  setPixelFont: vi.fn(),
  tod: (h: number) => ({ label: h < 12 ? 'Morning' : 'Afternoon', light: 1, sky: '#000', horizon: '#000', ambient: '#000' }),
  STATUS: { working: '#2ee6cf', planning: '#7b8cff', review: '#c084fc', waiting: '#f5b34a', blocked: '#f87171', done: '#4ade80', paused: '#8a929e', idle: '#5b6472' },
  // liveOffice.js's own mock below asks for its real module (`importOriginal`) so it keeps
  // `boardFromOverview`/`liveSlavesOf` real; that real module's `class LiveOffice extends WorldF`
  // still evaluates against *this* mock (the same module, one registration), so `WorldF` has to
  // exist here even though nothing ever instantiates it — `LiveOffice` itself is fully replaced below.
  WorldF: class {},
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

let streamSnapshot: OverviewSnapshot
vi.mock('../src/hooks/useOverview', () => ({
  useOverview: () => ({ snapshot: streamSnapshot, connection: 'connected', error: null, latencyMs: null, actionLines: {}, liveEvents: {} }),
}))

import { LiveOffice } from '../src/lib/office/liveOffice.js'
import { OfficeClient } from '../src/components/office/OfficeClient.js'

function card(over: Partial<SlaveCardData>): SlaveCardData {
  return {
    id: 'x', name: 'x', role: 'x', provider: null, gate: null, status: 'idle', taskTitle: null, taskId: null, taskStatus: null, progressPct: 0,
    stepLabel: null, skill: null, actionLine: null, runId: null, queuedMessage: null, resumeRequestedAt: null, recentEvents: [], costUsd: null,
    toolCalls: 0, pausedAtStep: null, ...over,
  }
}

function snapshot(archived = false): OfficeSnapshot {
  const overview = {
    workspace: { id: 'w1', name: 'Checkout', haltedReason: null, haltedAt: null, budgetUsd: null, spentUsd: 0, unmeasuredRuns: 0, goal: null, provider: null, costBlindBudgeted: false, maxConcurrentRuns: 3, runTimeoutMs: 1000, maxAttempts: 3 },
    slaves: [card({ id: 's1', status: 'working', taskTitle: 'Add the thing', stepLabel: 'verifying', progressPct: 40, runId: 'r1' }), card({ id: 's2' }), card({ id: 's3', status: 'paused', taskTitle: 'Plan', progressPct: 10, runId: 'r3' })],
    tasks: { active: 1, ready: 2, blocked: 0, done: 3, failed: 0 },
    blocked: [],
    liveEvents: [],
    mergeQueue: [],
  } as unknown as OverviewSnapshot
  streamSnapshot = overview
  return {
    workspace: { id: 'w1', name: 'Checkout', archived },
    departments: [
      { teamId: 't1', name: 'Engineering', color: '#2ee6cf', slaves: [{ slaveId: 's1', name: 'Alex', role: 'backend', color: '#2ee6cf' }, { slaveId: 's2', name: 'Maya', role: 'qa', color: '#7b8cff' }] },
      { teamId: 't2', name: 'Product', color: '#7b8cff', slaves: [{ slaveId: 's3', name: 'John', role: 'analyst', color: '#c084fc' }] },
    ],
    overview,
  }
}

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))

beforeEach(() => {
  // `toFake` excludes `requestAnimationFrame`/`cancelAnimationFrame`: sinon's fake timers (vitest's
  // default `useFakeTimers()`) install their own fakes for those two and delete them again on
  // `useRealTimers()` — colliding with the `vi.spyOn` mocks below (installed after sinon's) and
  // leaving `window.cancelAnimationFrame` undefined from the second test on. `performance` stays
  // faked: the loop's frame delta (`now - last`, both from the mocked rAF's `performance.now()`)
  // has to advance in lockstep with the fake `setTimeout` clock for the 250 ms overlay refresh to
  // ever fire inside `vi.advanceTimersByTime` — a real, unfaked `performance.now()` barely moves
  // while fake timers fire synchronously, so `acc` never crosses `OVERLAY_MS`.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { setTimeout(() => cb(performance.now()), 16); return 1 })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  // jsdom has no canvas backend: `getContext('2d')` returns `null` on its own, but logs a
  // "not implemented" notice through its virtual console on every call — the loop calls it
  // every frame, so left alone the test output is anything but pristine. Mock it silent.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  Object.defineProperty(document, 'fonts', { value: { load: () => Promise.resolve([]) }, configurable: true })
  stubWorld.focusId = null
  stubWorld.hourLock = null
  applied.length = 0
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

async function mount(archived = false) {
  render(<OfficeClient workspaceId="w1" initial={snapshot(archived)} pixelFontFamily="__Silkscreen_test" />)
  await act(async () => {
    await Promise.resolve()
    vi.advanceTimersByTime(320)
  })
}

describe('OfficeClient', () => {
  it('feeds the world the stream snapshot and the wall clock, and shows the counts', async () => {
    await mount()
    expect(stubWorld.apply).toHaveBeenCalled()
    const [live, board] = applied[0] as [Map<string, { status: string }>, { todo: number }]
    expect(live.get('s1')?.status).toBe('working')
    expect(board.todo).toBe(2)
    expect(stubWorld.setWallClock).toHaveBeenCalled()
    expect(screen.getByTestId('office-hud-counts').textContent).toBe('2 departments · 3 slaves · 1 working')
    expect(screen.getByTestId('office-clock').textContent).toBe('10:00')
    expect(screen.getByTestId('office-tod').textContent).toBe('MORNING')
    expect(screen.getByTestId('office-stream').textContent).toContain('LIVE')
  })

  it('locks the hour from the slider and LIVE clears it', async () => {
    await mount()
    fireEvent.change(screen.getByTestId('office-hour'), { target: { value: '21' } })
    expect(stubWorld.hourLock).toBe(21)
    fireEvent.click(screen.getByTestId('office-live'))
    expect(stubWorld.hourLock).toBeNull()
  })

  it('zooms through the levels and labels them', async () => {
    await mount()
    expect(screen.getByTestId('office-zoom').textContent).toBe('1x')
    fireEvent.click(screen.getByTestId('office-zoom-in'))
    expect(stubWorld.view.li).toBe(1)
    await act(async () => { vi.advanceTimersByTime(320) })
    expect(screen.getByTestId('office-zoom').textContent).toBe('2x')
    fireEvent.click(screen.getByTestId('office-zoom-out'))
    expect(stubWorld.view.li).toBe(0)
  })

  it('focuses the first slave by default, shows its live task, and Next cycles', async () => {
    await mount()
    const focus = screen.getByTestId('office-focus')
    expect(focus.textContent).toContain('Alex')
    expect(focus.textContent).toContain('backend · Engineering')
    expect(focus.textContent).toContain('verifying')
    expect(focus.textContent).toContain('Add the thing')
    expect(screen.getByTestId('office-focus-pause').textContent).toBe('Pause')
    fireEvent.click(screen.getByTestId('office-focus-next'))
    await act(async () => { vi.advanceTimersByTime(320) })
    expect(screen.getByTestId('office-focus').textContent).toContain('Maya')
  })

  it('pauses, resumes and stops through the run routes; refusals stay on the card', async () => {
    await mount()
    await act(async () => { fireEvent.click(screen.getByTestId('office-focus-pause')) })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r1/pause', expect.objectContaining({ method: 'POST' }))
    await act(async () => { fireEvent.click(screen.getByTestId('office-focus-stop')) })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r1/stop', expect.objectContaining({ method: 'POST' }))

    stubWorld.focusId = 's3'
    await act(async () => { vi.advanceTimersByTime(320) })
    expect(screen.getByTestId('office-focus-pause').textContent).toBe('Resume')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'run r3 is not paused' }), { status: 409 }))
    await act(async () => { fireEvent.click(screen.getByTestId('office-focus-pause')) })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r3/resume', expect.objectContaining({ method: 'POST' }))
    expect(screen.getByTestId('office-focus-error').textContent).toBe('run r3 is not paused')
  })

  it('disables the run controls for a slave without a run and hides them on an archived project', async () => {
    await mount()
    stubWorld.focusId = 's2'
    await act(async () => { vi.advanceTimersByTime(320) })
    expect((screen.getByTestId('office-focus-pause') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('office-focus-stop') as HTMLButtonElement).disabled).toBe(true)
  })

  it('hides the run controls on an archived project', async () => {
    await mount(true)
    expect(screen.queryByTestId('office-focus-pause')).toBeNull()
    expect(screen.queryByTestId('office-focus-stop')).toBeNull()
    expect(screen.getByTestId('office-focus-next')).toBeTruthy()
  })

  // Spec §9's "a rebuilt world carries `view` and `focusId`" case, on the client: the shared
  // `stubWorld` above is one object, so it cannot show a *second* world inheriting from the
  // first. This test swaps in a small factory — `LiveOffice` returns a fresh world per call —
  // so the camera and the focus set on the first world can be asserted on the second.
  it('rebuilds the world when the roster changes, carrying the camera and the focus', async () => {
    const worlds: (typeof stubWorld)[] = []
    // The real `LiveOffice` carries private fields (`live`, `wallHour`, …) an object literal can
    // never structurally satisfy — same reason the file-wide stub above needs the cast built into
    // `vi.fn(() => stubWorld)`'s untyped `vi.mock` factory. Explicit here since `vi.mocked` checks
    // the implementation against the real class.
    vi.mocked(LiveOffice).mockImplementation(() => {
      const world = {
        ...stubWorld,
        view: { ...stubWorld.view },
        viewHits: [] as { id: string; x: number; y: number; w: number; h: number }[],
        focusId: null as string | null,
        apply: vi.fn(),
      }
      worlds.push(world)
      return world as unknown as LiveOffice
    })
    try {
      const first = snapshot()
      const { rerender } = render(<OfficeClient workspaceId="w1" initial={first} pixelFontFamily="__Silkscreen_test" />)
      await act(async () => {
        await Promise.resolve()
        vi.advanceTimersByTime(320)
      })
      // `worlds` (this test's own factory calls, not the mock's file-wide call count — the same
      // `vi.fn()` is shared with every other test above and never cleared between them) is the
      // count that means something here: one `LiveOffice` per world this test itself built.
      expect(worlds).toHaveLength(1)
      worlds[0]!.view.li = 2
      worlds[0]!.focusId = 's2'

      const grown: OfficeSnapshot = {
        ...snapshot(),
        departments: [
          { ...first.departments[0]!, slaves: [...first.departments[0]!.slaves, { slaveId: 's4', name: 'New', role: 'backend', color: '#f5b34a' }] },
          first.departments[1]!,
        ],
      }
      rerender(<OfficeClient workspaceId="w1" initial={grown} pixelFontFamily="__Silkscreen_test" />)
      await act(async () => {
        await Promise.resolve()
        vi.advanceTimersByTime(320)
      })
      expect(worlds).toHaveLength(2)
      expect(worlds[1]!.view.li).toBe(2)
      expect(worlds[1]!.focusId).toBe('s2')
    } finally {
      vi.mocked(LiveOffice).mockImplementation(() => stubWorld as unknown as LiveOffice)
    }
  })
})
