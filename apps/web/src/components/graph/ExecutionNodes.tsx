'use client'

import { Handle, Position, type Edge, type Node, type NodeProps, type NodeTypes } from 'reactflow'
import type { TaskStatus } from '@slave-of-ai/domain'
import { BOARD_COLUMNS, COLUMN_FOR_STATUS, COLUMN_STATE, type BoardColumn } from '../../lib/taskColumns'
import { CARD_STATE_TONE, cardStateForTask } from '../../lib/tones'
import type { GraphSnapshot } from '../../server/graph'
import { TONE_BORDER, TONE_DOT, TONE_FILL, TONE_TEXT, type StatusTone } from '../ui/StatusPill'

// ---- node data shapes ---------------------------------------------------------------------------

/** A pipeline stage node — one per `BOARD_COLUMNS` member, laid out left→right. */
export interface StageNodeData {
  readonly kind: 'stage'
  readonly column: BoardColumn
  readonly count: number
  readonly tone: StatusTone
}

/** One task, rendered compactly beneath the stage its status maps to. */
export interface StageTaskNodeData {
  readonly kind: 'stageTask'
  readonly title: string
  readonly ref: string
  readonly tone: StatusTone
  /** The stage this task hangs under — the same value `COLUMN_FOR_STATUS` gave it. Carried on the
   *  node so `placeExecutionTasks` is a pure function of the NODE list alone, with no second walk
   *  over the containment edges to rediscover a parent the builder already knew. */
  readonly column: BoardColumn
}

/**
 * Statuses that mean work is happening in a stage RIGHT NOW — what lights the cable into it
 * (design README "1b — Modes": Execution is the pipeline, and a live pipeline is the point).
 * `blocked` and `backlog` are at rest: something is sitting there, not moving through.
 *
 * Typed `Record<...>`-free but pinned to `TaskStatus` members so a rename in the domain is a
 * build error here rather than a cable that silently stops lighting.
 */
const LIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['running', 'verifying', 'reviewing', 'merging'])

/** The `TASK-<8 chars>` reference the board card and the agent card already render. */
const TASK_REF_LENGTH = 8

/** Node-id prefixes. Exported because `GraphClient`'s `ExecutionMode` splits the graph on them:
 *  ELK is handed the STAGE CHAIN only (see `placeExecutionTasks`). */
export const STAGE_NODE_PREFIX = 'stage:'
export const EXEC_TASK_NODE_PREFIX = 'execTask:'

/**
 * The rendered footprints `placeExecutionTasks` stacks against — `StageNode` is one text row inside
 * `py-[8px]` plus its border, `StageTaskNode` is two inside the same. Static numbers rather than
 * DOM measurement, the same trade `layout.ts`'s `DEFAULT_SIZE` makes and for the same reason: at
 * tens of nodes, measuring costs a reflow to buy nothing.
 */
export const STAGE_NODE_HEIGHT = 34
export const TASK_NODE_HEIGHT = 48
/** Vertical breathing room between a stage and its first task, and between two tasks. */
export const EXECUTION_NODE_GAP = 14

/** Handle ids. A node with two source handles needs them named, and the edges stamp which one they
 *  leave from: the chain runs left→right across the stage row, containment runs straight down. */
const STAGE_CHAIN_IN = 'chain-in'
const STAGE_CHAIN_OUT = 'chain-out'
const STAGE_TASKS_OUT = 'tasks-out'
const STAGE_TASK_IN = 'stage-in'

// ---- node renderers -----------------------------------------------------------------------------

export function StageNode({ data }: NodeProps<StageNodeData>): React.JSX.Element {
  return (
    <div
      data-testid="stage-node"
      data-column={data.column}
      className={`flex w-[176px] items-center gap-[7px] rounded-card border bg-bg-2 px-[10px] py-[8px] ${TONE_BORDER[data.tone]}`}
    >
      <Handle type="target" position={Position.Left} id={STAGE_CHAIN_IN} className="!opacity-0" />
      <span aria-hidden className={`h-[6px] w-[6px] flex-none rounded-full ${TONE_DOT[data.tone]}`} />
      <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] uppercase tracking-[.06em] text-text-2">{data.column}</span>
      <span data-testid="stage-count" className={`font-mono text-[11px] font-semibold ${TONE_TEXT[data.tone]}`}>
        {data.count}
      </span>
      <Handle type="source" position={Position.Right} id={STAGE_CHAIN_OUT} className="!opacity-0" />
      {/* The containment cable leaves from the BOTTOM: its tasks sit directly below, so a
        * right-edge exit would loop back on itself across the column. */}
      <Handle type="source" position={Position.Bottom} id={STAGE_TASKS_OUT} className="!opacity-0" />
    </div>
  )
}

