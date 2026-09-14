// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarTree } from '../src/components/shell/SidebarTree.js'
import { ThemeProvider } from '../src/components/theme/ThemeProvider.js'
import type { ShellFacts } from '../src/server/shell.js'
import type { SidebarProject } from '../src/server/sidebar.js'

let pathname = '/'
/** The query string the mocked `useSearchParams` answers from -- `/analytics?workspace=<id>` is a
 *  project route with no `/w/<id>` in its path, and the tree reads it (ruling T3-2). */
let search = ''

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}))

/** What the open project's page has published, if anything. A new object is a WAKE-UP: the tree's
 *  refetch effect depends on this value's identity, which is what the throttle cases below move. */
let facts: ShellFacts | null = null

vi.mock('../src/hooks/useShellFacts', () => ({ useShellFacts: () => facts }))
vi.mock('../src/hooks/useStreamState', () => ({ useStreamState: () => null }))

/** One published snapshot. The figures are irrelevant to the tree -- only the object's identity is
 *  -- but it is the real shape, so a widened `ShellFacts` fails here rather than drifting. */
function snapshot(): ShellFacts {
  return {
    workspace: { id: 'w1', name: 'Checkout rewrite' },
    counts: { slavesWorking: 1, tasksActive: 5, slavesPaused: 0 },
    guardrails: { budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 3_600_000, maxAttempts: 3 },
    status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: null },
  }
}

const PROJECTS: readonly SidebarProject[] = [
  { id: 'w1', name: 'Checkout rewrite', archived: false, status: 'needs_you', statusLabel: 'WAITING FOR YOU', needsYouCount: 2, tasksActive: 5 },
  { id: 'w2', name: 'Billing API', archived: false, status: 'working', statusLabel: 'WORKING', needsYouCount: 0, tasksActive: 9 },
]

function tree(): React.JSX.Element {
  return (
    <ThemeProvider>
      <SidebarTree initial={PROJECTS} />
    </ThemeProvider>
  )
}

function renderTree(): ReturnType<typeof render> {
  return render(tree())
}

/** Re-render against whatever `pathname`, `search` and `facts` now say, and let the effect's own
 *  promise settle inside `act` -- otherwise a `setProjects` landing after the test body would be a
 *  React warning in an otherwise clean run. */
