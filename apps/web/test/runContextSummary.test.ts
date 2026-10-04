import { describe, expect, it } from 'vitest'
import { sectionLine } from '../src/lib/runContextSummary.js'

// Final review M3: the run page said which skills' instructions reached the prompt and which were
// cut, but not which were left out -- for length, or because they had nothing to show -- so an
// operator reading "instructions in the prompt: a" could not tell a skill that was dropped from one
// that was never assigned.
describe('sectionLine — skills', () => {
  const base = {
    kind: 'skills' as const,
    copied: ['a', 'b', 'c', 'd'],
    missing: [],
    shadowedByRepo: [],
    provider_unsupported: false,
    no_worktree: false,
  }

  it('names what was inlined, cut, left out for length, and had no instructions to show', () => {
    const line = sectionLine({ ...base, inlined: ['a', 'b'], truncated: ['b'], omitted: ['c'], unreadable: ['d'] })
    expect(line.detail).toContain('instructions in the prompt: a, b')
    expect(line.detail).toContain('cut for length: b')
    expect(line.detail).toContain('left out for length: c')
    expect(line.detail).toContain('no instructions to show: d')
  })

  it('says nothing of the conductor fields on a row written before them', () => {
    expect(sectionLine(base).detail).toBe('copied a, b, c, d')
  })
})

// Conductor Plan 2: a package worker's contract and the report it was asked for.
describe('sectionLine — package and report_protocol', () => {
  it('names the work package, its requirement count and the contract hash', () => {
    const line = sectionLine({ kind: 'package', workPackageId: 'wp-123456789', requirements: 2, sha256: 'abcdef0123456789' })
    expect(line.detail).toBe('Work package wp-12345: 2 requirements (sha abcdef01)')
    expect(line.missing).toEqual([])
  })

  it('says what the report must cover', () => {
    expect(sectionLine({ kind: 'report_protocol', requirements: 1, workflowSteps: 3 }).detail).toBe(
      'Report required: 1 requirement, 3 workflow steps',
    )
    expect(sectionLine({ kind: 'report_protocol', requirements: 2, workflowSteps: 0 }).detail).toBe(
      'Report required: 2 requirements, no workflow',
    )
  })
})

// Conductor Plan 4b (Task 3): a verification run's own goal and the report it was asked for.
describe('sectionLine — verification_goal and verification_protocol', () => {
  it('names the round, the goal version, the requirement count and whether the diff was capped', () => {
    expect(sectionLine({ kind: 'verification_goal', goalVersion: 2, round: 3, requirements: 2, diffCapped: false }).detail).toBe(
      'Verification round 3 of goal v2: 2 requirements',
    )
    expect(sectionLine({ kind: 'verification_goal', goalVersion: 1, round: 1, requirements: 1, diffCapped: true }).detail).toBe(
      'Verification round 1 of goal v1: 1 requirement (diff capped)',
    )
  })

  it('says what the verification must cover', () => {
    expect(sectionLine({ kind: 'verification_protocol', requirements: 2 }).detail).toBe('Verification required: 2 requirements')
  })
})

describe('sectionLine — lead_brief', () => {
  it('says which turn it was and whether the session was continued', () => {
    expect(sectionLine({ kind: 'lead_brief', goalVersion: 2, turn: 'wrap_up', resumed: true, requirements: 3, roster: 1 }).detail).toBe(
      'Lead brief for goal v2 (wrap up, into the same session): 3 requirements, 1 roster member',
    )
  })
})
