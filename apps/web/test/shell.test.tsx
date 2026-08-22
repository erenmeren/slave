// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../src/components/Sidebar.js'
import { TopBar } from '../src/components/TopBar.js'

let pathname = '/w/w1'

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}))

describe('the shell', () => {
  afterEach(() => {
    pathname = '/w/w1'
  })

  it('shows Overview as the current page and Tasks/Activity as live links', () => {
    render(<Sidebar workspaceId="w1" />)
    expect(screen.getByText('Overview')).toHaveProperty('ariaCurrent', 'page')
    expect(screen.getByText('Tasks').getAttribute('href')).toBe('/w/w1/tasks')
    expect(screen.getByText('Activity').getAttribute('href')).toBe('/w/w1/activity')
    expect(screen.getByText('Activity').getAttribute('aria-disabled')).toBeNull()
    // Graph is still the roadmap rendered as chrome — present, inert, and honest about why (spec
    // §7). Rendering it enabled would invite clicks into nothing.
    expect(screen.getByText('Graph').getAttribute('aria-disabled')).toBe('true')
  })

  it('marks Activity aria-current on the activity route', () => {
    pathname = '/w/w1/activity'
    render(<Sidebar workspaceId="w1" />)
    expect(screen.getByText('Activity')).toHaveProperty('ariaCurrent', 'page')
    expect(screen.getByText('Overview')).not.toHaveProperty('ariaCurrent', 'page')
  })

  it('turns the budget bar amber past 80% and red past 100%', () => {
    const { rerender } = render(
      <TopBar workspaceName="W" connection="connected" budget={{ spentUsd: 85, budgetUsd: 100 }} />,
    )
    expect(screen.getByTestId('budget').innerHTML).toContain('bg-status-warn')
    rerender(<TopBar workspaceName="W" connection="connected" budget={{ spentUsd: 101, budgetUsd: 100 }} />)
    expect(screen.getByTestId('budget').innerHTML).toContain('bg-status-danger')
  })

  it('reports the connection state it was given', () => {
    render(<TopBar workspaceName="W" connection="reconnecting" budget={null} />)
    expect(screen.getByTestId('connection').textContent).toContain('reconnecting')
  })
})
