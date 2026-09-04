import { listAllAgents, listProjectTeams, listWorkspaceNames } from '../../server/org'
import { AgentsClient } from '../../components/AgentsClient'

export const dynamic = 'force-dynamic'

/** M24's Agents page (Task 7 -- one shell, one table): every agent, project-materialized or
 *  still catalog-only, in one table (`listAllAgents`), and the M23 D3 Departments tab beside it
 *  (M25 Task 7: Teams renamed), tabbed in `AgentsClient`. `listAllAgents()` returns the page
 *  object now (M25 Task 6): the row array plus the department select's two option lists, so
 *  `AgentsClient`/`AllAgentsTable` need no query of their own to render it. `listWorkspaceNames()`
 *  feeds the Departments tab's "New department" project `<select>`. */
export default async function AgentsPage(): Promise<React.JSX.Element> {
  const [agents, teams, workspaces] = await Promise.all([listAllAgents(), listProjectTeams(), listWorkspaceNames()])
  return <AgentsClient agents={agents} teams={teams} workspaces={workspaces} />
}
