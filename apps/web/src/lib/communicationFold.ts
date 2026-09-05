import type { DomainEventType } from '@slave-of-ai/db'

/** The literal node every `agent.message_sent` edge with `actor: 'human'` renders from (spec §6
 *  E1): no event carries an operator id, so every human message collapses onto one node. */
export const OPERATOR = 'operator'

/** One event, reduced to exactly what the fold reads. Independent of `AppendableEvent`/the DB
 *  row shape on purpose -- this is the fold's own contract, not a reflection of either. */
export interface FoldEvent {
  readonly type: DomainEventType
  readonly agentId: string | null
  readonly taskId: string | null
  readonly actor: string
  readonly payload: unknown
  readonly seq: number
}

export type CommunicationEdgeKind = 'plan' | 'review' | 'rework' | 'message'

export interface CommunicationEdge {
  readonly from: string
  readonly to: string
  readonly count: number
  readonly kind: CommunicationEdgeKind
}

/**
 * Derives who-talked-to-whom edges from task co-participation in the log (spec §6 E1 -- no event
 * carries a target agent, so an edge is never read off a single event, only inferred from two
 * events sharing a `taskId`):
 *
 * - `workspace.plan_created` names a planner and lists task ids; the first `run.started` on each
 *   of those tasks names the implementer -> `planner -> implementer, 'plan'`.
 * - `task.review_started` names a reviewer on a task whose latest `run.started` named an
 *   implementer -> `implementer -> reviewer, 'review'`.
 * - `task.review_rejected` names a reviewer; the next `run.started` on the same task names the
 *   agent sent back to rework it -> `reviewer -> implementer, 'rework'`.
 * - `agent.message_sent` with `actor: 'human'` and an `agentId` -> `operator -> agentId,
 *   'message'`.
 *
 * `events` must already be in `seq` order -- the fold is a single forward pass with no look-ahead
 * (a task's planner/reviewer state is only ever set from an event already seen).
 */
export function foldCommunication(events: readonly FoldEvent[]): { edges: CommunicationEdge[] } {
  // Latest `run.started`'s agentId per task -- who `task.review_started` credits as implementer.
  const implementerByTask = new Map<string, string>()
  // Set by `workspace.plan_created`, consumed (deleted) by that task's first `run.started`.
  const plannedBy = new Map<string, string>()
  // Set by `task.review_rejected`, consumed (deleted) by the next `run.started` on the same task.
  const pendingRework = new Map<string, string>()

  const edges = new Map<string, { from: string; to: string; kind: CommunicationEdgeKind; count: number }>()
  const bump = (from: string, to: string, kind: CommunicationEdgeKind): void => {
    if (from === to) return // self-edges dropped (spec §6 E1)
    const key = `${from}|${to}|${kind}`
    const existing = edges.get(key)
    if (existing === undefined) edges.set(key, { from, to, kind, count: 1 })
    else existing.count += 1
  }

  for (const event of events) {
    switch (event.type) {
      case 'workspace.plan_created': {
        if (event.agentId === null) break
        const planner = event.agentId
        const tasks = (event.payload as { tasks?: readonly { id?: unknown }[] } | null)?.tasks ?? []
        for (const task of tasks) {
          if (typeof task?.id === 'string') plannedBy.set(task.id, planner)
        }
        break
      }
      case 'run.started': {
        if (event.taskId === null || event.agentId === null) break
        const taskId = event.taskId
        const implementer = event.agentId
        const planner = plannedBy.get(taskId)
        if (planner !== undefined) {
          bump(planner, implementer, 'plan')
          plannedBy.delete(taskId)
        }
        const reworker = pendingRework.get(taskId)
        if (reworker !== undefined) {
          bump(reworker, implementer, 'rework')
          pendingRework.delete(taskId)
        }
        implementerByTask.set(taskId, implementer)
        break
      }
      case 'task.review_started': {
        if (event.taskId === null || event.agentId === null) break
        const implementer = implementerByTask.get(event.taskId)
        if (implementer !== undefined) bump(implementer, event.agentId, 'review')
        break
      }
      case 'task.review_rejected': {
        if (event.taskId === null || event.agentId === null) break
        pendingRework.set(event.taskId, event.agentId)
        break
      }
      case 'agent.message_sent': {
        if (event.actor === 'human' && event.agentId !== null) bump(OPERATOR, event.agentId, 'message')
        break
      }
      default:
        break
    }
  }

  const sorted = [...edges.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
  )
  return { edges: sorted }
}
