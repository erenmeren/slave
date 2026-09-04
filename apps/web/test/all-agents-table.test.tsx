// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AllAgentsTable } from '../src/components/AllAgentsTable.js'
import type { AllAgentRow } from '../src/server/org.js'

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
    teamName: 'Engineering',
    projectName: 'Checkout',
    workspaceId: 'w1',
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
        initial={[row({ agentId: 'a1', name: 'Alex' }), row({ agentId: 'a2', name: 'Blair' })]}
        onOpen={() => {}}
      />,
    )
    expect(screen.getAllByTestId('data-table-row')).toHaveLength(2)
  })

  it('shows AgentRowActions and the model override editor on a project row (agentId set)', () => {
    render(<AllAgentsTable initial={[row({ agentId: 'a1', name: 'Alex', role: 'backend' })]} onOpen={() => {}} />)
    expect(screen.getByTestId('agent-name-edit').textContent).toBe('Alex')
    expect(screen.getByTestId('model-override-editor')).toBeTruthy()
  })

  it('shows "—" for a catalog member\'s project and no row actions', () => {
    render(
      <AllAgentsTable
        initial={[row({ agentId: null, companyAgentId: 'ca1', name: 'Nova', projectName: null, workspaceId: null })]}
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
    render(<AllAgentsTable initial={[row({ agentId: 'a9', workspaceId: 'w9', name: 'Alex' })]} onOpen={onOpen} />)
    fireEvent.click(screen.getByTestId('worker-row-button'))
    expect(onOpen).toHaveBeenCalledWith({ agentId: 'a9', workspaceId: 'w9' })
  })

  // Ported from `WorkersTable`'s own case (M12 Task 13 fix round 1, base
  // `test/agents-page.test.tsx`; M24 final review, Important 3 -- the move to `AllAgentsTable`
  // dropped the mark).
  it('marks a shell-only gate beside the provider, and nothing for a runtime that gates every tool', () => {
    const { rerender } = render(<AllAgentsTable initial={[row({ provider: 'cursor', gate: 'shell-only' })]} onOpen={() => {}} />)
    expect(screen.getByTestId('shell-only-mark')).toBeTruthy()

    rerender(<AllAgentsTable initial={[row({ provider: 'claude_code', gate: 'all-tools' })]} onOpen={() => {}} />)
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
          initial={[
            row({ agentId: 'a1', name: 'Alex', status: 'working' }),
            row({ agentId: null, companyAgentId: 'ca1', name: 'Nova', projectName: null, workspaceId: null, status: 'idle' }),
          ]}
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
          initial={[
            row({ agentId: 'a1', name: 'Alex' }),
            row({ agentId: null, companyAgentId: 'ca1', name: 'Nova', projectName: null, workspaceId: null }),
          ]}
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
          initial={[
            row({ agentId: 'a1', name: 'Alex' }),
            row({ agentId: 'a2', name: 'Blair', projectName: 'Billing' }),
            row({ agentId: null, companyAgentId: 'ca1', name: 'Nova', projectName: null, workspaceId: null }),
          ]}
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

      const { unmount } = render(<AllAgentsTable initial={[row({ agentId: 'a1', name: 'Alex' })]} onOpen={() => {}} />)
      unmount()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })

      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('pauses polling while document.visibilityState is hidden, resumes once visible again', async () => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ workers: [polledWorker({ agentId: 'a1' })] }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      render(<AllAgentsTable initial={[row({ agentId: 'a1', name: 'Alex' })]} onOpen={() => {}} />)
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
      render(<AllAgentsTable initial={[row({ agentId: 'a1', costUsd: 3.02, unmeasuredRuns: 2 })]} onOpen={() => {}} />)
      expect(screen.getByTestId('worker-cost').textContent?.replace(/\s+/g, ' ').trim()).toBe('$3.02 · 2 unmeasured')
    })

    it('says nothing extra when every run was measured', () => {
      render(<AllAgentsTable initial={[row({ agentId: 'a1', costUsd: 3.02, unmeasuredRuns: 0 })]} onOpen={() => {}} />)
      expect(screen.getByTestId('worker-cost').textContent?.replace(/\s+/g, ' ').trim()).toBe('$3.02')
      expect(screen.queryByTestId('worker-unmeasured-a1')).toBeNull()
    })
  })
})
