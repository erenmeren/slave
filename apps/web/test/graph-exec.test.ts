import { describe, expect, it } from 'vitest'
import type { GraphSnapshot } from '../src/server/graph.js'
import { buildExecutionGraph } from '../src/components/graph/ExecutionNodes.js'

const SHELL_FACTS: GraphSnapshot['shellFacts'] = {
  workspace: { id: 'w1', name: 'W' },
  counts: { agentsWorking: 0, tasksActive: 0 },
  guardrails: { budgetUsd: null, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 },
}

function snapshot(tasks: GraphSnapshot['tasks']): GraphSnapshot {
  return {
    workspace: { id: 'w1', name: 'W', haltedReason: null },
    teams: [],
    agents: [],
    tasks,
    dependencies: [],
    shellFacts: SHELL_FACTS,
  }
}

function task(over: Partial<GraphSnapshot['tasks'][number]>): GraphSnapshot['tasks'][number] {
  return {
    id: 't1',
    title: 'Checkout API',
    status: 'running',
    priority: 2,
    attempt: 0,
    maxAttempts: 3,
    dependenciesDone: true,
    ...over,
  }
}

describe('buildExecutionGraph', () => {
  it('emits the six stages in BOARD_COLUMNS order, always, even with no tasks at all', () => {
    const { nodes } = buildExecutionGraph(snapshot([]))
    const stages = nodes.filter((node) => node.type === 'stage')
    expect(stages.map((node) => node.id)).toEqual([
      'stage:Backlog',
      'stage:Todo',
      'stage:In Progress',
      'stage:Review',
      'stage:Blocked',
      'stage:Done',
    ])
    // A stage with nothing in it is still a stage — the pipeline's shape is the information, and
    // hiding an empty one would make the graph change layout on every tick.
    expect(stages.every((node) => (node.data as { count: number }).count === 0)).toBe(true)
  })

  it('chains the stages left to right, one inactive cable per adjacent pair', () => {
    const { edges } = buildExecutionGraph(snapshot([]))
    expect(edges.map((edge) => edge.id)).toEqual([
      'stage:Backlog->stage:Todo',
      'stage:Todo->stage:In Progress',
      'stage:In Progress->stage:Review',
      'stage:Review->stage:Blocked',
      'stage:Blocked->stage:Done',
    ])
    expect(edges.every((edge) => edge.type === 'cable')).toBe(true)
    expect(edges.every((edge) => (edge.data as { active: boolean }).active === false)).toBe(true)
  })

  it('places each task under the stage its status maps to, via COLUMN_FOR_STATUS', () => {
    const { nodes, edges } = buildExecutionGraph(
      snapshot([
        task({ id: 't1', status: 'running' }),
        task({ id: 't2', status: 'verifying' }),
        task({ id: 't3', status: 'merging' }),
        task({ id: 't4', status: 'cancelled' }),
      ]),
    )
    const parentOf = (taskId: string): string | undefined => edges.find((edge) => edge.target === `execTask:${taskId}`)?.source

    expect(parentOf('t1')).toBe('stage:In Progress')
    expect(parentOf('t2')).toBe('stage:In Progress')
    // `merging` is Review, `cancelled` is Done — the SAME mapping the board uses, imported from
    // `lib/taskColumns.ts`, never re-derived here.
    expect(parentOf('t3')).toBe('stage:Review')
    expect(parentOf('t4')).toBe('stage:Done')

    const inProgress = nodes.find((node) => node.id === 'stage:In Progress')
    expect((inProgress?.data as { count: number }).count).toBe(2)
    expect(nodes.filter((node) => node.type === 'stageTask')).toHaveLength(4)
  })

  it('lights the cable INTO a stage that currently holds live work', () => {
    const { edges } = buildExecutionGraph(snapshot([task({ id: 't1', status: 'running' })]))
    const intoInProgress = edges.find((edge) => edge.id === 'stage:Todo->stage:In Progress')
    expect((intoInProgress?.data as { active: boolean }).active).toBe(true)
    // Nothing is in Review, so its inbound cable stays inactive.
    const intoReview = edges.find((edge) => edge.id === 'stage:In Progress->stage:Review')
    expect((intoReview?.data as { active: boolean }).active).toBe(false)
  })

  it('does not light a stage whose only tasks are at rest', () => {
    const { edges } = buildExecutionGraph(snapshot([task({ id: 't1', status: 'done' }), task({ id: 't2', status: 'backlog' })]))
    expect(edges.every((edge) => (edge.data as { active: boolean }).active === false)).toBe(true)
  })

  it('renders a task node with the same mono reference the board uses, and its tone', () => {
    const { nodes } = buildExecutionGraph(snapshot([task({ id: '3f9a21c8-0000-4000-8000-000000000000', status: 'blocked' })]))
    const node = nodes.find((n) => n.type === 'stageTask')
    expect((node?.data as { ref: string }).ref).toBe('TASK-3f9a21c8')
    expect((node?.data as { tone: string }).tone).toBe('blocked')
  })

  it('seeds every node at the origin — this builder owns topology and data, never coordinates', () => {
    const { nodes } = buildExecutionGraph(snapshot([task({ id: 't1', status: 'running' })]))
    expect(nodes.every((node) => node.position.x === 0 && node.position.y === 0)).toBe(true)
  })
})
