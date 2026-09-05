// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlavesClient, toneForStatus } from '../src/components/SlavesClient.js'
import type { AllSlaveRow, AllSlavesPage } from '../src/server/org.js'

const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}))

function slaveRow(over: Partial<AllSlaveRow> = {}): AllSlaveRow {
  return {
    slaveId: 'a1',
    companySlaveId: null,
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

function page(rows: readonly AllSlaveRow[]): AllSlavesPage {
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
  it('maps every SlaveStatus to a StatusTone', () => {
    expect(toneForStatus('working')).toBe('working')
    expect(toneForStatus('starting')).toBe('planning')
    expect(toneForStatus('resuming')).toBe('planning')
    expect(toneForStatus('paused')).toBe('paused')
    expect(toneForStatus('pausing')).toBe('paused')
    expect(toneForStatus('stopping')).toBe('waiting')
    expect(toneForStatus('idle')).toBe('idle')
  })
})

describe('SlavesClient tabs', () => {
  // M24 Task 7: the Slaves page is two tabs now -- Slaves (the one table, default) and
  // Departments (M25 Task 7: Teams renamed). Roster and Workers were two names for the same
  // list of slaves (spec §5.3) and are gone.
  it('renders the slaves table by default, with Departments beside it', () => {
    render(<SlavesClient slaves={page([slaveRow({})])} teams={[]} workspaces={[]} companies={[]} roster={[]} templates={[]} />)
    expect(screen.getByTestId('data-table')).toBeTruthy()
    expect(screen.getByTestId('worker-row-button').textContent).toContain('Alex')
    expect(screen.getByTestId('slaves-tab-slaves').getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Slaves', 'Departments'])
  })

  it('switches to the Departments tab and renders a DepartmentsTable row', () => {
    render(
      <SlavesClient
        slaves={page([slaveRow({})])}
        teams={[{ teamId: 't1', name: 'Platform', workspaceId: 'w1', projectName: 'Checkout', slaveCount: 2 }]}
        workspaces={[]}
        companies={[]}
        roster={[]}
        templates={[]}
      />,
    )
    expect(screen.queryByTestId('department-rename')).toBeNull()

    fireEvent.click(screen.getByTestId('slaves-tab-departments'))

    expect(screen.getByTestId('slaves-tab-departments').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('department-rename').textContent).toBe('Platform')
  })

  // M25 Task 8: `+ New slave` opens the catalog form (`NewSlaveDrawer`) beside the tablist.
  it('opens the New slave drawer', () => {
    render(<SlavesClient slaves={page([slaveRow({})])} teams={[]} workspaces={[]} companies={[]} roster={[]} templates={[]} />)
    fireEvent.click(screen.getByTestId('new-slave'))
    expect(screen.getByRole('dialog', { name: /new slave/i })).toBeTruthy()
  })
})

// Fix round 1 (Important finding), from `WorkersTable`'s M11-era days: the row-click panel must
// resolve `workspaceId` off the clicked row itself, never by re-deriving from `SlavesClient`'s
// own snapshot prop. `AllSlavesTable` (M24 Task 7) keeps that: `onOpen` still hands back the
// CLICKED row's own ids straight out of the table's own state, not a lookup back into
// `SlavesClient`'s `slaves` prop. Its poll is a narrower merge than `WorkersTable`'s full
// replace, though (`AllSlavesTable.tsx`'s own docstring): it only refreshes the LIVE fields of
// a row already on screen, matched by `slaveId` -- so a slave this page has never
// seen no longer materializes purely from a poll tick the way a `WorkersTable` row once could;
// it shows up as a catalog row (from `listAllSlaves`'s own snapshot) until the next page load.
describe('SlavesClient row click opens the panel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("opens the panel using the clicked row's own slaveId/workspaceId, after its status has moved via the poll", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/org/workers') {
        return new Response(
          JSON.stringify({
            workers: [
              {
                slaveId: 'a1',
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
            slaves: [
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

    render(
      <SlavesClient
        slaves={page([slaveRow({ slaveId: 'a1', workspaceId: 'w1', name: 'Alex', status: 'working' })])}
        teams={[]}
        workspaces={[]}
        companies={[]}
        roster={[]}
        templates={[]}
      />,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('paused')

    vi.useRealTimers()
    fireEvent.click(screen.getByTestId('worker-row-button'))

    expect(await screen.findByRole('heading', { name: 'Alex' })).toBeTruthy()
  })
})
