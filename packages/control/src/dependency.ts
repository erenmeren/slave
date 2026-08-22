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
const ADD_DEPENDENCY_TIMEOUT_MS = 5_000
const ADD_DEPENDENCY_MAX_WAIT_MS = 2_000

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

  const outcome = await prisma.$transaction(
    async (tx) => {
      // Read Committed (Postgres's default, and this transaction names no `isolationLevel`) gives
      // each statement its own fresh snapshot -- it does not make read-then-decide-then-write
      // atomic against a second transaction doing the same thing. Two operators adding A->B and
      // B->A at the same instant would each run the cycle CTE below before either INSERT commits:
      // neither sees the other's uncommitted row, both CTEs report "no cycle" truthfully for the
      // graph as *they* observed it, and both inserts land -- the composite `@@id` doesn't even
      // fire, because the two rows have different keys. The result is a live cycle in
      // "TaskDependency" that `dependenciesDone` (apps/orchestrator/src/world.ts) evaluates as
      // permanently false for both tasks, with no error, no refusal, and nothing in the event log
      // to explain why the scheduler stopped picking them up.
      //
      // A workspace-scoped row lock closes this: every edge is intra-workspace (the cross-workspace
      // refusal above guarantees `task.workspaceId === dependsOnTask.workspaceId`), so the
      // workspace row is the smallest lock that still covers every pair of adds that could
      // possibly close a loop between each other. The second transaction blocks here until the
      // first commits or rolls back; when it resumes, its own reads (the duplicate pre-check and
      // the cycle CTE) see the first transaction's now-committed row, and correctly refuse it --
      // as `duplicate_dependency` if it was the same edge, as `dependency_cycle` if it was the
      // reverse edge this comment opened with. `FOR UPDATE` is used (not just `FOR SHARE`)
      // because every writer here needs exclusivity, not just a read guarantee.
      await tx.$queryRaw`SELECT 1 FROM "Workspace" WHERE id = ${task.workspaceId} FOR UPDATE`

      // Pre-check rather than catching the composite primary key's unique violation: every other
      // refusal in this package (and this function's own cross-workspace/self checks above) is a
      // read-then-decide, not exception-driven control flow, and the codebase has no precedent
      // anywhere for catching Prisma's P2002. The lock above now closes the concurrency window
      // this used to leave open: a second transaction racing the same edge blocks on the
      // workspace row until the first commits, then finds the row here and refuses gracefully.
      const duplicate = await tx.taskDependency.findUnique({
        where: { taskId_dependsOnTaskId: { taskId, dependsOnTaskId } },
      })
      if (duplicate !== null) {
        return {
          ok: false as const,
          error: { kind: 'duplicate_dependency', taskId, dependsOnTaskId } as ControlRefusal,
        }
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
        return {
          ok: false as const,
          error: { kind: 'dependency_cycle', taskId, dependsOnTaskId } as ControlRefusal,
        }
      }

      await tx.taskDependency.create({ data: { taskId, dependsOnTaskId } })
      return { ok: true as const }
    },
    {
      // Named rather than left to Prisma's defaults (which happen to match these numbers today) --
      // see `world.ts:240`'s own comment for why silently inheriting a driver default is worth
      // avoiding on a path that can now block on a lock. This is a human-triggered write, not a
      // per-tick loop: a short queue behind one workspace's lock during a burst of concurrent adds
      // is expected and fine, and 2s to acquire a connection / 5s to finish once acquired is ample
      // for that queue to drain without an operator seeing a mysterious `P2028`.
      timeout: ADD_DEPENDENCY_TIMEOUT_MS,
      maxWait: ADD_DEPENDENCY_MAX_WAIT_MS,
    },
  )

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
