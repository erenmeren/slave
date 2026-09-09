// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SUPERVISOR_PANEL_MIN_REFRESH_MS, SupervisorPanel } from '../src/components/SupervisorPanel.js'
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
    next: { ready: 3, running: 1, waiting: 0, blocked: 2 },
    supervisor: { applied: 4, pending: 1, escalated: 0, failed: 0, lastDecisionAt: 1_757_412_000_000 },
    // M39 Task 4 renders this block; Task 1 only added it to the report the view carries.
    mailbox: { pendingQuestions: 0, draftsAwaiting: 0, answeredBySupervisor24h: 0 },
  },
  pending: [decision({})],
  // Fix round 1, Minor 3: the tier and the status are DIFFERENT literals here, so an assertion
  // that the row carries both cannot be satisfied by one of them printed twice.
  recent: [decision({}), decision({ id: 'd0', tier: 'proposed', status: 'approved', decidedBy: 'rules', rationale: 'The review cap was the only thing holding it.' })],
  settings: { enabled: true, profile: 'Prefer unblocking over failing.' },
  ...over,
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

  it('lists recent decisions with their tier, status, decider and rationale', async () => {
    await mount()

    const rows = screen.getAllByTestId('supervisor-decision-row')
    expect(rows).toHaveLength(2)
    expect(rows[1]?.textContent).toContain('proposed')
    expect(rows[1]?.textContent).toContain('approved')
    expect(rows[1]?.textContent).toContain('rules')
    expect(screen.getAllByTestId('supervisor-decision-rationale')[1]?.textContent).toBe(
      'The review cap was the only thing holding it.',
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
})
