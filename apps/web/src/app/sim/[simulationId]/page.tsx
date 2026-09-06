import { notFound } from 'next/navigation'
import { buildSimulationSnapshot } from '../../../server/simulation'
import { SimulationClient } from '../../../components/sim/SimulationClient'

export const dynamic = 'force-dynamic'

export default async function SimulationPageRoute({ params }: { params: Promise<{ simulationId: string }> }): Promise<React.JSX.Element> {
  const { simulationId } = await params
  const snapshot = await buildSimulationSnapshot(simulationId)
  if (snapshot === null) notFound()
  return <SimulationClient key={`${simulationId}:${snapshot.summary.version}`} initial={snapshot} />
}
