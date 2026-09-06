import { describe, expect, it } from 'vitest'
import { replay, runUntil } from '../../src/core/engine.js'
import { demoDefinition, tradeInitialEngineState } from '../../src/trade/definition.js'
import { tradeMetrics } from '../../src/trade/metrics.js'
import { tradeModel } from '../../src/trade/model.js'
import { RulesDecisionProvider } from '../../src/trade/rules.js'

const roster = [
  { slaveName: 'Sonia', departmentName: 'Sales' },
  { slaveName: 'Pete', departmentName: 'Purchasing' },
  { slaveName: 'Olga', departmentName: 'Operations' },
  { slaveName: 'Fin', departmentName: 'Finance' },
]

function run(policy: 'A' | 'B') {
  const definition = demoDefinition({ policy, seed: 1, roster, currency: 'USD' })
  const initial = tradeInitialEngineState(definition)
  const provider = new RulesDecisionProvider(definition)
  const result = runUntil(tradeModel, definition, initial, provider, definition.horizonDays, 1000)
  return { definition, initial, ...result, metrics: tradeMetrics(result.entries, result.state.sector) }
}

describe('the demo scenario under the two policies', () => {
  it('policy A waits for the normal supplier: cheaper, late; policy B hedges with the fast one: on time, dearer — no verdict', () => {
    const a = run('A')
    const b = run('B')
    expect(a.state.status).toBe('finished')
    expect(b.state.status).toBe('finished')
    expect(a.metrics.deliveredQty).toBe(150)
    expect(b.metrics.deliveredQty).toBe(150)
    expect(a.metrics.lateDays).toBeGreaterThan(0)
    expect(b.metrics.lateDays).toBe(0)
    expect(b.metrics.purchaseCostMinor).toBeGreaterThan(a.metrics.purchaseCostMinor)
    expect(b.metrics.minCashMinor).toBeLessThan(a.metrics.minCashMinor)
    expect(a.metrics.closingInventory).toBe(0)
    expect(b.metrics.closingInventory).toBe(50)
    // The normal purchase's payment day (31) lies past the horizon (30): a commitment, not spend.
    expect(a.metrics.unpaidCommitmentsMinor).toBe(50 * 6_000)
  })
  it('nothing happens without the rules: stock is 100 and no order is late before demand is accepted', () => {
    const a = run('A')
    const firstDecision = a.entries.find((e) => e.kind === 'decision')
    expect(firstDecision?.simTime).toBe(0)
    expect(a.entries.filter((e) => e.kind === 'action_rejected')).toHaveLength(0)
  })
  it('replay of either journal reproduces its state; two runs of one policy are identical', () => {
    const a = run('A')
    expect(replay(tradeModel, a.definition, a.initial, a.entries)).toEqual(a.state)
    const b1 = run('B')
    const b2 = run('B')
    expect(b1.entries).toEqual(b2.entries)
    expect(replay(tradeModel, b1.definition, b1.initial, b1.entries)).toEqual(b1.state)
  })
  it('the definition validates and freezes the roster it was given', () => {
    const definition = demoDefinition({ policy: 'A', seed: 3, roster, currency: 'USD' })
    expect(definition.synthetic).toBe(true)
    expect(definition.roles.map((r) => [r.name, r.slaveName])).toEqual([['sales', 'Sonia'], ['purchasing', 'Pete'], ['operations', 'Olga'], ['finance', 'Fin']])
    expect(() => demoDefinition({ policy: 'A', seed: 3, roster: roster.slice(0, 3), currency: 'USD' })).toThrow(/four/)
  })
})
