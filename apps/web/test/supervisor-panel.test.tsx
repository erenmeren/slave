// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SUPERVISOR_PANEL_MIN_REFRESH_MS, SupervisorPanel, actionText } from '../src/components/SupervisorPanel.js'
import type { SupervisorView } from '../src/server/supervisor.js'

const GET_URL = '/api/w/w1/supervisor'

const decision = (over: Partial<SupervisorView['pending'][number]>): SupervisorView['pending'][number] => ({
  id: 'd1',
  workspaceId: 'w1',
  situationKind: 'no_reviewer',
  subjectId: 'reviewer',
  situation: {
    kind: 'no_reviewer',
    subjectId: 'reviewer',
    summary: 'A task is in review and no worker holds the reviewer role.',
    facts: { role: 'reviewer', tasksWaiting: 1 },
  },
  candidates: [],
  chosenIndex: 0,
  action: { kind: 'set_runtime_roles', slaveId: 'a1', roles: ['backend', 'reviewer'] },
  // M39 t2: every decision row carries a draft column now -- null for every action but
  // `answer_question`, which is what a staffing proposal is.
  draft: null,
  rationale: 'Alex is idle and their title already reads as reviewer.',
  tier: 'proposed',
  status: 'pending',
  decidedBy: 'model',
  modelCostUsd: 0.02,
  modelCalled: true,
  failureReason: null,
  createdAt: '2026-09-09T10:00:00.000Z',
  expiresAt: '2026-09-10T10:00:00.000Z',
  resolvedAt: null,
  ...over,
})

/** An `answer_question` proposal with the drafted answer a human is asked to read, edit and
 *  approve (M39 §6) -- the shape `recordDecision` writes for an interpretation the citations of
 *  which did not all verify. */
const answerDecision = (over?: Partial<SupervisorView['pending'][number]>): SupervisorView['pending'][number] =>
  decision({
    id: 'd-answer',
    situationKind: 'waiting_stale',
    subjectId: 'm-1',
    situation: {
      kind: 'waiting_stale',
      subjectId: 'm-1',
      summary: 'A slave has been waiting on an answer for two hours.',
      facts: { messageId: 'm-1' },
    },
    action: { kind: 'answer_question', messageId: 'm-1' },
    draft: {
      body: 'Land them on the payments-retry queue.',
      sources: [{ kind: 'task', ref: null, quote: 'retries go to payments-retry' }],
      rejectedSources: [{ source: { kind: 'goal', ref: null, quote: 'ship by friday' }, reason: 'quote_not_found' }],
      critical: { lexicon: ['spend'], model: true },
      confidence: 'interpretation',
    },
    rationale: 'the task description looks like it answers this.',
    ...over,
  })

const question = (over?: Partial<SupervisorView['questions'][number]>): SupervisorView['questions'][number] => ({
  messageId: 'm-1',
  body: 'Which queue should retries land on?',
  askerName: 'Alex (backend)',
  waitingOn: 'anyone with the product role',
  holders: 0,
  since: '2026-09-09T08:00:00.000Z',
  ...over,
})

const view = (over?: Partial<SupervisorView>): SupervisorView => ({
  report: {
    done: { integrated: 2, awaitingIntegration: 1 },
    stuck: [
      {
        kind: 'no_reviewer',
        subjectId: 'reviewer',
        summary: 'A task is in review and no worker holds the reviewer role.',
        facts: { role: 'reviewer' },
      },
    ],
    next: { ready: 3, running: 1, waiting: 0, blocked: 2, stale: 0 },
    supervisor: { applied: 4, pending: 1, escalated: 0, failed: 0, lastDecisionAt: 1_757_412_000_000 },
    // M39 Task 4 renders this block; Task 1 only added it to the report the view carries.
    mailbox: { pendingQuestions: 0, draftsAwaiting: 0, answeredBySupervisor24h: 0 },
  },
  pending: [decision({})],
  // Fix round 1, Minor 3: the tier and the status are DIFFERENT literals here, so an assertion
  // that the row carries both cannot be satisfied by one of them printed twice.
  recent: [decision({}), decision({ id: 'd0', tier: 'proposed', status: 'approved', decidedBy: 'rules', rationale: 'The review cap was the only thing holding it.' })],
  settings: { enabled: true, profile: 'Prefer unblocking over failing.' },
  // M39 t4: the mailbox block -- every question still waiting on somebody, whether or not the
  // Supervisor has drafted anything for it.
  questions: [question()],
  // M40 t4: the board's titles by id, so a `cancel_task` proposal names the task a human is being
  // asked to give up rather than its uuid.
  taskTitles: { 't-1': 'Wire up the refunds form' },
  ...over,
})

