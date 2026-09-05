import { listAllSlaves, listCompanies, listProjectTeams, listRoster, listTemplates, listWorkspaceNames } from '../../server/org'
import { SlavesClient } from '../../components/SlavesClient'

export const dynamic = 'force-dynamic'

/** M24's Slaves page (Task 7 -- one shell, one table): every slave, project-materialized or
 *  still catalog-only, in one table (`listAllSlaves`), and the M23 D3 Departments tab beside it
 *  (M25 Task 7: Teams renamed), tabbed in `SlavesClient`. `listAllSlaves()` returns the page
 *  object now (M25 Task 6): the row array plus the department select's two option lists, so
 *  `SlavesClient`/`AllSlavesTable` need no query of their own to render it. `listWorkspaceNames()`
 *  feeds the Departments tab's "New department" project `<select>` and the New slave drawer's
 *  "assign to project" step. `listCompanies()`/`listRoster()`/`listTemplates()` (M25 Task 8) feed
 *  that drawer's own form -- the same catalog data `CompanyManager`/`TemplateCatalog` already
 *  load on the Settings page, loaded again here so `+ New slave` opens the form without a
 *  round trip. */
export default async function SlavesPage(): Promise<React.JSX.Element> {
  // `listAllSlaves()` already calls `listRoster()` internally to build its rows, but its return
  // shape has none of `RosterCompany`'s own structure -- the New slave drawer needs that shape
  // directly (company -> department -> members), so this page runs `listRoster()` again rather
  // than reshaping `listAllSlaves()`'s output. One extra query per Slaves page load; accepted
  // (M25 final review, folded minor -- named rather than silently duplicated).
  const [slaves, teams, workspaces, companies, roster, templates] = await Promise.all([
    listAllSlaves(),
    listProjectTeams(),
    listWorkspaceNames(),
    listCompanies(),
    listRoster(),
    listTemplates(),
  ])
  return <SlavesClient slaves={slaves} teams={teams} workspaces={workspaces} companies={companies} roster={roster} templates={templates} />
}
