import { sectors, type SectorName } from '@slave-of-ai/simulation'
import { listSimulationCards, listSimulationCompanies } from '../../server/simulation'
import { SimulationsClient } from '../../components/sim/SimulationsClient'

export const dynamic = 'force-dynamic'

const SECTOR_NAMES = Object.keys(sectors) as SectorName[]

/** M29: every simulation run, and the drawer that creates one from a catalog company.
 *  M31b Task 4: the drawer picks a sector first, so the company list is fetched once per
 *  registered sector here (server-side, through `companiesForSector`) and handed down as a map —
 *  the drawer only ever selects which of these already-filtered lists to show. */
export default async function SimulationsPage(): Promise<React.JSX.Element> {
  const [cards, ...companiesPerSector] = await Promise.all([listSimulationCards(), ...SECTOR_NAMES.map((sector) => listSimulationCompanies(sector))])
  const companiesBySector = Object.fromEntries(SECTOR_NAMES.map((sector, i) => [sector, companiesPerSector[i] ?? []])) as Record<SectorName, readonly { id: string; name: string; slaves: number }[]>
  return <SimulationsClient cards={cards} companiesBySector={companiesBySector} />
}
