import { prisma } from '@ai-team-os/db/client'
import { NON_TERMINAL_RUN_STATUSES, type RunStatus, type TaskStatus } from '@ai-team-os/domain'

export interface TaskRunSummary {
  readonly id: string
  readonly status: RunStatus
  /** USD, or `null` when this run's runtime reported no spend (M12 Task 9 -- spec Decision 6). */
  readonly costUsd: number | null
  readonly toolCalls: number
  readonly startedAt: string
  readonly endedAt: string | null
  readonly checkpoint: { readonly pausedAtStep: number | null; readonly sessionId: string; readonly dirtyFileCount: number } | null
}

export interface TaskBoardItem {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly status: TaskStatus
  readonly priority: number
  readonly attempt: number
  readonly maxAttempts: number
  readonly assigneeName: string | null
  readonly branch: string | null
  readonly lastRejectionReason: string | null
  readonly runs: readonly TaskRunSummary[]
}

export interface TasksSnapshot {
  readonly workspace: { readonly id: string; readonly name: string; readonly haltedReason: string | null }
  readonly tasks: readonly TaskBoardItem[]
}

export async function buildTasksSnapshot(workspaceId: string): Promise<TasksSnapshot | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  const tasks = await prisma.task.findMany({
    where: { workspaceId },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    include: { runs: { orderBy: { startedAt: 'desc' }, include: { checkpoint: true, agent: true } } },
  })

  return {
    workspace: { id: workspace.id, name: workspace.name, haltedReason: workspace.haltedReason },
    tasks: tasks.map((task) => {
      const liveRun = task.runs.find((run) => (NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status))
      return {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
        assigneeName: liveRun?.agent.name ?? null,
        branch: task.branch,
        lastRejectionReason: task.lastRejectionReason,
        runs: task.runs.map((run) => ({
          id: run.id,
          status: run.status,
          // Passed through as `number | null` (M12 Task 9, ruling R3). The comment this replaces
          // chose `$0.00` to avoid "widening this DTO to a tri-state" -- widening it is exactly
          // what spec Decision 6 asks for, and `TaskDetailPanel` renders `—` for the null.
          costUsd: run.costUsd,
          toolCalls: run.toolCalls,
          startedAt: run.startedAt.toISOString(),
          endedAt: run.endedAt?.toISOString() ?? null,
          checkpoint:
            run.checkpoint === null
              ? null
              : {
                  pausedAtStep: run.pausedAtStep,
                  sessionId: run.checkpoint.sessionId,
                  dirtyFileCount: run.checkpoint.dirtyFiles.length,
                },
        })),
      }
    }),
  }
}
