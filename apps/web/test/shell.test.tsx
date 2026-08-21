// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../src/components/Sidebar.js'
import { TopBar } from '../src/components/TopBar.js'

vi.mock('next/navigation', () => ({
  usePathname: () => '/w/w1',
}))

describe('the shell', () => {
  it('shows Overview as the current page and Tasks as a live link', () => {
    render(<Sidebar workspaceId="w1" />)
    expect(screen.getByText('Overview')).toHaveProperty('ariaCurrent', 'page')
    expect(screen.getByText('Tasks').getAttribute('href')).toBe('/w/w1/tasks')
    // The still-inert entries are the roadmap rendered as chrome — present, inert, and honest
    // about why (spec §7). Rendering them enabled would invite clicks into nothing.
    for (const label of ['Activity', 'Graph']) {
      expect(screen.getByText(label).getAttribute('aria-disabled')).toBe('true')
    }
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