export function StageTaskNode({ data }: NodeProps<StageTaskNodeData>): React.JSX.Element {
  return (
    // Two layers on purpose: `bg-bg-2` is OPAQUE, so the containment cables running down the column
    // pass invisibly BEHIND the stack (React Flow paints nodes above edges) and read as one spine
    // rather than crossing each card. The tone tint has to sit on an inner element because
    // `TONE_FILL` is a `background-color` and would otherwise replace that opaque base.
    <div
      data-testid="stage-task-node"
      className={`w-[176px] overflow-hidden rounded-tile border bg-bg-2 ${TONE_BORDER[data.tone]}`}
    >
      <Handle type="target" position={Position.Top} id={STAGE_TASK_IN} className="!opacity-0" />
      <div className={`px-[10px] py-[8px] ${TONE_FILL[data.tone]}`}>
        <div data-testid="stage-task-ref" className="font-mono text-[9.5px] text-text-3">
          {data.ref}
        </div>
        <div className="truncate text-[11.5px] text-text-1">{data.title}</div>
      </div>
    </div>
  )
}

export const EXECUTION_NODE_TYPES: NodeTypes = { stage: StageNode, stageTask: StageTaskNode } as NodeTypes

// ---- graph builder ------------------------------------------------------------------------------

/**
 * Execution mode (design README §3a.4 / "1b — Modes": "Execution (pipeline stages)") — its OWN
 * node set, not Dependencies re-labelled.
 *
 * The stages are `BOARD_COLUMNS` and the placement is `COLUMN_FOR_STATUS`, both imported from
 * `lib/taskColumns.ts` (Task 10) rather than restated: the board and this graph must never
 * disagree about which column a `merging` task belongs to, and two tables that agree today are two
 * tables that disagree after the first edit.
 *
 * Every node starts at `{x: 0, y: 0}`. ELK positions the STAGE ROW only (see
 * `placeExecutionTasks` below for why), and the tasks are stacked under their own stage from
 * there. This function owns topology, `data` and the within-stage ORDER; it owns no coordinates.
 *
 * Pure: same snapshot in, same nodes and edges out. No React, no layout, no coordinates.
 */
