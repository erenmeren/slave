// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePathname } from 'next/navigation'
import { CommandStrip } from '../src/components/project/CommandStrip.js'
import { ModeProvider, useMode } from '../src/components/mode/ModeProvider.js'
import type { NeedsYouItem } from '../src/server/needsYou.js'

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/w/w1/tasks'),
  useSearchParams: () => new URLSearchParams(),
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

beforeEach((): void => {
  installStorage()
  document.documentElement.removeAttribute('data-mode')
  vi.mocked(usePathname).mockReturnValue('/w/w1/tasks')
})

afterEach((): void => {
  vi.unstubAllGlobals()
})

/** Flips the mode from outside -- `CommandStrip` renders no toggle of its own; the rail's is a
 *  different component (`rail.test.tsx` covers that one). */
function ModeProbe(): React.JSX.Element {
  const { setMode } = useMode()
  return (
    <button type="button" data-testid="mode-probe" onClick={() => setMode('developer')}>
      developer
    </button>
  )
}

function renderStrip(needsYou: readonly NeedsYouItem[] = []): ReturnType<typeof render> {
  return render(
    <ModeProvider>
      <ModeProbe />
      <CommandStrip workspaceId="w1" needsYou={needsYou} />
    </ModeProvider>,
  )
}

const ITEMS: readonly NeedsYouItem[] = [
  {
    kind: 'decision',
    id: 'd-1',
    title: 'Staffing: nobody can review',
    href: '/w/w1#decision-d-1',
    since: '2026-09-19T09:00:00.000Z',
    taskId: null,
    decisionId: 'd-1',
    messageId: null,
  },
  {
    kind: 'blocked_task',
    id: 't-1',
    title: 'Wire the webhook — no credentials',
    href: '/w/w1/tasks?task=t-1',
    since: '2026-09-19T08:00:00.000Z',
    taskId: 't-1',
    decisionId: null,
    messageId: null,
  },
]

describe('CommandStrip', () => {
  it('draws four tabs in simple mode, with the current one marked and Work/Activity carrying their own hrefs', () => {
    renderStrip()
    const tabs = screen.getAllByTestId('project-tab')
    expect(tabs.map((tab) => tab.getAttribute('data-tab'))).toEqual(['team', 'tasks', 'office', 'activity'])
    const tasks = tabs.find((tab) => tab.getAttribute('data-tab') === 'tasks')
    expect(tasks?.getAttribute('aria-current')).toBe('page')
    const activity = tabs.find((tab) => tab.getAttribute('data-tab') === 'activity')
    expect(activity?.getAttribute('href')).toBe('/w/w1/activity?view=digest')
  })

  it('adds Graph and Knowledge once developer mode is on', () => {
    renderStrip()
    fireEvent.click(screen.getByTestId('mode-probe'))
    const tabs = screen.getAllByTestId('project-tab')
    expect(tabs.map((tab) => tab.getAttribute('data-tab'))).toEqual(['team', 'tasks', 'office', 'activity', 'graph', 'knowledge'])
  })

  it('links project-settings to the settings route', () => {
    renderStrip()
    expect(screen.getByTestId('project-settings').getAttribute('href')).toBe('/w/w1/settings')
  })

  it('shows two needs-you rows with their kind, href and title, and nothing when the queue is empty', () => {
    const { rerender } = renderStrip(ITEMS)
    const rows = screen.getAllByTestId('needs-you-row')
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual(['decision', 'blocked_task'])
    // The row is a `<div>` now (review fix round 1, Important 1) -- its title is the `<a>`.
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/w/w1#decision-d-1')
    expect(rows[0]?.textContent).toContain('Staffing: nobody can review')

    rerender(
      <ModeProvider>
        <ModeProbe />
        <CommandStrip workspaceId="w1" needsYou={[]} />
      </ModeProvider>,
    )
    expect(screen.queryByTestId('needs-you')).toBeNull()
  })

  it('keeps a tab the current mode does not show, marked as outside the mode', () => {
    vi.mocked(usePathname).mockReturnValue('/w/w1/graph')
    renderStrip()
    const tabs = screen.getAllByTestId('project-tab')
    expect(tabs.map((tab) => tab.getAttribute('data-tab'))).toEqual(['team', 'tasks', 'office', 'activity', 'graph'])
    const graph = tabs.find((tab) => tab.getAttribute('data-tab') === 'graph')
    expect(graph?.getAttribute('data-outside-mode')).toBe('true')
    expect(graph?.getAttribute('aria-current')).toBe('page')
    for (const tab of tabs.filter((one) => one.getAttribute('data-tab') !== 'graph')) {
      expect(tab.getAttribute('data-outside-mode')).toBeNull()
    }
  })
})