describe('actionText', () => {
  it('names the task a cancel_task proposal is about, with the reason it was proposed for', () => {
    expect(
      actionText({ kind: 'cancel_task', taskId: 't-1', reason: 'the re-plan for goal v2 no longer needs it' }, { 't-1': 'Wire up the refunds form' }),
    ).toBe('cancel task Wire up the refunds form: the re-plan for goal v2 no longer needs it')
  })

  // M47 R4: the three arms of the exhaustive switch. Each names the capability the offer is FOR,
  // because the situation chip beside it only says that one is missing.
  it('names the role an assign_capability grants and the capability it is for', () => {
    expect(
      actionText({ kind: 'assign_capability', slaveId: 'Rae', capability: 'security.application', role: 'security' }),
    ).toBe('give Rae the "security" runtime role, for security.application')
  })

  it('names the worker a materialise_company_worker brings over', () => {
    expect(
      actionText({ kind: 'materialise_company_worker', companySlaveId: 'cs1', capability: 'security.application', name: 'Sam' }),
    ).toBe('bring Sam onto this project from the company roster, for security.application')
  })

  it('says when a catalog hire is a temporary specialist, and says nothing when it is not', () => {
    const hire = {
      kind: 'hire_from_catalog',
      templateId: 'tpl1',
      capability: 'security.application',
      name: 'Security Reviewer',
      rationale: 'nobody here provides Application security',
    } as const
    expect(actionText({ ...hire, temporary: false })).toBe(
      'hire Security Reviewer from the catalog, for security.application',
    )
    expect(actionText({ ...hire, temporary: true })).toBe(
      'hire Security Reviewer from the catalog as a temporary specialist, for security.application',
    )
  })

  it('falls back to the id for a task the world no longer holds', () => {
    // Findable, rather than a name this function would have to invent.
    expect(actionText({ kind: 'cancel_task', taskId: 't-9', reason: 'no longer needed' }, {})).toBe(
      'cancel task t-9: no longer needed',
    )
  })
})

