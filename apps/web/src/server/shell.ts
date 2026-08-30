import { toRunState } from '@ai-team-os/db'
import { prisma } from '@ai-team-os/db/client'
import { deriveAgentStatus, NON_TERMINAL_RUN_STATUSES } from '@ai-team-os/domain'

/**
 * The shell's own tiny snapshot (M14 §3): the two live counts the sidebar's nav rows carry, and
 * the workspace's guardrail columns for the bottom block.
 *
 * Its own module and its own route rather than a slice of `OverviewSnapshot`, because the sidebar
 * is mounted by the ROOT LAYOUT on every page — including `/w/:id/tasks`, `/graph` and
 * `/activity`, none of which builds an overview snapshot. Reading the overview's much larger
 * snapshot from four routes to display two integers is the cost this avoids.
 */
export interface ShellFacts {
  readonly workspace: { readonly id: string; readonly name: string }
  readonly counts: {
    /** Agents whose derived status is `working` — the handoff's "agents working" badge. */
    readonly agentsWorking: number
    /** Tasks in the six statuses `overview.ts` counts as active work. */
    readonly tasksActive: number
  }
  readonly guardrails: {
    /** `null` for an unbudgeted workspace (M12 Task 9) — rendered `—`, never `$0.00`. */
    readonly budgetUsd: number | null
    readonly maxConcurrentRuns: number
    readonly runTimeoutMs: number
    readonly maxAttempts: number
  }
}

// Mirrors `overview.ts`'s own list (the M8a widening: a task under review or in the merge queue
// is still active work). Not imported — `overview.ts` does not export it, and this module's whole
// point is not to depend on that one.
const ACTIVE_TASK_STATUSES = ['ready', 'running', 'verifying', 'reviewing', 'merging', 'rework'] as const

export async function buildShellFacts(workspaceId: string): Promise<ShellFacts | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  const [runs, tasksActive] = await Promise.all([
    // No `select`: `toRunState` maps a whole `AgentRun` row, and narrowing the query to the four
    // columns it happens to read today would hand it an object the mapper's own type rejects —
    // and would have to be revisited every time the domain's `RunState` grows a field. The row
    // set is bounded by `maxConcurrentRuns`-ish live runs, not by history.
    prisma.agentRun.findMany({
      where: { agent: { team: { workspaceId } }, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
    }),
    prisma.task.count({ where: { workspaceId, status: { in: [...ACTIVE_TASK_STATUSES] } } }),
  ])

  // `deriveAgentStatus` rather than a `status === 'working'` filter on the row: the domain owns
  // that mapping, and this badge must agree with the pill on every card that shows the same agent.
  const agentsWorking = runs.filter((run) => deriveAgentStatus(toRunState(run)) === 'working').length

  return {
    workspace: { id: workspace.id, name: workspace.name },
    counts: { agentsWorking, tasksActive },
    guardrails: {
      budgetUsd: workspace.budgetUsd,
      maxConcurrentRuns: workspace.maxConcurrentRuns,
      runTimeoutMs: workspace.runTimeoutMs,
      maxAttempts: workspace.maxAttempts,
    },
  }
}
