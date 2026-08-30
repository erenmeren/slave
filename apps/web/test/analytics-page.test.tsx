// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AnalyticsClient } from '../src/components/AnalyticsClient.js'
import { BarChart } from '../src/components/BarChart.js'
import type { AnalyticsSnapshot } from '../src/server/analytics.js'

const routerPush = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPush }), useSearchParams: () => new URLSearchParams() }))

function snapshot(over: Partial<AnalyticsSnapshot> = {}): AnalyticsSnapshot {
  return {
    workspaceId: 'w1',
    seeded: false,
    series: [
      { day: '2026-08-23', succeeded: 6, failed: 1 },
      { day: '2026-08-24', succeeded: 0, failed: 0 },
      { day: '2026-08-25', succeeded: 12, failed: 3 },
      { day: '2026-08-26', succeeded: 4, failed: 0 },
      { day: '2026-08-27', succeeded: 9, failed: 2 },
      { day: '2026-08-28', succeeded: 1, failed: 0 },
      { day: '2026-08-29', succeeded: 3, failed: 1 },
    ],
    kpis: [
      { label: 'Task success rate', value: '92%', note: '23 of 25' },
      { label: 'Avg run duration', value: '14m 20s', note: 'over 25 run(s)' },
      { label: 'Spend', value: '$8.43', note: '2 runs unmeasured' },
      { label: 'Tool calls', value: '482', note: null },
      { label: 'Pauses', value: '7', note: null },
      { label: 'Active agents', value: '3', note: null },
    ],
    perAgent: [
      { agentId: 'a1', name: 'Alex Turner', role: 'backend', runs: 42, successPct: 95, avgDurationMs: 760_000, tokens: 1_400_000, costUsd: 3.02, unmeasuredRuns: 0 },
      { agentId: 'a2', name: 'Bea Ng', role: 'qa', runs: 0, successPct: null, avgDurationMs: null, tokens: null, costUsd: 0, unmeasuredRuns: 0 },
    ],
    ...over,
  }
}

const workspaces = [{ id: 'w1', name: 'Checkout' }, { id: 'w2', name: 'Portal' }]

describe('BarChart', () => {
  it('draws one column per day, stacked, with the busiest day at full height', () => {
    render(<BarChart series={snapshot().series} height={180} label="tasks completed, last 7 days" />)
    expect(screen.getAllByTestId('bar-column')).toHaveLength(7)
    // The busiest day is 12+3 = 15; its succeeded segment is 12/15 of the 180px column.
    expect(screen.getByTestId('bar-ok-2026-08-25').getAttribute('height')).toBe('144')
    expect(screen.getByTestId('bar-fail-2026-08-25').getAttribute('height')).toBe('36')
  })

  it('draws nothing but the baseline for a day with no runs', () => {
    render(<BarChart series={snapshot().series} height={180} label="x" />)
    expect(screen.getByTestId('bar-ok-2026-08-24').getAttribute('height')).toBe('0')
  })

  it('carries an accessible label rather than being a decorative blob', () => {
    render(<BarChart series={snapshot().series} height={180} label="tasks completed, last 7 days" />)
    expect(screen.getByRole('img', { name: 'tasks completed, last 7 days' })).toBeTruthy()
  })
})

describe('AnalyticsClient', () => {
  it('renders six KPI tiles with their notes', () => {
    render(<AnalyticsClient snapshot={snapshot()} workspaces={workspaces} seeded={false} />)
    expect(screen.getAllByTestId('kpi-tile')).toHaveLength(6)
    expect(screen.getByTestId('kpi-note-Spend').textContent).toBe('2 runs unmeasured')
    expect(screen.queryByTestId('kpi-note-Pauses')).toBeNull()
  })

  it('renders the per-agent table with unknown marks where nothing was measured', () => {
    render(<AnalyticsClient snapshot={snapshot()} workspaces={workspaces} seeded={false} />)
    expect(screen.getByTestId('perf-tokens-a1').textContent).toBe('1.4M')
    expect(screen.getByTestId('perf-tokens-a2').textContent).toBe('—')
    expect(screen.getByTestId('perf-success-a2').textContent).toBe('—')
    expect(screen.getByTestId('perf-avg-a2').textContent).toBe('—')
  })

  it('shows the seeded caption only on the seeded workspace', () => {
    const { rerender } = render(<AnalyticsClient snapshot={snapshot()} workspaces={workspaces} seeded />)
    expect(screen.getByTestId('analytics-caption').textContent).toBe('Last 7 days · seeded development data')

    rerender(<AnalyticsClient snapshot={snapshot()} workspaces={workspaces} seeded={false} />)
    expect(screen.getByTestId('analytics-caption').textContent).toBe('Last 7 days')
  })

  it('navigates on a workspace change, including to the all-workspaces view', () => {
    render(<AnalyticsClient snapshot={snapshot()} workspaces={workspaces} seeded={false} />)
    fireEvent.change(screen.getByLabelText('workspace'), { target: { value: 'w2' } })
    expect(routerPush).toHaveBeenCalledWith('/analytics?workspace=w2')

    fireEvent.change(screen.getByLabelText('workspace'), { target: { value: '' } })
    expect(routerPush).toHaveBeenCalledWith('/analytics')
  })
})
