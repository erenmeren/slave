// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectNav, Sidebar } from '../src/components/Sidebar.js'
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

/** Minimal `EventSource` stand-in (`tasks-components.test.tsx`'s precedent). Still needed by the
 *  `TasksClient` case below, which streams for real — and by the several assertions that nothing
 *  ELSE streams: as of M14 Task 12 the `Sidebar`'s own fallback is a one-shot `fetch`, not a
 *  stream, so a `FakeEventSource` instance appearing at all is itself a failure. */
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

/** A nav row by its label. The row's own text is no longer its only child (a live count sits
 *  beside it), so `getByText` would match the inner label span, not the link that carries the
 *  href and `aria-current`. */
function navRow(label: string): HTMLElement {
  const row = screen.getAllByTestId('nav-row').find((element) => element.getAttribute('data-nav') === label)
  if (row === undefined) throw new Error(`no nav row labelled ${label}`)
  return row
}

describe('the shell', () => {
  afterEach(() => {
    pathname = '/w/w1'
  })

  it('shows Overview as the current page and Tasks/Activity/Graph as live links', () => {
    render(<Sidebar workspaceId="w1" />)
    expect(navRow('Overview')).toHaveProperty('ariaCurrent', 'page')
    expect(navRow('Tasks').getAttribute('href')).toBe('/w/w1/tasks')
    expect(navRow('Activity').getAttribute('href')).toBe('/w/w1/activity')
    expect(navRow('Activity').getAttribute('aria-disabled')).toBeNull()
    // Graph went live in M7 (spec §7) — the roadmap's last inert item, now a real link like its
    // siblings, not the "present but disabled" chrome it used to render as.
    expect(navRow('Graph').getAttribute('href')).toBe('/w/w1/graph')
    expect(navRow('Graph').getAttribute('aria-disabled')).toBeNull()
  })

  it('marks Activity aria-current on the activity route', () => {
    pathname = '/w/w1/activity'
    render(<Sidebar workspaceId="w1" />)
    expect(navRow('Activity')).toHaveProperty('ariaCurrent', 'page')
    expect(navRow('Overview')).not.toHaveProperty('ariaCurrent', 'page')
  })

  it('marks Graph aria-current on the graph route', () => {
    pathname = '/w/w1/graph'
    render(<Sidebar workspaceId="w1" />)
    expect(navRow('Graph')).toHaveProperty('ariaCurrent', 'page')
    expect(navRow('Overview')).not.toHaveProperty('ariaCurrent', 'page')
  })

  it('always shows the global section (Projects/Agents/Settings)', () => {
    render(<Sidebar workspaceId="w1" />)
    expect(navRow('Projects').getAttribute('href')).toBe('/')
    expect(navRow('Agents')).toBeTruthy()
    expect(navRow('Settings')).toBeTruthy()
  })

  it('renders Agents (M11 Task 8) and Settings (Task 9) as live links', () => {
    render(<Sidebar workspaceId="w1" />)
    expect(navRow('Agents').getAttribute('href')).toBe('/agents')
    expect(navRow('Agents').getAttribute('aria-disabled')).toBeNull()
    expect(navRow('Settings').getAttribute('href')).toBe('/settings')
    expect(navRow('Settings').getAttribute('aria-disabled')).toBeNull()
  })

  it('marks Agents aria-current on the agents route', () => {
    pathname = '/agents'
    // Propless, because that is the only configuration the root layout ever produces
    // (`app/layout.tsx` mounts `<Sidebar />`). `Agents` is a GLOBAL page: it must be present and
    // current here, or the row that took you to `/agents` vanishes on arrival.
    render(<Sidebar />)
    expect(navRow('Agents').getAttribute('href')).toBe('/agents')
    expect(navRow('Agents')).toHaveProperty('ariaCurrent', 'page')
  })

  it('marks Settings aria-current on the settings route', () => {
    pathname = '/settings'
    render(<Sidebar />)
    expect(navRow('Settings')).toHaveProperty('ariaCurrent', 'page')
  })

  it('renders only the global section when the pathname carries no workspaceId', () => {
    pathname = '/agents'
    render(<Sidebar />)
    expect(navRow('Projects')).toBeTruthy()
    expect(screen.queryByTestId('project-section')).toBeNull()
  })

  it('renders both sections, deriving the workspaceId from the pathname, when one is present', () => {
    pathname = '/w/w1/tasks'
    render(<Sidebar />)
    expect(navRow('Projects')).toBeTruthy()
    expect(screen.getByTestId('project-section')).toBeTruthy()
    expect(navRow('Overview').getAttribute('href')).toBe('/w/w1')
    expect(navRow('Tasks')).toHaveProperty('ariaCurrent', 'page')
  })

  it('renders nothing on /login — the shell is a logged-in surface', () => {
    pathname = '/login'
    const { container } = render(<Sidebar />)
    expect(container.innerHTML).toBe('')
  })

  it('turns the budget bar amber past 80% and red past 100%', () => {
    const { rerender } = render(
      <TopBar workspaceId="w1" workspaceName="W" connection="connected" latencyMs={null} budget={{ spentUsd: 85, budgetUsd: 100, unmeasuredRuns: 0 }} halted={false} />,
    )
    expect(screen.getByTestId('budget').innerHTML).toContain('bg-tone-waiting')
    rerender(
      <TopBar workspaceId="w1" workspaceName="W" connection="connected" latencyMs={null} budget={{ spentUsd: 101, budgetUsd: 100, unmeasuredRuns: 0 }} halted={false} />,
    )
    expect(screen.getByTestId('budget').innerHTML).toContain('bg-tone-blocked')
  })

  it('says how many runs went unmeasured, so known spend is not read as total spend', () => {
    // M12 Task 9 / ruling R11. `$3.20 / $20.00` on its own claims to be the whole bill. With two
    // runs nobody could measure, it is only the part of the bill that was measured -- and this is
    // the highest-visibility surface in the product for that distinction to be missing from.
    render(
      <TopBar
        workspaceId="w1"
        workspaceName="W"
        connection="connected"
        latencyMs={null}
        budget={{ spentUsd: 3.2, budgetUsd: 20, unmeasuredRuns: 2 }}
        halted={false}
      />,
    )
    const budget = screen.getByTestId('budget')
    expect(budget.textContent).toContain('$3.20')
    expect(budget.textContent).toContain('$20.00')
    expect(budget.textContent).toContain('2 unmeasured')
  })

  it('says nothing about unmeasured runs when there are none', () => {
    render(
      <TopBar
        workspaceId="w1"
        workspaceName="W"
        connection="connected"
        latencyMs={null}
        budget={{ spentUsd: 3.2, budgetUsd: 20, unmeasuredRuns: 0 }}
        halted={false}
      />,
    )
    expect(screen.getByTestId('budget').textContent).not.toContain('unmeasured')
  })

  it('shows the known spend with no ratio and no bar when the workspace has no budget', () => {
    // M12 Task 9 / ruling R11. `budget={null}` means "this page does not show a budget" (the
    // Tasks/Activity/Graph shells pass it); `budgetUsd: null` INSIDE a budget means something
    // else entirely -- this workspace is not budgeted, the state spec §6 requires before a
    // cost-blind runtime may run there. There is no ceiling to draw a ratio against, so showing
    // one would be inventing a limit nobody set.
    render(
      <TopBar
        workspaceId="w1"
        workspaceName="W"
        connection="connected"
        latencyMs={null}
        budget={{ spentUsd: 3.2, budgetUsd: null, unmeasuredRuns: 0 }}
        halted={false}
      />,
    )
    const budget = screen.getByTestId('budget')
    expect(budget.textContent).toContain('$3.20')
    expect(budget.textContent).not.toContain('/')
    expect(budget.innerHTML).not.toContain('bg-tone-working')
    expect(budget.innerHTML).not.toContain('bg-tone-waiting')
    expect(budget.innerHTML).not.toContain('bg-tone-blocked')
  })

  it('reports the connection state it was given', () => {
    render(<TopBar workspaceId="w1" workspaceName="W" connection="reconnecting" latencyMs={null} budget={null} halted={false} />)
    expect(screen.getByTestId('connection').textContent).toContain('reconnecting')
  })

  it('renders the emergency STOP button when the workspace is not halted', () => {
    render(<TopBar workspaceId="w1" workspaceName="W" connection="connected" latencyMs={null} budget={null} halted={false} />)
    const button = screen.getByTestId('emergency-stop')
    expect(button).toBeTruthy()
    expect(button.getAttribute('disabled')).toBeNull()
  })
})

