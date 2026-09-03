// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRouter } from 'next/navigation'
import { ProjectsPanel } from '../src/components/ProjectsPanel.js'

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ProjectsPanel', () => {
  it('posts the form as arrays and navigates to the new workspace', async () => {
    const push = vi.fn()
    vi.mocked(useRouter).mockReturnValue({ refresh: vi.fn(), push } as never)
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, id: 'ws-9' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectsPanel />)
    fireEvent.change(screen.getByTestId('create-workspace-name'), { target: { value: 'Billing' } })
    fireEvent.change(screen.getByTestId('create-workspace-repo'), { target: { value: '/srv/billing' } })
    fireEvent.change(screen.getByTestId('create-workspace-verify'), { target: { value: 'npm test\n\nnpm run lint\n' } })
    fireEvent.submit(screen.getByTestId('create-workspace-form'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)
    expect(body).toEqual({
      name: 'Billing',
      repoPath: '/srv/billing',
      baseBranch: 'main',
      verifyCommands: ['npm test', 'npm run lint'],
      setupCommands: [],
      budgetUsd: 20,
      provider: null,
    })
    await waitFor(() => expect(push).toHaveBeenCalledWith('/w/ws-9'))
  })

  it('shows a refusal in the alert band', async () => {
    vi.mocked(useRouter).mockReturnValue({ refresh: vi.fn(), push: vi.fn() } as never)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'no directory at /nope' }), { status: 409 })))
    render(<ProjectsPanel />)
    fireEvent.change(screen.getByTestId('create-workspace-name'), { target: { value: 'X' } })
    fireEvent.change(screen.getByTestId('create-workspace-repo'), { target: { value: '/nope' } })
    fireEvent.change(screen.getByTestId('create-workspace-verify'), { target: { value: 'true' } })
    fireEvent.submit(screen.getByTestId('create-workspace-form'))
    // `.textContent` rather than jest-dom's `toHaveTextContent` -- this repo's vitest setup
    // carries no jest-dom matchers (`runtime-card.test.tsx`, `skills-page.test.tsx` note the same).
    expect((await screen.findByTestId('create-workspace-error')).textContent).toContain('no directory at /nope')
  })
})
