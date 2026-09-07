// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulationsClient } from '../src/components/sim/SimulationsClient.js'
import { clearModelSelectCache } from '../src/components/ModelSelect.js'
import type { SimulationSummary } from '@slave-of-ai/control'
import { sectors } from '@slave-of-ai/simulation'

const routerPush = vi.fn()
const routerRefresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPush, refresh: routerRefresh }), usePathname: () => '/sim' }))

const card = (over: Partial<SimulationSummary> = {}): SimulationSummary => ({
  id: 's1', companyId: 'c1', companyName: 'Demo Trading Co.', name: 'Q3 plan', sector: 'trade', mode: 'simulation', decisionProvider: 'rules', modelProvider: null, model: null, maxModelCostUsd: null, llmRoles: [], policy: 'A',
  status: 'running', simTime: 4, horizonDays: 30, stepCount: 4, actionCount: 16, version: 2, haltedReason: null, createdAt: '2026-09-06T00:00:00.000Z', synthetic: true, autoRun: null, clonedFromId: null, clonedFromName: null, ...over,
})
// M31b Task 4: the company list is filtered SERVER-side per sector (`companiesForSector`), so the
// fixture already carries only companies that fit -- there is no "offered but marked" roster any
// more; a sector with nothing that fits shows an empty list (`software` here) and the drawer names
// why (`sectors.software.rosterRequirement`).
const companiesBySector = { trade: [{ id: 'c1', name: 'Demo Trading Co.', slaves: 4 }], software: [] }

beforeEach(() => { routerPush.mockClear(); routerRefresh.mockClear(); clearModelSelectCache() })
afterEach(() => vi.unstubAllGlobals())

async function waitForModelSelect(): Promise<HTMLSelectElement> {
  return waitFor(() => {
    const select = screen.getByTestId('model-select') as HTMLSelectElement
    expect(select.disabled).toBe(false)
    return select
  })
}

