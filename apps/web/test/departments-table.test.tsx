// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DepartmentsTable } from '../src/components/DepartmentsTable.js'
import type { ProjectTeamRow } from '../src/server/org.js'

const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}))

function team(over: Partial<ProjectTeamRow> = {}): ProjectTeamRow {
  return {
    teamId: 't1',
    name: 'Platform',
    workspaceId: 'w1',
    projectName: 'Checkout',
    agentCount: 0,
    ...over,
  }
}

const WORKSPACES = [{ id: 'w1', name: 'Checkout' }] as const

afterEach(() => {
  routerRefresh.mockClear()
})

describe('DepartmentsTable', () => {
  it('renders no rows message when there are no departments', () => {
    render(<DepartmentsTable teams={[]} workspaces={WORKSPACES} />)
    expect(screen.getByText('no departments yet.')).toBeTruthy()
  })

  it('renders one row per department: project, name, agent count', () => {
    render(<DepartmentsTable teams={[team({ projectName: 'Checkout', name: 'Platform', agentCount: 3 })]} workspaces={WORKSPACES} />)
    // Scoped to the data table: the form above it also renders a "Checkout" `<option>` (the
    // project select), so an unscoped `getByText('Checkout')` matches both.
    const table = within(screen.getByTestId('data-table'))
    expect(table.getByText('Checkout')).toBeTruthy()
    expect(screen.getByTestId('department-rename').textContent).toBe('Platform')
    expect(table.getByText('3')).toBeTruthy()
  })

  describe('rename', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('PUTs the new name on blur and refreshes on success', async () => {
      render(<DepartmentsTable teams={[team({ teamId: 't1', name: 'Platform' })]} workspaces={WORKSPACES} />)

      fireEvent.click(screen.getByTestId('department-rename'))
      fireEvent.change(screen.getByTestId('department-rename-input'), { target: { value: 'Infra' } })
      await act(async () => {
        fireEvent.blur(screen.getByTestId('department-rename-input'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/teams/t1/name',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: 'Infra' }) }),
      )
      expect(routerRefresh).toHaveBeenCalled()
    })

    it('PUTs the new name on Enter', async () => {
      render(<DepartmentsTable teams={[team({ teamId: 't1', name: 'Platform' })]} workspaces={WORKSPACES} />)

      fireEvent.click(screen.getByTestId('department-rename'))
      fireEvent.change(screen.getByTestId('department-rename-input'), { target: { value: 'Infra' } })
      await act(async () => {
        fireEvent.keyDown(screen.getByTestId('department-rename-input'), { key: 'Enter' })
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/teams/t1/name',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: 'Infra' }) }),
      )
    })

    it('shows the refusal text inline without refreshing', async () => {
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'the name "Infra" is already taken' }), { status: 409 }),
      )
      render(<DepartmentsTable teams={[team({ teamId: 't1', name: 'Platform' })]} workspaces={WORKSPACES} />)

      fireEvent.click(screen.getByTestId('department-rename'))
      fireEvent.change(screen.getByTestId('department-rename-input'), { target: { value: 'Infra' } })
      await act(async () => {
        fireEvent.blur(screen.getByTestId('department-rename-input'))
      })

      expect(screen.getByTestId('department-actions-error').textContent).toBe('the name "Infra" is already taken')
      expect(routerRefresh).not.toHaveBeenCalled()
    })
  })

  describe('delete', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('deletes only after a second click, DELETEing the team', async () => {
      render(<DepartmentsTable teams={[team({ teamId: 't1', agentCount: 0 })]} workspaces={WORKSPACES} />)

      fireEvent.click(screen.getByTestId('department-delete'))
      expect(fetchMock).not.toHaveBeenCalled()
      expect(screen.getByTestId('department-delete-confirm')).toBeTruthy()

      await act(async () => {
        fireEvent.click(screen.getByTestId('department-delete-confirm'))
      })

      expect(fetchMock).toHaveBeenCalledWith('/api/teams/t1', expect.objectContaining({ method: 'DELETE' }))
      expect(routerRefresh).toHaveBeenCalled()
    })

    it('cancels the delete confirm without calling fetch', () => {
      render(<DepartmentsTable teams={[team({ teamId: 't1', agentCount: 0 })]} workspaces={WORKSPACES} />)

      fireEvent.click(screen.getByTestId('department-delete'))
      fireEvent.click(screen.getByTestId('department-delete-cancel'))

      expect(screen.queryByTestId('department-delete-confirm')).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('disables delete with a title when the department still has agents', () => {
      render(<DepartmentsTable teams={[team({ teamId: 't1', agentCount: 2 })]} workspaces={WORKSPACES} />)

      const button = screen.getByTestId('department-delete') as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.title).toBe('department has agents')

      fireEvent.click(button)
      expect(screen.queryByTestId('department-delete-confirm')).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('shows the refusal on a blocked delete', async () => {
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'team t1 still has 1 agent(s)' }), { status: 409 }),
      )
      render(<DepartmentsTable teams={[team({ teamId: 't1', agentCount: 0 })]} workspaces={WORKSPACES} />)

      fireEvent.click(screen.getByTestId('department-delete'))
      await act(async () => {
        fireEvent.click(screen.getByTestId('department-delete-confirm'))
      })

      expect(screen.getByTestId('department-actions-error').textContent).toBe('team t1 still has 1 agent(s)')
      expect(routerRefresh).not.toHaveBeenCalled()
    })
  })

  describe('the New department form', () => {
    let fetchMock: ReturnType<typeof vi.fn>
    beforeEach(() => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: 't9' }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
    })
    afterEach(() => vi.unstubAllGlobals())

    it('posts { name } to the chosen project and refreshes', async () => {
      render(<DepartmentsTable teams={[]} workspaces={[{ id: 'w1', name: 'Checkout' }, { id: 'w2', name: 'Billing' }]} />)
      fireEvent.change(screen.getByTestId('department-project-select'), { target: { value: 'w2' } })
      fireEvent.change(screen.getByTestId('department-name-input'), { target: { value: 'Design' } })
      await act(async () => {
        fireEvent.click(screen.getByTestId('department-submit'))
      })
      expect(fetchMock).toHaveBeenCalledWith('/api/w/w2/teams', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Design' }) }))
      expect(routerRefresh).toHaveBeenCalled()
    })

    it('renders a 409 beside the form', async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'a department named Design already exists' }), { status: 409 }))
      render(<DepartmentsTable teams={[]} workspaces={[{ id: 'w1', name: 'Checkout' }]} />)
      fireEvent.change(screen.getByTestId('department-name-input'), { target: { value: 'Design' } })
      await act(async () => {
        fireEvent.click(screen.getByTestId('department-submit'))
      })
      expect(screen.getByTestId('department-error').textContent).toContain('Design')
    })

    it('is disabled with a hint when the install has no project', () => {
      render(<DepartmentsTable teams={[]} workspaces={[]} />)
      expect((screen.getByTestId('department-submit') as HTMLButtonElement).disabled).toBe(true)
      expect(screen.getByText('attach a project first')).toBeTruthy()
    })
  })
})
