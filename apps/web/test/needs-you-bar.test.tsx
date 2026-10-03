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
  // Human cards H4: a machine card -- Approve and Reject in one click.
  goalVersion: null,
  blocking: false,
  groupKey: 'no_reviewer:reviewer',
  mergedIds: [],
  merged: [],
  oneClick: true,
  questionCard: false,
  draftPreview: null,
  draftPreviewCut: false,
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
  goalVersion: null,
  blocking: true,
  groupKey: 'task:t-1',
  mergedIds: [],
  merged: [],
  oneClick: false,
  questionCard: false,
  draftPreview: null,
  draftPreviewCut: false,
}

/** A question card offering `send_answer` (human cards H4, pre-flight F56): one labelled click. */
const ANSWER_CARD: NeedsYouItem = {
  ...DECISION,
  id: 'd-2',
  decisionId: 'd-2',
  title: 'Waiting on an answer: Which gateway?',
  href: '/w/w1/activity#decision-d-2',
  goalVersion: 2,
  blocking: true,
  groupKey: 'question:m-2',
  oneClick: true,
  questionCard: true,
}

/** A question card that does not offer `send_answer` -- an escalation, or a draftless answer. */
const ESCALATION_CARD: NeedsYouItem = { ...ANSWER_CARD, id: 'd-3', decisionId: 'd-3', href: '/w/w1/activity#decision-d-3', oneClick: false }

/** What the page's stream has published (`useShellFacts`): null -- no poll -- unless a case wakes
 *  the bar the way a project page's stream does. */
let shellFacts: unknown = null
vi.mock('../src/hooks/useShellFacts', () => ({ useShellFacts: () => shellFacts }))

let fetchMock: ReturnType<typeof vi.fn>

