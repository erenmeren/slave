// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../src/components/Sidebar.js'
import { ActivityClient } from '../src/components/activity/ActivityClient.js'
import { TasksClient } from '../src/components/TasksClient.js'
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
  latencyMs: null as number | null,
}

// `ActivityClient` is exercised below only for the halt-banner presence, so its live stream is
// stubbed out entirely (same shape as `activity-page.test.tsx`'s `streamState` mock) rather than
// wired to a real `EventSource` — `TasksClient` below takes the other precedent instead
// (`tasks-components.test.tsx`'s `FakeEventSource` + `fetch` stub), since `useTasks` has no
// dedicated mock to reach for.
vi.mock('../src/hooks/useActivityStream.js', () => ({
  useActivityStream: () => streamState,
}))

vi.mock('../src/hooks/useStreamState', () => ({ publishStreamState: vi.fn() }))

/** Minimal `EventSource` stand-in (`tasks-components.test.tsx`'s precedent) — still needed by the
 *  `TasksClient` halt-banner case below, which streams for real. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  close(): void {}
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach((): void => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach((): void => {
  vi.unstubAllGlobals()
})

/** A nav row by its label. */
function navRow(label: string): HTMLElement {
  const row = screen.getAllByTestId('nav-row').find((element) => element.getAttribute('data-nav') === label)
  if (row === undefined) throw new Error(`no nav row labelled ${label}`)
  return row
}

