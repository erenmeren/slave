// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulationClient } from '../src/components/sim/SimulationClient.js'
import type { SimulationSnapshot } from '../src/server/simulation.js'

const routerRefresh = vi.fn()
const routerPush = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: routerRefresh, push: routerPush }) }))

let stream: { version: number; status: string; connection: 'connected' | 'reconnecting' } = { version: 2, status: 'running', connection: 'connected' }
vi.mock('../src/hooks/useSimulationStream', () => ({ useSimulationStream: () => stream }))

function snapshot(over: Partial<SimulationSnapshot> = {}): SimulationSnapshot {
  return {
    summary: { id: 's1', companyId: 'c1', companyName: 'Demo Trading Co.', name: 'Q3 plan', sector: 'trade', mode: 'simulation', decisionProvider: 'rules', modelProvider: null, model: null, maxModelCostUsd: null, llmRoles: [], policy: 'B', status: 'running', simTime: 4, horizonDays: 30, stepCount: 4, actionCount: 16, version: 2, haltedReason: null, createdAt: '2026-09-06T00:00:00.000Z', synthetic: true, autoRun: null, clonedFromId: null, clonedFromName: null },
    currency: 'USD',
    company: { day: 4, cashMinor: 4_575_000, inventory: 10, openOrders: 1, pendingDemand: 0, inboundPurchases: 2, dailyShipCapacity: 30 },
    roles: [{ name: 'sales', slaveName: 'Sonia', purpose: 'accepts demand', allowedActions: ['accept_order', 'note'] }],
    metrics: { deliveredQty: 90, onTimeQty: 90, lateDays: 0, purchaseCostMinor: 725_000, closingInventory: 10, closingCashMinor: 4_575_000, minCashMinor: 4_575_000, minCashDay: 3, collectedMinor: 0, unpaidCommitmentsMinor: 300_000, sources: { deliveredQty: ['action_applied:ship_order'], lateDays: ['state.orders'], purchaseCostMinor: ['action_applied:place_purchase'], collectedMinor: ['event:collection'], unpaidCommitmentsMinor: ['state.purchases'] } },
    journal: [
      { seq: 5, simTime: 1, kind: 'decision', actorRole: 'purchasing', payload: { index: 1, provider: 'rules', observation: { inventory: 100 }, actions: [{ type: 'place_purchase', params: { supplierId: 'normal', qty: 50 }, rationale: 'shortfall 50 against open orders', refs: ['order-2'] }] } },
      { seq: 6, simTime: 1, kind: 'action_applied', actorRole: 'purchasing', payload: { index: 1, actionIndex: 0, action: { type: 'place_purchase', params: { supplierId: 'normal', qty: 50 } }, costMinor: 300_000, expectedDay: 8 } },
      { seq: 7, simTime: 1, kind: 'action_rejected', actorRole: 'operations', payload: { index: 2, actionIndex: 1, action: { type: 'ship_order', params: { orderId: 'order-2', qty: 40 } }, reason: { kind: 'capacity_exhausted', remainingCapacity: 0 } } },
      { seq: 8, simTime: 1, kind: 'event', actorRole: null, payload: { kind: 'close', inventory: 70, cashMinor: 5_000_000, openOrders: 1, lateOrders: 0 } },
      { seq: 9, simTime: 2, kind: 'decision', actorRole: 'operations', payload: { index: 2, provider: 'rules', observation: { openOrders: 2 }, actions: [{ type: 'ship_order', params: { qty: 30 }, rationale: 'ship the smaller order first', refs: ['order-3'] }, { type: 'ship_order', params: { qty: 40 }, rationale: 'ship the larger order next', refs: ['order-4'] }] } },
      // Out-of-order on purpose: the rejection for the SECOND action (actionIndex 1) is
      // journalled before the applied row for the FIRST action (actionIndex 0), so a positional
      // zip (`outcomes[i]`) would swap them.
      { seq: 10, simTime: 2, kind: 'action_rejected', actorRole: 'operations', payload: { index: 2, actionIndex: 1, action: { type: 'ship_order', params: { qty: 40 } }, reason: { kind: 'capacity_exhausted', remainingCapacity: 0 } } },
      { seq: 11, simTime: 2, kind: 'action_applied', actorRole: 'operations', payload: { index: 2, actionIndex: 0, action: { type: 'ship_order', params: { qty: 30 } } } },
    ],
    modelUsage: { spentUsd: null, capUsd: null, rows: [], unmeasured: 0 },
    scenario: [{ day: 1, event: { type: 'demand', qty: 150 } }],
    compareCandidates: [{ id: 's2', name: 'Q3 plan (B)', policy: 'B', status: 'finished', simTime: 30 }],
    ...over,
  }
}
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); routerRefresh.mockClear(); routerPush.mockClear(); stream = { version: 2, status: 'running', connection: 'connected' } })
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
    expect(screen.getByRole('tab', { name: 'decisions' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'overview' }).getAttribute('aria-selected')).toBe('false')
    const rows = screen.getAllByTestId('sim-decision-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('purchasing')
    expect(rows[0]?.textContent).toContain('rules')
    expect(rows[0]?.textContent).toContain('place_purchase')
    expect(rows[0]?.textContent).toContain('shortfall 50')
    expect(rows[0]?.textContent).toContain('applied')
    // Outcomes are matched by the journal's own `actionIndex`, not by array position: the
    // rejection for the second action arrives in the journal before the first action's own
    // applied row, and the render must still pair each action with its own outcome.
    const opRow = rows[1]?.textContent ?? ''
    expect(opRow).toMatch(/"qty":30\}.*?applied.*?"qty":40\}.*?rejected/s)
    fireEvent.click(screen.getByTestId('sim-tab-journal'))
    expect(screen.getAllByTestId('sim-journal-row')).toHaveLength(7)
    expect(screen.getAllByTestId('sim-journal-row')[2]?.textContent).toContain('capacity_exhausted')
  })
  it('Clone… opens the drawer prefilled from the source; submit posts and navigates on success', async () => {
    render(<SimulationClient initial={snapshot()} />)
    fireEvent.click(screen.getByTestId('sim-clone-open'))
    expect(screen.getByTestId('sim-clone-drawer')).toBeTruthy()
    // source policy is 'B' (see snapshot()), so the name suggests '(A)' and the policy defaults to the OTHER policy, 'A'.
    expect((screen.getByTestId('sim-clone-name') as HTMLInputElement).value).toBe('Q3 plan (A)')
    expect((screen.getByTestId('sim-clone-policy') as HTMLSelectElement).value).toBe('A')
    expect((screen.getByTestId('sim-clone-seed') as HTMLInputElement).value).toBe('1')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, id: 'c1' }), { status: 200 }))
    await act(async () => { fireEvent.click(screen.getByTestId('sim-clone-submit')) })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/sim/s1/clone')
    expect(JSON.parse(String(init.body))).toMatchObject({ name: 'Q3 plan (A)', policy: 'A', seed: 1 })
    expect(routerPush).toHaveBeenCalledWith('/sim/c1')
    expect(screen.queryByTestId('sim-clone-drawer')).toBeNull()
  })
  it('a 409 on clone keeps the drawer open with sim-clone-error', async () => {
    render(<SimulationClient initial={snapshot()} />)
    fireEvent.click(screen.getByTestId('sim-clone-open'))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'a simulation named "Q3 plan (A)" already exists' }), { status: 409 }))
    await act(async () => { fireEvent.click(screen.getByTestId('sim-clone-submit')) })
    expect(screen.getByTestId('sim-clone-error').textContent).toContain('already exists')
    expect(screen.getByTestId('sim-clone-drawer')).toBeTruthy()
    expect(routerPush).not.toHaveBeenCalled()
  })
  it('choosing a run in "compare with" navigates to the compare page', () => {
    render(<SimulationClient initial={snapshot()} />)
    fireEvent.change(screen.getByTestId('sim-compare-with'), { target: { value: 's2' } })
    expect(routerPush).toHaveBeenCalledWith('/sim/compare?a=s1&b=s2')
    expect(routerRefresh).not.toHaveBeenCalled()
  })
  it('no candidates hides "compare with"', () => {
    render(<SimulationClient initial={snapshot({ compareCandidates: [] })} />)
    expect(screen.queryByTestId('sim-compare-with')).toBeNull()
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
  it('refreshes when the stream version moves past the summary version; sim-live shows LIVE/RECONNECTING', () => {
    stream = { version: 2, status: 'running', connection: 'connected' }
    const { rerender } = render(<SimulationClient initial={snapshot()} />)
    expect(routerRefresh).not.toHaveBeenCalled()
    expect(screen.getByTestId('sim-live').textContent).toContain('LIVE')
    stream = { version: 3, status: 'running', connection: 'connected' }
    rerender(<SimulationClient initial={snapshot()} />)
    expect(routerRefresh).toHaveBeenCalledTimes(1)
    stream = { version: 3, status: 'running', connection: 'reconnecting' }
    rerender(<SimulationClient initial={snapshot()} />)
    expect(screen.getByTestId('sim-live').textContent).toContain('RECONNECTING')
  })
  it('refreshes when the stream status changes with the version unchanged (fix wave, Important #1): an auto-run error halt, or a CLI pause/halt/stop-auto-run, never bumps version', () => {
    stream = { version: 2, status: 'running', connection: 'connected' }
    const { rerender } = render(<SimulationClient initial={snapshot()} />)
    expect(routerRefresh).not.toHaveBeenCalled()
    stream = { version: 2, status: 'halted', connection: 'connected' }
    rerender(<SimulationClient initial={snapshot()} />)
    expect(routerRefresh).toHaveBeenCalledTimes(1)
  })
  it('Auto-run posts everyMs/untilDay; with autoRun set, Stop auto-run posts to the stop route, the chip reads, and Step is disabled', async () => {
    const { unmount } = render(<SimulationClient initial={snapshot()} />)
    fireEvent.change(screen.getByTestId('sim-auto-run-every'), { target: { value: '1000' } })
    fireEvent.change(screen.getByTestId('sim-auto-run-until'), { target: { value: '30' } })
    await act(async () => { fireEvent.click(screen.getByTestId('sim-auto-run-start')) })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/sim/s1/auto-run')
    expect(JSON.parse(String(init.body))).toMatchObject({ everyMs: 1000, untilDay: 30 })
    unmount()

    render(<SimulationClient initial={snapshot({ summary: { ...snapshot().summary, autoRun: { everyMs: 1000, untilDay: 30, lastStepAt: null } } })} />)
    expect(screen.getByTestId('sim-auto-run-chip').textContent).toContain('auto-run every 1 s → day 30')
    expect((screen.getByTestId('sim-step') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('sim-run-to') as HTMLButtonElement).disabled).toBe(true)
    // Pause must stay live during auto-run (fix round 1, Important #2): it is what stops the
    // auto-run in flight (spec §4), so gating it the same way as Step/Run-to would make it
    // impossible to pause a run whose auto-run is stuck or misbehaving.
    expect((screen.getByTestId('sim-pause') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { fireEvent.click(screen.getByTestId('sim-auto-run-stop')) })
    expect(fetchMock).toHaveBeenCalledWith('/api/sim/s1/auto-run/stop', expect.objectContaining({ method: 'POST' }))
  })

  describe('an llm run', () => {
    function llmSnapshot(over: Partial<SimulationSnapshot> = {}): SimulationSnapshot {
      return snapshot({
        summary: { ...snapshot().summary, decisionProvider: 'llm', modelProvider: 'claude_code', model: 'claude-sonnet-4-5', maxModelCostUsd: 2, llmRoles: ['purchasing'] },
        journal: [
          { seq: 20, simTime: 5, kind: 'decision', actorRole: 'purchasing', payload: { index: 5, provider: 'llm', model: 'claude-sonnet-4-5', usageSeq: 100, promptHash: 'h1', observation: { inventory: 40 }, actions: [{ type: 'place_purchase', params: { supplierId: 'normal', qty: 20 }, rationale: 'restock', refs: [] }] } },
          { seq: 21, simTime: 6, kind: 'decision', actorRole: 'purchasing', payload: { index: 6, provider: 'llm', model: 'claude-sonnet-4-5', usageSeq: 101, promptHash: 'h2', parseError: 'no JSON action block found', observation: { inventory: 30 }, actions: [] } },
        ],
        modelUsage: { spentUsd: 0.0038, capUsd: 2, unmeasured: 1, rows: [{ seq: 100, simTime: 5, role: 'purchasing', costUsd: 0.0038 }, { seq: 101, simTime: 6, role: 'purchasing', costUsd: null }] },
        ...over,
      })
    }

    it('the strip names the model provider and model', () => {
      render(<SimulationClient initial={llmSnapshot()} />)
      expect(screen.getByTestId('sim-strip').textContent).toContain('llm provider · claude_code · claude-sonnet-4-5')
    })

    it('the model panel reads $spent of $cap with unmeasured count', () => {
      render(<SimulationClient initial={llmSnapshot()} />)
      expect(screen.getByTestId('sim-model-usage').textContent).toContain('$0.0038 of $2.00')
      expect(screen.getByTestId('sim-model-usage').textContent).toContain('1 unmeasured')
    })

    it('Step and Run-to-day are absent; the auto-run-only sentence shows instead', () => {
      render(<SimulationClient initial={llmSnapshot()} />)
      expect(screen.queryByTestId('sim-step')).toBeNull()
      expect(screen.queryByTestId('sim-run-to')).toBeNull()
      expect(screen.getByTestId('sim-controls').textContent).toContain('an llm run steps only through auto-run (the daemon makes the model calls); a call already in flight finishes and is billed')
    })

    it('a halted llm run names the reason without the in-request stepping note', () => {
      render(<SimulationClient initial={llmSnapshot({ summary: { ...llmSnapshot().summary, status: 'halted', haltedReason: 'model budget exhausted' } })} />)
      const note = screen.getByTestId('sim-halted-note').textContent ?? ''
      expect(note).toContain('model budget exhausted')
      expect(note).not.toContain('stepping is in-request')
    })

    it('the Decisions tab shows the llm chip, the model, the matched cost, and a parse error line', () => {
      render(<SimulationClient initial={llmSnapshot()} />)
      fireEvent.click(screen.getByTestId('sim-tab-decisions'))
      const rows = screen.getAllByTestId('sim-decision-row')
      expect(rows).toHaveLength(2)
      expect(rows[0]?.textContent).toContain('llm')
      expect(rows[0]?.textContent).toContain('claude-sonnet-4-5')
      expect(rows[0]?.textContent).toContain('$0.0038')
      expect(rows[1]?.textContent).toContain('unmeasured')
      expect(rows[1]?.textContent).toContain('no JSON action block found')
    })
  })
})
