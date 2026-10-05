import { prisma } from '@slave-of-ai/db/client'
import { phaseNeedsPerson, projectPhaseOf, type LeadState, type ProjectPhase, type StopReason, type WorkspaceFlow } from '@slave-of-ai/domain'
import { goalSpend } from './lead/spend.js'
import { workspaceSpend } from './spend.js'

/** One project as the sidebar and Home show it (lead UX design sections 6 and 6.1). */
export interface ProjectListItem {
  readonly id: string
  readonly name: string
  readonly flow: WorkspaceFlow
  readonly phase: ProjectPhase
  readonly archived: boolean
  /** The repository the project points at: a delete says it is left on disk. */
  readonly repoPath: string
  readonly baseBranch: string
  readonly haltedReason: string | null
  /** The newest build's number, 0 before the first. */
  readonly goalVersion: number
  /**
   * How many things wait for a person: 1 for a lead build that needs a decision or a merge; for an
   * older project, its pending decisions and blocked tasks.
   */
  readonly waiting: number
  /** Why the newest build stopped, when it did. */
  readonly stopReason: StopReason | null
  /** When the wait began (the newest build's last state change, else its creation). */
  readonly waitingSince: string | null
  readonly spentUsd: number
  readonly spendUnmeasured: boolean
  readonly budgetUsd: number | null
  /** The newest event of the project, else its creation. */
  readonly updatedAt: string
}

/**
 * Lead UX design section 10: the one read model of the sidebar and Home -- every project, archived
 * ones last and marked, each with its phase, what waits for a person and what it spent. In the lead
 * flow the spend is the newest build's (what its budget caps); in the packages flow it is the
 * project's (what its budget caps there). A read: nothing here writes.
 */
export async function listProjects(): Promise<readonly ProjectListItem[]> {
  const workspaces = await prisma.workspace.findMany({
    orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    select: { id: true, name: true, flow: true, archivedAt: true, repoPath: true, baseBranch: true, haltedReason: true, goalVersion: true, budgetUsd: true, createdAt: true },
  })
  return Promise.all(
    workspaces.map(async (workspace): Promise<ProjectListItem> => {
      const [newest, latestEvent] = await Promise.all([
        prisma.goalDelivery.findFirst({
          where: { workspaceId: workspace.id },
          orderBy: { goalVersion: 'desc' },
          select: { goalVersion: true, leadState: true, status: true, stopReason: true, createdAt: true },
        }),
        prisma.executionEvent.findFirst({ where: { workspaceId: workspace.id }, orderBy: { seq: 'desc' }, select: { ts: true } }),
      ])
      const phase = projectPhaseOf({
        flow: workspace.flow,
        haltedReason: workspace.haltedReason,
        goalVersion: workspace.goalVersion,
        delivery: newest === null ? null : { goalVersion: newest.goalVersion, leadState: newest.leadState as LeadState | null, status: newest.status },
      })

      let waiting = phaseNeedsPerson(phase) ? 1 : 0
      let spentUsd = 0
      let spendUnmeasured = false
      if (workspace.flow === 'lead') {
        if (newest !== null) {
          const spend = await goalSpend(workspace.id, newest.goalVersion)
          spentUsd = spend.totalUsd
          spendUnmeasured = spend.unmeasuredRuns > 0
        }
      } else {
        const [decisions, blocked, spend] = await Promise.all([
          prisma.supervisorDecision.count({ where: { workspaceId: workspace.id, status: 'pending' } }),
          prisma.task.count({ where: { workspaceId: workspace.id, status: 'blocked' } }),
          workspaceSpend(workspace.id),
        ])
        waiting = decisions + blocked
        spentUsd = spend.spentUsd
      }

      // The wait began at the newest build's last state change, which `workspace.lead_state` records.
      const since =
        waiting === 0 || newest === null
          ? null
          : ((
              await prisma.executionEvent.findFirst({
                where: { workspaceId: workspace.id, type: 'workspace_lead_state', payload: { path: ['version'], equals: newest.goalVersion } },
                orderBy: { seq: 'desc' },
                select: { ts: true },
              })
            )?.ts ?? newest.createdAt)

      return {
        id: workspace.id,
        name: workspace.name,
        flow: workspace.flow,
        phase,
        archived: workspace.archivedAt !== null,
        repoPath: workspace.repoPath,
        baseBranch: workspace.baseBranch,
        haltedReason: workspace.haltedReason,
        goalVersion: workspace.goalVersion,
        waiting,
        stopReason: (newest?.stopReason ?? null) as StopReason | null,
        waitingSince: since?.toISOString() ?? null,
        spentUsd,
        spendUnmeasured,
        budgetUsd: workspace.budgetUsd,
        updatedAt: (latestEvent?.ts ?? workspace.createdAt).toISOString(),
      }
    }),
  )
}
