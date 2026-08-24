import { listCompanies, listProjects } from '../server/org'
import { ProjectsClient } from '../components/ProjectsClient'

export const dynamic = 'force-dynamic'

/** The M11 shell's new root (spec §4): the Projects page, not the old workspace picker/redirect
 *  -- `/w/[workspaceId]` and its siblings are still reached from a project card or the sidebar. */
export default async function Home(): Promise<React.JSX.Element> {
  const [projects, companies] = await Promise.all([listProjects(), listCompanies()])
  return <ProjectsClient projects={projects} companies={companies} />
}
