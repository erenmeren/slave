// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../src/components/Sidebar.js'
import { ActivityClient } from '../src/components/activity/ActivityClient.js'
import { TasksClient } from '../src/components/TasksClient.js'
import { TopBar } from '../src/components/TopBar.js'
import type { ActivityPage } from '../src/server/activity.js'
import type { TasksSnapshot } from '../src/server/tasks.js'

let pathname = '/w/w1'
const routerReplace = vi.fn()

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: routerReplace }),
  useSearchParams: () => new URLSearchParams(),
}))

const streamState = {
  events: [] as unknown[],
  connection: 'connected' as const,
  loadOlder: vi.fn(),
  loadingOlder: false,
  exhausted: false,
  sparkline: new Array(10).fill(0) as number[],
  error: null as string | null,
}

// `ActivityClient` is exercised below only for the halt-banner presence, so its live stream is
// stubbed out entirely (same shape as `activity-page.test.tsx`'s `streamState` mock) rather than
// wired to a real `EventSource` — `TasksClient` below takes the other precedent instead
// (`tasks-components.test.tsx`'s `FakeEventSource` + `fetch` stub), since `useTasks` has no
// dedicated mock to reach for.
vi.mock('../src/hooks/useActivityStream.js', () => ({
  useActivityStream: () => streamState,
}))

describe('the shell', () => {
  afterEach(() => {
    pathname = '/w/w1'
  })

  it('shows Overview as the current page and Tasks/Activity/Graph as live links', () => {
    render(<Sidebar workspaceId="w1" />)
    expect(screen.getByText('Overview')).toHaveProperty('ariaCurrent', 'page')
    expect(screen.getByText('Tasks').getAttribute('href')).toBe('/w/w1/tasks')
    expect(screen.getByText('Activity').getAttribute('href')).toBe('/w/w1/activity')
    expect(screen.getByText('Activity').getAttribute('aria-disabled')).toBeNull()
    // Graph went live in M7 (spec §7) — the roadmap's last inert item, now a real link like its
    // siblings, not the "present but disabled" chrome it used to render as.
    expect(screen.getByText('Graph').getAttribute('href')).toBe('/w/w1/graph')
    expect(screen.getByText('Graph').getAttribute('aria-disabled')).toBeNull()
  })

  it('marks Activity aria-current on the activity route', () => {
    pathname = '/w/w1/activity'
    render(<Sidebar workspaceId="w1" />)
    expect(screen.getByText('Activity')).toHaveProperty('ariaCurrent', 'page')
    expect(screen.getByText('Overview')).not.toHaveProperty('ariaCurrent', 'page')
  })

  it('marks Graph aria-current on the graph route', () => {
    pathname = '/w/w1/graph'
    render(<Sidebar workspaceId="w1" />)
    expect(screen.getByText('Graph')).toHaveProperty('ariaCurrent', 'page')
    expect(screen.getByText('Overview')).not.toHaveProperty('ariaCurrent', 'page')
  })

  it('always shows the global section (Projects/Agents/Settings)', () => {
    render(<Sidebar workspaceId="w1" />)
    expect(screen.getByText('Projects').getAttribute('href')).toBe('/')
    expect(screen.getByText('Agents')).toBeTruthy()
    expect(screen.getByText('Settings')).toBeTruthy()
  })

  it('renders only the global section when the pathname carries no workspaceId', () => {
    pathname = '/agents'
    render(<Sidebar />)
    expect(screen.getByText('Projects')).toBeTruthy()
    expect(screen.queryByTestId('project-section')).toBeNull()
  })

  it('renders both sections, deriving the workspaceId from the pathname, when one is present', () => {
    pathname = '/w/w1/tasks'
    render(<Sidebar />)
    expect(screen.getByText('Projects')).toBeTruthy()
    expect(screen.getByTestId('project-section')).toBeTruthy()
    expect(screen.getByText('Overview').getAttribute('href')).toBe('/w/w1')
    expect(screen.getByText('Tasks')).toHaveProperty('ariaCurrent', 'page')
  })

  it('turns the budget bar amber past 80% and red past 100%', () => {
    const { rerender } = render(
      <TopBar workspaceId="w1" workspaceName="W" connection="connected" budget={{ spentUsd: 85, budgetUsd: 100 }} halted={false} />,
    )
    expect(screen.getByTestId('budget').innerHTML).toContain('bg-status-warn')
    rerender(
      <TopBar workspaceId="w1" workspaceName="W" connection="connected" budget={{ spentUsd: 101, budgetUsd: 100 }} halted={false} />,
    )
    expect(screen.getByTestId('budget').innerHTML).toContain('bg-status-danger')
  })

  it('reports the connection state it was given', () => {
    render(<TopBar workspaceId="w1" workspaceName="W" connection="reconnecting" budget={null} halted={false} />)
    expect(screen.getByTestId('connection').textContent).toContain('reconnecting')
  })

  it('renders the emergency STOP button when the workspace is not halted', () => {
    render(<TopBar workspaceId="w1" workspaceName="W" connection="connected" budget={null} halted={false} />)
    const button = screen.getByTestId('emergency-stop')
    expect(button).toBeTruthy()
    expect(button.getAttribute('disabled')).toBeNull()
  })
})

describe('the halt banner shows on every page', () => {
  const HALT_REASON = 'the pause gate failed open (PreToolUse:Write exited 127)'

  // `Timeline` (inside `ActivityClient`) measures its scroll viewport via `@tanstack/react-virtual`,
  // which falls back to `offsetWidth`/`offsetHeight` when no `ResizeObserver` is present — jsdom has
  // neither by default. Same local mock as `activity-page.test.tsx`'s `mockElementSizes`.
  function mockElementSizes(): void {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
    HTMLElement.prototype.scrollTo = vi.fn()
  }

  beforeEach(() => {
    mockElementSizes()
  })

  it('TasksClient renders the reason as a role="alert" banner', () => {
    // `useTasks` (via `useWorkspaceStream`) opens a real `EventSource` and fetches on open — same
    // stub shape as `tasks-components.test.tsx`'s `FakeEventSource`.
    class FakeEventSource {
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onopen: (() => void) | null = null
      close(): void {}
    }
    const snapshot: TasksSnapshot = { workspace: { id: 'w1', name: 'W', haltedReason: HALT_REASON }, tasks: [] }
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200 })))

    render(<TasksClient workspaceId="w1" initial={snapshot} />)

    expect(screen.getByRole('alert').textContent).toContain(HALT_REASON)

    vi.unstubAllGlobals()
  })

  it('ActivityClient renders the reason as a role="alert" banner', () => {
    const initial: ActivityPage = {
      workspace: { id: 'w1', name: 'W', haltedReason: HALT_REASON },
      events: [],
      nextBefore: null,
      sparkline: new Array(10).fill(0),
      agents: [],
      tasks: [],
    }

    render(<ActivityClient workspaceId="w1" initial={initial} />)

    expect(screen.getByRole('alert').textContent).toContain(HALT_REASON)
  })
})
