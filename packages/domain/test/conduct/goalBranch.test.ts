import { describe, expect, it } from 'vitest'
import { integrationBranchName, integrationWorktreeKey } from '../../src/conduct/goalBranch.js'

describe('integrationBranchName', () => {
  it('names the version and the workspace', () => {
    expect(integrationBranchName(3, '0c1d2e3f-aaaa-4bbb-8ccc-123456789abc')).toBe('slaveofai/goal-v3-0c1d2e3f')
    expect(integrationWorktreeKey(3, '0c1d2e3f-aaaa-4bbb-8ccc-123456789abc')).toBe('goal-v3-0c1d2e3f')
  })

  it('refuses a version that is not a positive integer', () => {
    expect(() => integrationBranchName(0, 'x')).toThrow(/positive integer/)
  })
})
