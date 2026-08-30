'use client'

import { Handle, Position, type Edge, type Node, type NodeProps, type NodeTypes } from 'reactflow'
import type { TaskStatus } from '@ai-team-os/domain'
import { BOARD_COLUMNS, COLUMN_FOR_STATUS, COLUMN_STATE, type BoardColumn } from '../../lib/taskColumns'
import { CARD_STATE_TONE, cardStateFor } from '../../lib/tones'
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

// ---- node renderers -----------------------------------------------------------------------------

export function StageNode({ data }: NodeProps<StageNodeData>): React.JSX.Element {
  return (
    <div
      data-testid="stage-node"
      data-column={data.column}
      className={`flex w-[176px] items-center gap-[7px] rounded-card border bg-bg-2 px-[10px] py-[8px] ${TONE_BORDER[data.tone]}`}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <span aria-hidden className={`h-[6px] w-[6px] flex-none rounded-full ${TONE_DOT[data.tone]}`} />
      <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] uppercase tracking-[.06em] text-text-2">{data.column}</span>
      <span data-testid="stage-count" className={`font-mono text-[11px] font-semibold ${TONE_TEXT[data.tone]}`}>
        {data.count}
      </span>
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  )
}

export function StageTaskNode({ data }: NodeProps<StageTaskNodeData>): React.JSX.Element {
  return (
    <div
      data-testid="stage-task-node"
      className={`w-[176px] rounded-tile border px-[10px] py-[8px] ${TONE_BORDER[data.tone]} ${TONE_FILL[data.tone]}`}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <div data-testid="stage-task-ref" className="font-mono text-[9.5px] text-text-3">
        {data.ref}
      </div>
      <div className="truncate text-[11.5px] text-text-1">{data.title}</div>
      <Handle type="source" position={Position.Right} className="!opacity-0" />
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
 * Every node starts at `{x: 0, y: 0}`; `layout.ts`'s `useLayoutedGraph` positions them
 * left-to-right under the `layered` algorithm. This function owns topology and `data`, never
 * coordinates — the same contract `buildOrgGraph`/`buildDepsGraph` follow.
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

  for (const column of BOARD_COLUMNS) {
    const columnTasks = tasksByColumn.get(column) ?? []
    const stageId = `stage:${column}`
    const stageTone = CARD_STATE_TONE[COLUMN_STATE[column]].tone
    nodes.push({
      id: stageId,
      type: 'stage',
      position: origin,
      data: { kind: 'stage', column, count: columnTasks.length, tone: stageTone } satisfies StageNodeData,
    })

    for (const task of columnTasks) {
      const taskNodeId = `execTask:${task.id}`
      nodes.push({
        id: taskNodeId,
        type: 'stageTask',
        position: origin,
        data: {
          kind: 'stageTask',
          title: task.title,
          ref: `TASK-${task.id.slice(0, TASK_REF_LENGTH)}`,
          // `cardStateFor('idle', status)` is the board card's own derivation: this node is about
          // the TASK, and no agent status is in play here.
          tone: CARD_STATE_TONE[cardStateFor('idle', task.status)].tone,
        } satisfies StageTaskNodeData,
      })
      // Stage → its own tasks. Inactive: this edge is containment, not flow.
      edges.push({
        id: `${stageId}->${taskNodeId}`,
        source: stageId,
        target: taskNodeId,
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
      id: `stage:${from}->stage:${to}`,
      source: `stage:${from}`,
      target: `stage:${to}`,
      type: 'cable',
      // The TARGET's tone (design README: "in the target's status colour").
      data: { tone: CARD_STATE_TONE[COLUMN_STATE[to]].tone, active: live },
    })
  }

  return { nodes, edges }
}
