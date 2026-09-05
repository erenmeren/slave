// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewSlaveDrawer } from '../src/components/slaves/NewSlaveDrawer.js'
import { clearModelSelectCache } from '../src/components/ModelSelect.js'
import type { RosterCompany } from '../src/server/org.js'

const routerRefresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: routerRefresh }) }))

const companies = [{ id: 'c1', name: 'Atlas Software' }]
const roster: readonly RosterCompany[] = [
  { companyId: 'c1', companyName: 'Atlas Software', projectsUsing: 0, teams: [{ companyTeamId: 'ct1', teamName: 'Backend', members: [] }] },
]
const templates = [{ id: 'tpl1', name: 'Backend Developer', role: 'backend', description: '', defaultModel: null, defaultProvider: null }]
const workspaces = [{ id: 'w1', name: 'Checkout' }]

function drawer(onClose = vi.fn()): ReturnType<typeof render> {
  return render(<NewSlaveDrawer open onClose={onClose} companies={companies} roster={roster} templates={templates} workspaces={workspaces} />)
}

async function waitForModelSelect(): Promise<HTMLSelectElement> {
  return waitFor(() => {
    const select = screen.getByTestId('model-select') as HTMLSelectElement
    expect(select.disabled).toBe(false)
    return select
  })
}

