import { listCompanies, listProjects, listRoster, listTemplates } from '../server/org'
import { ProjectsClient } from '../components/ProjectsClient'

export const dynamic = 'force-dynamic'

/** The M11 shell's root, grown by M24 §5.2: the Projects page carries its own "New project"
 *  drawer (the attach-a-repo form, moved off Settings) and the team catalog (the template
 *  catalog and the company manager, also moved off Settings) below the project cards --
 *  `/w/[workspaceId]` and its siblings are still reached from a project card or the sidebar. */
export default async function Home(): Promise<React.JSX.Element> {
  const [projects, companies, templates, roster] = await Promise.all([
    listProjects(),
    listCompanies(),
    listTemplates(),
    listRoster(),
  ])
  return <ProjectsClient projects={projects} companies={companies} templates={templates} roster={roster} />
}
