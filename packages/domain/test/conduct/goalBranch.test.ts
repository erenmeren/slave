import { describe, expect, it } from 'vitest'
import { handMergeInstruction, integrationBranchName, integrationWorktreeKey } from '../../src/conduct/goalBranch.js'

describe('integrationBranchName', () => {
  it('names the version and the workspace', () => {
    expect(integrationBranchName(3, '0c1d2e3f-aaaa-4bbb-8ccc-123456789abc')).toBe('slaveofai/goal-v3-0c1d2e3f')
    expect(integrationWorktreeKey(3, '0c1d2e3f-aaaa-4bbb-8ccc-123456789abc')).toBe('goal-v3-0c1d2e3f')
  })

  it('refuses a version that is not a positive integer', () => {
    expect(() => integrationBranchName(0, 'x')).toThrow(/positive integer/)
  })
})

// Ruling V6: one wording for every wait on a person's hand merge -- the goal pass's trips and the
// Supervisor's `goal_needs_human` escalation read the same function.
describe('handMergeInstruction', () => {
  it('names the branch, the base and the confirm command', () => {
    expect(handMergeInstruction('slaveofai/goal-v2-0c1d2e3f', 'main', 'ws-9', 2)).toBe(
      'Merge slaveofai/goal-v2-0c1d2e3f into main by hand, then run confirm-goal-merge --workspace ws-9 --version 2',
    )
  })
})
