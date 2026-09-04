import type React from 'react'
import { buildShellFacts } from '../../../server/shell'
import { listWorkspaceNames } from '../../../server/org'
import { ProjectHeader } from '../../../components/project/ProjectHeader'
import { ProjectTabs } from '../../../components/project/ProjectTabs'

export const dynamic = 'force-dynamic'

/**
 * One header and one tab strip for every `/w/:id/...` page (M24 §2.2). The facts rendered here
 * are fetched once, when this layout segment MOUNTS -- not on every navigation under it: Next.js
 * keeps a shared layout mounted across soft navigations between the sibling routes it wraps, so a
 * Tasks→Graph→Activity→Settings hop reuses this same fetch. The page below keeps the header live
 * from there by publishing its own snapshot to `hooks/useShellFacts.ts` (every one of the four
 * page clients, and now the Settings tab too), so the header never opens a connection of its own.
 * An unknown workspace renders the children alone — every page already answers that case.
 */
export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ workspaceId: string }>
  children: React.ReactNode
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const [facts, workspaces] = await Promise.all([buildShellFacts(workspaceId), listWorkspaceNames()])
  if (facts === null) return <>{children}</>
  return (
    <div className="flex min-h-screen flex-1 flex-col">
      <ProjectHeader workspaceId={workspaceId} initial={facts} workspaces={workspaces} />
      <ProjectTabs workspaceId={workspaceId} initialTasksActive={facts.counts.tasksActive} />
      {children}
    </div>
  )
}
