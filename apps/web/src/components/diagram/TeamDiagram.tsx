'use client'

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, { BaseEdge, Controls, EdgeLabelRenderer, Handle, Position, ReactFlowProvider, getBezierPath, useReactFlow, useStore, type Edge, type EdgeProps, type EdgeTypes, type FitViewOptions, type Node, type NodeProps, type NodeTypes } from 'reactflow'
import 'reactflow/dist/style.css'
import type { BuildDiagram } from '@slave-of-ai/control'
import { layoutDiagram, type Direction, type Positions } from './layout'
import { NodeCard } from './NodeCard'
import { diagramShape, layoutKey, type CardData, type CardSpec, type LineSpec } from './shape'
import { TONE_STROKE } from './words'

/** Who or what the side panel is about: a node of the diagram, or one session of it. */
export interface DiagramSubject {
  readonly nodeId: string
  readonly sessionId: string | null
}

/** Never magnify a small team past its real size; leave air around the outermost card. */
const FIT: FitViewOptions = { maxZoom: 1, padding: 0.12 }
/** On a phone the whole team would be too small to read: keep the cards legible and let the person pan. */
const FIT_NARROW: FitViewOptions = { maxZoom: 1, minZoom: 0.6, padding: 0.08 }
const NARROW = 640

const Canvas = createContext<{ readonly direction: Direction; readonly onToggle: (nodeId: string) => void }>({ direction: 'RIGHT', onToggle: () => undefined })

function CardNode({ data }: NodeProps<CardSpec>): React.JSX.Element {
  const { direction, onToggle } = useContext(Canvas)
  const card: CardData = data.data
  return (
    <>
      {card.kind !== 'request' && <Handle type="target" position={direction === 'RIGHT' ? Position.Left : Position.Top} isConnectable={false} className="!opacity-0" />}
      <NodeCard data={card} width={data.width} height={data.height} onToggle={() => onToggle(card.nodeId)} />
      {card.kind !== 'result' && <Handle type="source" position={direction === 'RIGHT' ? Position.Right : Position.Bottom} isConnectable={false} className="!opacity-0" />}
    </>
  )
}

/**
 * A line with its words just before the card it arrives at. Every card has one line coming in, so
 * words placed there never sit on another line's words -- at a line's middle, where several lines
 * leave the lead together, they would.
 */
function LineEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, style }: EdgeProps<LineSpec>): React.JSX.Element {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const down = targetPosition === Position.Top
  return (
    <>
      <BaseEdge path={path} {...(style === undefined ? {} : { style })} />
      {data !== undefined && data.label !== null && (
        <EdgeLabelRenderer>
          <span
            data-testid="diagram-line-label"
            className="absolute rounded-md border bg-background px-1.5 py-0.5 text-[11px] leading-tight font-medium whitespace-nowrap text-foreground"
            style={{ transform: down ? `translate(-50%, -100%) translate(${String(targetX)}px, ${String(targetY - 10)}px)` : `translate(-100%, -50%) translate(${String(targetX - 12)}px, ${String(targetY)}px)` }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const NODE_TYPES: NodeTypes = { card: CardNode }
const EDGE_TYPES: EdgeTypes = { line: LineEdge }

/**
 * Fits the view once the cards are placed and measured, and again only when the layout itself
 * changes: a re-read that changes what a card says leaves the person's pan and zoom alone.
 */
function FitOnLayout({ layout, fit }: { readonly layout: string; readonly fit: FitViewOptions }): null {
  const { fitView } = useReactFlow()
  const measured = useStore((state) => Array.from(state.nodeInternals.values()).every((node) => node.hidden === true || (node.width ?? 0) > 0))
  const count = useStore((state) => state.nodeInternals.size)
  useEffect(() => {
    if (layout === '' || !measured || count === 0) return
    const frame = requestAnimationFrame(() => fitView(fit))
    return (): void => cancelAnimationFrame(frame)
  }, [layout, measured, count, fitView, fit])
  return null
}

/**
 * The team diagram: You, the lead, each helper session it started, the checkers and the result,
 * laid out in layers. The layout runs when the set of cards or lines changes and at no other
 * time, so between two reads of a running build every card stays where it is and only its words
 * move. Pressing a card opens its details.
 */
export function TeamDiagram({ build, onSelect }: { readonly build: BuildDiagram; readonly onSelect: (subject: DiagramSubject) => void }): React.JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [direction, setDirection] = useState<Direction>('RIGHT')
  const [placed, setPlaced] = useState<{ readonly key: string; readonly positions: Positions }>({ key: '', positions: new Map() })
  const [failed, setFailed] = useState(false)
  const frame = useRef<HTMLDivElement>(null)

  // Left to right where there is room for it, top to bottom on a phone.
  useEffect(() => {
    const element = frame.current
    if (element === null) return
    const read = (): void => {
      if (element.clientWidth > 0) setDirection(element.clientWidth < NARROW ? 'DOWN' : 'RIGHT')
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return (): void => observer.disconnect()
  }, [])

  const shape = useMemo(() => diagramShape(build, expanded), [build, expanded])
  const key = layoutKey(shape, direction)
  const latest = useRef(shape)
  latest.current = shape

  useEffect(() => {
    let stale = false
    layoutDiagram(latest.current, direction).then(
      (positions) => {
        if (stale) return
        setFailed(false)
        setPlaced({ key, positions })
      },
      () => {
        if (!stale) setFailed(true)
      },
    )
    return (): void => {
      stale = true
    }
    // The key alone: it names everything the layout reads from the shape.
  }, [key, direction])

  const nodes = useMemo(
    (): Node<CardSpec>[] =>
      shape.cards.map((card) => {
        const position = placed.positions.get(card.id)
        return { id: card.id, type: 'card', data: card, position: position ?? { x: 0, y: 0 }, hidden: position === undefined, draggable: false, connectable: false, width: card.width, height: card.height }
      }),
    [shape, placed],
  )
  const edges = useMemo(
    (): Edge<LineSpec>[] =>
      shape.lines.map((line) => ({
        id: line.id,
        type: 'line',
        source: line.source,
        target: line.target,
        animated: line.moving,
        focusable: false,
        data: line,
        style: { stroke: TONE_STROKE[line.tone], strokeWidth: line.moving ? 2 : 1.5, opacity: line.tone === 'muted' ? 0.5 : 1 },
      })),
    [shape],
  )
  const canvas = useMemo(() => ({ direction, onToggle: (nodeId: string): void => setExpanded((now) => new Set(now.has(nodeId) ? [...now].filter((id) => id !== nodeId) : [...now, nodeId])) }), [direction])

  return (
    <div
      ref={frame}
      data-testid="team-diagram"
      data-layout={placed.key === key ? 'placed' : 'placing'}
      className="relative h-[460px] w-full overflow-hidden rounded-lg border bg-muted/30 sm:h-[620px]"
    >
      {failed && <p className="absolute inset-x-0 top-3 z-10 text-center text-sm text-muted-foreground">The diagram could not be laid out. It tries again on the next read.</p>}
      <ReactFlowProvider>
        <Canvas.Provider value={canvas}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            minZoom={0.2}
            maxZoom={1.5}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_event, node: Node<CardSpec>) => onSelect({ nodeId: node.data.data.nodeId, sessionId: node.data.data.sessionId })}
          >
            <Controls showInteractive={false} fitViewOptions={direction === 'DOWN' ? FIT_NARROW : FIT} position="bottom-right" />
            <FitOnLayout layout={placed.key} fit={direction === 'DOWN' ? FIT_NARROW : FIT} />
          </ReactFlow>
        </Canvas.Provider>
      </ReactFlowProvider>
    </div>
  )
}
