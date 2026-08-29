// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeCard } from '../src/components/RuntimeCard.js'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: (): void => {} }) }))

describe('RuntimeCard', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('PUTs the chosen provider', async (): Promise<void> => {
    render(<RuntimeCard workspaceId="w1" provider="claude_code" budgetUsd={20} costBlindBudgeted={false} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('workspace provider'), { target: { value: 'cursor' } })
      fireEvent.click(screen.getByTestId('runtime-provider-submit'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/provider',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ provider: 'cursor' }) }),
    )
  })

  it('sends an explicit null when the operator picks (none)', async (): Promise<void> => {
    render(<RuntimeCard workspaceId="w1" provider="cursor" budgetUsd={null} costBlindBudgeted={false} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('workspace provider'), { target: { value: '' } })
      fireEvent.click(screen.getByTestId('runtime-provider-submit'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/provider',
      expect.objectContaining({ body: JSON.stringify({ provider: null }) }),
    )
  })

  it('PUTs the typed budget', async (): Promise<void> => {
    render(<RuntimeCard workspaceId="w1" provider="claude_code" budgetUsd={20} costBlindBudgeted={false} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('workspace budget'), { target: { value: '35.5' } })
      fireEvent.click(screen.getByTestId('runtime-budget-submit'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/budget',
      expect.objectContaining({ body: JSON.stringify({ budgetUsd: 35.5 }) }),
    )
  })

  it('submits a budget of zero as the number zero, never as null', async (): Promise<void> => {
    // Decision 11's edge: `0` is a real ceiling ("this workspace may spend nothing"), and a card
    // that coalesced it to null would silently turn the strictest budget into no budget at all.
    render(<RuntimeCard workspaceId="w1" provider="claude_code" budgetUsd={20} costBlindBudgeted={false} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('workspace budget'), { target: { value: '0' } })
      fireEvent.click(screen.getByTestId('runtime-budget-submit'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/budget',
      expect.objectContaining({ body: JSON.stringify({ budgetUsd: 0 }) }),
    )
  })

  it('the not-budgeted checkbox disables the input and submits null', async (): Promise<void> => {
    render(<RuntimeCard workspaceId="w1" provider="cursor" budgetUsd={20} costBlindBudgeted={true} />)

    await act(async () => {
      fireEvent.click(screen.getByLabelText('not budgeted'))
    })
    // `getAttribute('disabled')` rather than jest-dom's `toBeDisabled` -- this repo's vitest
    // setup carries no jest-dom matchers, and `shell.test.tsx`/`agent-panel.test.tsx` assert on
    // the attribute directly for the same reason.
    expect((screen.getByLabelText('workspace budget') as HTMLInputElement).disabled).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-budget-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/budget',
      expect.objectContaining({ body: JSON.stringify({ budgetUsd: null }) }),
    )
  })

  it('a 409 keeps the operator input and shows the refusal verbatim', async (): Promise<void> => {
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'a budget must be a non-negative amount or absent' }), { status: 409 }),
    )
    render(<RuntimeCard workspaceId="w1" provider="claude_code" budgetUsd={20} costBlindBudgeted={false} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('workspace budget'), { target: { value: '-3' } })
      fireEvent.click(screen.getByTestId('runtime-budget-submit'))
    })

    expect(screen.getByRole('alert').textContent).toContain('a budget must be a non-negative amount or absent')
    // M11's idiom: a refused write keeps what the operator typed.
    expect((screen.getByLabelText('workspace budget') as HTMLInputElement).value).toBe('-3')
  })

  it('warns only for the cost-blind-and-budgeted combination', (): void => {
    const warning = /this provider reports no cost; a budgeted workspace will refuse it at dispatch/i
    const { rerender } = render(
      <RuntimeCard workspaceId="w1" provider="cursor" budgetUsd={20} costBlindBudgeted={true} />,
    )
    expect(screen.getByText(warning)).toBeTruthy()

    // Same cost-blind provider, no budget: nothing to warn about.
    rerender(<RuntimeCard workspaceId="w1" provider="cursor" budgetUsd={null} costBlindBudgeted={false} />)
    expect(screen.queryByText(warning)).toBeNull()

    // Budgeted, but on a runtime that reports cost.
    rerender(<RuntimeCard workspaceId="w1" provider="claude_code" budgetUsd={20} costBlindBudgeted={false} />)
    expect(screen.queryByText(warning)).toBeNull()
  })
})
