import { describe, expect, it } from 'vitest'
import { SLAVE_LIFECYCLES, SLAVE_LIFECYCLE_LABEL } from '../../src/lifecycle/types.js'
import { isReleasable, type ReleasableWorker } from '../../src/lifecycle/release.js'

const ENGAGED: ReleasableWorker = {
  lifecycle: 'ephemeral',
  released: false,
  busy: false,
  engagementTaskStatus: 'done',
  openAssignedTasks: 0,
}

describe('the lifecycle vocabulary', () => {
  it('is the three M50 names, in the order a person reads them', () => {
    expect(SLAVE_LIFECYCLES).toEqual(['permanent', 'project', 'ephemeral'])
  })

  it('gives every member a word, so no surface ever prints the key', () => {
    expect(SLAVE_LIFECYCLE_LABEL).toEqual({
      permanent: 'Permanent',
      project: 'Project',
      ephemeral: 'Ephemeral',
    })
  })
})

describe('isReleasable', () => {
  it('releases an ephemeral worker whose one assignment is done and who has nothing else open', () => {
    expect(isReleasable(ENGAGED)).toBe(true)
  })

  it('releases one whose assignment failed or was cancelled -- the engagement is over either way', () => {
    expect(isReleasable({ ...ENGAGED, engagementTaskStatus: 'failed' })).toBe(true)
    expect(isReleasable({ ...ENGAGED, engagementTaskStatus: 'cancelled' })).toBe(true)
  })

  it('never releases a project or permanent worker, whatever else is true of them', () => {
    expect(isReleasable({ ...ENGAGED, lifecycle: 'project' })).toBe(false)
    expect(isReleasable({ ...ENGAGED, lifecycle: 'permanent' })).toBe(false)
  })

  it('never releases one that is already released', () => {
    expect(isReleasable({ ...ENGAGED, released: true })).toBe(false)
  })

  it('never releases one with a live run', () => {
    expect(isReleasable({ ...ENGAGED, busy: true })).toBe(false)
  })

  it('never releases one whose assignment is still open', () => {
    expect(isReleasable({ ...ENGAGED, engagementTaskStatus: 'ready' })).toBe(false)
    expect(isReleasable({ ...ENGAGED, engagementTaskStatus: 'running' })).toBe(false)
    expect(isReleasable({ ...ENGAGED, engagementTaskStatus: 'reviewing' })).toBe(false)
  })

  it('never releases one whose assignment the world no longer holds', () => {
    expect(isReleasable({ ...ENGAGED, engagementTaskStatus: null })).toBe(false)
  })

  it('never releases one that still has other work assigned to it', () => {
    expect(isReleasable({ ...ENGAGED, openAssignedTasks: 1 })).toBe(false)
  })
})
