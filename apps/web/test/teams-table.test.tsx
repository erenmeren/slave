// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamsTable } from '../src/components/TeamsTable.js'
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

afterEach(() => {
  routerRefresh.mockClear()
})

describe('TeamsTable', () => {
  it('renders no rows message when there are no teams', () => {
    render(<TeamsTable teams={[]} />)
    expect(screen.getByText('no teams yet.')).toBeTruthy()
  })

  it('renders one row per team: project, name, agent count', () => {
    render(<TeamsTable teams={[team({ projectName: 'Checkout', name: 'Platform', agentCount: 3 })]} />)
    expect(screen.getByText('Checkout')).toBeTruthy()
    expect(screen.getByTestId('team-rename').textContent).toBe('Platform')
    expect(screen.getByText('3')).toBeTruthy()
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
      render(<TeamsTable teams={[team({ teamId: 't1', name: 'Platform' })]} />)

      fireEvent.click(screen.getByTestId('team-rename'))
      fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: 'Infra' } })
      await act(async () => {
        fireEvent.blur(screen.getByTestId('team-name-input'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/teams/t1/name',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: 'Infra' }) }),
      )
      expect(routerRefresh).toHaveBeenCalled()
    })

    it('PUTs the new name on Enter', async () => {
      render(<TeamsTable teams={[team({ teamId: 't1', name: 'Platform' })]} />)

      fireEvent.click(screen.getByTestId('team-rename'))
      fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: 'Infra' } })
      await act(async () => {
        fireEvent.keyDown(screen.getByTestId('team-name-input'), { key: 'Enter' })
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
      render(<TeamsTable teams={[team({ teamId: 't1', name: 'Platform' })]} />)

      fireEvent.click(screen.getByTestId('team-rename'))
      fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: 'Infra' } })
      await act(async () => {
        fireEvent.blur(screen.getByTestId('team-name-input'))
      })

      expect(screen.getByTestId('team-actions-error').textContent).toBe('the name "Infra" is already taken')
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
      render(<TeamsTable teams={[team({ teamId: 't1', agentCount: 0 })]} />)

      fireEvent.click(screen.getByTestId('team-delete'))
      expect(fetchMock).not.toHaveBeenCalled()
      expect(screen.getByTestId('team-delete-confirm')).toBeTruthy()

      await act(async () => {
        fireEvent.click(screen.getByTestId('team-delete-confirm'))
      })

      expect(fetchMock).toHaveBeenCalledWith('/api/teams/t1', expect.objectContaining({ method: 'DELETE' }))
      expect(routerRefresh).toHaveBeenCalled()
    })

    it('cancels the delete confirm without calling fetch', () => {
      render(<TeamsTable teams={[team({ teamId: 't1', agentCount: 0 })]} />)

      fireEvent.click(screen.getByTestId('team-delete'))
      fireEvent.click(screen.getByTestId('team-delete-cancel'))

      expect(screen.queryByTestId('team-delete-confirm')).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('disables delete with a title when the team still has agents', () => {
      render(<TeamsTable teams={[team({ teamId: 't1', agentCount: 2 })]} />)

      const button = screen.getByTestId('team-delete') as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.title).toBe('team has agents')

      fireEvent.click(button)
      expect(screen.queryByTestId('team-delete-confirm')).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('shows the refusal on a blocked delete', async () => {
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'team t1 still has 1 agent(s)' }), { status: 409 }),
      )
      render(<TeamsTable teams={[team({ teamId: 't1', agentCount: 0 })]} />)

      fireEvent.click(screen.getByTestId('team-delete'))
      await act(async () => {
        fireEvent.click(screen.getByTestId('team-delete-confirm'))
      })

      expect(screen.getByTestId('team-actions-error').textContent).toBe('team t1 still has 1 agent(s)')
      expect(routerRefresh).not.toHaveBeenCalled()
    })
  })
})
