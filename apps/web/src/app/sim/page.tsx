import { listSimulationCards, listSimulationCompanies } from '../../server/simulation'
import { SimulationsClient } from '../../components/sim/SimulationsClient'

export const dynamic = 'force-dynamic'

/** M29: every simulation run, and the drawer that creates one from a catalog company. */
export default async function SimulationsPage(): Promise<React.JSX.Element> {
  const [cards, companies] = await Promise.all([listSimulationCards(), listSimulationCompanies()])
  return <SimulationsClient cards={cards} companies={companies} />
}