describe('SupervisorPanel', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  const respondWith = (body: SupervisorView): void => {
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
      init?.method === undefined || init.method === 'GET'
        ? new Response(JSON.stringify(body), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
  }

  /** Mounts the panel and lets its first fetch settle, so every case starts from a painted panel. */
  const mount = async (over?: Partial<SupervisorView>, refreshKey: unknown = 0): Promise<void> => {
    respondWith(view(over))
    await act(async () => {
      render(<SupervisorPanel workspaceId="w1" refreshKey={refreshKey} />)
    })
  }

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** Every read this panel made, in order -- the writes are POSTs and PATCHes to other URLs. */
  const reads = (): unknown[][] => fetchMock.mock.calls.filter((call) => call[0] === GET_URL)

  it('reads the view once on mount', async () => {
    await mount()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(GET_URL)
    expect(screen.getByTestId('supervisor-panel')).toBeTruthy()
  })

  it('says what is done, what is stuck and what comes next', async () => {
    await mount()

    expect(screen.getByTestId('supervisor-done').textContent).toContain('2 integrated')
    expect(screen.getByTestId('supervisor-done').textContent).toContain('1 awaiting integration')
    expect(screen.getByTestId('supervisor-next').textContent).toContain('3 ready')
    expect(screen.getByTestId('supervisor-next').textContent).toContain('2 blocked')
    expect(screen.getAllByTestId('supervisor-stuck-row').map((row) => row.textContent)).toEqual([
      expect.stringContaining('no worker holds the reviewer role'),
    ])
  })

  it('says so when nothing is stuck', async () => {
    await mount({ report: { ...view().report, stuck: [] } })

    expect(screen.queryByTestId('supervisor-stuck-row')).toBeNull()
    expect(screen.getByTestId('supervisor-stuck-empty').textContent).toMatch(/nothing is stuck/i)
  })

  it('shows each proposal with its situation, its action and the reason it was chosen', async () => {
    await mount()

    expect(screen.getByTestId('supervisor-proposal-summary').textContent).toContain('no worker holds the reviewer role')
    expect(screen.getByTestId('supervisor-proposal-action').textContent).toContain('backend, reviewer')
    expect(screen.getByTestId('supervisor-proposal-rationale').textContent).toBe(
      'Alex is idle and their title already reads as reviewer.',
    )
  })

  it('names the task in a cancel_task proposal, so a human is not asked to approve a uuid (M40 §6)', async () => {
    await mount({
      pending: [
        decision({
          id: 'd-cancel',
          situationKind: 'stale_task',
          subjectId: 't-1',
          situation: {
            kind: 'stale_task',
            subjectId: 't-1',
            summary: 'the re-plan for goal v2 no longer needs "Wire up the refunds form"',
            facts: { goalVersion: 1, currentVersion: 2, reason: 'replan_cancel' },
          },
          action: { kind: 'cancel_task', taskId: 't-1', reason: 'the re-plan for goal v2 no longer needs it' },
          rationale: 'the re-plan for goal v2 no longer needs this task',
        }),
      ],
    })

    // M44 R5 leak 5: the kind chip printed the enum member. The word is what a person reads; the
    // raw kind stays in `title`.
    expect(screen.getByTestId('supervisor-proposal-kind').textContent).toBe('Work the goal no longer needs')
    expect(screen.getByTestId('supervisor-proposal-kind').getAttribute('title')).toBe('stale_task')
    expect(screen.getByTestId('supervisor-proposal-action').textContent).toBe(
      'cancel task Wire up the refunds form: the re-plan for goal v2 no longer needs it',
    )
  })

  it('reads a capability proposal in words: the label chip, the sentence and the raw kind (M47 R4)', async () => {
    await mount({
      pending: [
        decision({
          id: 'd-capability',
          situationKind: 'capability_unstaffed',
          subjectId: 'security.application',
          situation: {
            kind: 'capability_unstaffed',
            subjectId: 'security.application',
            summary: '1 startable task(s) need "security.application" and no slave can be dispatched as "security".',
            facts: { capability: 'security.application', role: 'security', readyTasks: 1, firstTaskId: 't-1' },
          },
          action: {
            kind: 'hire_from_catalog',
            templateId: 'tpl1',
            capability: 'security.application',
            name: 'Security Reviewer',
            rationale: 'Security Reviewer provides Application security, which nobody on this project does.',
            temporary: false,
          },
          rationale: 'Security Reviewer provides Application security, which nobody on this project does.',
        }),
      ],
    })

    // M44 R5 leak 5 / `docs/ia.md` rule 3: the word is what a person reads, the member stays in
    // `title` so the raw value is still available.
    expect(screen.getByTestId('supervisor-proposal-kind').textContent).toBe('Missing a capability')
    expect(screen.getByTestId('supervisor-proposal-kind').getAttribute('title')).toBe('capability_unstaffed')
    expect(screen.getByTestId('supervisor-proposal-action').textContent).toBe(
      'hire Security Reviewer from the catalog, for security.application',
    )
  })

  it('approving POSTs the decision approve route and re-reads the view', async () => {
    await mount()

    await act(async () => {
      fireEvent.click(screen.getByTestId('supervisor-approve'))
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/supervisor/decisions/d1/approve', expect.objectContaining({ method: 'POST' }))
    expect(reads()).toHaveLength(2)
  })

  it('rejecting POSTs the reject route with the typed reason', async () => {
    await mount()

    fireEvent.change(screen.getByTestId('supervisor-reject-reason'), { target: { value: 'Alex is on the rewrite' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('supervisor-reject'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/supervisor/decisions/d1/reject',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ reason: 'Alex is on the rewrite' }) }),
    )
  })

  it('rejecting with an empty box sends no reason at all', async () => {
    await mount()

    await act(async () => {
      fireEvent.click(screen.getByTestId('supervisor-reject'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/supervisor/decisions/d1/reject',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
    )
  })

  it('says so when nothing is waiting on a human', async () => {
    await mount({ pending: [] })

    expect(screen.queryByTestId('supervisor-approve')).toBeNull()
    expect(screen.getByTestId('supervisor-pending-empty').textContent).toMatch(/nothing is waiting/i)
  })

  it('lists recent decisions with their status, decider and rationale', async () => {
    await mount()

    const rows = screen.getAllByTestId('supervisor-decision-row')
    expect(rows).toHaveLength(2)
    // M44 R5 leak 5: the raw record used to BE the line (`no_reviewer · proposed · approved · by
    // rules`). `tier` left the visible line -- `status` already says what happened to the decision
    // -- and the whole record, tier included, is in the meta node's `title`.
    expect(rows[1]?.textContent).toContain('Approved')
    expect(rows[1]?.textContent).toContain('the rules')
    expect(rows[1]?.textContent).not.toContain('proposed')
    expect(screen.getAllByTestId('supervisor-decision-meta')[1]?.getAttribute('title')).toBe(
      'no_reviewer · proposed · approved · rules',
    )
    expect(screen.getAllByTestId('supervisor-decision-rationale')[1]?.textContent).toBe(
      'The review cap was the only thing holding it.',
    )
  })

  it('reads a recent decision as a sentence, with the raw record in the title (M44 R5)', async () => {
    await mount({
      recent: [
        decision({
          id: 'd9',
          situationKind: 'no_reviewer',
          tier: 'proposed',
          status: 'approved',
          decidedBy: 'model',
          rationale: 'the project has nobody who can review',
          failureReason: null,
        }),
      ],
    })

    const row = screen.getAllByTestId('supervisor-decision-row')[0]
    expect(row?.textContent).toContain('No reviewer')
    expect(row?.textContent).toContain('Approved')
    expect(row?.textContent).toContain('the model')
    expect(row?.textContent).not.toContain('no_reviewer')
    expect(row?.querySelector('[data-testid="supervisor-decision-meta"]')?.getAttribute('title')).toBe(
      'no_reviewer · proposed · approved · model',
    )
  })

  it('renders another party rationale as text, never as markup', async () => {
    await mount({ pending: [decision({ rationale: '<img src=x onerror="boom()">' })] })

    const rationale = screen.getByTestId('supervisor-proposal-rationale')
    expect(rationale.textContent).toBe('<img src=x onerror="boom()">')
    expect(rationale.querySelector('img')).toBeNull()
  })

  it('the toggle PATCHes the settings route with the opposite of what is stored', async () => {
    await mount()

    await act(async () => {
      fireEvent.click(screen.getByTestId('supervisor-enabled'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/supervisor/settings',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: false }) }),
    )
  })

  it('seeds the profile box from the settings and PATCHes the typed text', async () => {
    await mount()

    expect((screen.getByTestId('supervisor-profile-input') as HTMLTextAreaElement).value).toBe(
      'Prefer unblocking over failing.',
    )
    fireEvent.change(screen.getByTestId('supervisor-profile-input'), { target: { value: 'Never fail a task with dependents.' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('supervisor-profile-save'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/supervisor/settings',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ profile: 'Never fail a task with dependents.' }) }),
    )
  })

  it('emptying the profile box and saving clears it with an explicit null', async () => {
    await mount()

    fireEvent.change(screen.getByTestId('supervisor-profile-input'), { target: { value: '   ' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('supervisor-profile-save'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/supervisor/settings',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ profile: null }) }),
    )
  })

  it("renders a refusal in the panel's error band", async () => {
    await mount()
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'decision d1 is already applied' }), { status: 409 }),
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('supervisor-approve'))
    })

    expect(screen.getByRole('alert').textContent).toContain('already applied')
  })

  it('refetches immediately after its own write, without waiting out the throttle window', async () => {
    await mount()

    await act(async () => {
      fireEvent.click(screen.getByTestId('supervisor-approve'))
    })

    // Two reads a few milliseconds apart, well inside `SUPERVISOR_PANEL_MIN_REFRESH_MS`: the
    // throttle governs the stream's wake-ups, never the result of a click.
    expect(reads()).toHaveLength(2)
  })

  // Fix round 1, Important 2 + the controller's ruling. `refreshKey` is the SSE refetch, which
  // fires several times a second while a run is live; each read here is a `RepeatableRead` world
  // load plus two decision queries.
  it('reads at most once per window however often the stream wakes it, and carries the last wake-up across', async () => {
    vi.useFakeTimers()
    respondWith(view())
    const { rerender } = render(<SupervisorPanel workspaceId="w1" refreshKey={0} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(reads()).toHaveLength(1)

    for (const key of [1, 2, 3, 4]) {
      await act(async () => {
        rerender(<SupervisorPanel workspaceId="w1" refreshKey={key} />)
        await vi.advanceTimersByTimeAsync(100)
      })
    }
    expect(reads()).toHaveLength(1)

    // The trailing read: the last wake-up inside the window still lands, once the window is over.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUPERVISOR_PANEL_MIN_REFRESH_MS)
    })
    expect(reads()).toHaveLength(2)
  })

  // Fix round 1, Important 1: the same monotonic guard `useWorkspaceStream`'s refetch carries.
  it('ignores a slow read that lands after a newer one', async () => {
    vi.useFakeTimers()
    let releaseFirst: (() => void) | null = null
    const answer = (rationale: string): Response =>
      new Response(JSON.stringify(view({ pending: [decision({ rationale })] })), { status: 200 })
    fetchMock
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        return answer('the read that started FIRST')
      })
      .mockImplementationOnce(async () => answer('the read that started SECOND'))

    const { rerender } = render(<SupervisorPanel workspaceId="w1" refreshKey={0} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    // Past the throttle window, so the next wake-up issues its read straight away -- while the
    // first one is still hanging.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUPERVISOR_PANEL_MIN_REFRESH_MS)
    })
    await act(async () => {
      rerender(<SupervisorPanel workspaceId="w1" refreshKey={1} />)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('supervisor-proposal-rationale').textContent).toBe('the read that started SECOND')

    await act(async () => {
      releaseFirst?.()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(screen.getByTestId('supervisor-proposal-rationale').textContent).toBe('the read that started SECOND')
  })

  // Fix round 1, Minor 2: a read that fails is named, and an expired session lands on the door
  // rather than on a band that never clears (M20 §3.4) -- this read dials `fetch` itself, so it
  // owes the same `onUnauthorized` call every other control surface makes.
  it('sends the operator to /login when the read comes back 401', async () => {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { configurable: true, value: { assign, pathname: '/w/w1', search: '' } })
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'session revoked' }), { status: 401 }))

    await act(async () => {
      render(<SupervisorPanel workspaceId="w1" refreshKey={0} />)
    })

    expect(assign).toHaveBeenCalledWith('/login?next=%2Fw%2Fw1')
  })

  it('names a failed read in the error band instead of going quiet, keeping the last good view', async () => {
    await mount()
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'the database is down' }), { status: 500 }))

    await act(async () => {
      fireEvent.click(screen.getByTestId('supervisor-approve'))
    })

    expect(screen.getByRole('alert').textContent).toContain('the database is down')
    // The proposal is still on screen: a failed read replaces nothing.
    expect(screen.getByTestId('supervisor-proposal-summary')).toBeTruthy()
  })

  // ---- M39 t4: the drafted answer, its evidence, and the edit box ------------------------------

  describe('a drafted answer', () => {
    const withDraft = (decisionOver?: Partial<SupervisorView['pending'][number]>): Partial<SupervisorView> => ({
      pending: [answerDecision(decisionOver)],
    })

    it('shows the question it would answer, the draft in an editable box, and how confident it is', async () => {
      await mount(withDraft())

      expect(screen.getByTestId('supervisor-draft-question').textContent).toBe('Which queue should retries land on?')
      expect((screen.getByTestId('supervisor-draft-body') as HTMLTextAreaElement).value).toBe(
        'Land them on the payments-retry queue.',
      )
      expect(screen.getByTestId('supervisor-draft-confidence').textContent).toContain('interpretation')
    })

    it('quotes every verified source with where it came from, and marks a rejected one with its reason', async () => {
      await mount(withDraft())

      const verified = screen.getAllByTestId('supervisor-draft-source')
      expect(verified).toHaveLength(1)
      expect(verified[0]?.textContent).toContain('retries go to payments-retry')
      expect(verified[0]?.textContent).toContain('task')
      const rejected = screen.getAllByTestId('supervisor-draft-rejected')
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.textContent).toContain('ship by friday')
      expect(rejected[0]?.textContent).toContain('quote_not_found')
    })

    it('names both critical signals -- the lexicon match and the model flag', async () => {
      await mount(withDraft())

      const critical = screen.getByTestId('supervisor-draft-critical').textContent ?? ''
      expect(critical).toContain('spend')
      expect(critical).toMatch(/model/i)
    })

    it('says nothing about critical when neither signal fired', async () => {
      await mount(
        withDraft({
          draft: { ...answerDecision().draft!, critical: { lexicon: [], model: false } },
        }),
      )

      expect(screen.queryByTestId('supervisor-draft-critical')).toBeNull()
    })

    it("seeds the box from a human's earlier edit when the row carries one, and shows it as the edit", async () => {
      await mount(
        withDraft({ draft: { ...answerDecision().draft!, editedBody: 'Use the retry topic, not the queue.' } }),
      )

      expect((screen.getByTestId('supervisor-draft-body') as HTMLTextAreaElement).value).toBe(
        'Use the retry topic, not the queue.',
      )
      expect(screen.getByTestId('supervisor-draft-edited').textContent).toContain('Use the retry topic, not the queue.')
    })

    it('offers an empty box on an escalated draft that has no body at all, so a human can answer it', async () => {
      await mount(withDraft({ draft: { ...answerDecision().draft!, body: null } }))

      expect((screen.getByTestId('supervisor-draft-body') as HTMLTextAreaElement).value).toBe('')
    })

    it('approving an edited draft POSTs the typed body', async () => {
      await mount(withDraft())

      fireEvent.change(screen.getByTestId('supervisor-draft-body'), { target: { value: 'Use the retry topic.' } })
      await act(async () => {
        fireEvent.click(screen.getByTestId('supervisor-approve'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/w/w1/supervisor/decisions/d-answer/approve',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ body: 'Use the retry topic.' }) }),
      )
      // The write is followed by a re-read, exactly as every other action on this panel is.
      expect(reads()).toHaveLength(2)
    })

    it('approving an untouched draft posts no body at all -- the Supervisor\'s own words go out', async () => {
      await mount(withDraft())

      await act(async () => {
        fireEvent.click(screen.getByTestId('supervisor-approve'))
      })

      const call = fetchMock.mock.calls.find((one) => one[0] === '/api/w/w1/supervisor/decisions/d-answer/approve')
      // FIRST that the approve fired at all (final review Minor 8): `call?.[1]?.body` is undefined
      // for a POST with no body AND for a button that did nothing, so without this line a panel
      // whose Approve had stopped working would pass this test.
      expect(call).toBeDefined()
      expect((call?.[1] as { method?: unknown } | undefined)?.method).toBe('POST')
      expect((call?.[1] as { body?: unknown } | undefined)?.body).toBeUndefined()
    })

    it('renders a draft, a quote and a question as text, never as markup', async () => {
      await mount(
        withDraft({
          draft: {
            ...answerDecision().draft!,
            body: '<img src=x onerror="boom()">',
            sources: [{ kind: 'task', ref: null, quote: '<script>boom()</script>' }],
          },
        }),
      )

      const box = screen.getByTestId('supervisor-draft-body') as HTMLTextAreaElement
      expect(box.value).toBe('<img src=x onerror="boom()">')
      expect(box.querySelector('img')).toBeNull()
      const source = screen.getByTestId('supervisor-draft-source')
      expect(source.textContent).toContain('<script>boom()</script>')
      expect(source.querySelector('script')).toBeNull()
    })

    it('shows no draft block on a proposal that is not an answer', async () => {
      await mount()

      expect(screen.queryByTestId('supervisor-draft-body')).toBeNull()
    })
  })

  describe('the questions waiting', () => {
    it('lists every question with who asked it, who it waits on, how many could answer and since when', async () => {
      await mount({ questions: [question({ holders: 2 })] })

      const rows = screen.getAllByTestId('supervisor-question-row')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.textContent).toContain('Which queue should retries land on?')
      expect(rows[0]?.textContent).toContain('Alex (backend)')
      expect(rows[0]?.textContent).toContain('anyone with the product role')
      expect(rows[0]?.textContent).toContain('2')
    })

    it('says so when nobody is waiting on an answer', async () => {
      await mount({ questions: [] })

      expect(screen.queryByTestId('supervisor-question-row')).toBeNull()
      expect(screen.getByTestId('supervisor-questions-empty').textContent).toMatch(/no question/i)
    })

    it("says when a question nobody holds the role for cannot be answered by anybody", async () => {
      await mount({ questions: [question({ holders: 0 })] })

      expect(screen.getByTestId('supervisor-question-row').textContent).toMatch(/nobody/i)
    })

    it('renders a question body as text, never as markup', async () => {
      await mount({ questions: [question({ body: '<img src=x onerror="boom()">' })] })

      const row = screen.getByTestId('supervisor-question-row')
      expect(row.textContent).toContain('<img src=x onerror="boom()">')
      expect(row.querySelector('img')).toBeNull()
    })
  })
})