async function fillCore(): Promise<void> {
  fireEvent.change(screen.getByTestId('new-slave-company'), { target: { value: 'c1' } })
  fireEvent.change(screen.getByTestId('new-slave-department'), { target: { value: 'ct1' } })
  fireEvent.change(screen.getByTestId('new-slave-template'), { target: { value: 'tpl1' } })
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

  it('posts the catalog slave and closes when no project is chosen', async () => {
    const onClose = vi.fn()
    drawer(onClose)
    await fillCore()
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-slave-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/slaves', expect.objectContaining({ method: 'POST', body: JSON.stringify({ companyTeamId: 'ct1', templateId: 'tpl1', name: 'Sam' }) }))
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/company'))).toBe(false)
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
    expect(fetchMock).toHaveBeenCalledWith('/api/org/slaves', expect.objectContaining({ body: JSON.stringify({ companyTeamId: 'ct1', templateId: 'tpl1', name: 'Sam', model: 'opus', provider: 'claude_code' }) }))
  })

  it('then assigns the company to the chosen project', async () => {
    drawer()
    await fillCore()
    fireEvent.change(screen.getByTestId('new-slave-project'), { target: { value: 'w1' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-slave-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/company', expect.objectContaining({ method: 'POST', body: JSON.stringify({ companyId: 'c1' }) }))
  })

  it('keeps the drawer open with the second step\'s refusal when assign is refused', async () => {
    const onClose = vi.fn()
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/company')
        ? new Response(JSON.stringify({ error: 'a budget needs a provider that reports cost' }), { status: 409 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    drawer(onClose)
    await fillCore()
    fireEvent.change(screen.getByTestId('new-slave-project'), { target: { value: 'w1' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-slave-submit'))
    })
    expect(screen.getByTestId('new-slave-error').textContent).toContain('reports cost')
    expect(screen.getByText(/catalog slave created; assign from the project card/)).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()

    // Fix round 1, Finding 1: the catalog row already exists -- a resubmission must not
    // re-POST /api/org/slaves (it would hit `duplicate_name`, masking the real retry).
    // `getAttribute('disabled')` rather than jest-dom's `toBeDisabled` -- this repo's vitest
    // setup carries no jest-dom matchers (`project-settings.test.tsx` notes the same).
    const slaveCallsSoFar = fetchMock.mock.calls.filter(([url]) => url === '/api/org/slaves').length
    expect((screen.getByTestId('new-slave-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('new-slave-submit'))
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/org/slaves')).toHaveLength(slaveCallsSoFar)
  })

  // M25 final review, item C: a realistic second-step refusal, not a stand-in string --
  // `workspaceControlRoute.ts` answers `{ error: refusalText(result.error) }`, and
  // `refusalText`'s real `company_already_assigned` wording (`packages/control/src/refusal.ts`)
  // is "this workspace is already run by <companyName>", not the drawer's own copy for anything.
  it('shows the real company_already_assigned wording when the second step is refused', async () => {
    const onClose = vi.fn()
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/company')
        ? new Response(JSON.stringify({ error: 'this workspace is already run by Atlas Software' }), { status: 409 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    drawer(onClose)
    await fillCore()
    fireEvent.change(screen.getByTestId('new-slave-project'), { target: { value: 'w1' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-slave-submit'))
    })

    expect(screen.getByTestId('new-slave-error').textContent).toBe('this workspace is already run by Atlas Software')
    expect(screen.getByText(/catalog slave created; assign from the project card/)).toBeTruthy()
    expect((screen.getByTestId('new-slave-submit') as HTMLButtonElement).disabled).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
  })

  // Fix round 1, Finding 1: `SlavesClient` renders this drawer unconditionally (`!open` returns
  // `null`, it never unmounts), so its form state must be reset on a full success -- otherwise a
  // second "New slave" carries the last submission's values.
  it('reopening after a success shows an empty form', async () => {
    const { rerender } = drawer()
    await fillCore()
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-slave-submit'))
    })
    rerender(<NewSlaveDrawer open={false} onClose={vi.fn()} companies={companies} roster={roster} templates={templates} workspaces={workspaces} />)
    rerender(<NewSlaveDrawer open onClose={vi.fn()} companies={companies} roster={roster} templates={templates} workspaces={workspaces} />)
    expect((screen.getByTestId('new-slave-name') as HTMLInputElement).value).toBe('')
  })

  it('"new department…" creates the template first, then the slave in it', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url) === '/api/org/teams'
        ? new Response(JSON.stringify({ ok: true, id: 'ct9' }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    drawer()
    fireEvent.change(screen.getByTestId('new-slave-company'), { target: { value: 'c1' } })
    fireEvent.change(screen.getByTestId('new-slave-department'), { target: { value: '__new__' } })
    fireEvent.change(screen.getByTestId('new-slave-department-name'), { target: { value: 'Design' } })
    fireEvent.change(screen.getByTestId('new-slave-template'), { target: { value: 'tpl1' } })
    fireEvent.change(screen.getByTestId('new-slave-name'), { target: { value: 'Sam' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-slave-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/teams', expect.objectContaining({ body: JSON.stringify({ companyId: 'c1', name: 'Design' }) }))
    expect(fetchMock).toHaveBeenCalledWith('/api/org/slaves', expect.objectContaining({ body: JSON.stringify({ companyTeamId: 'ct9', templateId: 'tpl1', name: 'Sam' }) }))
  })

  // Fix round 1, Finding 2: the department create succeeded even though the slave step after it
  // was refused -- a retry must address the real id, not resubmit `__new__` (which would hit
  // `duplicate_name` at the team step), and the drawer must say the department now exists.
  it('"new department…" then a refused slave keeps the created department and lets a retry use its id', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url) === '/api/org/teams'
        ? new Response(JSON.stringify({ ok: true, id: 'ct9' }), { status: 200 })
        : String(url) === '/api/org/slaves'
          ? new Response(JSON.stringify({ error: 'the name "Sam" is already taken' }), { status: 409 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    drawer()
    fireEvent.change(screen.getByTestId('new-slave-company'), { target: { value: 'c1' } })
    fireEvent.change(screen.getByTestId('new-slave-department'), { target: { value: '__new__' } })
    fireEvent.change(screen.getByTestId('new-slave-department-name'), { target: { value: 'Design' } })
    fireEvent.change(screen.getByTestId('new-slave-template'), { target: { value: 'tpl1' } })
    fireEvent.change(screen.getByTestId('new-slave-name'), { target: { value: 'Sam' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-slave-submit'))
    })

    expect(screen.getByTestId('new-slave-note').textContent).toBe('department template created; the slave was refused')
    expect((screen.getByTestId('new-slave-department') as HTMLSelectElement).value).toBe('ct9')

    const teamCallsSoFar = fetchMock.mock.calls.filter(([url]) => url === '/api/org/teams').length
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-slave-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/slaves', expect.objectContaining({ body: JSON.stringify({ companyTeamId: 'ct9', templateId: 'tpl1', name: 'Sam' }) }))
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/org/teams')).toHaveLength(teamCallsSoFar)
  })

  it('closes on Escape and on the close button', () => {
    const onClose = vi.fn()
    drawer(onClose)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('new-slave-close'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  // Folded minor (M25 final review): while a submit is in flight, the scrim, the ✕ button and
  // Escape must not tear the drawer down out from under it -- a deferred fetch stands in for a
  // submit that has not resolved yet.
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
    fireEvent.click(screen.getByTestId('new-slave-scrim'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      resolveSlave(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      await deferred
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
