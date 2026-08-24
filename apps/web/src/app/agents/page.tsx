import { listRoster, listWorkers } from '../../server/org'
import { AgentsClient } from '../../components/AgentsClient'

export const dynamic = 'force-dynamic'

/** The M11 shell's Agents page (Task 8): the org roster (grouped company -> team) and the flat,
 *  self-polling worker list, tabbed in `AgentsClient`. */
export default async function AgentsPage(): Promise<React.JSX.Element> {
  const [roster, workers] = await Promise.all([listRoster(), listWorkers()])
  return <AgentsClient roster={roster} workers={workers} />
}
