// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CompareClient } from '../src/components/sim/CompareClient.js'
import type { SimulationSummary, SimulationComparison } from '@slave-of-ai/control'

function summary(over: Partial<SimulationSummary> = {}): SimulationSummary {
  return {
    id: 'a1', companyId: 'c1', companyName: 'Demo Trading Co.', name: 'Run A', sector: 'trade', mode: 'simulation', decisionProvider: 'rules',
    policy: 'A', status: 'finished', simTime: 30, horizonDays: 30, stepCount: 30, actionCount: 90, version: 1, haltedReason: null,
    createdAt: '2026-09-06T00:00:00.000Z', synthetic: true, autoRun: null, clonedFromId: null, clonedFromName: null,
    ...over,
  }
}

function comparison(over: Partial<SimulationComparison> = {}): SimulationComparison {
  return {
    a: {
      summary: summary({ id: 'a1', name: 'Run A', policy: 'A' }),
      metrics: { deliveredQty: 90, onTimeQty: 86, lateDays: 4, purchaseCostMinor: 300_000, closingInventory: 0, closingCashMinor: 4_700_000, minCashMinor: 4_700_000, minCashDay: 8, collectedMinor: 1_800_000, unpaidCommitmentsMinor: 0, sources: { deliveredQty: [], lateDays: [], purchaseCostMinor: [], collectedMinor: [], unpaidCommitmentsMinor: [] } },
      injected: 0,
    },
    b: {
      summary: summary({ id: 'b1', name: 'Run B', policy: 'B' }),
      metrics: { deliveredQty: 90, onTimeQty: 90, lateDays: 0, purchaseCostMinor: 725_000, closingInventory: 50, closingCashMinor: 4_700_000, minCashMinor: 4_700_000, minCashDay: 8, collectedMinor: 1_800_000, unpaidCommitmentsMinor: 0, sources: { deliveredQty: [], lateDays: [], purchaseCostMinor: [], collectedMinor: [], unpaidCommitmentsMinor: [] } },
      injected: 0,
    },
    deltas: { deliveredQty: 0, onTimeQty: 4, lateDays: -4, purchaseCostMinor: 425_000, closingInventory: 50, closingCashMinor: 0, minCashMinor: 0, collectedMinor: 0, unpaidCommitmentsMinor: 0 },
    definitionsMatch: true,
    differences: [],
    currency: 'USD',
    ...over,
  }
}

describe('CompareClient', () => {
  it('the strip names both runs and says SIMULATION; no warning when the worlds match and neither run has an injected event', () => {
    render(<CompareClient comparison={comparison()} />)
    const strip = screen.getByTestId('sim-compare-strip').textContent ?? ''
    expect(strip).toContain('SIMULATION')
    expect(strip).toContain('Run A')
    expect(strip).toContain('Run B')
    expect(strip).toContain('trade')
    expect(screen.queryByTestId('sim-compare-warning')).toBeNull()
  })

  it('the warning band lists the differing keys and the injected-event counts when the worlds diverge', () => {
    const withDivergence = comparison({
      definitionsMatch: false,
      differences: ['initial'],
      b: { ...comparison().b, injected: 1 },
    })
    render(<CompareClient comparison={withDivergence} />)
    const warning = screen.getByTestId('sim-compare-warning').textContent ?? ''
    expect(warning).toContain('initial')
    expect(warning).toContain('b has 1 injected event')
  })

  it('each metric row shows A, B and a signed delta — money through formatMinor with an explicit sign, counts with +/−', () => {
    render(<CompareClient comparison={comparison()} />)
    const purchaseRow = screen.getByTestId('sim-compare-row-purchaseCostMinor').textContent ?? ''
    expect(purchaseRow).toContain('$3,000.00')
    expect(purchaseRow).toContain('$7,250.00')
    expect(screen.getByTestId('sim-compare-delta-purchaseCostMinor').textContent).toBe('+$4,250.00')
    expect(screen.getByTestId('sim-compare-delta-lateDays').textContent).toBe('−4')
    expect(screen.getByTestId('sim-compare-delta-closingInventory').textContent).toBe('+50')
    expect(screen.getByTestId('sim-compare-delta-deliveredQty').textContent).toBe('0')
  })

  it('the footer says no verdict is computed', () => {
    render(<CompareClient comparison={comparison()} />)
    expect(screen.getByTestId('sim-compare-footer').textContent).toContain('no verdict')
  })
})
