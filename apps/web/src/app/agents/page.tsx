import { listAllAgents, listCompanies, listProjectTeams, listRoster, listTemplates, listWorkspaceNames } from '../../server/org'
import { AgentsClient } from '../../components/AgentsClient'

export const dynamic = 'force-dynamic'

/** M24's Agents page (Task 7 -- one shell, one table): every agent, project-materialized or
 *  still catalog-only, in one table (`listAllAgents`), and the M23 D3 Departments tab beside it
 *  (M25 Task 7: Teams renamed), tabbed in `AgentsClient`. `listAllAgents()` returns the page
 *  object now (M25 Task 6): the row array plus the department select's two option lists, so
 *  `AgentsClient`/`AllAgentsTable` need no query of their own to render it. `listWorkspaceNames()`
 *  feeds the Departments tab's "New department" project `<select>` and the New agent drawer's
 *  "assign to project" step. `listCompanies()`/`listRoster()`/`listTemplates()` (M25 Task 8) feed
 *  that drawer's own form -- the same catalog data `CompanyManager`/`TemplateCatalog` already
 *  load on the Settings page, loaded again here so `+ New agent` opens the form without a
 *  round trip. */
export default async function AgentsPage(): Promise<React.JSX.Element> {
  // `listAllAgents()` already calls `listRoster()` internally to build its rows, but its return
  // shape has none of `RosterCompany`'s own structure -- the New agent drawer needs that shape
  // directly (company -> department -> members), so this page runs `listRoster()` again rather
  // than reshaping `listAllAgents()`'s output. One extra query per Agents page load; accepted
  // (M25 final review, folded minor -- named rather than silently duplicated).
  const [agents, teams, workspaces, companies, roster, templates] = await Promise.all([
    listAllAgents(),
    listProjectTeams(),
    listWorkspaceNames(),
    listCompanies(),
    listRoster(),
    listTemplates(),
  ])
  return <AgentsClient agents={agents} teams={teams} workspaces={workspaces} companies={companies} roster={roster} templates={templates} />
}
