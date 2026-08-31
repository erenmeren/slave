'use client'

import { Handle, Position, type Edge, type Node, type NodeProps, type NodeTypes } from 'reactflow'
import type { SkillGraph, SkillGraphRun } from '../../server/skillGraph'
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

// ---- step node renderer (Task 12 -- the Focus view's chain) ---------------------------------

export const SKILLSTEP_NODE_PREFIX = 'skillstep:'

export interface SkillStepNodeData {
  readonly kind: 'skillstep'
  readonly name: string
  /** The collapsed run's own repeat count for this link (`SkillGraphRun.chain[i].count`) -- NOT
   *  the aggregate view's cross-run total. `1` for a link that ran once; the badge below only
   *  shows for `count > 1`. */
  readonly count: number
}

/**
 * The Focus view's per-step chip (Task 12, M18 design doc §6's "Focus" half). Same physical box
 * and tone as the aggregate `SkillNode` above (168×44, fixed `planning` tone, mono, `rounded-chip`)
 * -- a reader moving between Aggregate and Focus should recognize the same chip vocabulary, not
 * learn a second one for what is, structurally, the same "one skill, tinted by usage" idea. Differs
 * only in the second line: the aggregate chip's cross-run call total gives way to a `×N` REPEAT
 * badge, shown only when this run collapsed more than one consecutive call into this one step (a
 * single call says just the name -- no `×1` noise, matching the server's own collapse comment in
 * `server/skillGraph.ts`'s `collapseChain`).
 *
 * A distinct React Flow `type` (`skillstep`, not `skill`) rather than reusing `SkillNode` with an
 * optional prop: the two data shapes diverge (`calls`+`prominence` vs `count`, no prominence bucket
 * at all -- a chain step's emphasis is not "how often, workspace-wide" the way the aggregate chip's
 * is) and `layout.ts`'s `DEFAULT_SIZE` keys off `type`, so a genuinely different node kind gets its
 * own registered footprint rather than silently inheriting the aggregate chip's.
 */
export function SkillStepNode({ data }: NodeProps<SkillStepNodeData>): React.JSX.Element {
  return (
    <div
      data-testid="skillstep-node"
      className={`flex h-[44px] w-[168px] flex-col justify-center gap-0.5 rounded-chip border px-2 py-1 font-mono ${TONE_FILL.planning} ${TONE_BORDER.planning}`}
    >
      <Handle type="target" position={Position.Left} />
      <span data-testid="skillstep-node-name" className={`truncate text-[10px] font-medium ${TONE_TEXT.planning}`}>
        {data.name}
      </span>
      {data.count > 1 && (
        <span data-testid="skillstep-node-badge" className="text-[9px] text-text-3">
          ×{data.count}
        </span>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

export const SKILL_NODE_TYPES: NodeTypes = {
  skill: SkillNode,
  skillstep: SkillStepNode,
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

// ---- chain graph builder (Task 12 -- the Focus view) ---------------------------------------

/**
 * The Focus view's per-run chain graph (Task 12, M18 design doc §6's "Focus" half): one
 * `skillstep:<i>` node per COLLAPSED chain entry (`SkillGraphRun.chain`, already left-to-right in
 * the server's own event order -- see `server/skillGraph.ts`'s ordered `findMany`), connected by
 * `skillstep:<i> -> skillstep:<i+1>` in-order cable edges -- the same `layered`/`RIGHT` algorithm
 * that already reads Dependencies mode's DAG left-to-right lays a chain out the same way (a chain
 * is a DAG too, just a straight line: `SkillMode` hands this builder's output to
 * `useLayoutedGraph(nodes, edges, 'layered')`, unchanged from the aggregate view's own call). A
 * single-step run renders its one node with zero edges -- there is nothing to connect it to, not a
 * degenerate/error case.
 *
 * Node ids are POSITIONAL (`skillstep:<i>`), not `name`-keyed like the aggregate view's
 * `skill:<name>` -- a chain can (and does) revisit the same skill non-consecutively (collapsing
 * only merges ADJACENT repeats, per `collapseChain`'s own doc comment), and a name-keyed id would
 * collide two genuinely distinct steps into one node, silently dropping a step from the diagram.
 *
 * Every node starts at `{x: 0, y: 0}`, same "topology and data only, ELK owns position" contract
 * `buildSkillAggregateGraph` follows -- and every edge is a fixed-`planning`-tone, `active: false`
 * cable, same reasoning as that builder's own doc comment (no per-run "in flight" edge concept
 * exists yet).
 */
export function buildSkillChainGraph(run: SkillGraphRun): { readonly nodes: Node[]; readonly edges: Edge[] } {
  const origin = { x: 0, y: 0 }

  const nodes: Node[] = run.chain.map((link, index) => ({
    id: `${SKILLSTEP_NODE_PREFIX}${index}`,
    type: 'skillstep',
    position: origin,
    data: {
      kind: 'skillstep',
      name: link.name,
      count: link.count,
    } satisfies SkillStepNodeData,
  }))

  const edges: Edge[] = []
  for (let index = 0; index < run.chain.length - 1; index += 1) {
    const source = `${SKILLSTEP_NODE_PREFIX}${index}`
    const target = `${SKILLSTEP_NODE_PREFIX}${index + 1}`
    edges.push({
      id: `${source}->${target}`,
      source,
      target,
      type: 'cable',
      data: { tone: 'planning', active: false },
    })
  }

  return { nodes, edges }
}
