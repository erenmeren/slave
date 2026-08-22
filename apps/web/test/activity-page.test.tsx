// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DomainEventType } from '@ai-team-os/db'
import type { ActivityEventRow, ActivityPage } from '../src/server/activity.js'

// ---- jsdom element-size mocks -----------------------------------------------------------------
// `@tanstack/react-virtual` measures the scroll viewport and each item via `offsetWidth`/
// `offsetHeight` (its own `getRect`/`measureElement` fallback, used whenever no `ResizeObserver`
// is present — jsdom has none by default, so this is the only measurement path exercised here).
// Kept local to this file per the Task 8 brief's jsdom note. `scrollTo` is stubbed too: jsdom
// doesn't implement `Element.prototype.scrollTo` at all, and the fix-round-1 mount-scroll
// (Critical 2) is observed by asserting this stub gets called.
function mockElementSizes(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
  HTMLElement.prototype.scrollTo = vi.fn()
}

let pathname = '/w/w1/activity'
const routerReplace = vi.fn()

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: routerReplace }),
  useSearchParams: () => new URLSearchParams(),
}))

// Captures the exact options object (and spies on the returned instance's `scrollToIndex`)
// `Timeline` hands to/gets from `useVirtualizer`, while still delegating to the real
// implementation underneath. Lets tests inspect `getItemKey`/`onChange` directly (fix-round-1
// Important 4 and 5), and confirm the mount-time scroll-to-bottom call itself (Critical 2)
// without going through `Element.scrollTo` — jsdom's `scrollHeight`/`clientHeight` never reflect
// rendered content (no layout engine), and `scrollToIndex(lastIndex, { align: 'end' })` resolves
// its offset via exactly those two real-DOM properties, so the *outcome* of that call is not
// jsdom-observable even though the call itself, and its arguments, are.
let capturedVirtualizerOptions: Record<string, unknown> | null = null
let capturedVirtualizerInstance: { scrollToIndex: (...args: unknown[]) => void } | null = null

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>()
  return {
    ...actual,
    useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) => {
      capturedVirtualizerOptions = options as unknown as Record<string, unknown>
      const instance = actual.useVirtualizer(options)
      if (capturedVirtualizerInstance !== instance) {
        vi.spyOn(instance, 'scrollToIndex')
      }
      capturedVirtualizerInstance = instance as unknown as { scrollToIndex: (...args: unknown[]) => void }
      return instance
    },
  }
})

interface StreamState {
  events: ActivityEventRow[]
  connection: 'connected' | 'reconnecting'
  loadOlder: ReturnType<typeof vi.fn>
  loadingOlder: boolean
  exhausted: boolean
  sparkline: number[]
  error: string | null
}

const streamState: StreamState = {
  events: [],
  connection: 'connected',
  loadOlder: vi.fn(),
  loadingOlder: false,
  exhausted: false,
  sparkline: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  error: null,
}

vi.mock('../src/hooks/useActivityStream.js', () => ({
  useActivityStream: () => streamState,
}))

const buildActivityPageMock = vi.fn()

vi.mock('../src/server/activity.js', () => ({
  buildActivityPage: (...args: unknown[]) => buildActivityPageMock(...args),
}))

function row(seq: number, overrides: Partial<ActivityEventRow> = {}): ActivityEventRow {
  return {
    seq,
    ts: `2026-08-22T10:00:${String(seq).padStart(2, '0')}.000Z`,
    type: 'task.created' as DomainEventType,
    actor: 'human',
    agentId: null,
    taskId: null,
    runId: null,
    payload: { title: `event ${seq}` },
    summary: `event ${seq}`,
    ...overrides,
  }
}

const INITIAL: ActivityPage = {
  workspace: { id: 'w1', name: 'Checkout Platform', haltedReason: null },
  events: [row(3), row(2), row(1)], // descending, as the server page returns it
  nextBefore: null,
  sparkline: [0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
  agents: [{ id: 'a1', name: 'Alex' }],
  tasks: [{ id: 't1', title: 'Add the thing' }],
}

/** Sets scroll geometry on an already-rendered element and fires a `scroll` event, the same
 *  "drive the container's scrollTop" technique the brief calls out. `writable: true` matters
 *  here (unlike the other two): real DOM `scrollTop` stays assignable after being set, and the
 *  fix-round-1 scroll-anchor correction (Important 3) does `el.scrollTop += delta`. */
function scrollTo(element: HTMLElement, state: { scrollTop: number; scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(element, 'scrollTop', { configurable: true, writable: true, value: state.scrollTop })
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: state.scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: state.clientHeight })
  fireEvent.scroll(element)
}

