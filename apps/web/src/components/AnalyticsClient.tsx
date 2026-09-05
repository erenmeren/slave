'use client'

import { useRouter } from 'next/navigation'
import { formatDuration, formatTokens } from '../lib/format'
import type { AnalyticsSnapshot } from '../server/analytics'
import { BarChart } from './BarChart'
import { AvatarTile } from './ui/AvatarTile'
import { DataTable, Row } from './ui/DataTable'
import { Panel } from './ui/Panel'
import { ProgressBar } from './ui/ProgressBar'

const PERF_COLUMNS = '1fr 46px 80px 70px 90px 60px'
const PERF_HEADER = ['Slave', 'Runs', 'Success', 'Avg', 'Tokens', 'Cost']

/**
 * The Analytics page (spec §5.9, design README "3a — Analytics"): a workspace selector, six
 * ALL-TIME KPI tiles, the 7-day stacked bar chart, and the ALL-TIME per-slave performance table.
 *
 * Controller ruling (Task 7): the KPIs and per-slave rows summarize this scope's ENTIRE history,
 * not the 7-day window — an average duration or a success rate over the last week alone would
 * swing wildly on a quiet workspace, and the day-by-day trend already exists for the windowed
 * view. The "Last 7 days" caption is therefore CHART-scoped, not a page-wide claim: it sits on the
 * chart panel, beside the chart it actually describes, rather than in the page header where it
 * would misstate the KPIs and table sitting next to it.
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

      <div data-testid="kpi-strip" className="grid grid-cols-6 gap-px overflow-hidden rounded-tile border border-line bg-line">
        {snapshot.kpis.map((kpi) => (
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

      <div className="grid grid-cols-2 gap-[16px]">
        <Panel title="tasks completed · 7 days">
          <p data-testid="analytics-caption" className="font-mono text-[9.5px] text-text-3">
            {seeded ? 'Last 7 days · seeded development data' : 'Last 7 days'}
          </p>
          <BarChart series={snapshot.series} height={180} label="tasks completed, last 7 days" />
        </Panel>

        <Panel title="slave performance">
          <DataTable columns={PERF_COLUMNS} header={PERF_HEADER}>
            {snapshot.perSlave.map((row) => (
              <Row key={row.slaveId} columns={PERF_COLUMNS}>
                <span className="flex min-w-0 items-center gap-[9px]">
                  {/* `idle`, fixed: this row summarizes ALL-TIME performance, not a live run --
                      there is no status on `SlavePerformanceRow` to derive a tone from, and
                      borrowing one from the slave's CURRENT run would tie a history table to a
                      fact it does not describe. */}
                  <AvatarTile name={row.name} tone="idle" />
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-semibold text-text-1">{row.name}</span>
                    <span className="block truncate text-[10px] text-[#7c8697]">{row.role}</span>
                  </span>
                </span>
                <span className="font-mono text-[11px] text-text-2">{row.runs}</span>
                <span className="flex items-center gap-1">
                  <span className="w-[34px]">
                    <ProgressBar pct={row.successPct} />
                  </span>
                  <span data-testid={`perf-success-${row.slaveId}`} className="font-mono text-[11px] text-text-2">
                    {row.successPct === null ? '—' : `${row.successPct}%`}
                  </span>
                </span>
                <span data-testid={`perf-avg-${row.slaveId}`} className="font-mono text-[11px] text-text-2">
                  {row.avgDurationMs === null ? '—' : formatDuration(row.avgDurationMs)}
                </span>
                <span data-testid={`perf-tokens-${row.slaveId}`} className="font-mono text-[11px] text-text-2">
                  {row.tokens === null ? '—' : formatTokens(row.tokens)}
                </span>
                {/* The Spend KPI tile's own idiom, on the per-slave row (M14 fix wave, review
                  * I1): a cost that hides how many of the slave's runs were never measured
                  * presents the measured part of a bill as the whole of it. */}
                <span className="font-mono text-[11px] text-text-1">
                  ${row.costUsd.toFixed(2)}
                  {row.unmeasuredRuns > 0 && (
                    <span data-testid={`perf-unmeasured-${row.slaveId}`} className="text-text-3">
                      {' '}
                      · {row.unmeasuredRuns} unmeasured
                    </span>
                  )}
                </span>
              </Row>
            ))}
          </DataTable>
        </Panel>
      </div>
    </div>
  )
}
