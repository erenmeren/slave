// @vitest-environment jsdom
import { render, screen, act, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishShellFacts } from '../src/hooks/useShellFacts'
import { ProjectTabs } from '../src/components/project/ProjectTabs'

let pathname = '/w/w1'
vi.mock('next/navigation', () => ({ usePathname: () => pathname }))

afterEach(() => publishShellFacts('w1', null))

const TAB_HREFS = ['/w/w1', '/w/w1/tasks', '/w/w1/organization', '/w/w1/activity', '/w/w1/settings']

describe('ProjectTabs', () => {
  // Five since M47 R6: Organization sits third, between Tasks and Activity.
  it('renders the five tabs in order with their hrefs (M44 R2, M47 R6)', () => {
    pathname = '/w/w1'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={2} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, '').trim())).toEqual([
      'Overview',
      'Tasks',
      'Organization',
      'Activity',
      'Settings',
    ])
    expect(tabs.map((t) => t.getAttribute('href'))).toEqual(TAB_HREFS)
  })

  it('keeps Graph and Office reachable under Advanced, with their routes unchanged', () => {
    pathname = '/w/w1'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.queryByTestId('advanced-item-graph')).toBeNull()
    fireEvent.click(screen.getByTestId('project-advanced'))
    expect(screen.getByTestId('project-advanced').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('advanced-item-graph').getAttribute('href')).toBe('/w/w1/graph')
    expect(screen.getByTestId('advanced-item-office').getAttribute('href')).toBe('/w/w1/office')
    expect(screen.getByRole('menu').getAttribute('aria-label')).toBe('Advanced')
  })

  // `docs/ia.md` demotes `/analytics` from the sidebar and promises the per-workspace view is
  // reached FROM a project. This menu is where that promise is kept (M44 Task 4).
  it('reaches this project\'s analytics, scoped by ?workspace=, from the same menu', () => {
    pathname = '/w/w1'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    fireEvent.click(screen.getByTestId('project-advanced'))
    const link = screen.getByTestId('analytics-link')
    expect(link.getAttribute('href')).toBe('/analytics?workspace=w1')
    expect(link.textContent).toBe('Analytics')
    expect(link.getAttribute('role')).toBe('menuitem')
  })

  it('closes the Advanced menu on Escape and gives focus back to its trigger', () => {
    pathname = '/w/w1'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    fireEvent.click(screen.getByTestId('project-advanced'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('advanced-item-graph')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('project-advanced'))
  })

  // Fix round 1: `app/w/[workspaceId]/layout.tsx` mounts this component ONCE and keeps it across
  // every project tab, so a menu with no outside-click exit floats over the next page. Escape is
  // not enough on its own -- a person who clicks away has already stopped using the keyboard.
  it('closes the Advanced menu on a mousedown anywhere outside it, without stealing focus back', () => {
    pathname = '/w/w1'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    fireEvent.click(screen.getByTestId('project-advanced'))
    expect(screen.getByTestId('advanced-item-graph')).toBeTruthy()

    fireEvent.mouseDown(document.body)

    expect(screen.queryByTestId('advanced-item-graph')).toBeNull()
    expect(screen.getByTestId('project-advanced').getAttribute('aria-expanded')).toBe('false')
    // Unlike Escape, an outside click leaves focus where the person put it.
    expect(document.activeElement).not.toBe(screen.getByTestId('project-advanced'))
  })

  it('treats a mousedown on the trigger or inside the menu as inside -- the menu does not flicker shut', () => {
    pathname = '/w/w1'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    fireEvent.click(screen.getByTestId('project-advanced'))

    fireEvent.mouseDown(screen.getByTestId('advanced-item-graph'))
    expect(screen.getByTestId('advanced-item-graph')).toBeTruthy()

    // The trigger sits INSIDE the same root, so its own press does not race the toggle.
    fireEvent.mouseDown(screen.getByTestId('project-advanced'))
    expect(screen.getByTestId('advanced-item-graph')).toBeTruthy()
  })

  it('marks Advanced current while a Graph or Office route is open, so the strip never looks empty', () => {
    pathname = '/w/w1/graph'
    const { rerender } = render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.getByTestId('project-advanced').getAttribute('aria-current')).toBe('page')
    pathname = '/w/w1/office'
    rerender(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.getByTestId('project-advanced').getAttribute('aria-current')).toBe('page')
    pathname = '/w/w1/tasks'
    rerender(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.getByTestId('project-advanced').getAttribute('aria-current')).toBeNull()
  })

  it('marks Overview current only on the exact route', () => {
    pathname = '/w/w1'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.getByTestId('project-tab-overview').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('project-tab-tasks').getAttribute('aria-current')).toBeNull()
  })

  it('carries the active-task badge on Tasks only, from the initial value and then from publications', () => {
    pathname = '/w/w1/tasks'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={2} />)
    expect(screen.getByTestId('project-tab-badge-tasks').textContent).toBe('2')
    expect(screen.queryByTestId('project-tab-badge-overview')).toBeNull()
    act(() =>
      publishShellFacts('w1', {
        workspace: { id: 'w1', name: 'x' },
        counts: { slavesWorking: 1, tasksActive: 7 },
        guardrails: { budgetUsd: null, maxConcurrentRuns: 1, runTimeoutMs: 1000, maxAttempts: 1 },
        status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: null },
      }),
    )
    expect(screen.getByTestId('project-tab-badge-tasks').textContent).toBe('7')
  })
})
