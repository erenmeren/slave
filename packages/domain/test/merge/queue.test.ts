import { describe, expect, it } from 'vitest'
import { taskId } from '../../src/ids.js'
import { nextMergeCandidate, type MergeCandidate } from '../../src/merge/queue.js'

function candidate(id: string, enqueuedAt: number, blockedUntilRebase = false): MergeCandidate {
  return { taskId: taskId(id), branch: `aiteamos/${id}`, enqueuedAt, blockedUntilRebase }
}

describe('nextMergeCandidate', () => {
  it('returns null for an empty queue', () => {
    expect(nextMergeCandidate([], false)).toBeNull()
  })

  it('returns null while a merge is already in progress', () => {
    expect(nextMergeCandidate([candidate('TASK-1', 1)], true)).toBeNull()
  })

  it('picks the earliest enqueued candidate', () => {
    const next = nextMergeCandidate([candidate('TASK-2', 20), candidate('TASK-1', 10)], false)
    expect(next?.taskId).toBe('TASK-1')
  })

  it('skips candidates that must rebase first', () => {
    const next = nextMergeCandidate(
      [candidate('TASK-1', 10, true), candidate('TASK-2', 20)],
      false,
    )
    expect(next?.taskId).toBe('TASK-2')
  })

  it('returns null when every candidate needs a rebase', () => {
    expect(nextMergeCandidate([candidate('TASK-1', 10, true)], false)).toBeNull()
  })

  it('breaks ties on enqueue time by task id', () => {
    const next = nextMergeCandidate([candidate('TASK-9', 10), candidate('TASK-3', 10)], false)
    expect(next?.taskId).toBe('TASK-3')
  })
})
