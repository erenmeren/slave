// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamLive } from '../src/components/project/TeamLive.js'
import { ModeProvider, useMode } from '../src/components/mode/ModeProvider.js'
import { RightPanelProvider } from '../src/components/shell/RightPanelProvider.js'
import type { TeamLiveRow, TeamLiveSnapshot } from '../src/server/teamLive.js'

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
vi.mock('../src/hooks/useSelectedId.js', () => ({
  useSelectedId: () => [null, selectSlave],
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
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  constructor(public url: string) {}
  close(): void {}
}

beforeEach((): void => {
  installStorage()
  document.documentElement.removeAttribute('data-mode')
  selectSlave.mockClear()
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

function snapshot(rows: readonly TeamLiveRow[], over: Partial<TeamLiveSnapshot> = {}): TeamLiveSnapshot {
  return {
    workspaceId: 'w1',
    rows,
    stats: { inProgress: 1, done: 3, goal: 'Ship the checkout flow' },
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
    renderTeam(snapshot([row({})], { stats: { inProgress: 1, done: 3, goal: null } }))
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
})
