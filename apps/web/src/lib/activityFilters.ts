/**
 * The activity timeline's filter vocabulary: the six user-facing "kinds" that group the 29
 * `DomainEventType`s, the `ActivityFilters` shape parsed from a URL's query params, and the
 * predicate that decides whether one event matches those filters. Pure — no `prisma`, no React —
 * so it is importable from both server routes (`?agents=`, `?tasks=`, `?types=`, `?kinds=` parsing)
 * and client hooks, exactly like `feedSummary` (ruling R3 precedent).
 */

import { z } from 'zod'
import { EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@ai-team-os/db'

export const ACTIVITY_KINDS = ['runs', 'tool_calls', 'tasks', 'interventions', 'guardrails', 'workspace'] as const

export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

/**
 * Every domain event type assigned to exactly one kind. `satisfies` is load-bearing: dropping a
 * type here (or double-assigning one) fails the build only if it also breaks the record's shape,
 * so the completeness test above is what actually proves exhaustiveness at runtime.
 */
export const TYPES_BY_KIND = {
  runs: ['run.started', 'run.succeeded', 'run.failed', 'run.paused', 'run.resumed'],
  tool_calls: ['run.tool_call', 'run.output'],
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
  ],
  interventions: ['run.pause_requested', 'run.resume_requested', 'run.stopped', 'agent.message_sent'],
  guardrails: ['guardrail.tripped'],
  // The workspace's own lifecycle -- the goal, the plan it became, the company later assigned to
  // run it (M10), and a change to its runtime or budget (M13). Not under `guardrails`: the kinds
  // are user vocabulary (FilterBar chips), and a user filtering to guardrail trips must not
  // receive planning/assignment events, nor lose the only chip that can filter to them.
  // `workspace.settings_changed` belongs here even though the budget it can move is what
  // `guardrail.tripped` later enforces: this chip answers "what did an operator change about this
  // workspace", which is where an operator looks when a dispatch starts refusing.
  workspace: [
    'workspace.goal_set',
    'workspace.plan_created',
    'workspace.company_assigned',
    'workspace.settings_changed',
  ],
} as const satisfies Record<ActivityKind, readonly DomainEventType[]>

export interface ActivityFilters {
  readonly agents: readonly string[] // empty = all
  readonly tasks: readonly string[]
  readonly types: readonly DomainEventType[] // ALREADY the union of ?types and expanded ?kinds
}

export const EMPTY_ACTIVITY_FILTERS: ActivityFilters = {
  agents: [],
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
    agents: commaList,
    tasks: commaList,
    types: typesList,
    kinds: kindsList,
  })
  .transform(({ agents, tasks, types, kinds }): ActivityFilters => {
    const expanded = kinds.flatMap((kind) => TYPES_BY_KIND[kind as ActivityKind])
    const union = new Set<DomainEventType>([...types, ...expanded] as DomainEventType[])
    return { agents, tasks, types: [...union] }
  })

export function parseActivityFilters(
  params: URLSearchParams,
): { ok: true; filters: ActivityFilters } | { ok: false; error: string } {
  const result = activityFiltersSchema.safeParse({
    agents: params.get('agents'),
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
  if (filters.agents.length > 0) params.set('agents', [...filters.agents].sort().join(','))
  if (filters.tasks.length > 0) params.set('tasks', [...filters.tasks].sort().join(','))
  if (filters.types.length > 0) params.set('types', [...filters.types].sort().join(','))
  return params.toString()
}

export function eventMatchesFilters(
  event: { readonly agentId: string | null; readonly taskId: string | null; readonly type: string },
  filters: ActivityFilters,
): boolean {
  if (filters.agents.length > 0 && (event.agentId === null || !filters.agents.includes(event.agentId))) {
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
