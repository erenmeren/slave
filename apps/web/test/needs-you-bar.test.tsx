// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NeedsYouBar, NeedsYouRow } from '../src/components/project/NeedsYouBar.js'
import type { NeedsYouItem } from '../src/server/needsYou.js'

/**
 * `NeedsYouBar`'s own coverage (review fix round 1, Important 1): the approve/reject controls a
 * decision row got back, the way the deleted `NeedsYouCard.tsx` had them. `command-strip.test.tsx`
 * covers the tab row and the plain (non-answerable) row shapes; this file is the one that dials
 * `postControl` and asserts the refetch.
 */

const DECISION: NeedsYouItem = {
  kind: 'decision',
  id: 'd-1',
  title: 'Staffing: nobody can review',
  href: '/w/w1#decision-d-1',
  since: '2026-09-19T09:00:00.000Z',
  taskId: null,
  decisionId: 'd-1',
  messageId: null,
}

const BLOCKED: NeedsYouItem = {
  kind: 'blocked_task',
  id: 't-1',
  title: 'Wire the webhook — no credentials',
  href: '/w/w1/tasks?task=t-1',
  since: '2026-09-19T08:00:00.000Z',
  taskId: 't-1',
  decisionId: null,
  messageId: null,
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach((): void => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('NeedsYouBar', () => {
  it('renders approve/reject only on a decision row', () => {
    render(<NeedsYouBar workspaceId="w1" initial={[DECISION, BLOCKED]} />)
    const rows = screen.getAllByTestId('needs-you-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.querySelector('[data-testid="needs-you-approve"]')).toBeTruthy()
    expect(rows[0]?.querySelector('[data-testid="needs-you-reject"]')).toBeTruthy()
    expect(rows[1]?.querySelector('[data-testid="needs-you-approve"]')).toBeNull()
    expect(rows[1]?.querySelector('[data-testid="needs-you-reject"]')).toBeNull()
  })

  it('does not nest a button inside the row link (review fix round 1, Important 1)', () => {
    render(<NeedsYouBar workspaceId="w1" initial={[DECISION]} />)
    const row = screen.getByTestId('needs-you-row')
    expect(row.tagName).toBe('DIV')
    const link = row.querySelector('a')
    expect(link?.querySelector('button')).toBeNull()
  })

  it('clicking approve posts to the decision route and removes the row once it is gone', async (): Promise<void> => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url === '/api/w/w1/supervisor/decisions/d-1/approve') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url === '/api/w/w1/needs-you') {
        return new Response(JSON.stringify([BLOCKED]), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })
    render(<NeedsYouBar workspaceId="w1" initial={[DECISION, BLOCKED]} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('needs-you-approve'))
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/supervisor/decisions/d-1/approve', { method: 'POST' })
    await waitFor(() => {
      expect(screen.getAllByTestId('needs-you-row')).toHaveLength(1)
    })
    expect(screen.queryByTestId('needs-you-approve')).toBeNull()
    expect(screen.getByTestId('needs-you-row').textContent).toContain('Wire the webhook')
  })

  it('clicking reject posts to the reject route', async (): Promise<void> => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url === '/api/w/w1/supervisor/decisions/d-1/reject') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url === '/api/w/w1/needs-you') return new Response(JSON.stringify([]), { status: 200 })
      return new Response('not found', { status: 404 })
    })
    render(<NeedsYouBar workspaceId="w1" initial={[DECISION]} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('needs-you-reject'))
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/supervisor/decisions/d-1/reject', { method: 'POST' })
    await waitFor(() => expect(screen.queryByTestId('needs-you-row')).toBeNull())
  })

  it('shows the refusal in needs-you-error and keeps the row when the write fails', async (): Promise<void> => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'the decision was already answered' }), { status: 409 }))
    render(<NeedsYouBar workspaceId="w1" initial={[DECISION]} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('needs-you-approve'))
    })

    expect(screen.getByTestId('needs-you-error').textContent).toBe('the decision was already answered')
    expect(screen.getByTestId('needs-you-row')).toBeTruthy()
  })

  it('is absent for an empty queue', () => {
    render(<NeedsYouBar workspaceId="w1" initial={[]} />)
    expect(screen.queryByTestId('needs-you')).toBeNull()
  })

  it('wraps the list in a ScrollArea capped at 40dvh, so 30 items scroll inside the strip instead of growing it (I2)', () => {
    const many: NeedsYouItem[] = Array.from({ length: 30 }, (_, i) => ({
      ...BLOCKED,
      id: `t-${String(i)}`,
      title: `Task ${String(i)}`,
    }))
    render(<NeedsYouBar workspaceId="w1" initial={many} />)
    expect(screen.getAllByTestId('needs-you-row')).toHaveLength(30)
    const scrollArea = screen.getByTestId('scroll-area')
    expect(scrollArea.className).toMatch(/max-h-/)
    expect(scrollArea.querySelectorAll('[data-testid="needs-you-row"]')).toHaveLength(30)
  })

  describe('the age (hydration fix, T11 minor promoted)', () => {
    it('renders no age text on the server, so the first client render matches it', () => {
      const html = renderToStaticMarkup(<NeedsYouRow item={DECISION} busy={null} onAnswer={() => {}} />)
      expect(html).not.toMatch(/ago|just now/)
    })

    it('shows the real age once mounted client-side', async () => {
      render(<NeedsYouRow item={DECISION} busy={null} onAnswer={() => {}} />)
      await waitFor(() => {
        expect(screen.getByTestId('needs-you-row').textContent).toMatch(/ago|just now/)
      })
    })
  })
})
