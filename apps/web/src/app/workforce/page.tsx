import {
  listAllSlaves,
  listCatalogImports,
  listCompanies,
  listProjectTeams,
  listRoster,
  listWorkforceCatalogPage,
  listWorkspaceNames,
} from '../../server/org'
import { buildSkillsPage } from '../../server/skills'
import { WorkforceClient, type WorkforceTab } from '../../components/workforce/WorkforceClient'

export const dynamic = 'force-dynamic'

const TAB_IDS: readonly WorkforceTab[] = ['slaves', 'departments', 'catalog', 'skills']

/**
 * The people (M44 R1): every slave, the departments they sit on, the catalog they are made from,
 * and the skills they are given -- four tabs on one page instead of two sidebar rows and a section
 * on the Projects home. `/slaves` and `/skills` are 307s into it (`next.config.ts`).
 *
 * The tab is in the URL (`?tab=`), the way the Graph page keeps its mode, so `/skills` can redirect
 * to a tab and a reload or a shared link keeps it. An unknown value falls back to `slaves` rather
 * than rendering an empty page.
 *
 * ONE catalog read, not two (M46 plan erratum E9): `listWorkforceCatalogPage()` answers both the
 * Workforce Catalog's own rows and the `templates` the company manager and the New slave drawer
 * take -- `listTemplates()` IS that call's `.rows`, so asking for both would have been the same
 * `findMany` and the same `groupBy` run twice for one page.
 *
 * `listRoster()` runs even though `listAllSlaves()` calls it internally: that function's return
 * shape has none of `RosterCompany`'s own structure (company -> department -> members), which the
 * New slave drawer and the company manager both need directly. One extra query per page load,
 * carried over from the Slaves page rather than silently introduced here.
 */
export default async function WorkforcePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly tab?: string }>
}): Promise<React.JSX.Element> {
  const { tab } = await searchParams
  const [slaves, teams, workspaces, companies, roster, catalog, catalogImports, skills] = await Promise.all([
    listAllSlaves(),
    listProjectTeams(),
    listWorkspaceNames(),
    listCompanies(),
    listRoster(),
    listWorkforceCatalogPage(),
    listCatalogImports(),
    buildSkillsPage(),
  ])
  const initialTab = TAB_IDS.find((id) => id === tab) ?? 'slaves'
  return (
    <WorkforceClient
      initialTab={initialTab}
      slaves={slaves}
      teams={teams}
      workspaces={workspaces}
      companies={companies}
      roster={roster}
      templates={catalog.rows}
      catalog={catalog}
      catalogImports={catalogImports}
      skills={skills}
    />
  )
}
