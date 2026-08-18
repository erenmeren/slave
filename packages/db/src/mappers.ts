import {
  agentId,
  err,
  ok,
  parseExecutionEvent,
  runId,
  taskId,
  type ExecutionEvent,
  type Result,
  type RunState,
  type TaskState,
} from '@ai-team-os/domain'
import type { AgentRunRow, ExecutionEventRow, TaskRow } from './client.js'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from './enums.js'

export function toTaskState(row: TaskRow): TaskState {
  return {
    status: row.status,
    assigneeId: row.assigneeId === null ? null : agentId(row.assigneeId),
    activeRunId: row.activeRunId === null ? null : runId(row.activeRunId),
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    lastRejectionReason: row.lastRejectionReason,
  }
}

export function toRunState(row: AgentRunRow): RunState {
  return {
    status: row.status,
    toolCalls: row.toolCalls,
    sessionId: row.sessionId,
    pausedAtStep: row.pausedAtStep,
  }
}

/**
 * Converts a stored row to the domain event. `seq` is a database bigint; it is narrowed to a
 * JavaScript number here, which is exact below 2^53. That ceiling is nine quadrillion events and
 * is recorded in the M2 design spec §5.3 — this function is the single place to revisit it.
 */
export function toExecutionEvent(row: ExecutionEventRow): Result<ExecutionEvent, string> {
  const domainType = DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type]
  if (domainType === undefined) {
    return err(`unknown event type in the log: ${String(row.type)}`)
  }

  const candidate = {
    seq: Number(row.seq),
    ts: row.ts.toISOString(),
    type: domainType,
    workspaceId: row.workspaceId,
    ...(row.taskId === null ? {} : { taskId: taskId(row.taskId) }),
    ...(row.agentId === null ? {} : { agentId: agentId(row.agentId) }),
    ...(row.runId === null ? {} : { runId: runId(row.runId) }),
    actor: row.actor,
    payload: row.payload,
  }

  const parsed = parseExecutionEvent(candidate)
  return parsed.ok ? ok(parsed.value) : err(parsed.error)
}
