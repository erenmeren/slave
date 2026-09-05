import { listCompanies, listProjects, listRoster, listTemplates } from '../server/org'
import { ProjectsClient } from '../components/ProjectsClient'

export const dynamic = 'force-dynamic'

/** The M11 shell's root, grown by M24 §5.2: the Projects page carries its own "New project"
 *  drawer (the attach-a-repo form, moved off Settings) and the team catalog (the template
 *  catalog and the company manager, also moved off Settings) below the project cards --
 *  `/w/[workspaceId]` and its siblings are still reached from a project card or the sidebar.
 *
 *  M27 §3.4: `?archived=1` is `ProjectsClient`'s `show archived` toggle, round-tripped through
 *  the URL rather than component state so a reload or a shared link keeps the toggle's choice --
 *  the same idiom `analytics/page.tsx` and `login/page.tsx` use for their own `searchParams`. */
export default async function Home({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly archived?: string }>
}): Promise<React.JSX.Element> {
  const { archived } = await searchParams
  const [projects, companies, templates, roster] = await Promise.all([
    listProjects({ includeArchived: archived === '1' }),
    listCompanies(),
    listTemplates(),
    listRoster(),
  ])
  return <ProjectsClient projects={projects} companies={companies} templates={templates} roster={roster} />
}
