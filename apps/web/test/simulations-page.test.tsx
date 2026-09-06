// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulationsClient } from '../src/components/sim/SimulationsClient.js'
import type { SimulationSummary } from '@slave-of-ai/control'

const routerPush = vi.fn()
const routerRefresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPush, refresh: routerRefresh }), usePathname: () => '/sim' }))

const card = (over: Partial<SimulationSummary> = {}): SimulationSummary => ({
  id: 's1', companyId: 'c1', companyName: 'Demo Trading Co.', name: 'Q3 plan', sector: 'trade', mode: 'simulation', decisionProvider: 'rules', policy: 'A',
  status: 'running', simTime: 4, horizonDays: 30, stepCount: 4, decisionCount: 16, version: 2, haltedReason: null, createdAt: '2026-09-06T00:00:00.000Z', synthetic: true, ...over,
})
const companies = [{ id: 'c1', name: 'Demo Trading Co.', slaves: 4 }, { id: 'c2', name: 'Tiny', slaves: 1 }]

beforeEach(() => { routerPush.mockClear(); routerRefresh.mockClear() })
afterEach(() => vi.unstubAllGlobals())

describe('SimulationsClient', () => {
  it('lists every run as a card with the SIMULATION chip, sector, policy, day and status, and opens it on click', () => {
    render(<SimulationsClient cards={[card(), card({ id: 's2', name: 'hedged', policy: 'B', status: 'finished', simTime: 30 })]} companies={companies} />)
    const first = screen.getByTestId('sim-card-s1')
    expect(first.textContent).toContain('SIMULATION')
    expect(first.textContent).toContain('trade')
    expect(first.textContent).toContain('policy A')
    expect(first.textContent).toContain('day 4 / 30')
    expect(first.textContent).toContain('running')
    expect(first.textContent).toContain('rules provider')
    fireEvent.click(first)
    expect(routerPush).toHaveBeenCalledWith('/sim/s1')
    expect(screen.getAllByTestId('sim-card')).toHaveLength(2)
  })
  it('the drawer has company, name, policy and seed — no repository, branch or verify field — and posts to /api/sim', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: 's9' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<SimulationsClient cards={[]} companies={companies} />)
    fireEvent.click(screen.getByTestId('new-simulation'))
    const drawer = screen.getByTestId('new-simulation-drawer')
    expect(drawer.textContent).not.toMatch(/repo|branch|verify/i)
    expect(drawer.textContent).toContain('synthetic')
    fireEvent.change(screen.getByTestId('new-simulation-company'), { target: { value: 'c1' } })
    fireEvent.change(screen.getByTestId('new-simulation-name'), { target: { value: 'Q4' } })
    fireEvent.change(screen.getByTestId('new-simulation-policy'), { target: { value: 'B' } })
    fireEvent.change(screen.getByTestId('new-simulation-seed'), { target: { value: '7' } })
    await act(async () => { fireEvent.click(screen.getByTestId('new-simulation-submit')) })
    expect(fetchMock).toHaveBeenCalledWith('/api/sim', expect.objectContaining({ method: 'POST', body: JSON.stringify({ companyId: 'c1', name: 'Q4', policy: 'B', seed: 7 }) }))
    expect(routerPush).toHaveBeenCalledWith('/sim/s9')
  })
  it('a company with fewer than four slaves is offered but marked, and a refusal stays in the drawer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'company c2 has 1 slave; the trade sector needs 4 for its roles' }), { status: 409 })))
    render(<SimulationsClient cards={[]} companies={companies} />)
    fireEvent.click(screen.getByTestId('new-simulation'))
    const option = screen.getByTestId('new-simulation-company').querySelector('option[value="c2"]')
    expect(option?.textContent).toContain('1 slave')
    fireEvent.change(screen.getByTestId('new-simulation-company'), { target: { value: 'c2' } })
    fireEvent.change(screen.getByTestId('new-simulation-name'), { target: { value: 'x' } })
    await act(async () => { fireEvent.click(screen.getByTestId('new-simulation-submit')) })
    expect(screen.getByTestId('new-simulation-error').textContent).toContain('needs 4')
    expect(screen.getByTestId('new-simulation-drawer')).toBeTruthy()
  })
  it('an empty list says so and names the demo company', () => {
    render(<SimulationsClient cards={[]} companies={companies} />)
    expect(screen.getByTestId('sim-empty').textContent).toContain('No simulations yet')
  })
})
