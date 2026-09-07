import { describe, expect, it } from 'vitest'
import { replay, runUntil } from '../../src/core/engine.js'
import { demoDefinition, softwareInitialEngineState } from '../../src/software/definition.js'
import { softwareMetrics, type SoftwareMetrics } from '../../src/software/metrics.js'
import { softwareModel } from '../../src/software/model.js'
import { SoftwareRulesDecisionProvider } from '../../src/software/rules.js'
import { CHECKOUT_ROSTER } from './roster.js'

function run(policy: 'A' | 'B', roster: readonly { slaveName: string; departmentName: string; role: string }[] = CHECKOUT_ROSTER) {
  const definition = demoDefinition({ policy, seed: 1, roster, currency: 'USD' })
  const initial = softwareInitialEngineState(definition)
  const provider = new SoftwareRulesDecisionProvider(definition)
  const result = runUntil(softwareModel, definition, initial, provider, definition.horizonDays, 1000)
  return { definition, initial, ...result, metrics: softwareMetrics(result.entries, result.state.sector) }
}

/** The demo's figures, measured (not designed) and pinned here so any later change to the sector
 *  has to say so out loud. Recorded in design §9. Re-measured after erratum R17 ordered the
 *  engineer pool by id: these are now the figures the gate's real database-ordered roster measures
 *  too, so the unit test and `gate:m31b-software-sector` finally agree. */
const PINNED: Readonly<Record<'A' | 'B', SoftwareMetrics>> = {
  A: { deliveredTasks: 24, onTimeTasks: 14, lateTasks: 10, avgLeadDays: 3.2, reworkTasks: 12, defectIncidents: 12, queueMaxLength: 4, reviewBacklogMax: 2, idleEngineerDays: 55, openTasks: 0 },
  B: { deliveredTasks: 12, onTimeTasks: 12, lateTasks: 0, avgLeadDays: 2.8, reworkTasks: 0, defectIncidents: 0, queueMaxLength: 2, reviewBacklogMax: 2, idleEngineerDays: 89, openTasks: 0 },
}

describe('the software demo under the two policies', () => {
  it('policy A ships fast and pays for it in defects; policy B reviews everything and never reworks — no verdict', () => {
    const a = run('A')
    const b = run('B')
    expect(a.state.status).toBe('finished')
    expect(b.state.status).toBe('finished')
    // Design §3.5's invariants, checked as claims about the model rather than about these numbers.
    expect(b.metrics.defectIncidents).toBe(0)
    expect(b.metrics.reworkTasks).toBe(0)
    expect(a.metrics.defectIncidents).toBeGreaterThanOrEqual(4)
    expect(a.metrics.reviewBacklogMax).toBeLessThanOrEqual(b.metrics.reviewBacklogMax)
    // A delivers more only because twelve of its "deliveries" are defects it caused itself; the
    // twelve scenario requests are the same twelve under either policy.
    expect(a.metrics.deliveredTasks - a.metrics.defectIncidents).toBe(b.metrics.deliveredTasks)
    expect(a.metrics.lateTasks).toBeGreaterThan(b.metrics.lateTasks)
  })

  it('pins every metric of both runs', () => {
    expect(run('A').metrics).toEqual(PINNED.A)
    expect(run('B').metrics).toEqual(PINNED.B)
  })

  it('the roster\'s own order cannot change a run: engineers are ordered by id inside the plugin', () => {
    // Erratum R17: `rosterOf` (the read every real `createSimulation` goes through) sorts slaves
    // by name, this file's fixture is hand-typed in another order, and policy A breaks a
    // free-engineer tie by array position -- so before the fix the two orders measured different
    // runs. The plugin sorts, so neither caller has to.
    const reversed = [...CHECKOUT_ROSTER].reverse()
    const forward = run('A')
    const backward = run('A', reversed)
    expect(forward.definition.engineers.map((e) => e.id)).toEqual(['Alex', 'Daniel', 'Emma', 'Maya'])
    expect(backward.definition.engineers).toEqual(forward.definition.engineers)
    expect(backward.metrics).toEqual(PINNED.A)
    expect(run('B', reversed).metrics).toEqual(PINNED.B)
  })

  it('no action is ever rejected: the rules provider proposes only what the model accepts', () => {
    for (const policy of ['A', 'B'] as const) expect(run(policy).entries.filter((e) => e.kind === 'action_rejected')).toHaveLength(0)
  })

  it('replay of either journal reproduces its state; two runs of one policy are identical', () => {
    const a = run('A')
    expect(replay(softwareModel, a.definition, a.initial, a.entries)).toEqual(a.state)
    const b1 = run('B')
    const b2 = run('B')
    expect(b1.entries).toEqual(b2.entries)
    expect(replay(softwareModel, b1.definition, b1.initial, b1.entries)).toEqual(b1.state)
  })
})
