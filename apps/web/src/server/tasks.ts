import { prisma } from '@ai-team-os/db/client'
import { NON_TERMINAL_RUN_STATUSES, type RunStatus, type TaskStatus } from '@ai-team-os/domain'

export interface TaskRunSummary {
  readonly id: string
  readonly status: RunStatus
  readonly costUsd: number
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
          // costUsd is nullable (M12 Task 6): a run whose cost is not yet known displays as $0.00
          // here rather than widening this DTO/the panel to a tri-state, matching the same `?? 0`
          // convention graph.ts/overview.ts already use for this exact column.
          costUsd: run.costUsd ?? 0,
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
