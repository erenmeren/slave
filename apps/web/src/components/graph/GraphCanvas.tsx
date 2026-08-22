'use client'

import type React from 'react'
import ReactFlow, {
  Background,
  Controls,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeTypes,
} from 'reactflow'
import 'reactflow/dist/style.css'

export interface GraphCanvasProps {
  readonly nodes: readonly Node[]
  readonly edges: readonly Edge[]
  readonly nodeTypes: NodeTypes
  readonly onConnect?: (connection: Connection) => void
  readonly onEdgeDelete?: (edgeId: string) => void
  readonly onNodeContextMenu?: NodeMouseHandler
}

/**
 * The one React Flow host for every graph mode: org today, deps + edge editing in Tasks 6-7 --
 * callers hand it already-positioned nodes/edges (`layout.ts` owns positioning), and this owns
 * only pan/zoom/`fitView` chrome plus the passthrough wiring later tasks extend via props.
 * `onEdgeDelete` is our own per-edge shape (one id at a time, matching "select an edge, press
 * Delete" -- spec §4.5); it fans out React Flow's own `onEdgesDelete` (plural, one call per
 * batch) so callers don't each re-derive that translation.
 */
export function GraphCanvas({ nodes, edges, nodeTypes, onConnect, onEdgeDelete, onNodeContextMenu }: GraphCanvasProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <div data-testid="graph-canvas" className="h-full w-full bg-bg-0">
        <ReactFlow
          nodes={nodes as Node[]}
          edges={edges as Edge[]}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
          {...(onConnect === undefined ? {} : { onConnect })}
          {...(onNodeContextMenu === undefined ? {} : { onNodeContextMenu })}
          {...(onEdgeDelete === undefined
            ? {}
            : { onEdgesDelete: (deleted: Edge[]) => deleted.forEach((edge) => onEdgeDelete(edge.id)) })}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  )
}
