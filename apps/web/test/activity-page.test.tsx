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
// Kept local to this file per the Task 8 brief's jsdom note.
function mockElementSizes(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
}

let pathname = '/w/w1/activity'
const routerReplace = vi.fn()

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: routerReplace }),
  useSearchParams: () => new URLSearchParams(),
}))

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
 *  "drive the container's scrollTop" technique the brief calls out. */
function scrollTo(element: HTMLElement, state: { scrollTop: number; scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(element, 'scrollTop', { configurable: true, value: state.scrollTop })
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