beforeEach((): void => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach((): void => {
  vi.unstubAllGlobals()
  shellFacts = null
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

  // Fix round 2: a refusal is dismissible, and a later refresh that succeeds clears it.
  it('dismisses a refusal, and clears one when a later refresh succeeds', async (): Promise<void> => {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).endsWith('/approve')) return new Response(JSON.stringify({ error: 'the decision was already answered' }), { status: 409 })
      return new Response(JSON.stringify([]), { status: 200 })
    })
    const view = render(<NeedsYouBar workspaceId="w1" initial={[DECISION]} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('needs-you-approve'))
    })
    fireEvent.click(screen.getByTestId('needs-you-error-dismiss'))
    expect(screen.queryByTestId('needs-you-error')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByTestId('needs-you-approve'))
    })
    expect(screen.getByTestId('needs-you-error')).toBeTruthy()
    // The page's stream wakes the bar; its refresh comes back (empty) and the old refusal goes.
    shellFacts = { tick: 1 }
    await act(async () => {
      view.rerender(<NeedsYouBar workspaceId="w1" initial={[DECISION]} />)
    })
    await waitFor(() => expect(screen.queryByTestId('needs-you-error')).toBeNull())
    expect(screen.queryByTestId('needs-you')).toBeNull()
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

  describe('one queue per goal version (human cards H4, plan B Task 9)', () => {
    it('renders "decide" -- a link to the card -- and no Approve or Reject on a question card that does not offer send_answer', () => {
      render(<NeedsYouRow item={ESCALATION_CARD} busy={null} onAnswer={() => {}} />)
      const open = screen.getByTestId('needs-you-open')
      expect(open.tagName).toBe('A')
      expect(open.getAttribute('href')).toBe('/w/w1/activity#decision-d-3')
      expect(open.textContent).toBe('decide')
      expect(screen.queryByTestId('needs-you-approve')).toBeNull()
      expect(screen.queryByTestId('needs-you-reject')).toBeNull()
    })

    it('labels the one click on a question card with what it does, and offers no Reject (pre-flight F64)', () => {
      render(<NeedsYouRow item={ANSWER_CARD} busy={null} onAnswer={() => {}} />)
      expect(screen.getByTestId('needs-you-approve').textContent).toBe('Send this answer')
      expect(screen.queryByTestId('needs-you-reject')).toBeNull()
      // The card's other decisions ("dismiss and close" among them) are one link away.
      expect(screen.getByTestId('needs-you-open').getAttribute('href')).toBe('/w/w1/activity#decision-d-2')
      // No button on a question row reads as a bare, opaque approve or reject.
      const words = [...screen.getByTestId('needs-you-row').querySelectorAll('button')].map((button) => button.textContent?.trim().toLowerCase())
      expect(words).not.toContain('approve')
      expect(words).not.toContain('reject')
    })

    it('keeps Approve and Reject on a machine card', () => {
      render(<NeedsYouRow item={DECISION} busy={null} onAnswer={() => {}} />)
      expect(screen.getByTestId('needs-you-approve').textContent).toBe('Approve')
      expect(screen.getByTestId('needs-you-reject').textContent).toBe('Reject')
      expect(screen.queryByTestId('needs-you-open')).toBeNull()
    })

    it('marks a blocking row, in words as well as data-blocking, and names its version', () => {
      render(<NeedsYouRow item={ANSWER_CARD} busy={null} onAnswer={() => {}} />)
      const row = screen.getByTestId('needs-you-row')
      expect(row.getAttribute('data-blocking')).toBe('true')
      expect(screen.getByTestId('needs-you-blocking').textContent).toBe('blocking v2')
      expect(screen.getByTestId('needs-you-version').textContent).toBe('v2')
    })

    it('marks a row that blocks nothing data-blocking="false", with no version chip on a project-level item', () => {
      render(<NeedsYouRow item={DECISION} busy={null} onAnswer={() => {}} />)
      expect(screen.getByTestId('needs-you-row').getAttribute('data-blocking')).toBe('false')
      expect(screen.queryByTestId('needs-you-blocking')).toBeNull()
      expect(screen.queryByTestId('needs-you-version')).toBeNull()
    })

    it('says how many items merged into a row, and leads to each of them', () => {
      const merged: NeedsYouItem = { ...BLOCKED, id: 't-9', taskId: 't-9', title: 'Wire the webhook — blocked', href: '/w/w1/tasks?task=t-9' }
      render(<NeedsYouRow item={{ ...DECISION, mergedIds: ['t-9'], merged: [merged] }} busy={null} onAnswer={() => {}} />)
      const group = screen.getByTestId('needs-you-merged')
      expect(group.getAttribute('data-count')).toBe('1')
      expect(group.querySelector('summary')?.textContent).toBe('+1 more on this subject')
      expect(group.querySelector('a')?.getAttribute('href')).toBe('/w/w1/tasks?task=t-9')
      // The row's own title is still its first link (the gates read it).
      expect(screen.getByTestId('needs-you-row').querySelector('a')?.textContent).toBe(DECISION.title)
    })

    it('renders a hostile title as text', () => {
      render(<NeedsYouRow item={{ ...ESCALATION_CARD, title: '<img src=x onerror=alert(1)>' }} busy={null} onAnswer={() => {}} />)
      expect(screen.getByTestId('needs-you-row').querySelector('img')).toBeNull()
    })

    it("sends a question card's one click as decide { kind: send_answer }, shows what it did named by its card, and refetches at once", async (): Promise<void> => {
      fetchMock.mockImplementation(async (input: unknown) => {
        const url = String(input)
        if (url === '/api/w/w1/supervisor/decisions/d-2/decide') {
          return new Response(JSON.stringify({ ok: true, outcome: { decision: { kind: 'send_answer' }, summary: 'sent the drafted answer' } }), { status: 200 })
        }
        if (url === '/api/w/w1/needs-you') return new Response(JSON.stringify([BLOCKED]), { status: 200 })
        return new Response('not found', { status: 404 })
      })
      render(<NeedsYouBar workspaceId="w1" initial={[ANSWER_CARD, BLOCKED]} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('needs-you-approve'))
      })

      expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/supervisor/decisions/d-2/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'send_answer' }),
      })
      expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain('/api/w/w1/supervisor/decisions/d-2/approve')
      await waitFor(() => expect(screen.getAllByTestId('needs-you-row')).toHaveLength(1))
      expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/needs-you')
      expect(screen.getByTestId('needs-you-notice').textContent).toBe('Waiting on an answer: Which gateway? — sent the drafted answer')
      expect(screen.getByTestId('needs-you-notice').getAttribute('role')).toBe('status')
    })

    it('names the card a settled-first notice is about, then refetches', async (): Promise<void> => {
      fetchMock.mockImplementation(async (input: unknown) => {
        const url = String(input)
        if (url.endsWith('/decide')) {
          return new Response(JSON.stringify({ error: 'the question is closed', notice: 'Already closed by alice at 2026-10-03 08:00 UTC.' }), { status: 409 })
        }
        return new Response(JSON.stringify([]), { status: 200 })
      })
      render(<NeedsYouBar workspaceId="w1" initial={[ANSWER_CARD]} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('needs-you-approve'))
      })

      // Fix round 1: the list refetched empty, and the notice outlives the last row.
      await waitFor(() => expect(screen.queryByTestId('needs-you-row')).toBeNull())
      expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/needs-you')
      expect(screen.getByTestId('needs-you-notice').textContent).toBe('Waiting on an answer: Which gateway? — Already closed by alice at 2026-10-03 08:00 UTC.')
      // Dismissed, the empty bar goes.
      fireEvent.click(screen.getByTestId('needs-you-notice-dismiss'))
      expect(screen.queryByTestId('needs-you')).toBeNull()
    })

    it("keeps what the last decided card did on screen when the list refreshes empty (fix round 1)", async (): Promise<void> => {
      fetchMock.mockImplementation(async (input: unknown) => {
        if (String(input).endsWith('/decide')) {
          return new Response(JSON.stringify({ ok: true, outcome: { decision: { kind: 'send_answer' }, summary: 'sent the drafted answer' } }), { status: 200 })
        }
        return new Response(JSON.stringify([]), { status: 200 })
      })
      render(<NeedsYouBar workspaceId="w1" initial={[ANSWER_CARD]} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('needs-you-approve'))
      })

      await waitFor(() => expect(screen.queryByTestId('needs-you-row')).toBeNull())
      expect(screen.getByTestId('needs-you-notice').textContent).toBe('Waiting on an answer: Which gateway? — sent the drafted answer')
      expect(screen.getByTestId('needs-you-notice').getAttribute('role')).toBe('status')
    })

    it('shows the draft the one click sends, as text, and none on a row without that one click (fix round 1)', () => {
      const { unmount } = render(<NeedsYouRow item={{ ...ANSWER_CARD, draftPreview: 'Use Stripe.' }} busy={null} onAnswer={() => {}} />)
      expect(screen.getByTestId('needs-you-draft').textContent).toBe('Sends: “Use Stripe.”')
      unmount()
      // No preview where the server gave none (a card that does not offer send_answer), nor on a
      // machine card.
      const { unmount: again } = render(<NeedsYouRow item={ESCALATION_CARD} busy={null} onAnswer={() => {}} />)
      expect(screen.queryByTestId('needs-you-draft')).toBeNull()
      again()
      render(<NeedsYouRow item={{ ...DECISION, draftPreview: 'Use Stripe.' }} busy={null} onAnswer={() => {}} />)
      expect(screen.queryByTestId('needs-you-draft')).toBeNull()
    })

    it('shows the whole preview, never clamped to a few lines (fix round 2)', () => {
      const draft = `${'Use Stripe for cards.\n'.repeat(12)}Done.`
      render(<NeedsYouRow item={{ ...ANSWER_CARD, draftPreview: draft }} busy={null} onAnswer={() => {}} />)
      const shown = screen.getByTestId('needs-you-draft')
      expect(shown.textContent).toBe(`Sends: “${draft}”`)
      expect(shown.className).not.toMatch(/line-clamp|truncate/)
      expect(screen.queryByTestId('needs-you-draft-cut')).toBeNull()
    })

    it('says a cut draft is longer, and offers decide instead of the one click (fix round 2)', () => {
      render(<NeedsYouRow item={{ ...ANSWER_CARD, oneClick: false, draftPreview: 'Use Stripe…', draftPreviewCut: true }} busy={null} onAnswer={() => {}} />)
      expect(screen.getByTestId('needs-you-draft').textContent).toBe('The draft begins: “Use Stripe…”')
      expect(screen.getByTestId('needs-you-draft-cut').textContent).toContain('longer than this')
      expect(screen.queryByTestId('needs-you-approve')).toBeNull()
      expect(screen.getByTestId('needs-you-open').getAttribute('href')).toBe(ANSWER_CARD.href)
    })

    it('keeps the notice when the layout hands down a fresh, empty list (fix round 2)', async (): Promise<void> => {
      fetchMock.mockImplementation(async (input: unknown) => {
        if (String(input).endsWith('/decide')) {
          return new Response(JSON.stringify({ ok: true, outcome: { decision: { kind: 'send_answer' }, summary: 'sent the drafted answer' } }), { status: 200 })
        }
        return new Response(JSON.stringify([]), { status: 200 })
      })
      const view = render(<NeedsYouBar workspaceId="w1" initial={[ANSWER_CARD]} />)
      await act(async () => {
        fireEvent.click(screen.getByTestId('needs-you-approve'))
      })
      view.rerender(<NeedsYouBar workspaceId="w1" initial={[]} />)
      expect(screen.getByTestId('needs-you-notice').textContent).toBe('Waiting on an answer: Which gateway? — sent the drafted answer')
      // Another project's bar starts clean.
      view.rerender(<NeedsYouBar workspaceId="w2" initial={[]} />)
      expect(screen.queryByTestId('needs-you')).toBeNull()
    })

    it('renders a hostile draft inert', () => {
      render(<NeedsYouRow item={{ ...ANSWER_CARD, draftPreview: '<img src=x onerror=alert(1)><script>alert(2)</script>' }} busy={null} onAnswer={() => {}} />)
      const draft = screen.getByTestId('needs-you-draft')
      expect(draft.querySelector('img')).toBeNull()
      expect(draft.querySelector('script')).toBeNull()
      expect(draft.textContent).toContain('<img src=x onerror=alert(1)>')
    })

    it('marks each blocking member of a merged row (fix round 1)', () => {
      const blocking: NeedsYouItem = { ...BLOCKED, id: 't-9', taskId: 't-9', goalVersion: 1, blocking: true }
      const quiet: NeedsYouItem = { ...DECISION, id: 'd-8', decisionId: 'd-8', blocking: false }
      render(<NeedsYouRow item={{ ...DECISION, blocking: true, mergedIds: ['t-9', 'd-8'], merged: [blocking, quiet] }} busy={null} onAnswer={() => {}} />)
      const members = [...screen.getByTestId('needs-you-merged').querySelectorAll('li')]
      expect(members.map((li) => li.getAttribute('data-blocking'))).toEqual(['true', 'false'])
      expect(members[0]?.querySelector('[data-testid="needs-you-merged-blocking"]')?.textContent).toBe('blocking v1')
      expect(members[1]?.querySelector('[data-testid="needs-you-merged-blocking"]')).toBeNull()
    })

    it('keeps the named notice visible while the list still has rows', async (): Promise<void> => {
      fetchMock.mockImplementation(async (input: unknown) => {
        const url = String(input)
        if (url.endsWith('/approve')) {
          return new Response(JSON.stringify({ error: 'not pending', notice: 'Already closed by alice at 2026-10-03 08:00 UTC.' }), { status: 409 })
        }
        return new Response(JSON.stringify([BLOCKED]), { status: 200 })
      })
      render(<NeedsYouBar workspaceId="w1" initial={[DECISION, BLOCKED]} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('needs-you-approve'))
      })

      await waitFor(() => expect(screen.getAllByTestId('needs-you-row')).toHaveLength(1))
      expect(screen.getByTestId('needs-you-notice').textContent).toBe('Staffing: nobody can review — Already closed by alice at 2026-10-03 08:00 UTC.')
      expect(screen.queryByTestId('needs-you-error')).toBeNull()
    })

    it('disables the one click while it is in flight, so it is never sent twice', async (): Promise<void> => {
      let release: (value: Response) => void = () => {}
      fetchMock.mockImplementation(async (input: unknown) => {
        if (String(input).endsWith('/decide')) return new Promise<Response>((resolve) => { release = resolve })
        return new Response(JSON.stringify([]), { status: 200 })
      })
      render(<NeedsYouBar workspaceId="w1" initial={[ANSWER_CARD]} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('needs-you-approve'))
      })
      const button = screen.getByTestId('needs-you-approve') as HTMLButtonElement
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
      expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/decide'))).toHaveLength(1)
      await act(async () => {
        release(new Response(JSON.stringify({ ok: true, outcome: { decision: { kind: 'send_answer' }, summary: 'sent the drafted answer' } }), { status: 200 }))
      })
    })
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
