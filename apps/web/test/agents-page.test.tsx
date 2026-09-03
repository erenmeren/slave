// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentsClient, toneForStatus } from '../src/components/AgentsClient.js'
import { ModelOverrideEditor } from '../src/components/ModelOverrideEditor.js'
import { RosterTable } from '../src/components/RosterTable.js'
import { WorkersTable } from '../src/components/WorkersTable.js'
import type { RosterCompany, RosterMemberRow, WorkerRow } from '../src/server/org.js'

const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}))

function member(over: Partial<RosterMemberRow>): RosterMemberRow {
  return {
    companyAgentId: 'ca1',
    name: 'Alex',
    role: 'backend',
    templateName: 'Backend Engineer',
    effectiveModel: 'claude-sonnet-4',
    modelSource: 'template',
    rosterModel: null,
    templateDefaultModel: 'claude-sonnet-4',
    effectiveProvider: 'claude_code',
    providerSource: 'template',
    workers: [],
    ...over,
  }
}

function company(over: Partial<RosterCompany>): RosterCompany {
  return {
    companyId: 'c1',
    companyName: 'Acme Robotics',
    teams: [{ companyTeamId: 't1', teamName: 'Platform', members: [member({})] }],
    ...over,
  }
}

function rosterWithMember(m: RosterMemberRow): readonly RosterCompany[] {
  return [company({ teams: [{ companyTeamId: 't1', teamName: 'Platform', members: [m] }] })]
}

// M12 Task 13: a worker row from `listRoster`'s `RosterMemberRow.workers`, with its `provider`/
// `gate` pair -- new fields, so a new helper rather than widening `workerRow` below (that one
// builds a flat `WorkerRow`, a different type from `listWorkers`, untouched by this task).
function rosterWorker(over: Partial<RosterMemberRow['workers'][number]> = {}): RosterMemberRow['workers'][number] {
  return {
    agentId: 'wk1',
    // M23 D2: the worker's OWN name/role, distinct from the roster member's -- `AgentRowActions`
    // renders/edits these.
    name: 'Alex',
    role: 'backend',
    workspaceId: 'w1',
    projectName: 'Checkout',
    status: 'working',
    model: null,
    provider: null,
    gate: null,
    currentTask: null,
    ...over,
  }
}

function workerRow(over: Partial<WorkerRow>): WorkerRow {
  return {
    agentId: 'a1',
    name: 'Alex',
    role: 'backend',
    workspaceId: 'w1',
    projectName: 'Checkout',
    status: 'working',
    currentTask: { title: 'Add the thing', pct: 40 },
    department: 'Engineering',
    provider: null,
    gate: null,
    tokens: null,
    costUsd: 0,
    unmeasuredRuns: 0,
    ...over,
  }
}

afterEach(() => {
  routerRefresh.mockClear()
})

describe('toneForStatus', () => {
  it('maps every AgentStatus to a StatusTone', () => {
    expect(toneForStatus('working')).toBe('working')
    expect(toneForStatus('starting')).toBe('planning')
    expect(toneForStatus('resuming')).toBe('planning')
    expect(toneForStatus('paused')).toBe('paused')
    expect(toneForStatus('pausing')).toBe('paused')
    expect(toneForStatus('stopping')).toBe('waiting')
    expect(toneForStatus('idle')).toBe('idle')
  })
})

