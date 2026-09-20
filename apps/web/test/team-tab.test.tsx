// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamLive } from '../src/components/project/TeamLive.js'
import { ModeProvider, useMode } from '../src/components/mode/ModeProvider.js'
import { RightPanel } from '../src/components/shell/RightPanel.js'
import { RightPanelProvider } from '../src/components/shell/RightPanelProvider.js'
import { useStreamState } from '../src/hooks/useStreamState.js'
import type { TeamLiveRow, TeamLiveSnapshot } from '../src/server/teamLive.js'
import type { OrganizationView } from '../src/server/organization.js'

/**
 * The Team tab (M61 R7/Task 6), replacing `organization-page.test.tsx` -- `OrganizationClient`'s
 * own roster/pool/hints UI is no longer routed anywhere (`/organization` redirects to `/w/:id`
 * now), so its dedicated coverage does not move here; `OrganizationNeeds`/`OrganizationPreferences`
 * -- the two blocks THIS page does render -- get their own light coverage below instead of the
 * old file's full 28-case suite. See the task report for the coverage this narrowing drops.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/w/w1',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}))

const selectSlave = vi.fn()
// A mutable module-level binding, not a fixed `[null, selectSlave]` -- the review fix round 1
// panel-error case (Important 7) needs a REAL `?slave=` selection to open the panel, which the
// original fixed mock could never produce (`selectSlave` was a spy, not real state).
let mockSelectedId: string | null = null
vi.mock('../src/hooks/useSelectedId.js', () => ({
  useSelectedId: () => [mockSelectedId, selectSlave],
}))

/** jsdom implements `localStorage` but this runner never hands it over (`rail.test.tsx`'s own
 *  note) -- `ModeProvider`'s hydration effect needs a working one. */
function installStorage(): void {
  const cells = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string): string | null => cells.get(key) ?? null,
    setItem: (key: string, value: string): void => void cells.set(key, value),
    removeItem: (key: string): void => void cells.delete(key),
    clear: (): void => cells.clear(),
  })
}

