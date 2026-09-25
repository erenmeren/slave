import { describe, expect, it } from 'vitest'
import { isWorkspaceLimitAllowed, WORKSPACE_LIMIT_BOUNDS, WORKSPACE_LIMIT_RULE } from '../../src/guardrails/limits.js'

describe('the workspace limit bounds (H9 F8)', () => {
  it('holds the timeout to 5..180 whole minutes', () => {
    expect(isWorkspaceLimitAllowed('runTimeoutMs', 5 * 60_000)).toBe(true)
    expect(isWorkspaceLimitAllowed('runTimeoutMs', 180 * 60_000)).toBe(true)
    expect(isWorkspaceLimitAllowed('runTimeoutMs', 4 * 60_000)).toBe(false)
    expect(isWorkspaceLimitAllowed('runTimeoutMs', 181 * 60_000)).toBe(false)
    // A millisecond figure that is not a whole minute is a caller that skipped the conversion.
    expect(isWorkspaceLimitAllowed('runTimeoutMs', 30 * 60_000 + 1)).toBe(false)
  })

  it('holds runs at once and attempts to 1..10 whole numbers', () => {
    for (const field of ['maxConcurrentRuns', 'maxAttempts'] as const) {
      expect(isWorkspaceLimitAllowed(field, 1)).toBe(true)
      expect(isWorkspaceLimitAllowed(field, 10)).toBe(true)
      expect(isWorkspaceLimitAllowed(field, 0)).toBe(false)
      expect(isWorkspaceLimitAllowed(field, 11)).toBe(false)
      expect(isWorkspaceLimitAllowed(field, 2.5)).toBe(false)
      expect(isWorkspaceLimitAllowed(field, Number.NaN)).toBe(false)
    }
  })

  it('states each rule in the unit a person types', () => {
    expect(WORKSPACE_LIMIT_RULE.runTimeoutMs).toBe('a run timeout must be a whole number of minutes from 5 to 180')
    expect(WORKSPACE_LIMIT_RULE.maxConcurrentRuns).toBe('runs at once must be a whole number from 1 to 10')
    expect(WORKSPACE_LIMIT_RULE.maxAttempts).toBe('attempts per task must be a whole number from 1 to 10')
    expect(WORKSPACE_LIMIT_BOUNDS.maxAttempts).toEqual({ min: 1, max: 10 })
  })
})
