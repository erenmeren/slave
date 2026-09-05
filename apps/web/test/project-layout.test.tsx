// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ usePathname: () => '/w/w1/tasks', useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('../src/server/shell', () => ({
  buildShellFacts: vi.fn(async (id: string) =>
    id === 'w1'
      ? {
          workspace: { id: 'w1', name: 'Checkout Platform' },
          counts: { slavesWorking: 0, tasksActive: 3 },
          guardrails: { budgetUsd: 2, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 5 },
          status: { goal: 'Ship it', spentUsd: 0, unmeasuredRuns: 0, haltedReason: null },
        }
      : null,
  ),
}))
vi.mock('../src/server/org', () => ({ listWorkspaceNames: vi.fn(async () => [{ id: 'w1', name: 'Checkout Platform' }]) }))

import ProjectLayout from '../src/app/w/[workspaceId]/layout'

describe('the project layout', () => {
  it('renders the header, the tab strip and the page below them', async () => {
    const tree = await ProjectLayout({ params: Promise.resolve({ workspaceId: 'w1' }), children: <div data-testid="page">page</div> })
    render(tree)
    expect(screen.getByTestId('project-header')).toBeTruthy()
    expect(screen.getByTestId('project-goal').textContent).toBe('Goal: Ship it')
    expect(screen.getByTestId('project-tab-tasks').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('project-tab-badge-tasks').textContent).toBe('3')
    expect(screen.getByTestId('page')).toBeTruthy()
  })

  it('renders only the page for an unknown workspace (the page says so itself)', async () => {
    const tree = await ProjectLayout({ params: Promise.resolve({ workspaceId: 'nope' }), children: <div data-testid="page">no workspace</div> })
    render(tree)
    expect(screen.queryByTestId('project-header')).toBeNull()
    expect(screen.getByTestId('page')).toBeTruthy()
  })
})
