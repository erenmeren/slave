// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRowActions } from '../src/components/AgentRowActions.js'

const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}))

describe('AgentRowActions', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    routerRefresh.mockClear()
  })

  it('PUTs the new name on blur and refreshes on success', async () => {
    render(<AgentRowActions agentId="wk1" name="Alex" role="backend" />)

    fireEvent.click(screen.getByTestId('agent-name-edit'))
    fireEvent.change(screen.getByTestId('agent-name-input'), { target: { value: 'Jordan' } })
    await act(async () => {
      fireEvent.blur(screen.getByTestId('agent-name-input'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agents/wk1/name',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: 'Jordan' }) }),
    )
    expect(routerRefresh).toHaveBeenCalled()
    // The field collapses back to the button on a successful commit.
    expect(screen.getByTestId('agent-name-edit')).toBeTruthy()
  })

  it('PUTs the new name on Enter, without waiting for blur', async () => {
    render(<AgentRowActions agentId="wk1" name="Alex" role="backend" />)

    fireEvent.click(screen.getByTestId('agent-name-edit'))
    fireEvent.change(screen.getByTestId('agent-name-input'), { target: { value: 'Jordan' } })
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('agent-name-input'), { key: 'Enter' })
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agents/wk1/name',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: 'Jordan' }) }),
    )
  })

  it('PUTs the new role on blur and refreshes on success', async () => {
    render(<AgentRowActions agentId="wk1" name="Alex" role="backend" />)

    fireEvent.click(screen.getByTestId('agent-role-edit'))
    fireEvent.change(screen.getByTestId('agent-role-input'), { target: { value: 'frontend' } })
    await act(async () => {
      fireEvent.blur(screen.getByTestId('agent-role-input'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agents/wk1/role',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ role: 'frontend' }) }),
    )
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('deletes only after a second click -- the DangerZone two-step', async () => {
    render(<AgentRowActions agentId="wk1" name="Alex" role="backend" />)

    fireEvent.click(screen.getByTestId('agent-delete'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('agent-delete-confirm')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByTestId('agent-delete-confirm'))
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/agents/wk1', expect.objectContaining({ method: 'DELETE' }))
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('cancels the delete confirm without ever calling fetch', () => {
    render(<AgentRowActions agentId="wk1" name="Alex" role="backend" />)

    fireEvent.click(screen.getByTestId('agent-delete'))
    fireEvent.click(screen.getByTestId('agent-delete-cancel'))

    expect(screen.queryByTestId('agent-delete-confirm')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows a refusal inline without refreshing, on either edit', async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'the name "Jordan" is already taken' }), { status: 409 }),
    )
    render(<AgentRowActions agentId="wk1" name="Alex" role="backend" />)

    fireEvent.click(screen.getByTestId('agent-name-edit'))
    fireEvent.change(screen.getByTestId('agent-name-input'), { target: { value: 'Jordan' } })
    await act(async () => {
      fireEvent.blur(screen.getByTestId('agent-name-input'))
    })

    expect(screen.getByRole('alert').textContent).toBe('the name "Jordan" is already taken')
    expect(routerRefresh).not.toHaveBeenCalled()
  })

  it('shows a refusal on a blocked delete, and leaves the row in place', async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: 'agent wk1 has 2 run(s) in history and stays (rename it or leave it idle)' }), {
          status: 409,
        }),
    )
    render(<AgentRowActions agentId="wk1" name="Alex" role="backend" />)

    fireEvent.click(screen.getByTestId('agent-delete'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('agent-delete-confirm'))
    })

    expect(screen.getByTestId('agent-actions-error').textContent).toBe(
      'agent wk1 has 2 run(s) in history and stays (rename it or leave it idle)',
    )
    expect(routerRefresh).not.toHaveBeenCalled()
  })
})
