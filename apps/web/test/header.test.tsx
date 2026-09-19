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
  { id: 'w2', name: 'Billing', archived: false, status: 'idle' as const, statusLabel: 'IDLE', needsYouCount: 0, tasksActive: 0 },
]

/** A FRESH element every call, deliberately: `rerender` with the same element object is a React
 *  bailout -- the subtree is skipped entirely and `usePathname()` is never read again, so a
 *  navigation case would silently assert nothing. */
function tree(): React.JSX.Element {
  return (
    <HeaderActionProvider>
      <Header projects={PROJECTS} />
    </HeaderActionProvider>
  )
}

/** Returns the render result so a case can `rerender` -- which is what a NAVIGATION is for this
 *  component: the root layout keeps it mounted, only the pathname moves. */
function renderHeader(): ReturnType<typeof render> {
  return render(tree())
}

describe('the header', () => {
  it('reads Projects / <project> / <tab>, with only the last emphasised', () => {
    renderHeader()
    const crumb = screen.getByTestId('breadcrumb')
    expect(crumb.getAttribute('data-crumbs')).toBe('Projects/Checkout rewrite/Work')
    expect(crumb.textContent).toContain('Checkout rewrite')
  })

  it('is 48px tall -- the README number (M57 R7, M61 R6)', () => {
    renderHeader()
    expect(screen.getByTestId('app-header').className).toContain('h-[48px]')
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
    expect(fetchMock).toHaveBeenLastCalledWith('/api/w/w1/runs/pause-all', expect.objectContaining({ method: 'POST' }))

    // The OTHER half of this case's name (fix round 1): the same button on an all-paused project
    // posts somewhere else, and a test that only ever saw `pause-all` could not have noticed.
    facts = shellFacts({}, { slavesWorking: 0, slavesPaused: 2 })
    renderHeader()
    act((): void => { screen.getAllByTestId('pause-all').at(-1)?.click() })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/w/w1/runs/resume-all', expect.objectContaining({ method: 'POST' }))
  })

  // Fix round 1, finding 2a. After an emergency stop every run settles to `paused`, so the split
  // button reads `Resume all` -- and `requestResume` refuses every one of them with
  // `workspace_halted`, which came back as a 200 carrying an empty report. The button is shut.
  it('will not offer to resume into a halt: the pause/resume half is disabled while halted', () => {
    facts = shellFacts({ haltedReason: 'emergency stop by eren' }, { slavesWorking: 0, slavesPaused: 3 })
    renderHeader()
    const button = screen.getByTestId('pause-all') as HTMLButtonElement
    expect(button.textContent).toBe('Resume all')
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toContain('Clear the safety halt first')

    act((): void => { button.click() })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Fix round 1, finding 2b. A fan-out that asked for nothing and was refused something is the one
  // shape a 200 can hide, and `postControl` threw the body away.
  it('says so when a fan-out comes back having requested nothing and refused something', async (): Promise<void> => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, requested: [], refused: ['r1'] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderHeader()
    await act(async (): Promise<void> => { screen.getByTestId('pause-all').click() })
    expect(screen.getByTestId('header-error').textContent).toContain('Nothing could be paused')
  })

  it('prefers the refusal a fan-out entry explains itself with, when one does', async (): Promise<void> => {
    fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, requested: [], refused: [{ error: 'this project is halted' }] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderHeader()
    await act(async (): Promise<void> => { screen.getByTestId('pause-all').click() })
    expect(screen.getByTestId('header-error').textContent).toContain('this project is halted')
  })

  it('shows the server\'s own words for a refused control POST', async (): Promise<void> => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'this project is archived' }), { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    renderHeader()
    await act(async (): Promise<void> => { screen.getByTestId('pause-all').click() })
    const band = screen.getByTestId('header-error')
    expect(band.getAttribute('role')).toBe('alert')
    expect(band.textContent).toBe('this project is archived')
  })

  // Fix round 1, finding 3. The header is the ROOT layout's now, so a hop between two pages of one
  // project unmounts nothing and `workspaceId` never moves -- only the pathname does.
  it('disarms the stop on any navigation, not only on a change of project', () => {
    const view = renderHeader()
    act((): void => { screen.getByTestId('stop-split').click() })
    expect(screen.getByTestId('stop-cancel')).toBeTruthy()

    pathname = '/w/w1/settings'
    view.rerender(tree())

    expect(screen.queryByTestId('stop-cancel')).toBeNull()
    expect(screen.getByTestId('stop-split').getAttribute('data-armed')).toBe('false')
    expect(screen.getByTestId('pause-all').textContent).toBe('Pause all')
  })

  it('forgets a refusal on the way to another project', async (): Promise<void> => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'this project is archived' }), { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    const view = renderHeader()
    await act(async (): Promise<void> => { screen.getByTestId('pause-all').click() })
    expect(screen.getByTestId('header-error')).toBeTruthy()

    pathname = '/w/w2/tasks'
    view.rerender(tree())

    expect(screen.queryByTestId('header-error')).toBeNull()
  })

  // Fix round 1, finding 5: the thresholds had no test anywhere once `project-header.test.tsx` was
  // deleted. `data-tone` is the name; the fill's Tailwind class is a colour decision that may move.
  it('tones the budget bar at the 80% and 100% lines', () => {
    renderHeader()
    expect(screen.getByTestId('budget-bar').getAttribute('data-tone')).toBe('ok')

    facts = shellFacts({ spentUsd: 36 })
    renderHeader()
    expect(screen.getAllByTestId('budget-bar').at(-1)?.getAttribute('data-tone')).toBe('near')

    facts = shellFacts({ spentUsd: 44 })
    renderHeader()
    expect(screen.getAllByTestId('budget-bar').at(-1)?.getAttribute('data-tone')).toBe('over')
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
    // The name comes from the TREE, so it is there even though nothing published. `/organization`
    // reads the same as the bare project route -- Team is the project's own page, so no third
    // crumb (same rule Overview/Team had).
    expect(screen.getByTestId('breadcrumb').getAttribute('data-crumbs')).toBe('Projects/Checkout rewrite')
  })
})

/** A page that declares a header action, the way `ProjectsClient` will. `useHeaderAction` is a
 *  static import at the top of this file (scan finding 17): `require` is not defined in a vitest
 *  ESM module and threw a `ReferenceError` in the draft of this plan. */
function SetsAction(): null {
  useHeaderAction(<button type="button">+ New project</button>, [])
  return null
}
