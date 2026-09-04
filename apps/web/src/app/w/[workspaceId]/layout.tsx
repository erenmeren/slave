import type React from 'react'
import { buildShellFacts } from '../../../server/shell'
import { listWorkspaceNames } from '../../../server/org'
import { ProjectHeader } from '../../../components/project/ProjectHeader'
import { ProjectTabs } from '../../../components/project/ProjectTabs'

export const dynamic = 'force-dynamic'

/**
 * One header and one tab strip for every `/w/:id/...` page (M24 §2.2). The facts rendered here
 * are the server's snapshot at navigation time; the page's own stream publishes newer ones to the
 * same header through `hooks/useShellFacts.ts`, so the header never opens a connection of its own.
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
