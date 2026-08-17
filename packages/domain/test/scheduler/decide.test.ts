import { describe, expect, it } from 'vitest'
import { agentId, taskId } from '../../src/ids.js'
import { DEFAULT_GUARDRAIL_LIMITS } from '../../src/guardrails/evaluate.js'
import {
  decide,
  type Command,
  type SchedulableAgent,
  type SchedulableTask,
  type World,
} from '../../src/scheduler/decide.js'

const alex: SchedulableAgent = { id: agentId('alex'), role: 'backend', busy: false }
const emma: SchedulableAgent = { id: agentId('emma'), role: 'frontend', busy: false }

/** Command is a union; narrow before reading taskId so the tests type-check. */
function startedTaskIds(commands: readonly Command[]): readonly string[] {
  return commands.flatMap((c) => (c.kind === 'start_run' ? [c.taskId as string] : []))
}

function task(id: string, overrides: Partial<SchedulableTask> = {}): SchedulableTask {
  return {
    id: taskId(id),
    status: 'ready',
    requiredRole: 'backend',
    priority: 1,
    dependenciesDone: true,
    ...overrides,
  }
}

function world(overrides: Partial<World> = {}): World {
  return {
    tasks: [],
    agents: [alex, emma],
    limits: DEFAULT_GUARDRAIL_LIMITS,
    stats: { activeRuns: 0, spentUsd: 0, consecutiveFailures: 0, emergencyStopped: false },
    ...overrides,
  }
}

describe('decide', () => {
  it('starts nothing when there is nothing to do', () => {
    expect(decide(world())).toEqual([])
  })

  it('starts a ready task on a matching free agent', () => {
    const commands = decide(world({ tasks: [task('TASK-1')] }))
    expect(commands).toEqual([{ kind: 'start_run', taskId: 'TASK-1', agentId: 'alex' }])
  })

  it('starts a rework task too', () => {
    const commands = decide(world({ tasks: [task('TASK-1', { status: 'rework' })] }))
    expect(commands).toHaveLength(1)
  })

  it('ignores tasks whose dependencies are unmet', () => {
    expect(decide(world({ tasks: [task('TASK-1', { dependenciesDone: false })] }))).toEqual([])
  })

  it('ignores tasks in a non-startable status', () => {
    expect(decide(world({ tasks: [task('TASK-1', { status: 'running' })] }))).toEqual([])
  })

  it('leaves a task unscheduled when no agent has the required role', () => {
    expect(decide(world({ tasks: [task('TASK-1', { requiredRole: 'security' })] }))).toEqual([])
  })

  it('does not assign two tasks to the same agent in one tick', () => {
    const commands = decide(world({ tasks: [task('TASK-1'), task('TASK-2')] }))
    expect(startedTaskIds(commands)).toEqual(['TASK-1'])
  })

  it('schedules different roles in parallel', () => {
    const commands = decide(
      world({ tasks: [task('TASK-1'), task('TASK-2', { requiredRole: 'frontend' })] }),
    )
    expect(startedTaskIds(commands)).toEqual(['TASK-1', 'TASK-2'])
  })

  it('prefers higher priority, breaking ties by task id', () => {
    const commands = decide(
      world({ tasks: [task('TASK-9', { priority: 1 }), task('TASK-2', { priority: 5 })] }),
    )
    expect(startedTaskIds(commands)).toEqual(['TASK-2'])
  })

  it('respects the remaining concurrency budget', () => {
    const commands = decide(
      world({
        tasks: [task('TASK-1'), task('TASK-2', { requiredRole: 'frontend' })],
        stats: { activeRuns: 2, spentUsd: 0, consecutiveFailures: 0, emergencyStopped: false },
      }),
    )
    expect(commands).toHaveLength(1)
  })

  it('halts instead of scheduling when a guardrail trips', () => {
    const commands = decide(
      world({
        tasks: [task('TASK-1')],
        stats: { activeRuns: 0, spentUsd: 20, consecutiveFailures: 0, emergencyStopped: false },
      }),
    )
    expect(commands).toEqual([{ kind: 'halt', reason: 'budget_exhausted' }])
  })

  it('skips busy agents', () => {
    const commands = decide(
      world({ tasks: [task('TASK-1')], agents: [{ ...alex, busy: true }, emma] }),
    )
    expect(commands).toEqual([])
  })
})
