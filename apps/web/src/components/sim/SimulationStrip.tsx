import { Chip } from '../ui/Chip'
import { providerLabel } from '../../lib/providerLabel'
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
      {/* The runtime's WORD, with the raw kind in `title` (M44 R4, final review item I3): this
        * strip printed `claude_code` at a person, and the m44 gate caught it as a fifth surface
        * after `PROVIDER_KINDS` joined its blocklist. `decisionProvider` beside it (`rules`/`llm`)
        * is plain English already and stays as it is. */}
      <span data-testid="sim-model-provider" title={summary.modelProvider ?? undefined}>{summary.decisionProvider} provider{summary.decisionProvider === 'llm' ? ` · ${providerLabel(summary.modelProvider)} · ${String(summary.model)}` : ''}</span><span>·</span>
      {summary.autoRun !== null && (
        <>
          <Chip tone="working"><span data-testid="sim-auto-run-chip">auto-run every {formatEveryMs(summary.autoRun.everyMs)} → day {summary.autoRun.untilDay}</span></Chip>
          <span>·</span>
        </>
      )}
      {summary.adoptedBy.map((workspace) => (
        <span key={workspace.workspaceId} className="contents">
          <Chip tone="done"><span data-testid="sim-adopted-chip">adopted → {workspace.workspaceName}</span></Chip>
          <span>·</span>
        </span>
      ))}
      {connection !== undefined && (
        <>
          <span data-testid="sim-live" className={connection === 'connected' ? 'text-tone-done' : 'text-tone-waiting'}>{connection === 'connected' ? '● LIVE' : '● RECONNECTING'}</span>
          <span>·</span>
        </>
      )}
      <span className="text-text-3">synthetic data — not a real company; no real order, payment or tool is touched</span>
    </div>
  )
}
