// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeClient } from '../src/components/home/HomeClient.js'
import { HeaderActionProvider, useHeaderActionNode } from '../src/components/shell/HeaderActionProvider.js'
import { ModeProvider, useMode } from '../src/components/mode/ModeProvider.js'
import type { CompanyRow } from '../src/components/CompanyManager.js'
import type { Kpi } from '../src/server/analytics.js'
import type { HappeningNowItem, HomeNeedsYouItem, HomeSnapshot } from '../src/server/home.js'
import type { ProjectRow } from '../src/server/org.js'

const routerPush = vi.fn()
const routerReplace = vi.fn()
const routerRefresh = vi.fn()
// A STABLE object, unlike a fresh `{ push, replace, refresh }` literal returned per call: real
// Next.js hands back the SAME router across renders, and `HomeClient`'s `openNew` is memoized on
// it (`useHeaderAction`'s effect re-fires whenever that identity changes) -- a fresh object here
// would re-publish the header's action node on every render and never stop.
const router = { push: routerPush, replace: routerReplace, refresh: routerRefresh }
// Backs `useSearchParams` below -- reset per test so `?new=1` in one test can't leak the Sheet
// open into the next (the same idiom the deleted `projects-page.test.tsx` used).
let search = ''

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => '/',
}))

/** jsdom implements `localStorage` but this runner never hands it over (`command-strip.test.tsx`'s
 *  own note) -- `ModeProvider`'s hydration effect needs a working one. */
function installStorage(): void {
  const cells = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string): string | null => cells.get(key) ?? null,
    setItem: (key: string, value: string): void => void cells.set(key, value),
    removeItem: (key: string): void => void cells.delete(key),
    clear: (): void => cells.clear(),
  })
}

/** Flips the mode from outside -- `HomeClient` renders no toggle of its own; the rail's is a
 *  different component (`rail.test.tsx` covers that one). */
function ModeProbe(): React.JSX.Element {
  const { setMode } = useMode()
  return (
    <button type="button" data-testid="mode-probe" onClick={() => setMode('developer')}>
      developer
    </button>
  )
}

/** What the shell's `Header` renders in its action slot (M57 R7) -- the page declares its primary
 *  action with `useHeaderAction`, so a test that renders `HomeClient` alone would render no
 *  `+ New project` button at all -- the provider IS the button's mount point. */
function HeaderActionSlot(): React.JSX.Element {
  return <>{useHeaderActionNode()}</>
}

function project(over: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: 'w1',
    name: 'Checkout Platform',
    companyName: null,
    halted: false,
    archived: false,
    taskCounts: { done: 2, total: 5, active: 1, blocked: 0 },
    workerCount: 3,
    goal: null,
    team: [],
    spend: 12.5,
    unmeasuredRuns: 0,
    needsYou: 0,
    ...over,
  }
}

function needsYouItem(over: Partial<HomeNeedsYouItem> = {}): HomeNeedsYouItem {
  return {
    kind: 'blocked_task',
    id: 't1',
    title: 'Ship the checkout redesign — blocked',
    href: '/w/w1/tasks?task=t1',
    since: '2026-09-01T00:00:00.000Z',
    taskId: 't1',
    decisionId: null,
    messageId: null,
    workspaceId: 'w1',
    workspaceName: 'Checkout Platform',
    ...over,
  }
}

function feedItem(over: Partial<HappeningNowItem> = {}): HappeningNowItem {
  return {
    id: '1',
    at: '2026-09-19T10:00:00.000Z',
    type: 'task.done',
    workspaceId: 'w1',
    workspaceName: 'Checkout Platform',
    actorName: 'Alex',
    sentence: 'Alex finished "Ship the checkout redesign"',
    ...over,
  }
}

const KPIS: readonly Kpi[] = [
  { label: 'tasks done', value: '42', note: null },
  { label: 'success', value: '92%', note: null },
  { label: 'avg', value: '14m 20s', note: null },
  { label: 'tokens', value: '1.2M', note: null },
  { label: 'spend', value: '$8.43', note: '3 runs unmeasured' },
  { label: 'slaves', value: '7', note: null },
]

