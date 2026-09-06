// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulationClient } from '../src/components/sim/SimulationClient.js'
import type { SimulationSnapshot } from '../src/server/simulation.js'

const routerRefresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }) }))

function snapshot(over: Partial<SimulationSnapshot> = {}): SimulationSnapshot {
  return {
    summary: { id: 's1', companyId: 'c1', companyName: 'Demo Trading Co.', name: 'Q3 plan', sector: 'trade', mode: 'simulation', decisionProvider: 'rules', policy: 'B', status: 'running', simTime: 4, horizonDays: 30, stepCount: 4, decisionCount: 16, version: 2, haltedReason: null, createdAt: '2026-09-06T00:00:00.000Z', synthetic: true },
    currency: 'USD',
    company: { day: 4, cashMinor: 4_575_000, inventory: 10, openOrders: 1, pendingDemand: 0, inboundPurchases: 2, dailyShipCapacity: 30 },
    roles: [{ name: 'sales', slaveName: 'Sonia', purpose: 'accepts demand', allowedActions: ['accept_order', 'note'] }],
    metrics: { deliveredQty: 90, onTimeQty: 90, lateDays: 0, purchaseCostMinor: 725_000, closingInventory: 10, closingCashMinor: 4_575_000, minCashMinor: 4_575_000, minCashDay: 3, collectedMinor: 0, unpaidCommitmentsMinor: 300_000, sources: { deliveredQty: ['action_applied:ship_order'], lateDays: ['state.orders'], purchaseCostMinor: ['action_applied:place_purchase'], collectedMinor: ['event:collection'], unpaidCommitmentsMinor: ['state.purchases'] } },
    journal: [
      { seq: 5, simTime: 1, kind: 'decision', actorRole: 'purchasing', payload: { index: 1, provider: 'rules', observation: { inventory: 100 }, actions: [{ type: 'place_purchase', params: { supplierId: 'normal', qty: 50 }, rationale: 'shortfall 50 against open orders', refs: ['order-2'] }] } },
      { seq: 6, simTime: 1, kind: 'action_applied', actorRole: 'purchasing', payload: { index: 1, actionIndex: 0, action: { type: 'place_purchase', params: { supplierId: 'normal', qty: 50 } }, costMinor: 300_000, expectedDay: 8 } },
      { seq: 7, simTime: 1, kind: 'action_rejected', actorRole: 'operations', payload: { index: 2, actionIndex: 1, action: { type: 'ship_order', params: { orderId: 'order-2', qty: 40 } }, reason: { kind: 'capacity_exhausted', remainingCapacity: 0 } } },
      { seq: 8, simTime: 1, kind: 'event', actorRole: null, payload: { kind: 'close', inventory: 70, cashMinor: 5_000_000, openOrders: 1, lateOrders: 0 } },
    ],
    modelUsage: { rows: 0, costUsd: null, unmeasured: 0 },
    scenario: [{ day: 1, event: { type: 'demand', qty: 150 } }],
    ...over,
  }
}
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); routerRefresh.mockClear() })
afterEach(() => vi.unstubAllGlobals())

