'use client'

import { Handle, Position, type Edge, type Node, type NodeProps, type NodeTypes } from 'reactflow'
import type { SkillGraph } from '../../server/skillGraph'
import { TONE_BORDER, TONE_FILL, TONE_TEXT } from '../ui/StatusPill'

// ---- node data shape -------------------------------------------------------------------------

/**
 * Prominence step from raw call count -- a small fixed set of buckets, NOT a continuous function
 * of `calls` (the brief's "no free-form scaling" rule). Every skill node shares one DOM footprint
 * regardless of bucket (`layout.ts`'s `DEFAULT_SIZE.skill`) -- only the chip's typographic
 * emphasis (see `PROMINENCE_TEXT_CLASS` below) reads the bucket, so ELK's layout box never drifts
 * from what actually renders.
 */
export type SkillProminence = 'small' | 'medium' | 'large'

export interface SkillNodeData {
  readonly kind: 'skill'
  readonly name: string
  readonly calls: number
  readonly prominence: SkillProminence
}

/**
 * The bucket boundaries: a skill called once or twice is incidental (`small`); the ordinary
 * working set of a skill actually in rotation is `medium`; a skill the workspace leans on
 * repeatedly across the aggregate window (Task 10's `SKILL_GRAPH_RUN_LIMIT`-bounded run set)
 * earns `large`. Pure and total over every non-negative integer -- see `graph-skill.test.tsx`
 * for the boundary cases.
 */
export function skillProminence(calls: number): SkillProminence {
  if (calls >= 8) return 'large'
  if (calls >= 3) return 'medium'
  return 'small'
}

// ---- node renderer ------------------------------------------------------------------------

export const SKILL_NODE_PREFIX = 'skill:'

/** Discrete per-bucket emphasis -- font size/weight only, never the box (spec: "prominence via a
 *  size/emphasis STEP ... NOT free-form scaling"). Reuses the house `text-text-*`-family sizing
 *  idiom, no new tokens. */
const PROMINENCE_TEXT_CLASS: Record<SkillProminence, string> = {
  small: 'text-[9px] font-normal',
  medium: 'text-[10px] font-medium',
  large: 'text-[11px] font-semibold',
}

/**
 * The chip-styled skill node (M18 design doc §6 / the drawer mockup's "SKILL CHAIN · SUPERPOWERS"
 * chain-pill: mono, `border-radius: 5px`, `padding: 4px 8px`, tone-tinted border/background/text
 * -- reused here verbatim as `rounded-chip` / `TONE_*[planning]`, no new colour tokens). Skills
 * carry no live status of their own (no agent/task tone applies), so every skill node rides the
 * same `planning` tone the mockup's chain pill already used (`#7b8cff`, this codebase's
 * `--color-tone-planning`) -- a fixed, honest choice rather than inventing a "skill" tone.
 *
 * Fixed at `w-[168px] h-[44px]` -- MUST match `layout.ts`'s `DEFAULT_SIZE.skill` exactly, or ELK
 * lays every skill node out against the wrong box and neighbours overlap (the Task 5/6 footprint
 * rule). Two lines: the name (truncated, sized by `prominence`) and the call count, dim.
 */
export function SkillNode({ data }: NodeProps<SkillNodeData>): React.JSX.Element {
  return (
    <div
      data-testid="skill-node"
      data-prominence={data.prominence}
      className={`flex h-[44px] w-[168px] flex-col justify-center gap-0.5 rounded-chip border px-2 py-1 font-mono ${TONE_FILL.planning} ${TONE_BORDER.planning}`}
    >
      <Handle type="target" position={Position.Left} />
      <span data-testid="skill-node-name" className={`truncate ${TONE_TEXT.planning} ${PROMINENCE_TEXT_CLASS[data.prominence]}`}>
        {data.name}
      </span>
      <span data-testid="skill-node-calls" className="text-[9px] text-text-3">
        {data.calls} call{data.calls === 1 ? '' : 's'}
      </span>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

export const SKILL_NODE_TYPES: NodeTypes = {
  skill: SkillNode,
} as NodeTypes

// ---- graph builder ------------------------------------------------------------------------

/**
 * The aggregate skill graph's nodes + edges (Task 11, M18 design doc §6's "Aggregate (default)"
 * half -- the "Focus" run-selector half is Task 12, not built here). Pure, per the house builder
 * contract `TaskNodes.tsx:125-134` states for `buildDepsGraph` and every builder since has
 * followed: one node per `graph.skills` entry (id `skill:<name>`, distinct from every other
 * mode's node-id space), one edge per `graph.edges` succession pair, direction `from -> to` so an
 * observed "A then B" call order reads left to right under the `layered` algorithm the same way
 * `buildDepsGraph`'s `dependsOn -> task` does. Every node starts at `{x: 0, y: 0}` -- `layout.ts`'s
 * `useLayoutedGraph` positions them, this function only owns topology and node `data`, never
 * coordinates.
 *
 * Every edge is a `cable` (M14 Task 11 -- `CableEdge.tsx`) at the fixed `planning` tone
 * (`SkillNode`'s own tone, above) and `active: false` -- the aggregate view has no notion of an
 * edge currently "in flight" (that is a per-run, focus-view fact -- Task 12), so every cable here
 * draws the flat inactive line, honestly.
 *
 * `graph.skills`/`graph.edges` arrive from `server/skillGraph.ts` already ordered (name-sorted /
 * `(from, to)`-sorted) -- this function preserves that order rather than re-sorting, the same
 * "the server owns order" split `buildDepsGraph` keeps with `snapshot.tasks`/`snapshot.dependencies`.
 */
export function buildSkillAggregateGraph(graph: SkillGraph): { readonly nodes: Node[]; readonly edges: Edge[] } {
  const origin = { x: 0, y: 0 }

  const nodes: Node[] = graph.skills.map((skill) => ({
    id: `${SKILL_NODE_PREFIX}${skill.name}`,
    type: 'skill',
    position: origin,
    data: {
      kind: 'skill',
      name: skill.name,
      calls: skill.calls,
      prominence: skillProminence(skill.calls),
    } satisfies SkillNodeData,
  }))

  const edges: Edge[] = graph.edges.map((edge) => {
    const source = `${SKILL_NODE_PREFIX}${edge.from}`
    const target = `${SKILL_NODE_PREFIX}${edge.to}`
    return {
      id: `${source}->${target}`,
      source,
      target,
      type: 'cable',
      data: { tone: 'planning', active: false },
    }
  })

  return { nodes, edges }
}
