import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GUARDRAIL_LIMITS,
  evaluateGuardrails,
  type WorkspaceStats,
} from '../../src/guardrails/evaluate.js'

const CALM: WorkspaceStats = {
  activeRuns: 1,
  globalActiveRuns: 1,
  spentUsd: 2,
  consecutiveFailures: 0,
  emergencyStopped: false,
}

describe('evaluateGuardrails', () => {
  it('reports nothing when everything is within limits', () => {
    expect(evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, CALM)).toEqual([])
  })

  it('halts scheduling when the concurrency limit is reached', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, activeRuns: 3 })
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.guardrail).toBe('concurrency')
    expect(breaches[0]?.haltsScheduling).toBe(true)
  })

  it('warns at 80% of budget without halting', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, spentUsd: 16 })
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.guardrail).toBe('budget_warning')
    expect(breaches[0]?.haltsScheduling).toBe(false)
  })

  it('halts when the budget is exhausted', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, spentUsd: 20 })
    const budget = breaches.find((b) => b.guardrail === 'budget_exhausted')
    expect(budget?.haltsScheduling).toBe(true)
  })

  it('does not emit budget_warning when budget is exhausted (mutual exclusivity)', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, spentUsd: 20 })
    expect(breaches).toHaveLength(1)
    expect(breaches.some((b) => b.guardrail === 'budget_warning')).toBe(false)
    expect(breaches[0]?.guardrail).toBe('budget_exhausted')
  })

  it('halts on the circuit breaker', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, consecutiveFailures: 3 })
    const breaker = breaches.find((b) => b.guardrail === 'circuit_breaker')
    expect(breaker?.haltsScheduling).toBe(true)
  })

  it('halts on emergency stop regardless of other numbers', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, emergencyStopped: true })
    expect(breaches.some((b) => b.guardrail === 'emergency_stop' && b.haltsScheduling)).toBe(true)
  })

  it('reports every simultaneous breach', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, {
      activeRuns: 5,
      globalActiveRuns: 0,
      spentUsd: 25,
      consecutiveFailures: 4,
      emergencyStopped: true,
    })
    expect(breaches.map((b) => b.guardrail).sort()).toEqual(
      ['budget_exhausted', 'circuit_breaker', 'concurrency', 'emergency_stop'].sort(),
    )
  })

  it('reports simultaneous breaches in a pinned, deterministic order', () => {
    // Order matters beyond mere presence: decide() surfaces the FIRST halting breach
    // (`.find(b => b.haltsScheduling)`) as the halt reason a human sees, so the emitted
    // order is itself part of the contract, not an implementation detail.
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, {
      activeRuns: 5,
      globalActiveRuns: 6,
      spentUsd: 25,
      consecutiveFailures: 4,
      emergencyStopped: true,
    })
    expect(breaches.map((b) => b.guardrail)).toEqual([
      'emergency_stop',
      'concurrency',
      'global_concurrency',
      'budget_exhausted',
      'circuit_breaker',
    ])
  })

  it('halts scheduling when the global concurrency limit is reached', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, globalActiveRuns: 6 })
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.guardrail).toBe('global_concurrency')
    expect(breaches[0]?.haltsScheduling).toBe(true)
  })

  it('does not breach global concurrency just below the limit', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, globalActiveRuns: 5 })
    expect(breaches).toHaveLength(0)
  })

  it('does not breach on concurrency just below the limit', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, activeRuns: 2 })
    expect(breaches).toHaveLength(0)
  })

  it('does not warn on budget just below the 80% threshold', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, spentUsd: 15.99 })
    expect(breaches).toHaveLength(0)
  })

  it('does not breach on circuit breaker just below the consecutive failure limit', () => {
    const breaches = evaluateGuardrails(DEFAULT_GUARDRAIL_LIMITS, { ...CALM, consecutiveFailures: 2 })
    expect(breaches).toHaveLength(0)
  })
})
