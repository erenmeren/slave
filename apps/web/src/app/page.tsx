import { buildAnalytics } from '../server/analytics'
import { listCompanies, listProjects } from '../server/org'
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
  const [projects, companies, analytics] = await Promise.all([
    listProjects({ includeArchived: archived === '1' }),
    listCompanies(),
    // The all-workspaces view (M44 R1): the SAME builder /analytics calls, with a null scope. The
    // template catalog, the company manager and the catalog-import log that used to load here have
    // moved to Workforce -> Catalog, so `listTemplates`/`listRoster`/`listCatalogImports` went
    // with them.
    buildAnalytics(null),
  ])
  // Only the tiles cross into the client bundle -- `buildAnalytics` also returns `series` and
  // `perSlave`, which `/analytics` renders and this page does not.
  return <ProjectsClient projects={projects} companies={companies} kpis={analytics.kpis} />
}
