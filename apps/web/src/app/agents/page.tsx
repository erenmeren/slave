import { listProjectTeams, listRoster, listWorkers } from '../../server/org'
import { AgentsClient } from '../../components/AgentsClient'

export const dynamic = 'force-dynamic'

/** The M11 shell's Agents page (Task 8): the org roster (grouped company -> team), the flat,
 *  self-polling worker list, and the M23 D3 Teams tab, tabbed in `AgentsClient`. */
export default async function AgentsPage(): Promise<React.JSX.Element> {
  const [roster, workers, teams] = await Promise.all([listRoster(), listWorkers(), listProjectTeams()])
  return <AgentsClient roster={roster} workers={workers} teams={teams} />
}