describe('AgentsClient tabs', () => {
  // Re-pointed by the M14 fix wave (queue item (a) / review I3): the default tab was `roster`,
  // and this test asserted it. The design README §3a.2 says the Agents page IS the seven-column
  // workers table, so `workers` is the default now and Roster is the tab you click to.
  it('renders the workers table by default and switches to the roster tab on click', () => {
    render(<AgentsClient roster={[company({})]} workers={[workerRow({})]} teams={[]} />)
    expect(screen.queryByTestId('roster-company')).toBeNull()
    expect(screen.getByTestId('data-table')).toBeTruthy()
    // The Workers tab is the handoff's seven-column table (Task 9, C2) -- it has no Project
    // column any more, so this asserts on the Department column (the team name) it replaced it
    // with, not the `projectName` field the M11-era table used to render here.
    expect(screen.getByTestId('worker-department').textContent).toBe('Engineering')
    expect(screen.getByTestId('agents-tab-workers').getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByTestId('agents-tab-roster'))

    expect(screen.getByTestId('roster-company')).toBeTruthy()
  })

  it('puts Workers first in the tab row, because it is the page -- Teams (M23 D3) trails Roster', () => {
    render(<AgentsClient roster={[company({})]} workers={[workerRow({})]} teams={[]} />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Workers', 'Roster', 'Teams'])
  })

  it('switches to the Teams tab and renders a TeamsTable row', () => {
    render(
      <AgentsClient
        roster={[company({})]}
        workers={[workerRow({})]}
        teams={[{ teamId: 't1', name: 'Platform', workspaceId: 'w1', projectName: 'Checkout', agentCount: 2 }]}
      />,
    )
    expect(screen.queryByTestId('team-rename')).toBeNull()

    fireEvent.click(screen.getByTestId('agents-tab-teams'))

    expect(screen.getByTestId('agents-tab-teams').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('team-rename').textContent).toBe('Platform')
  })
})

// Fix round 1 (Important finding): the row-click panel must resolve `workspaceId` off the
// clicked `WorkerRow` itself, never by re-deriving from `AgentsClient`'s own `workers` prop --
// that prop is the Agents page's one-time server snapshot (`app/agents/page.tsx`, fetched once
// per navigation), while `WorkersTable` polls `/api/org/workers` every 5s and keeps the refreshed
// rows in its OWN internal state, never surfacing them back up. A worker materialized only after
// the page's initial load is invisible to that stale prop, so a lookup against it is a silent
// no-op for exactly the row an operator can see and click.
// M14 fix wave, review I1 / Decision 4: `unmeasuredRuns` was on the row and rendered nowhere, so
// the README's own `cost` column presented the measured part of a bill as the whole of it.
describe('WorkersTable cost column', () => {
  it('says how many of the agent runs were never measured, beside the cost', () => {
    render(<WorkersTable initial={[workerRow({ agentId: 'a1', costUsd: 3.02, unmeasuredRuns: 2 })]} onOpen={() => {}} />)
    expect(screen.getByTestId('worker-cost').textContent?.replace(/\s+/g, ' ').trim()).toBe('$3.02 · 2 unmeasured')
  })

  it('says nothing extra when every run was measured', () => {
    render(<WorkersTable initial={[workerRow({ agentId: 'a1', costUsd: 3.02, unmeasuredRuns: 0 })]} onOpen={() => {}} />)
    expect(screen.getByTestId('worker-cost').textContent?.replace(/\s+/g, ' ').trim()).toBe('$3.02')
    expect(screen.queryByTestId('worker-unmeasured-a1')).toBeNull()
  })
})

describe('AgentsClient row click opens the freshest data', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens the panel for a worker that only exists via the poll, not the stale server-snapshot prop', async () => {
    const polledWorker = workerRow({ agentId: 'a2', workspaceId: 'w2', name: 'Blair' })
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/org/workers') {
        return new Response(JSON.stringify({ workers: [polledWorker] }), { status: 200 })
      }
      if (url === '/api/w/w2/overview') {
        return new Response(
          JSON.stringify({
            agents: [
              {
                id: 'a2',
                name: 'Blair',
                role: 'backend',
                provider: null,
                gate: null,
                status: 'working',
                taskTitle: null,
                taskId: null,
                taskStatus: null,
                progressPct: 0,
                stepLabel: null,
                skill: null,
                actionLine: null,
                runId: null,
                queuedMessage: null,
                resumeRequestedAt: null,
                recentEvents: [],
                costUsd: 0,
                toolCalls: 0,
                pausedAtStep: null,
              },
            ],
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    // The page's own snapshot knows only 'a1'/'w1' -- 'a2'/'w2' is materialized entirely by the
    // poll below, and is the only worker on screen by the time it's clicked.
    render(<AgentsClient roster={[company({})]} workers={[workerRow({ agentId: 'a1', workspaceId: 'w1', name: 'Alex' })]} teams={[]} />)
    fireEvent.click(screen.getByTestId('agents-tab-workers'))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getByText('Blair')).toBeTruthy()

    vi.useRealTimers()
    fireEvent.click(screen.getByTestId('worker-row-button'))

    expect(await screen.findByRole('heading', { name: 'Blair' })).toBeTruthy()
  })
})

