// @vitest-environment jsdom
import { fireEvent, render, screen, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SupervisorThreadPanel, type PendingDecision } from '../src/components/supervisor/SupervisorThreadPanel.js'
import type { SupervisorThread } from '../src/server/supervisorThreads.js'

vi.mock('next/navigation', () => ({
  usePathname: () => '/w/w1',
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('../src/hooks/useShellFacts', () => ({ useShellFacts: () => null }))

const THREADS: readonly SupervisorThread[] = [
  {
    id: '2026-09-14',
    title: 'make the cart totals right',
    when: 'today',
    messages: [
      { id: '1', who: 'operator', text: 'make the cart totals right', at: '2026-09-14T09:00:00.000Z', refs: ['v2'], decisionId: null },
      { id: '2', who: 'supervisor', text: 'Supervisor · proposed', at: '2026-09-14T09:01:00.000Z', refs: ['T-118'], decisionId: 'd-1' },
    ],
  },
  { id: '2026-09-13', title: 'earlier', when: 'yesterday', messages: [
    { id: '0', who: 'operator', text: 'earlier', at: '2026-09-13T09:00:00.000Z', refs: [], decisionId: null },
  ] },
]

const DECISIONS: readonly PendingDecision[] = [
  {
    id: 'd-1',
    situationKind: 'ready_unstaffed',
    situation: { summary: 'nobody can review' },
    status: 'pending',
    // A NON-answer kind, so every Approve/Decline case below is about a proposal this card is
    // allowed to answer in one click (ruling T5-3).
    action: { kind: 'set_runtime_roles' },
  },
]

let fetchMock: ReturnType<typeof vi.fn>

beforeEach((): void => {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
    // The view's own GET (`/api/w/:id/supervisor`, no further path) -- what the scope line's
    // autonomy switch reads on mount. Matched by suffix rather than `includes('/supervisor')`,
    // which would also catch `/supervisor/threads` and the settings/decisions routes below.
    if (url.endsWith('/supervisor')) {
      return new Response(JSON.stringify({ settings: { enabled: true, profile: null, autonomy: 'propose' } }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true, version: 3 }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('the Supervisor panel', () => {
  it('renders the newest thread, oldest message first, and says which side each is on', async (): Promise<void> => {
    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    await waitFor(() => expect(screen.getAllByTestId('supervisor-message')).toHaveLength(2))
    const messages = screen.getAllByTestId('supervisor-message')
    expect(messages[0]?.getAttribute('data-who')).toBe('operator')
    expect(messages[0]?.textContent).toContain('make the cart totals right')
    expect(messages[1]?.getAttribute('data-who')).toBe('supervisor')
    expect(screen.getByTestId('supervisor-thread').getAttribute('data-thread-id')).toBe('2026-09-14')
  })

  it('lists the days behind ≡, and switching day switches the messages', async (): Promise<void> => {
    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    await waitFor(() => expect(screen.getAllByTestId('supervisor-message')).toHaveLength(2))
    act((): void => { screen.getByTestId('supervisor-history').click() })
    const rows = screen.getAllByTestId('supervisor-thread-row')
    expect(rows).toHaveLength(2)
    expect(rows[1]?.textContent).toContain('yesterday')
    act((): void => { rows[1]?.click() })
    await waitFor(() => expect(screen.getAllByTestId('supervisor-message')).toHaveLength(1))
    expect(screen.getByTestId('supervisor-thread').getAttribute('data-thread-id')).toBe('2026-09-13')
  })

  it('puts a decision card inside the message that carries its id', async (): Promise<void> => {
    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    await waitFor(() => expect(screen.getByTestId('supervisor-decision-card')).toBeTruthy())
    const card = screen.getByTestId('supervisor-decision-card')
    expect(card.getAttribute('data-decision-id')).toBe('d-1')
    expect(card.textContent).toContain('nobody can review')
    const message = screen.getAllByTestId('supervisor-message')[1]
    expect(message?.contains(card)).toBe(true)
  })

  it('draws ONE card for a decision two messages name -- `decided` and `proposed` are one proposal', async (): Promise<void> => {
    const twice: readonly SupervisorThread[] = [
      {
        ...THREADS[0]!,
        messages: [
          { id: '1', who: 'supervisor', text: 'Supervisor · decided', at: '2026-09-14T09:00:00.000Z', refs: [], decisionId: 'd-1' },
          { id: '2', who: 'supervisor', text: 'Supervisor · proposed', at: '2026-09-14T09:00:01.000Z', refs: [], decisionId: 'd-1' },
        ],
      },
    ]
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/supervisor/threads') ? new Response(JSON.stringify(twice), { status: 200 }) : new Response('{}', { status: 200 }),
    )
    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    await waitFor(() => expect(screen.getAllByTestId('supervisor-message')).toHaveLength(2))
    const cards = screen.getAllByTestId('supervisor-decision-card')
    expect(cards).toHaveLength(1)
    // On the FIRST message that names it, so the card sits where the proposal begins.
    expect(screen.getAllByTestId('supervisor-message')[0]?.contains(cards[0]!)).toBe(true)
  })

  it('still shows a proposal this day s conversation never mentions -- the dock badge must not lie', async (): Promise<void> => {
    const orphan: readonly PendingDecision[] = [
      ...DECISIONS,
      { id: 'd-9', situationKind: 'no_reviewer', situation: { summary: 'nobody may review' }, status: 'pending' },
    ]
    render(<SupervisorThreadPanel workspaceId="w1" pending={orphan} />)
    await waitFor(() => expect(screen.getAllByTestId('supervisor-decision-card')).toHaveLength(2))
    const loose = screen.getAllByTestId('supervisor-decision-card').find((card) => card.getAttribute('data-decision-id') === 'd-9')
    expect(loose).toBeTruthy()
    expect(screen.getAllByTestId('supervisor-message').some((message) => message.contains(loose!))).toBe(false)
  })

  // Ruling T5-3: an `answer_question` proposal sends a DRAFTED ANSWER to another worker in the
  // operator's name, and this card shows the situation summary, not the draft. One-click Approve
  // here would be approving words nobody has read.
  it('sends an answer_question proposal to be READ instead of offering one-click Approve', async (): Promise<void> => {
    const answering: readonly PendingDecision[] = [
      {
        id: 'd-1',
        situationKind: 'waiting_stale',
        situation: { summary: 'a worker has been waiting on an answer for two hours' },
        status: 'pending',
        action: { kind: 'answer_question' },
      },
    ]
    render(<SupervisorThreadPanel workspaceId="w1" pending={answering} />)
    await waitFor(() => expect(screen.getByTestId('supervisor-decision-card')).toBeTruthy())

    // The timeline's DECISION REQUIRED lane renders `ProposalRow`, which shows the question, the
    // draft in an editable box and every source behind it.
    expect(screen.getByTestId('supervisor-decision-review').getAttribute('href')).toBe('/w/w1')
    expect(screen.queryByTestId('supervisor-decision-approve')).toBeNull()
    expect(screen.queryByTestId('supervisor-decision-decline')).toBeNull()
    // The two chips gate-m44 reads are untouched by the branch.
    expect(screen.getByTestId('supervisor-proposal-kind').getAttribute('title')).toBe('waiting_stale')
    expect(screen.getByTestId('supervisor-decision-meta')).toBeTruthy()
  })

  it('approves through the EXISTING route', async (): Promise<void> => {
    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    await waitFor(() => expect(screen.getByTestId('supervisor-decision-approve')).toBeTruthy())
    act((): void => { screen.getByTestId('supervisor-decision-approve').click() })
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/w/w1/supervisor/decisions/d-1/approve',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })

  it('sends the composer to the EXISTING goal/request route, on Enter', async (): Promise<void> => {
    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    await waitFor(() => expect(screen.getByTestId('supervisor-composer')).toBeTruthy())
    const box = screen.getByTestId('supervisor-request-input')
    // `fireEvent.change`, not a hand-dispatched `input`: React's value tracker sees a direct
    // `node.value = ...` assignment and reports the value as UNCHANGED, so `onChange` never runs
    // and the composer stays empty (which is exactly what the draft of this test measured).
    fireEvent.change(box, { target: { value: 'add 3-D Secure' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/w/w1/goal/request',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ request: 'add 3-D Secure' }) }),
      ),
    )
    // The SUCCESS line `gate-m45` stage 5 waits for, naming the version the route answered with.
    await waitFor(() => expect(screen.getByTestId('supervisor-request-result').textContent).toContain('goal v3'))
  })

  it('renders the route s refusal in its own line, with no success line beside it', async (): Promise<void> => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/supervisor/threads')
        ? new Response(JSON.stringify(THREADS), { status: 200 })
        : new Response(JSON.stringify({ error: 'this project is halted: the budget is exhausted' }), { status: 409 }),
    )
    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    await waitFor(() => expect(screen.getByTestId('supervisor-composer')).toBeTruthy())

    fireEvent.change(screen.getByTestId('supervisor-request-input'), { target: { value: 'add 3-D Secure' } })
    fireEvent.click(screen.getByTestId('supervisor-request-send'))

    await waitFor(() =>
      expect(screen.getByTestId('supervisor-request-error').textContent).toBe('this project is halted: the budget is exhausted'),
    )
    expect(screen.queryByTestId('supervisor-request-result')).toBeNull()
  })

  // M57 t6: three cases that lived on `project/SupervisorRequest`'s own describe until that
  // component was deleted. The composer is the one box posting to `/goal/request` now, and these
  // are behaviours it still has -- so they moved here rather than dying with the widget.
  it('will not send an empty request, and names its box for a screen reader', async (): Promise<void> => {
    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    await waitFor(() => expect(screen.getByTestId('supervisor-composer')).toBeTruthy())
    const box = screen.getByTestId('supervisor-request-input')
    // M45 final wave, M2: a placeholder is not a name, and it disappears the moment somebody types.
    expect(box.getAttribute('aria-label')).toBe('Message the Supervisor')
    expect(screen.getByLabelText('Message the Supervisor')).toBeTruthy()

    expect((screen.getByTestId('supervisor-request-send') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(box, { target: { value: '   ' } })
    expect((screen.getByTestId('supervisor-request-send') as HTMLButtonElement).disabled).toBe(true)
  })

  it('will not send the same request twice while the first is still in flight', async (): Promise<void> => {
    // `duplicate_request` is the route's backstop, not the UX: the button goes down the moment a
    // POST leaves, so a double click is one write.
    let release: (() => void) | null = null
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
      return new Promise<Response>((resolve) => {
        release = () => resolve(new Response(JSON.stringify({ ok: true, version: 3 }), { status: 200 }))
      })
    })
    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    await waitFor(() => expect(screen.getByTestId('supervisor-composer')).toBeTruthy())
    fireEvent.change(screen.getByTestId('supervisor-request-input'), { target: { value: 'add 3-D Secure' } })
    fireEvent.click(screen.getByTestId('supervisor-request-send'))

    expect((screen.getByTestId('supervisor-request-send') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('supervisor-request-send'))
    await act(async (): Promise<void> => {
      release?.()
    })
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/goal/request'))).toHaveLength(1)
  })

  it('shows a refusal without clearing what was typed', async (): Promise<void> => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/supervisor/threads')
        ? new Response(JSON.stringify(THREADS), { status: 200 })
        : new Response(
            JSON.stringify({ error: 'project w1 already recorded exactly this change request at version 3: nothing was recorded' }),
            { status: 409 },
          ),
    )
    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    await waitFor(() => expect(screen.getByTestId('supervisor-composer')).toBeTruthy())
    fireEvent.change(screen.getByTestId('supervisor-request-input'), { target: { value: 'add 3-D Secure' } })
    fireEvent.click(screen.getByTestId('supervisor-request-send'))

    await waitFor(() => expect(screen.getByTestId('supervisor-request-error').textContent).toContain('nothing was recorded'))
    // A refusal that emptied the box would delete the words a person has to read to understand it.
    expect((screen.getByTestId('supervisor-request-input') as HTMLTextAreaElement).value).toBe('add 3-D Secure')
  })

  it('says so, once, when there is no conversation yet', async (): Promise<void> => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/supervisor/threads') ? new Response('[]', { status: 200 }) : new Response('{}', { status: 200 }),
    )
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    await waitFor(() => expect(screen.getByTestId('supervisor-empty')).toBeTruthy())
    expect(screen.queryAllByTestId('supervisor-message')).toEqual([])
    // The composer is still there: an empty conversation is where you START one.
    expect(screen.getByTestId('supervisor-composer')).toBeTruthy()
  })

  // R14/I3 (final-review wave): the chrome fixes -- the footer's own "recorded as an event" line
  // is gone, the composer names the Enter key with a real `<kbd>`, and the scope line is still
  // findable, just promoted out of the composer's footer.
  it('drops the composer footer line, keeps the scope line, and names Enter with a kbd', async (): Promise<void> => {
    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    await waitFor(() => expect(screen.getByTestId('supervisor-composer')).toBeTruthy())
    expect(screen.queryByText('Every message is recorded as an event.')).toBeNull()
    expect(screen.getByText('this project', { exact: false })).toBeTruthy()
    const composer = screen.getByTestId('supervisor-composer')
    expect(composer.querySelector('kbd')).toBeTruthy()
    expect(composer.querySelector('kbd')?.textContent).toBe('⏎')
  })

  // R1/R8 (Task 7): the autonomy switch, on the scope line -- the same setting `RuntimePanel`'s
  // own `runtime-autonomy` checkbox writes, read here off the view this panel fetches once on
  // mount rather than off `useShellFacts` (mocked to `null` in this file; it carries none of the
  // Supervisor's own settings).
  it('renders the autonomy switch off the view, PATCHes it on toggle, and disables it while the request is in flight', async (): Promise<void> => {
    let currentAutonomy: 'propose' | 'act' = 'propose'
    let resolvePatch: (() => void) | null = null
    fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
      if (url.endsWith('/supervisor/settings')) {
        return new Promise<Response>((resolve) => {
          resolvePatch = () => {
            const body = JSON.parse(init?.body ?? '{}') as { autonomy?: 'propose' | 'act' }
            if (body.autonomy !== undefined) currentAutonomy = body.autonomy
            resolve(new Response('{}', { status: 200 }))
          }
        })
      }
      if (url.endsWith('/supervisor')) {
        return new Response(JSON.stringify({ settings: { enabled: true, profile: null, autonomy: currentAutonomy } }), {
          status: 200,
        })
      }
      return new Response('{}', { status: 200 })
    })

    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    const toggle = await screen.findByTestId('supervisor-autonomy')
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false))

    fireEvent.click(toggle)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/supervisor/settings',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ autonomy: 'act' }) }),
    )
    expect((screen.getByTestId('supervisor-autonomy') as HTMLInputElement).disabled).toBe(true)

    await act(async (): Promise<void> => {
      resolvePatch?.()
    })

    await waitFor(() => expect((screen.getByTestId('supervisor-autonomy') as HTMLInputElement).checked).toBe(true))
    expect((screen.getByTestId('supervisor-autonomy') as HTMLInputElement).disabled).toBe(false)
  })

  // Final review, Minor 6: the refusal was swallowed. The checkbox sprang back to where it had
  // been -- the state never moves until `loadSettings` confirms it -- and the one switch that
  // decides whether this project runs itself disagreed with the person holding it, silently.
  it('says so when the autonomy PATCH is refused, and leaves the switch where it was', async (): Promise<void> => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
      if (url.endsWith('/supervisor/settings')) {
        return new Response(JSON.stringify({ error: 'this project is archived' }), { status: 409 })
      }
      if (url.endsWith('/supervisor')) {
        return new Response(JSON.stringify({ settings: { enabled: true, profile: null, autonomy: 'propose' } }), {
          status: 200,
        })
      }
      return new Response('{}', { status: 200 })
    })

    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    const toggle = await screen.findByTestId('supervisor-autonomy')
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false))

    await act(async (): Promise<void> => {
      fireEvent.click(toggle)
    })

    const band = await screen.findByTestId('supervisor-request-error')
    expect(band.textContent).toBe('this project is archived')
    expect((screen.getByTestId('supervisor-autonomy') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId('supervisor-autonomy') as HTMLInputElement).disabled).toBe(false)
  })

  it('labels the autonomy switch "act on its own"', async (): Promise<void> => {
    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    const toggle = await screen.findByTestId('supervisor-autonomy')
    expect(screen.getByLabelText('act on its own')).toBe(toggle)
  })
})
