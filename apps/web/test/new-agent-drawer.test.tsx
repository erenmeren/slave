// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewAgentDrawer } from '../src/components/agents/NewAgentDrawer.js'
import { clearModelSelectCache } from '../src/components/ModelSelect.js'
import type { RosterCompany } from '../src/server/org.js'

const routerRefresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: routerRefresh }) }))

const companies = [{ id: 'c1', name: 'Atlas Software' }]
const roster: readonly RosterCompany[] = [
  { companyId: 'c1', companyName: 'Atlas Software', teams: [{ companyTeamId: 'ct1', teamName: 'Backend', members: [] }] },
]
const templates = [{ id: 'tpl1', name: 'Backend Developer', role: 'backend', description: '', defaultModel: null, defaultProvider: null }]
const workspaces = [{ id: 'w1', name: 'Checkout' }]

function drawer(onClose = vi.fn()): ReturnType<typeof render> {
  return render(<NewAgentDrawer open onClose={onClose} companies={companies} roster={roster} templates={templates} workspaces={workspaces} />)
}

async function fillCore(): Promise<void> {
  fireEvent.change(screen.getByTestId('new-agent-company'), { target: { value: 'c1' } })
  fireEvent.change(screen.getByTestId('new-agent-department'), { target: { value: 'ct1' } })
  fireEvent.change(screen.getByTestId('new-agent-template'), { target: { value: 'tpl1' } })
  fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'Sam' } })
}

describe('NewAgentDrawer', () => {
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

  it('posts the catalog agent and closes when no project is chosen', async () => {
    const onClose = vi.fn()
    drawer(onClose)
    await fillCore()
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-agent-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/agents', expect.objectContaining({ method: 'POST', body: JSON.stringify({ companyTeamId: 'ct1', templateId: 'tpl1', name: 'Sam' }) }))
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/company'))).toBe(false)
    expect(onClose).toHaveBeenCalled()
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('sends model+provider when both are chosen', async () => {
    drawer()
    await fillCore()
    fireEvent.change(screen.getByTestId('new-agent-provider'), { target: { value: 'claude_code' } })
    await waitFor(() => expect(screen.getByTestId('model-select')).toBeTruthy())
    fireEvent.change(screen.getByTestId('model-select'), { target: { value: 'opus' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-agent-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/agents', expect.objectContaining({ body: JSON.stringify({ companyTeamId: 'ct1', templateId: 'tpl1', name: 'Sam', model: 'opus', provider: 'claude_code' }) }))
  })

  it('then assigns the company to the chosen project', async () => {
    drawer()
    await fillCore()
    fireEvent.change(screen.getByTestId('new-agent-project'), { target: { value: 'w1' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-agent-submit'))
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
    fireEvent.change(screen.getByTestId('new-agent-project'), { target: { value: 'w1' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-agent-submit'))
    })
    expect(screen.getByTestId('new-agent-error').textContent).toContain('reports cost')
    expect(screen.getByText(/catalog agent created; assign from the project card/)).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('"new department…" creates the template first, then the agent in it', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url) === '/api/org/teams'
        ? new Response(JSON.stringify({ ok: true, id: 'ct9' }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    drawer()
    fireEvent.change(screen.getByTestId('new-agent-company'), { target: { value: 'c1' } })
    fireEvent.change(screen.getByTestId('new-agent-department'), { target: { value: '__new__' } })
    fireEvent.change(screen.getByTestId('new-agent-department-name'), { target: { value: 'Design' } })
    fireEvent.change(screen.getByTestId('new-agent-template'), { target: { value: 'tpl1' } })
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'Sam' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-agent-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/teams', expect.objectContaining({ body: JSON.stringify({ companyId: 'c1', name: 'Design' }) }))
    expect(fetchMock).toHaveBeenCalledWith('/api/org/agents', expect.objectContaining({ body: JSON.stringify({ companyTeamId: 'ct9', templateId: 'tpl1', name: 'Sam' }) }))
  })

  it('closes on Escape and on the close button', () => {
    const onClose = vi.fn()
    drawer(onClose)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('new-agent-close'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
