import { Chip } from '../ui/Chip'
import type { SimulationSummary } from '@slave-of-ai/control'

/** The one line every simulation screen carries (spec §7): what this is, and what it is not. */
export function SimulationStrip({ summary }: { readonly summary: SimulationSummary }): React.JSX.Element {
  return (
    <div data-testid="sim-strip" className="flex flex-wrap items-center gap-2 border-b border-line bg-bg-1 px-6 py-2 text-xs text-text-2">
      <Chip tone="waiting">SIMULATION</Chip>
      <span>{summary.companyName}</span><span>·</span><span>{summary.sector}</span><span>·</span><span>policy {summary.policy}</span><span>·</span>
      <span>{summary.decisionProvider} provider</span><span>·</span>
      <span className="text-text-3">synthetic data — not a real company; no real order, payment or tool is touched</span>
    </div>
  )
}
