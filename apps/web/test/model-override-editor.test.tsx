// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelOverrideEditor } from '../src/components/ModelOverrideEditor.js'
import { clearModelSelectCache } from '../src/components/ModelSelect.js'

const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}))

afterEach(() => {
  routerRefresh.mockClear()
})

async function waitForModelSelect(): Promise<HTMLSelectElement> {
  return waitFor(() => {
    const select = screen.getByTestId('model-select') as HTMLSelectElement
    expect(select.disabled).toBe(false)
    return select
  })
}

// Recovered verbatim (M24 Task 7 fix round 1, Important finding 1) from the pre-rewrite
// `agents-page.test.tsx` (`git show 3b43e84:apps/web/test/agents-page.test.tsx`) -- `agents-page
// .test.tsx`'s M24 rewrite dropped this `describe` block entirely, even though `ModelOverrideEditor`
// itself is untouched by M24 and is still mounted (by `AllAgentsTable.tsx` now, not `RosterTable
// .tsx`/`WorkersTable.tsx`) on every project row. Moved to its own file, not restored into
// `agents-page.test.tsx`, because it tests the shared component directly rather than anything
// `AgentsClient`/`AllAgentsTable`-specific -- the same reason `agent-row-actions.test.tsx` (its
// sibling row-action component) already lives on its own.
describe('ModelOverrideEditor', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  // M25 Task 5: the model field is a `ModelSelect` now, gated on the provider being chosen --
  // there is no free-text input to type into until a provider is picked and `other…` is chosen.
  async function typeModel(value: string): Promise<void> {
    fireEvent.change(screen.getByTestId('model-override-provider'), { target: { value: 'claude_code' } })
    await waitForModelSelect()
    fireEvent.change(screen.getByTestId('model-select'), { target: { value: '__other__' } })
    fireEvent.change(screen.getByTestId('model-override-input'), { target: { value } })
  }

  beforeEach(() => {
    clearModelSelectCache()
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/api/providers/')) {
        return new Response(JSON.stringify({ models: [{ id: 'opus', label: 'opus' }], source: 'static' }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts the typed value on Set and refreshes on 200', async () => {
    render(<ModelOverrideEditor agentId="wk1" model={null} />)
    await typeModel('claude-opus-4')

    await act(async () => {
      fireEvent.click(screen.getByTestId('model-override-set'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agents/wk1/model',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ model: 'claude-opus-4', provider: 'claude_code' }) }),
    )
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('posts null on Clear and refreshes on 200', async () => {
    render(<ModelOverrideEditor agentId="wk1" model="claude-opus-4" />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('model-override-clear'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agents/wk1/model',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ model: null }) }),
    )
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('shows a 409 refusal inline without refreshing', async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'a model must be a non-empty text' }), { status: 409 }),
    )
    render(<ModelOverrideEditor agentId="wk1" model={null} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('model-override-set'))
    })

    expect(screen.getByRole('alert').textContent).toContain('a model must be a non-empty text')
    expect(routerRefresh).not.toHaveBeenCalled()
  })

  it('resyncs the select from a new model prop -- the post-refresh snapshot, not a stray edit', async () => {
    const { rerender } = render(<ModelOverrideEditor agentId="wk1" model="claude-opus-4" provider="claude_code" />)
    await waitForModelSelect()

    // A stray edit the caller never submitted (e.g. picked then navigated away without clicking
    // Set/Clear) must not survive the next snapshot arriving as a new `model` prop.
    fireEvent.change(screen.getByTestId('model-select'), { target: { value: 'opus' } })
    expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('opus')

    // Same instance (same agentId/key) re-rendered with a changed model, as router.refresh()
    // would do after a successful clear elsewhere.
    rerender(<ModelOverrideEditor agentId="wk1" model={null} provider="claude_code" />)

    expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('')
  })
})
