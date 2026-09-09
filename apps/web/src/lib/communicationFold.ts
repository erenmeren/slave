import type { DomainEventType } from '@slave-of-ai/db'

/** The literal node every `slave.message_sent` edge with `actor: 'human'` renders from (spec §6
 *  E1): no event carries an operator id, so every human message collapses onto one node. */
export const OPERATOR = 'operator'

/** The literal node every `slave.message_sent` edge with `actor: 'system'` renders from (M39 §6):
 *  an answer the SUPERVISOR wrote itself. Its own node, never folded onto {@link OPERATOR} -- a
 *  person did not write it, and a graph that said so would credit an operator with every answer
 *  the machine sent while they were asleep. */
export const SUPERVISOR = 'supervisor'

/** One event, reduced to exactly what the fold reads. Independent of `AppendableEvent`/the DB
 *  row shape on purpose -- this is the fold's own contract, not a reflection of either. */
export interface FoldEvent {
  readonly type: DomainEventType
  readonly slaveId: string | null
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
 * carries a target slave, so an edge is never read off a single event, only inferred from two
 * events sharing a `taskId`):
 *
 * - `workspace.plan_created` names a planner and lists task ids; the first `run.started` on each
 *   of those tasks names the implementer -> `planner -> implementer, 'plan'`.
 * - `task.review_started` names a reviewer on a task whose latest `run.started` named an
 *   implementer -> `implementer -> reviewer, 'review'`.
 * - `task.review_rejected` names a reviewer; the next `run.started` on the same task names the
 *   slave sent back to rework it -> `reviewer -> implementer, 'rework'`.
 * - `slave.message_sent` with `actor: 'human'` and a `slaveId` -> `operator -> slaveId,
 *   'message'` (a human message's `slaveId` is who the operator addressed).
 * - `slave.message_sent` with `actor: 'system'` -> `supervisor -> slaveId, 'message'` (M39): a
 *   Supervisor answer's `slaveId` is the ASKER it was written for, the same reading as a human's.
 * - `slave.message_sent` with `actor: 'slave'` -> `slaveId -> payload.recipientSlaveId, 'message'`
 *   (M36 t3): here `slaveId` is the SENDER and the recipient is on the event. A role-addressed
 *   message draws no edge -- see the case itself for why.
 *
 * `events` must already be in `seq` order -- the fold is a single forward pass with no look-ahead
 * (a task's planner/reviewer state is only ever set from an event already seen).
 */
export function foldCommunication(events: readonly FoldEvent[]): { edges: CommunicationEdge[] } {
  // Latest `run.started`'s slaveId per task -- who `task.review_started` credits as implementer.
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
        if (event.slaveId === null) break
        const planner = event.slaveId
        const tasks = (event.payload as { tasks?: readonly { id?: unknown }[] } | null)?.tasks ?? []
        for (const task of tasks) {
          if (typeof task?.id === 'string') plannedBy.set(task.id, planner)
        }
        break
      }
      case 'run.started': {
        if (event.taskId === null || event.slaveId === null) break
        const taskId = event.taskId
        const implementer = event.slaveId
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
        if (event.taskId === null || event.slaveId === null) break
        const implementer = implementerByTask.get(event.taskId)
        if (implementer !== undefined) bump(implementer, event.slaveId, 'review')
        break
      }
      case 'task.review_rejected': {
        if (event.taskId === null || event.slaveId === null) break
        pendingRework.set(event.taskId, event.slaveId)
        break
      }
      case 'slave.message_sent': {
        if (event.slaveId === null) break
        // A human message's `slaveId` is who the operator ADDRESSED; a worker's is the SENDER, and
        // the recipient rides in the payload (M36 t1's `sendMessage`). Two readings of one column,
        // told apart by `actor` and by nothing else.
        if (event.actor === 'human') {
          bump(OPERATOR, event.slaveId, 'message')
          break
        }
        // `system` is the Supervisor answering a question itself (`answerQuestion` with
        // `origin: 'system'`, M39 §2). Its `slaveId` is the asker -- the row's own "who this is
        // for" column, the same one a human's answer fills -- so the edge is read exactly like the
        // operator's above, from the Supervisor's node instead. An answer a human APPROVED is
        // written with `origin: 'human'` and draws from the operator, which is the truth: a person
        // sent it.
        if (event.actor === 'system') {
          bump(SUPERVISOR, event.slaveId, 'message')
          break
        }
        const recipient = (event.payload as { recipientSlaveId?: unknown } | null)?.recipientSlaveId
        // A ROLE-addressed message draws nothing. The payload names the role, not its holders, and
        // this fold is a pure pass over events with no roster to expand one against -- inventing an
        // edge per current holder would also credit workers who never saw it. The exchange still
        // shows up: an `answer` is always addressed to the asker by name (M36 t3's `answer.ts`
        // reads the recipient off the question row), so the reply draws `answerer -> asker`.
        if (typeof recipient === 'string') bump(event.slaveId, recipient, 'message')
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