export function buildExecutionGraph(snapshot: GraphSnapshot): { readonly nodes: Node[]; readonly edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const origin = { x: 0, y: 0 }

  // Seeded with every column, so an empty stage is still a stage — the pipeline's SHAPE is the
  // information, and a graph that drops its empty columns re-lays-out on every tick.
  const tasksByColumn = new Map<BoardColumn, GraphSnapshot['tasks'][number][]>(BOARD_COLUMNS.map((column) => [column, []]))
  for (const task of snapshot.tasks) {
    tasksByColumn.get(COLUMN_FOR_STATUS[task.status])?.push(task)
  }

  // Within a stage, highest priority sits at the top of the stack -- the same `priority desc`
  // order the board's own query uses, so a task does not swap places between the two surfaces.
  // The id tiebreak is what makes the order TOTAL: `loadGraphTaskRows` has no `ORDER BY` at all,
  // so equal-priority tasks would otherwise stack in whatever order Postgres returned them.
  for (const columnTasks of tasksByColumn.values()) {
    columnTasks.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  }

  for (const column of BOARD_COLUMNS) {
    const columnTasks = tasksByColumn.get(column) ?? []
    const stageId = `${STAGE_NODE_PREFIX}${column}`
    const stageTone = CARD_STATE_TONE[COLUMN_STATE[column]].tone
    nodes.push({
      id: stageId,
      type: 'stage',
      position: origin,
      data: { kind: 'stage', column, count: columnTasks.length, tone: stageTone } satisfies StageNodeData,
    })

    for (const task of columnTasks) {
      const taskNodeId = `${EXEC_TASK_NODE_PREFIX}${task.id}`
      nodes.push({
        id: taskNodeId,
        type: 'stageTask',
        position: origin,
        data: {
          kind: 'stageTask',
          title: task.title,
          ref: `TASK-${task.id.slice(0, TASK_REF_LENGTH)}`,
          // `cardStateForTask` is the board card's own derivation: this node is about the TASK,
          // and no agent status is in play here (M14 fix wave, review I2 — this used to pass a
          // fake idle agent through `cardStateFor` and paint a live task's node grey).
          tone: CARD_STATE_TONE[cardStateForTask(task.status)].tone,
          column,
        } satisfies StageTaskNodeData,
      })
      // Stage → its own tasks. Inactive: this edge is containment, not flow. It is deliberately
      // NOT part of what ELK lays out -- see `placeExecutionTasks`.
      edges.push({
        id: `${stageId}->${taskNodeId}`,
        source: stageId,
        target: taskNodeId,
        sourceHandle: STAGE_TASKS_OUT,
        targetHandle: STAGE_TASK_IN,
        type: 'cable',
        data: { tone: stageTone, active: false },
      })
    }
  }

  // The pipeline itself: stage → next stage. A cable is LIVE when the stage it points INTO holds
  // work that is actually moving right now — `LIVE_STATUSES` above, not merely "is non-empty".
  for (let index = 0; index < BOARD_COLUMNS.length - 1; index += 1) {
    const from = BOARD_COLUMNS[index] as BoardColumn
    const to = BOARD_COLUMNS[index + 1] as BoardColumn
    const live = (tasksByColumn.get(to) ?? []).some((task) => LIVE_STATUSES.has(task.status))
    edges.push({
      id: `${STAGE_NODE_PREFIX}${from}->${STAGE_NODE_PREFIX}${to}`,
      source: `${STAGE_NODE_PREFIX}${from}`,
      target: `${STAGE_NODE_PREFIX}${to}`,
      sourceHandle: STAGE_CHAIN_OUT,
      targetHandle: STAGE_CHAIN_IN,
      type: 'cable',
      // The TARGET's tone (design README: "in the target's status colour").
      data: { tone: CARD_STATE_TONE[COLUMN_STATE[to]].tone, active: live },
    })
  }

  return { nodes, edges }
}

/**
 * Stacks each stage's tasks in that stage's OWN column, from wherever ELK left the stage.
 *
 * Fix round 1, Important 3. The obvious wiring -- hand ELK the whole graph, containment edges
 * included -- is wrong in a way that is easy to miss and bad to ship: `elk.algorithm: layered` with
 * `elk.direction: RIGHT` assigns a node's layer by longest path from a source, so `stage:Backlog`
 * is layer 0 and BOTH `stage:Todo` and Backlog's own tasks land in layer 1. A Backlog task rendered
 * one column right of its own heading, directly under "Todo" -- a viewer reading a column would
 * count the wrong tasks under the wrong stage. Making ELK do it properly needs `elk.partitioning`
 * plus a per-node partition option, which means `layoutGraph` reading something off `node.data`;
 * giving ELK only the stage chain and doing this one-dimensional stack here costs less and says
 * more.
 *
 * Pure, total and idempotent: a task's position is a function of its stage's position and its own
 * index within that stage, so running this over an already-placed set moves nothing. A task whose
 * stage is somehow absent keeps the position it came in with rather than being dropped.
 */
export function placeExecutionTasks(nodes: readonly Node[]): Node[] {
  const stagePositionByColumn = new Map<BoardColumn, { readonly x: number; readonly y: number }>()
  for (const node of nodes) {
    if (node.type === 'stage') stagePositionByColumn.set((node.data as StageNodeData).column, node.position)
  }

  const placedSoFar = new Map<BoardColumn, number>()
  return nodes.map((node) => {
    if (node.type !== 'stageTask') return node
    const { column } = node.data as StageTaskNodeData
    const stage = stagePositionByColumn.get(column)
    if (stage === undefined) return node
    const index = placedSoFar.get(column) ?? 0
    placedSoFar.set(column, index + 1)
    return {
      ...node,
      position: {
        x: stage.x,
        y: stage.y + STAGE_NODE_HEIGHT + EXECUTION_NODE_GAP + index * (TASK_NODE_HEIGHT + EXECUTION_NODE_GAP),
      },
    }
  })
}
