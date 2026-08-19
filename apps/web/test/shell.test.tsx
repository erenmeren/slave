// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Sidebar } from '../src/components/Sidebar.js'
import { TopBar } from '../src/components/TopBar.js'

describe('the shell', () => {
  it('shows Overview as the one enabled destination', () => {
    render(<Sidebar />)
    expect(screen.getByText('Overview')).toHaveProperty('ariaCurrent', 'page')
    // The disabled entries are the roadmap rendered as chrome — present, inert, and honest
    // about why (spec §7). Rendering them enabled would invite clicks into nothing.
    for (const label of ['Tasks', 'Activity', 'Graph']) {
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
