'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { SimulationSummary } from '@slave-of-ai/control'
import type { SectorName } from '@slave-of-ai/simulation'
import { Card } from '../ui/Card'
import { Chip } from '../ui/Chip'
import { PrimaryButton } from '../ui/FormControls'
import { Panel } from '../ui/Panel'
import { NewSimulationDrawer, type SimulationCompanyOption } from './NewSimulationDrawer'

const STATUS_TONE = { ready: 'idle', running: 'working', paused: 'paused', finished: 'done', halted: 'blocked' } as const

/** M29: every simulation run as a card (chip, sector, policy, day, status), and the drawer that
 *  creates one from a catalog company. M31b §5: `companiesBySector` carries every registered
 *  sector's own (already roster-filtered) company list; the drawer picks which one to show. */
export function SimulationsClient({
  cards,
  companiesBySector,
}: {
  readonly cards: readonly SimulationSummary[]
  readonly companiesBySector: Readonly<Record<SectorName, readonly SimulationCompanyOption[]>>
}): React.JSX.Element {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-4 p-6">
      <Panel title="Simulations" action={<PrimaryButton data-testid="new-simulation" onClick={() => setOpen(true)}>+ New simulation</PrimaryButton>}>
        {cards.length === 0 ? (
          <p data-testid="sim-empty" className="text-xs text-text-3">No simulations yet. Create the first run from a catalog company whose roster fits the sector.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => (
              <div key={card.id} data-testid="sim-card">
                <div data-testid={`sim-card-${card.id}`}>
                  <Card onClick={() => router.push(`/sim/${card.id}`)}>
                    <div className="flex items-center gap-2">
                      <span data-testid="sim-chip"><Chip tone="waiting">SIMULATION</Chip></span>
                      <span className="text-sm text-text-1">{card.name}</span>
                      <span data-testid="sim-sector-chip"><Chip>{card.sector}</Chip></span>
                    </div>
                    <div className="text-xs text-text-3">{card.companyName} · {card.sector} · policy {card.policy} · {card.decisionProvider} provider</div>
                    {card.clonedFromName !== null && <div className="text-xs text-text-3">clone of {card.clonedFromName}</div>}
                    {card.adoptedBy.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        {card.adoptedBy.map((workspace) => (
                          <Chip key={workspace.workspaceId} tone="done"><span data-testid="sim-adopted-chip">adopted → {workspace.workspaceName}</span></Chip>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-xs text-text-2">
                      <span>day {card.simTime} / {card.horizonDays}</span>
                      <Chip tone={STATUS_TONE[card.status]}>{card.status}</Chip>
                      {card.decisionProvider === 'llm' && <Chip tone="working">llm</Chip>}
                      {card.autoRun !== null && <Chip tone="working">auto-run</Chip>}
                    </div>
                  </Card>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
      <NewSimulationDrawer open={open} onClose={() => setOpen(false)} companiesBySector={companiesBySector} />
    </div>
  )
}
