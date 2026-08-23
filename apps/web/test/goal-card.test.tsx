// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoalCard } from '../src/components/GoalCard.js'

describe('GoalCard', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the form when goal is null', () => {
    render(<GoalCard workspaceId="w1" goal={null} />)
    expect(screen.getByRole('textbox', { name: 'workspace goal' })).toBeTruthy()
    expect(screen.getByTestId('goal-submit')).toBeTruthy()
    expect(screen.queryByTestId('workspace-goal')).toBeNull()
  })

  it('POSTs /api/w/w1/goal with the typed text', async () => {
    render(<GoalCard workspaceId="w1" goal={null} />)
    fireEvent.change(screen.getByTestId('goal-input'), { target: { value: 'ship the redesign' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('goal-submit'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/goal',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ goal: 'ship the redesign' }),
      }),
    )
  })

  it('renders the goal read-only when set', () => {
    render(<GoalCard workspaceId="w1" goal="ship the redesign" />)
    expect(screen.getByTestId('workspace-goal').textContent).toBe('ship the redesign')
    expect(screen.queryByTestId('goal-input')).toBeNull()
  })

  it('a 409 lands in the alert span', async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'a goal must be a non-empty text' }), { status: 409 }),
    )
    render(<GoalCard workspaceId="w1" goal={null} />)
    fireEvent.change(screen.getByTestId('goal-input'), { target: { value: '  ' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('goal-submit'))
    })

    expect(screen.getByRole('alert').textContent).toContain('a goal must be a non-empty text')
    // Success clears nothing locally; a failed submit stays in form mode too.
    expect(screen.getByTestId('goal-input')).toBeTruthy()
  })
})
