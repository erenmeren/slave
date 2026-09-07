import { Chip } from '../ui/Chip'
import type { SimulationSummary } from '@slave-of-ai/control'

/** `250` → `250 ms`; `1000`/`5000` → `1 s`/`5 s` -- the same three values `AutoRunControls`'
 *  `sim-auto-run-every` offers. */
function formatEveryMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`
}

/** The one line every simulation screen carries (spec §7): what this is, and what it is not. */
export function SimulationStrip({
  summary,
  connection,
}: {
  readonly summary: SimulationSummary
  readonly connection?: 'connected' | 'reconnecting'
}): React.JSX.Element {
  return (
    <div data-testid="sim-strip" className="flex flex-wrap items-center gap-2 border-b border-line bg-bg-1 px-6 py-2 text-xs text-text-2">
      <Chip tone="waiting">SIMULATION</Chip>
      <span>{summary.companyName}</span><span>·</span><span>{summary.sector}</span><span>·</span><span>policy {summary.policy}</span><span>·</span>
      <span>{summary.decisionProvider} provider{summary.decisionProvider === 'llm' ? ` · ${String(summary.modelProvider)} · ${String(summary.model)}` : ''}</span><span>·</span>
      {summary.autoRun !== null && (
        <>
          <Chip tone="working"><span data-testid="sim-auto-run-chip">auto-run every {formatEveryMs(summary.autoRun.everyMs)} → day {summary.autoRun.untilDay}</span></Chip>
          <span>·</span>
        </>
      )}
      {connection !== undefined && (
        <>
          <span data-testid="sim-live" className={connection === 'connected' ? 'text-[#4ade80]' : 'text-[#f5b34a]'}>{connection === 'connected' ? '● LIVE' : '● RECONNECTING'}</span>
          <span>·</span>
        </>
      )}
      <span className="text-text-3">synthetic data — not a real company; no real order, payment or tool is touched</span>
    </div>
  )
}
