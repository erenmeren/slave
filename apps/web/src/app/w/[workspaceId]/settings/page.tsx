import { buildProjectSettings } from '../../../../server/projectSettings'
import { buildShellFacts } from '../../../../server/shell'
import { buildRunbookPanel } from '../../../../server/runbook'
import { ProjectSettingsClient } from '../../../../components/project/ProjectSettingsClient'

export const dynamic = 'force-dynamic'

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  // `buildRunbookPanel` alongside the other two (M61 R7/Task 6): the Overview's Runbook section
  // moved here, and `server/overview.ts:23` is the existing caller this reuses rather than a
  // second builder -- `RunbookPanelView` is unchanged, and so are `RunbookPanel`'s own testids.
  const [settings, shellFacts, runbook] = await Promise.all([
    buildProjectSettings(workspaceId),
    buildShellFacts(workspaceId),
    buildRunbookPanel(workspaceId),
  ])
  if (settings === null || shellFacts === null) {
    return <div className="p-6 text-tone-blocked">no project with id {workspaceId}</div>
  }
  // Keyed so a client-side workspace-to-workspace navigation remounts the client instead of
  // rendering the old workspace's state under the new URL.
  return <ProjectSettingsClient key={workspaceId} settings={settings} shellFacts={shellFacts} runbook={runbook} />
}
