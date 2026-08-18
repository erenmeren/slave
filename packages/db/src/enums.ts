import type { ExecutionEvent, RunStatus, TaskStatus } from '@ai-team-os/domain'

export type DomainEventType = ExecutionEvent['type']

/**
 * Domain event type to the value stored in the database. The `satisfies` clause is
 * load-bearing: adding a member to the Zod union without adding it here fails the build.
 */
export const EVENT_TYPE_BY_DOMAIN_TYPE = {
  'task.created': 'task_created',
  'task.started': 'task_started',
  'task.done': 'task_done',
  'task.rework': 'task_rework',
  'run.started': 'run_started',
  'run.tool_call': 'run_tool_call',
  'run.paused': 'run_paused',
  'run.resumed': 'run_resumed',
  'agent.message_sent': 'agent_message_sent',
  'guardrail.tripped': 'guardrail_tripped',
} as const satisfies Record<DomainEventType, string>

export type DbEventType = (typeof EVENT_TYPE_BY_DOMAIN_TYPE)[DomainEventType]

export const DOMAIN_EVENT_TYPE_BY_DB_VALUE: Readonly<Record<string, DomainEventType>> =
  Object.fromEntries(
    Object.entries(EVENT_TYPE_BY_DOMAIN_TYPE).map(([domain, db]) => [db, domain as DomainEventType]),
  )

/** Every TaskStatus, as data. The parity test proves this list is complete. */
export const TASK_STATUSES = [
  'backlog',
  'ready',
  'blocked',
  'assigned',
  'running',
  'verifying',
  'reviewing',
  'merging',
  'rework',
  'done',
  'failed',
  'cancelled',
] as const

/** Every RunStatus, as data. */
export const RUN_STATUSES = [
  'starting',
  'working',
  'pause_requested',
  'paused',
  'resuming',
  'stopping',
  'stopped',
  'succeeded',
  'failed',
] as const

export const ACTORS = ['human', 'agent', 'system'] as const

/**
 * Compile-time proof that the lists above are neither short nor long.
 * `Exclude<A, B>` is `never` only when every member of A appears in B.
 *
 * `AssertNever<T extends never>` only type-checks when `T` actually is
 * `never`; applying it to a non-`never` type reports the offending member(s)
 * as a constraint violation. This is purely type-level — it has no runtime
 * footprint at all, unlike an `x: Never[] = []` assignment, which type-checks
 * for *any* element type because an empty array literal has no elements to
 * conflict with the declared type and so proves nothing.
 */
type _TaskStatusesComplete = Exclude<TaskStatus, (typeof TASK_STATUSES)[number]>
type _TaskStatusesSound = Exclude<(typeof TASK_STATUSES)[number], TaskStatus>
type _RunStatusesComplete = Exclude<RunStatus, (typeof RUN_STATUSES)[number]>
type _RunStatusesSound = Exclude<(typeof RUN_STATUSES)[number], RunStatus>

type AssertNever<T extends never> = T

type _AssertTaskStatusesComplete = AssertNever<_TaskStatusesComplete>
type _AssertTaskStatusesSound = AssertNever<_TaskStatusesSound>
type _AssertRunStatusesComplete = AssertNever<_RunStatusesComplete>
type _AssertRunStatusesSound = AssertNever<_RunStatusesSound>