async function rerenderTree(result: ReturnType<typeof render>): Promise<void> {
  await act(async (): Promise<void> => {
    result.rerender(tree())
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach((): void => {
  pathname = '/'
  search = ''
  facts = null
  fetchMock = vi.fn(async () => new Response(JSON.stringify(PROJECTS), { status: 200 }))
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach((): void => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

describe('the sidebar tree', () => {
  it('is the Primary navigation landmark, and the skip link still comes first', () => {
    renderTree()
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    const skip = screen.getByTestId('skip-link')
    expect(skip.getAttribute('href')).toBe('#main')
    expect(skip.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('lists one row per project, with its raw state on the node and its word in the title', () => {
    renderTree()
    const rows = screen.getAllByTestId('sidebar-project')
    expect(rows.map((row) => row.getAttribute('data-project-id'))).toEqual(['w1', 'w2'])
    expect(rows[0]?.getAttribute('data-status')).toBe('needs_you')
    expect(rows[0]?.getAttribute('title')).toBe('WAITING FOR YOU')
    expect(rows[0]?.textContent).toContain('Checkout rewrite')
  })

  it('shows the needs-you count only where there is one', () => {
    renderTree()
    const counts = screen.getAllByTestId('sidebar-needs-you')
    expect(counts).toHaveLength(1)
    expect(counts[0]?.textContent).toBe('2')
  })

  it('nests the six sections under the CURRENT project only', () => {
    pathname = '/w/w1/tasks'
    renderTree()
    const sections = screen.getAllByTestId('sidebar-section')
    expect(sections.map((row) => row.getAttribute('data-section'))).toEqual([
      'overview', 'tasks', 'organization', 'knowledge', 'activity', 'settings',
    ])
    // The labels are the README's, and `organization` is called Team.
    expect(sections.map((row) => row.textContent?.replace(/\d+$/, '').trim())).toEqual([
      'Overview', 'Tasks', 'Team', 'Knowledge', 'Activity', 'Settings',
    ])
    expect(sections[1]?.getAttribute('aria-current')).toBe('page')
    expect(sections[0]?.getAttribute('aria-current')).toBeNull()
  })

  it('nests nothing when no project is open', () => {
    pathname = '/workforce'
    renderTree()
    expect(screen.queryAllByTestId('sidebar-section')).toEqual([])
    expect(screen.queryAllByTestId('sidebar-view')).toEqual([])
  })

  it('renders the three VIEWS chips under the open project -- what Advanced held (R11)', () => {
    pathname = '/w/w1/graph'
    renderTree()
    const views = screen.getAllByTestId('sidebar-view')
    expect(views.map((chip) => chip.getAttribute('data-view'))).toEqual(['graph', 'office', 'analytics'])
    expect(views.map((chip) => chip.getAttribute('href'))).toEqual([
      '/w/w1/graph', '/w/w1/office', '/analytics?workspace=w1',
    ])
    expect(views[0]?.getAttribute('aria-current')).toBe('page')
  })

  it('keeps the three global rows, with the data-nav contract nav-row used to carry', () => {
    renderTree()
    const globals = screen.getAllByTestId('sidebar-global')
    expect(globals.map((row) => row.getAttribute('data-nav'))).toEqual(['Workforce', 'Simulations', 'Settings'])
    expect(globals.map((row) => row.getAttribute('href'))).toEqual(['/workforce', '/sim', '/settings'])
    expect(globals.every((row) => (row.getAttribute('aria-label') ?? '') !== '')).toBe(true)
  })

  it('marks Workforce current on the two routes that redirect into it', () => {
    pathname = '/skills'
    renderTree()
    const workforce = screen.getAllByTestId('sidebar-global').find((row) => row.getAttribute('data-nav') === 'Workforce')
    expect(workforce?.getAttribute('aria-current')).toBe('page')
  })

  it('shows the live chip, saying "—" when no page has published a stream yet', () => {
    renderTree()
    const live = screen.getByTestId('sidebar-live')
    expect(live.textContent).toContain('live')
    expect(live.textContent).toContain('—')
  })

  it('carries the theme pill, and the pill says which mode it is in', () => {
    renderTree()
    const pill = screen.getByTestId('theme-toggle')
    expect(pill.getAttribute('data-theme-mode')).toBe('system')
    expect(pill.textContent).toContain('System')
  })

  it('is 236px wide -- the README number (R4)', () => {
    // Class string, not computed style: jsdom loads no CSS. gate:m57-ui-redesign reads it back.
    renderTree()
    expect(screen.getByRole('navigation', { name: 'Primary' }).className).toContain('w-[236px]')
  })

  it('renders the ⌘K field, inert this milestone and marked so', () => {
    renderTree()
    const field = screen.getByTestId('sidebar-search')
    expect(field.textContent).toContain('⌘K')
    expect(field.getAttribute('aria-disabled')).toBe('true')
  })

  it('keeps the project open on /analytics?workspace=<id>, and lights the Analytics chip alone', () => {
    pathname = '/analytics'
    search = '?workspace=w1'
    renderTree()
    // The route has no `/w/w1` in it, so only the query string can say which project this is.
    expect(screen.getAllByTestId('sidebar-project').map((row) => row.getAttribute('aria-current'))).toEqual([
      'page',
      null,
    ])
    const views = screen.getAllByTestId('sidebar-view')
    expect(views.map((chip) => chip.getAttribute('data-view'))).toEqual(['graph', 'office', 'analytics'])
    expect(views.map((chip) => chip.getAttribute('aria-current'))).toEqual([null, null, 'page'])
    // A view is beside the sections, not one of them: no section row is current on this route.
    expect(screen.getAllByTestId('sidebar-section').map((row) => row.getAttribute('aria-current'))).toEqual(
      new Array(6).fill(null),
    )
  })
})

describe("the sidebar tree's refetching (ruling P16)", () => {
  it('asks for nothing on mount: `initial` IS the server read from this same request', async () => {
    const result = renderTree()
    await rerenderTree(result)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refetches immediately on a route change -- once, not once per render', async () => {
    const result = renderTree()
    pathname = '/w/w1'
    await rerenderTree(result)
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/sidebar'])
    // A second render on the SAME route is not a second navigation.
    await rerenderTree(result)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('makes two facts wake-ups inside the ten-second window wait their turn', async () => {
    vi.useFakeTimers()
    pathname = '/w/w1'
    const result = renderTree()
    vi.advanceTimersByTime(1_000)
    facts = snapshot()
    await rerenderTree(result)
    vi.advanceTimersByTime(1_000)
    facts = snapshot()
    await rerenderTree(result)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('lets a facts wake-up through once the window has passed', async () => {
    vi.useFakeTimers()
    pathname = '/w/w1'
    const result = renderTree()
    vi.advanceTimersByTime(10_001)
    facts = snapshot()
    await rerenderTree(result)
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/sidebar'])
  })
})

describe('the sidebar tree on /login (ruling T3-3)', () => {
  it('renders the frame with an empty root: no projects, no row lit, and no request for a tree', async () => {
    pathname = '/login'
    const result = renderTree()
    expect(screen.queryAllByTestId('sidebar-project')).toEqual([])
    expect(screen.getAllByTestId('sidebar-global').map((row) => row.getAttribute('aria-current'))).toEqual([
      null,
      null,
      null,
    ])
    // A facts wake-up on this route asks for nothing either.
    facts = snapshot()
    await rerenderTree(result)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks for nothing when a route change lands ON /login -- a sign-out is not a refetch', async () => {
    const result = renderTree()
    pathname = '/login'
    await rerenderTree(result)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
