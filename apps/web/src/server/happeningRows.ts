import { prisma, type Prisma } from '@slave-of-ai/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@slave-of-ai/db'
import { HAPPENING_TYPES, happeningSentence } from '../lib/happening'

/**
 * One `HAPPENING_TYPES` event, said as a sentence (M61 controller Ruling 1).
 *
 * The one read `activityDigest.ts` and, later, Home's own feed (Task 8) both build on: the
 * `Event` query (`type in HAPPENING_TYPES`), the slave-name and task-title resolution, and
 * `happeningSentence`. `where` carries the workspace filter (and anything else a caller wants to
 * narrow by) rather than this module hardcoding `workspaceId` itself, so a future caller scoped
 * differently -- Home reads across every workspace a person can see -- is still one function.
 */
export interface HappeningRow {
  readonly id: string
  /** ISO. */
  readonly at: string
  /** The domain spelling (`task.done`, not the DB's `task_done`) -- `docs/ia.md` rule 3: the raw
   *  type rides on an attribute, never as the visible word. */
  readonly type: string
  readonly workspaceId: string
  readonly actorName: string | null
  readonly taskTitle: string | null
  readonly sentence: string
  readonly payload: Record<string, unknown>
}

/**
 * Pages `HAPPENING_TYPES` events newest-first through `happeningSentence`, resolving the two names
 * a sentence needs (the slave's person, the task's title) in two batched queries rather than one
 * per row.
 */
export async function loadHappeningRows(
  where: Prisma.ExecutionEventWhereInput,
  take: number,
): Promise<readonly HappeningRow[]> {
  const rows = await prisma.executionEvent.findMany({
    where: { ...where, type: { in: HAPPENING_TYPES.map((type) => EVENT_TYPE_BY_DOMAIN_TYPE[type]) } },
    orderBy: { seq: 'desc' },
    take,
  })

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

  return rows.map((row): HappeningRow => {
    const type = DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? (row.type as DomainEventType)
    const payload = row.payload as Record<string, unknown>
    const actorName = row.slaveId !== null ? (nameBySlaveId.get(row.slaveId) ?? null) : null
    const taskTitle = row.taskId !== null ? (titleByTaskId.get(row.taskId) ?? null) : null
    return {
      id: String(row.seq),
      at: row.ts.toISOString(),
      type,
      workspaceId: row.workspaceId,
      actorName,
      taskTitle,
      sentence: happeningSentence(type, payload, { actor: actorName, taskTitle }),
      payload,
    }
  })
}
