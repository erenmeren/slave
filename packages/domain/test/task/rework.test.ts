import { describe, expect, it } from 'vitest'
import { slaveId, runId } from '../../src/ids.js'
import { applyTaskEvent, initialTaskState, type TaskEvent, type TaskState } from '../../src/task/state.js'

function drive(state: TaskState, events: readonly TaskEvent[]): TaskState {
  return events.reduce((current, event) => {
    const result = applyTaskEvent(current, event)
    if (!result.ok) throw new Error(`illegal: ${result.error.from} + ${result.error.event}`)
    return result.value
  }, state)
}

const TO_RUNNING: readonly TaskEvent[] = [
  { type: 'dependencies_satisfied' },
  { type: 'assigned', slaveId: slaveId('alex') },
  { type: 'run_started', runId: runId('run-1') },
]

describe('rejection paths', () => {
  it('sends a failed verification back to rework', () => {
    const state = drive(initialTaskState(3), [
      ...TO_RUNNING,
      { type: 'run_succeeded' },
      { type: 'verify_failed', reason: '2 tests failing' },
    ])
    expect(state.status).toBe('rework')
    expect(state.lastRejectionReason).toBe('2 tests failing')
    expect(state.activeRunId).toBeNull()
  })

  it('sends a rejected review back to rework with the reviewer reason', () => {
    const state = drive(initialTaskState(3), [
      ...TO_RUNNING,
      { type: 'run_succeeded' },
      { type: 'verify_passed' },
      { type: 'review_rejected', reason: 'no input validation' },
    ])
    expect(state.status).toBe('rework')
    expect(state.lastRejectionReason).toBe('no input validation')
  })

  it('sends a failed merge back to rework rather than leaving done', () => {
    const state = drive(initialTaskState(3), [
      ...TO_RUNNING,
      { type: 'run_succeeded' },
      { type: 'verify_passed' },
      { type: 'review_approved' },
      { type: 'merge_failed', reason: 'post-merge tests red' },
    ])
    expect(state.status).toBe('rework')
    expect(state.lastRejectionReason).toBe('post-merge tests red')
  })

  it('allows reassignment from rework and increments the attempt', () => {
    const reworked = drive(initialTaskState(3), [
      ...TO_RUNNING,
      { type: 'run_failed', reason: 'crashed' },
      { type: 'assigned', slaveId: slaveId('alex') },
      { type: 'run_started', runId: runId('run-2') },
    ])
    expect(reworked.status).toBe('running')
    expect(reworked.attempt).toBe(2)
  })

  it('fails the task when attempts are exhausted', () => {
    let state = initialTaskState(2)
    state = drive(state, TO_RUNNING)
    state = drive(state, [{ type: 'run_failed', reason: 'first' }])
    expect(state.status).toBe('rework')

    state = drive(state, [
      { type: 'assigned', slaveId: slaveId('alex') },
      { type: 'run_started', runId: runId('run-2') },
      { type: 'run_failed', reason: 'second' },
    ])
    expect(state.status).toBe('failed')
    expect(state.attempt).toBe(2)
  })

  it('blocks a ready task whose dependencies regress', () => {
    const state = drive(initialTaskState(3), [
      { type: 'dependencies_satisfied' },
      { type: 'dependencies_unmet' },
    ])
    expect(state.status).toBe('blocked')
  })

  it('cancels from any non-terminal status', () => {
    const state = drive(initialTaskState(3), [...TO_RUNNING, { type: 'cancelled' }])
    expect(state.status).toBe('cancelled')
  })

  it('refuses to cancel a task that is already done', () => {
    const done = drive(initialTaskState(3), [
      ...TO_RUNNING,
      { type: 'run_succeeded' },
      { type: 'verify_passed' },
      { type: 'review_approved' },
      { type: 'merged' },
    ])
    const result = applyTaskEvent(done, { type: 'cancelled' })
    expect(result.ok).toBe(false)
  })
})
