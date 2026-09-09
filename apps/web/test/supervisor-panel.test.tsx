// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SupervisorPanel } from '../src/components/SupervisorPanel.js'
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
  },
  pending: [decision({})],
  recent: [decision({}), decision({ id: 'd0', status: 'applied', tier: 'applied', decidedBy: 'rules', rationale: 'The review cap was the only thing holding it.' })],
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
  })

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
    expect(fetchMock.mock.calls.filter((call) => call[0] === GET_URL)).toHaveLength(2)
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
    expect(rows[1]?.textContent).toContain('applied')
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

  it("re-reads the view when the overview's poll tick changes", async () => {
    respondWith(view())
    const { rerender } = render(<SupervisorPanel workspaceId="w1" refreshKey={1} />)
    await act(async () => {})

    await act(async () => {
      rerender(<SupervisorPanel workspaceId="w1" refreshKey={2} />)
    })

    expect(fetchMock.mock.calls.filter((call) => call[0] === GET_URL)).toHaveLength(2)
  })
})
