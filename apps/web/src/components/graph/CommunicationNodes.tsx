'use client'

import { Handle, Position, type Edge, type Node, type NodeProps, type NodeTypes } from 'reactflow'
import type { CommunicationEdgeKind } from '../../lib/communicationFold'
import type { CommunicationGraph } from '../../server/communicationGraph'
import type { StatusTone } from '../ui/StatusPill'

// ---- node data shapes -------------------------------------------------------------------------

/**
 * The minimal node this mode needs (Task 12, M23 E3): `OrgNodes.tsx`'s `AgentNodeData` requires
 * `status`/`activeTaskTitle`/`workspaceId` (it renders a status pill and a context menu) -- the
 * communication graph carries none of that (`server/communicationGraph.ts`'s `CommunicationGraph`
 * is `{ agents: {id,name,role}[]; edges: CommunicationEdge[] }`), so this is a SEPARATE, smaller
 * node kind rather than a widening of `AgentNodeData` for a shape it doesn't have.
 */
export interface CommAgentNodeData {
  readonly kind: 'commAgent'
  readonly name: string
  readonly role: string
}

/** The literal human node every `agent.message_sent` edge with `actor: 'human'` renders from
 *  (`communicationFold.ts`'s `OPERATOR` constant) -- carries no data of its own beyond its kind. */
export interface OperatorNodeData {
  readonly kind: 'operator'
}

// ---- node renderers ------------------------------------------------------------------------

/** `agent:<id>` -- distinct from every other mode's node-id space, same prefix `OrgNodes.tsx`
 *  uses for its own (unrelated) agent node kind. */
export const COMM_AGENT_NODE_PREFIX = 'agent:'

/** The one node every human-originated edge collapses onto (`communicationFold.ts`'s `OPERATOR`). */
export const OPERATOR_NODE_ID = 'operator'

/**
 * The chip-styled agent node: name + role, nothing else -- this graph has no live status to show
 * (spec §6 E1: the graph is folded from a bounded event window, not a live agent snapshot), so
 * unlike `OrgNodes.tsx`'s `AgentNode` this renders no status pill and opens no context menu.
 */
export function CommAgentNode({ data }: NodeProps<CommAgentNodeData>): React.JSX.Element {
  return (
    <div data-testid="comm-agent-node" className="rounded border border-line bg-bg-1 px-3 py-2 text-center">
      <Handle type="target" position={Position.Left} />
      <div className="truncate text-sm text-text-1">{data.name}</div>
      <div className="truncate text-xs text-text-3">{data.role}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

/** The operator's own node -- one per canvas, always present (Task 12's interface: "one `operator`
 *  node ... label `operator`"), whether or not any edge actually touches it this fetch. */
export function OperatorNode(_props: NodeProps<OperatorNodeData>): React.JSX.Element {
  return (
    <div data-testid="operator-node" className="rounded border border-line bg-bg-1 px-3 py-2 text-center">
      <Handle type="target" position={Position.Left} />
      <div className="text-sm text-text-1">operator</div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

export const COMM_NODE_TYPES: NodeTypes = {
  commAgent: CommAgentNode,
  operator: OperatorNode,
} as NodeTypes

// ---- graph builder ------------------------------------------------------------------------

/**
 * The tone each `CommunicationEdgeKind` draws its cable in (Task 12's interface table).
 * `StatusTone` (`StatusPill.tsx`) has no `warn` member -- `rework`'s natural reading ("something
 * went back for another pass") falls back to `waiting`, the closest tone this vocabulary actually
 * has, rather than a value that would fail to typecheck against `CableEdgeData['tone']`.
 */
const TONE_BY_KIND: Record<CommunicationEdgeKind, StatusTone> = {
  plan: 'planning',
  review: 'working',
  rework: 'waiting',
  message: 'idle',
}

/** `CommunicationEdge.from`/`.to` are either an agent id or the literal `'operator'`
 *  (`communicationFold.ts`'s `OPERATOR`) -- this maps either to the node id space above. */
function commNodeId(rawId: string): string {
  return rawId === OPERATOR_NODE_ID ? OPERATOR_NODE_ID : `${COMM_AGENT_NODE_PREFIX}${rawId}`
}

/**
 * The Communication tab's graph (Task 12, M23 E3): one `agent:<id>` node per `graph.agents` entry
 * plus one ALWAYS-present `operator` node (whether or not this fetch's edges touch it -- a stable
 * landmark on the canvas, not something that pops in and out as hand-offs come and go), and one
 * cable edge per `graph.edges` entry. Every node starts at `{x: 0, y: 0}` -- `layout.ts`'s
 * `useLayoutedGraph` positions them, this function only owns topology and node `data`, same
 * "server owns order, this owns shape" contract `buildSkillAggregateGraph` follows.
 *
 * Edge id is `<source>-><target>:<kind>` (the already-prefixed node ids, not the raw `from`/`to`)
 * -- the same convention `buildSkillAggregateGraph`'s `${source}->${target}` uses, with `:<kind>`
 * appended because, unlike the skill graph, two DIFFERENT edges can share one `(from, to)` pair
 * here (`communicationFold.ts`'s `bump` keys its own map by `from|to|kind` for exactly this
 * reason) -- e.g. one agent plans for another AND later reworks something for them.
 *
 * Every edge is a `cable` (`CableEdge.tsx`) at the kind's fixed tone (`TONE_BY_KIND` above) and
 * `active: false` -- this view has no notion of an edge currently "in flight", the same honesty
 * `buildSkillAggregateGraph`'s own doc comment gives for its aggregate cables. It DOES carry
 * `weight: edge.count` (the M19 C3 idiom), so a hot hand-off still draws as thick as its own
 * traffic.
 */
export function buildCommunicationGraph(graph: CommunicationGraph): { readonly nodes: Node[]; readonly edges: Edge[] } {
  const origin = { x: 0, y: 0 }

  const agentNodes: Node[] = graph.agents.map((agent) => ({
    id: `${COMM_AGENT_NODE_PREFIX}${agent.id}`,
    type: 'commAgent',
    position: origin,
    data: { kind: 'commAgent', name: agent.name, role: agent.role } satisfies CommAgentNodeData,
  }))

  const operatorNode: Node = {
    id: OPERATOR_NODE_ID,
    type: 'operator',
    position: origin,
    data: { kind: 'operator' } satisfies OperatorNodeData,
  }

  const edges: Edge[] = graph.edges.map((edge) => {
    const source = commNodeId(edge.from)
    const target = commNodeId(edge.to)
    return {
      id: `${source}->${target}:${edge.kind}`,
      source,
      target,
      type: 'cable',
      data: { tone: TONE_BY_KIND[edge.kind], active: false, weight: edge.count },
    }
  })

  return { nodes: [...agentNodes, operatorNode], edges }
}
