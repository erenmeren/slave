// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReposRootField } from '../src/components/SettingsClient.js'

describe('the Repositories section', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows the resolved folder and where it came from', () => {
    render(<ReposRootField initial={{ reposRoot: null, resolved: '/home/me/projects', source: 'default' }} />)
    expect((screen.getByTestId('settings-repos-root') as HTMLInputElement).value).toBe('')
    expect(screen.getByTestId('settings-repos-root-source').textContent).toContain('default')
  })

  it('names the environment variable when that is where the value came from', () => {
    render(<ReposRootField initial={{ reposRoot: null, resolved: '/srv/repos', source: 'env' }} />)
    expect(screen.getByTestId('settings-repos-root-source').textContent).toContain('SLAVEOFAI_REPOS')
  })

  it('saves a folder and shows the new source', async (): Promise<void> => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, reposRoot: '/home/me/code' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ReposRootField initial={{ reposRoot: null, resolved: '/home/me/projects', source: 'default' }} />)
    fireEvent.change(screen.getByTestId('settings-repos-root'), { target: { value: '/home/me/code' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-repos-root-save'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/installation', expect.objectContaining({ method: 'POST' }))
    await waitFor(() => expect(screen.getByTestId('settings-repos-root-source').textContent).toContain('Settings'))
  })

  it('shows the refusal rather than pretending it saved', async (): Promise<void> => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'the repositories folder must be an absolute path: code' }), { status: 409 })),
    )
    render(<ReposRootField initial={{ reposRoot: null, resolved: '/home/me/projects', source: 'default' }} />)
    fireEvent.change(screen.getByTestId('settings-repos-root'), { target: { value: 'code' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-repos-root-save'))
    })
    await waitFor(() => expect(screen.getByTestId('settings-repos-root-error').textContent).toContain('absolute'))
  })
})
