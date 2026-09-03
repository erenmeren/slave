import { existsSync } from 'node:fs'
import { prisma } from '@ai-team-os/db/client'
import { NON_TERMINAL_RUN_STATUSES, TERMINAL, err, ok, type Result } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
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

/** Spec §3 B2. One implementation for both the aged pass and the operator's button. */
export async function collectTaskWorktree(
  taskId: string,
  reason: 'aged' | 'operator',
  _principal?: Principal,
): Promise<Result<{ path: string }, ControlRefusal>> {
  const plan = await prisma.$transaction(async (tx) => {
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
    return { task, path }
  })
  if ('refusal' in plan) return err(plan.refusal)
  const { task, path } = plan

  // The row said there was a tree; the disk decides what to run. A directory that is already gone
  // leaves a stale registration `worktree prune` clears; a present one is removed with --force
  // because a terminal task's dirty files are not worth keeping (the branch keeps the commits).
  if (existsSync(path)) await gitIn(task.workspace.repoPath, 'worktree', 'remove', '--force', path)
  else await gitIn(task.workspace.repoPath, 'worktree', 'prune')

  await prisma.agentRun.updateMany({ where: { taskId, worktreePath: path }, data: { worktreePath: null } })
  await appendEvent({
    type: 'task.worktree_collected',
    workspaceId: task.workspace.id,
    taskId,
    actor: reason === 'aged' ? 'system' : 'human',
    payload: { path, reason, branch: task.branch },
  })
  return ok({ path })
}
