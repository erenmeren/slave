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
    model: null,
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
            JSON.stringify({
              workers: [
                {
                  agentId: 'a1',
                  name: 'Alex',
                  role: 'backend',
                  workspaceId: 'w1',
                  projectName: 'Checkout',
                  status: 'paused',
                  currentTask: null,
                  department: 'Engineering',
                  provider: 'cursor',
                  gate: null,
                  tokens: null,
                  costUsd: 5,
                  unmeasuredRuns: 1,
                },
              ],
            }),
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
