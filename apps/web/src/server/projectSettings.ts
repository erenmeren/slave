import { prisma } from '@ai-team-os/db/client'
import { capabilitiesOf, workspaceDefaultProvider, type ProviderKind } from '@ai-team-os/control'
import { buildPermissionMatrix, type PermissionSection } from './settings'

export interface ProjectSettings {
  readonly workspace: {
    readonly id: string
    readonly name: string
    readonly goal: string | null
    readonly provider: ProviderKind | null
    readonly budgetUsd: number | null
    /** `overview.ts`'s rule, verbatim: a budgeted workspace whose provider reports no cost. */
    readonly costBlindBudgeted: boolean
    readonly maxConcurrentRuns: number
    readonly runTimeoutMs: number
    readonly maxAttempts: number
    readonly haltedReason: string | null
  }
  readonly permissions: PermissionSection | null
}

/** The project Settings tab's snapshot (M24 §4). A plain row read plus the one permission
 *  section; nothing streams here — every form calls `router.refresh()` after a write. */
export async function buildProjectSettings(workspaceId: string): Promise<ProjectSettings | null> {
  const [workspace, sections] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId } }),
    buildPermissionMatrix(workspaceId),
  ])
  if (workspace === null) return null
  // The same single-query mapping `overview.ts` uses for its provider column (`workspaceDefaultProvider`
  // issues its own query rather than reading `workspace.defaultProvider` -- there is no such column;
  // the default lives in a `ProviderConfiguration` row, and one row is a default, none or more than
  // one is `null`).
  const provider = await workspaceDefaultProvider(workspaceId)
  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      goal: workspace.goal,
      provider,
      budgetUsd: workspace.budgetUsd,
      costBlindBudgeted: provider !== null && workspace.budgetUsd !== null && !capabilitiesOf(provider).reportsCost,
      maxConcurrentRuns: workspace.maxConcurrentRuns,
      runTimeoutMs: workspace.runTimeoutMs,
      maxAttempts: workspace.maxAttempts,
      haltedReason: workspace.haltedReason,
    },
    permissions: sections[0] ?? null,
  }
}
