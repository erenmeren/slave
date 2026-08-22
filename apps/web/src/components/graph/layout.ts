'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
// `elkjs`'s "main" entry (`lib/main.js`) is the Node-targeted build: it conditionally
// `require.resolve('web-worker')` to decide whether to spin up a real worker, a pattern
// bundlers can choke on when this module is pulled into a browser bundle (Next's build gate,
// binding constraint: "if the bundler trips on elkjs, the Task-5 web:build gate catches it").
// `lib/elk.bundled.js` is elkjs's own browserify bundle -- every layout algorithm inlined, no
// `require()` of anything outside itself, a synchronous "fake worker" fallback baked in -- the
// "plain async build" the brief points at. Importing this specific subpath sidesteps the bundler
// risk entirely; `npm run web:build` passing (see the Task 5 report) is the evidence it works.
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'
import type { Edge, Node } from 'reactflow'

const elk = new ELK()

export type LayoutAlgorithm = 'mrtree' | 'layered'

/** Default node footprints ELK lays out against, keyed by React Flow `type`. Static sizing (no
 *  DOM measurement) is enough at MVP scale (tens of nodes) -- the same "plain async, not a
 *  worker" scale note the spec makes for the algorithm itself (§4.2). */
const DEFAULT_SIZE: Record<string, { readonly width: number; readonly height: number }> = {
  workspace: { width: 220, height: 68 },
  team: { width: 180, height: 52 },
  agent: { width: 220, height: 92 },
  activeTask: { width: 140, height: 40 },
  task: { width: 220, height: 64 },
}
const FALLBACK_SIZE = { width: 180, height: 56 } as const

/**
 * The ELK adapter: builds an ELK graph from React Flow nodes/edges, runs the named algorithm, and
 * returns the same nodes with `position` replaced by ELK's computed layout. Node `type` selects
 * the default footprint ELK lays out against (no live DOM measurement -- see `DEFAULT_SIZE`).
 * Pure and stateless -- Task 6 reuses this directly for the dependency DAG's `layered` layout.
 */
export async function layoutGraph(nodes: readonly Node[], edges: readonly Edge[], algorithm: LayoutAlgorithm): Promise<Node[]> {
  if (nodes.length === 0) return []

  const elkGraph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': algorithm,
      'elk.direction': algorithm === 'layered' ? 'RIGHT' : 'DOWN',
    },
    children: nodes.map((node) => {
      const size = DEFAULT_SIZE[node.type ?? ''] ?? FALLBACK_SIZE
      return { id: node.id, width: size.width, height: size.height }
    }),
    edges: edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  }

  // Cast rather than lean on `ELK.layout`'s generic return type (`Omit<T, 'children'> & {...}`,
  // keyed off whatever `T` gets inferred for `elkGraph`): the shape actually returned is an
  // `ElkNode`, and the generic's indexed-access gymnastics (`T['children'][number]`) buy nothing
  // here that a plain, readable type doesn't already give.
  const result = (await elk.layout(elkGraph)) as ElkNode
  const positionById = new Map((result.children ?? []).map((child) => [child.id, { x: child.x ?? 0, y: child.y ?? 0 }]))

  return nodes.map((node) => ({ ...node, position: positionById.get(node.id) ?? node.position }))
}

/**
 * The "has the node/edge SET changed" identity the recompute contract keys off (spec §4.2: "Layout
 * recomputes only when the node/edge SET changes -- a status change repaints, never re-layouts").
 * Sorted so a snapshot refetch that reorders an otherwise-unchanged roster (Prisma's `orderBy`
 * gives a stable order in practice, but nothing guarantees array order survives a round trip
 * through JSON) does not read as a set change. Edge identity is the `source->target` pair, not the
 * edge's own `id` -- our ids are already derived from that pair (see `OrgNodes.buildOrgGraph`), but
 * keying on the pair directly keeps this contract honest even if a future caller mints edge ids
 * differently.
 */
export function layoutKey(nodes: readonly Node[], edges: readonly Edge[]): string {
  const nodeIds = nodes
    .map((node) => node.id)
    .sort()
    .join(',')
  const edgePairs = edges
    .map((edge) => `${edge.source}->${edge.target}`)
    .sort()
    .join(',')
  return `${nodeIds}|${edgePairs}`
}

/**
 * The memoized layout: calls `layoutGraph` once per distinct `layoutKey`, and on every other
 * render merges the latest `data` (status, active-task title, ...) onto the cached positions --
 * so a status-only change repaints immediately (no re-layout, no flight through ELK) while a
 * node/edge set change re-triggers a real layout pass. Nodes not yet positioned (the very first
 * render, before the async layout resolves) render at their caller-supplied `position` (the
 * builder seeds every node at `{x: 0, y: 0}`) -- a one-frame flash to the ELK-computed layout,
 * acceptable at this milestone's static-styling scope (motion is Task 8's).
 */
export function useLayoutedGraph(nodes: readonly Node[], edges: readonly Edge[], algorithm: LayoutAlgorithm): readonly Node[] {
  const key = layoutKey(nodes, edges)
  const keyRef = useRef<string | null>(null)
  const [positioned, setPositioned] = useState<readonly Node[]>(nodes)

  useEffect(() => {
    if (keyRef.current === key) return
    keyRef.current = key
    let cancelled = false
    void layoutGraph(nodes, edges, algorithm).then((result) => {
      if (!cancelled) setPositioned(result)
    })
    return () => {
      cancelled = true
    }
    // `nodes`/`edges` are intentionally excluded: `key` is their stable identity for this effect's
    // purposes, and including the arrays themselves would re-run the effect (and hit the `return`
    // above) on every status-only change for no benefit -- the merge below already picks up latest
    // `data` on every render regardless of whether this effect ran.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, algorithm])

  return useMemo(() => {
    const latestById = new Map(nodes.map((node) => [node.id, node]))
    return positioned
      .filter((node) => latestById.has(node.id)) // a node removed from the set drops out immediately, not just on the next layout
      .map((node) => {
        const latest = latestById.get(node.id)
        return latest === undefined ? node : { ...latest, position: node.position }
      })
  }, [positioned, nodes])
}
