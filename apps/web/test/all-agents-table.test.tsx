// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AllAgentsTable } from '../src/components/AllAgentsTable.js'
import type { AllAgentRow, AllAgentsPage } from '../src/server/org.js'

const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}))

function row(over: Partial<AllAgentRow> = {}): AllAgentRow {
  return {
    agentId: 'a1',
    companyAgentId: null,
    name: 'Alex',
    role: 'backend',
    departmentName: 'Engineering',
    projectName: 'Checkout',
    workspaceId: 'w1',
    teamId: 't1',
    companyId: null,
    companyTeamId: null,
    status: 'working',
    currentTask: null,
    provider: null,
    gate: null,
    model: null,
    costUsd: 0,
    unmeasuredRuns: 0,
    ...over,
  }
}

function page(rows: readonly AllAgentRow[]): AllAgentsPage {
  return {
    rows,
    departmentsByWorkspace: { w1: [{ id: 't1', name: 'Engineering' }, { id: 't2', name: 'QA' }] },
    templatesByCompany: { c1: [{ id: 'ct1', name: 'Backend' }, { id: 'ct2', name: 'Design' }] },
  }
}

/** A full `GET /api/org/workers` payload entry (`PolledWorker` in `AllAgentsTable.tsx`) -- every
 *  field a poll reads, whether merging into a known row or seeding a brand-new one. */
function polledWorker(over: Partial<{
  agentId: string
  name: string
  role: string
  workspaceId: string
  projectName: string
  status: string
  currentTask: AllAgentRow['currentTask']
  teamId: string
  department: string
  provider: AllAgentRow['provider']
  gate: AllAgentRow['gate']
  costUsd: number
  unmeasuredRuns: number
}> = {}) {
  return {
    agentId: 'a1',
    name: 'Alex',
    role: 'backend',
    workspaceId: 'w1',
    projectName: 'Checkout',
    status: 'working',
    currentTask: null,
    teamId: 't1',
    department: 'Engineering',
    provider: null,
    gate: null,
    costUsd: 0,
    unmeasuredRuns: 0,
    ...over,
  }
}

afterEach(() => {
  routerRefresh.mockClear()
})

