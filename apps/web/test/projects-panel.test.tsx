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

  // Fix round 1, Important finding 1: `Number('')` is `0`, so a cleared budget field with the
  // checkbox unchecked used to silently post `budgetUsd: 0` -- a real, strictest-possible ceiling
  // the operator never typed. The submit button disables and the form itself refuses to fetch.
  it('refuses a cleared budget field when "not budgeted" is unchecked', () => {
    vi.mocked(useRouter).mockReturnValue({ refresh: vi.fn(), push: vi.fn() } as never)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectsPanel />)
    fireEvent.change(screen.getByTestId('create-workspace-name'), { target: { value: 'Billing' } })
    fireEvent.change(screen.getByTestId('create-workspace-repo'), { target: { value: '/srv/billing' } })
    fireEvent.change(screen.getByTestId('create-workspace-verify'), { target: { value: 'npm test' } })
    fireEvent.change(screen.getByTestId('create-workspace-budget'), { target: { value: '' } })

    expect((screen.getByTestId('create-workspace-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(screen.getByTestId('create-workspace-form'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Fix round 1, Important finding 2: an uncaught fetch rejection used to leave `pending` true
  // forever (submit stuck disabled) and the error band blank.
  it('shows the error and re-enables the submit button when fetch rejects', async () => {
    vi.mocked(useRouter).mockReturnValue({ refresh: vi.fn(), push: vi.fn() } as never)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    render(<ProjectsPanel />)
    fireEvent.change(screen.getByTestId('create-workspace-name'), { target: { value: 'Billing' } })
    fireEvent.change(screen.getByTestId('create-workspace-repo'), { target: { value: '/srv/billing' } })
    fireEvent.change(screen.getByTestId('create-workspace-verify'), { target: { value: 'npm test' } })
    fireEvent.submit(screen.getByTestId('create-workspace-form'))

    expect((await screen.findByTestId('create-workspace-error')).textContent).toContain('network down')
    expect((screen.getByTestId('create-workspace-submit') as HTMLButtonElement).disabled).toBe(false)
  })

  // Fix round 1, Important finding 3: every other control surface routes a 401 to
  // `/login?next=<here>` (M20 spec §3.4, `sendControl`) -- this form dials `fetch` directly, so it
  // must call the same `onUnauthorized` by hand.
  it('routes a 401 to /login?next=<here>, the same as every other control surface', async () => {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { configurable: true, value: { assign, pathname: '/settings', search: '' } })
    vi.mocked(useRouter).mockReturnValue({ refresh: vi.fn(), push: vi.fn() } as never)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'authentication required' }), { status: 401 })))
    render(<ProjectsPanel />)
    fireEvent.change(screen.getByTestId('create-workspace-name'), { target: { value: 'Billing' } })
    fireEvent.change(screen.getByTestId('create-workspace-repo'), { target: { value: '/srv/billing' } })
    fireEvent.change(screen.getByTestId('create-workspace-verify'), { target: { value: 'npm test' } })
    fireEvent.submit(screen.getByTestId('create-workspace-form'))

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login?next=%2Fsettings'))
    vi.restoreAllMocks()
  })
})
