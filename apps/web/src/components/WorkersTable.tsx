'use client'

import { useEffect, useState } from 'react'
import type { WorkerRow } from '../server/org'
import { toneForStatus } from './AgentsClient'
import { DataTable, Row } from './ui/DataTable'
import { ProgressBar } from './ui/ProgressBar'
import { StatusPill } from './ui/StatusPill'

const COLUMNS = '1fr 130px 1fr 120px 1fr'
const HEADER = ['Worker', 'Role', 'Project', 'Status', 'Current task'] as const

/**
 * The Workers tab (M11 Task 8 brief): a flat table hydrated from server props, then kept fresh by
 * polling `GET /api/org/workers` every 5s via `setInterval` -- cleared on unmount, and skipped
 * (not fetched, interval left running) while `document.visibilityState === 'hidden'`, the same
 * "check at fire-time" idiom `components/graph/flow.ts`'s `canSpawnParticles` uses rather than
 * tearing the interval down and rebuilding it on every visibility change.
 */
export function WorkersTable({ initial }: { readonly initial: readonly WorkerRow[] }): React.JSX.Element {
  const [workers, setWorkers] = useState<readonly WorkerRow[]>(initial)

  useEffect(() => {
    setWorkers(initial)
  }, [initial])

  useEffect(() => {
    async function poll(): Promise<void> {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try {
        const response = await fetch('/api/org/workers')
        if (!response.ok) return
        const data = (await response.json()) as { readonly workers: readonly WorkerRow[] }
        setWorkers(data.workers)
      } catch {
        // best-effort refresh -- keep showing the last known snapshot on a transient failure
      }
    }
    const id = setInterval(() => void poll(), 5000)
    return () => clearInterval(id)
  }, [])

  return (
    <DataTable columns={COLUMNS} header={[...HEADER]}>
      {workers.map((worker) => (
        <Row key={worker.agentId} columns={COLUMNS}>
          <span className="truncate text-sm text-text-1">{worker.name}</span>
          <span className="truncate text-text-2">{worker.role}</span>
          <span className="truncate text-text-2">{worker.projectName}</span>
          <StatusPill tone={toneForStatus(worker.status)} label={worker.status} />
          <div className="flex flex-col gap-1">
            {worker.currentTask !== null ? (
              <>
                <span className="truncate text-xs text-text-2">{worker.currentTask.title}</span>
                <ProgressBar pct={worker.currentTask.pct} />
              </>
            ) : (
              <span className="text-xs text-text-3">—</span>
            )}
          </div>
        </Row>
      ))}
    </DataTable>
  )
}
