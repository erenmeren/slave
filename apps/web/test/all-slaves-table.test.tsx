// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AllSlavesTable } from '../src/components/AllSlavesTable.js'
import type { AllSlaveRow, AllSlavesPage } from '../src/server/org.js'

const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}))

function row(over: Partial<AllSlaveRow> = {}): AllSlaveRow {
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
    currentTask: null,
    provider: null,
    gate: null,
    model: null,
    costUsd: 0,
    unmeasuredRuns: 0,
    runCount: 0,
    // M37 t4 fix round 1: the dispatch set. The default is the parked one, so the cases below
    // that care state their own.
    runtimeRoles: [],
    // M50 R1/R3: why the worker is here, and whether the engagement is over. `project` is the
    // ordinary hire, which is what most of this file's rows are.
    lifecycle: 'project',
    released: null,
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

/** A full `GET /api/org/workers` payload entry (`PolledWorker` in `AllSlavesTable.tsx`) -- every
 *  field a poll reads, whether merging into a known row or seeding a brand-new one. */
function polledWorker(over: Partial<{
  slaveId: string
  name: string
  role: string
  workspaceId: string
  projectName: string
  status: string
  currentTask: AllSlaveRow['currentTask']
  teamId: string
  department: string
  provider: AllSlaveRow['provider']
  gate: AllSlaveRow['gate']
  costUsd: number
  unmeasuredRuns: number
  runtimeRoles: readonly string[]
  lifecycle: AllSlaveRow['lifecycle']
  released: AllSlaveRow['released']
}> = {}) {
  return {
    slaveId: 'a1',
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
    runtimeRoles: [],
    lifecycle: 'project' as const,
    released: null,
    ...over,
  }
}

afterEach(() => {
  routerRefresh.mockClear()
})

describe('AllSlavesTable', () => {
  it('renders one data-table-row per row', () => {
    render(
      <AllSlavesTable
        initial={page([row({ slaveId: 'a1', name: 'Alex' }), row({ slaveId: 'a2', name: 'Blair' })])}
        onOpen={() => {}}
      />,
    )
    expect(screen.getAllByTestId('data-table-row')).toHaveLength(2)
  })

  it('shows SlaveRowActions and the model override editor on a project row (slaveId set)', () => {
    render(<AllSlavesTable initial={page([row({ slaveId: 'a1', name: 'Alex', role: 'backend' })])} onOpen={() => {}} />)
    expect(screen.getByTestId('slave-name-edit').textContent).toBe('Alex')
    expect(screen.getByTestId('model-override-editor')).toBeTruthy()
  })

  it('shows "—" for a catalog member\'s project, no rename/re-role, and a catalog-slave-delete (not slave-delete)', () => {
    render(
      <AllSlavesTable
        initial={page([row({ slaveId: null, companySlaveId: 'ca1', name: 'Nova', projectName: null, workspaceId: null })])}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('slave-project').textContent).toBe('—')
    expect(screen.getByTestId('slave-project').getAttribute('aria-label')).toBe('project —')
    expect(screen.queryByTestId('slave-name-edit')).toBeNull()
    expect(screen.queryByTestId('model-override-editor')).toBeNull()
    expect(screen.getByTestId('catalog-slave-delete')).toBeTruthy()
    expect(screen.queryByTestId('slave-delete')).toBeNull()
  })

  // M44 R5 leak 1: this pill printed the raw `deriveSlaveStatus` value, so the Slaves table said
  // "pausing" where the Overview card said PAUSING. Both come from the domain projection now, and
  // the raw value stays one hover away -- backend state fidelity is never weakened for the UI.
  it('says PAUSING, not "pausing", and keeps the raw status where a person can still find it (M44 R5)', () => {
    render(<AllSlavesTable initial={page([row({ slaveId: 'a1', name: 'Alex', status: 'pausing' })])} onOpen={vi.fn()} />)
    const pill = screen.getAllByTestId('status-pill')[0]
    expect(pill?.textContent).toContain('PAUSING')
    expect(pill?.textContent).not.toContain('pausing')
    expect(pill?.getAttribute('title')).toBe('pausing')
    // `pausing` is the `pause_requested` card state, which rides the amber `waiting` tone (and
    // pulses) rather than the settled grey-blue `paused` -- `lib/tones.ts`'s own distinction, and
    // the reason this case pins the tone as well as the word.
    expect(pill?.getAttribute('data-tone')).toBe('waiting')
  })

  it("calls onOpen with the clicked project row's own slaveId and workspaceId", () => {
    const onOpen = vi.fn()
    render(<AllSlavesTable initial={page([row({ slaveId: 'a9', workspaceId: 'w9', name: 'Alex' })])} onOpen={onOpen} />)
    fireEvent.click(screen.getByTestId('worker-row-button'))
    expect(onOpen).toHaveBeenCalledWith({ slaveId: 'a9', workspaceId: 'w9' })
  })

  // Ported from `WorkersTable`'s own case (M12 Task 13 fix round 1, base
  // `test/slaves-page.test.tsx`; M24 final review, Important 3 -- the move to `AllSlavesTable`
  // dropped the mark).
  it('marks a shell-only gate beside the provider, and nothing for a runtime that gates every tool', () => {
    const { rerender } = render(<AllSlavesTable initial={page([row({ provider: 'cursor', gate: 'shell-only' })])} onOpen={() => {}} />)
    expect(screen.getByTestId('shell-only-mark')).toBeTruthy()

    rerender(<AllSlavesTable initial={page([row({ provider: 'claude_code', gate: 'all-tools' })])} onOpen={() => {}} />)
    expect(screen.queryByTestId('shell-only-mark')).toBeNull()
  })

  // M44 final review, item I3: this table printed the bare `claude_code` column value.
  it('reads the provider label, with the raw kind kept in title', () => {
    const { rerender } = render(<AllSlavesTable initial={page([row({ provider: 'claude_code', gate: 'all-tools' })])} onOpen={() => {}} />)
    expect(screen.getByTestId('worker-provider').textContent).toBe('Claude Code')
    expect(screen.getByTestId('worker-provider').getAttribute('title')).toBe('claude_code')

    rerender(<AllSlavesTable initial={page([row({ provider: 'cursor', gate: 'all-tools' })])} onOpen={() => {}} />)
    expect(screen.getByTestId('worker-provider').textContent).toBe('Cursor')

    rerender(<AllSlavesTable initial={page([row({ provider: null, gate: null })])} onOpen={() => {}} />)
    expect(screen.getByTestId('worker-provider').textContent).toBe('—')
  })

  // M37 t4 fix round 1 (spec §5): this table is the all-workers view, and a worker parked with an
  // empty `runtimeRoles` -- the exact state an operator looks for when nothing picks up a task --
  // was invisible here. `role` stays the title cell it always was; the dispatch set sits beside it.
  describe('runtime roles (M37 §5)', () => {
    it('shows one chip per dispatchable role beside the title', () => {
      render(
        <AllSlavesTable
          initial={page([row({ role: 'Senior Engineer', runtimeRoles: ['backend', 'reviewer'] })])}
          onOpen={() => {}}
        />,
      )

      expect(screen.getByTestId('worker-role').textContent).toBe('Senior Engineer')
      expect(screen.getAllByTestId('runtime-role-chip').map((chip) => chip.textContent)).toEqual([
        'backend',
        'reviewer',
      ])
      expect(screen.queryByTestId('not-dispatchable')).toBeNull()
    })

    it('warns that a project worker holding no runtime roles cannot be dispatched', () => {
      render(<AllSlavesTable initial={page([row({ runtimeRoles: [] })])} onOpen={() => {}} />)

      expect(screen.getByTestId('not-dispatchable').textContent).toMatch(/cannot be dispatched/i)
    })

    it('says nothing about dispatch on a catalog row: no worker exists yet to dispatch', () => {
      render(
        <AllSlavesTable
          initial={page([row({ slaveId: null, companySlaveId: 'ca1', name: 'Nova', projectName: null, workspaceId: null })])}
          onOpen={() => {}}
        />,
      )

      expect(screen.queryByTestId('not-dispatchable')).toBeNull()
      expect(screen.queryByTestId('runtime-role-chip')).toBeNull()
    })
  })

  // M50 R6/D6: the column that says who is temporary, and the poll that keeps it honest.
  describe('the lifecycle column', () => {
    it('prints the word, keeps the key in title, and greys a released row', () => {
      render(
        <AllSlavesTable
          initial={page([
            row({ slaveId: 'a1', name: 'Ada' }),
            row({
              slaveId: 'a2',
              name: 'Robin',
              lifecycle: 'ephemeral',
              released: { at: '2026-09-12T10:00:00.000Z', reason: 'the engagement is over' },
            }),
          ])}
          onOpen={() => {}}
        />,
      )
      const cells = screen.getAllByTestId('worker-lifecycle')
      expect(cells.map((cell) => cell.textContent)).toEqual(['Project', 'Ephemeral'])
      expect(cells[1]?.getAttribute('title')).toBe('ephemeral')
      // Greyed, never hidden (D7) -- the row is still here and still openable.
      expect(screen.getAllByTestId('slave-row').map((one) => one.getAttribute('data-released'))).toEqual([null, 'true'])
      expect(screen.getAllByTestId('data-table-row')).toHaveLength(2)
    })

    it('names a catalog member Permanent: a roster member IS somebody the organisation has', () => {
      render(
        <AllSlavesTable
          initial={page([row({ slaveId: null, companySlaveId: 'ca1', name: 'Nova', projectName: null, workspaceId: null, lifecycle: 'permanent' })])}
          onOpen={() => {}}
        />,
      )
      expect(screen.getByTestId('worker-lifecycle').textContent).toBe('Permanent')
    })
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
        <AllSlavesTable
          initial={page([
            row({ slaveId: 'a1', name: 'Alex', status: 'working' }),
            row({ slaveId: null, companySlaveId: 'ca1', name: 'Nova', projectName: null, workspaceId: null, status: 'idle' }),
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
      // The catalog row (no slaveId) never matches the poll -- still idle.
      expect(screen.getAllByTestId('status-pill')[1]?.getAttribute('data-tone')).toBe('idle')
    })

    it("merges a poll's teamId/department into a known row's department select", async () => {
      fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ workers: [polledWorker({ teamId: 't2', department: 'QA' })] }), { status: 200 }),
      )
      vi.stubGlobal('fetch', fetchMock)

      render(<AllSlavesTable initial={page([row({})])} onOpen={() => {}} />)
      expect((screen.getByTestId('slave-department') as HTMLSelectElement).value).toBe('t1')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect((screen.getByTestId('slave-department') as HTMLSelectElement).value).toBe('t2')
    })

    // M24 final review, Important 4: the merge-only poll regressed the base `WorkersTable`'s
    // add/remove contract -- a worker created after load never appeared.
    it('adds a row for a worker the table has never rendered before', async () => {
      fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ workers: [polledWorker({ slaveId: 'a1' }), polledWorker({ slaveId: 'a2', name: 'Blair', projectName: 'Billing' })] }),
            { status: 200 },
          ),
      )
      vi.stubGlobal('fetch', fetchMock)

      render(
        <AllSlavesTable
          initial={page([
            row({ slaveId: 'a1', name: 'Alex' }),
            row({ slaveId: null, companySlaveId: 'ca1', name: 'Nova', projectName: null, workspaceId: null }),
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

    // M50 D6: an approved hire and a release both land between reloads. A table that showed a
    // released worker as an ordinary project one for five minutes would be the one surface
    // disagreeing with the roster.
    it('carries a release and a lifecycle move onto an already-rendered row', async () => {
      fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              workers: [
                polledWorker({
                  slaveId: 'a1',
                  lifecycle: 'ephemeral',
                  released: { at: '2026-09-12T10:00:00.000Z', reason: 'the engagement is over' },
                }),
              ],
            }),
            { status: 200 },
          ),
      )
      vi.stubGlobal('fetch', fetchMock)

      render(<AllSlavesTable initial={page([row({ slaveId: 'a1', name: 'Alex' })])} onOpen={() => {}} />)
      expect(screen.getByTestId('worker-lifecycle').textContent).toBe('Project')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect(screen.getByTestId('worker-lifecycle').textContent).toBe('Ephemeral')
      expect(screen.getByTestId('slave-row').getAttribute('data-released')).toBe('true')
    })

    it('drops a project row whose slaveId is missing from the payload, leaving a catalog row alone', async () => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ workers: [polledWorker({ slaveId: 'a1' })] }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      render(
        <AllSlavesTable
          initial={page([
            row({ slaveId: 'a1', name: 'Alex' }),
            row({ slaveId: 'a2', name: 'Blair', projectName: 'Billing' }),
            row({ slaveId: null, companySlaveId: 'ca1', name: 'Nova', projectName: null, workspaceId: null }),
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

    // Ported from `WorkersTable`'s own polling tests (base `test/slaves-page.test.tsx`).
    it('clears the interval on unmount (no further fetch after unmounting)', async () => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ workers: [polledWorker({ slaveId: 'a1' })] }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      const { unmount } = render(<AllSlavesTable initial={page([row({ slaveId: 'a1', name: 'Alex' })])} onOpen={() => {}} />)
      unmount()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })

      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('pauses polling while document.visibilityState is hidden, resumes once visible again', async () => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ workers: [polledWorker({ slaveId: 'a1' })] }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      render(<AllSlavesTable initial={page([row({ slaveId: 'a1', name: 'Alex' })])} onOpen={() => {}} />)
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
    it('says how many of the slave runs were never measured, beside the cost', () => {
      render(<AllSlavesTable initial={page([row({ slaveId: 'a1', costUsd: 3.02, unmeasuredRuns: 2 })])} onOpen={() => {}} />)
      expect(screen.getByTestId('worker-cost').textContent?.replace(/\s+/g, ' ').trim()).toBe('$3.02 · 2 unmeasured')
    })

    it('says nothing extra when every run was measured', () => {
      render(<AllSlavesTable initial={page([row({ slaveId: 'a1', costUsd: 3.02, unmeasuredRuns: 0 })])} onOpen={() => {}} />)
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
    render(<AllSlavesTable initial={page([row({})])} onOpen={() => {}} />)
    const select = screen.getByTestId('slave-department') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Engineering', 'QA'])
    expect(select.value).toBe('t1')

    await act(async () => {
      fireEvent.change(select, { target: { value: 't2' } })
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/slaves/a1/team', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ teamId: 't2' }) }))
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('lists the company templates on a catalog row and PUTs the catalog move', async () => {
    render(
      <AllSlavesTable
        initial={page([row({ slaveId: null, workspaceId: null, projectName: null, teamId: null, companySlaveId: 'ca1', companyId: 'c1', companyTeamId: 'ct1', departmentName: 'Backend' })])}
        onOpen={() => {}}
      />,
    )
    const select = screen.getByTestId('slave-department') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Backend', 'Design'])

    await act(async () => {
      fireEvent.change(select, { target: { value: 'ct2' } })
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/org/slaves/ca1/team', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ companyTeamId: 'ct2' }) }))
  })

  it('renders a 409 under the cell and keeps the old value', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'slave a1 holds a live run' }), { status: 409 }))
    render(<AllSlavesTable initial={page([row({})])} onOpen={() => {}} />)

    await act(async () => {
      fireEvent.change(screen.getByTestId('slave-department'), { target: { value: 't2' } })
    })

    expect(screen.getByTestId('slave-department-error').textContent).toContain('live run')
    expect((screen.getByTestId('slave-department') as HTMLSelectElement).value).toBe('t1')
    expect(routerRefresh).not.toHaveBeenCalled()
  })
})
