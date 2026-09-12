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
    expect(refusalText({ kind: 'invalid_simulation_input', detail: 'qty must be positive' })).toBe('invalid simulation input: qty must be positive')
  })
})

describe('refusalText for not_adoptable (M33)', () => {
  it('names the run and prints the sector\'s own reason verbatim', () => {
    expect(refusalText({ kind: 'not_adoptable', simulationId: 's1', reason: "the trade sector's roles are not software roles" })).toBe(
      "simulation s1 cannot be adopted: the trade sector's roles are not software roles",
    )
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

describe('refusalText for the messaging verbs (M36 t1)', () => {
  it('disambiguates the two cross_workspace shapes by their own fields, and names the messaging refusals', () => {
    expect(refusalText({ kind: 'cross_workspace', taskId: 't1', dependsOnTaskId: 't2' })).toBe(
      'task t1 and t2 are in different workspaces',
    )
    expect(refusalText({ kind: 'cross_workspace', runId: 'r1', recipientSlaveId: 's2' })).toBe(
      'run r1 cannot send a message to s2: they are in a different workspace',
    )
    expect(refusalText({ kind: 'invalid_recipient', detail: 'exactly one of recipientSlaveId or recipientRole must be set' })).toBe(
      'invalid recipient: exactly one of recipientSlaveId or recipientRole must be set',
    )
    expect(refusalText({ kind: 'invalid_message_body' })).toBe('a message body must be a non-empty text')
    expect(refusalText({ kind: 'message_not_found', messageId: 'm1' })).toBe('no message with id m1')
    expect(refusalText({ kind: 'not_message_recipient', messageId: 'm1', slaveId: 's1' })).toBe(
      'message m1 is not addressed to slave s1',
    )
  })
})

/**
 * M53 R9, fix round 1 (Important 1). `invalid_model` is REUSED by `setStaffingPreference` for a
 * SHAPE failure, and its default sentence -- written for `setSlaveModel`, whose only check is
 * `trim() === ''` -- was then false about the input: an operator typing `gpt 4o` was told a
 * non-empty value was empty. The kind keeps its name and takes `invalid_name`'s optional `detail`,
 * and this is the case that would have caught the mismatch: the two sentences are asserted
 * VERBATIM, so neither caller's wording can drift into the other's.
 */
describe('refusalText for invalid_model (M53 R9)', () => {
  it('keeps the blank-value sentence the three callers before M53 rely on', () => {
    expect(refusalText({ kind: 'invalid_model' })).toBe('a model must be a non-empty text')
  })

  it('states the RULE when a verb has one, in words and never as a pattern', () => {
    const sentence = refusalText({
      kind: 'invalid_model',
      detail: 'a model must be one word: a letter or digit, then any of . _ - : @ / — and no spaces',
    })
    expect(sentence).toBe('a model must be one word: a letter or digit, then any of . _ - : @ / — and no spaces')
    // The sentence a person reads is prose, not a regular expression they have to decode first.
    expect(sentence).not.toMatch(/[\^$\\[\]*+]/)
  })
})