describe('RosterTable', () => {
  it('renders company -> team groups with member rows', () => {
    render(<RosterTable roster={[company({})]} />)
    expect(screen.getByText('Acme Robotics')).toBeTruthy()
    expect(screen.getByText('Platform')).toBeTruthy()
    expect(screen.getByText('Alex')).toBeTruthy()
    expect(screen.getByText('backend')).toBeTruthy()
    expect(screen.getByText('Backend Engineer')).toBeTruthy()
  })

  describe('the model chain chip for each modelSource case', () => {
    it('worker-varies', () => {
      const m = member({ name: 'A', modelSource: 'worker-varies', effectiveModel: 'claude-sonnet-4' })
      render(<RosterTable roster={rosterWithMember(m)} />)
      expect(screen.getByText('claude-sonnet-4')).toBeTruthy()
      expect(screen.getByText('worker-varies')).toBeTruthy()
    })

    it('roster', () => {
      const m = member({ name: 'B', modelSource: 'roster', effectiveModel: 'claude-opus-4', rosterModel: 'claude-opus-4' })
      render(<RosterTable roster={rosterWithMember(m)} />)
      expect(screen.getByText('claude-opus-4')).toBeTruthy()
      expect(screen.getByText('roster')).toBeTruthy()
    })

    it('template', () => {
      // providerSource overridden to 'roster' (not the member() default, also 'template'):
      // otherwise both chips would show the text "template" and `getByText` would be ambiguous.
      const m = member({ name: 'C', modelSource: 'template', effectiveModel: 'claude-sonnet-4', rosterModel: null, providerSource: 'roster' })
      render(<RosterTable roster={rosterWithMember(m)} />)
      expect(screen.getByText('claude-sonnet-4')).toBeTruthy()
      expect(screen.getByText('template')).toBeTruthy()
    })

    it('none -- "—" for the effective model', () => {
      const m = member({ name: 'D', modelSource: 'none', effectiveModel: null, rosterModel: null, templateDefaultModel: null })
      render(<RosterTable roster={rosterWithMember(m)} />)
      expect(screen.getByText('—')).toBeTruthy()
      expect(screen.getByText('none')).toBeTruthy()
    })
  })

  // M12 Task 13 fix round 1, spec §8 / finding 4b: `providerSource` beside `modelSource`.
  describe('the provider chain chip for each providerSource case', () => {
    it('shows a template source when the provider comes from the template default', () => {
      const m = member({
        name: 'E',
        effectiveProvider: 'cursor',
        providerSource: 'template',
        // A distinct modelSource so this test's own "template" assertion is unambiguous.
        modelSource: 'roster',
      })
      render(<RosterTable roster={rosterWithMember(m)} />)
      expect(screen.getByText('cursor')).toBeTruthy()
      expect(screen.getByText('template')).toBeTruthy()
    })

    it('shows a roster source when the provider comes from the roster row override', () => {
      const m = member({
        name: 'F',
        effectiveProvider: 'claude_code',
        providerSource: 'roster',
        // A distinct modelSource so this test's own "roster" assertion is unambiguous.
        modelSource: 'none',
        effectiveModel: null,
      })
      render(<RosterTable roster={rosterWithMember(m)} />)
      expect(screen.getByText('claude_code')).toBeTruthy()
      expect(screen.getByText('roster')).toBeTruthy()
    })
  })

  describe('expanding a member', () => {
    it('reveals its workers (project, status, current task + progress, model, override editor) and hides them collapsed', () => {
      const worker = {
        agentId: 'wk1',
        name: 'Alex',
        role: 'backend',
        workspaceId: 'w1',
        projectName: 'Checkout',
        status: 'working',
        model: 'claude-sonnet-4',
        currentTask: { title: 'Add the thing', pct: 40 },
      }
      const m = member({ name: 'Alex', workers: [worker] })
      render(<RosterTable roster={rosterWithMember(m)} />)

      expect(screen.queryByTestId('roster-worker-row')).toBeNull()

      fireEvent.click(screen.getByTestId('roster-member-toggle'))

      const row = screen.getByTestId('roster-worker-row')
      expect(row).toBeTruthy()
      expect(screen.getByText('Checkout')).toBeTruthy()
      expect(screen.getByText('Add the thing')).toBeTruthy()
      expect(screen.getByTestId('progress-bar-fill').style.width).toBe('40%')
      expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('working')
      expect(screen.getByTestId('model-override-editor')).toBeTruthy()

      fireEvent.click(screen.getByTestId('roster-member-toggle'))
      expect(screen.queryByTestId('roster-worker-row')).toBeNull()
    })
  })

  // M12 Task 13 brief, Step 1 -- adapted to `RosterTable`'s real `roster` prop (the brief's
  // sketch's `workers` prop is pseudocode; `ModelOverrideEditor`'s pair editor lives one level
  // down, inside an expanded member's worker row).
  describe('the model+provider pair on a worker row', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('submits the model and its provider together', async () => {
      const m = member({ name: 'Alex', workers: [rosterWorker()] })
      render(<RosterTable roster={rosterWithMember(m)} />)
      fireEvent.click(screen.getByTestId('roster-member-toggle'))

      fireEvent.change(screen.getByLabelText('provider'), { target: { value: 'cursor' } })
      fireEvent.change(screen.getByLabelText('model override'), { target: { value: 'some-model' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('model-override-set'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/agents/wk1/model',
        expect.objectContaining({ body: JSON.stringify({ model: 'some-model', provider: 'cursor' }) }),
      )
    })

    it('shows the refusal text verbatim when a model arrives without a provider', async () => {
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'a model must name the provider that runs it' }), { status: 409 }),
      )
      const m = member({ name: 'Alex', workers: [rosterWorker()] })
      render(<RosterTable roster={rosterWithMember(m)} />)
      fireEvent.click(screen.getByTestId('roster-member-toggle'))

      fireEvent.change(screen.getByLabelText('model override'), { target: { value: 'some-model' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('model-override-set'))
      })

      expect(await screen.findByText('a model must name the provider that runs it')).toBeTruthy()
      // M11's idiom: a refused write keeps what the operator typed.
      expect((screen.getByLabelText('model override') as HTMLInputElement).value).toBe('some-model')
    })

    it('marks a shell-only gate on the roster row', () => {
      const m = member({ name: 'Alex', workers: [rosterWorker({ provider: 'cursor', gate: 'shell-only' })] })
      render(<RosterTable roster={rosterWithMember(m)} />)
      fireEvent.click(screen.getByTestId('roster-member-toggle'))

      expect(screen.getByText(/shell only/i)).toBeTruthy()
    })
  })
})

