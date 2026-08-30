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
    render(<GoalCard workspaceId="w1" goal={null} suggestions={[]} />)
    expect(screen.getByRole('textbox', { name: 'workspace goal' })).toBeTruthy()
    expect(screen.getByTestId('goal-submit')).toBeTruthy()
    expect(screen.queryByTestId('workspace-goal')).toBeNull()
  })

  it('POSTs /api/w/w1/goal with the typed text', async () => {
    render(<GoalCard workspaceId="w1" goal={null} suggestions={[]} />)
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
    render(<GoalCard workspaceId="w1" goal="ship the redesign" suggestions={[]} />)
    expect(screen.getByTestId('workspace-goal').textContent).toBe('ship the redesign')
    expect(screen.queryByTestId('goal-input')).toBeNull()
  })

  it('a 409 lands in the alert span', async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'a goal must be a non-empty text' }), { status: 409 }),
    )
    render(<GoalCard workspaceId="w1" goal={null} suggestions={[]} />)
    fireEvent.change(screen.getByTestId('goal-input'), { target: { value: '  ' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('goal-submit'))
    })

    expect(screen.getByRole('alert').textContent).toContain('a goal must be a non-empty text')
    // Success clears nothing locally; a failed submit stays in form mode too.
    expect(screen.getByTestId('goal-input')).toBeTruthy()
  })
  it('captions an unset goal as waiting and offers the last three goals as chips', () => {
    render(<GoalCard workspaceId="w1" goal={null} suggestions={['ship checkout', 'fix fraud rules', 'add SSO']} />)
    expect(screen.getByTestId('goal-waiting').textContent).toBe('waiting for a goal')
    expect(screen.getAllByTestId('goal-suggestion').map((c) => c.textContent)).toEqual(['ship checkout', 'fix fraud rules', 'add SSO'])
  })

  it('fills the input from a clicked suggestion rather than submitting it', () => {
    render(<GoalCard workspaceId="w1" goal={null} suggestions={['ship checkout']} />)
    fireEvent.click(screen.getByTestId('goal-suggestion'))
    expect((screen.getByLabelText('workspace goal') as HTMLInputElement).value).toBe('ship checkout')
    // A chip is a shortcut into the form, not a second submit button — clicking one must not
    // POST a goal the operator has not read back.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('captions a workspace with no goal history, without drawing an empty chip row', () => {
    render(<GoalCard workspaceId="w1" goal={null} suggestions={[]} />)
    expect(screen.getByTestId('goal-waiting').textContent).toBe('waiting for a goal')
    expect(screen.queryByTestId('goal-suggestion')).toBeNull()
  })

  it('shows no chips and no caption once a goal is set', () => {
    render(<GoalCard workspaceId="w1" goal="ship checkout" suggestions={['ship checkout']} />)
    expect(screen.queryByTestId('goal-waiting')).toBeNull()
    expect(screen.queryByTestId('goal-suggestion')).toBeNull()
  })
})
