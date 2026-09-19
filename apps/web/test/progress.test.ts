import { describe, expect, it } from 'vitest'
import { PROGRESS_FOR_TASK_STATUS, progressOf } from '../src/lib/progress.js'

describe('PROGRESS_FOR_TASK_STATUS', () => {
  it('covers all thirteen statuses and is monotone through the pipeline', () => {
    expect(Object.keys(PROGRESS_FOR_TASK_STATUS).sort()).toEqual(
      [
        'assigned', 'backlog', 'blocked', 'cancelled', 'done', 'failed', 'merging', 'ready',
        'reviewing', 'rework', 'running', 'verifying', 'waiting',
      ].sort(),
    )
    expect([
      PROGRESS_FOR_TASK_STATUS.ready,
      PROGRESS_FOR_TASK_STATUS.assigned,
      PROGRESS_FOR_TASK_STATUS.running,
      PROGRESS_FOR_TASK_STATUS.verifying,
      PROGRESS_FOR_TASK_STATUS.reviewing,
      PROGRESS_FOR_TASK_STATUS.merging,
      PROGRESS_FOR_TASK_STATUS.done,
    ]).toEqual([0, 10, 35, 60, 80, 90, 100])
    expect(PROGRESS_FOR_TASK_STATUS.blocked).toBe(null)
  })

  it('moves inside the running band with the live run and never past 60', () => {
    expect(progressOf('running', 0)).toBe(35)
    expect(progressOf('running', 100)).toBe(60)
    expect(progressOf('running', 50)).toBe(48)
    expect(progressOf('verifying', 100)).toBe(60)
    expect(progressOf(null, 50)).toBe(null)
    expect(progressOf('blocked', 50)).toBe(null)
  })
})
