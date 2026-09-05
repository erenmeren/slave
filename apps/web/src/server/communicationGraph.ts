import { prisma } from '@slave-of-ai/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@slave-of-ai/db'
import { foldCommunication, type CommunicationEdge, type FoldEvent } from '../lib/communicationFold'

/** The newest events (workspace-wide, across the four families the fold reads) the graph folds
 *  over -- spec §6 E1. Bounded before the fold, same discipline as `SKILL_GRAPH_RUN_LIMIT`: the
 *  `take` rides the `orderBy: { seq: 'desc' }` so the database applies the bound, not JS after an
 *  unbounded fetch. */
export const COMMUNICATION_EVENT_LIMIT = 500

const EVENT_TYPES = [
  'workspace_plan_created',
  'run_started',
  'task_review_started',
  'task_review_rejected',
  'agent_message_sent',
] as const

export interface CommunicationGraph {
  readonly agents: readonly { readonly id: string; readonly name: string; readonly role: string }[]
  readonly edges: readonly CommunicationEdge[]
}

export async function buildCommunicationGraph(workspaceId: string): Promise<CommunicationGraph | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return null

  const [agents, rows] = await Promise.all([
    prisma.agent.findMany({
      where: { team: { workspaceId } },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    }),
    prisma.executionEvent.findMany({
      where: { workspaceId, type: { in: [...EVENT_TYPES] } },
      orderBy: { seq: 'desc' },
      take: COMMUNICATION_EVENT_LIMIT,
      select: { type: true, agentId: true, taskId: true, actor: true, payload: true, seq: true },
    }),
  ])

  // The query above reads newest-first (so the LIMIT bounds the newest events, not the oldest);
  // the fold itself is a forward pass over `seq` order (a task's planner/reviewer state is only
  // ever set from an event already seen), so the rows are reversed to ascending here.
  const events: FoldEvent[] = rows
    .slice()
    .reverse()
    .map((row) => ({
      type: DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? (row.type as DomainEventType),
      agentId: row.agentId,
      taskId: row.taskId,
      actor: row.actor,
      payload: row.payload,
      seq: Number(row.seq),
    }))

  const { edges } = foldCommunication(events)
  return { agents, edges }
}
