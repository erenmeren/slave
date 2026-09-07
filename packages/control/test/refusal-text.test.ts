import { describe, expect, it } from 'vitest'
import { refusalText } from '../src/refusal.js'

/**
 * The `live_runs` refusal is the one refusal whose text is assembled from a field that names a
 * SCHEMA entity (`workspace`/`team`/`slave`), and it used to interpolate that word straight into
 * the sentence a person reads -- "team 7f3a… has 1 live run(s)" (M27 final review, Important 3).
 * The product's vocabulary is project and department; identifiers keep `Workspace`/`Team`.
 */
describe('refusalText for live_runs', () => {
  it('says project, department and slave — never workspace or team', () => {
    expect(refusalText({ kind: 'live_runs', entity: 'workspace', id: 'w1', runs: 2 })).toBe(
      'project w1 has 2 live runs; wait for them to finish or stop them first',
    )
    expect(refusalText({ kind: 'live_runs', entity: 'team', id: 't1', runs: 1 })).toBe(
      'department t1 has 1 live run; wait for them to finish or stop them first',
    )
    expect(refusalText({ kind: 'live_runs', entity: 'slave', id: 'a1', runs: 1 })).toBe(
      'slave a1 has 1 live run; wait for them to finish or stop them first',
    )
  })
})

describe('refusalText for workspace_archived', () => {
  it('names the verb that lifts it, the way workspace_halted names clear-halt', () => {
    expect(refusalText({ kind: 'workspace_archived', workspaceId: 'w1' })).toBe(
      'project w1 is archived; nothing runs until it is restored with: restore-workspace --workspace w1',
    )
  })
})

describe('refusalText for the simulation kinds (M29)', () => {
  it('names the run, the version, the company and the verb', () => {
    expect(refusalText({ kind: 'simulation_not_found', simulationId: 's1' })).toBe('no simulation with id s1')
    expect(refusalText({ kind: 'unsupported_simulation', sector: 'retail', mode: 'simulation' })).toBe('a retail company cannot run in simulation mode yet; supported: trade, software + simulation')
    expect(refusalText({ kind: 'simulation_not_runnable', simulationId: 's1', status: 'halted' })).toBe('simulation s1 is halted; it cannot be stepped')
    expect(refusalText({ kind: 'stale_version', simulationId: 's1', expected: 3, actual: 4 })).toBe('simulation s1 moved on (version 4, you saw 3): reload and retry')
    expect(refusalText({ kind: 'simulation_corrupt', simulationId: 's1', reason: 'state: bad' })).toBe('simulation s1 cannot be read: state: bad')
    expect(refusalText({ kind: 'live_simulations', companyId: 'c1', simulations: 2 })).toBe('company c1 has 2 simulations; delete them first')
    expect(refusalText({ kind: 'roster_too_small', companyId: 'c1', needed: 4, have: 1 })).toBe('company c1 has 1 slave; the trade sector needs 4 for its roles')
    expect(refusalText({ kind: 'invalid_simulation_input', detail: 'qty must be positive' })).toBe('invalid simulation input: qty must be positive')
  })
})

describe('refusalText for the llm decision provider kinds (M31a)', () => {
  it('names the run and points at auto-run, and explains why a provider is unsupported', () => {
    expect(refusalText({ kind: 'llm_steps_in_daemon', simulationId: 's1' })).toBe(
      'simulation s1 makes its decisions with a model; its steps happen in the daemon — start auto-run',
    )
    expect(refusalText({ kind: 'unsupported_model_provider', provider: 'cursor', reason: 'it reports no cost, so a cap cannot be enforced' })).toBe(
      'model provider cursor is not supported for simulations: it reports no cost, so a cap cannot be enforced',
    )
  })
})
