import { prisma } from '@slave-of-ai/db/client'
import { capabilitiesOf, projectFootprint, workspaceDefaultProvider, type Footprint, type ProviderKind } from '@slave-of-ai/control'
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
    /** M27 §3.3: `Workspace.archivedAt !== null`. `ProjectSettingsClient`'s danger zone shows
     *  Restore instead of Archive when this is true. */
    readonly archived: boolean
  }
  readonly permissions: PermissionSection | null
  /** What this project holds (M27 §3.4, §7) -- the archive confirm's counts: "archives Checkout
   *  Platform: 3 departments, 9 slaves, 12 tasks, 41 runs stay on record". Read even for an
   *  already-archived project, so the danger zone can show it there too. */
  readonly footprint: Footprint
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
  const [provider, footprint] = await Promise.all([
    workspaceDefaultProvider(workspaceId),
    projectFootprint(prisma, workspaceId),
  ])
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
      archived: workspace.archivedAt !== null,
    },
    permissions: sections[0] ?? null,
    footprint,
  }
}
