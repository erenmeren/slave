// @vitest-environment jsdom
import { fireEvent, render, screen, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SupervisorThreadPanel, type PendingDecision } from '../src/components/supervisor/SupervisorThreadPanel.js'
import { clearModelSelectCache } from '../src/components/ModelSelect.js'
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

/** The view `GET /api/w/:id/supervisor` answers, as this panel reads it (F R4/R8): the settings
 *  its three controls are bound to and the conversation's two cost figures. */
function view(
  over: {
    readonly autonomy?: 'propose' | 'act'
    readonly provider?: string | null
    readonly model?: string | null
    readonly costUsd?: number
    readonly unmeasured?: number
  } = {},
): string {
  return JSON.stringify({
    settings: {
      enabled: true,
      profile: null,
      autonomy: over.autonomy ?? 'propose',
      provider: over.provider ?? null,
      model: over.model ?? null,
    },
    conversationCostUsd: over.costUsd ?? 0,
    conversationUnmeasuredTurns: over.unmeasured ?? 0,
  })
}

/** One conversation of CHAT rows (F R1) -- the shape `supervisorThreads.ts` builds from
 *  `SupervisorMessage`, with every field an event row does not carry. */
function chatThread(...messages: SupervisorThread['messages']): readonly SupervisorThread[] {
  return [{ id: '2026-09-20', title: 'why is nothing running?', when: 'today', messages }]
}

const ASKED: SupervisorThread['messages'][number] = {
  id: 'msg:m1',
  messageId: 'm1',
  who: 'operator',
  text: 'why is nothing running?',
  at: '2026-09-20T09:00:00.000Z',
  refs: [],
  decisionId: null,
  status: 'sent',
}

/** jsdom's `files` is a getter on the prototype, so the property is DEFINED on the element rather
 *  than assigned through `fireEvent`'s target spread -- the same reason a `value` needs React's
 *  own setter. The handler reads `event.target.files` and only ever iterates it. */
function choose(input: HTMLElement, files: readonly File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  fireEvent.change(input)
}

/** What `/api/providers/<kind>/models` answers here. BOTH models, because the two that matter --
 *  what a project is set to and what somebody switches it to -- have to be in the list for a
 *  `<select>` to offer either. */
const MODELS = JSON.stringify({
  models: [
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-opus-5', label: 'Opus 5' },
  ],
  source: 'account',
})

type FetchInit = { readonly method?: string; readonly body?: string }

/**
 * One case's answers, with the model listing answered for it.
 *
 * The header's model field asks for the EFFECTIVE runtime's models on every mount (fix round 1,
 * I1), and `ModelSelect` reads `models.length` off whatever comes back -- so a case that replaced
 * the stub and forgot this route would crash the panel it was measuring, for a reason that has
 * nothing to do with what it was measuring. Answered once, here.
 */
