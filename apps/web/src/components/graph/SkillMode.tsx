'use client'

import { useEffect, useMemo, useState } from 'react'
import type { GraphSnapshot } from '../../server/graph'
import type { SkillGraph } from '../../server/skillGraph'
import { GraphCanvas } from './GraphCanvas'
import { useLayoutedGraph } from './layout'
import { buildSkillAggregateGraph, SKILL_NODE_TYPES } from './SkillNodes'

/** The DTO's own honest zero state (M18 design doc §6, "Empty state") -- also this component's
 *  initial state, before the fetch below has resolved. A workspace whose skill graph genuinely
 *  has zero calls and one that simply hasn't answered yet render identically for that one gap:
 *  the same panel a moment later either stays (truly empty) or gives way to the real graph. */
const EMPTY_GRAPH: SkillGraph = { skills: [], edges: [], runs: [] }

/**
 * Skill chain mode's aggregate canvas (Task 11, M18 design doc §6's "Aggregate (default)" half --
 * the run-selector "Focus" half is Task 12, not built here). On the same `DepsMode.tsx:52-162`
 * template every sibling mode follows: an absolute error band (`role="alert"`) and an absolute
 * empty-state hint stack over an ALWAYS-rendered `GraphCanvas` (never a conditionally-omitted
 * one -- an empty result is still a real, explained canvas, not a blank one).
 *
 * Unlike `DepsMode`/`ExecutionMode` (which receive an already-fetched `GraphSnapshot`), this mode
 * owns its own fetch: `snapshot` is accepted only for prop-shape parity with its siblings (every
 * mode in `GraphClient.tsx`'s render slot takes `{ workspaceId, snapshot }`), and is not read --
 * the skill graph is a SIBLING DTO to `GraphSnapshot` (M18 design doc §6: "New SIBLING builder --
 * NOT a `GraphSnapshot` widening"), fetched from Task 10's own route,
 * `/api/w/<workspaceId>/skill-graph`.
 */
export function SkillMode({ workspaceId, snapshot: _snapshot }: { readonly workspaceId: string; readonly snapshot: GraphSnapshot }): React.JSX.Element {
  const [graph, setGraph] = useState<SkillGraph>(EMPTY_GRAPH)
  const [errorText, setErrorText] = useState<string | null>(null)

  // Fetch-on-mount only (Task 12 adds the debounced refetch on a `run.tool_call` stream frame --
  // not built here). Same shape as `useWorkspaceStream.ts`'s own `refetch`: keep the stale graph
  // on failure and name the error, rather than clearing to the empty panel and implying "no calls
  // ever happened" when the truth is "the request failed".
  useEffect(() => {
    let cancelled = false
    void fetch(`/api/w/${workspaceId}/skill-graph`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`skill graph failed: ${response.status} ${await response.text()}`)
        return (await response.json()) as SkillGraph
      })
      .then((data) => {
        if (!cancelled) setGraph(data)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setErrorText(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const { nodes, edges } = useMemo(() => buildSkillAggregateGraph(graph), [graph])
  const { nodes: positioned, edges: visibleEdges } = useLayoutedGraph(nodes, edges, 'layered')

  return (
    <div className="relative h-full w-full">
      {errorText !== null && (
        <div
          role="alert"
          data-testid="skill-error"
          className="absolute inset-x-0 top-0 z-10 border-b border-tone-blocked/40 bg-tone-blocked/10 px-4 py-1.5 text-xs text-tone-blocked"
        >
          {errorText}
        </div>
      )}
      {graph.skills.length === 0 && (
        <div
          data-testid="skill-empty"
          className="pointer-events-none absolute inset-x-0 top-10 z-10 text-center text-xs text-text-3"
        >
          no skill calls recorded yet — runs record their skills as they use them
        </div>
      )}
      <GraphCanvas nodes={positioned} edges={visibleEdges} nodeTypes={SKILL_NODE_TYPES} />
    </div>
  )
}
