import { buildSimulationSnapshot } from '../../../server/simulation'
import { SimulationClient } from '../../../components/sim/SimulationClient'

export const dynamic = 'force-dynamic'

export default async function SimulationPageRoute({ params }: { params: Promise<{ simulationId: string }> }): Promise<React.JSX.Element> {
  const { simulationId } = await params
  const snapshot = await buildSimulationSnapshot(simulationId)
  if (snapshot === null) return <main className="p-6 text-tone-blocked">no simulation with id {simulationId}</main>
  return <SimulationClient key={`${simulationId}:${snapshot.summary.version}`} initial={snapshot} />
}
