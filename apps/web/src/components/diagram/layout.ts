// `elkjs/lib/elk.bundled.js` is elkjs's own browser bundle: every algorithm inlined, no worker to
// resolve, so the bundler has nothing to trip on. Type-only here; the value is imported on first
// use, which keeps its weight out of the Project screen until a diagram is opened.
import type { ELK as ElkInstance, ElkNode } from 'elkjs/lib/elk.bundled.js'
import type { DiagramShape } from './shape'

export type Direction = 'RIGHT' | 'DOWN'
export type Positions = ReadonlyMap<string, { readonly x: number; readonly y: number }>

let elkPromise: Promise<ElkInstance> | null = null
function getElk(): Promise<ElkInstance> {
  // A failed import (a dropped chunk) must not be remembered: the next layout tries again.
  elkPromise ??= import('elkjs/lib/elk.bundled.js')
    .then((module) => new module.default())
    .catch((cause: unknown) => {
      elkPromise = null
      throw cause
    })
  return elkPromise
}

/**
 * Where each card goes: a layered layout, left to right on a wide canvas and top to bottom on a
 * narrow one, from the cards' own boxes. The gap between layers leaves room for a line's words.
 */
export async function layoutDiagram(shape: DiagramShape, direction: Direction): Promise<Positions> {
  if (shape.cards.length === 0) return new Map()
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.spacing.nodeNode': '28',
      'elk.layered.spacing.nodeNodeBetweenLayers': direction === 'RIGHT' ? '116' : '72',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      // A caller sits in the middle of whom it called, not level with the first of them.
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    },
    children: shape.cards.map((card) => ({ id: card.id, width: card.width, height: card.height })),
    edges: shape.lines.map((line) => ({ id: line.id, sources: [line.source], targets: [line.target] })),
  }
  const result = (await (await getElk()).layout(graph)) as ElkNode
  return new Map((result.children ?? []).map((child) => [child.id, { x: child.x ?? 0, y: child.y ?? 0 }]))
}
