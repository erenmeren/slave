import { prisma } from '@ai-team-os/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@ai-team-os/db'
import { feedSummary } from '../lib/feedSummary'
import type { ActivityFilters } from '../lib/activityFilters'

export interface ActivityEventRow {
  readonly seq: number
  readonly ts: string
  readonly type: DomainEventType
  readonly actor: string
  readonly agentId: string | null
  readonly taskId: string | null
  readonly runId: string | null
  readonly payload: Record<string, unknown>
  readonly summary: string
}

export interface ActivityHistoryPage {
  readonly events: readonly ActivityEventRow[]
  readonly nextBefore: number | null
}

export const ACTIVITY_PAGE_LIMIT_DEFAULT = 100
export const ACTIVITY_PAGE_LIMIT_MAX = 200

/**
 * Pages the workspace's execution event log newest-first for the activity timeline. Reads only —
 * every write to `ExecutionEvent` goes through `appendEvent` (`@ai-team-os/events`), never here.
 *
 * `before` is an exclusive `seq` cursor (`seq < before`); `nextBefore` is the oldest `seq` in the
 * page just returned, or `null` once a page comes back shorter than requested — the log is
 * exhausted, not just this page's slice of it.
 */
export async function buildActivityHistory(
  workspaceId: string,
  filters: ActivityFilters,
  options?: { readonly before?: number; readonly limit?: number },
): Promise<ActivityHistoryPage | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  const take = Math.min(options?.limit ?? ACTIVITY_PAGE_LIMIT_DEFAULT, ACTIVITY_PAGE_LIMIT_MAX)

  const rows = await prisma.executionEvent.findMany({
    where: {
      workspaceId,
      ...(filters.agents.length > 0 ? { agentId: { in: [...filters.agents] } } : {}),
      ...(filters.tasks.length > 0 ? { taskId: { in: [...filters.tasks] } } : {}),
      ...(filters.types.length > 0
        ? { type: { in: filters.types.map((type) => EVENT_TYPE_BY_DOMAIN_TYPE[type]) } }
        : {}),
      ...(options?.before !== undefined ? { seq: { lt: options.before } } : {}),
    },
    orderBy: { seq: 'desc' },
    take,
  })

  const events: ActivityEventRow[] = rows.map((row) => {
    const domainType = DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? (row.type as DomainEventType)
    const payload = row.payload as Record<string, unknown>
    return {
      seq: Number(row.seq),
      ts: row.ts.toISOString(),
      type: domainType,
      actor: row.actor,
      agentId: row.agentId,
      taskId: row.taskId,
      runId: row.runId,
      payload,
      summary: feedSummary(domainType, payload),
    }
  })

  const lastRow = events.at(-1)
  const nextBefore = events.length < take || lastRow === undefined ? null : lastRow.seq

  return { events, nextBefore }
}
