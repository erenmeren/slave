'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Connection, Edge } from 'reactflow'
import type { GraphSnapshot } from '../../server/graph'
import { errorMessage } from '../../lib/postControl'
import { EDGE_FLASH_MS, outgoingEdgeIds, tasksTurnedDone } from './flow'
import { GraphCanvas } from './GraphCanvas'
import { useLayoutedGraph } from './layout'
import { buildDepsGraph, TASK_NODE_TYPES } from './TaskNodes'

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

/** Plain CSS class (not a Tailwind utility) -- see `globals.css`'s `edge-flash` keyframe doc
 *  comment for why this can't route through `motion-safe:animate-[...]` the way node flashes do. */
const EDGE_FLASH_CLASS_NAME = 'edge-flash'

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

  // Completion wave (spec §6): when a task turns `done` between two snapshots, its outgoing edges
  // (it as the prerequisite) flash once. `previousStatusRef` starts `null` so the very first
  // snapshot this component ever sees never flashes anything (same "no flash on mount" rule the
  // node border-flash idiom follows) -- only a *second* snapshot showing a new `done` counts.
  const previousStatusRef = useRef<ReadonlyMap<string, string> | null>(null)
  const [flashingEdgeIds, setFlashingEdgeIds] = useState<ReadonlySet<string>>(new Set())
  // fix-round-1, Critical: held in a ref, not this effect's own cleanup return. A snapshot refetch
  // (the 250ms debounce plus the completion burst itself -- task.done, run.succeeded, the
  // dependent's start events -- makes one near-certain inside the flash's own 800ms window) re-runs
  // this effect; if that refetch carries no NEW completion, the body returns above before ever
  // touching a clear timer. When the timer WAS this effect's own cleanup, React cancelled it on that
  // re-run and nothing replaced it -- `flashingEdgeIds` got stuck forever, and because
  // `useLayoutedGraph` remounts edges on a node/edge SET change, a later remount replayed the stuck
  // flash on an edge whose task hadn't just completed at all. `useStatusFlash` (`OrgNodes.tsx`/
  // `TaskNodes.tsx`) never had this bug because its dependency is the primitive status itself, which
  // only actually changes when there's something new to flash -- this effect's dependency is the
  // whole `snapshot`, which changes on every refetch regardless. Keeping the timer in a ref removes
  // the coupling: only a genuinely new completion ever touches it, and it fires on its own schedule
  // no matter how many unrelated re-runs of this effect happen in between.
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const currentStatusById = new Map(snapshot.tasks.map((task) => [task.id, task.status]))
    const previous = previousStatusRef.current
    previousStatusRef.current = currentStatusById

    if (previous === null) return
    const turnedDone = tasksTurnedDone(previous, snapshot.tasks)
    if (turnedDone.length === 0) return

    const ids = new Set(turnedDone.flatMap((taskId) => outgoingEdgeIds(edges, taskId)))
    if (ids.size === 0) return

    // Union with whatever's already flashing (a second wave landing before the first one's 800ms
    // elapsed extends rather than replaces it) and restart the single clear timer from here.
    setFlashingEdgeIds((current) => new Set([...current, ...ids]))
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => {
      setFlashingEdgeIds(new Set())
      flashTimerRef.current = null
    }, EDGE_FLASH_MS)
    // `edges` (the pre-layout topology from `buildDepsGraph`) rather than `visibleEdges`: it's
    // always complete (never filtered on a pending async layout) and is exactly what
    // `outgoingEdgeIds` needs to match against.
  }, [snapshot, edges])

  // The only other place the timer is ever cancelled: unmount. A component swap (org <-> deps mode)
  // must not leave a stray `setState` call scheduled against an unmounted `DepsMode`.
  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
    }
  }, [])

  const flashedEdges: Edge[] = useMemo(
    () => visibleEdges.map((edge) => (flashingEdgeIds.has(edge.id) ? { ...edge, className: EDGE_FLASH_CLASS_NAME } : edge)),
    [visibleEdges, flashingEdgeIds],
  )

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
          className="absolute inset-x-0 top-0 z-10 border-b border-tone-blocked/40 bg-tone-blocked/10 px-4 py-1.5 text-xs text-tone-blocked"
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
      <GraphCanvas nodes={positioned} edges={flashedEdges} nodeTypes={TASK_NODE_TYPES} onConnect={onConnect} onEdgeDelete={onEdgeDelete} />
    </div>
  )
}
