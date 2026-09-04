// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentsClient, toneForStatus } from '../src/components/AgentsClient.js'
import type { AllAgentRow, AllAgentsPage } from '../src/server/org.js'

const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}))

function agentRow(over: Partial<AllAgentRow> = {}): AllAgentRow {
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
    currentTask: { title: 'Add the thing', pct: 40 },
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
  // M24 Task 7: the Agents page is two tabs now -- Agents (the one table, default) and Teams.
  // Roster and Workers were two names for the same list of agents (spec §5.3) and are gone.
  it('renders the agents table by default, with Teams beside it', () => {
    render(<AgentsClient agents={page([agentRow({})])} teams={[]} />)
    expect(screen.getByTestId('data-table')).toBeTruthy()
    expect(screen.getByTestId('worker-row-button').textContent).toContain('Alex')
    expect(screen.getByTestId('agents-tab-agents').getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Agents', 'Teams'])
  })

  it('switches to the Teams tab and renders a TeamsTable row', () => {
    render(
      <AgentsClient
        agents={page([agentRow({})])}
        teams={[{ teamId: 't1', name: 'Platform', workspaceId: 'w1', projectName: 'Checkout', agentCount: 2 }]}
      />,
    )
    expect(screen.queryByTestId('team-rename')).toBeNull()

    fireEvent.click(screen.getByTestId('agents-tab-teams'))

    expect(screen.getByTestId('agents-tab-teams').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('team-rename').textContent).toBe('Platform')
  })
})

// Fix round 1 (Important finding), from `WorkersTable`'s M11-era days: the row-click panel must
// resolve `workspaceId` off the clicked row itself, never by re-deriving from `AgentsClient`'s
// own snapshot prop. `AllAgentsTable` (M24 Task 7) keeps that: `onOpen` still hands back the
// CLICKED row's own ids straight out of the table's own state, not a lookup back into
// `AgentsClient`'s `agents` prop. Its poll is a narrower merge than `WorkersTable`'s full
// replace, though (`AllAgentsTable.tsx`'s own docstring): it only refreshes the LIVE fields of
// a row already on screen, matched by `agentId` -- so an agent this page has never
// seen no longer materializes purely from a poll tick the way a `WorkersTable` row once could;
// it shows up as a catalog row (from `listAllAgents`'s own snapshot) until the next page load.
describe('AgentsClient row click opens the panel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("opens the panel using the clicked row's own agentId/workspaceId, after its status has moved via the poll", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/org/workers') {
        return new Response(
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
                provider: null,
                gate: null,
                tokens: null,
                costUsd: 0,
                unmeasuredRuns: 0,
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (url === '/api/w/w1/overview') {
        return new Response(
          JSON.stringify({
            agents: [
              {
                id: 'a1',
                name: 'Alex',
                role: 'backend',
                provider: null,
                gate: null,
                status: 'paused',
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
    vi.useFakeTimers()

    render(<AgentsClient agents={page([agentRow({ agentId: 'a1', workspaceId: 'w1', name: 'Alex', status: 'working' })])} teams={[]} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('paused')

    vi.useRealTimers()
    fireEvent.click(screen.getByTestId('worker-row-button'))

    expect(await screen.findByRole('heading', { name: 'Alex' })).toBeTruthy()
  })
})