function stubFetch(own: (url: string, init?: FetchInit) => Promise<Response>): void {
  fetchMock.mockImplementation(async (url: string, init?: FetchInit) =>
    url.includes('/api/providers/') ? new Response(MODELS, { status: 200 }) : own(url, init),
  )
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach((): void => {
  // The model listing is cached per provider kind for the whole module, so a listing one case
  // stubbed would otherwise be the listing every case after it reads.
  clearModelSelectCache()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  // The default, through the same helper every case uses, so there is one path for all of them.
  stubFetch(async (url: string) => {
    if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
    // The view's own GET (`/api/w/:id/supervisor`, no further path) -- what the scope line's
    // autonomy switch reads on mount. Matched by suffix rather than `includes('/supervisor')`,
    // which would also catch `/supervisor/threads` and the settings/decisions routes below.
    if (url.endsWith('/supervisor')) return new Response(view(), { status: 200 })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
})

afterEach((): void => {
  // The two poll cases fake the clock; every other case must not inherit it.
  vi.useRealTimers()
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
    stubFetch(async (url: string) =>
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

  // F R2/R8: the composer's verb. It posted `{ request }` to `/goal/request` until this milestone,
  // which re-planned the whole board for a question that wanted an answer -- asking for the goal
  // to change is a `request_goal_change` action the REPLY may propose now (R3).
  it('sends the composer to the messages route, on Enter', async (): Promise<void> => {
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
        '/api/w/w1/supervisor/messages',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'add 3-D Secure' }) }),
      ),
    )
    // Nothing is posted to the goal route any more, by the composer or by anything else here.
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/goal/request'))).toHaveLength(0)
    await waitFor(() => expect((screen.getByTestId('supervisor-request-input') as HTMLTextAreaElement).value).toBe(''))
  })

  it('renders the route s refusal in its own line', async (): Promise<void> => {
    stubFetch(async (url: string) =>
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
  })

  // M57 t6: three cases that lived on `project/SupervisorRequest`'s own describe until that
  // component was deleted. The composer is the one box the panel sends from, and these are
  // behaviours it still has -- so they moved here rather than dying with the widget.
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

  it('will not send the same message twice while the first is still in flight', async (): Promise<void> => {
    // The route's own guards are the backstop, not the UX: the button goes down the moment a POST
    // leaves, so a double click is one message and one model call.
    let release: (() => void) | null = null
    stubFetch(async (url: string) => {
      if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
      if (url.endsWith('/supervisor')) return new Response(view(), { status: 200 })
      return new Promise<Response>((resolve) => {
        release = () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      })
    })
    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    await waitFor(() => expect(screen.getByTestId('supervisor-composer')).toBeTruthy())
    fireEvent.change(screen.getByTestId('supervisor-request-input'), { target: { value: 'add 3-D Secure' } })
    fireEvent.click(screen.getByTestId('supervisor-request-send'))

    expect((screen.getByTestId('supervisor-request-send') as HTMLButtonElement).disabled).toBe(true)
    // Fix round 1, M4: the whole box goes down with it. `send` read the words and the tray once,
    // so anything typed or attached while it is out would be cleared unsent when it lands.
    expect((screen.getByTestId('supervisor-request-input') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByTestId('supervisor-attach-button') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('supervisor-request-send'))
    await act(async (): Promise<void> => {
      release?.()
    })
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/supervisor/messages'))).toHaveLength(1)
  })

  it('shows a refusal without clearing what was typed', async (): Promise<void> => {
    stubFetch(async (url: string) =>
      url.includes('/supervisor/threads')
        ? new Response(JSON.stringify(THREADS), { status: 200 })
        : new Response(JSON.stringify({ error: 'a message must not be blank' }), { status: 409 }),
    )
    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    await waitFor(() => expect(screen.getByTestId('supervisor-composer')).toBeTruthy())
    fireEvent.change(screen.getByTestId('supervisor-request-input'), { target: { value: 'add 3-D Secure' } })
    fireEvent.click(screen.getByTestId('supervisor-request-send'))

    await waitFor(() => expect(screen.getByTestId('supervisor-request-error').textContent).toContain('must not be blank'))
    // A refusal that emptied the box would delete the words a person has to read to understand it.
    expect((screen.getByTestId('supervisor-request-input') as HTMLTextAreaElement).value).toBe('add 3-D Secure')
  })

  it('says so, once, when there is no conversation yet', async (): Promise<void> => {
    stubFetch(async (url: string) =>
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
    stubFetch(async (url: string, init?: { method?: string; body?: string }) => {
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
      if (url.endsWith('/supervisor')) return new Response(view({ autonomy: currentAutonomy }), { status: 200 })
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
    stubFetch(async (url: string) => {
      if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
      if (url.endsWith('/supervisor/settings')) {
        return new Response(JSON.stringify({ error: 'this project is archived' }), { status: 409 })
      }
      if (url.endsWith('/supervisor')) return new Response(view(), { status: 200 })
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

  // ==============================================================================================
  // F R8: the conversation's own rows -- thinking, failed, sourced, attachments.
  // ==============================================================================================

  it('draws a reply nobody has answered yet as thinking, not as an empty bubble', async (): Promise<void> => {
    const waiting = chatThread(ASKED, {
      id: 'msg:m2',
      messageId: 'm2',
      who: 'supervisor',
      text: '',
      at: '2026-09-20T09:00:01.000Z',
      refs: [],
      decisionId: null,
      status: 'answering',
    })
    stubFetch(async (url: string) =>
      url.includes('/supervisor/threads')
        ? new Response(JSON.stringify(waiting), { status: 200 })
        : new Response(url.endsWith('/supervisor') ? view() : '{}', { status: 200 }),
    )
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    const thinking = await screen.findByTestId('supervisor-thinking')
    expect(thinking.textContent).toContain('thinking')
    // Inside the reply's own bubble, so it reads where the answer will appear.
    expect(screen.getAllByTestId('supervisor-message')[1]?.contains(thinking)).toBe(true)
  })

  it('says why a turn failed, in a sentence, for each reason the tick records', async (): Promise<void> => {
    const failures = chatThread(
      { id: 'msg:a', messageId: 'a', who: 'supervisor', text: '', at: '2026-09-20T09:00:01.000Z', refs: [], decisionId: null, status: 'failed', failureReason: 'no_decider_for_provider' },
      { id: 'msg:b', messageId: 'b', who: 'supervisor', text: '', at: '2026-09-20T09:00:02.000Z', refs: [], decisionId: null, status: 'failed', failureReason: 'budget_exhausted' },
      { id: 'msg:c', messageId: 'c', who: 'supervisor', text: '', at: '2026-09-20T09:00:03.000Z', refs: [], decisionId: null, status: 'failed', failureReason: 'turn_unreadable' },
      // Anything else is the PROVIDER's own words, which are not this panel's to rewrite.
      { id: 'msg:d', messageId: 'd', who: 'supervisor', text: '', at: '2026-09-20T09:00:04.000Z', refs: [], decisionId: null, status: 'failed', failureReason: 'the runtime exited with code 1' },
    )
    stubFetch(async (url: string) =>
      url.includes('/supervisor/threads')
        ? new Response(JSON.stringify(failures), { status: 200 })
        : new Response(url.endsWith('/supervisor') ? view() : '{}', { status: 200 }),
    )
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    await waitFor(() => expect(screen.getAllByTestId('supervisor-failed')).toHaveLength(4))
    const said = screen.getAllByTestId('supervisor-failed').map((row) => row.textContent)
    expect(said[0]).toBe('No runtime can answer for this provider on this daemon.')
    expect(said[1]).toBe("The project's budget is spent; the conversation waits for more.")
    expect(said[2]).toBe('The message could not be read back; send it again.')
    expect(said[3]).toBe('the runtime exited with code 1')
    expect(screen.queryByTestId('supervisor-thinking')).toBeNull()
  })

  it('marks a reply every citation checked out for with the sourced chip', async (): Promise<void> => {
    const answered = chatThread(
      { id: 'msg:a', messageId: 'a', who: 'supervisor', text: 'Nothing is running: the planner has no seat.', at: '2026-09-20T09:00:01.000Z', refs: [], decisionId: null, status: 'answered', sourced: true },
      { id: 'msg:b', messageId: 'b', who: 'supervisor', text: 'I think so.', at: '2026-09-20T09:00:02.000Z', refs: [], decisionId: null, status: 'answered', sourced: false },
    )
    stubFetch(async (url: string) =>
      url.includes('/supervisor/threads')
        ? new Response(JSON.stringify(answered), { status: 200 })
        : new Response(url.endsWith('/supervisor') ? view() : '{}', { status: 200 }),
    )
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    await waitFor(() => expect(screen.getAllByTestId('supervisor-message')).toHaveLength(2))
    const chips = screen.getAllByTestId('supervisor-sourced')
    expect(chips).toHaveLength(1)
    expect(chips[0]?.textContent).toBe('sourced')
    expect(screen.getAllByTestId('supervisor-message')[0]?.contains(chips[0]!)).toBe(true)
  })

  it('shows what a sent message carried, by name and size', async (): Promise<void> => {
    const withFile = chatThread({
      ...ASKED,
      attachments: [{ path: 'docs/inbox/2026-09-20-brief.md', name: 'brief.md', bytes: 1400, kind: 'text' }],
    })
    stubFetch(async (url: string) =>
      url.includes('/supervisor/threads')
        ? new Response(JSON.stringify(withFile), { status: 200 })
        : new Response(url.endsWith('/supervisor') ? view() : '{}', { status: 200 }),
    )
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    const chip = await screen.findByTestId('supervisor-attachment')
    expect(chip.textContent).toContain('brief.md')
    expect(chip.textContent).toContain('1.4 kB')
    // The PATH is the whole identity of an attachment (R6), one hover away.
    expect(chip.getAttribute('title')).toBe('docs/inbox/2026-09-20-brief.md')
  })

  // ==============================================================================================
  // F R3: a card per action a reply asked for.
  // ==============================================================================================

  it('draws one card per action under the reply that asked for it, and never the same one twice', async (): Promise<void> => {
    const proposed = chatThread(ASKED, {
      id: 'msg:m2',
      messageId: 'm2',
      who: 'supervisor',
      text: 'The planner has no seat. I can ask for the goal to change and leave a note.',
      at: '2026-09-20T09:00:01.000Z',
      refs: [],
      // `supervisorThreads.ts` puts the FIRST action's decision here too -- a card drawn from both
      // fields would be a card drawn twice.
      decisionId: 'd-1',
      status: 'answered',
      actions: [
        { decisionId: 'd-1', tier: 'proposed', kind: 'request_goal_change' },
        { decisionId: 'd-7', tier: 'applied', kind: 'note_for_planner' },
      ],
    })
    stubFetch(async (url: string) =>
      url.includes('/supervisor/threads')
        ? new Response(JSON.stringify(proposed), { status: 200 })
        : new Response(url.endsWith('/supervisor') ? view() : '{}', { status: 200 }),
    )
    render(<SupervisorThreadPanel workspaceId="w1" pending={DECISIONS} />)
    await waitFor(() => expect(screen.getAllByTestId('supervisor-decision-card')).toHaveLength(2))
    const cards = screen.getAllByTestId('supervisor-decision-card')
    const reply = screen.getAllByTestId('supervisor-message')[1]
    expect(cards.every((card) => reply?.contains(card))).toBe(true)

    // The one the view still holds is answerable, and says what the proposal is about.
    const open = cards.find((card) => card.getAttribute('data-decision-id') === 'd-1')
    expect(open?.textContent).toContain('nobody can review')
    expect(open?.querySelector('[data-testid="supervisor-decision-approve"]')).toBeTruthy()

    // The one it does not is the kind and the tier, and nothing to press: it was carried out in
    // the same settlement, so there is no open question to approve.
    const settled = cards.find((card) => card.getAttribute('data-decision-id') === 'd-7')
    expect(settled?.textContent).toContain('note for planner')
    expect(settled?.textContent).toContain('Done')
    expect(settled?.querySelector('[data-testid="supervisor-decision-approve"]')).toBeNull()
    // The raw member stays readable (docs/ia.md rule 3) without being the visible word.
    expect(settled?.querySelector('[data-testid="supervisor-decision-asked"]')?.getAttribute('title')).toBe('note_for_planner')

    // And a proposal drawn under a reply is not drawn a second time in the tail below the thread.
    expect(screen.queryByText('Waiting on you')).toBeNull()
  })

  // ==============================================================================================
  // F R6/R8: the attach flow.
  // ==============================================================================================

  it('uploads what was attached FIRST, then sends the message with the paths the upload answered', async (): Promise<void> => {
    const stored = { path: 'docs/inbox/2026-09-20-brief.md', name: 'brief.md', bytes: 1400, kind: 'text' }
    const seen: string[] = []
    stubFetch(async (url: string) => {
      seen.push(url)
      if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
      if (url.includes('/supervisor/uploads')) return new Response(JSON.stringify({ attachments: [stored] }), { status: 200 })
      if (url.endsWith('/supervisor')) return new Response(view(), { status: 200 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    await waitFor(() => expect(screen.getByTestId('supervisor-attach')).toBeTruthy())

    choose(screen.getByTestId('supervisor-attach-input'), [new File(['# what I want'], 'brief.md', { type: 'text/markdown' })])
    // What is waiting to go is on screen before it goes, with its name and its size.
    const pending = await screen.findByTestId('supervisor-attach-chip')
    expect(pending.textContent).toContain('brief.md')

    fireEvent.change(screen.getByTestId('supervisor-request-input'), { target: { value: 'use this brief' } })
    fireEvent.click(screen.getByTestId('supervisor-request-send'))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/w/w1/supervisor/messages',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'use this brief', attachments: [stored] }) }),
      ),
    )
    // The ORDER is the contract: a message may only name a file that is already in the repository.
    expect(seen.indexOf('/api/w/w1/supervisor/uploads')).toBeLessThan(seen.indexOf('/api/w/w1/supervisor/messages'))
    const upload = fetchMock.mock.calls.find((call) => String(call[0]).includes('/supervisor/uploads'))
    const form = (upload?.[1] as { body: FormData }).body
    expect(form).toBeInstanceOf(FormData)
    expect([...form.values()].map((value) => (value as File).name)).toEqual(['brief.md'])
    // Sent: the box and the tray are both empty again.
    await waitFor(() => expect(screen.queryByTestId('supervisor-attach-chip')).toBeNull())
    expect((screen.getByTestId('supervisor-request-input') as HTMLTextAreaElement).value).toBe('')
  })

  it('takes a file dropped on the composer, and lets it be taken back off', async (): Promise<void> => {
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    const zone = await screen.findByTestId('supervisor-attach')
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } })
    const chip = await screen.findByTestId('supervisor-attach-chip')
    expect(chip.textContent).toContain('shot.png')
    fireEvent.click(screen.getByTestId('supervisor-attach-remove'))
    await waitFor(() => expect(screen.queryByTestId('supervisor-attach-chip')).toBeNull())
  })

  it('keeps the words and the file when the upload is refused, and sends no message', async (): Promise<void> => {
    stubFetch(async (url: string) => {
      if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
      if (url.includes('/supervisor/uploads')) {
        return new Response(JSON.stringify({ error: 'nothing here can read a .exe: attach a document or an image' }), { status: 415 })
      }
      if (url.endsWith('/supervisor')) return new Response(view(), { status: 200 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    await waitFor(() => expect(screen.getByTestId('supervisor-attach')).toBeTruthy())

    choose(screen.getByTestId('supervisor-attach-input'), [new File(['MZ'], 'tool.exe', { type: 'application/octet-stream' })])
    fireEvent.change(screen.getByTestId('supervisor-request-input'), { target: { value: 'read this' } })
    fireEvent.click(screen.getByTestId('supervisor-request-send'))

    await waitFor(() =>
      expect(screen.getByTestId('supervisor-request-error').textContent).toContain('nothing here can read a .exe'),
    )
    // Nothing was said in the conversation, and nothing a person typed or chose was thrown away.
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/supervisor/messages'))).toHaveLength(0)
    expect((screen.getByTestId('supervisor-request-input') as HTMLTextAreaElement).value).toBe('read this')
    expect(screen.getByTestId('supervisor-attach-chip').textContent).toContain('tool.exe')
  })

  // ==============================================================================================
  // F R4/R8: the runtime pair and the conversation's cost.
  // ==============================================================================================

  it('binds the two selects to the project s settings and PATCHes a change at once', async (): Promise<void> => {
    stubFetch(async (url: string) => {
      if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
      if (url.endsWith('/supervisor')) return new Response(view({ provider: 'claude_code', model: 'claude-sonnet-5' }), { status: 200 })
      return new Response('{}', { status: 200 })
    })
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    const provider = await screen.findByTestId('supervisor-provider')
    await waitFor(() => expect((provider as HTMLSelectElement).value).toBe('claude_code'))
    await waitFor(() => expect((screen.getByTestId('supervisor-model') as HTMLSelectElement).value).toBe('claude-sonnet-5'))

    await act(async (): Promise<void> => {
      fireEvent.change(screen.getByTestId('supervisor-model'), { target: { value: 'claude-opus-5' } })
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/supervisor/settings',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ model: 'claude-opus-5' }) }),
    )

    // A runtime the model does not belong to takes the model with it: a model id is a name one
    // vendor knows, and keeping it across a switch would ask Cursor for a Claude model.
    await act(async (): Promise<void> => {
      fireEvent.change(screen.getByTestId('supervisor-provider'), { target: { value: 'cursor' } })
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/supervisor/settings',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ provider: 'cursor', model: null }) }),
    )
  })

  // Fix round 1, I1: `null` and `claude_code` are two spellings of ONE runtime (R4 — null is the
  // installation default, and that default is `claude_code`), so moving between them is not a
  // change of vendor and must not take the model with it.
  it('sends provider null when the runtime is cleared, and leaves the model alone', async (): Promise<void> => {
    stubFetch(async (url: string) => {
      if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
      if (url.endsWith('/supervisor')) return new Response(view({ provider: 'claude_code', model: 'claude-sonnet-5' }), { status: 200 })
      return new Response('{}', { status: 200 })
    })
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    const provider = await screen.findByTestId('supervisor-provider')
    await waitFor(() => expect((provider as HTMLSelectElement).value).toBe('claude_code'))

    await act(async (): Promise<void> => {
      fireEvent.change(provider, { target: { value: '' } })
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/supervisor/settings',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ provider: null }) }),
    )
    expect((screen.getByTestId('supervisor-model') as HTMLSelectElement).value).toBe('claude-sonnet-5')
  })

  it('shows the model of a project on the default runtime, editable', async (): Promise<void> => {
    stubFetch(async (url: string) => {
      if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
      // A project that never chose a runtime, with a model set from the CLI.
      if (url.endsWith('/supervisor')) return new Response(view({ provider: null, model: 'claude-opus-5' }), { status: 200 })
      return new Response('{}', { status: 200 })
    })
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    const field = await screen.findByTestId('supervisor-model')
    // The EFFECTIVE runtime is what the model list is asked for, so the field is a live select
    // showing what the project is set to rather than "choose a provider first".
    await waitFor(() => expect((field as HTMLSelectElement).value).toBe('claude-opus-5'))
    expect((field as HTMLSelectElement).disabled).toBe(false)
    expect((screen.getByTestId('supervisor-provider') as HTMLSelectElement).value).toBe('')

    await act(async (): Promise<void> => {
      fireEvent.change(field, { target: { value: 'claude-sonnet-5' } })
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/supervisor/settings',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ model: 'claude-sonnet-5' }) }),
    )
  })

  it('naming the default runtime out loud is not a change of vendor, so the model survives it', async (): Promise<void> => {
    stubFetch(async (url: string) => {
      if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
      if (url.endsWith('/supervisor')) return new Response(view({ provider: null, model: 'claude-opus-5' }), { status: 200 })
      return new Response('{}', { status: 200 })
    })
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    const provider = await screen.findByTestId('supervisor-provider')
    await waitFor(() => expect((screen.getByTestId('supervisor-model') as HTMLSelectElement).value).toBe('claude-opus-5'))

    await act(async (): Promise<void> => {
      fireEvent.change(provider, { target: { value: 'claude_code' } })
    })
    // No `model: null` in the patch, and the field still shows what it showed.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/supervisor/settings',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ provider: 'claude_code' }) }),
    )
    expect((screen.getByTestId('supervisor-model') as HTMLSelectElement).value).toBe('claude-opus-5')

    // A real change of vendor still does take it.
    await act(async (): Promise<void> => {
      fireEvent.change(screen.getByTestId('supervisor-provider'), { target: { value: 'cursor' } })
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/supervisor/settings',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ provider: 'cursor', model: null }) }),
    )
  })

  it('says so and puts the runtime back when the settings PATCH is refused', async (): Promise<void> => {
    stubFetch(async (url: string) => {
      if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
      if (url.endsWith('/supervisor/settings')) {
        return new Response(JSON.stringify({ error: 'this installation has no such provider: cursor' }), { status: 400 })
      }
      if (url.endsWith('/supervisor')) return new Response(view({ provider: 'claude_code', model: 'claude-sonnet-5' }), { status: 200 })
      return new Response('{}', { status: 200 })
    })
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    const provider = await screen.findByTestId('supervisor-provider')
    await waitFor(() => expect((provider as HTMLSelectElement).value).toBe('claude_code'))

    await act(async (): Promise<void> => {
      fireEvent.change(provider, { target: { value: 'cursor' } })
    })
    expect((await screen.findByTestId('supervisor-request-error')).textContent).toContain('no such provider')
    // The select shows what the project IS set to, not what was refused.
    await waitFor(() => expect((screen.getByTestId('supervisor-provider') as HTMLSelectElement).value).toBe('claude_code'))
    expect((screen.getByTestId('supervisor-model') as HTMLSelectElement).value).toBe('claude-sonnet-5')
  })

  it('shows what the conversation has cost, and says how many turns nobody could price', async (): Promise<void> => {
    stubFetch(async (url: string) =>
      url.includes('/supervisor/threads')
        ? new Response(JSON.stringify(THREADS), { status: 200 })
        : new Response(url.endsWith('/supervisor') ? view({ costUsd: 0.42, unmeasured: 2 }) : '{}', { status: 200 }),
    )
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    const line = await screen.findByTestId('supervisor-cost')
    expect(line.textContent).toBe('$0.42 so far, 2 turns unpriced')
  })

  it('uploads each file ONCE, even when the message after the upload is refused', async (): Promise<void> => {
    // The upload WRITES AND COMMITS. A retry that sent the file again would leave two copies in
    // `docs/inbox/` under two dated paths, and two commits nobody asked for.
    const stored = { path: 'docs/inbox/2026-09-20-brief.md', name: 'brief.md', bytes: 1400, kind: 'text' }
    let refuse = true
    stubFetch(async (url: string) => {
      if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
      if (url.includes('/supervisor/uploads')) return new Response(JSON.stringify({ attachments: [stored] }), { status: 200 })
      if (url.includes('/supervisor/messages')) {
        return refuse
          ? new Response(JSON.stringify({ error: 'this project is halted: the budget is exhausted' }), { status: 409 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url.endsWith('/supervisor')) return new Response(view(), { status: 200 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    await waitFor(() => expect(screen.getByTestId('supervisor-attach')).toBeTruthy())

    choose(screen.getByTestId('supervisor-attach-input'), [new File(['# what I want'], 'brief.md', { type: 'text/markdown' })])
    fireEvent.change(screen.getByTestId('supervisor-request-input'), { target: { value: 'use this brief' } })
    fireEvent.click(screen.getByTestId('supervisor-request-send'))

    await waitFor(() => expect(screen.getByTestId('supervisor-request-error').textContent).toContain('budget is exhausted'))
    const uploads = (): number => fetchMock.mock.calls.filter((call) => String(call[0]).includes('/supervisor/uploads')).length
    expect(uploads()).toBe(1)
    // The file is still on the tray, under the name the repository knows it by.
    expect(screen.getByTestId('supervisor-attach-chip').textContent).toContain('brief.md')

    refuse = false
    fireEvent.click(screen.getByTestId('supervisor-request-send'))
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/supervisor/messages'))).toHaveLength(2),
    )
    expect(uploads()).toBe(1)
    const last = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/supervisor/messages')).at(-1)
    expect((last?.[1] as { body: string }).body).toBe(JSON.stringify({ text: 'use this brief', attachments: [stored] }))
    await waitFor(() => expect(screen.queryByTestId('supervisor-attach-chip')).toBeNull())
  })

  it('leaves the unpriced half off when every turn was measured', async (): Promise<void> => {
    stubFetch(async (url: string) =>
      url.includes('/supervisor/threads')
        ? new Response(JSON.stringify(THREADS), { status: 200 })
        : new Response(url.endsWith('/supervisor') ? view({ costUsd: 1.5 }) : '{}', { status: 200 }),
    )
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    const line = await screen.findByTestId('supervisor-cost')
    expect(line.textContent).toBe('$1.50 so far')
  })

  // ==============================================================================================
  // F R2/R8: the one clock, and what it is for.
  // ==============================================================================================

  /** The conversation before and after the reply lands. Only `status` and `text` differ -- what is
   *  measured here is WHO re-reads which endpoint, and when. */
  const WAITING = chatThread(ASKED, {
    id: 'msg:m2',
    messageId: 'm2',
    who: 'supervisor',
    text: '',
    at: '2026-09-20T09:00:01.000Z',
    refs: [],
    decisionId: null,
    status: 'answering',
  })
  const LANDED = chatThread(ASKED, {
    id: 'msg:m2',
    messageId: 'm2',
    who: 'supervisor',
    text: 'Nothing is running: the planner has no seat.',
    at: '2026-09-20T09:00:01.000Z',
    refs: [],
    decisionId: null,
    status: 'answered',
  })

  /** Everything the mount fetched, settled, with the clock faked. `advanceTimersByTimeAsync`
   *  flushes the microtask queue between timers, which is what lets a `fetch` stub resolve. */
  async function settle(ms = 0): Promise<void> {
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  const threadReads = (): number =>
    fetchMock.mock.calls.filter((call) => String(call[0]).includes('/supervisor/threads')).length

  it('re-reads the thread every two seconds while a reply is being written, and stops when it lands', async (): Promise<void> => {
    vi.useFakeTimers()
    let landed = false
    stubFetch(async (url: string) => {
      if (url.includes('/supervisor/threads')) {
        return new Response(JSON.stringify(landed ? LANDED : WAITING), { status: 200 })
      }
      if (url.endsWith('/supervisor')) return new Response(view(), { status: 200 })
      return new Response('{}', { status: 200 })
    })
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    await settle()
    expect(screen.getByTestId('supervisor-thinking')).toBeTruthy()

    const before = threadReads()
    await settle(2_000)
    expect(threadReads()).toBe(before + 1)

    landed = true
    await settle(2_000)
    expect(screen.queryByTestId('supervisor-thinking')).toBeNull()
    // The interval is cleared with the waiting: nothing is read again, however long nobody
    // touches the panel.
    const after = threadReads()
    await settle(10_000)
    expect(threadReads()).toBe(after)
  })

  // Fix round 1, I2: the cost of a turn is written WITH the reply, and the poll above re-reads the
  // THREAD alone -- so a conversation answering all afternoon would sit under "$0.00 so far".
  it('re-reads the view when the reply lands, so the cost line is not one turn behind', async (): Promise<void> => {
    vi.useFakeTimers()
    let landed = false
    stubFetch(async (url: string) => {
      if (url.includes('/supervisor/threads')) {
        return new Response(JSON.stringify(landed ? LANDED : WAITING), { status: 200 })
      }
      if (url.endsWith('/supervisor')) return new Response(view({ costUsd: landed ? 0.42 : 0 }), { status: 200 })
      return new Response('{}', { status: 200 })
    })
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    await settle()
    expect(screen.getByTestId('supervisor-cost').textContent).toBe('$0.00 so far')

    landed = true
    await settle(2_000)
    await settle()
    expect(screen.getByTestId('supervisor-cost').textContent).toBe('$0.42 so far')
  })
})
