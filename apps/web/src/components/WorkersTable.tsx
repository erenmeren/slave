'use client'

import { useEffect, useState } from 'react'
import type { AgentStatus } from '@ai-team-os/domain'
import { CARD_STATE_TONE, cardStateForAgent } from '../lib/tones'
import type { WorkerRow } from '../server/org'
import { ShellOnlyMark } from './ShellOnlyMark'
import { AvatarTile } from './ui/AvatarTile'
import { DataTable, Row } from './ui/DataTable'
import { ProgressBar } from './ui/ProgressBar'
import { StatusPill } from './ui/StatusPill'

/** The design README §3a.2 grid template, verbatim. Passed to `DataTable`/`Row`, which write it
 *  as an inline `gridTemplateColumns` -- so the gate can read the exact string back off the DOM. */
const COLUMNS = '200px 130px 120px 1fr 110px 90px 80px'
const HEADER = ['Agent', 'Department', 'Status', 'Current task', 'Provider', 'Tokens', 'Cost'] as const

/** `1_400_000` → `1.4M`; `900` → `900`. The handoff's own token format. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

/**
 * The Workers tab (M11 Task 8 brief, rewritten to the handoff's seven columns in M14 Task 9):
 * a flat table hydrated from server props, then kept fresh by polling `GET /api/org/workers`
 * every 5s via `setInterval` -- cleared on unmount, and skipped (not fetched, interval left
 * running) while `document.visibilityState === 'hidden'`, the same "check at fire-time" idiom
 * `components/graph/flow.ts`'s `canSpawnParticles` uses rather than tearing the interval down
 * and rebuilding it on every visibility change.
 *
 * A row click opens the `AgentPanel` -- `onOpen` is owned by `AgentsClient`, which resolves the
 * clicked agent id into the `AgentCardData` the panel needs.
 */
export function WorkersTable({
  initial,
  onOpen,
}: {
  readonly initial: readonly WorkerRow[]
  readonly onOpen: (agentId: string) => void
}): React.JSX.Element {
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
      {workers.map((worker) => {
        const state = cardStateForAgent(worker.status as AgentStatus)
        const { tone, label, pulse } = CARD_STATE_TONE[state]
        return (
          <Row key={worker.agentId} columns={COLUMNS}>
            <button
              type="button"
              data-testid="worker-row-button"
              onClick={() => onOpen(worker.agentId)}
              className="flex min-w-0 items-center gap-[9px] text-left"
            >
              <AvatarTile name={worker.name} tone={tone} />
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-semibold text-text-1">{worker.name}</span>
                <span className="block truncate text-[10px] text-[#7c8697]">{worker.role}</span>
              </span>
            </button>
            <span data-testid="worker-department" className="truncate text-[11.5px] text-text-2">
              {worker.department}
            </span>
            <StatusPill tone={tone} label={label} pulse={pulse} />
            <div data-testid="worker-task" className="min-w-0 pr-[14px]">
              {worker.currentTask === null ? (
                <span className="text-xs text-text-3">—</span>
              ) : (
                <>
                  <span className="block truncate text-[11.5px] text-[#c8cfda]">{worker.currentTask.title}</span>
                  <ProgressBar pct={worker.currentTask.pct} tone={tone} />
                </>
              )}
            </div>
            <span className="flex items-center gap-1 font-mono text-[11px] text-text-2">
              <span data-testid="worker-provider">{worker.provider ?? '—'}</span>
              <ShellOnlyMark gate={worker.gate ?? null} />
            </span>
            <span data-testid="worker-tokens" className="font-mono text-[11px] text-[#7c8697]">
              {worker.tokens === null ? '—' : formatTokens(worker.tokens)}
            </span>
            <span data-testid="worker-cost" className="font-mono text-[11px] text-text-1">
              ${worker.costUsd.toFixed(2)}
            </span>
          </Row>
        )
      })}
    </DataTable>
  )
}
