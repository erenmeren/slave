/**
 * The activity timeline's filter vocabulary: the six user-facing "kinds" that group every
 * `DomainEventType`, the `ActivityFilters` shape parsed from a URL's query params, and the
 * predicate that decides whether one event matches those filters. Pure — no `prisma`, no React —
 * so it is importable from both server routes (`?slaves=`, `?tasks=`, `?types=`, `?kinds=` parsing)
 * and client hooks, exactly like `feedSummary` (ruling R3 precedent).
 */

import { z } from 'zod'
import { EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@slave-of-ai/db'

export const ACTIVITY_KINDS = ['runs', 'tool_calls', 'tasks', 'interventions', 'guardrails', 'workspace'] as const

export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

/**
 * Every domain event type assigned to exactly one kind. `satisfies` is load-bearing: dropping a
 * type here (or double-assigning one) fails the build only if it also breaks the record's shape,
 * so the completeness test above is what actually proves exhaustiveness at runtime.
 */
export const TYPES_BY_KIND = {
  // M51 R2: a breaker rung is something that happened to the RUN, beside `run.paused`/`run.resumed`
  // -- the chip somebody filters to when asking "what happened to this run". Deliberately not
  // `guardrails`: that chip is `guardrail.tripped` alone, which is where the STOP rung announces
  // itself, and a person filtering for "what stopped work" must not also receive the two quieter
  // rungs that did not stop anything.
  runs: ['run.started', 'run.succeeded', 'run.failed', 'run.paused', 'run.resumed', 'run.breaker'],
  // `run.tool_denied` sits beside `run.tool_call`, not under `runs`: it is a per-call refusal
  // (M18 §2) an operator filtering to individual tool activity needs, not a run lifecycle event.
  // M51 R1: a tool RESULT sits beside the call it answers, under the same chip an operator filters
  // to when they want per-call activity. Not under `runs`: it is not a run lifecycle event, and one
  // per call would swamp that chip.
  // M52 R3: a brokered operation is PER-CALL activity -- a worker asked the orchestrator for
  // something inside its own turn -- so both ends of it sit beside the call and the refusal an
  // operator already filters to here. Deliberately not `guardrails`, which is `guardrail.tripped`
  // alone (plan decision D31): nothing about a refused broker call stops work.
  tool_calls: [
    'run.tool_call',
    'run.output',
    'run.tool_denied',
    'run.tool_result',
    'broker.executed',
    'broker.refused',
  ],
  tasks: [
    'task.created',
    'task.started',
    'task.done',
    'task.rework',
    'task.verifying',
    'task.verify_passed',
    'task.verify_failed',
    'task.failed',
    'task.dependency_added',
    'task.dependency_removed',
    'task.review_started',
    'task.review_approved',
    'task.review_rejected',
    'task.merge_failed',
    'task.worktree_collected',
    // M35 t2: `confirmIntegration` stamped a done, hand-merged task's `integratedAt` -- a task
    // outcome, the same chip as `task.done` and `task.merge_failed` beside it.
    'task.integrated',
    // M35 t5: `unblockTask` moved a `blocked` task back to `rework` -- a task lifecycle event,
    // the same chip `task.rework` sits under.
    'task.unblocked',
    // M40 t1: a task taken off the board is a task outcome, beside `task.failed` -- it carries a
    // taskId and it is the end of that task's life.
    'task.cancelled',
  ],
  // M39 t2: `slave.message_reassigned` sits beside `slave.message_sent` -- a question put in front
  // of a different worker is an intervention in the mailbox, the same chip an operator filters to
  // when asking "who has been made to do what", whether the Supervisor or a person moved it.
  interventions: [
    'run.pause_requested',
    'run.resume_requested',
    'run.stopped',
    'slave.message_sent',
    'slave.message_reassigned',
  ],
  guardrails: ['guardrail.tripped'],
  // The workspace's own lifecycle -- the goal, the plan it became, the company later assigned to
  // run it (M10), and a change to its runtime or budget (M13). Not under `guardrails`: the kinds
  // are user vocabulary (FilterBar chips), and a user filtering to guardrail trips must not
  // receive planning/assignment events, nor lose the only chip that can filter to them.
  // `workspace.settings_changed` belongs here even though the budget it can move is what
  // `guardrail.tripped` later enforces: this chip answers "what did an operator change about this
  // workspace", which is where an operator looks when a dispatch starts refusing.
  // `org.changed` (M23 D1) joins the same chip for the same reason: the roster (a project's
  // `Team`/`Slave` rows) is workspace configuration, not a run outcome, and it carries no taskId
  // of its own to sort it under `tasks` instead.
  workspace: [
    'workspace.created',
    'workspace.goal_set',
    'workspace.plan_created',
    // M40 t1: a goal change on a non-empty board starts a delta re-plan, and both ends of that are
    // workspace lifecycle for the same reason `workspace.plan_created` is -- neither carries a
    // taskId, and an operator asking "what changed about this project" is who reads them.
    'workspace.replan_started',
    'workspace.replanned',
    'workspace.company_assigned',
    'workspace.settings_changed',
    'org.changed',
    // M27 §3.2: archiving/restoring a project is workspace lifecycle, the same chip as
    // `workspace.created` -- not a run outcome and not a guardrail trip.
    'workspace.archived',
    'workspace.restored',
    // M37 t3: a persona rewritten and a runtime role set replaced are both operator changes to
    // the roster, the same chip `org.changed` sits under -- what an operator looks at when a
    // worker stops being dispatched, or starts answering differently. Not `runs`: neither can be
    // written by a run (spec §1), and neither carries a taskId.
    'slave.profile_changed',
    'slave.runtime_roles_changed',
    // M38 t1: the Supervisor's five events. This chip, for the same reason `org.changed` sits
    // here: a Supervisor decision is something that happened TO the workspace's configuration and
    // pipeline, not a run outcome, and none of the five carries a runId. Not `guardrails` either
    // -- the Supervisor is what an operator reaches for AFTER a guardrail trip, and a user
    // filtering to trips must not have the decisions about them mixed in.
    // M48 t1: adopting (or clearing) a runbook is a change to HOW this project will work -- the
    // same chip `workspace.goal_set` and `workspace.plan_created` sit under, for their reason: it
    // carries no taskId and no runId, and an operator asking "what changed about this project"
    // is who reads it.
    'workspace.runbook_adopted',
    'supervisor.decided',
    'supervisor.proposed',
    'supervisor.applied',
    'supervisor.resolved',
    'supervisor.failed',
    // M49 t1: knowledge written down or moved is something that happened TO this project's
    // understanding of itself, the same chip `workspace.goal_set` sits under -- not a run outcome,
    // and (for the ones a person makes) not a guardrail trip either.
    'memory.recorded',
    'memory.changed',
    // M50 t1: a worker's engagement ending is a change to the project's roster, the same chip
    // `org.changed` and `slave.runtime_roles_changed` sit under -- not a run outcome, and it
    // carries no taskId of its own.
    'slave.released',
    // M52 R5: what a worker may DO is project configuration, beside `org.changed` and
    // `slave.runtime_roles_changed` (plan decision D31) -- it carries no taskId, it is not a run
    // outcome, and an operator asking "what changed about this project" is who reads it.
    'permission.changed',
    // M53 R9: who should take a capability is project CONFIGURATION, beside `org.changed` and
    // `permission.changed` -- it carries no taskId, it is not a run outcome, and an operator asking
    // "what changed about this project" is who reads it.
    'staffing.preference_changed',
  ],
} as const satisfies Record<ActivityKind, readonly DomainEventType[]>

export interface ActivityFilters {
  readonly slaves: readonly string[] // empty = all
  readonly tasks: readonly string[]
  readonly types: readonly DomainEventType[] // ALREADY the union of ?types and expanded ?kinds
}

export const EMPTY_ACTIVITY_FILTERS: ActivityFilters = {
  slaves: [],
  tasks: [],
  types: [],
}

const KNOWN_TYPES = Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE) as DomainEventType[]

