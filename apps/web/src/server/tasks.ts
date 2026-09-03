import { prisma } from '@ai-team-os/db/client'
import { NON_TERMINAL_RUN_STATUSES, TERMINAL, type RunStatus, type TaskStatus } from '@ai-team-os/domain'
import { artifactLabel } from '../lib/artifactLabel'
import { buildShellFacts, type ShellFacts } from './shell'

export interface TaskRunSummary {
  readonly id: string
  readonly status: RunStatus
  /** USD, or `null` when this run's runtime reported no spend (M12 Task 9 -- spec Decision 6). */
  readonly costUsd: number | null
  readonly toolCalls: number
  readonly startedAt: string
  readonly endedAt: string | null
  /** M23 B4: null once collected. */
  readonly worktreePath: string | null
  readonly checkpoint: {
    readonly pausedAtStep: number | null
    readonly sessionId: string
    readonly dirtyFileCount: number
    /**
     * The pause gate's `Checkpoint.deniedToolUseIds` (M15), one entry per denied tool use.
     * `summary` is always `null` today -- a MEASURED limit, not a TODO: `run.tool_call` event
     * payloads carry only `{ name, summary }` (`packages/domain/src/events/schema.ts`,
     * `apps/orchestrator/src/pump.ts`'s `tool_call` case) with no `tool_use_id`, so there is no
     * field to join a denied id back to the event that named it. Inventing a join (e.g. matching
     * by ordinal position or nearest `seq`) would assert a correspondence the data does not
     * support, so this stays an honest `null` and `TaskDetailPanel` falls back to the truncated
     * id. A future task that adds `toolUseId` to the event payload can populate this for real.
     */
    readonly deniedDuringPause: readonly { readonly id: string; readonly summary: string | null }[]
  } | null
}

export interface TaskArtifactSummary {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly createdAt: string
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
  /**
   * M23 B4 (controller ruling): computed server-side so the panel never imports `TERMINAL` from
   * `@ai-team-os/domain` itself -- a terminal task with at least one run that still has a
   * worktree on disk to remove.
   */
  readonly collectable: boolean
  /** M23 C1: the verify logs `apps/orchestrator/src/verify.ts` wrote for this task, newest first. */
  readonly artifacts: readonly TaskArtifactSummary[]
}

export interface TasksSnapshot {
  readonly workspace: { readonly id: string; readonly name: string; readonly haltedReason: string | null }
  readonly tasks: readonly TaskBoardItem[]
  /**
   * The same counts/guardrails the global shell's `<Sidebar>` shows (M14 Task 8/10 controller
   * ruling): this route already streams the workspace `/w/:id/tasks` mounts, so `TasksClient`
   * publishes this to `hooks/useShellFacts.ts` on every snapshot rather than the sidebar opening
   * a second `EventSource` against `/api/w/:id/shell` for the same workspace.
   */
  readonly shellFacts: ShellFacts
}

export async function buildTasksSnapshot(workspaceId: string): Promise<TasksSnapshot | null> {
  const [workspace, tasks, shellFacts] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId } }),
    prisma.task.findMany({
      where: { workspaceId },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      include: {
        runs: { orderBy: { startedAt: 'desc' }, include: { checkpoint: true, agent: true } },
        artifacts: { orderBy: { createdAt: 'desc' } },
      },
    }),
    buildShellFacts(workspaceId),
  ])
  if (workspace === null || shellFacts === null) return null

  return {
    workspace: { id: workspace.id, name: workspace.name, haltedReason: workspace.haltedReason },
    shellFacts,
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
        // M23 B4 (controller ruling): a terminal task with a worktree still standing on at least
        // one of its runs. Computed here, not in the panel -- the panel never imports `TERMINAL`
        // from `@ai-team-os/domain`.
        collectable: TERMINAL.includes(task.status) && task.runs.some((run) => run.worktreePath !== null),
        artifacts: task.artifacts.map((artifact) => ({
          id: artifact.id,
          kind: artifact.kind,
          label: artifactLabel(artifact.path),
          createdAt: artifact.createdAt.toISOString(),
        })),
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
          // M23 B4: null once collected.
          worktreePath: run.worktreePath,
          checkpoint:
            run.checkpoint === null
              ? null
              : {
                  pausedAtStep: run.pausedAtStep,
                  sessionId: run.checkpoint.sessionId,
                  dirtyFileCount: run.checkpoint.dirtyFiles.length,
                  // No extra query here (see the DTO field's own comment): `checkpoint: true`
                  // above already selects every `Checkpoint` column, so `deniedToolUseIds` needs
                  // no widening, and there is no `run.tool_call` field to join those ids against.
                  deniedDuringPause: run.checkpoint.deniedToolUseIds.map((id) => ({ id, summary: null })),
                },
        })),
      }
    }),
  }
}