describe('AllAgentsTable', () => {
  it('renders one data-table-row per row', () => {
    render(
      <AllAgentsTable
        initial={page([row({ agentId: 'a1', name: 'Alex' }), row({ agentId: 'a2', name: 'Blair' })])}
        onOpen={() => {}}
      />,
    )
    expect(screen.getAllByTestId('data-table-row')).toHaveLength(2)
  })

  it('shows AgentRowActions and the model override editor on a project row (agentId set)', () => {
    render(<AllAgentsTable initial={page([row({ agentId: 'a1', name: 'Alex', role: 'backend' })])} onOpen={() => {}} />)
    expect(screen.getByTestId('agent-name-edit').textContent).toBe('Alex')
    expect(screen.getByTestId('model-override-editor')).toBeTruthy()
  })

  it('shows "—" for a catalog member\'s project and no row actions', () => {
    render(
      <AllAgentsTable
        initial={page([row({ agentId: null, companyAgentId: 'ca1', name: 'Nova', projectName: null, workspaceId: null })])}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('agent-project').textContent).toBe('—')
    expect(screen.getByTestId('agent-project').getAttribute('aria-label')).toBe('project —')
    expect(screen.queryByTestId('agent-name-edit')).toBeNull()
    expect(screen.queryByTestId('model-override-editor')).toBeNull()
  })

  it("calls onOpen with the clicked project row's own agentId and workspaceId", () => {
    const onOpen = vi.fn()
    render(<AllAgentsTable initial={page([row({ agentId: 'a9', workspaceId: 'w9', name: 'Alex' })])} onOpen={onOpen} />)
    fireEvent.click(screen.getByTestId('worker-row-button'))
    expect(onOpen).toHaveBeenCalledWith({ agentId: 'a9', workspaceId: 'w9' })
  })

  // Ported from `WorkersTable`'s own case (M12 Task 13 fix round 1, base
  // `test/agents-page.test.tsx`; M24 final review, Important 3 -- the move to `AllAgentsTable`
  // dropped the mark).
  it('marks a shell-only gate beside the provider, and nothing for a runtime that gates every tool', () => {
    const { rerender } = render(<AllAgentsTable initial={page([row({ provider: 'cursor', gate: 'shell-only' })])} onOpen={() => {}} />)
    expect(screen.getByTestId('shell-only-mark')).toBeTruthy()

    rerender(<AllAgentsTable initial={page([row({ provider: 'claude_code', gate: 'all-tools' })])} onOpen={() => {}} />)
    expect(screen.queryByTestId('shell-only-mark')).toBeNull()
  })

  describe('polling', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('updates the matching row\'s status/cost from a 5s poll of /api/org/workers, and leaves a catalog row alone', async () => {
      fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ workers: [polledWorker({ status: 'paused', provider: 'cursor', costUsd: 5, unmeasuredRuns: 1 })] }),
            { status: 200 },
          ),
      )
      vi.stubGlobal('fetch', fetchMock)

      render(
        <AllAgentsTable
          initial={page([
            row({ agentId: 'a1', name: 'Alex', status: 'working' }),
            row({ agentId: null, companyAgentId: 'ca1', name: 'Nova', projectName: null, workspaceId: null, status: 'idle' }),
          ])}
          onOpen={() => {}}
        />,
      )
      expect(screen.getAllByTestId('status-pill')[0]?.getAttribute('data-tone')).toBe('working')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect(fetchMock).toHaveBeenCalledWith('/api/org/workers')
      expect(screen.getAllByTestId('status-pill')[0]?.getAttribute('data-tone')).toBe('paused')
      // The catalog row (no agentId) never matches the poll -- still idle.
      expect(screen.getAllByTestId('status-pill')[1]?.getAttribute('data-tone')).toBe('idle')
    })

    it("merges a poll's teamId/department into a known row's department select", async () => {
      fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ workers: [polledWorker({ teamId: 't2', department: 'QA' })] }), { status: 200 }),
      )
      vi.stubGlobal('fetch', fetchMock)

      render(<AllAgentsTable initial={page([row({})])} onOpen={() => {}} />)
      expect((screen.getByTestId('agent-department') as HTMLSelectElement).value).toBe('t1')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect((screen.getByTestId('agent-department') as HTMLSelectElement).value).toBe('t2')
    })

    // M24 final review, Important 4: the merge-only poll regressed the base `WorkersTable`'s
    // add/remove contract -- a worker created after load never appeared.
    it('adds a row for a worker the table has never rendered before', async () => {
      fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ workers: [polledWorker({ agentId: 'a1' }), polledWorker({ agentId: 'a2', name: 'Blair', projectName: 'Billing' })] }),
            { status: 200 },
          ),
      )
      vi.stubGlobal('fetch', fetchMock)

      render(
        <AllAgentsTable
          initial={page([
            row({ agentId: 'a1', name: 'Alex' }),
            row({ agentId: null, companyAgentId: 'ca1', name: 'Nova', projectName: null, workspaceId: null }),
          ])}
          onOpen={() => {}}
        />,
      )
      expect(screen.queryByText('Blair')).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect(screen.getAllByText('Blair').length).toBeGreaterThan(0)
      // The catalog row survives an add exactly as it does a drop -- a poll never touches one.
      expect(screen.getByText('Nova')).toBeTruthy()
      expect(screen.getAllByTestId('data-table-row')).toHaveLength(3)
    })

    it('drops a project row whose agentId is missing from the payload, leaving a catalog row alone', async () => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ workers: [polledWorker({ agentId: 'a1' })] }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      render(
        <AllAgentsTable
          initial={page([
            row({ agentId: 'a1', name: 'Alex' }),
            row({ agentId: 'a2', name: 'Blair', projectName: 'Billing' }),
            row({ agentId: null, companyAgentId: 'ca1', name: 'Nova', projectName: null, workspaceId: null }),
          ])}
          onOpen={() => {}}
        />,
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      // Both `Alex` matches are inside the surviving row -- its name span and its rename button.
      expect(screen.getAllByText('Alex').length).toBeGreaterThan(0)
      expect(screen.queryByText('Blair')).toBeNull()
      expect(screen.getByText('Nova')).toBeTruthy()
      expect(screen.getAllByTestId('data-table-row')).toHaveLength(2)
    })

    // Ported from `WorkersTable`'s own polling tests (base `test/agents-page.test.tsx`).
    it('clears the interval on unmount (no further fetch after unmounting)', async () => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ workers: [polledWorker({ agentId: 'a1' })] }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      const { unmount } = render(<AllAgentsTable initial={page([row({ agentId: 'a1', name: 'Alex' })])} onOpen={() => {}} />)
      unmount()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })

      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('pauses polling while document.visibilityState is hidden, resumes once visible again', async () => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ workers: [polledWorker({ agentId: 'a1' })] }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      render(<AllAgentsTable initial={page([row({ agentId: 'a1', name: 'Alex' })])} onOpen={() => {}} />)
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

  // Ported from `WorkersTable`'s own cost-column cases (M14 fix wave, review I1 / Decision 4).
  describe('cost column', () => {
    it('says how many of the agent runs were never measured, beside the cost', () => {
      render(<AllAgentsTable initial={page([row({ agentId: 'a1', costUsd: 3.02, unmeasuredRuns: 2 })])} onOpen={() => {}} />)
      expect(screen.getByTestId('worker-cost').textContent?.replace(/\s+/g, ' ').trim()).toBe('$3.02 · 2 unmeasured')
    })

    it('says nothing extra when every run was measured', () => {
      render(<AllAgentsTable initial={page([row({ agentId: 'a1', costUsd: 3.02, unmeasuredRuns: 0 })])} onOpen={() => {}} />)
      expect(screen.getByTestId('worker-cost').textContent?.replace(/\s+/g, ' ').trim()).toBe('$3.02')
      expect(screen.queryByTestId('worker-unmeasured-a1')).toBeNull()
    })
  })
})