describe('ActivityClient', () => {
  let ActivityClient: (props: { workspaceId: string; initial: ActivityPage }) => ReactElement

  beforeEach(async () => {
    mockElementSizes()
    pathname = '/w/w1/activity'
    routerReplace.mockClear()
    capturedVirtualizerOptions = null
    capturedVirtualizerInstance = null
    streamState.events = [...INITIAL.events].reverse() // ascending, oldest first — matches useActivityStream's contract
    streamState.connection = 'connected'
    streamState.loadOlder = vi.fn()
    streamState.loadingOlder = false
    streamState.exhausted = false
    streamState.sparkline = [...INITIAL.sparkline]
    streamState.error = null
    ;({ ActivityClient } = await import('../src/components/activity/ActivityClient.js'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the seed events through their per-type cards, newest at the bottom', () => {
    render(<ActivityClient workspaceId="w1" initial={INITIAL} />)
    const cards = screen.getAllByTestId('activity-card')
    expect(cards).toHaveLength(3)
    expect(cards.map((card) => card.getAttribute('data-event-type'))).toEqual(['task.created', 'task.created', 'task.created'])
    // Ascending order: event 1 (oldest) first in the DOM, event 3 (newest) last — "newest at the bottom".
    expect(cards[0]?.textContent).toContain('10:00:01')
    expect(cards[2]?.textContent).toContain('10:00:03')
  })

  it('resolves agentName/taskTitle from the page roster for cards that carry an agent/task id', () => {
    streamState.events = [row(1, { agentId: 'a1', taskId: 't1' })]
    render(<ActivityClient workspaceId="w1" initial={INITIAL} />)
    expect(screen.getByTestId('agent-link').textContent).toBe('Alex')
    expect(screen.getByTestId('task-link').textContent).toBe('Add the thing')
  })

  it('wires TopBar workspace name + connection, FilterBar, and a sparkline slot', () => {
    streamState.connection = 'reconnecting'
    render(<ActivityClient workspaceId="w1" initial={INITIAL} />)
    expect(screen.getByText('Checkout Platform')).toBeTruthy()
    expect(screen.getByTestId('connection').textContent).toContain('reconnecting')
    expect(screen.getByTestId('filter-bar')).toBeTruthy()
    expect(screen.getByTestId('sparkline-slot').textContent).toContain('3')
  })

  it('stays pinned at the bottom by default — the "new events" badge never appears as events arrive', () => {
    const { rerender } = render(<ActivityClient workspaceId="w1" initial={INITIAL} />)
    expect(screen.queryByTestId('new-events-badge')).toBeNull()

    streamState.events = [...streamState.events, row(4)]
    rerender(<ActivityClient workspaceId="w1" initial={INITIAL} />)

    expect(screen.queryByTestId('new-events-badge')).toBeNull()
  })

  it('shows "↓ N new events" once scrolled away from the bottom, and clicking it re-pins', () => {
    const { rerender } = render(<ActivityClient workspaceId="w1" initial={INITIAL} />)
    const viewport = screen.getByTestId('timeline-viewport')

    // Scrolled well away from the bottom.
    act(() => {
      scrollTo(viewport, { scrollTop: 0, scrollHeight: 4000, clientHeight: 300 })
    })
    expect(screen.queryByTestId('new-events-badge')).toBeNull() // no new events yet, so no badge

    streamState.events = [...streamState.events, row(4)]
    rerender(<ActivityClient workspaceId="w1" initial={INITIAL} />)
    expect(screen.getByTestId('new-events-badge').textContent).toContain('1')

    streamState.events = [...streamState.events, row(5)]
    rerender(<ActivityClient workspaceId="w1" initial={INITIAL} />)
    expect(screen.getByTestId('new-events-badge').textContent).toContain('2')

    fireEvent.click(screen.getByTestId('new-events-badge'))
    expect(screen.queryByTestId('new-events-badge')).toBeNull()

    // Re-pinned: a further event must not bring the badge back.
    streamState.events = [...streamState.events, row(6)]
    rerender(<ActivityClient workspaceId="w1" initial={INITIAL} />)
    expect(screen.queryByTestId('new-events-badge')).toBeNull()
  })

  it('calls loadOlder exactly once per approach to the top', () => {
    render(<ActivityClient workspaceId="w1" initial={INITIAL} />)
    const viewport = screen.getByTestId('timeline-viewport')

    act(() => {
      scrollTo(viewport, { scrollTop: 5, scrollHeight: 4000, clientHeight: 300 })
    })
    expect(streamState.loadOlder).toHaveBeenCalledTimes(1)

    // Still near the top: no second call for the same approach.
    act(() => {
      scrollTo(viewport, { scrollTop: 2, scrollHeight: 4000, clientHeight: 300 })
    })
    expect(streamState.loadOlder).toHaveBeenCalledTimes(1)

    // Scrolls away from the top, then back — a second, distinct approach.
    act(() => {
      scrollTo(viewport, { scrollTop: 1000, scrollHeight: 4000, clientHeight: 300 })
    })
    act(() => {
      scrollTo(viewport, { scrollTop: 5, scrollHeight: 4000, clientHeight: 300 })
    })
    expect(streamState.loadOlder).toHaveBeenCalledTimes(2)
  })

  // ---- fix round 1 ------------------------------------------------------------------------

  it('Critical 2: positions the viewport at the newest row on mount, and mounting alone does not fire onNearTop or unpin', () => {
    render(<ActivityClient workspaceId="w1" initial={INITIAL} />)

    // The mount-time scroll-to-bottom the doc comment already claimed happens, but nothing
    // previously triggered — `INITIAL` carries 3 events (indices 0-2), so the newest is index 2.
    expect(capturedVirtualizerInstance?.scrollToIndex).toHaveBeenCalledWith(2, { align: 'end' })
    // Nothing about mounting itself should read as "near the top" or "scrolled away" — no scroll
    // event has fired yet.
    expect(streamState.loadOlder).not.toHaveBeenCalled()
    expect(screen.queryByTestId('new-events-badge')).toBeNull()
  })

  it('Critical 1: a loadOlder prepend does not inflate the "new events" badge', () => {
    const { rerender } = render(<ActivityClient workspaceId="w1" initial={INITIAL} />)
    const viewport = screen.getByTestId('timeline-viewport')

    act(() => {
      scrollTo(viewport, { scrollTop: 0, scrollHeight: 4000, clientHeight: 300 })
    })
    expect(screen.queryByTestId('new-events-badge')).toBeNull()

    // `loadOlder` landing a history page: older rows PREPENDED, the newest (tail) event unchanged.
    streamState.events = [row(-1), row(0), ...streamState.events]
    rerender(<ActivityClient workspaceId="w1" initial={INITIAL} />)

    expect(screen.queryByTestId('new-events-badge')).toBeNull()
  })

  it('Critical 1: a filter-change reset + reload does not inflate the "new events" badge', () => {
    const { rerender } = render(<ActivityClient workspaceId="w1" initial={INITIAL} />)
    const viewport = screen.getByTestId('timeline-viewport')

    act(() => {
      scrollTo(viewport, { scrollTop: 0, scrollHeight: 4000, clientHeight: 300 })
    })
    expect(screen.queryByTestId('new-events-badge')).toBeNull()

    // useActivityStream's filter-change handling: the buffer empties, then repopulates with a
    // fresh (unrelated-seq) filtered page — none of it is a live arrival.
    streamState.events = []
    rerender(<ActivityClient workspaceId="w1" initial={INITIAL} />)
    streamState.events = [row(10), row(11), row(12)]
    rerender(<ActivityClient workspaceId="w1" initial={INITIAL} />)

    expect(screen.queryByTestId('new-events-badge')).toBeNull()
  })

  it('Important 4: the virtualizer is keyed by event seq, not array index', () => {
    streamState.events = [row(1), row(2), row(3)]
    render(<ActivityClient workspaceId="w1" initial={INITIAL} />)

    expect(typeof capturedVirtualizerOptions?.['getItemKey']).toBe('function')
    const getItemKey = capturedVirtualizerOptions?.['getItemKey'] as (index: number) => unknown
    expect([getItemKey(0), getItemKey(1), getItemKey(2)]).toEqual([1, 2, 3])
  })

  it('Important 5: pinned re-derives from a virtualizer resize notification, not only from a scroll event', () => {
    const { rerender } = render(<ActivityClient workspaceId="w1" initial={INITIAL} />)
    const viewport = screen.getByTestId('timeline-viewport')

    // Geometry moves to "far from the bottom" WITHOUT a scroll event — the shape of a payload
    // `<details>` expanding below the fold and growing the true bottom.
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, writable: true, value: 0 })
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 4000 })
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 })
    act(() => {
      ;(capturedVirtualizerOptions?.['onChange'] as (() => void) | undefined)?.()
    })

    streamState.events = [...streamState.events, row(4)]
    rerender(<ActivityClient workspaceId="w1" initial={INITIAL} />)

    // Only observable if `pinned` actually flipped false from the resize-driven notification
    // alone — no `fireEvent.scroll` occurred anywhere in this test.
    expect(screen.getByTestId('new-events-badge').textContent).toContain('1')
  })

  // ---- fix round 2 ------------------------------------------------------------------------

  it('Fix round 2: disables the library\'s own first-measure scroll compensation (the prepend anchor is the sole writer for that case) while keeping its re-measure default (Important 5)', () => {
    render(<ActivityClient workspaceId="w1" initial={INITIAL} />)

    const instance = capturedVirtualizerInstance as unknown as {
      shouldAdjustScrollPositionOnItemSizeChange:
        | ((
            item: { start: number; size: number; key: unknown },
            delta: number,
            instance: {
              itemSizeCache: Map<unknown, number>
              scrollOffset: number | null
              scrollAdjustments: number
              scrollDirection: 'forward' | 'backward' | null
            },
          ) => boolean)
        | undefined
    }
    expect(typeof instance.shouldAdjustScrollPositionOnItemSizeChange).toBe('function')
    const predicate = instance.shouldAdjustScrollPositionOnItemSizeChange!

    const instanceStub = {
      itemSizeCache: new Map<unknown, number>(),
      scrollOffset: 1000,
      scrollAdjustments: 0,
      scrollDirection: null as 'forward' | 'backward' | null,
    }

    // First measure (key absent from `itemSizeCache`) of a row starting above the current scroll
    // offset — exactly the shape the library's own default WOULD compensate for. Must say no:
    // the prepend-anchor effect owns this case, summing every newly prepended row's height
    // itself, not one row's estimate-vs-measured delta.
    expect(predicate({ start: 0, size: 96, key: 'new-row' }, 504, instanceStub)).toBe(false)

    // Re-measure (key already cached) of a row entirely above the fold, not scrolling backward —
    // must match the library's own default: yes, compensate.
    instanceStub.itemSizeCache.set('existing-row', 96)
    expect(predicate({ start: 0, size: 96, key: 'existing-row' }, 504, instanceStub)).toBe(true)

    // Same re-measure shape, but scrolling backward — the library's default explicitly skips this.
    instanceStub.scrollDirection = 'backward'
    expect(predicate({ start: 0, size: 96, key: 'existing-row' }, 504, instanceStub)).toBe(false)

    // Re-measure of a row that only partly spans the fold (its end is below the scroll offset) —
    // the library's default only compensates a row ENTIRELY above the fold.
    instanceStub.scrollDirection = null
    expect(predicate({ start: 950, size: 96, key: 'existing-row' }, 504, instanceStub)).toBe(false)
  })
})