describe('the sidebar geometry and rows', () => {
  afterEach(() => {
    pathname = '/w/w1'
  })

  it('is 212px wide with a nine-row nav in the README order', () => {
    pathname = '/w/w1'
    render(<Sidebar workspaceId="w1" />)
    // Class string, not computed style: jsdom loads no CSS here. The gate reads `width: 212px`.
    expect(screen.getByRole('navigation', { name: 'Primary' }).className).toContain('w-[212px]')

    const labels = screen.getAllByTestId('nav-row').map((row) => row.getAttribute('data-nav'))
    expect(labels).toEqual(['Overview', 'Agents', 'Tasks', 'Graph', 'Activity', 'Projects', 'Skills', 'Analytics', 'Settings'])
  })

  it('renders Skills and Analytics as global links', () => {
    pathname = '/skills'
    render(<Sidebar />)
    expect(screen.getByRole('link', { name: 'Skills' }).getAttribute('href')).toBe('/skills')
    expect(screen.getByRole('link', { name: 'Skills' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Analytics' }).getAttribute('href')).toBe('/analytics')
  })

  it('drops the four workspace-scoped rows, but never Agents, off a workspace route', () => {
    // Overview/Tasks/Graph/Activity are `/w/:id/...` pages and have nowhere to point without a
    // workspace. `Agents` is a global page and stays, keeping README §3a's order among what is
    // left; it simply carries no count, because the count is a workspace fact.
    pathname = '/settings'
    render(<Sidebar />)
    const labels = screen.getAllByTestId('nav-row').map((row) => row.getAttribute('data-nav'))
    expect(labels).toEqual(['Agents', 'Projects', 'Skills', 'Analytics', 'Settings'])
    expect(screen.queryByTestId('nav-badge-Agents')).toBeNull()
    // And nothing streams: no workspace in scope means `ProjectNav` never mounts (Minor 11).
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('paints the live counts and guardrail labels in the mock faint tone', () => {
    // The mock's nav badge (`AI Team OS Mockups.dc.html:63`) and its bottom-block row labels
    // (`:70`) are `#69727f` — README "faint", one step above "label" `#5b6472`.
    render(<ProjectNav workspaceId="w1" pathname="/w/w1" />)
    expect(screen.getByTestId('nav-badge-Tasks').className).toContain('text-text-faint')
    expect(screen.getByText('budget').className).toContain('text-text-faint')
  })

  it('marks the selected row with the handoff selected surface and its teal rail', () => {
    // Class string, not computed style (jsdom loads no CSS): `#151a21` is spec §3's "selected"
    // surface and the `inset 2px 0 0` rail is the mockup's own. The gate reads both back.
    pathname = '/w/w1'
    render(<Sidebar workspaceId="w1" />)
    expect(navRow('Overview').className).toContain('bg-[#151a21]')
    expect(navRow('Overview').className).toContain('inset_2px_0_0')
    expect(navRow('Graph').className).not.toContain('bg-[#151a21]')
  })
})

describe('ProjectNav counts and guardrails', () => {
  beforeEach((): void => {
    vi.useFakeTimers()
  })

  afterEach((): void => {
    vi.useRealTimers()
  })

  it('shows the unknown mark for every figure before the first snapshot lands', () => {
    render(<ProjectNav workspaceId="w1" pathname="/w/w1" />)
    expect(screen.getByTestId('nav-badge-Tasks').textContent).toBe('—')
    expect(screen.getByTestId('nav-badge-Agents').textContent).toBe('—')
    expect(screen.getByTestId('guardrail-budget').textContent).toBe('—')
    expect(screen.getByTestId('guardrail-concurrency').textContent).toBe('—')
  })

  it('renders the counts and every guardrail once the snapshot arrives', async (): Promise<void> => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            workspace: { id: 'w1', name: 'Checkout' },
            counts: { agentsWorking: 3, tasksActive: 12 },
            guardrails: { budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 },
          }),
          { status: 200 },
        ),
    )
    render(<ProjectNav workspaceId="w1" pathname="/w/w1" />)
    // One `fetch`, no stream to open (M14 Task 12): flushing the microtask queue is all the
    // fallback needs. `advanceTimersByTimeAsync(0)` is how that is done under fake timers.
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(FakeEventSource.instances).toHaveLength(0)
    expect(screen.getByTestId('nav-badge-Tasks').textContent).toBe('12')
    expect(screen.getByTestId('nav-badge-Agents').textContent).toBe('3')
    expect(screen.getByTestId('guardrail-budget').textContent).toBe('$20.00')
    expect(screen.getByTestId('guardrail-concurrency').textContent).toBe('3')
    expect(screen.getByTestId('guardrail-timeout').textContent).toBe('30m')
    expect(screen.getByTestId('guardrail-attempts').textContent).toBe('3')
  })

  it('says an unbudgeted workspace is unbudgeted rather than showing a budget of zero', async (): Promise<void> => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            workspace: { id: 'w1', name: 'Checkout' },
            counts: { agentsWorking: 0, tasksActive: 0 },
            guardrails: { budgetUsd: null, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 },
          }),
          { status: 200 },
        ),
    )
    render(<ProjectNav workspaceId="w1" pathname="/w/w1" />)
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('guardrail-budget').textContent).toBe('—')
  })

  it('reads the shell endpoint once, and never opens a stream for it (M14 Task 12)', () => {
    // Before Task 12 this fallback rode the workspace's SSE stream (`/api/w/w1/events`) and
    // refetched on every notification. Every workspace route now PUBLISHES its shell facts, so
    // the fallback is a single request to the shell endpoint itself — and the assertion that
    // matters most is the second one: no `EventSource` anywhere.
    render(<ProjectNav workspaceId="w1" pathname="/w/w1" />)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/w/w1/shell')
    expect(FakeEventSource.instances).toHaveLength(0)
  })
})

