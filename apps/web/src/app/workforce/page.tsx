import {
  listAllSlaves,
  listCapabilityTaxonomy,
  listCatalogImports,
  listCompanies,
  listProjectTeams,
  listRoster,
  listRunbookRows,
  listTemplates,
  listWorkforceCatalogPage,
  listWorkspaceNames,
} from '../../server/org'
import { buildSkillsPage } from '../../server/skills'
import { parseCatalogFilters } from '../../lib/catalogFilters'
import { WorkforceClient, type WorkforceTab } from '../../components/workforce/WorkforceClient'

export const dynamic = 'force-dynamic'

const TAB_IDS: readonly WorkforceTab[] = ['slaves', 'departments', 'catalog', 'skills', 'runbooks']

/** Next hands a repeated param (`?capability=a&capability=b`) as an array; the catalog's filters
 *  are one value each, so the first wins -- the same thing `URLSearchParams.get` does for the
 *  client hook reading the same URL. */
function queryOf(params: Record<string, string | readonly string[] | undefined>): URLSearchParams {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    const first = typeof value === 'string' ? value : value?.[0]
    if (first !== undefined) query.set(key, first)
  }
  return query
}

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
 * The catalog read takes the URL's filters (M46 final wave, M1), parsed by the same
 * `parseCatalogFilters` the client hook uses, so `WorkforceCatalog` is seeded with the rows its
 * filter bar already claims to be showing. Unfiltered, that was always true; a shared
 * `?q=`/`?capability=` link painted the WHOLE catalog until the client's first refetch replaced
 * it. The exception is `templates`, which the pickers on two other tabs staff a company FROM and
 * which must stay the whole catalog: a FILTERED url is the one case that pays for a second read.
 *
 * `listRoster()` runs even though `listAllSlaves()` calls it internally: that function's return
 * shape has none of `RosterCompany`'s own structure (company -> department -> members), which the
 * New slave drawer and the company manager both need directly. One extra query per page load,
 * carried over from the Slaves page rather than silently introduced here.
 */
export default async function WorkforcePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>
}): Promise<React.JSX.Element> {
  const params = await searchParams
  const tab = typeof params.tab === 'string' ? params.tab : undefined
  const filters = parseCatalogFilters(queryOf(params))
  const filtered = Object.keys(filters).length > 0
  const [slaves, teams, workspaces, companies, roster, catalog, allTemplates, catalogImports, skills, taxonomy, runbooks] =
    await Promise.all([
      listAllSlaves(),
      listProjectTeams(),
      listWorkspaceNames(),
      listCompanies(),
      listRoster(),
      listWorkforceCatalogPage(filters),
      filtered ? listTemplates() : Promise.resolve(null),
      listCatalogImports(),
      buildSkillsPage(),
      // M47 §2: one read, beside the catalog it labels -- the drawer resolves a row's capability
      // keys against it rather than opening a request of its own per profile.
      listCapabilityTaxonomy(),
      // M48 R7: the fifth tab's rows, read here with the other nine rather than fetched by the
      // component -- a runbook changes when an operator adds a file or an import runs, which is
      // not something this page has to watch for.
      listRunbookRows(),
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
      templates={allTemplates ?? catalog.rows}
      catalog={catalog}
      catalogImports={catalogImports}
      skills={skills}
      taxonomy={taxonomy}
      runbooks={runbooks}
    />
  )
}
