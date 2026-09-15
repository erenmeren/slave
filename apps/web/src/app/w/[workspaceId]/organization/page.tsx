import { buildOrganization } from '../../../../server/organization'
import { listProjectTeams, listRoster, listTemplates } from '../../../../server/org'
import { listSkillCatalogue } from '../../../../server/persons'
import { OrganizationClient } from '../../../../components/organization/OrganizationClient'

export const dynamic = 'force-dynamic'

/**
 * The Organization tab (M47 R6, `docs/ia.md` tab 3): who works on this project, why they were
 * chosen, what they provide, and what the board still needs.
 */
export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const [view, roster, templates, teams, skillCatalogue] = await Promise.all([
    buildOrganization(workspaceId),
    listRoster(),
    listTemplates(),
    listProjectTeams(),
    listSkillCatalogue(),
  ])
  if (view === null) {
    return <div className="p-6 text-tone-blocked">no project with id {workspaceId}</div>
  }
  // Keyed, like every other project tab: a client-side move between projects remounts rather than
  // rendering the old project's rows under the new URL.
  return (
    <OrganizationClient
      key={workspaceId}
      workspaceId={workspaceId}
      initial={view}
      roster={roster}
      templates={templates}
      teams={teams}
      skillCatalogue={skillCatalogue}
    />
  )
}