describe('ModelOverrideEditor', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts the typed value on Set and refreshes on 200', async () => {
    render(<ModelOverrideEditor agentId="wk1" model={null} />)
    fireEvent.change(screen.getByTestId('model-override-input'), { target: { value: 'claude-opus-4' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('model-override-set'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agents/wk1/model',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ model: 'claude-opus-4' }) }),
    )
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('posts null on Clear and refreshes on 200', async () => {
    render(<ModelOverrideEditor agentId="wk1" model="claude-opus-4" />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('model-override-clear'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agents/wk1/model',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ model: null }) }),
    )
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('shows a 409 refusal inline without refreshing', async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'a model must be a non-empty text' }), { status: 409 }),
    )
    render(<ModelOverrideEditor agentId="wk1" model={null} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('model-override-set'))
    })

    expect(screen.getByRole('alert').textContent).toContain('a model must be a non-empty text')
    expect(routerRefresh).not.toHaveBeenCalled()
  })

  it('resyncs the input from a new model prop -- the post-refresh snapshot, not a stray edit', () => {
    const { rerender } = render(<ModelOverrideEditor agentId="wk1" model="claude-opus-4" />)
    // A stray edit the caller never submitted (e.g. typed then navigated away without clicking
    // Set/Clear) must not survive the next snapshot arriving as a new `model` prop.
    fireEvent.change(screen.getByTestId('model-override-input'), { target: { value: 'not submitted' } })
    expect((screen.getByTestId('model-override-input') as HTMLInputElement).value).toBe('not submitted')

    // Same instance (same agentId/key) re-rendered with a changed model, as router.refresh()
    // would do after a successful clear elsewhere.
    rerender(<ModelOverrideEditor agentId="wk1" model={null} />)

    expect((screen.getByTestId('model-override-input') as HTMLInputElement).value).toBe('')
  })
})

describe('WorkersTable', () => {
  it('renders a flat row per worker with role, department, status, and task progress', () => {
    render(
      <WorkersTable
        initial={[
          workerRow({ name: 'Alex', role: 'backend', department: 'Engineering', status: 'working', currentTask: { title: 'Ship it', pct: 60 } }),
        ]}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByText('Alex')).toBeTruthy()
    expect(screen.getByText('backend')).toBeTruthy()
    expect(screen.getByTestId('worker-department').textContent).toBe('Engineering')
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('working')
    expect(screen.getByText('Ship it')).toBeTruthy()
    expect(screen.getByTestId('progress-bar-fill').style.width).toBe('60%')
  })

  describe('polling', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      vi.useFakeTimers()
      fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ workers: [workerRow({ agentId: 'a2', name: 'Blair' })] }), { status: 200 }),
      )
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('re-fetches GET /api/org/workers every 5s and replaces the rows', async () => {
      render(<WorkersTable initial={[workerRow({ agentId: 'a1', name: 'Alex' })]} onOpen={() => {}} />)
      expect(screen.getByText('Alex')).toBeTruthy()
      expect(fetchMock).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect(fetchMock).toHaveBeenCalledWith('/api/org/workers')
      expect(screen.getByText('Blair')).toBeTruthy()
    })

    it('clears the interval on unmount (no further fetch after unmounting)', async () => {
      const { unmount } = render(<WorkersTable initial={[workerRow({ agentId: 'a1', name: 'Alex' })]} onOpen={() => {}} />)
      unmount()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })

      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('pauses polling while document.visibilityState is hidden, resumes once visible again', async () => {
      render(<WorkersTable initial={[workerRow({ agentId: 'a1', name: 'Alex' })]} onOpen={() => {}} />)
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(fetchMock).not.toHaveBeenCalled()

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(fetchMock).toHaveBeenCalledWith('/api/org/workers')
    })
  })
})