describe('the top bar', () => {
  it('is 52px tall and carries the gradient hairline', () => {
    render(<TopBar workspaceId="w1" workspaceName="W" connection="connected" latencyMs={null} budget={null} halted={false} />)
    const header = screen.getByTestId('top-bar')
    expect(header.className).toContain('h-[52px]')
    expect(screen.getByTestId('top-bar-hairline')).toBeTruthy()
  })

  it('renders the latency chip as sse · <ms>, and sse · — before the first event', () => {
    const { rerender } = render(
      <TopBar workspaceId="w1" workspaceName="W" connection="connected" latencyMs={null} budget={null} halted={false} />,
    )
    expect(screen.getByTestId('connection').textContent).toBe('sse · —')

    rerender(<TopBar workspaceId="w1" workspaceName="W" connection="connected" latencyMs={42} budget={null} halted={false} />)
    expect(screen.getByTestId('connection').textContent).toBe('sse · 42ms')
  })

  it('keeps the structural hairline under the gradient, as the mock does', () => {
    // `AI Team OS Web.dc.html:32-33`: the bar has BOTH a `border-bottom:1px solid
    // rgba(255,255,255,.07)` and the gradient element at `bottom:-1px`, beneath it.
    render(<TopBar workspaceId="w1" workspaceName="W" connection="connected" latencyMs={null} budget={null} halted={false} />)
    expect(screen.getByTestId('top-bar').className).toContain('border-b')
    expect(screen.getByTestId('top-bar').className).toContain('border-line')
    expect(screen.getByTestId('top-bar-hairline').className).toContain('-bottom-px')
  })

  it('gives the connection chip the mockup pill shape in the live status colour', () => {
    // `AI Team OS Web.dc.html:38-41`: `padding:3px 9px`, `border-radius:20px`, border
    // `rgba(46,230,207,.25)`, background `rgba(46,230,207,.06)`, `500 10px` mono `#2ee6cf`,
    // 5px dot.
    render(<TopBar workspaceId="w1" workspaceName="W" connection="connected" latencyMs={42} budget={null} halted={false} />)
    const chip = screen.getByTestId('connection')
    expect(chip.className).toContain('rounded-pill')
    expect(chip.className).toContain('px-[9px]')
    expect(chip.className).toContain('py-[3px]')
    expect(chip.className).toContain('text-[10px]')
    expect(chip.className).toContain('border-tone-working/25')
    expect(chip.className).toContain('bg-tone-working/[0.06]')
    expect(chip.className).toContain('text-tone-working')
    expect(chip.innerHTML).toContain('h-[5px]')
  })

  it('turns the chip amber, not teal, while the stream is reconnecting', () => {
    render(<TopBar workspaceId="w1" workspaceName="W" connection="reconnecting" latencyMs={42} budget={null} halted={false} />)
    const chip = screen.getByTestId('connection')
    expect(chip.className).toContain('border-tone-waiting/25')
    expect(chip.className).toContain('text-tone-waiting')
    expect(chip.className).not.toContain('text-tone-working')
  })

  it('draws the budget bar at the mockup geometry, with the glow in the threshold colour', () => {
    // `AI Team OS Web.dc.html:47`: track `width:150px; height:3px; border-radius:2px;
    // background:rgba(255,255,255,.08)`, fill `box-shadow:0 0 8px <colour>`.
    render(
      <TopBar
        workspaceId="w1"
        workspaceName="W"
        connection="connected"
        latencyMs={null}
        budget={{ spentUsd: 5, budgetUsd: 20, unmeasuredRuns: 0 }}
        halted={false}
      />,
    )
    const html = screen.getByTestId('budget').innerHTML
    expect(html).toContain('w-[150px]')
    expect(html).toContain('h-[3px]')
    expect(html).toContain('rounded-[2px]')
    expect(html).toContain('bg-white/[0.08]')
    expect(html).toContain('shadow-[0_0_8px_var(--color-tone-working)]')
  })

  it('says reconnecting instead of a stale latency while the stream is down', () => {
    render(<TopBar workspaceId="w1" workspaceName="W" connection="reconnecting" latencyMs={42} budget={null} halted={false} />)
    expect(screen.getByTestId('connection').textContent).toBe('reconnecting')
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
      workspace: { id: 'w1', name: 'W', haltedReason: HALT_REASON },
      shellFacts: {
        workspace: { id: 'w1', name: 'W' },
        counts: { agentsWorking: 0, tasksActive: 0 },
        guardrails: { budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 3_600_000, maxAttempts: 3 },
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
      agents: [],
      tasks: [],
      users: [],
      // M14 Task 12 widenings: the right rail's 24h volumes, and the shell facts this page now
      // publishes to `hooks/useShellFacts.ts` in place of the sidebar's removed fallback stream.
      typeVolumes: [],
      shellFacts: {
        workspace: { id: 'w1', name: 'W' },
        counts: { agentsWorking: 0, tasksActive: 0 },
        guardrails: { budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 3_600_000, maxAttempts: 3 },
      },
    }

    render(<ActivityClient workspaceId="w1" initial={initial} />)

    expect(screen.getByRole('alert').textContent).toContain(HALT_REASON)
  })
})