describe('Timeline scroll anchoring', () => {
  it('Important 3: a loadOlder prepend adjusts scrollTop by the grown total size, keeping the reading position stable', async () => {
    mockElementSizes()
    const { Timeline } = await import('../src/components/activity/Timeline.js')
    const initialEvents = [row(1), row(2), row(3)]

    const { rerender } = render(
      <Timeline
        events={initialEvents}
        workspaceId="w1"
        agentNameById={new Map()}
        taskTitleById={new Map()}
        onPinnedChange={vi.fn()}
        onNearTop={vi.fn()}
      />,
    )
    const viewport = screen.getByTestId('timeline-viewport')
    viewport.scrollTop = 500 // an arbitrary, scrolled-up-from-the-bottom baseline

    // `loadOlder` prepends two older rows; the tail (newest) event is unchanged.
    act(() => {
      rerender(
        <Timeline
          events={[row(-1), row(0), ...initialEvents]}
          workspaceId="w1"
          agentNameById={new Map()}
          taskTitleById={new Map()}
          onPinnedChange={vi.fn()}
          onNearTop={vi.fn()}
        />,
      )
    })

    // Every row measures uniformly at the mocked 600px `offsetHeight`, so the total grows by
    // exactly 2 rows' worth (1200px) — the expected `scrollTop` is deterministic.
    expect(viewport.scrollTop).toBe(500 + 1200)
  })
})

describe('the activity page route', () => {
  afterEach(() => {
    buildActivityPageMock.mockReset()
  })

  it('renders the 404 copy for an unknown workspace', async () => {
    buildActivityPageMock.mockResolvedValue(null)
    const { default: ActivityPageRoute } = await import('../src/app/w/[workspaceId]/activity/page.js')
    const element = await ActivityPageRoute({ params: Promise.resolve({ workspaceId: 'nope' }) })
    render(element)
    expect(screen.getByText(/no workspace with id nope/)).toBeTruthy()
  })

  it('renders ActivityClient when the workspace exists', async () => {
    mockElementSizes()
    buildActivityPageMock.mockResolvedValue(INITIAL)
    const { default: ActivityPageRoute } = await import('../src/app/w/[workspaceId]/activity/page.js')
    const element = await ActivityPageRoute({ params: Promise.resolve({ workspaceId: 'w1' }) })
    render(element)
    expect(screen.getByText('Checkout Platform')).toBeTruthy()
  })
})
