// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarTree } from '../src/components/shell/SidebarTree.js'
import { ThemeProvider } from '../src/components/theme/ThemeProvider.js'
import type { SidebarProject } from '../src/server/sidebar.js'

let pathname = '/'

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('../src/hooks/useShellFacts', () => ({ useShellFacts: () => null }))
vi.mock('../src/hooks/useStreamState', () => ({ useStreamState: () => null }))

const PROJECTS: readonly SidebarProject[] = [
  { id: 'w1', name: 'Checkout rewrite', archived: false, status: 'needs_you', statusLabel: 'WAITING FOR YOU', needsYouCount: 2, tasksActive: 5 },
  { id: 'w2', name: 'Billing API', archived: false, status: 'working', statusLabel: 'WORKING', needsYouCount: 0, tasksActive: 9 },
]

function renderTree(): void {
  render(
    <ThemeProvider>
      <SidebarTree initial={PROJECTS} />
    </ThemeProvider>,
  )
}

beforeEach((): void => {
  pathname = '/'
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PROJECTS), { status: 200 })))
})

afterEach((): void => {
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
    const search = screen.getByTestId('sidebar-search')
    expect(search.textContent).toContain('⌘K')
    expect(search.getAttribute('aria-disabled')).toBe('true')
  })
})
