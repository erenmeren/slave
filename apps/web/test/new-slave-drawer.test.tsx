// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewSlaveDrawer } from '../src/components/slaves/NewSlaveDrawer.js'
import { clearModelSelectCache } from '../src/components/ModelSelect.js'
import type { RosterCompany } from '../src/server/org.js'

const routerRefresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: routerRefresh }) }))

const roster: readonly RosterCompany[] = [
  { companyId: 'c1', companyName: 'Atlas Software', projectsUsing: 0, teams: [{ companyTeamId: 'ct1', teamName: 'Backend', members: [] }] },
]
const templates = [
  { id: 'tpl1', name: 'Backend Developer', role: 'backend', description: '', defaultModel: null, defaultProvider: null, catalogSlaveCount: 0 },
]
const teams = [{ teamId: 'tm1', name: 'Engineering', workspaceId: 'w1', projectName: 'Checkout' }]

function drawer(onClose = vi.fn(), extra: Partial<React.ComponentProps<typeof NewSlaveDrawer>> = {}): ReturnType<typeof render> {
  return render(<NewSlaveDrawer open onClose={onClose} roster={roster} templates={templates} teams={teams} {...extra} />)
}

async function waitForModelSelect(): Promise<HTMLSelectElement> {
  return waitFor(() => {
    const select = screen.getByTestId('model-select') as HTMLSelectElement
    expect(select.disabled).toBe(false)
    return select
  })
}

async function fillCore(): Promise<void> {
  fireEvent.change(screen.getByTestId('new-slave-persona'), { target: { value: 'tpl1' } })
  fireEvent.change(screen.getByTestId('new-slave-name'), { target: { value: 'Sam' } })
}

describe('NewSlaveDrawer', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    clearModelSelectCache()
    routerRefresh.mockClear()
    fetchMock = vi.fn(async (url: string) =>
      url.startsWith('/api/providers/')
        ? new Response(JSON.stringify({ models: [{ id: 'opus', label: 'opus' }], source: 'static' }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('posts the slave and closes when no project is chosen', async () => {
    const onClose = vi.fn()
    drawer(onClose)
    await fillCore()
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-slave-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/slaves', expect.objectContaining({ method: 'POST', body: JSON.stringify({ templateId: 'tpl1', name: 'Sam' }) }))
    expect(onClose).toHaveBeenCalled()
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('sends model+provider when both are chosen', async () => {
    drawer()
    await fillCore()
    fireEvent.change(screen.getByTestId('new-slave-provider'), { target: { value: 'claude_code' } })
    await waitForModelSelect()
    fireEvent.change(screen.getByTestId('model-select'), { target: { value: 'opus' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-slave-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/slaves', expect.objectContaining({ body: JSON.stringify({ templateId: 'tpl1', name: 'Sam', provider: 'claude_code', model: 'opus' }) }))
  })

  it('includes the chosen department and project team in the one POST', async () => {
    drawer()
    await fillCore()
    fireEvent.change(screen.getByTestId('new-slave-department'), { target: { value: 'ct1' } })
    fireEvent.change(screen.getByTestId('new-slave-project'), { target: { value: 'tm1' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-slave-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/org/slaves',
      expect.objectContaining({ body: JSON.stringify({ templateId: 'tpl1', name: 'Sam', companyTeamId: 'ct1', teamId: 'tm1' }) }),
    )
  })

  it('keeps the drawer open with the refusal', async () => {
    const onClose = vi.fn()
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/org/slaves'
        ? new Response(JSON.stringify({ error: 'a slave needs a name, or a persona to take one from' }), { status: 400 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    drawer(onClose)
    await fillCore()
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-slave-submit'))
    })
    expect(screen.getByTestId('new-slave-error').textContent).toContain('a slave needs a name')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('reopening after a success shows an empty form', async () => {
    const { rerender } = drawer()
    await fillCore()
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-slave-submit'))
    })
    rerender(<NewSlaveDrawer open={false} onClose={vi.fn()} roster={roster} templates={templates} teams={teams} />)
    rerender(<NewSlaveDrawer open onClose={vi.fn()} roster={roster} templates={templates} teams={teams} />)
    expect((screen.getByTestId('new-slave-name') as HTMLInputElement).value).toBe('')
  })

  it('says they land in the pool until a department or project is picked', () => {
    drawer()
    expect(screen.getByTestId('new-slave-pool-note').textContent).toMatch(/lands in the pool/)
    fireEvent.change(screen.getByTestId('new-slave-department'), { target: { value: 'ct1' } })
    expect(screen.getByTestId('new-slave-pool-note').textContent).toMatch(/put to work/)
  })

  it('starts the project select on defaultTeamId when opened from inside a project', () => {
    drawer(vi.fn(), { defaultTeamId: 'tm1' })
    expect((screen.getByTestId('new-slave-project') as HTMLSelectElement).value).toBe('tm1')
    expect(screen.getByTestId('new-slave-pool-note').textContent).toMatch(/put to work/)
  })

  it('a persona or a name is enough to submit', () => {
    drawer()
    expect((screen.getByTestId('new-slave-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('new-slave-name'), { target: { value: 'Sam' } })
    expect((screen.getByTestId('new-slave-submit') as HTMLButtonElement).disabled).toBe(false)
  })

  it('closes on Escape and on the close button', () => {
    const onClose = vi.fn()
    drawer(onClose)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('new-slave-close'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('closes on its scrim and on Escape, through the shared drawer frame (M44 R3)', () => {
    const onScrim = vi.fn()
    const { unmount } = drawer(onScrim)
    expect(screen.getByTestId('new-slave-drawer').getAttribute('aria-modal')).toBe('true')
    fireEvent.click(screen.getByTestId('new-slave-drawer-scrim'))
    expect(onScrim).toHaveBeenCalledTimes(1)
    unmount()

    const onEscape = vi.fn()
    drawer(onEscape)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('ignores the ✕ button, the scrim and Escape while a submit is pending, then closes once it resolves', async () => {
    const onClose = vi.fn()
    let resolveSlave: (value: Response) => void = () => {}
    const deferred = new Promise<Response>((resolve) => {
      resolveSlave = resolve
    })
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/org/slaves' ? deferred : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    drawer(onClose)
    await fillCore()

    fireEvent.click(screen.getByTestId('new-slave-submit'))
    await waitFor(() => expect((screen.getByTestId('new-slave-submit') as HTMLButtonElement).disabled).toBe(true))

    fireEvent.click(screen.getByTestId('new-slave-close'))
    fireEvent.click(screen.getByTestId('new-slave-drawer-scrim'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      resolveSlave(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      await deferred
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
