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
      { label: 'Tool calls', value: '482', note: null },
      { label: 'Pauses', value: '7', note: null },
      { label: 'Active slaves', value: '3', note: null },
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
  // FIVE since M53 R12 (plan erratum E18): the `Spend` tile went with the raw `SUM(costUsd)`
  // behind it, and money is three figures with three words beside them on the Evidence tab.
  it('renders five KPI tiles with their notes, and no money tile at all', () => {
    render(<AnalyticsClient snapshot={snapshot()} workspaces={workspaces} seeded={false} />)
    expect(screen.getAllByTestId('kpi-tile')).toHaveLength(5)
    expect(screen.getAllByTestId('kpi-tile').map((tile) => tile.textContent ?? '').join(' | ')).not.toContain('Spend')
    expect(screen.queryByTestId('kpi-note-Spend')).toBeNull()
    expect(screen.getByTestId('kpi-note-Task success rate').textContent).toBe('23 of 25')
    expect(screen.queryByTestId('kpi-note-Pauses')).toBeNull()
  })

  it('hands the per-slave question over rather than dropping it (ia.md rule 2)', () => {
    render(<AnalyticsClient snapshot={snapshot()} workspaces={workspaces} seeded={false} />)
    const link = screen.getByTestId('evidence-link')
    expect(link.getAttribute('href')).toBe('/workforce?tab=evidence')
    expect(screen.queryByTestId('perf-success-a1')).toBeNull()
  })

  // M14 fix wave, review I5: the page returned a bare `flex flex-col gap-4`, so the `analytics`
  // h1 was clipped against the sidebar edge and both panels ran flush into the viewport. `p-4` is
  // the padding Settings and Slaves already use.
  it('pads the page the way the other global pages do', () => {
    render(<AnalyticsClient snapshot={snapshot()} workspaces={workspaces} seeded={false} />)
    // M45 R5: the page's own frame is one level in now, under the flush `PageShell`. The padding
    // is still the page's own -- that is exactly what `flush` is for.
    expect(screen.getByTestId('page-shell').querySelector(':scope > div')?.className).toContain('p-4')
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

// M44 erratum E25 / M45 R5: the one page frame reaches this page too. `flush`, so it brings its
// landmark and its `page-shell` marker and none of its padding -- the frame's own classes are
// unchanged, which is what keeps `gate:m14-fidelity`'s numbers where they are.
describe('AnalyticsClient (M44 E25 / M45 R5)', () => {
  it('renders inside the one page shell, with its own frame classes untouched', () => {
    render(<AnalyticsClient snapshot={snapshot()} workspaces={workspaces} seeded={false} />)
    const shell = screen.getByTestId('page-shell')
    expect(shell.className).not.toContain('p-3')
    expect(shell.querySelector(':scope > div')?.className).toBe('flex flex-col gap-4 p-4')
  })
})
