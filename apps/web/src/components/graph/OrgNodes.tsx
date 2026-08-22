'use client'

import type React from 'react'
import { Handle, Position, type Edge, type Node, type NodeProps, type NodeTypes } from 'reactflow'
import type { AgentStatus, TaskStatus } from '@ai-team-os/domain'
import type { GraphSnapshot } from '../../server/graph'
import { DOT } from '../AgentCard'
import { TASK_STATUS_BORDER, TASK_STATUS_DOT } from '../TaskCard'

// ---- node data shapes -----------------------------------------------------------------------

export interface WorkspaceNodeData {
  readonly kind: 'workspace'
  readonly name: string
  readonly haltedReason: string | null
}

export interface TeamNodeData {
  readonly kind: 'team'
  readonly name: string
}

export interface AgentNodeData {
  readonly kind: 'agent'
  readonly name: string
  readonly role: string
  readonly status: AgentStatus
  readonly activeTaskTitle: string | null
}

/** The active-task satellite (spec §6's particle track: "along the agent → active-task edge") --
 *  appears only while the agent has a live run, small and title-only (its full detail lives on
 *  the Tasks board / Task 6's deps-mode node, one click away via the node context menu). */
export interface ActiveTaskNodeData {
  readonly kind: 'activeTask'
  readonly title: string
  readonly status: TaskStatus
}

// `GraphAgent.status` is typed `string` (a deliberately widened field -- see `server/graph.ts`'s
// own comment) even though `deriveAgentStatus` only ever produces one of the seven `AgentStatus`
// literals at runtime. `DOT` is keyed by the narrow union; this guards the lookup so an
// unrecognized value (a future status this component hasn't been told about yet, or a fixture
// typo) reads as idle rather than `undefined` reaching a className.
function agentDot(status: string): string {
  return DOT[status as AgentStatus] ?? DOT.idle
}

// Same shape of guard for `GraphTask.status` reuse -- `TASK_STATUS_DOT`/`TASK_STATUS_BORDER` are
// total over `TaskStatus`, but the satellite's status comes from a `Map` lookup keyed by id (see
// `buildOrgGraph`) that can, in principle, miss.
function taskDot(status: TaskStatus): string {
  return TASK_STATUS_DOT[status] ?? TASK_STATUS_DOT.backlog
}

function taskBorder(status: TaskStatus): string {
  return TASK_STATUS_BORDER[status] ?? TASK_STATUS_BORDER.backlog
}

// ---- node renderers ---------------------------------------------------------------------------

export function WorkspaceNode({ data }: NodeProps<WorkspaceNodeData>): React.JSX.Element {
  const halted = data.haltedReason !== null
  return (
    <div
      data-testid="workspace-node"
      data-halted={halted}
      className={`rounded border-2 px-4 py-3 text-center ${halted ? 'border-status-danger bg-status-danger/10' : 'border-line bg-bg-1'}`}
    >
      <div className="text-sm font-medium text-text-1">{data.name}</div>
      {halted && <div className="mt-1 text-xs text-status-danger">halted: {data.haltedReason}</div>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

export function TeamNode({ data }: NodeProps<TeamNodeData>): React.JSX.Element {
  return (
    <div data-testid="team-node" className="rounded border border-line bg-bg-1 px-3 py-2 text-center">
      <Handle type="target" position={Position.Top} />
      <div className="text-sm text-text-1">{data.name}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

export function AgentNode({ data }: NodeProps<AgentNodeData>): React.JSX.Element {
  return (
    <div data-testid="agent-node" data-status={data.status} className="rounded border border-line bg-bg-1 px-3 py-2">
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-1.5">
        <span
          data-testid="status-dot"
          className={`inline-block h-2 w-2 rounded-full ${agentDot(data.status)} ${data.status === 'working' ? 'animate-pulse' : ''}`}
        />
        <span className="text-sm text-text-1">{data.name}</span>
        <span className="text-xs text-text-3">{data.role}</span>
      </div>
      <div className="mt-1 truncate text-xs text-text-2">{data.activeTaskTitle ?? 'idle'}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

export function ActiveTaskNode({ data }: NodeProps<ActiveTaskNodeData>): React.JSX.Element {
  return (
    <div
      data-testid="active-task-node"
      className={`rounded border bg-bg-1 px-2 py-1 text-xs text-text-2 ${taskBorder(data.status)}`}
    >
      <Handle type="target" position={Position.Top} />
      <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${taskDot(data.status)}`} />
      {data.title}
    </div>
  )
}

export const ORG_NODE_TYPES: NodeTypes = {
  workspace: WorkspaceNode,
  team: TeamNode,
  agent: AgentNode,
  activeTask: ActiveTaskNode,
} as NodeTypes

// ---- graph builder ------------------------------------------------------------------------

/**
 * The workspace → team → agent hierarchy (spec §4.3), plus one active-task satellite + agent→task
 * edge per agent currently on a live run (spec §6). Every node starts at `{x: 0, y: 0}` --
 * `layout.ts`'s `useLayoutedGraph` positions them; this function only owns topology and node
 * `data`, never coordinates.
 */
export function buildOrgGraph(snapshot: GraphSnapshot): { readonly nodes: Node[]; readonly edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const origin = { x: 0, y: 0 }

  const workspaceNodeId = `workspace:${snapshot.workspace.id}`
  nodes.push({
    id: workspaceNodeId,
    type: 'workspace',
    position: origin,
    data: { kind: 'workspace', name: snapshot.workspace.name, haltedReason: snapshot.workspace.haltedReason } satisfies WorkspaceNodeData,
  })

  for (const team of snapshot.teams) {
    const teamNodeId = `team:${team.id}`
    nodes.push({
      id: teamNodeId,
      type: 'team',
      position: origin,
      data: { kind: 'team', name: team.name } satisfies TeamNodeData,
    })
    edges.push({ id: `${workspaceNodeId}->${teamNodeId}`, source: workspaceNodeId, target: teamNodeId })
  }

  const taskStatusById = new Map(snapshot.tasks.map((task) => [task.id, task.status]))

  for (const agent of snapshot.agents) {
    const agentNodeId = `agent:${agent.id}`
    const teamNodeId = `team:${agent.teamId}`
    nodes.push({
      id: agentNodeId,
      type: 'agent',
      position: origin,
      data: {
        kind: 'agent',
        name: agent.name,
        role: agent.role,
        status: agent.status as AgentStatus,
        activeTaskTitle: agent.activeTaskTitle,
      } satisfies AgentNodeData,
    })
    edges.push({ id: `${teamNodeId}->${agentNodeId}`, source: teamNodeId, target: agentNodeId })

    if (agent.activeTaskId !== null) {
      const taskNodeId = `activeTask:${agent.activeTaskId}`
      nodes.push({
        id: taskNodeId,
        type: 'activeTask',
        position: origin,
        data: {
          kind: 'activeTask',
          title: agent.activeTaskTitle ?? '',
          status: taskStatusById.get(agent.activeTaskId) ?? 'running',
        } satisfies ActiveTaskNodeData,
      })
      edges.push({ id: `${agentNodeId}->${taskNodeId}`, source: agentNodeId, target: taskNodeId })
    }
  }

  return { nodes, edges }
}
