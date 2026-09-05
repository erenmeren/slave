// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishShellFacts } from '../src/hooks/useShellFacts'
import { ProjectTabs } from '../src/components/project/ProjectTabs'

let pathname = '/w/w1'
vi.mock('next/navigation', () => ({ usePathname: () => pathname }))

afterEach(() => publishShellFacts('w1', null))

const TAB_HREFS = ['/w/w1', '/w/w1/tasks', '/w/w1/graph', '/w/w1/office', '/w/w1/activity', '/w/w1/settings']

describe('ProjectTabs', () => {
  it('renders the six tabs in order with their hrefs', () => {
    pathname = '/w/w1'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={2} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, '').trim())).toEqual(['Overview', 'Tasks', 'Graph', 'Office', 'Activity', 'Settings'])
    expect(tabs.map((t) => t.getAttribute('href'))).toEqual(TAB_HREFS)
  })

  it('marks Overview current only on the exact route', () => {
    pathname = '/w/w1'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.getByTestId('project-tab-overview').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('project-tab-tasks').getAttribute('aria-current')).toBeNull()
  })

  it('marks Graph current on a graph route with a query string', () => {
    pathname = '/w/w1/graph'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.getByTestId('project-tab-graph').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('project-tab-overview').getAttribute('aria-current')).toBeNull()
  })

  it('marks Office current on the office route', () => {
    pathname = '/w/w1/office'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.getByTestId('project-tab-office').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('project-tab-graph').getAttribute('aria-current')).toBeNull()
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