class SilentEventSource {
  static instances: SilentEventSource[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  constructor(public url: string) {
    SilentEventSource.instances.push(this)
  }
  close(): void {}
}

beforeEach((): void => {
  installStorage()
  document.documentElement.removeAttribute('data-mode')
  selectSlave.mockClear()
  mockSelectedId = null
  SilentEventSource.instances = []
  vi.stubGlobal('EventSource', SilentEventSource as unknown as typeof EventSource)
})

afterEach((): void => {
  vi.unstubAllGlobals()
})

function row(over: Partial<TeamLiveRow> = {}): TeamLiveRow {
  return {
    slaveId: 'a1',
    personId: 'p1',
    name: 'Alex',
    role: 'backend',
    status: 'working',
    state: 'working',
    stateLabel: 'WORKING',
    doing: 'Add the thing',
    doingTone: 'working',
    progress: 48,
    taskId: 't1',
    lifecycle: 'project',
    released: null,
    why: 'the only backend engineer here',
    technical: {
      runId: '3f9a21c8-0000-4000-8000-000000000000',
      provider: 'claude_code',
      startedAt: null,
      toolCalls: 3,
      costUsd: 0.42,
    },
    ...over,
  }
}

/** A minimal `OrganizationRow` off a `TeamLiveRow`, for the `workers` fixture -- the scope fix's
 *  `OrganizationRoster` reads this shape, not `TeamLiveRow`'s. */
function workerFromRow(r: TeamLiveRow): OrganizationView['workers'][number] {
  return {
    slaveId: r.slaveId,
    personId: r.personId,
    name: r.name,
    roleLabel: r.role,
    lifecycle: r.lifecycle,
    released: r.released,
    capabilities: [],
    why: r.why,
    runtimeRoles: [],
    doing: r.doing,
  }
}

function snapshot(rows: readonly TeamLiveRow[], over: Partial<TeamLiveSnapshot> = {}): TeamLiveSnapshot {
  return {
    workspaceId: 'w1',
    rows,
    stats: { inProgress: 1, done: 3, goal: 'Ship the checkout flow', goalVersion: 2, unmeasuredCalls: 0, unmeasuredRuns: 0, knowledge: { verified: 2, candidates: 1 } },
    shellFacts: {
      workspace: { id: 'w1', name: 'W' },
      counts: { slavesWorking: 1, tasksActive: 1, slavesPaused: 0 },
      guardrails: { budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 },
      status: { goal: 'Ship the checkout flow', spentUsd: 4.2, unmeasuredRuns: 0, haltedReason: null },
    },
    needs: [],
    preferences: [],
    haltedReason: null,
    pendingElsewhere: 0,
    taskTitles: {},
    templates: [],
    adoptedFrom: null,
    workers: rows.map(workerFromRow),
    pool: [],
    teamId: 't1',
    hints: [],
    ...over,
  }
}

/** Flips the mode from outside, the same "probe" shape `command-strip.test.tsx` uses -- `TeamLive`
 *  itself renders no toggle of its own. */
function ModeProbe(): React.JSX.Element {
  const { setMode } = useMode()
  return (
    <button type="button" data-testid="mode-probe" onClick={() => setMode('developer')}>
      developer
    </button>
  )
}

function renderTeam(initial: TeamLiveSnapshot): ReturnType<typeof render> {
  return render(
    <ModeProvider>
      <RightPanelProvider>
        <ModeProbe />
        <TeamLive workspaceId="w1" initial={initial} />
      </RightPanelProvider>
    </ModeProvider>,
  )
}

describe('TeamLive', () => {
  it('draws one team-card per row, with data-slave/data-status and the doing sentence', () => {
    renderTeam(
      snapshot([
        row({}),
        row({ slaveId: 'a2', personId: 'p2', name: 'Sam', status: 'idle', state: 'idle', doing: 'Idle' }),
      ]),
    )
    const cards = screen.getAllByTestId('team-card')
    expect(cards).toHaveLength(2)
    expect(cards[0]?.getAttribute('data-slave')).toBe('a1')
    expect(cards[0]?.getAttribute('data-status')).toBe('working')
    expect(cards[1]?.getAttribute('data-slave')).toBe('a2')
    const doing = screen.getAllByTestId('team-doing')
    expect(doing[0]?.textContent).toContain('Add the thing')
    expect(doing[1]?.textContent).toContain('Idle')
  })

  it('sets data-progress and draws the fill bar only when progress is a number', () => {
    renderTeam(
      snapshot([
        row({ progress: 48 }),
        row({ slaveId: 'a2', personId: 'p2', name: 'Sam', progress: null, technical: { runId: null, provider: null, startedAt: null, toolCalls: 0, costUsd: null } }),
      ]),
    )
    const bars = screen.getAllByTestId('team-progress')
    expect(bars[0]?.getAttribute('data-progress')).toBe('48')
    expect(bars[0]?.querySelector('span')).not.toBeNull()
    expect(bars[1]?.getAttribute('data-progress')).toBe('')
    expect(bars[1]?.querySelector('span')).toBeNull()
  })

  it('hides team-technical in simple mode and shows it, with the run id, once developer mode is on', () => {
    renderTeam(snapshot([row({})]))
    expect(screen.queryByTestId('team-technical')).toBeNull()

    fireEvent.click(screen.getByTestId('mode-probe'))

    const technical = screen.getByTestId('team-technical')
    expect(technical.textContent).toContain('run 3f9a')
  })

  it('reads stat-work as N in progress and M done', () => {
    renderTeam(snapshot([row({})], { stats: { inProgress: 1, done: 3, goal: null, goalVersion: null, unmeasuredCalls: 0, unmeasuredRuns: 0, knowledge: { verified: 2, candidates: 1 } } }))
    const stat = screen.getByTestId('stat-work')
    expect(stat.textContent).toContain('1 in progress')
    expect(stat.textContent).toContain('3 done')
  })

  it('clicking a card calls the ?slave= setter with the seat\'s personId', () => {
    renderTeam(snapshot([row({})]))
    fireEvent.click(screen.getAllByTestId('team-card')[0]!)
    expect(selectSlave).toHaveBeenCalledWith('p1')
  })

  it('says nobody works here yet rather than drawing an empty grid', () => {
    renderTeam(snapshot([]))
    expect(screen.queryByTestId('team-card')).toBeNull()
    expect(screen.getByTestId('team-empty').textContent).toContain('nobody works here yet')
  })

  // `OrganizationNeeds`/`OrganizationPreferences` are the two blocks this extracted from
  // `organization-page.test.tsx`'s deleted coverage that the Team tab actually renders -- one case
  // each, proving the wiring (props reaching the right component, testids present), not a repeat
  // of that file's full assertions on every button inside them.
  it('renders what this project still needs, with its own testid, when there is one', () => {
    renderTeam(
      snapshot([row({})], {
        needs: [
          {
            capability: 'security.application',
            label: 'Application security',
            summary: 'Nobody here can review this.',
            readyTasks: 2,
            decisions: [],
            preference: null,
          },
        ],
      }),
    )
    expect(screen.getByTestId('organization-needs').textContent).toContain('Application security')
  })

  it('renders coverage preferences only in developer mode', () => {
    renderTeam(
      snapshot([row({})], {
        preferences: [{ capability: 'backend.api-design', label: 'API design', by: 'a1', preference: null }],
      }),
    )
    expect(screen.queryByTestId('organization-covered')).toBeNull()

    fireEvent.click(screen.getByTestId('mode-probe'))
    expect(screen.getByTestId('organization-covered').textContent).toContain('API design')
  })

  // Scope fix (M61 R7, controller Ruling 4): `docs/ia.md` rule 2 -- nothing removed, only moved --
  // binds the rest of the organization page's UI too. "Add somebody" is how an end user staffs a
  // project, so it renders in BOTH modes; the roster table is a developer-mode detail.
  it('renders the add-somebody controls in simple mode, and the roster table only in developer mode', () => {
    renderTeam(snapshot([row({})]))
    expect(screen.getByTestId('organization-pool-person')).toBeTruthy()
    expect(screen.getByTestId('organization-pool-submit')).toBeTruthy()
    expect(screen.getByTestId('organization-add-from-pool')).toBeTruthy()
    expect(screen.queryByTestId('organization-rows')).toBeNull()

    fireEvent.click(screen.getByTestId('mode-probe'))
    expect(screen.getByTestId('organization-rows')).toBeTruthy()
    expect(screen.getByTestId('organization-row-a1').textContent).toContain('Alex')
    expect(screen.getByTestId('organization-why-a1').textContent).toBe('the only backend engineer here')
    // Add-somebody stays up in developer mode too -- it does not toggle off with the roster.
    expect(screen.getByTestId('organization-add-from-pool')).toBeTruthy()
  })

  it('renders collaboration hints inside the needs section, in both modes', () => {
    renderTeam(
      snapshot([row({})], {
        hints: [
          {
            slaveId: 'a1',
            text: 'Ask Alex before touching the checkout schema.',
            targetTemplateName: null,
            capability: 'backend.api-design',
            capabilityLabel: 'API design',
          },
        ],
      }),
    )
    const hint = screen.getByTestId('organization-hint')
    expect(hint.getAttribute('data-capability')).toBe('backend.api-design')
    expect(hint.textContent).toContain('Ask Alex before touching the checkout schema.')
    expect(screen.getByTestId('organization-advice')).toBeTruthy()
  })

  // M61 Task 11, controller Ruling 9: the goal's version is `stat-goal`'s note, beside Edit goal --
  // the fact the deleted `ProjectBrief`'s objective tile carried, and the one
  // `gate-m45-project-experience.mjs` reads back.
  it("prints the goal's version in stat-goal's note, with the raw number on data-goal-version", () => {
    renderTeam(snapshot([row({})]))
    const stat = screen.getByTestId('stat-goal')
    const version = stat.querySelector('[data-goal-version]')
    expect(version?.getAttribute('data-goal-version')).toBe('2')
    expect(version?.textContent).toBe('v2')
    expect(stat.textContent).toContain('Edit goal')
  })

  it('prints no version at all when there is no goal', () => {
    renderTeam(snapshot([row({})], { stats: { inProgress: 0, done: 0, goal: null, goalVersion: null, unmeasuredCalls: 0, unmeasuredRuns: 0, knowledge: { verified: 2, candidates: 1 } } }))
    const stat = screen.getByTestId('stat-goal')
    expect(stat.querySelector('[data-goal-version]')).toBe(null)
    expect(stat.textContent).toContain('No goal yet')
  })

  // M61 Task 11: M32's upper-bound policy on the one surface that shows the project's spend --
  // the deleted `ProjectBrief`'s cost tile said both of these and nothing said them after it.
  it('names unmeasured calls and unmeasured runs beside the spend, and neither when there are none', () => {
    renderTeam(snapshot([row({})]))
    const clean = screen.getByTestId('stat-spend')
    expect(clean.querySelector('[data-testid="stat-spend-unmeasured-calls"]')).toBe(null)
    expect(clean.querySelector('[data-testid="stat-spend-unmeasured-runs"]')).toBe(null)
    expect(clean.getAttribute('data-unmeasured')).toBe(null)

    renderTeam(
      snapshot([row({})], {
        stats: { inProgress: 1, done: 3, goal: 'g', goalVersion: 1, unmeasuredCalls: 2, unmeasuredRuns: 3, knowledge: { verified: 2, candidates: 1 } },
      }),
    )
    const stat = screen.getAllByTestId('stat-spend').at(-1) as HTMLElement
    expect(stat.getAttribute('data-unmeasured')).toBe('true')
    expect(stat.textContent).toContain('2 unmeasured calls charged at')
    expect(stat.textContent).toContain('3 unmeasured runs (not in the total)')
  })

  // M49 R6 re-homed (M61 Task 11): the knowledge line is a developer-mode link into the tab.
  it('links to Knowledge with both counts, in developer mode only', () => {
    renderTeam(snapshot([row({})]))
    expect(screen.queryByTestId('brief-knowledge')).toBeNull()

    fireEvent.click(screen.getByTestId('mode-probe'))

    const link = screen.getByTestId('brief-knowledge')
    expect(link.textContent).toBe('Knowledge: 2 verified · 1 candidates')
    expect(link.getAttribute('href')).toContain('/knowledge')
  })

  // Review fix round 1, Important 8: clamped to two lines, with the whole of it one hover away.
  it('clamps the goal line to two lines, with the full text one hover away', () => {
    const goal = 'Ship the checkout flow end to end, including refunds and partial captures.'
    renderTeam(snapshot([row({})], { stats: { inProgress: 0, done: 0, goal, goalVersion: 4, unmeasuredCalls: 0, unmeasuredRuns: 0, knowledge: { verified: 2, candidates: 1 } } }))
    const line = screen.getByTestId('project-goal-line')
    expect(line.textContent).toBe(goal)
    expect(line.getAttribute('title')).toBe(goal)
    expect(line.className).toContain('line-clamp-2')
  })

  // Review fix round 1, Important 5: `hooks/useTeamLive.ts` publishes `useStreamState`, the same
  // pair `TasksClient.tsx:69-71` does, so the rail's live chip is right on `/w/:id` too.
  it('publishes the stream connection state for the rail chip', () => {
    function StreamProbe(): React.JSX.Element {
      const state = useStreamState('w1')
      return <span data-testid="stream-probe" data-connection={state?.connection ?? 'none'} />
    }
    render(
      <ModeProvider>
        <RightPanelProvider>
          <TeamLive workspaceId="w1" initial={snapshot([row({})])} />
          <StreamProbe />
        </RightPanelProvider>
      </ModeProvider>,
    )
    expect(screen.getByTestId('stream-probe').getAttribute('data-connection')).toBe('connected')
  })

  // Review fix round 1, Important 6: the same "showing stale data: …" band the deleted
  // `OverviewClient.tsx` drew, carrying no testid of its own (neither did the page it moved off).
  it('shows the stale-data band when the stream refetch fails', async (): Promise<void> => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      renderTeam(snapshot([row({})]))
      expect(screen.queryByText(/showing stale data/)).toBeNull()
      act(() => {
        SilentEventSource.instances[0]?.onopen?.()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      expect(screen.getByText(/showing stale data: offline/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  // Review fix round 1, Important 7: both the `/api/persons/:id` fetch and the `Promise.all` are
  // caught now, so an offline/rejected fetch resolves to the pre-existing `team-panel-error` state
  // instead of leaving the slot on `team-panel-loading` forever.
  it('renders team-panel-error when opening a slave panel fails to load', async (): Promise<void> => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', fetchMock)
    mockSelectedId = 'p1'
    render(
      <ModeProvider>
        <RightPanelProvider>
          <TeamLive workspaceId="w1" initial={snapshot([row({})])} />
          <RightPanel>{null}</RightPanel>
        </RightPanelProvider>
      </ModeProvider>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('team-panel-error')).toBeTruthy()
    })
  })
})
