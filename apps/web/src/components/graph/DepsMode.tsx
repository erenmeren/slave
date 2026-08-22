'use client'

import { useMemo, useState } from 'react'
import type { Connection } from 'reactflow'
import type { GraphSnapshot } from '../../server/graph'
import { GraphCanvas } from './GraphCanvas'
import { useLayoutedGraph } from './layout'
import { buildDepsGraph, TASK_NODE_TYPES } from './TaskNodes'

/** Pulls a non-2xx refusal's `{ error }` text, falling back to something nameable for any other
 *  malformed body -- the same shape as `AgentPanel.tsx`'s `errorMessage` (the error band must
 *  never render blank). */
function errorMessage(data: unknown, status: number): string {
  if (data !== null && typeof data === 'object') {
    const value = (data as { error?: unknown }).error
    if (typeof value === 'string') return value
  }
  return `request failed (${status})`
}

/** Bare `fetch` -- the M5 constraint every control mutation in this app follows
 *  (`AgentPanel.tsx`'s `postControl`). No state is written from the response beyond the error
 *  band: no optimistic edge insert, no optimistic edge removal -- the event-driven snapshot
 *  refetch (`useGraph`) owns truth for what edges actually exist. */
async function postDependency(url: string, method: 'POST' | 'DELETE', body?: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response =
      body === undefined
        ? await fetch(url, { method })
        : await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (response.ok) return { ok: true }
    const data: unknown = await response.json().catch(() => null)
    return { ok: false, error: errorMessage(data, response.status) }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

const TASK_NODE_PREFIX = 'task:'

/** `buildDepsGraph` prefixes every task id with `task:` for the node/handle id space (distinct
 *  from org mode's `activeTask:<id>`) -- this is its inverse, the one place that prefix gets
 *  stripped back to the bare task id the dependency routes take. */
function taskIdFromNodeId(nodeId: string): string | null {
  return nodeId.startsWith(TASK_NODE_PREFIX) ? nodeId.slice(TASK_NODE_PREFIX.length) : null
}

/**
 * Dependencies mode (Task 6): the DAG's task nodes plus edge editing. Edges render `dependsOn ->
 * task` (source is the prerequisite, target is the dependent) -- React Flow's `onConnect` hands
 * back `{source, target}` in that same shape, so a drawn connection maps directly to "target task
 * depends on source task": `POST /tasks/<target>/dependencies {dependsOnTaskId: <source>}`.
 * Deleting a selected edge (`GraphCanvas`'s `onEdgeDelete`, fired on Delete-key) reverses the
 * same mapping from the edge's own `source->target` id (`TaskNodes.buildDepsGraph`'s edge id
 * convention) -- `DELETE /tasks/<target>/dependencies/<source>`.
 */
export function DepsMode({ workspaceId, snapshot }: { readonly workspaceId: string; readonly snapshot: GraphSnapshot }): React.JSX.Element {
  const { nodes, edges } = useMemo(() => buildDepsGraph(snapshot), [snapshot])
  const { nodes: positioned, edges: visibleEdges } = useLayoutedGraph(nodes, edges, 'layered')
  const [errorText, setErrorText] = useState<string | null>(null)

  const onConnect = (connection: Connection): void => {
    setErrorText(null)
    const { source, target } = connection
    if (source === null || target === null) return
    const dependsOnTaskId = taskIdFromNodeId(source)
    const taskId = taskIdFromNodeId(target)
    if (dependsOnTaskId === null || taskId === null) return
    void postDependency(`/api/w/${workspaceId}/tasks/${taskId}/dependencies`, 'POST', { dependsOnTaskId }).then((result) => {
      if (!result.ok) setErrorText(result.error)
    })
  }

  const onEdgeDelete = (edgeId: string): void => {
    setErrorText(null)
    const separator = edgeId.indexOf('->')
    if (separator < 0) return
    const dependsOnTaskId = taskIdFromNodeId(edgeId.slice(0, separator))
    const taskId = taskIdFromNodeId(edgeId.slice(separator + 2))
    if (dependsOnTaskId === null || taskId === null) return
    void postDependency(`/api/w/${workspaceId}/tasks/${taskId}/dependencies/${dependsOnTaskId}`, 'DELETE').then((result) => {
      if (!result.ok) setErrorText(result.error)
    })
  }

  return (
    <div className="relative h-full w-full">
      {errorText !== null && (
        <div
          role="alert"
          data-testid="deps-error"
          className="absolute inset-x-0 top-0 z-10 border-b border-status-danger/40 bg-status-danger/10 px-4 py-1.5 text-xs text-status-danger"
        >
          {errorText}
        </div>
      )}
      {snapshot.dependencies.length === 0 && (
        <div
          data-testid="deps-empty"
          className="pointer-events-none absolute inset-x-0 top-10 z-10 text-center text-xs text-text-3"
        >
          no dependencies yet — draw one, or planning arrives in M8
        </div>
      )}
      <GraphCanvas nodes={positioned} edges={visibleEdges} nodeTypes={TASK_NODE_TYPES} onConnect={onConnect} onEdgeDelete={onEdgeDelete} />
    </div>
  )
}
