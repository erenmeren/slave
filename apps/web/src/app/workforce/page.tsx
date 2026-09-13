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
import { buildEvidencePage } from '../../server/evidence'
import { buildSkillsPage } from '../../server/skills'
import { parseCatalogFilters } from '../../lib/catalogFilters'
import { WorkforceClient, type WorkforceTab } from '../../components/workforce/WorkforceClient'

export const dynamic = 'force-dynamic'

const TAB_IDS: readonly WorkforceTab[] = ['slaves', 'departments', 'catalog', 'skills', 'runbooks', 'evidence']

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
 * the skills they are given, the runbooks they can be asked to follow (M48 R7) and -- since M53 R12
 * -- what their record says: six tabs on one page instead of two sidebar rows and a section on the
 * Projects home. `/slaves` and `/skills` are 307s into it (`next.config.ts`).
 *
 * The tab is in the URL (`?tab=`), the way the Graph page keeps its mode, so `/skills` can redirect
 * to a tab and a reload or a shared link keeps it. An unknown value falls back to `slaves` rather
 * than rendering an empty page.
 *
 * TWO catalog reads, on every load (M46 plan erratum E9, ended by M55 fix round 1). E9 made
 * `templates` the catalog read's own `.rows` because the two WERE the same unbounded `findMany`.
 * M55 R3 made that read a PAGE of a hundred, and a page is not a catalog: `templates` is what
 * `CompanyManager`, `CompanyDetail`, `company/TeamBlock` and `NewSlaveDrawer` staff a company FROM,
 * so sharing the page would have hidden the hundred-and-first template from every one of those
 * `<select>`s, silently and with no sentence anywhere saying the list was cut -- exactly the harm
 * erratum E2 exists to prevent. `listTemplates()` is therefore its own read, unconditionally, with
 * its own bound (`TEMPLATE_PICKER_MAX`) and no filters at all.
 *
 * The catalog read takes the URL's filters (M46 final wave, M1), parsed by the same
 * `parseCatalogFilters` the client hook uses, so `WorkforceCatalog` is seeded with the rows its
 * filter bar already claims to be showing. Unfiltered, that was always true; a shared
 * `?q=`/`?capability=` link painted the WHOLE catalog until the client's first refetch replaced
 * it. `templates` is deliberately outside all of it: a search box on the Catalog tab must not
 * narrow the pickers two tabs over.
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
  const query = queryOf(params)
  const filters = parseCatalogFilters(query)
  const initialTab = TAB_IDS.find((id) => id === tab) ?? 'slaves'
  const [slaves, teams, workspaces, companies, roster, catalog, templates, catalogImports, skills, taxonomy, runbooks, evidence] =
    await Promise.all([
      listAllSlaves(),
      listProjectTeams(),
      listWorkspaceNames(),
      listCompanies(),
      listRoster(),
      listWorkforceCatalogPage(filters),
      // Never `catalog.rows` (M55 fix round 1): that is a PAGE now, and these are the pickers a
      // company is staffed from.
      listTemplates(),
      listCatalogImports(),
      buildSkillsPage(),
      // M47 §2: one read, beside the catalog it labels -- the drawer resolves a row's capability
      // keys against it rather than opening a request of its own per profile.
      listCapabilityTaxonomy(),
      // M48 R7: the fifth tab's rows, read here with the other nine rather than fetched by the
      // component -- a runbook changes when an operator adds a file or an import runs, which is
      // not something this page has to watch for.
      listRunbookRows(),
      // M53 R12: the sixth tab's two aggregates, seeded with the domain the URL already claims to
      // be filtering by -- the `parseCatalogFilters` precedent one line up. Both are `GROUP BY`s,
      // so the filter has to be applied where the grouping happens and cannot be a client concern.
      //
      // ONLY FOR THE TAB THAT SHOWS THEM (final wave). Unfiltered, neither aggregate is served by
      // any of `EvidenceRecord`'s four indexes -- `(profileKey, model, repositoryKey)` cannot
      // answer `GROUP BY profileKey, repositoryKey`, the GIN index answers only `domains &&`, and
      // there is no `workspaceId` here -- so this is a sequential scan and a hash aggregate that
      // grows by one row per run forever. Paying it on every `/workforce` load, five sixths of
      // which are another tab, is the one read in this milestone that gets worse with age. The tab
      // asks for it by URL, and `WorkforceClient` asks the server again when somebody selects the
      // tab from another one.
      initialTab === 'evidence' ? buildEvidencePage({ domain: query.get('domain') }) : Promise.resolve(null),
    ])
  return (
    <WorkforceClient
      initialTab={initialTab}
      slaves={slaves}
      teams={teams}
      workspaces={workspaces}
      companies={companies}
      roster={roster}
      templates={templates}
      catalog={catalog}
      catalogImports={catalogImports}
      skills={skills}
      taxonomy={taxonomy}
      runbooks={runbooks}
      evidence={evidence}
    />
  )
}
