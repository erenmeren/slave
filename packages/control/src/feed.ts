import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { HAPPENING_TYPES, happeningSentence } from '@slave-of-ai/domain'

/** The most feed sentences {@link recentFeed} will read however large a `limit` a caller names.
 *  `CHAT_FEED_MAX` is twenty and the prompt keeps only the newest twenty anyway; this is the bound
 *  on the QUERY, so a caller that asks for a thousand does not turn one chat turn into a read of
 *  the whole event log. Five times the window: far past anything a turn shows, far short of a
 *  project's history. */
export const RECENT_FEED_MAX = 100

/**
 * "What has been happening here", as the sentences a person reads (F R2).
 *
 * `apps/web/src/server/happeningRows.ts` in `packages/control`'s own vocabulary: the same
 * `HAPPENING_TYPES` filter, the same newest-first paging by `seq`, the same two batched name
 * reads, and the same `happeningSentence` -- which is why that function moved into the domain
 * (`packages/domain/src/feed/`) rather than being copied here. Two readers, one table of
 * sentences; a second copy would be a feed that says one thing on Home and another to the
 * Supervisor.
 *
 * NEWEST FIRST out of Postgres, returned OLDEST FIRST: `buildSupervisorChatPrompt` sorts by `seq`
 * itself and takes the last {@link CHAT_FEED_MAX}, so the order here cannot change what the model
 * reads -- but the caller of a "recent" list is entitled to one that reads forwards, and
 * `renderedChatSources` pairs a citation with `seq` rather than with a position.
 *
 * `seq` is the event log's own, which is what makes a citation checkable: the prompt prints
 * `[<seq>]` and `verifySources` looks the number up in exactly the window the prompt rendered.
 */
export async function recentFeed(
  workspaceId: string,
  limit: number,
): Promise<readonly { readonly seq: number; readonly sentence: string }[]> {
  const take = Math.min(Math.max(0, Math.trunc(limit)), RECENT_FEED_MAX)
  if (take === 0) return []

  const rows = await prisma.executionEvent.findMany({
    where: { workspaceId, type: { in: HAPPENING_TYPES.map((type) => EVENT_TYPE_BY_DOMAIN_TYPE[type]) } },
    orderBy: { seq: 'desc' },
    take,
    select: { seq: true, type: true, payload: true, slaveId: true, taskId: true },
  })

  // Two batched reads for the whole page, never one per row -- `loadHappeningRows`' own shape. A
  // sentence needs the worker's PERSON name (a seat is not a name since M58) and the task's title.
  const slaveIds = [...new Set(rows.map((row) => row.slaveId).filter((id): id is string => id !== null))]
  const taskIds = [...new Set(rows.map((row) => row.taskId).filter((id): id is string => id !== null))]
  const [slaves, tasks] = await Promise.all([
    slaveIds.length === 0
      ? []
      : prisma.slave.findMany({ where: { id: { in: slaveIds } }, select: { id: true, person: { select: { name: true } } } }),
    taskIds.length === 0 ? [] : prisma.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, title: true } }),
  ])
  const nameBySlaveId = new Map(slaves.map((slave) => [slave.id, slave.person.name]))
  const titleByTaskId = new Map(tasks.map((task) => [task.id, task.title]))

  return rows
    .map((row) => {
      // The DOMAIN spelling, never the column's (`docs/ia.md` rule 3): `happeningSentence` keys on
      // `task.done`, and the database stores `task_done`. A value the map does not hold is passed
      // through rather than dropped -- the sentence table's own fallback then names it in words.
      const type = DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? (row.type as DomainEventType)
      const payload = row.payload as Record<string, unknown>
      return {
        // `ExecutionEvent.seq` is a `BigInt` column; the prompt prints it and a citation names it
        // as text, so it crosses into the domain as a `number` -- the same narrowing
        // `loadHappeningRows` makes when it stringifies the row's id.
        seq: Number(row.seq),
        sentence: happeningSentence(type, payload, {
          actor: row.slaveId === null ? null : (nameBySlaveId.get(row.slaveId) ?? null),
          taskTitle: row.taskId === null ? null : (titleByTaskId.get(row.taskId) ?? null),
        }),
      }
    })
    .reverse()
}
