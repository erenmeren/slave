'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { AllSlaveRow, AllSlavesPage } from '../server/org'
import { sendControl } from '../lib/postControl'
import { SlaveRowActions } from './SlaveRowActions'
import { toneForStatus } from './SlavesClient'
import { ModelOverrideEditor } from './ModelOverrideEditor'
import { ShellOnlyMark } from './ShellOnlyMark'
import { AvatarTile } from './ui/AvatarTile'
import { DataTable, Row } from './ui/DataTable'
import { ProgressBar } from './ui/ProgressBar'
import { StatusPill } from './ui/StatusPill'

/** M24 §5.3's one Slaves table: slave · role · department · project · status · current task ·
 *  provider · cost · actions. Built from the old flat self-polling table's skeleton (M24 Task 7).
 *  The department column widened from 130px to 150px in M25 Task 6, when its bare team-name
 *  `<span>` became a `<select>`. */
const COLUMNS = '200px 110px 150px 120px 110px 1fr 90px 90px 160px'
const HEADER = ['Slave', 'Role', 'Department', 'Project', 'Status', 'Current task', 'Provider', 'Cost', ''] as const

/** The shape `GET /api/org/workers` returns -- a full `WorkerRow` per slave, project-wide, not
 *  scoped to the rows this table already knows about (M24 final review, Important 4). A poll
 *  reads every field on it: the live ones are merged into an already-known project row, and the
 *  rest seed a brand-new row for a worker this table has never rendered before. */
interface PolledWorker {
  readonly slaveId: string
  readonly name: string
  readonly role: string
  readonly workspaceId: string
  readonly projectName: string
  readonly status: string
  readonly currentTask: AllSlaveRow['currentTask']
  /** The worker's own project `Team.id` (M25 Task 6) -- merged into a known row's `teamId`, so
   *  a department move made through the select on another tab (or another operator) shows up in
   *  this table's next poll tick. */
  readonly teamId: string
  readonly department: string
  readonly provider: AllSlaveRow['provider']
  readonly gate: AllSlaveRow['gate']
  readonly costUsd: number
  readonly unmeasuredRuns: number
}

/**
 * The Slaves page's one table (M24 §5.3, Task 7): the old grouped company -> team roster (with
 * its expandable worker sub-rows) and the old flat, self-polling worker list were two names for
 * the same list of slaves -- this is the one of them. `listAllSlaves()`'s union feeds it: a
 * `null` `slaveId` marks a catalog member no project has materialized yet, shown with `project —`
 * and no rename/re-role/model-override (those act on a project `Slave`, which a catalog member
 * is not) -- but it still gets a delete (M27 §4.3): `SlaveRowActions`' `catalog` prop renders
 * only `catalog-slave-delete`, which goes through `deleteCompanySlave` and never touches the
 * project copies `assignCompany` already made.
 *
 * Kept fresh the same way the old worker list was: polling `GET /api/org/workers` every 5s via
 * `setInterval` -- cleared on unmount, skipped (not fetched, interval left running) while
 * `document.visibilityState === 'hidden'`. Restored to the base `WorkersTable`'s full add/remove
 * contract (M24 final review, Important 4 -- Task 7's merge-only poll had regressed it: a worker
 * created after load never appeared, and a deleted one never left): a project row whose `slaveId`
 * IS in the payload gets its live fields (`status`, `currentTask`, `provider`, `gate`, `costUsd`,
 * `unmeasuredRuns`) merged in; one whose `slaveId` is NOT in the payload is dropped; a payload
 * worker matching no known row becomes a brand-new project row instead. A catalog row's `slaveId`
 * is `null`, so it never matches a polled worker, is never dropped, and never gains one --
 * `listAllSlaves()`'s catalog union runs once, at load; a project materializing a catalog member
 * is a page reload, not a poll tick.
 *
 * `initial` is the full `AllSlavesPage` now, not a bare row array (M25 Task 6, spec §4.1): the
 * department column reads/writes a project row's `teamId` or a catalog row's `companyTeamId`
 * through a `<select>` (`DepartmentCell` below), whose option list comes from
 * `initial.departmentsByWorkspace`/`initial.templatesByCompany` -- keyed lookups, not a per-row
 * fetch. Those two maps are fixed at load; a poll tick only ever merges a row's live fields.
 *
 * A row click opens the `SlavePanel` -- `onOpen` is owned by `SlavesClient`, unchanged from the
 * old table's own contract.
 */
