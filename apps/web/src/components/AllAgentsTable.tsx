'use client'

import { useEffect, useState } from 'react'
import type { AllAgentRow } from '../server/org'
import { AgentRowActions } from './AgentRowActions'
import { toneForStatus } from './AgentsClient'
import { ModelOverrideEditor } from './ModelOverrideEditor'
import { AvatarTile } from './ui/AvatarTile'
import { DataTable, Row } from './ui/DataTable'
import { ProgressBar } from './ui/ProgressBar'
import { StatusPill } from './ui/StatusPill'

/** M24 §5.3's one Agents table: agent · role · team · project · status · current task · provider
 *  · cost · actions. Built from the old flat self-polling table's skeleton (M24 Task 7). */
const COLUMNS = '200px 110px 130px 120px 110px 1fr 90px 90px 160px'
const HEADER = ['Agent', 'Role', 'Team', 'Project', 'Status', 'Current task', 'Provider', 'Cost', ''] as const

/** The shape `GET /api/org/workers` returns -- only the LIVE fields this table's poll merges in
 *  are read off it; the rest of a row (`role`, `teamName`, `model`, ...) comes from the server
 *  snapshot and a catalog-only row's identity, neither of which the poll ever changes. */
interface PolledWorker {
  readonly agentId: string
  readonly status: string
  readonly currentTask: AllAgentRow['currentTask']
  readonly provider: AllAgentRow['provider']
  readonly costUsd: number
  readonly unmeasuredRuns: number
}

/**
 * The Agents page's one table (M24 §5.3, Task 7): the old grouped company -> team roster (with
 * its expandable worker sub-rows) and the old flat, self-polling worker list were two names for
 * the same list of agents -- this is the one of them. `listAllAgents()`'s union feeds it: a
 * `null` `agentId` marks a catalog member no project has materialized yet, shown with
 * `project —` and no row actions (spec §5.3: rename/re-role/delete act on a project `Agent`,
 * which a catalog member is not).
 *
 * Kept fresh the same way the old worker list was: polling `GET /api/org/workers` every 5s via
 * `setInterval` -- cleared on unmount, skipped (not fetched, interval left running) while
 * `document.visibilityState === 'hidden'` -- and merging the LIVE fields (`status`,
 * `currentTask`, `provider`, `costUsd`, `unmeasuredRuns`) into the rows whose `agentId` matches.
 * A catalog row's `agentId` is `null`, so it never matches a polled worker and never changes from
 * the poll -- a project materializing it is a page reload, not a poll tick.
 *
 * A row click opens the `AgentPanel` -- `onOpen` is owned by `AgentsClient`, unchanged from the
 * old table's own contract.
 */
export function AllAgentsTable({
  initial,
  onOpen,
}: {
  readonly initial: readonly AllAgentRow[]
  readonly onOpen: (row: { readonly agentId: string; readonly workspaceId: string }) => void
}): React.JSX.Element {
  const [rows, setRows] = useState<readonly AllAgentRow[]>(initial)

  useEffect(() => {
    setRows(initial)
  }, [initial])

  useEffect(() => {
    async function poll(): Promise<void> {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try {
        const response = await fetch('/api/org/workers')
        if (!response.ok) return
        const data = (await response.json()) as { readonly workers: readonly PolledWorker[] }
        const byId = new Map(data.workers.map((w) => [w.agentId, w] as const))
        setRows((prev) =>
          prev.map((r) => {
            const w = r.agentId === null ? undefined : byId.get(r.agentId)
            return w === undefined
              ? r
              : { ...r, status: w.status, currentTask: w.currentTask, provider: w.provider, costUsd: w.costUsd, unmeasuredRuns: w.unmeasuredRuns }
          }),
        )
      } catch {
        // best-effort refresh -- keep showing the last known snapshot on a transient failure
      }
    }
    const id = setInterval(() => void poll(), 5000)
    return () => clearInterval(id)
  }, [])

  return (
    <DataTable columns={COLUMNS} header={[...HEADER]}>
      {rows.map((row) => {
        const tone = toneForStatus(row.status)
        // Plain locals, not `row.agentId`/`row.workspaceId` property accesses: TS narrows a
        // captured variable across the `onClick` closure below, but not a captured property.
        const { agentId, workspaceId } = row
        return (
          <Row key={agentId ?? `catalog-${row.companyAgentId ?? row.name}`} columns={COLUMNS}>
            {agentId !== null && workspaceId !== null ? (
              <button
                type="button"
                data-testid="worker-row-button"
                onClick={() => onOpen({ agentId, workspaceId })}
                className="flex min-w-0 items-center gap-[9px] text-left"
              >
                <AvatarTile name={row.name} tone={tone} />
                <span className="block min-w-0 truncate text-[12.5px] font-semibold text-text-1">{row.name}</span>
              </button>
            ) : (
              <span className="truncate text-[12.5px] font-semibold text-text-1">{row.name}</span>
            )}
            <span className="truncate text-[11.5px] text-text-2">{row.role}</span>
            <span className="truncate text-[11.5px] text-text-2">{row.teamName}</span>
            {row.projectName === null ? (
              <span data-testid="agent-project" aria-label="project —" className="text-xs text-text-3">
                —
              </span>
            ) : (
              <span data-testid="agent-project" className="truncate text-[11.5px] text-text-2">
                {row.projectName}
              </span>
            )}
            <StatusPill tone={tone} label={row.status} />
            <div data-testid="worker-task" className="min-w-0 pr-[14px]">
              {row.currentTask === null ? (
                <span className="text-xs text-text-3">—</span>
              ) : (
                <>
                  <span className="block truncate text-[11.5px] text-[#c8cfda]">{row.currentTask.title}</span>
                  <ProgressBar pct={row.currentTask.pct} tone={tone} />
                </>
              )}
            </div>
            <span data-testid="worker-provider" className="font-mono text-[11px] text-text-2">
              {row.provider ?? '—'}
            </span>
            {/* The KPI tile's own idiom (M14 fix wave, review I1 / Decision 4: "a sum over
              * unknowns says how many were unknown"), unchanged from the old worker list. */}
            <span data-testid="worker-cost" className="font-mono text-[11px] text-text-1">
              ${row.costUsd.toFixed(2)}
              {row.unmeasuredRuns > 0 && (
                <span data-testid={`worker-unmeasured-${agentId ?? row.companyAgentId ?? ''}`} className="text-text-3">
                  {' '}
                  · {row.unmeasuredRuns} unmeasured
                </span>
              )}
            </span>
            <div className="flex flex-wrap items-center gap-1">
              {agentId !== null && (
                <>
                  <ModelOverrideEditor agentId={agentId} model={row.model} provider={row.provider} />
                  <AgentRowActions agentId={agentId} name={row.name} role={row.role} />
                </>
              )}
            </div>
          </Row>
        )
      })}
    </DataTable>
  )
}