describe('the department select', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('lists the project departments on a project row and PUTs the move, then refreshes', async () => {
    render(<AllAgentsTable initial={page([row({})])} onOpen={() => {}} />)
    const select = screen.getByTestId('agent-department') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Engineering', 'QA'])
    expect(select.value).toBe('t1')

    await act(async () => {
      fireEvent.change(select, { target: { value: 't2' } })
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/team', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ teamId: 't2' }) }))
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('lists the company templates on a catalog row and PUTs the catalog move', async () => {
    render(
      <AllAgentsTable
        initial={page([row({ agentId: null, workspaceId: null, projectName: null, teamId: null, companyAgentId: 'ca1', companyId: 'c1', companyTeamId: 'ct1', departmentName: 'Backend' })])}
        onOpen={() => {}}
      />,
    )
    const select = screen.getByTestId('agent-department') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Backend', 'Design'])

    await act(async () => {
      fireEvent.change(select, { target: { value: 'ct2' } })
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/org/agents/ca1/team', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ companyTeamId: 'ct2' }) }))
  })

  it('renders a 409 under the cell and keeps the old value', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'agent a1 holds a live run' }), { status: 409 }))
    render(<AllAgentsTable initial={page([row({})])} onOpen={() => {}} />)

    await act(async () => {
      fireEvent.change(screen.getByTestId('agent-department'), { target: { value: 't2' } })
    })

    expect(screen.getByTestId('agent-department-error').textContent).toContain('live run')
    expect((screen.getByTestId('agent-department') as HTMLSelectElement).value).toBe('t1')
    expect(routerRefresh).not.toHaveBeenCalled()
  })
})
