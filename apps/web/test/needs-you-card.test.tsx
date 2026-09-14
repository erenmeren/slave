// @vitest-environment jsdom
import { render, screen, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NeedsYouCard } from '../src/components/project/NeedsYouCard.js'
import type { NeedsYouItem } from '../src/server/needsYou.js'

vi.mock('next/navigation', () => ({
  usePathname: () => '/w/w1',
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const ITEMS: readonly NeedsYouItem[] = [
  { kind: 'decision', id: 'd-1', title: 'Staffing: nobody can review', href: '/w/w1#decision-d-1', since: '2026-09-14T09:00:00.000Z', taskId: null, decisionId: 'd-1', messageId: null },
  { kind: 'blocked_task', id: 't-1', title: 'Wire the webhook — no credentials', href: '/w/w1/tasks?task=t-1', since: '2026-09-14T08:00:00.000Z', taskId: 't-1', decisionId: null, messageId: null },
]

let fetchMock: ReturnType<typeof vi.fn>

beforeEach((): void => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach((): void => { vi.unstubAllGlobals() })

describe('the Needs you card', () => {
  it('lists one row per item, with the kind on the node and the chip in words', () => {
    render(<NeedsYouCard workspaceId="w1" items={ITEMS} />)
    const rows = screen.getAllByTestId('needs-you-row')
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual(['decision', 'blocked_task'])
    expect(rows[0]?.textContent).toContain('DECISION')
    expect(rows[1]?.textContent).toContain('BLOCKED')
    expect(screen.getByTestId('needs-you-card').textContent).toContain('2')
  })

  it('answers a decision in place, through the EXISTING approve route', async (): Promise<void> => {
    render(<NeedsYouCard workspaceId="w1" items={ITEMS} />)
    act((): void => { screen.getByTestId('needs-you-approve').click() })
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/supervisor/decisions/d-1/approve', expect.objectContaining({ method: 'POST' })),
    )
  })

  it('offers a blocked task a link to itself, never an Approve it cannot answer', () => {
    render(<NeedsYouCard workspaceId="w1" items={ITEMS} />)
    const rows = screen.getAllByTestId('needs-you-row')
    expect(rows[1]?.querySelector('[data-testid="needs-you-approve"]')).toBeNull()
    expect(rows[1]?.querySelector('a')?.getAttribute('href')).toBe('/w/w1/tasks?task=t-1')
  })

  it('gives EVERY row a chip with the raw kind in title and a working link (gate-m45 stage 3)', () => {
    render(<NeedsYouCard workspaceId="w1" items={ITEMS} />)
    for (const row of screen.getAllByTestId('needs-you-row')) {
      expect(row.querySelector('[data-testid="chip"]')?.getAttribute('title')).toBe(row.getAttribute('data-kind'))
      expect(row.querySelector('a')?.getAttribute('href')).toBeTruthy()
    }
  })

  it('says nothing needs you, rather than drawing an empty card', () => {
    render(<NeedsYouCard workspaceId="w1" items={[]} />)
    expect(screen.queryByTestId('needs-you-row')).toBeNull()
    expect(screen.getByTestId('needs-you-empty').textContent).toContain('Nothing needs you right now')
  })
})