const commaList = z
  .string()
  .nullish()
  .transform((raw) => (raw ?? '').split(',').filter(Boolean))

const kindsList = z
  .string()
  .nullish()
  .transform((raw) => (raw ?? '').split(',').filter(Boolean))
  .refine((kinds) => kinds.every((kind) => (ACTIVITY_KINDS as readonly string[]).includes(kind)), {
    message: 'unknown kind',
  })

const typesList = z
  .string()
  .nullish()
  .transform((raw) => (raw ?? '').split(',').filter(Boolean))
  .refine((types) => types.every((type) => KNOWN_TYPES.includes(type as DomainEventType)), {
    message: 'unknown type',
  })

const activityFiltersSchema = z
  .object({
    slaves: commaList,
    tasks: commaList,
    types: typesList,
    kinds: kindsList,
  })
  .transform(({ slaves, tasks, types, kinds }): ActivityFilters => {
    const expanded = kinds.flatMap((kind) => TYPES_BY_KIND[kind as ActivityKind])
    const union = new Set<DomainEventType>([...types, ...expanded] as DomainEventType[])
    return { slaves, tasks, types: [...union] }
  })

export function parseActivityFilters(
  params: URLSearchParams,
): { ok: true; filters: ActivityFilters } | { ok: false; error: string } {
  const result = activityFiltersSchema.safeParse({
    slaves: params.get('slaves'),
    tasks: params.get('tasks'),
    types: params.get('types'),
    kinds: params.get('kinds'),
  })
  if (!result.success) {
    return { ok: false, error: result.error.message }
  }
  return { ok: true, filters: result.data }
}

/**
 * Inverse of `parseActivityFilters`: serializes only the non-empty dimensions, `types` as
 * dotted domain names comma-joined (already the expanded union — `kinds` never round-trips,
 * only its expansion does). `filtersToQuery(EMPTY_ACTIVITY_FILTERS)` is `''`.
 *
 * Each dimension is sorted before joining. This is the one canonical serialization of a filter
 * *set* — sorting here, rather than only where a caller derives a stable key from this string
 * (`useActivityStream`'s `filterKey`), keeps that guarantee on the single code path instead of
 * requiring every caller to remember it, and is harmless on the wire: the server reads each
 * dimension as a `{ in: [...] }` set (`buildActivityHistory`, `eventMatchesFilters`), never as an
 * ordered list.
 */
export function filtersToQuery(filters: ActivityFilters): string {
  const params = new URLSearchParams()
  if (filters.slaves.length > 0) params.set('slaves', [...filters.slaves].sort().join(','))
  if (filters.tasks.length > 0) params.set('tasks', [...filters.tasks].sort().join(','))
  if (filters.types.length > 0) params.set('types', [...filters.types].sort().join(','))
  return params.toString()
}

export function eventMatchesFilters(
  event: { readonly slaveId: string | null; readonly taskId: string | null; readonly type: string },
  filters: ActivityFilters,
): boolean {
  if (filters.slaves.length > 0 && (event.slaveId === null || !filters.slaves.includes(event.slaveId))) {
    return false
  }
  if (filters.tasks.length > 0 && (event.taskId === null || !filters.tasks.includes(event.taskId))) {
    return false
  }
  if (filters.types.length > 0 && !filters.types.includes(event.type as DomainEventType)) {
    return false
  }
  return true
}
