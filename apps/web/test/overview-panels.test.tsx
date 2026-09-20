// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LiveEventsPanel, MergeQueuePanel } from '../src/components/activity/OverviewPanels.js'

/**
 * `LiveEventsPanel`/`MergeQueuePanel`'s own coverage (M61 R7/Task 6), split out of
 * `overview-components.test.tsx` when that file was deleted with `OverviewClient.tsx`, which used
 * to be their only caller. Both panels MOVED, unchanged, to `components/activity/OverviewPanels.tsx`
 * for Task 7's raw activity river -- this file moves with them rather than lapsing until Task 7
 * gets around to re-adding it.
 */

describe('Overview bottom row', () => {
  it('renders the 340px live-events panel with an all → action', () => {
    render(<LiveEventsPanel workspaceId="w1" events={[{ seq: 9, ts: '2026-08-29T10:00:00.000Z', type: 'run.tool_result', summary: 'Alex wrote a.txt' }]} />)
    expect(screen.getByTestId('live-events').className).toContain('w-[340px]')
    expect(screen.getByTestId('panel-header-action').textContent).toBe('all →')
    expect(screen.getAllByTestId('live-event-row')).toHaveLength(1)
    // The clock, not the whole ISO stamp — the handoff's events panel is a mono time column.
    expect(screen.getAllByTestId('live-event-row')[0]?.textContent).toContain('10:00:00')
  })

  it('points all → at this workspace\'s Activity page', () => {
    render(<LiveEventsPanel workspaceId="w1" events={[]} />)
    expect(screen.getByTestId('panel-header-action').querySelector('a')?.getAttribute('href')).toBe('/w/w1/activity')
    expect(screen.getByTestId('live-events-empty').textContent).toBe('no events yet')
  })

  it('gives a new live-events row the rise class and an existing one none', () => {
    const { rerender } = render(<LiveEventsPanel workspaceId="w1" events={[{ seq: 1, ts: '2026-08-29T10:00:00.000Z', type: 'run.started', summary: 'a' }]} />)
    rerender(
      <LiveEventsPanel
        workspaceId="w1"
        events={[
          { seq: 2, ts: '2026-08-29T10:00:01.000Z', type: 'run.started', summary: 'b' },
          { seq: 1, ts: '2026-08-29T10:00:00.000Z', type: 'run.started', summary: 'a' },
        ]}
      />,
    )
    const rows = screen.getAllByTestId('live-event-row')
    expect(rows[0]?.className).toContain('motion-safe:animate-[rise_0.3s_ease-out]')
    expect(rows[1]?.className).not.toContain('animate-[rise')
  })

  it('lists the merge queue FIFO and says nothing when it is empty', () => {
    const { rerender } = render(
      <MergeQueuePanel queue={[{ id: 't1', title: 'API contract', hasApproval: true }, { id: 't2', title: 'Checkout UI', hasApproval: true }]} />,
    )
    expect(screen.getAllByTestId('merge-row').map((r) => r.textContent)).toEqual(['API contract', 'Checkout UI'])

    rerender(<MergeQueuePanel queue={[]} />)
    expect(screen.getByTestId('merge-empty').textContent).toBe('nothing in the queue')
  })

  // Coordinator ruling (b): the merge pass SKIPS a `merging` task with no `task.review_approved`
  // event — it will never be picked up. The panel still lists it, last, and says why, because a
  // task stuck in the queue is exactly what an operator opened this panel to find.
  it('marks a queued task the merge pass will never pick up, and leaves the rest unmarked', () => {
    render(
      <MergeQueuePanel
        queue={[
          { id: 't1', title: 'API contract', hasApproval: true },
          { id: 't2', title: 'Hand-moved task', hasApproval: false },
        ]}
      />,
    )
    expect(screen.getAllByTestId('merge-row').map((r) => r.textContent)).toEqual([
      'API contract',
      'Hand-moved taskno approval',
    ])
    const marks = screen.getAllByTestId('merge-queue-no-approval')
    expect(marks).toHaveLength(1)
    expect(marks[0]?.textContent).toBe('no approval')
  })
})

