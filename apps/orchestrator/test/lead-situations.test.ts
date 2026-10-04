import { describe, expect, it } from 'vitest'
import { leadSituations } from '../src/supervisor.js'

const seen = [{ kind: 'task_failed' }, { kind: 'goal_needs_human' }, { kind: 'verification_failed' }, { kind: 'workspace_halted' }, { kind: 'waiting_stale' }]

describe('leadSituations (plan A L13)', () => {
  it('keeps only a stopped goal version and a halt in the lead flow', () => {
    expect(leadSituations('lead', seen).map((s) => s.kind)).toEqual(['goal_needs_human', 'workspace_halted'])
  })

  it('returns what it was given for every other project', () => {
    expect(leadSituations('packages', seen)).toBe(seen)
    expect(leadSituations(null, seen)).toBe(seen)
  })
})