describe('SimulationClient', () => {
  it('shows the persistent strip, the two money panels apart, and the metrics with their sources', () => {
    render(<SimulationClient initial={snapshot()} />)
    const strip = screen.getByTestId('sim-strip').textContent ?? ''
    expect(strip).toContain('SIMULATION')
    expect(strip).toContain('trade')
    expect(strip).toContain('rules provider')
    expect(strip).toContain('synthetic')
    expect(screen.getByTestId('sim-company-cash').textContent).toBe('$45,750.00')
    expect(screen.getByTestId('sim-company-day').textContent).toContain('4 / 30')
    expect(screen.getByTestId('sim-model-usage').textContent).toContain('no model calls')
    expect(screen.getByTestId('sim-model-usage').textContent).not.toContain('$0')
    expect(screen.getByTestId('sim-metric-purchaseCostMinor').textContent).toContain('$7,250.00')
    expect(screen.getByTestId('sim-metric-purchaseCostMinor').textContent).toContain('action_applied:place_purchase')
    expect(screen.getByTestId('sim-metric-lateDays').textContent).toContain('0')
  })
  it('Step posts one step with an idempotency key and a version, then refreshes; Run to day posts untilDay', async () => {
    render(<SimulationClient initial={snapshot()} />)
    await act(async () => { fireEvent.click(screen.getByTestId('sim-step')) })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/sim/s1/step')
    const body = JSON.parse(String(init.body)) as { steps: number; expectedVersion: number; idempotencyKey: string }
    expect(body).toMatchObject({ steps: 1, expectedVersion: 2 })
    expect(body.idempotencyKey.length).toBeGreaterThan(8)
    expect(routerRefresh).toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('sim-run-to-day'), { target: { value: '30' } })
    await act(async () => { fireEvent.click(screen.getByTestId('sim-run-to')) })
    expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toMatchObject({ untilDay: 30, expectedVersion: 2 })
  })
  it('a refusal lands in sim-error; Pause/Resume/Halt hit their routes; halt needs a confirm', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'simulation s1 moved on (version 3, you saw 2): reload and retry' }), { status: 409 }))
    render(<SimulationClient initial={snapshot()} />)
    await act(async () => { fireEvent.click(screen.getByTestId('sim-step')) })
    expect(screen.getByTestId('sim-error').textContent).toContain('moved on')
    await act(async () => { fireEvent.click(screen.getByTestId('sim-pause')) })
    expect(fetchMock).toHaveBeenCalledWith('/api/sim/s1/pause', expect.objectContaining({ method: 'POST' }))
    fireEvent.click(screen.getByTestId('sim-halt'))
    await act(async () => { fireEvent.click(screen.getByTestId('sim-halt-confirm')) })
    expect(fetchMock).toHaveBeenCalledWith('/api/sim/s1/halt', expect.objectContaining({ method: 'POST' }))
  })
  it('a paused run shows Resume instead of Pause and disables Step; a finished run disables everything but the tabs', () => {
    const { unmount } = render(<SimulationClient initial={snapshot({ summary: { ...snapshot().summary, status: 'paused' } })} />)
    expect(screen.queryByTestId('sim-pause')).toBeNull()
    expect(screen.getByTestId('sim-resume')).toBeTruthy()
    expect((screen.getByTestId('sim-step') as HTMLButtonElement).disabled).toBe(true)
    unmount()
    render(<SimulationClient initial={snapshot({ summary: { ...snapshot().summary, status: 'finished', simTime: 30 } })} />)
    expect((screen.getByTestId('sim-step') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('sim-run-to') as HTMLButtonElement).disabled).toBe(true)
  })
  it('the Decisions tab lists each decision with role, provider, actions, rationale and the rule outcome; the Journal tab lists every row', () => {
    render(<SimulationClient initial={snapshot()} />)
    fireEvent.click(screen.getByTestId('sim-tab-decisions'))
    const rows = screen.getAllByTestId('sim-decision-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('purchasing')
    expect(rows[0]?.textContent).toContain('rules')
    expect(rows[0]?.textContent).toContain('place_purchase')
    expect(rows[0]?.textContent).toContain('shortfall 50')
    expect(rows[0]?.textContent).toContain('applied')
    fireEvent.click(screen.getByTestId('sim-tab-journal'))
    expect(screen.getAllByTestId('sim-journal-row')).toHaveLength(4)
    expect(screen.getAllByTestId('sim-journal-row')[2]?.textContent).toContain('capacity_exhausted')
  })
  it('injecting a demand posts the event for a future day', async () => {
    render(<SimulationClient initial={snapshot()} />)
    fireEvent.click(screen.getByTestId('sim-inject-open'))
    fireEvent.change(screen.getByTestId('sim-inject-kind'), { target: { value: 'demand' } })
    fireEvent.change(screen.getByTestId('sim-inject-day'), { target: { value: '6' } })
    fireEvent.change(screen.getByTestId('sim-inject-qty'), { target: { value: '20' } })
    await act(async () => { fireEvent.click(screen.getByTestId('sim-inject-submit')) })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/sim/s1/inject')
    expect(JSON.parse(String(init.body))).toMatchObject({ day: 6, event: { type: 'demand', qty: 20 } })
  })
})
