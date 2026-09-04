import { buildProjectSettings } from '../../../../server/projectSettings'
import { ProjectSettingsClient } from '../../../../components/project/ProjectSettingsClient'

export const dynamic = 'force-dynamic'

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const settings = await buildProjectSettings(workspaceId)
  if (settings === null) {
    return <main className="p-6 text-tone-blocked">no workspace with id {workspaceId}</main>
  }
  // Keyed so a client-side workspace-to-workspace navigation remounts the client instead of
  // rendering the old workspace's state under the new URL.
  return <ProjectSettingsClient key={workspaceId} settings={settings} />
}
