// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelOverrideEditor } from '../src/components/ModelOverrideEditor.js'

const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}))

afterEach(() => {
  routerRefresh.mockClear()
})

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

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts the typed value on Set and refreshes on 200', async () => {
    render(<ModelOverrideEditor agentId="wk1" model={null} />)
    fireEvent.change(screen.getByTestId('model-override-input'), { target: { value: 'claude-opus-4' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('model-override-set'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agents/wk1/model',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ model: 'claude-opus-4' }) }),
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

  it('resyncs the input from a new model prop -- the post-refresh snapshot, not a stray edit', () => {
    const { rerender } = render(<ModelOverrideEditor agentId="wk1" model="claude-opus-4" />)
    // A stray edit the caller never submitted (e.g. typed then navigated away without clicking
    // Set/Clear) must not survive the next snapshot arriving as a new `model` prop.
    fireEvent.change(screen.getByTestId('model-override-input'), { target: { value: 'not submitted' } })
    expect((screen.getByTestId('model-override-input') as HTMLInputElement).value).toBe('not submitted')

    // Same instance (same agentId/key) re-rendered with a changed model, as router.refresh()
    // would do after a successful clear elsewhere.
    rerender(<ModelOverrideEditor agentId="wk1" model={null} />)

    expect((screen.getByTestId('model-override-input') as HTMLInputElement).value).toBe('')
  })
})
