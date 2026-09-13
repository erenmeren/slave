import type { Kpi } from '../../server/analytics'

/** The five all-time KPI tiles. Extracted from `AnalyticsClient` in M44 so the Projects home can
 *  show the all-workspaces view without a second builder or a second tile recipe (R1). Both
 *  testids are unchanged -- `kpi-tile` is `gate:m14-fidelity`'s structural marker for /analytics.
 *
 *  SIX until M53 R12 (plan erratum E18), which deleted the `Spend` tile: its figure was a raw
 *  `SUM(costUsd)` with no provenance in it, and money moved to `/workforce?tab=evidence` where each
 *  figure carries the word for how it was arrived at.
 *
 *  `grid-cols-5` is an `xl:` step with 2-up and 3-up below it (R6's page-level breakpoints).
 *  At 1440px -- the fidelity gate's viewport -- `xl:` is active and the strip is a five-up. */
export function KpiStrip({ kpis }: { readonly kpis: readonly Kpi[] }): React.JSX.Element {
  return (
    <div
      data-testid="kpi-strip"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-tile border border-line bg-line md:grid-cols-3 xl:grid-cols-5"
    >
      {kpis.map((kpi) => (
        <div key={kpi.label} data-testid="kpi-tile" className="flex flex-col gap-1 bg-bg-1 p-[10px]">
          <span className="font-mono text-[10.5px] uppercase tracking-[.09em] text-text-3">{kpi.label}</span>
          <span className="font-mono text-[20px] font-semibold tracking-[-.8px] text-text-1">{kpi.value}</span>
          {kpi.note !== null && (
            <span data-testid={`kpi-note-${kpi.label}`} className="text-[9.5px] text-text-3">
              {kpi.note}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
