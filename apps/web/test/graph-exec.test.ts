import { describe, expect, it } from 'vitest'
import type { Node } from 'reactflow'
import type { GraphSnapshot } from '../src/server/graph.js'
import { BOARD_COLUMNS, type BoardColumn } from '../src/lib/taskColumns.js'
import {
  buildExecutionGraph,
  placeExecutionTasks,
  STAGE_NODE_HEIGHT,
  STAGE_NODE_PREFIX,
  type StageNodeData,
  type StageTaskNodeData,
} from '../src/components/graph/ExecutionNodes.js'

const SHELL_FACTS: GraphSnapshot['shellFacts'] = {
  workspace: { id: 'w1', name: 'W' },
  counts: { slavesWorking: 0, tasksActive: 0 },
  guardrails: { budgetUsd: null, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 },
  status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: null },
}

function snapshot(tasks: GraphSnapshot['tasks']): GraphSnapshot {
  return {
    workspace: { id: 'w1', name: 'W', haltedReason: null },
    teams: [],
    slaves: [],
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

  // M14 fix wave, review I2: this node used to take its tone from `cardStateFor('idle', status)`,
  // which painted every live task on the execution graph the grey idle tone.
  it('gives a running task node the working tone of the stage it hangs under, not idle', () => {
    const { nodes } = buildExecutionGraph(snapshot([task({ id: 't1', status: 'running' })]))
    const node = nodes.find((n) => n.type === 'stageTask')
    expect((node?.data as { tone: string }).tone).toBe('working')
    expect((node?.data as StageTaskNodeData).column).toBe('In Progress')
  })

  // M16 Task 8: the Tasks board reads a `reviewing` task's pill as the review tone (purple), via
  // the same `lib/tones.ts` table. This node must read the same fact from the same table, not a
  // local mapping that drifts from it and falls back to grey.
  it('gives a reviewing task node the review tone, the same table the Tasks board reads', () => {
    const { nodes } = buildExecutionGraph(snapshot([task({ id: 't1', status: 'reviewing' })]))
    const node = nodes.find((n) => n.type === 'stageTask')
    expect((node?.data as { tone: string }).tone).toBe('review')
    expect((node?.data as StageTaskNodeData).column).toBe('Review')
  })

  it('leaves every STAGE at the origin — ELK owns the stage chain\'s coordinates, this does not', () => {
    const { nodes } = buildExecutionGraph(snapshot([task({ id: 't1', status: 'running' })]))
    const stages = nodes.filter((node) => node.type === 'stage')
    expect(stages.every((node) => node.position.x === 0 && node.position.y === 0)).toBe(true)
  })

  it('separates the stage chain from the containment edges by node-id prefix, so ELK can be given only the chain', () => {
    const { edges } = buildExecutionGraph(snapshot([task({ id: 't1', status: 'running' }), task({ id: 't2', status: 'blocked' })]))
    const chain = edges.filter((edge) => edge.source.startsWith(STAGE_NODE_PREFIX) && edge.target.startsWith(STAGE_NODE_PREFIX))
    expect(chain).toHaveLength(BOARD_COLUMNS.length - 1)
    expect(edges).toHaveLength(chain.length + 2)
  })
})

// ==================================================================================================
// Fix round 1, Important 3: ELK lays out the STAGE CHAIN only. Feeding it the containment edges made
// `layered`/RIGHT assign a stage's own tasks to the NEXT stage's layer -- a Backlog task rendered
// under the Todo heading. `placeExecutionTasks` stacks each stage's tasks in that stage's own
// column instead, from whatever position ELK gave the stage.
// ==================================================================================================

const COLUMN_X = 240
const STAGE_Y = 40

/** The stage row as ELK's `layered`/RIGHT pass leaves it: one column per stage, all on one row. */
function withStagesLaidOut(nodes: readonly Node[]): Node[] {
  return nodes.map((node) =>
    node.type === 'stage'
      ? { ...node, position: { x: BOARD_COLUMNS.indexOf((node.data as StageNodeData).column) * COLUMN_X, y: STAGE_Y } }
      : node,
  )
}

function placed(tasks: GraphSnapshot['tasks']): Node[] {
  return placeExecutionTasks(withStagesLaidOut(buildExecutionGraph(snapshot(tasks)).nodes))
}

describe('placeExecutionTasks', () => {
  it('puts every task in its OWN stage\'s column, never the next one\'s', () => {
    const nodes = placed([
      task({ id: 't1', status: 'backlog' }),
      task({ id: 't2', status: 'running' }),
      task({ id: 't3', status: 'merging' }),
      task({ id: 't4', status: 'done' }),
    ])
    const stageX = new Map(
      nodes.filter((node) => node.type === 'stage').map((node) => [(node.data as StageNodeData).column, node.position.x]),
    )

    for (const node of nodes.filter((n) => n.type === 'stageTask')) {
      expect(node.position.x).toBe(stageX.get((node.data as StageTaskNodeData).column))
    }
    // And the columns really are distinct, so the assertion above is not vacuously true.
    expect(new Set(nodes.filter((n) => n.type === 'stageTask').map((n) => n.position.x)).size).toBe(4)
  })

  it('clears every stage\'s own y band — a task never overlaps the heading it hangs under', () => {
    const nodes = placed([task({ id: 't1', status: 'running' }), task({ id: 't2', status: 'verifying' })])
    for (const node of nodes.filter((n) => n.type === 'stageTask')) {
      expect(node.position.y).toBeGreaterThanOrEqual(STAGE_Y + STAGE_NODE_HEIGHT)
    }
  })

  it('stacks a stage\'s tasks downward in priority order, highest first, with no two at the same y', () => {
    const nodes = placed([
      task({ id: 'low', status: 'running', priority: 0 }),
      task({ id: 'urgent', status: 'running', priority: 4 }),
      task({ id: 'mid', status: 'verifying', priority: 2 }),
    ])
    const stacked = nodes
      .filter((node) => node.type === 'stageTask')
      .sort((a, b) => a.position.y - b.position.y)

    expect(stacked.map((node) => node.id)).toEqual(['execTask:urgent', 'execTask:mid', 'execTask:low'])
    expect(new Set(stacked.map((node) => node.position.y)).size).toBe(3)
  })

  it('leaves the stage row exactly where ELK put it', () => {
    const nodes = placed([task({ id: 't1', status: 'running' })])
    const stages = nodes.filter((node) => node.type === 'stage')
    expect(stages.map((node) => node.id)).toEqual(BOARD_COLUMNS.map((column: BoardColumn) => `stage:${column}`))
    expect(stages.map((node) => node.position.x)).toEqual(BOARD_COLUMNS.map((_c, index) => index * COLUMN_X))
    expect(stages.every((node) => node.position.y === STAGE_Y)).toBe(true)
  })

  it('is idempotent — re-placing an already-placed set moves nothing', () => {
    const once = placed([task({ id: 't1', status: 'running' }), task({ id: 't2', status: 'running' })])
    const twice = placeExecutionTasks(once)
    expect(twice.map((node) => node.position)).toEqual(once.map((node) => node.position))
  })
})
