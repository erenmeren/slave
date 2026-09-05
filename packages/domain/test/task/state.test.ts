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

const HAPPY_PATH: readonly TaskEvent[] = [
  { type: 'dependencies_satisfied' },
  { type: 'assigned', slaveId: slaveId('alex') },
  { type: 'run_started', runId: runId('run-1') },
  { type: 'run_succeeded' },
  { type: 'verify_passed' },
  { type: 'review_approved' },
  { type: 'merged' },
]

describe('applyTaskEvent — happy path', () => {
  it('starts in backlog', () => {
    expect(initialTaskState(3).status).toBe('backlog')
  })

  it('walks backlog to done', () => {
    expect(drive(initialTaskState(3), HAPPY_PATH).status).toBe('done')
  })

  it('records the assignee and the active run', () => {
    const state = drive(initialTaskState(3), HAPPY_PATH.slice(0, 3))
    expect(state.status).toBe('running')
    expect(state.assigneeId).toBe('alex')
    expect(state.activeRunId).toBe('run-1')
  })

  it('increments the attempt counter when a run starts', () => {
    const state = drive(initialTaskState(3), HAPPY_PATH.slice(0, 3))
    expect(state.attempt).toBe(1)
  })

  it('passes through verifying, reviewing and merging in order', () => {
    const statuses = HAPPY_PATH.reduce<string[]>((acc, event, index) => {
      acc.push(drive(initialTaskState(3), HAPPY_PATH.slice(0, index + 1)).status)
      return acc
    }, [])
    expect(statuses).toEqual([
      'ready', 'assigned', 'running', 'verifying', 'reviewing', 'merging', 'done',
    ])
  })

  it('rejects an event that does not belong to the current status', () => {
    const result = applyTaskEvent(initialTaskState(3), { type: 'verify_passed' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.from).toBe('backlog')
      expect(result.error.event).toBe('verify_passed')
    }
  })
})
