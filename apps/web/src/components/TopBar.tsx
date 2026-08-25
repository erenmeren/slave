import type React from 'react'
import { EmergencyStopButton } from './EmergencyStopButton'

// `ui/Chip.tsx`'s exact recipe (`inline-flex items-center rounded-chip border px-2 py-0.5 text-xs`,
// neutral surface `border-line bg-bg-2 text-text-2`), not the literal component -- `Chip` takes
// only `tone`/`children`, no `data-testid` passthrough, and this badge's own `connection` test-id
// (`shell.test.tsx`) must stay put. Same judgment `TaskCard.tsx`'s `CHIP_CLASS` documents.
const CONNECTION_CHIP_CLASS = 'inline-flex items-center gap-1.5 rounded-chip border border-line bg-bg-2 px-2 py-0.5 text-xs text-text-2'

export interface TopBarProps {
  readonly workspaceId: string
  readonly workspaceName: string
  readonly connection: 'connected' | 'reconnecting'
  readonly budget: { readonly spentUsd: number; readonly budgetUsd: number } | null
  readonly halted: boolean
}

export function TopBar({ workspaceId, workspaceName, connection, budget, halted }: TopBarProps): React.JSX.Element {
  const ratio = budget === null || budget.budgetUsd <= 0 ? 0 : budget.spentUsd / budget.budgetUsd
  const barColor = ratio >= 1 ? 'bg-status-danger' : ratio >= 0.8 ? 'bg-status-warn' : 'bg-status-working'
  return (
    <header className="flex h-12 items-center gap-4 border-b border-line bg-bg-1 px-4">
      <span className="text-sm font-medium">{workspaceName}</span>
      <span data-testid="connection" className={CONNECTION_CHIP_CLASS}>
        <span
          className={`inline-block h-2 w-2 rounded-full ${connection === 'connected' ? 'bg-status-working' : 'bg-status-warn'}`}
        />
        {connection}
      </span>
      <span className="ml-auto flex items-center gap-3">
        {budget !== null && (
          <span data-testid="budget" className="flex items-center gap-2 text-xs text-text-2">
            <span className="font-mono">
              ${budget.spentUsd.toFixed(2)} / ${budget.budgetUsd.toFixed(2)}
            </span>
            {/* `ui/ProgressBar.tsx`'s exact recipe (rounded-full track, `motion-safe:` width
             *  transition -- spec §3's `.5s ease`) satisfies this migration's "motion behind
             *  prefers-reduced-motion" rule, not the literal component: `ProgressBar` colours its
             *  fill from the `StatusTone` vocabulary, but `shell.test.tsx` pins the literal
             *  `bg-status-warn`/`bg-status-danger` class strings the older M4 vocabulary uses for
             *  this ratio's own three-way threshold (not a status at all). */}
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-bg-2">
              <span
                className={`block h-full motion-safe:[transition:width_.5s_ease] ${barColor}`}
                style={{ width: `${Math.min(100, ratio * 100)}%` }}
              />
            </span>
          </span>
        )}
        <EmergencyStopButton workspaceId={workspaceId} halted={halted} />
      </span>
    </header>
  )
}
