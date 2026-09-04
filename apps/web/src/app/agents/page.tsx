import { listAllAgents, listProjectTeams } from '../../server/org'
import { AgentsClient } from '../../components/AgentsClient'

export const dynamic = 'force-dynamic'

/** M24's Agents page (Task 7 -- one shell, one table): every agent, project-materialized or
 *  still catalog-only, in one table (`listAllAgents`), and the M23 D3 Teams tab beside it,
 *  tabbed in `AgentsClient`. `listAllAgents()` returns the page object now (M25 Task 6): the
 *  row array plus the department select's two option lists, so `AgentsClient`/`AllAgentsTable`
 *  need no query of their own to render it. */
export default async function AgentsPage(): Promise<React.JSX.Element> {
  const [agents, teams] = await Promise.all([listAllAgents(), listProjectTeams()])
  return <AgentsClient agents={agents} teams={teams} />
}
