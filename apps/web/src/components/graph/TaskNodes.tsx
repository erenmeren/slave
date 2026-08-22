'use client'

import type React from 'react'
import { Handle, Position, type Edge, type Node, type NodeProps, type NodeTypes } from 'reactflow'
import type { TaskStatus } from '@ai-team-os/domain'
import type { GraphSnapshot } from '../../server/graph'
import { TASK_STATUS_BORDER, TASK_STATUS_DOT } from '../TaskCard'

// ---- node data shape -------------------------------------------------------------------------

export interface TaskNodeData {
  readonly kind: 'task'
  readonly title: string
  readonly status: TaskStatus
  readonly attempt: number
  readonly maxAttempts: number
  /** Unmet-dependency count, shown as "waiting on N" -- only set for a `ready` task whose
   *  `dependenciesDone` is false (spec: the badge marks a task that *would* run except for an
   *  unmet prerequisite, not every task with a dependency). `null` for every other status,
   *  including `ready` tasks whose dependencies are already all done. */
  readonly waitingOn: number | null
}

// Same guarded-lookup shape as `OrgNodes.tsx`'s `taskDot`/`taskBorder` -- `TASK_STATUS_*` are
// total over `TaskStatus`, but a status value that reached here via a `Map` lookup keyed by id
// (see `buildDepsGraph`) can, in principle, miss.
function taskBorder(status: TaskStatus): string {
  return TASK_STATUS_BORDER[status] ?? TASK_STATUS_BORDER.backlog
}
function taskDot(status: TaskStatus): string {
  return TASK_STATUS_DOT[status] ?? TASK_STATUS_DOT.backlog
}

// ---- node renderer ------------------------------------------------------------------------

export function TaskNode({ data }: NodeProps<TaskNodeData>): React.JSX.Element {
  return (
    <div
      data-testid="task-node"
      data-status={data.status}
      className={`rounded border bg-bg-1 px-3 py-2 ${taskBorder(data.status)}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-1.5">
        <span data-testid="status-dot" className={`inline-block h-2 w-2 shrink-0 rounded-full ${taskDot(data.status)}`} />
        <span className="text-sm text-text-1">{data.title}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-text-2">
        <span data-testid="status-label">{data.status}</span>
        <span data-testid="attempt" className="font-mono">
          {data.attempt}/{data.maxAttempts}
        </span>
        {data.waitingOn !== null && (
          <span data-testid="waiting-badge" className="rounded bg-status-warn/10 px-1 text-status-warn">
            waiting on {data.waitingOn}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

export const TASK_NODE_TYPES: NodeTypes = {
  task: TaskNode,
} as NodeTypes

// ---- graph builder ------------------------------------------------------------------------

/**
 * Unmet-dependency count for `taskId`: the subset of its `dependencies` rows whose
 * `dependsOnTaskId` task is not `done` -- the same "done or not" `server/graph.ts`'s
 * `loadGraphTaskRows` already booleans into `dependenciesDone`, just counted here instead of
 * only checked for zero/nonzero (the "waiting on N" badge needs N, `dependenciesDone` alone only
 * gives whether N is zero).
 */
function unmetDependencyCount(taskId: string, dependencies: GraphSnapshot['dependencies'], statusById: ReadonlyMap<string, TaskStatus>): number {
  let count = 0
  for (const dependency of dependencies) {
    if (dependency.taskId !== taskId) continue
    if (statusById.get(dependency.dependsOnTaskId) !== 'done') count += 1
  }
  return count
}

/**
 * The dependency DAG's task nodes + `dependsOn -> task` edges (Task 6, spec's deps mode): one
 * node per snapshot task (id `task:<id>` -- deliberately distinct from org mode's `activeTask:
 * <id>` satellite, no collision), one edge per `TaskDependency` row, direction `dependsOn ->
 * task` so "this finishes first" reads left to right under the `layered` algorithm. Every node
 * starts at `{x: 0, y: 0}` -- `layout.ts`'s `useLayoutedGraph` positions them, this function only
 * owns topology and node `data`, never coordinates (same split as `OrgNodes.buildOrgGraph`).
 */
export function buildDepsGraph(snapshot: GraphSnapshot): { readonly nodes: Node[]; readonly edges: Edge[] } {
  const origin = { x: 0, y: 0 }
  const statusById = new Map(snapshot.tasks.map((task) => [task.id, task.status]))

  const nodes: Node[] = snapshot.tasks.map((task) => {
    const waitingOn = task.status === 'ready' && !task.dependenciesDone ? unmetDependencyCount(task.id, snapshot.dependencies, statusById) : null
    return {
      id: `task:${task.id}`,
      type: 'task',
      position: origin,
      data: {
        kind: 'task',
        title: task.title,
        status: task.status,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
        waitingOn,
      } satisfies TaskNodeData,
    }
  })

  const edges: Edge[] = snapshot.dependencies.map((dependency) => {
    const source = `task:${dependency.dependsOnTaskId}`
    const target = `task:${dependency.taskId}`
    return { id: `${source}->${target}`, source, target }
  })

  return { nodes, edges }
}
