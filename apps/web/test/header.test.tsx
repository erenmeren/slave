// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Header } from '../src/components/shell/Header.js'
import { HeaderActionProvider, useHeaderAction } from '../src/components/shell/HeaderActionProvider.js'
import type { ShellFacts } from '../src/server/shell.js'

let pathname = '/w/w1/tasks'
let facts: ShellFacts | null = null

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('../src/hooks/useShellFacts', () => ({ useShellFacts: () => facts }))

function shellFacts(overrides: Partial<ShellFacts['status']> = {}, counts: Partial<ShellFacts['counts']> = {}): ShellFacts {
  return {
    workspace: { id: 'w1', name: 'Checkout rewrite' },
    counts: { slavesWorking: 2, tasksActive: 5, slavesPaused: 0, ...counts },
    guardrails: { budgetUsd: 40, maxConcurrentRuns: 3, runTimeoutMs: 3_600_000, maxAttempts: 3 },
    status: { goal: 'Ship it', spentUsd: 12.4, unmeasuredRuns: 0, haltedReason: null, ...overrides },
  }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach((): void => {
  pathname = '/w/w1/tasks'
  facts = shellFacts()
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach((): void => {
  vi.unstubAllGlobals()
})

const PROJECTS = [
  { id: 'w1', name: 'Checkout rewrite', archived: false, status: 'working' as const, statusLabel: 'WORKING', needsYouCount: 0, tasksActive: 5 },
]

function renderHeader(): void {
  render(<HeaderActionProvider><Header projects={PROJECTS} /></HeaderActionProvider>)
}

describe('the header', () => {
  it('reads Projects / <project> / <section>, with only the last emphasised', () => {
    renderHeader()
    const crumb = screen.getByTestId('breadcrumb')
    expect(crumb.getAttribute('data-crumbs')).toBe('Projects/Checkout rewrite/Tasks')
    expect(crumb.textContent).toContain('Checkout rewrite')
  })

  it('is 54px tall -- the README number (R7)', () => {
    renderHeader()
    expect(screen.getByTestId('app-header').className).toContain('h-[54px]')
  })

  it('shows the money and the bar, and keeps the budget testids the gates pin', () => {
    renderHeader()
    expect(screen.getByTestId('budget').textContent).toContain('$12.40')
    expect(screen.getByTestId('budget').textContent).toContain('$40.00')
  })

  it('draws no bar for an unbudgeted project -- a bar is a fraction of a ceiling', () => {
    facts = { ...shellFacts(), guardrails: { budgetUsd: null, maxConcurrentRuns: 3, runTimeoutMs: 1, maxAttempts: 3 } }
    renderHeader()
    expect(screen.queryByTestId('budget-bar')).toBeNull()
  })

  it('names the unmeasured runs beside the figure', () => {
    facts = shellFacts({ unmeasuredRuns: 2 })
    renderHeader()
    expect(screen.getByTestId('budget-unmeasured').textContent).toContain('2 unmeasured')
  })

  it('says Pause all while anything is working, and Resume all once everything is paused', () => {
    renderHeader()
    expect(screen.getByTestId('pause-all').textContent).toBe('Pause all')
    facts = shellFacts({}, { slavesWorking: 0, slavesPaused: 3 })
    renderHeader()
    expect(screen.getAllByTestId('pause-all').at(-1)?.textContent).toBe('Resume all')
  })

  it('arms the stop on the first click and fires on the second', () => {
    renderHeader()
    const stop = screen.getByTestId('stop-split')
    expect(stop.getAttribute('data-armed')).toBe('false')
    expect(screen.queryByTestId('stop-cancel')).toBeNull()

    act((): void => { stop.click() })
    expect(screen.getByTestId('stop-split').getAttribute('data-armed')).toBe('true')
    expect(screen.getByTestId('stop-split').textContent).toBe('Stop everything')
    expect(screen.getByTestId('stop-cancel')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()

    act((): void => { screen.getByTestId('stop-split').click() })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/emergency-stop', expect.objectContaining({ method: 'POST' }))
  })

  it('disarms on Cancel without firing', () => {
    renderHeader()
    act((): void => { screen.getByTestId('stop-split').click() })
    act((): void => { screen.getByTestId('stop-cancel').click() })
    expect(screen.getByTestId('stop-split').getAttribute('data-armed')).toBe('false')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the HALTED pill and offers Clear halt instead of Stop while halted', () => {
    facts = shellFacts({ haltedReason: 'emergency stop by eren' })
    renderHeader()
    expect(screen.getByTestId('halted-pill').textContent).toContain('HALTED')
    const stop = screen.getByTestId('stop-split')
    expect(stop.textContent).toBe('Clear halt')
    act((): void => { stop.click() })
    // One click, no arming: clearing a halt is not destructive.
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/clear-halt', expect.objectContaining({ method: 'POST' }))
  })

  it('posts pause-all and resume-all to their own routes', () => {
    renderHeader()
    act((): void => { screen.getByTestId('pause-all').click() })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/pause-all', expect.objectContaining({ method: 'POST' }))
  })

  it('renders no project cluster at all on a global route', () => {
    pathname = '/workforce'
    facts = null
    renderHeader()
    expect(screen.getByTestId('breadcrumb').getAttribute('data-crumbs')).toBe('Workforce')
    expect(screen.queryByTestId('budget')).toBeNull()
    expect(screen.queryByTestId('pause-all')).toBeNull()
    expect(screen.queryByTestId('stop-split')).toBeNull()
  })

  it('renders whatever a page put in the action slot, and nothing when a page put nothing', () => {
    renderHeader()
    expect(screen.queryByTestId('header-action')).toBeNull()
    render(
      <HeaderActionProvider>
        <Header projects={PROJECTS} />
        <SetsAction />
      </HeaderActionProvider>,
    )
    expect(screen.getAllByTestId('header-action').at(-1)?.textContent).toBe('+ New project')
  })

  it('names the project on a route whose page publishes no ShellFacts (spec erratum E12)', () => {
    pathname = '/w/w1/organization'
    facts = null
    renderHeader()
    // The name comes from the TREE, so it is there even though nothing published.
    expect(screen.getByTestId('breadcrumb').getAttribute('data-crumbs')).toBe('Projects/Checkout rewrite/Team')
  })
})

/** A page that declares a header action, the way `ProjectsClient` will. `useHeaderAction` is a
 *  static import at the top of this file (scan finding 17): `require` is not defined in a vitest
 *  ESM module and threw a `ReferenceError` in the draft of this plan. */
function SetsAction(): null {
  useHeaderAction(<button type="button">+ New project</button>, [])
  return null
}
