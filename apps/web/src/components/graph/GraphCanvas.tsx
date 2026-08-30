'use client'

import type React from 'react'
import { useEffect } from 'react'
import ReactFlow, {
  Controls,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeTypes,
  type FitViewOptions,
  type Node,
  type NodeMouseHandler,
  type NodeTypes,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { CABLE_EDGE_TYPES } from './CableEdge'

/**
 * The first paint's fit (M14 fix wave, review I7).
 *
 * `maxZoom: 1` because React Flow's own default is `2`: with a handful of nodes the fit is free
 * to magnify, and `graph.png` was committed at roughly 2x -- the fit landed, at twice the mock's
 * density. `padding: 0.2` leaves the design README's breathing room around the outermost node.
 */
export const GRAPH_FIT_VIEW_OPTIONS: FitViewOptions = { maxZoom: 1, padding: 0.2 }

/**
 * Re-fits once ELK has actually positioned the nodes (M14 fix wave, review I7).
 *
 * The bare `fitView` prop runs ONCE, at init -- and at init `layout.ts`'s `useLayoutedGraph` has
 * not resolved yet, so every node is still at the builder's seeded `{x: 0, y: 0}`. Fitting a pile
 * at the origin is what the real app opened on; the gate never saw it because `settleGraph()`
 * waits for the layout and clicks the fit control by hand.
 *
 * Keyed on the node POSITIONS, not just the ids: the async layout pass changes coordinates
 * without changing the set, which is exactly the transition that needs a re-fit. Lives in its own
 * component because `useReactFlow` has to be called under `ReactFlowProvider`.
 */
function FitOnLayout({ nodes }: { readonly nodes: readonly Node[] }): null {
  const { fitView } = useReactFlow()
  const positionKey = nodes.map((node) => `${node.id}@${node.position.x},${node.position.y}`).join('|')

  useEffect(() => {
    if (nodes.length === 0) return
    fitView(GRAPH_FIT_VIEW_OPTIONS)
    // `positionKey` is the dependency; `nodes` itself is a new array identity on every render and
    // would re-fit continuously, fighting an operator's own pan and zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionKey, fitView])

  return null
}

export interface GraphCanvasProps {
  readonly nodes: readonly Node[]
  readonly edges: readonly Edge[]
  readonly nodeTypes: NodeTypes
  /** Defaults to `CABLE_EDGE_TYPES` -- every builder stamps `type: 'cable'`, so no caller has
   *  needed to override this yet; the prop exists so a future mode can. */
  readonly edgeTypes?: EdgeTypes
  readonly onConnect?: (connection: Connection) => void
  readonly onEdgeDelete?: (edgeId: string) => void
  readonly onNodeContextMenu?: NodeMouseHandler
  /** A plain left-click on a node (M14 Task 11: the drawer's opener). Passed straight through, the
   *  same way `onNodeContextMenu` is -- React Flow owns the gesture, this owns nothing about it. */
  readonly onNodeClick?: NodeMouseHandler
}

/**
 * The one React Flow host for every graph mode: org today, deps + edge editing in Tasks 6-7 --
 * callers hand it already-positioned nodes/edges (`layout.ts` owns positioning), and this owns
 * only pan/zoom/`fitView` chrome plus the passthrough wiring later tasks extend via props.
 * `onEdgeDelete` is our own per-edge shape (one id at a time, matching "select an edge, press
 * Delete" -- spec §4.5); it fans out React Flow's own `onEdgesDelete` (plural, one call per
 * batch) so callers don't each re-derive that translation.
 *
 * `onNodeContextMenu` is always wired (unlike the other, purely optional passthrough props): a
 * node with its own menu (`OrgNodes.tsx`'s `AgentNode`/`ActiveTaskNode`, `TaskNodes.tsx`'s
 * `TaskNode` -- Task 7) opens it from its own `onContextMenu` and stops the event there, so this
 * only ever fires for a node with no menu of its own (`WorkspaceNode`/`TeamNode`) -- there this
 * unconditional `preventDefault` is what makes right-clicking one of those a clean no-op instead
 * of popping the browser's own context menu. A caller-supplied handler (none yet) still runs
 * after it.
 *
 * `onNodeClick` (M14 Task 11) is the opposite kind of prop: purely optional, spread in only when
 * supplied, and doing nothing of its own -- a plain left-click on a node had no handler at all
 * before the drawer needed one. `edgeTypes` defaults to `CABLE_EDGE_TYPES`, so every mode's edges
 * render as the design README's cable without each caller registering it.
 */
export function GraphCanvas({
  nodes,
  edges,
  nodeTypes,
  edgeTypes = CABLE_EDGE_TYPES,
  onConnect,
  onEdgeDelete,
  onNodeContextMenu,
  onNodeClick,
}: GraphCanvasProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      {/* The handoff's canvas (design README "1b -- Canvas"): a near-black #08090c ground under a
        * 26px radial-dot grid, drawn as a background-image on this wrapper rather than through React
        * Flow's own `<Background />` (dropped) -- that component paints its own dot pattern, at its
        * own colour and spacing, into an absolutely-positioned SVG, which would have to be fought
        * rather than configured to reach these exact numbers. */}
      <div
        data-testid="graph-canvas"
        className="relative h-full w-full bg-[#08090c] bg-[radial-gradient(rgba(255,255,255,.055)_1px,transparent_1px)] [background-size:26px_26px]"
      >
        {/* The soft teal radial wash across the top (design README "1b -- Canvas"). */}
        <span
          aria-hidden
          data-testid="graph-wash"
          className="pointer-events-none absolute inset-x-0 top-0 z-0 h-1/2 bg-[radial-gradient(ellipse_at_top,rgba(46,230,207,.08),transparent_65%)]"
        />
        <ReactFlow
          nodes={nodes as Node[]}
          edges={edges as Edge[]}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={GRAPH_FIT_VIEW_OPTIONS}
          proOptions={{ hideAttribution: true }}
          onNodeContextMenu={(event, node) => {
            event.preventDefault()
            onNodeContextMenu?.(event, node)
          }}
          {...(onNodeClick === undefined ? {} : { onNodeClick })}
          {...(onConnect === undefined ? {} : { onConnect })}
          {...(onEdgeDelete === undefined
            ? {}
            : { onEdgesDelete: (deleted: Edge[]) => deleted.forEach((edge) => onEdgeDelete(edge.id)) })}
        >
          {/* The fit CONTROL takes the same options (M14 fix wave, review I7). `<Controls>` fits
            * with React Flow's own defaults otherwise, so an operator clicking the affordance --
            * and the gate's `settleGraph()`, which clicks it -- would undo the 1x fit and land
            * back on `maxZoom: 2`. One set of fit options for every way of asking for a fit. */}
          <Controls showInteractive={false} fitViewOptions={GRAPH_FIT_VIEW_OPTIONS} />
          <FitOnLayout nodes={nodes} />
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  )
}
