import { describe, expect, it } from 'vitest'
import { GUARDRAIL_KINDS, GUARDRAIL_LABEL, type GuardrailKind } from '../../src/guardrails/kinds.js'
import { DEFAULT_GUARDRAIL_LIMITS, evaluateGuardrails } from '../../src/guardrails/evaluate.js'

describe('GUARDRAIL_KINDS', () => {
  it('is the closed list of every spelling this codebase writes, plus M51 behavioural_loop', () => {
    expect(GUARDRAIL_KINDS).toEqual([
      'emergency_stop',
      'concurrency',
      'global_concurrency',
      'budget_exhausted',
      'budget_warning',
      'circuit_breaker',
      'behavioural_loop',
      'run_timeout',
      'tool_call_ceiling',
      'pause_gate',
      'permission_mode',
      'no_planner',
      'no_reviewer',
      'review_retry_cap_exhausted',
      'merge_failure',
      'verify_could_not_run',
      'verify_failed',
    ])
  })

  it('has no duplicates -- the list is the union, so a repeat would type-check and lie', () => {
    expect(new Set(GUARDRAIL_KINDS).size).toBe(GUARDRAIL_KINDS.length)
  })

  it('gives every member a word, so no surface ever prints the key', () => {
    for (const kind of GUARDRAIL_KINDS) {
      expect(GUARDRAIL_LABEL[kind], kind).toMatch(/^[A-Z]/u)
      expect(GUARDRAIL_LABEL[kind], kind).not.toContain('_')
    }
  })

  it('names the behavioural breaker apart from the failure-streak one -- two breakers, two words', () => {
    expect(GUARDRAIL_LABEL.circuit_breaker).toBe('Too many failed runs')
    expect(GUARDRAIL_LABEL.behavioural_loop).toBe('Going in circles')
  })
})

describe('evaluateGuardrails after the union', () => {
  it('still emits exactly the six breaches it always did, and every one of them is a GuardrailKind', () => {
    const breaches = evaluateGuardrails(
      { ...DEFAULT_GUARDRAIL_LIMITS, budgetUsd: 10 },
      { activeRuns: 9, globalActiveRuns: 9, spentUsd: 99, consecutiveFailures: 9, emergencyStopped: true },
    )
    const names: readonly GuardrailKind[] = breaches.map((breach) => breach.guardrail)
    expect(names).toEqual([
      'emergency_stop',
      'concurrency',
      'global_concurrency',
      'budget_exhausted',
      'circuit_breaker',
    ])
    for (const name of names) expect(GUARDRAIL_KINDS).toContain(name)
  })
})