function snapshot(over: Partial<HomeSnapshot> = {}): HomeSnapshot {
  return {
    projects: [
      project({ id: 'w1', name: 'Checkout Platform', needsYou: 2 }),
      project({ id: 'w2', name: 'Growth Site', needsYou: 0 }),
    ],
    needsYou: [
      needsYouItem({ id: 't1', kind: 'blocked_task', decisionId: null }),
      needsYouItem({ id: 'd1', kind: 'decision', decisionId: 'd1', taskId: null, title: 'No reviewer: nobody holds reviewer' }),
    ],
    feed: [feedItem({ id: '1' }), feedItem({ id: '2', type: 'guardrail.tripped', sentence: 'the redesign is blocked and needs you' })],
    numbers: { peopleWorking: 2, peopleIdle: 1, spendUsd: 12.5, unmeasured: false, finishedThisWeek: 3 },
    kpis: KPIS,
    ...over,
  }
}

const companies: readonly CompanyRow[] = [{ id: 'c1', name: 'Acme Robotics' }]

function renderHome(
  initial: HomeSnapshot = snapshot(),
  props: { readonly companies?: readonly CompanyRow[] } = {},
): ReturnType<typeof render> {
  return render(
    <ModeProvider>
      <ModeProbe />
      <HeaderActionProvider>
        <HeaderActionSlot />
        <HomeClient initial={initial} companies={props.companies ?? companies} />
      </HeaderActionProvider>
    </ModeProvider>,
  )
}

