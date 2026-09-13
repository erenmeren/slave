'use client'

import { useRouter } from 'next/navigation'
import type { AnalyticsSnapshot } from '../server/analytics'
import { BarChart } from './BarChart'
import { KpiStrip } from './analytics/KpiStrip'
import { PageShell } from './ui/PageShell'
import { Panel } from './ui/Panel'

/**
 * The Analytics page (spec §5.9, design README "3a — Analytics"): a workspace selector, five
 * ALL-TIME KPI tiles and the 7-day stacked bar chart.
 *
 * M53 R12 took two things off it and kept the route, the `?workspace=` scope and everything else:
 * the per-slave performance table, which counted one project's MATERIALISED workers and summed
 * `costUsd` raw, and the `Spend` tile whose figure was that same raw sum. Both questions are
 * answered on `/workforce?tab=evidence`, per PROFILE and per MODEL -- two different questions -- with
 * the provenance of every figure beside it. `docs/ia.md` rule 2: nothing is removed, only moved, and
 * the panel that stood here now says where it went.
 *
 * Controller ruling (Task 7): the KPIs summarize this scope's ENTIRE history, not the 7-day window
 * — an average duration or a success rate over the last week alone would swing wildly on a quiet
 * workspace, and the day-by-day trend already exists for the windowed view. The "Last 7 days"
 * caption is therefore CHART-scoped, not a page-wide claim: it sits on the chart panel, beside the
 * chart it actually describes, rather than in the page header where it would misstate the tiles
 * sitting next to it.
 */
export function AnalyticsClient({
  snapshot,
  workspaces,
  seeded,
}: {
  readonly snapshot: AnalyticsSnapshot
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
  /** True for the seeded development workspace — the ONE labelled exception to "no placeholder
   *  data" (Decision 3), rendered as the README's own caption. */
  readonly seeded: boolean
}): React.JSX.Element {
  const router = useRouter()

  function handleWorkspaceChange(event: React.ChangeEvent<HTMLSelectElement>): void {
    const value = event.target.value
    router.push(value === '' ? '/analytics' : `/analytics?workspace=${value}`)
  }

  return (
    // `p-4`, the same page padding `SettingsClient` and `SlavesClient` use (M14 fix wave, review
    // I5). Without it the `analytics` h1 was clipped mid-glyph against the sidebar's edge and the
    // KPI strip ran flush into both viewport edges -- visible in the committed `analytics.png`.
    // M44 erratum E25 / M45 R5: the shell WRAPS this page's own frame rather than replacing it --
    // `flush` drops the shell's `gap-4 p-3 md:p-4`, so the page keeps its own padding, gap and
    // width exactly and not a pixel moves. The shell is here for its landmark and its
    // `page-shell` marker.
    <PageShell flush>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-[15px] font-semibold tracking-[-.2px] text-text-1">analytics</h1>
          <select
            data-testid="analytics-workspace-select"
            aria-label="workspace"
            value={snapshot.workspaceId ?? ''}
            onChange={handleWorkspaceChange}
            className="rounded-chip border border-line bg-bg-2 px-2 py-1 text-xs text-text-1"
          >
            <option value="">all workspaces</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </div>

        {/* M44 t3: the strip is `analytics/KpiStrip` now, so the Projects home's all-workspaces
          * section renders the same five tiles from the same builder rather than a second recipe. */}
        <KpiStrip kpis={snapshot.kpis} />

        <div className="grid grid-cols-2 gap-[16px]">
          <Panel title="tasks completed · 7 days">
            <p data-testid="analytics-caption" className="font-mono text-[9.5px] text-text-3">
              {seeded ? 'Last 7 days · seeded development data' : 'Last 7 days'}
            </p>
            <BarChart series={snapshot.series} height={180} label="tasks completed, last 7 days" />
          </Panel>

          <Panel title="how this workforce is doing">
            {/* `docs/ia.md` rule 2: nothing is removed, only moved. The per-slave table that stood
              * here counted one project's materialised workers and summed `costUsd` raw -- no
              * provenance, no profile, no model, no domain. Its questions are answered on the
              * Evidence tab, per PROFILE and per MODEL, which are two different questions. */}
            <p className="text-xs text-text-2">
              Per-profile and per-model evidence — counts, rates and what it cost —{' '}
              <a data-testid="evidence-link" className="underline" href="/workforce?tab=evidence">
                moved to Workforce → Evidence
              </a>
              .
            </p>
          </Panel>
        </div>
      </div>
    </PageShell>
  )
}
