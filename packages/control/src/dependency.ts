import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import type { ControlRefusal } from './refusal.js'

/**
 * Records that `taskId` cannot start until `dependsOnTaskId` reaches `done` -- the edge
 * `apps/orchestrator/src/world.ts`'s `dependenciesDone` reads to gate `decide()`.
 *
 * The refusals run cheapest-and-most-obvious first, entirely outside any transaction: a
 * self-edge or a missing task needs no database round trip beyond the read already required to
 * report it, and a cross-workspace edge is refused on the same two rows. What remains --
 * duplicate and cycle -- both need to observe the graph as it stands *right now*, so they run
 * together with the insert inside one `prisma.$transaction`: nothing else can slip an edge in
 * between the cycle check reading the graph and the insert changing it. See `appendEvent`'s own
 * doc comment in `packages/events/src/append.ts` for why the event append below is *not* inside
 * that same transaction -- it opens (and serialises on) its own, against the process-wide
 * `prisma` client rather than this function's `tx`, and every other control operation in this
 * package (`resume.ts`, `pause.ts`, `stop.ts`) already accepts that gap: the write is claimed
 * first, the event follows immediately after, uncommitted only for the width of one `await`.
 */
export async function addTaskDependency(
  taskId: string,
  dependsOnTaskId: string,
  requestedBy: string,
): Promise<Result<void, ControlRefusal>> {
  if (taskId === dependsOnTaskId) return err({ kind: 'self_dependency', taskId })

  const [task, dependsOnTask] = await Promise.all([
    prisma.task.findUnique({ where: { id: taskId } }),
    prisma.task.findUnique({ where: { id: dependsOnTaskId } }),
  ])
  if (task === null) return err({ kind: 'task_not_found', taskId })
  if (dependsOnTask === null) return err({ kind: 'task_not_found', taskId: dependsOnTaskId })
  if (task.workspaceId !== dependsOnTask.workspaceId) {
    return err({ kind: 'cross_workspace', taskId, dependsOnTaskId })
  }

  const outcome = await prisma.$transaction(async (tx) => {
    // Pre-check rather than catching the composite primary key's unique violation: every other
    // refusal in this package (and this function's own cross-workspace/self checks above) is a
    // read-then-decide, not exception-driven control flow, and the codebase has no precedent
    // anywhere for catching Prisma's P2002. The narrow gap this leaves -- two concurrent adds of
    // the exact same edge both passing this check -- is closed by the composite `@@id` regardless:
    // the loser's `create` throws, which is a 500 an operator can retry, not a silent double
    // insert. That is an acceptable trade for staying in the codebase's existing idiom.
    const duplicate = await tx.taskDependency.findUnique({
      where: { taskId_dependsOnTaskId: { taskId, dependsOnTaskId } },
    })
    if (duplicate !== null) {
      return { ok: false as const, error: { kind: 'duplicate_dependency', taskId, dependsOnTaskId } as ControlRefusal }
    }

    // Reachability from `dependsOnTaskId` outward, following existing `taskId -> dependsOnTaskId`
    // edges. If `taskId` is reachable, adding this edge would close a cycle: something
    // `dependsOnTaskId` already (transitively) depends on is `taskId` itself. The seed row alone
    // already covers the direct 2-cycle (dependsOnTaskId depends directly on taskId) -- no
    // separate check needed; see the "direct 2-cycle" test.
    const reach = await tx.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE reach(id) AS (
        SELECT "dependsOnTaskId" FROM "TaskDependency" WHERE "taskId" = ${dependsOnTaskId}
        UNION
        SELECT td."dependsOnTaskId" FROM "TaskDependency" td JOIN reach r ON td."taskId" = r.id
      )
      SELECT id FROM reach WHERE id = ${taskId} LIMIT 1
    `
    if (reach.length > 0) {
      return { ok: false as const, error: { kind: 'dependency_cycle', taskId, dependsOnTaskId } as ControlRefusal }
    }

    await tx.taskDependency.create({ data: { taskId, dependsOnTaskId } })
    return { ok: true as const }
  })

  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'task.dependency_added',
    workspaceId: task.workspaceId,
    taskId,
    actor: 'human',
    payload: { dependsOnTaskId, dependsOnTitle: dependsOnTask.title, requestedBy },
  })
  return ok(undefined)
}

/**
 * Removes the `taskId -> dependsOnTaskId` edge. Conditioned on both ids in one `deleteMany`
 * rather than a `findUnique` followed by a `delete`, so an edge already gone (removed twice, or
 * never created) is a plain refusal rather than a thrown "record not found".
 */
export async function removeTaskDependency(
  taskId: string,
  dependsOnTaskId: string,
  requestedBy: string,
): Promise<Result<void, ControlRefusal>> {
  const deleted = await prisma.taskDependency.deleteMany({ where: { taskId, dependsOnTaskId } })
  if (deleted.count === 0) return err({ kind: 'dependency_not_found', taskId, dependsOnTaskId })

  // The FK on `TaskDependency` guarantees both tasks existed at the moment the edge did, and
  // removing the edge does not touch the `Task` rows themselves -- these reads are safe even
  // though they run after the delete.
  const [task, dependsOnTask] = await Promise.all([
    prisma.task.findUniqueOrThrow({ where: { id: taskId } }),
    prisma.task.findUniqueOrThrow({ where: { id: dependsOnTaskId } }),
  ])

  await appendEvent({
    type: 'task.dependency_removed',
    workspaceId: task.workspaceId,
    taskId,
    actor: 'human',
    payload: { dependsOnTaskId, dependsOnTitle: dependsOnTask.title, requestedBy },
  })
  return ok(undefined)
}