describe('SimulationsClient', () => {
  it('lists every run as a card with the SIMULATION chip, sector, policy, day and status, and opens it on click', () => {
    render(<SimulationsClient cards={[card(), card({ id: 's2', name: 'hedged', policy: 'B', status: 'finished', simTime: 30 })]} companiesBySector={companiesBySector} />)
    const first = screen.getByTestId('sim-card-s1')
    expect(first.textContent).toContain('SIMULATION')
    expect(first.textContent).toContain('trade')
    expect(within(first).getByTestId('sim-sector-chip').textContent).toBe('trade')
    expect(first.textContent).toContain('policy A')
    expect(first.textContent).toContain('day 4 / 30')
    expect(first.textContent).toContain('running')
    expect(first.textContent).toContain('rules provider')
    fireEvent.click(within(first).getByRole('button'))
    expect(routerPush).toHaveBeenCalledWith('/sim/s1')
    expect(screen.getAllByTestId('sim-card')).toHaveLength(2)
  })
  it('the drawer has sector, company, name, policy and seed — no repository, branch or verify field — and posts to /api/sim with the sector', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: 's9' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<SimulationsClient cards={[]} companiesBySector={companiesBySector} />)
    fireEvent.click(screen.getByTestId('new-simulation'))
    const drawer = screen.getByTestId('new-simulation-drawer')
    expect(drawer.textContent).not.toMatch(/repo|branch|verify/i)
    expect(drawer.textContent).toContain('synthetic')
    // The sector select defaults to 'trade' and its options are the registry's own keys.
    const sectorSelect = screen.getByTestId('new-simulation-sector') as HTMLSelectElement
    expect(sectorSelect.value).toBe('trade')
    expect([...sectorSelect.querySelectorAll('option')].map((o) => o.value)).toEqual(['trade', 'software'])
    fireEvent.change(screen.getByTestId('new-simulation-company'), { target: { value: 'c1' } })
    fireEvent.change(screen.getByTestId('new-simulation-name'), { target: { value: 'Q4' } })
    fireEvent.change(screen.getByTestId('new-simulation-policy'), { target: { value: 'B' } })
    fireEvent.change(screen.getByTestId('new-simulation-seed'), { target: { value: '7' } })
    await act(async () => { fireEvent.click(screen.getByTestId('new-simulation-submit')) })
    expect(fetchMock).toHaveBeenCalledWith('/api/sim', expect.objectContaining({ method: 'POST', body: JSON.stringify({ companyId: 'c1', name: 'Q4', policy: 'B', sector: 'trade', seed: 7 }) }))
    expect(routerPush).toHaveBeenCalledWith('/sim/s9')
  })
  it('the company list is per sector (server-filtered); a sector with nothing that fits shows its own rosterRequirement and disables submit', async () => {
    render(<SimulationsClient cards={[]} companiesBySector={companiesBySector} />)
    fireEvent.click(screen.getByTestId('new-simulation'))
    // trade has one fitting company (from companiesBySector) — no hint, and it is selectable.
    expect(screen.queryByTestId('new-simulation-roster-hint')).toBeNull()
    expect(screen.getByTestId('new-simulation-company').querySelector('option[value="c1"]')?.textContent).toContain('4 slaves')
    // software's list is empty (nothing in the catalog fits it yet) — the sector's own
    // rosterRequirement explains why, and the create button stays disabled (no company chosen).
    fireEvent.change(screen.getByTestId('new-simulation-sector'), { target: { value: 'software' } })
    expect(screen.getByTestId('new-simulation-company').querySelectorAll('option')).toHaveLength(1) // "select a company" only
    expect(screen.getByTestId('new-simulation-roster-hint').textContent).toContain('the software sector needs')
    fireEvent.change(screen.getByTestId('new-simulation-name'), { target: { value: 'x' } })
    expect((screen.getByTestId('new-simulation-submit') as HTMLButtonElement).disabled).toBe(true)
  })
  it('the policy options are the CHOSEN sector\'s own prose, and change with the sector (final fix wave)', () => {
    render(<SimulationsClient cards={[]} companiesBySector={companiesBySector} />)
    fireEvent.click(screen.getByTestId('new-simulation'))
    const options = (): (string | null)[] => [...screen.getByTestId('new-simulation-policy').querySelectorAll('option')].map((o) => o.textContent)
    expect(options()).toEqual([sectors.trade.policyLabels.A, sectors.trade.policyLabels.B])
    expect(options()[0]).toContain('normal supplier')
    fireEvent.change(screen.getByTestId('new-simulation-sector'), { target: { value: 'software' } })
    expect(options()).toEqual([sectors.software.policyLabels.A, sectors.software.policyLabels.B])
    expect(options().join(' ')).not.toMatch(/supplier/i)
  })
  it('a 409 refusal from the server stays in the drawer with the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'a simulation named "x" already exists' }), { status: 409 })))
    render(<SimulationsClient cards={[]} companiesBySector={companiesBySector} />)
    fireEvent.click(screen.getByTestId('new-simulation'))
    fireEvent.change(screen.getByTestId('new-simulation-company'), { target: { value: 'c1' } })
    fireEvent.change(screen.getByTestId('new-simulation-name'), { target: { value: 'x' } })
    await act(async () => { fireEvent.click(screen.getByTestId('new-simulation-submit')) })
    expect(screen.getByTestId('new-simulation-error').textContent).toContain('already exists')
    expect(screen.getByTestId('new-simulation-drawer')).toBeTruthy()
  })
  it('a card cloned from another run shows "clone of <name>"', () => {
    render(<SimulationsClient cards={[card({ clonedFromId: 's0', clonedFromName: 'Q3 plan' })]} companiesBySector={companiesBySector} />)
    expect(screen.getByTestId('sim-card-s1').textContent).toContain('clone of Q3 plan')
  })
  it('a card with autoRun set shows the auto-run chip', () => {
    render(<SimulationsClient cards={[card({ autoRun: { everyMs: 1000, untilDay: 30, lastStepAt: null } })]} companiesBySector={companiesBySector} />)
    expect(screen.getByTestId('sim-card-s1').textContent).toContain('auto-run')
  })
  it('an empty list says so, sector-neutrally (review round 1, Minor #2: no "trade sector" text)', () => {
    render(<SimulationsClient cards={[]} companiesBySector={companiesBySector} />)
    const text = screen.getByTestId('sim-empty').textContent ?? ''
    expect(text).toContain('No simulations yet')
    expect(text).not.toMatch(/trade/i)
  })
  it('a card with decisionProvider llm shows an llm chip', () => {
    render(<SimulationsClient cards={[card({ decisionProvider: 'llm', modelProvider: 'claude_code', model: 'sonnet', maxModelCostUsd: 2, llmRoles: ['purchasing'] })]} companiesBySector={companiesBySector} />)
    const first = within(screen.getByTestId('sim-card-s1'))
    expect(first.getByText('llm')).toBeTruthy()
  })
  it('the provider select defaults to rules and hides the llm fields', () => {
    render(<SimulationsClient cards={[]} companiesBySector={companiesBySector} />)
    fireEvent.click(screen.getByTestId('new-simulation'))
    expect((screen.getByTestId('new-simulation-provider') as HTMLSelectElement).value).toBe('rules')
    expect(screen.queryByTestId('new-simulation-model')).toBeNull()
    expect(screen.queryByTestId('new-simulation-cap')).toBeNull()
    expect(screen.queryByTestId('new-simulation-consent')).toBeNull()
  })
  it('choosing llm reveals the model, cap and consent fields; submit is disabled until consent is checked; the body carries the llm fields', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith('/api/providers/')
        ? new Response(JSON.stringify({ models: [{ id: 'claude-sonnet-4-5', label: 'sonnet' }], source: 'static' }), { status: 200 })
        : new Response(JSON.stringify({ ok: true, id: 's9' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<SimulationsClient cards={[]} companiesBySector={companiesBySector} />)
    fireEvent.click(screen.getByTestId('new-simulation'))
    fireEvent.change(screen.getByTestId('new-simulation-company'), { target: { value: 'c1' } })
    fireEvent.change(screen.getByTestId('new-simulation-name'), { target: { value: 'Q4' } })
    fireEvent.change(screen.getByTestId('new-simulation-provider'), { target: { value: 'llm' } })
    expect(screen.getByTestId('new-simulation-drawer').textContent).toContain('paid model calls')
    expect((screen.getByTestId('new-simulation-cap') as HTMLInputElement).value).toBe('2.00')
    await waitForModelSelect()
    fireEvent.change(screen.getByTestId('model-select'), { target: { value: 'claude-sonnet-4-5' } })
    expect((screen.getByTestId('new-simulation-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('new-simulation-consent'))
    expect((screen.getByTestId('new-simulation-submit') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { fireEvent.click(screen.getByTestId('new-simulation-submit')) })
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/sim')
    expect(call).toBeDefined()
    const body = JSON.parse(String((call as unknown as [string, RequestInit])[1].body))
    expect(body).toMatchObject({ companyId: 'c1', name: 'Q4', policy: 'A', decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-sonnet-4-5', maxModelCostUsd: 2 })
    expect(routerPush).toHaveBeenCalledWith('/sim/s9')
  })
  it('a 400 refusal for a missing cap lands in the drawer error', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith('/api/providers/')
        ? new Response(JSON.stringify({ models: [{ id: 'claude-sonnet-4-5', label: 'sonnet' }], source: 'static' }), { status: 200 })
        : new Response(JSON.stringify({ error: 'invalid simulation input: maxModelCostUsd must be a positive number' }), { status: 400 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<SimulationsClient cards={[]} companiesBySector={companiesBySector} />)
    fireEvent.click(screen.getByTestId('new-simulation'))
    fireEvent.change(screen.getByTestId('new-simulation-company'), { target: { value: 'c1' } })
    fireEvent.change(screen.getByTestId('new-simulation-name'), { target: { value: 'Q4' } })
    fireEvent.change(screen.getByTestId('new-simulation-provider'), { target: { value: 'llm' } })
    await waitForModelSelect()
    fireEvent.change(screen.getByTestId('model-select'), { target: { value: 'claude-sonnet-4-5' } })
    fireEvent.click(screen.getByTestId('new-simulation-consent'))
    await act(async () => { fireEvent.click(screen.getByTestId('new-simulation-submit')) })
    expect(screen.getByTestId('new-simulation-error').textContent).toContain('maxModelCostUsd must be a positive number')
  })
})