describe('WorkersTable — the handoff seven columns', () => {
  it('uses the README grid template on the header and every row', () => {
    render(<WorkersTable initial={[workerRow({})]} onOpen={() => {}} />)
    const expected = '200px 130px 120px 1fr 110px 90px 80px'
    expect(screen.getByTestId('data-table-header').style.gridTemplateColumns).toBe(expected)
    expect(screen.getByTestId('data-table-row').style.gridTemplateColumns).toBe(expected)
  })

  it('names the seven columns in the README order', () => {
    render(<WorkersTable initial={[workerRow({})]} onOpen={() => {}} />)
    expect(screen.getAllByTestId('data-table-header-cell').map((c) => c.textContent)).toEqual([
      'Agent', 'Department', 'Status', 'Current task', 'Provider', 'Tokens', 'Cost',
    ])
  })

  it('renders an avatar tile, the department, and the status pill from the tone table', () => {
    render(<WorkersTable initial={[workerRow({ name: 'Alex Turner', department: 'Engineering', status: 'working' })]} onOpen={() => {}} />)
    expect(screen.getByTestId('avatar-tile').textContent).toBe('AT')
    expect(screen.getByTestId('worker-department').textContent).toBe('Engineering')
    expect(screen.getByTestId('status-pill').textContent).toBe('WORKING')
  })

  it('renders the current task with an inline progress bar, and — when there is none', () => {
    const { rerender } = render(
      <WorkersTable initial={[workerRow({ currentTask: { title: 'Add the thing', pct: 40 } })]} onOpen={() => {}} />,
    )
    expect(screen.getByTestId('progress-bar-fill').style.width).toBe('40%')

    rerender(<WorkersTable initial={[workerRow({ currentTask: null })]} onOpen={() => {}} />)
    expect(screen.getByTestId('worker-task').textContent).toBe('—')
  })

  it('renders tokens and cost, with the unknown mark where nothing was measured', () => {
    const { rerender } = render(<WorkersTable initial={[workerRow({ tokens: 1_400_000, costUsd: 3.02 })]} onOpen={() => {}} />)
    expect(screen.getByTestId('worker-tokens').textContent).toBe('1.4M')
    expect(screen.getByTestId('worker-cost').textContent).toBe('$3.02')

    rerender(<WorkersTable initial={[workerRow({ tokens: null, costUsd: 0 })]} onOpen={() => {}} />)
    expect(screen.getByTestId('worker-tokens').textContent).toBe('—')
  })

  it('marks a shell-only gate beside the provider, and nothing for a runtime that gates every tool', () => {
    const { rerender } = render(<WorkersTable initial={[workerRow({ provider: 'cursor', gate: 'shell-only' })]} onOpen={() => {}} />)
    expect(screen.getByTestId('shell-only-mark')).toBeTruthy()

    rerender(<WorkersTable initial={[workerRow({ provider: 'claude_code', gate: 'all-tools' })]} onOpen={() => {}} />)
    expect(screen.queryByTestId('shell-only-mark')).toBeNull()
  })

  it('opens the agent panel on a row click, with the clicked worker itself -- not just its id', () => {
    // Fix round 1: `onOpen` must hand back the full `WorkerRow` (or at least its `workspaceId`
    // alongside `agentId`) -- `AgentsClient` needs a workspaceId that is CURRENT for the row
    // actually clicked, which only this table's own (possibly polled) row can supply.
    const onOpen = vi.fn()
    const worker = workerRow({ agentId: 'a9', workspaceId: 'w9' })
    render(<WorkersTable initial={[worker]} onOpen={onOpen} />)
    fireEvent.click(screen.getByTestId('worker-row-button'))
    expect(onOpen).toHaveBeenCalledWith(worker)
  })
})