export function AllSlavesTable({
  initial,
  onOpen,
}: {
  readonly initial: AllSlavesPage
  readonly onOpen: (row: { readonly slaveId: string; readonly workspaceId: string }) => void
}): React.JSX.Element {
  const [rows, setRows] = useState<readonly AllSlaveRow[]>(initial.rows)

  useEffect(() => {
    setRows(initial.rows)
  }, [initial])

  useEffect(() => {
    async function poll(): Promise<void> {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try {
        const response = await fetch('/api/org/workers')
        if (!response.ok) return
        const data = (await response.json()) as { readonly workers: readonly PolledWorker[] }
        const byId = new Map(data.workers.map((w) => [w.slaveId, w] as const))
        setRows((prev) => {
          // Catalog rows pass through untouched; a known project row survives only if its
          // `slaveId` is still in the payload (dropped otherwise), merging in the live fields.
          const kept: AllSlaveRow[] = []
          const seenSlaveIds = new Set<string>()
          for (const r of prev) {
            if (r.slaveId === null) {
              kept.push(r)
              continue
            }
            const w = byId.get(r.slaveId)
            if (w === undefined) continue
            seenSlaveIds.add(r.slaveId)
            kept.push({
              ...r,
              status: w.status,
              currentTask: w.currentTask,
              teamId: w.teamId,
              departmentName: w.department,
              provider: w.provider,
              gate: w.gate,
              costUsd: w.costUsd,
              unmeasuredRuns: w.unmeasuredRuns,
            })
          }
          // A payload worker this table has never rendered becomes a new project row.
          // `companySlaveId`/`companyId`/`companyTeamId`/`model` are `null` -- none is knowable
          // from this payload; a roster link and a hand-made override both stay unknown until the
          // next full reload.
          for (const w of data.workers) {
            if (seenSlaveIds.has(w.slaveId)) continue
            kept.push({
              slaveId: w.slaveId,
              companySlaveId: null,
              name: w.name,
              role: w.role,
              departmentName: w.department,
              projectName: w.projectName,
              workspaceId: w.workspaceId,
              teamId: w.teamId,
              companyId: null,
              companyTeamId: null,
              status: w.status,
              currentTask: w.currentTask,
              provider: w.provider,
              gate: w.gate,
              model: null,
              costUsd: w.costUsd,
              unmeasuredRuns: w.unmeasuredRuns,
              // Not in the poll payload, same as `model` above -- unknown until the next full
              // reload (`AllSlaveRow.runCount`'s own docstring).
              runCount: 0,
            })
          }
          // The table's order rule, unchanged from `listAllSlaves()`: project rows sorted
          // project-then-name, catalog rows (no `slaveId`) after.
          const projectRows = kept
            .filter((r) => r.slaveId !== null)
            .sort((a, b) => (a.projectName ?? '').localeCompare(b.projectName ?? '') || a.name.localeCompare(b.name))
          const catalogRows = kept.filter((r) => r.slaveId === null)
          return [...projectRows, ...catalogRows]
        })
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
        // Plain locals, not `row.slaveId`/`row.workspaceId` property accesses: TS narrows a
        // captured variable across the `onClick` closure below, but not a captured property.
        const { slaveId, workspaceId } = row
        return (
          <Row key={slaveId ?? `catalog-${row.companySlaveId ?? row.name}`} columns={COLUMNS}>
            {slaveId !== null && workspaceId !== null ? (
              <button
                type="button"
                data-testid="worker-row-button"
                onClick={() => onOpen({ slaveId, workspaceId })}
                className="flex min-w-0 items-center gap-[9px] text-left"
              >
                <AvatarTile name={row.name} tone={tone} />
                <span className="block min-w-0 truncate text-[12.5px] font-semibold text-text-1">{row.name}</span>
              </button>
            ) : (
              <span className="truncate text-[12.5px] font-semibold text-text-1">{row.name}</span>
            )}
            <span className="truncate text-[11.5px] text-text-2">{row.role}</span>
            <DepartmentCell row={row} page={initial} />
            {row.projectName === null ? (
              <span data-testid="slave-project" aria-label="project —" className="text-xs text-text-3">
                —
              </span>
            ) : (
              <span data-testid="slave-project" className="truncate text-[11.5px] text-text-2">
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
            <span className="flex items-center gap-1 font-mono text-[11px] text-text-2">
              <span data-testid="worker-provider">{row.provider ?? '—'}</span>
              <ShellOnlyMark gate={row.gate} />
            </span>
            {/* The KPI tile's own idiom (M14 fix wave, review I1 / Decision 4: "a sum over
              * unknowns says how many were unknown"), unchanged from the old worker list. */}
            <span data-testid="worker-cost" className="font-mono text-[11px] text-text-1">
              ${row.costUsd.toFixed(2)}
              {row.unmeasuredRuns > 0 && (
                <span data-testid={`worker-unmeasured-${slaveId ?? row.companySlaveId ?? ''}`} className="text-text-3">
                  {' '}
                  · {row.unmeasuredRuns} unmeasured
                </span>
              )}
            </span>
            <div className="flex flex-wrap items-center gap-1">
              {slaveId !== null ? (
                <>
                  <ModelOverrideEditor slaveId={slaveId} model={row.model} provider={row.provider} />
                  <SlaveRowActions slaveId={slaveId} name={row.name} role={row.role} runCount={row.runCount} />
                </>
              ) : (
                row.companySlaveId !== null && (
                  <SlaveRowActions
                    slaveId={row.companySlaveId}
                    name={row.name}
                    role={row.role}
                    runCount={0}
                    catalog={{ companySlaveId: row.companySlaveId }}
                  />
                )
              )}
            </div>
          </Row>
        )
      })}
    </DataTable>
  )
}

/**
 * The Slaves table's department cell (M25 Task 6, spec §4.1): a `<select>`, not a bare name --
 * a project row lists its own workspace's departments and PUTs `/api/slaves/:id/team`
 * (`{ teamId }`); a catalog row lists its own company's templates (its `CompanyTeam`s) and PUTs
 * `/api/org/slaves/:id/team` (`{ companyTeamId }`). `isProject` is `AllSlavesTable`'s own project-
 * row test (`slaveId !== null && workspaceId !== null`), repeated here rather than threaded down
 * as a prop -- the two facts it reads (`row.slaveId`, `row.workspaceId`) are already on `row`.
 *
 * The controlled `value={current}` is what keeps the OLD value on a 409: `current` is read
 * straight off `row.teamId`/`row.companyTeamId`, which does not change until the parent's `rows`
 * state does -- and that only happens on `router.refresh()`, never as a side effect of the select
 * firing its own `onChange`. A refusal renders `slave-department-error` under the select instead
 * (`role="alert"`, spec §9's refusal-band idiom) and leaves the select's value exactly where it
 * was. Disabled while a move is in flight, and whenever its own row has no options to offer
 * (an empty workspace/company -- `options.length === 0`), so a select with nothing in it is never
 * clickable into a no-op.
 */
function DepartmentCell({ row, page }: { readonly row: AllSlaveRow; readonly page: AllSlavesPage }): React.JSX.Element {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const isProject = row.slaveId !== null && row.workspaceId !== null
  const options = isProject
    ? (page.departmentsByWorkspace[row.workspaceId ?? ''] ?? [])
    : (page.templatesByCompany[row.companyId ?? ''] ?? [])
  const current = isProject ? (row.teamId ?? '') : (row.companyTeamId ?? '')

  const move = async (next: string): Promise<void> => {
    if (next === current || next === '') return
    setPending(true)
    setErrorText(null)
    const error =
      isProject && row.slaveId !== null
        ? await sendControl(`/api/slaves/${row.slaveId}/team`, { method: 'PUT', body: { teamId: next } })
        : await sendControl(`/api/org/slaves/${row.companySlaveId ?? ''}/team`, { method: 'PUT', body: { companyTeamId: next } })
    setPending(false)
    if (error === null) router.refresh()
    else setErrorText(error)
  }

  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <select
        data-testid="slave-department"
        aria-label="department"
        value={current}
        disabled={pending || options.length === 0}
        onChange={(event) => void move(event.target.value)}
        className="w-full rounded border border-line bg-bg-2 px-1.5 py-1 text-[11px] text-text-1"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      {errorText !== null && (
        <span role="alert" data-testid="slave-department-error" className="text-[10px] text-tone-blocked">
          {errorText}
        </span>
      )}
    </span>
  )
}
