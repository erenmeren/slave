'use client'

import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Handle, Position, type Edge, type Node, type NodeProps, type NodeTypes } from 'reactflow'
import type { TaskStatus } from '@slave-of-ai/domain'
import { CARD_STATE_TONE, cardStateForTask } from '../../lib/tones'
import type { GraphSnapshot } from '../../server/graph'
import { BORDER_FLASH_MS } from '../AgentCard'
import { TASK_STATUS_BORDER, TASK_STATUS_DOT, TASK_STATUS_FLASH_COLOR } from '../TaskCard'
import { NodeMenu } from './NodeMenu'

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
  /** Same "carried on node data" reasoning as `OrgNodes.tsx`'s `AgentNodeData.workspaceId` --
   *  needed for this node's `NodeMenu` hrefs. */
  readonly workspaceId: string
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

function taskFlashColor(status: TaskStatus): string {
  return TASK_STATUS_FLASH_COLOR[status] ?? TASK_STATUS_FLASH_COLOR.backlog
}

/** The M5 border-flash idiom (`AgentCard.tsx`), copied into this file the same way `OrgNodes.tsx`'s
 *  own copy is (spec §6) -- only a status *change* flashes, never the initial mount. */
function useStatusFlash(status: TaskStatus): boolean {
  const previous = useRef(status)
  const [flashing, setFlashing] = useState(false)
  useEffect((): (() => void) | void => {
    if (previous.current === status) return
    previous.current = status
    setFlashing(true)
    const timer = setTimeout(() => setFlashing(false), BORDER_FLASH_MS)
    return () => clearTimeout(timer)
  }, [status])
  return flashing
}

const FLASH_CLASS = 'motion-safe:animate-[border-flash_800ms_ease-out]'

// ---- node renderer ------------------------------------------------------------------------

const TASK_NODE_PREFIX = 'task:'

export function TaskNode({ id, data }: NodeProps<TaskNodeData>): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const taskId = id.startsWith(TASK_NODE_PREFIX) ? id.slice(TASK_NODE_PREFIX.length) : id
  const flashing = useStatusFlash(data.status)
  return (
    <div
      data-testid="task-node"
      data-status={data.status}
      className={`group relative rounded border bg-bg-1 px-3 py-2 ${taskBorder(data.status)} ${flashing ? FLASH_CLASS : ''}`}
      style={flashing ? ({ '--flash-color': taskFlashColor(data.status) } as React.CSSProperties) : undefined}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenuOpen(true)
      }}
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
          <span data-testid="waiting-badge" className="rounded bg-tone-waiting/10 px-1 text-tone-waiting">
            waiting on {data.waitingOn}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
      <NodeMenu kind="task" workspaceId={data.workspaceId} id={taskId} open={menuOpen} onOpenChange={setMenuOpen} />
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
 * task` so "this finishes first" reads left to right under the `layered` algorithm. Every edge is
 * a `cable` (M14 Task 11 -- `CableEdge.tsx`) in its target's tone, lit once its prerequisite is
 * done. Every node
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
        workspaceId: snapshot.workspace.id,
      } satisfies TaskNodeData,
    }
  })

  const edges: Edge[] = snapshot.dependencies.map((dependency) => {
    const source = `task:${dependency.dependsOnTaskId}`
    const target = `task:${dependency.taskId}`
    // The TARGET's own state, through `cardStateForTask` -- the task-only derivation (M14 fix
    // wave, review I2). This used to be `cardStateFor('idle', status)`, which handed the
    // AGENT-first derivation a fake idle agent and drew every cable into a `running`, `assigned`
    // or `verifying` task in the grey idle tone. `undefined` only for a dependency row pointing
    // outside the snapshot's own task set; `idle` is the honest tone for a target we cannot see.
    const targetStatus = statusById.get(dependency.taskId)
    return {
      id: `${source}->${target}`,
      source,
      target,
      type: 'cable',
      // The TARGET's tone (design README "1b -- Cables"), and "active" means the prerequisite is
      // satisfied: the way is CLEAR along this cable, which is the one thing a dependency edge
      // has to say. An unmet prerequisite draws as the flat inactive line.
      data: {
        tone: CARD_STATE_TONE[targetStatus === undefined ? 'idle' : cardStateForTask(targetStatus)].tone,
        active: statusById.get(dependency.dependsOnTaskId) === 'done',
      },
    }
  })

  return { nodes, edges }
}
