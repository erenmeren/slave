import { describe, expect, it } from 'vitest'
import { RUNBOOK_MAX_STAGES, parseRunbookStages, stageOrder, type RunbookStage } from '../../src/runbook/spec.js'

const stage = (overrides: Partial<RunbookStage> & { key: string }): RunbookStage => ({
  title: `Stage ${overrides.key}`,
  objective: `Do ${overrides.key}`,
  capabilities: [],
  dependsOn: [],
  expectedOutputs: [],
  gates: [],
  retry: null,
  escalation: null,
  ...overrides,
})

describe('parseRunbookStages', () => {
  it('fills every optional field, so a seed row may name only what it means', () => {
    const parsed = parseRunbookStages([{ key: 'design', title: 'Design', objective: 'Decide the shape' }])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toEqual([
      {
        key: 'design',
        title: 'Design',
        objective: 'Decide the shape',
        capabilities: [],
        dependsOn: [],
        expectedOutputs: [],
        gates: [],
        retry: null,
        escalation: null,
      },
    ])
  })

  it('refuses an empty list, a duplicate key, an unknown dependency and a cycle, by name', () => {
    expect(parseRunbookStages([])).toEqual({ ok: false, error: 'a runbook needs at least one stage' })
    expect(parseRunbookStages([stage({ key: 'a' }), stage({ key: 'a' })])).toEqual({
      ok: false,
      error: 'duplicate stage key: "a"',
    })
    expect(parseRunbookStages([stage({ key: 'a', dependsOn: ['b'] })])).toEqual({
      ok: false,
      error: 'stage "a" depends on unknown stage "b"',
    })
    expect(parseRunbookStages([stage({ key: 'a', dependsOn: ['b'] }), stage({ key: 'b', dependsOn: ['a'] })])).toEqual({
      ok: false,
      error: 'the runbook has a stage cycle through: a, b',
    })
    expect(parseRunbookStages([stage({ key: 'a', dependsOn: ['a'] })])).toEqual({
      ok: false,
      error: 'stage "a" cannot depend on itself',
    })
  })

  it('refuses a key that is not a slug, and more stages than the cap', () => {
    expect(parseRunbookStages([stage({ key: 'Design Stage' })]).ok).toBe(false)
    expect(parseRunbookStages(Array.from({ length: RUNBOOK_MAX_STAGES + 1 }, (_, i) => stage({ key: `s${String(i)}` }))).ok).toBe(false)
  })

  it('refuses a retry of zero attempts: a stage that may not be attempted is not a stage', () => {
    expect(parseRunbookStages([stage({ key: 'a', retry: { maxAttempts: 0 } })]).ok).toBe(false)
  })
})

describe('stageOrder', () => {
  it('is topological, and ties break on key ascending so the same runbook always reads the same', () => {
    const stages = [
      stage({ key: 'release', dependsOn: ['review'] }),
      stage({ key: 'implement', dependsOn: ['design'] }),
      stage({ key: 'design' }),
      stage({ key: 'review', dependsOn: ['verify'] }),
      stage({ key: 'verify', dependsOn: ['implement'] }),
    ]
    expect(stageOrder(stages).map((s) => s.key)).toEqual(['design', 'implement', 'verify', 'review', 'release'])
  })

  it('orders two independent stages by key, not by the order they were written in', () => {
    expect(stageOrder([stage({ key: 'zeta' }), stage({ key: 'alpha' })]).map((s) => s.key)).toEqual(['alpha', 'zeta'])
  })
})
