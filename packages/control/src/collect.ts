import { existsSync } from 'node:fs'
import { prisma } from '@slave-of-ai/db/client'
import { NON_TERMINAL_RUN_STATUSES, TERMINAL, err, ok, type Result } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { gitIn } from './git.js'
import { isAlive } from './kill.js'
import type { ControlRefusal } from './refusal.js'
import type { Principal } from './principal.js'

export const WORKTREE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The clock for ageing: the latest terminal event's `ts` (spec §3 B1). No column -- the log is
 * the source of truth. `null` for a terminal task with no such event (pre-M8 seed rows).
 *
 * The `in` list is `['task_done', 'task_failed']`, not the three the spec's B1 wording names:
 * `task.cancelled` is not an `EventType` member at all (checked `schema.prisma` and
 * `events/schema.ts`) -- there is no such event to look for. A cancelled task
 * (`requestStop`, `packages/control/src/stop.ts`) logs `run.stopped` and moves the *task* to
 * `blocked`, never to `cancelled`; nothing in this codebase ever writes `Task.status = 'cancelled'`
 * outside the pure state machine in `packages/domain/src/task/state.ts`. So a cancelled task, as
 * this codebase actually produces one, has no terminal event and is collectable on demand only
 * (an operator's button), never aged by this function -- `terminalTimestamp` returns `null` for
 * it and the aged pass (Task 5) skips anything it cannot date.
 */
export async function terminalTimestamp(taskId: string): Promise<Date | null> {
  const row = await prisma.executionEvent.findFirst({
    where: { taskId, type: { in: ['task_done', 'task_failed'] } },
    orderBy: { seq: 'desc' },
    select: { ts: true },
  })
  return row?.ts ?? null
}

/**
 * Spec §3 B2. One implementation for both the aged pass and the operator's button.
 *
 * The row lock (`FOR UPDATE`) has to outlive the git call and the `worktreePath` write, not just
 * the read (M23 B2 fix round 1, Important 1): the aged pass and the operator button are exactly
 * the pair of callers that can name the same terminal task at once, and a lock released after the
 * *check* lets both see the same non-null path -- the second `git worktree remove` then throws on
 * a directory the first already deleted, out of a function whose contract is `Promise<Result<…>>`,
 * with no catch anywhere above it. Holding the lock across the whole thing serializes the two: the
 * second caller wakes up (after the first's transaction commits) to a run with no worktree path at
 * all, and gets the ordinary `nothing_to_collect` refusal instead of an unhandled rejection.
 *
 * `timeout: 30_000` (Prisma's default is 5s) because the git call now runs *inside* the
 * transaction it used to run after: `worktree remove` on a large tree is not bounded by anything
 * this function controls, and a transaction that times out mid-`git` would roll back a DB write
 * that already has no matching filesystem state to redo.
 */
export async function collectTaskWorktree(
  taskId: string,
  reason: 'aged' | 'operator',
  principal?: Principal,
): Promise<Result<{ path: string }, ControlRefusal>> {
  const plan = await prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Task" WHERE id = ${taskId} FOR UPDATE`
      if (locked.length === 0) return { refusal: { kind: 'task_not_found', taskId } as const }
      const task = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        include: { workspace: { select: { id: true, repoPath: true } }, runs: { select: { id: true, status: true, pid: true, worktreePath: true } } },
      })
      if (!TERMINAL.includes(task.status)) return { refusal: { kind: 'task_not_terminal', taskId, status: task.status } as const }
      for (const run of task.runs) {
        const live = (NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status) || (run.pid !== null && isAlive(run.pid))
        if (live) return { refusal: { kind: 'run_still_alive', taskId, runId: run.id } as const }
      }
      const path = task.runs.map((run) => run.worktreePath).find((candidate): candidate is string => candidate !== null)
      if (path === undefined) return { refusal: { kind: 'nothing_to_collect', taskId } as const }

      // The row said there was a tree; the disk decides what to run. A directory that is already
      // gone leaves a stale registration `worktree prune` clears; a present one is removed with
      // --force because a terminal task's dirty files are not worth keeping (the branch keeps the
      // commits). Caught here, inside the lock: a throw that escaped would leave the transaction
      // to roll back nothing useful (no write has happened yet) while unwinding through a
      // `Promise<Result<…>>` contract that has nowhere to put it.
      try {
        if (existsSync(path)) await gitIn(task.workspace.repoPath, 'worktree', 'remove', '--force', path)
        else await gitIn(task.workspace.repoPath, 'worktree', 'prune')
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return { refusal: { kind: 'worktree_remove_failed', taskId, path, reason } as const }
      }

      await tx.agentRun.updateMany({ where: { taskId, worktreePath: path }, data: { worktreePath: null } })
      return { task, path }
    },
    { timeout: 30_000 },
  )
  if ('refusal' in plan) return err(plan.refusal)
  const { task, path } = plan

  // Outside the transaction, after it has committed (ADR 0003): `appendEvent` runs its own
  // transaction and the two must not nest -- committing the removal must not wait on the event
  // log, and a failure to append must not undo a worktree that is already gone from disk.
  await appendEvent({
    type: 'task.worktree_collected',
    workspaceId: task.workspace.id,
    taskId,
    actor: reason === 'aged' ? 'system' : 'human',
    payload: { path, reason, branch: task.branch },
    userId: principal?.userId ?? null,
  })
  return ok({ path })
}