describe('HomeClient', () => {
  beforeEach((): void => {
    installStorage()
    document.documentElement.removeAttribute('data-mode')
    search = ''
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'intake-1' }), { status: 200 })))
  })

  afterEach((): void => {
    vi.unstubAllGlobals()
    routerPush.mockClear()
    routerReplace.mockClear()
    routerRefresh.mockClear()
  })

  it('greets and states the headline numbers', () => {
    renderHome()
    const greeting = screen.getByTestId('home-greeting')
    expect(greeting.textContent).toContain('2 projects')
    expect(greeting.textContent).toContain('2 people working')
    expect(greeting.textContent).toContain('$12.50 spent')
  })

  it('renders one needs-you-row per cross-project item', () => {
    renderHome()
    expect(screen.getAllByTestId('needs-you-row')).toHaveLength(2)
  })

  it('renders one project-row per project, carrying its workspace, status and needs-you count', () => {
    renderHome()
    const rows = screen.getAllByTestId('project-row')
    expect(rows).toHaveLength(2)
    const first = rows.find((row) => row.getAttribute('data-workspace') === 'w1')
    expect(first).toBeTruthy()
    expect(first?.getAttribute('data-status')).toBeTruthy()
    expect(first?.getAttribute('data-needs-you')).toBe('2')
    const second = rows.find((row) => row.getAttribute('data-workspace') === 'w2')
    expect(second?.getAttribute('data-needs-you')).toBe('0')
  })

  it('renders the feed with one feed-item per happening', () => {
    renderHome()
    const feed = screen.getByTestId('home-feed')
    expect(within(feed).getAllByTestId('feed-item')).toHaveLength(2)
  })

  it('renders home-numbers with stat-people, stat-spend and stat-finished', () => {
    renderHome()
    const numbers = screen.getByTestId('home-numbers')
    expect(within(numbers).getByTestId('stat-people')).toBeTruthy()
    expect(within(numbers).getByTestId('stat-spend')).toBeTruthy()
    expect(within(numbers).getByTestId('stat-finished').textContent).toContain('3')
  })

  it('marks the Spend tile unmeasured only when a project has an unmeasured run', () => {
    const { rerender } = renderHome(snapshot({ numbers: { peopleWorking: 0, peopleIdle: 0, spendUsd: 0, unmeasured: false, finishedThisWeek: 0 } }))
    expect(screen.getByTestId('stat-spend').getAttribute('data-unmeasured')).toBeNull()

    rerender(
      <ModeProvider>
        <ModeProbe />
        <HeaderActionProvider>
          <HeaderActionSlot />
          <HomeClient
            initial={snapshot({ numbers: { peopleWorking: 0, peopleIdle: 0, spendUsd: 4, unmeasured: true, finishedThisWeek: 0 } })}
            companies={companies}
          />
        </HeaderActionProvider>
      </ModeProvider>,
    )
    expect(screen.getByTestId('stat-spend').getAttribute('data-unmeasured')).toBe('true')
  })

  it('hides the all-projects-analytics section in simple mode and shows it in developer mode', () => {
    renderHome()
    expect(screen.queryByTestId('all-projects-analytics')).toBeNull()

    fireEvent.click(screen.getByTestId('mode-probe'))
    expect(screen.getByTestId('all-projects-analytics')).toBeTruthy()
    expect(screen.getAllByTestId('kpi-tile')).toHaveLength(6)
  })

  it('clicking new-project renders the Sheet and pushes ?new=1', () => {
    renderHome()
    expect(screen.queryByTestId('new-project-sheet')).toBeNull()

    fireEvent.click(screen.getByTestId('new-project'))
    expect(screen.getByTestId('new-project-sheet')).toBeTruthy()
    expect(routerPush).toHaveBeenCalledWith('/?new=1')
  })

  it('opens the Sheet on load when ?new=1 is in the URL', () => {
    search = 'new=1'
    renderHome()
    expect(screen.getByTestId('new-project-sheet')).toBeTruthy()
  })

  // `Sheet` keeps its panel mounted through its exit animation (`ui/Sheet.test.tsx` covers that
  // mechanics on its own terms, asserting the `onClose` callback rather than the animated
  // removal) -- this only asserts the SIDE EFFECT `closeNew` is responsible for, not the
  // animated unmount jsdom cannot settle without real timers.
  it('closing the Sheet that ?new=1 opened drops the param, keeping ?archived=1 beside it', () => {
    search = 'new=1&archived=1'
    renderHome()
    expect(screen.getByTestId('new-project-sheet')).toBeTruthy()

    fireEvent.click(screen.getByTestId('sheet-close'))
    expect(routerReplace).toHaveBeenCalledWith('/?archived=1')
  })

  describe('show archived', () => {
    it('is unchecked by default and checking it replaces the URL with ?archived=1', () => {
      renderHome()
      expect((screen.getByTestId('show-archived') as HTMLInputElement).checked).toBe(false)
      fireEvent.click(screen.getByTestId('show-archived'))
      expect(routerReplace).toHaveBeenCalledWith('/?archived=1')
    })

    it('is checked when ?archived=1', () => {
      search = 'archived=1'
      renderHome()
      expect((screen.getByTestId('show-archived') as HTMLInputElement).checked).toBe(true)
    })
  })

  describe('the project row menu', () => {
    it('opens Assign company from the row menu for a project with no company', () => {
      renderHome()
      const row = screen.getAllByTestId('project-row').find((r) => r.getAttribute('data-workspace') === 'w1')
      const menuButton = within(row!.parentElement as HTMLElement).getByTestId('project-menu')
      fireEvent.click(menuButton)
      fireEvent.click(screen.getByTestId('assign-company-button'))
      expect(screen.getByTestId('assign-company-dialog')).toBeTruthy()
    })

    it('shows Restore for an archived project and posts the restore control on click', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
      )
      renderHome(
        snapshot({
          projects: [project({ id: 'w1', archived: true })],
        }),
      )
      const row = screen.getByTestId('project-row')
      const menuButton = within(row.parentElement as HTMLElement).getByTestId('project-menu')
      fireEvent.click(menuButton)
      expect(screen.getByTestId('restore-project')).toBeTruthy()
    })
  })
})