describe('the shell', () => {
  afterEach(() => {
    pathname = '/w/w1'
  })

  it('renders the four global rows in order: Projects, Workforce, Simulations, Settings (M44 R1)', () => {
    render(<Sidebar />)
    const labels = screen.getAllByTestId('nav-row').map((row) => row.getAttribute('data-nav'))
    expect(labels).toEqual(['Projects', 'Workforce', 'Simulations', 'Settings'])
    expect(navRow('Workforce').getAttribute('href')).toBe('/workforce')
    expect(navRow('Simulations').getAttribute('href')).toBe('/sim')
    expect(navRow('Settings').getAttribute('href')).toBe('/settings')
  })

  it('has no Slaves, Skills or Analytics row -- they are a Workforce tab, a Workforce tab and a Projects section now', () => {
    render(<Sidebar />)
    const labels = screen.getAllByTestId('nav-row').map((row) => row.getAttribute('data-nav'))
    expect(labels).not.toContain('Slaves')
    expect(labels).not.toContain('Skills')
    expect(labels).not.toContain('Analytics')
  })

  it('marks Workforce current on /workforce and on the routes that redirect into it', () => {
    pathname = '/workforce'
    const { rerender } = render(<Sidebar />)
    expect(navRow('Workforce')).toHaveProperty('ariaCurrent', 'page')
    pathname = '/slaves'
    rerender(<Sidebar />)
    expect(navRow('Workforce')).toHaveProperty('ariaCurrent', 'page')
    pathname = '/skills'
    rerender(<Sidebar />)
    expect(navRow('Workforce')).toHaveProperty('ariaCurrent', 'page')
  })

  it('marks Projects current on /, on /w/:id/... and on /analytics -- analytics is a Projects fact', () => {
    pathname = '/'
    const { rerender } = render(<Sidebar />)
    expect(navRow('Projects')).toHaveProperty('ariaCurrent', 'page')
    pathname = '/w/w1/tasks'
    rerender(<Sidebar />)
    expect(navRow('Projects')).toHaveProperty('ariaCurrent', 'page')
    pathname = '/analytics'
    rerender(<Sidebar />)
    expect(navRow('Projects')).toHaveProperty('ariaCurrent', 'page')
  })

  it('marks Settings current on the settings route', () => {
    pathname = '/settings'
    render(<Sidebar />)
    expect(navRow('Settings')).toHaveProperty('ariaCurrent', 'page')
    expect(navRow('Projects')).not.toHaveProperty('ariaCurrent', 'page')
  })

  it('is 212px wide at full width and collapses to a 52px icon rail below 900px (M44 R3/R6)', () => {
    render(<Sidebar />)
    // Class strings, not computed style: jsdom loads no CSS. gate:m44-ux-foundation reads the real
    // widths back at 1440px and at 800px.
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(nav.className).toContain('w-[212px]')
    expect(nav.className).toContain('max-[899px]:w-[52px]')
  })

  it('gives every row an accessible name that survives the collapse', () => {
    render(<Sidebar />)
    expect(navRow('Workforce').getAttribute('aria-label')).toBe('Workforce')
    expect(navRow('Workforce').getAttribute('title')).toBe('Workforce')
    // The collapsed rail shows one letter; the full label is hidden below 900px, not deleted.
    expect(navRow('Workforce').textContent).toContain('Workforce')
  })

  it('puts a skip link first, before the nav, pointing at the one main landmark', () => {
    render(<Sidebar />)
    const skip = screen.getByTestId('skip-link')
    expect(skip.getAttribute('href')).toBe('#main')
    expect(skip.textContent).toBe('Skip to content')
    expect(skip.compareDocumentPosition(screen.getByRole('navigation', { name: 'Primary' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('marks the selected row with the handoff selected surface and its teal rail', () => {
    // Class string, not computed style (jsdom loads no CSS): `bg-bg-selected` is spec §3's
    // "selected" surface token and the `inset 2px 0 0` rail is the mockup's own. The gate reads
    // both back.
    pathname = '/w/w1'
    render(<Sidebar />)
    expect(navRow('Projects').className).toContain('bg-bg-selected')
    expect(navRow('Projects').className).toContain('inset_2px_0_0')
    expect(navRow('Workforce').className).not.toContain('bg-bg-selected')
  })

  it('renders no project section, no nav badges and no guardrail figures -- those live in the project header and tabs now (M24 §2.2)', () => {
    pathname = '/w/w1/tasks'
    render(<Sidebar />)
    expect(screen.queryByTestId('project-section')).toBeNull()
    expect(screen.queryAllByTestId(/^nav-badge-/)).toEqual([])
    expect(screen.queryAllByTestId(/^guardrail-/)).toEqual([])
  })

  it('renders nothing on /login -- the shell is a logged-in surface', () => {
    pathname = '/login'
    const { container } = render(<Sidebar />)
    expect(container.innerHTML).toBe('')
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
    // `useTasks` (via `useWorkspaceStream`) opens a real `EventSource` and fetches on open — the
    // file-level `FakeEventSource` + `fetch` stubs cover both; this only pins the body.
    const snapshot: TasksSnapshot = {
      workspace: { id: 'w1', name: 'W', haltedReason: HALT_REASON, goalVersion: 0 },
      shellFacts: {
        workspace: { id: 'w1', name: 'W' },
        counts: { slavesWorking: 0, tasksActive: 0 },
        guardrails: { budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 3_600_000, maxAttempts: 3 },
        status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: HALT_REASON },
      },
      tasks: [],
    }
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(snapshot), { status: 200 }))

    render(<TasksClient workspaceId="w1" initial={snapshot} />)

    expect(screen.getByRole('alert').textContent).toContain(HALT_REASON)
  })

  it('ActivityClient renders the reason as a role="alert" banner', () => {
    const initial: ActivityPage = {
      workspace: { id: 'w1', name: 'W', haltedReason: HALT_REASON },
      events: [],
      nextBefore: null,
      sparkline: new Array(10).fill(0),
      slaves: [],
      tasks: [],
      users: [],
      // M14 Task 12 widenings: the right rail's 24h volumes, and the shell facts this page
      // publishes to `hooks/useShellFacts.ts` for the project header and the Tasks tab's badge.
      typeVolumes: [],
      shellFacts: {
        workspace: { id: 'w1', name: 'W' },
        counts: { slavesWorking: 0, tasksActive: 0 },
        guardrails: { budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 3_600_000, maxAttempts: 3 },
        status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: HALT_REASON },
      },
    }

    render(<ActivityClient workspaceId="w1" initial={initial} />)

    expect(screen.getByRole('alert').textContent).toContain(HALT_REASON)
  })
})
