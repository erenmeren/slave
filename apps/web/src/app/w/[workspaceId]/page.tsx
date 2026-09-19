import { buildTeamLive } from '../../../server/teamLive'
import { listProjectTeams } from '../../../server/org'
import { listSkillCatalogue } from '../../../server/persons'
import { TeamLive } from '../../../components/project/TeamLive'
import { assignableProjectsOf } from '../../../components/persons/assignableProjects'

export const dynamic = 'force-dynamic'

/** The project's own page now (M61 R7/Task 6): the Team tab, live. Replaces the Overview --
 *  `buildOverviewSnapshot` is still read (`buildTeamLive` composes it), but this page's own read
 *  model is `buildTeamLive`'s, and the client it renders is `TeamLive`. */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const [snapshot, skillCatalogue, teams] = await Promise.all([
    buildTeamLive(workspaceId),
    listSkillCatalogue(),
    listProjectTeams(),
  ])
  if (snapshot === null) {
    return <div className="p-6 text-tone-blocked">no project with id {workspaceId}</div>
  }
  // Keyed so a client-side workspace-to-workspace navigation remounts the client instead of
  // rendering the old workspace's state under the new URL.
  return (
    <TeamLive
      key={workspaceId}
      workspaceId={workspaceId}
      initial={snapshot}
      skillCatalogue={skillCatalogue}
      projects={assignableProjectsOf(teams)}
    />
  )
}
