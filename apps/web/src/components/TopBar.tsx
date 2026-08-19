import type React from 'react'

export interface TopBarProps {
  readonly workspaceName: string
  readonly connection: 'connected' | 'reconnecting'
  readonly budget: { readonly spentUsd: number; readonly budgetUsd: number } | null
}

export function TopBar({ workspaceName, connection, budget }: TopBarProps): React.JSX.Element {
  const ratio = budget === null || budget.budgetUsd <= 0 ? 0 : budget.spentUsd / budget.budgetUsd
  const barColor = ratio >= 1 ? 'bg-status-danger' : ratio >= 0.8 ? 'bg-status-warn' : 'bg-status-working'
  return (
    <header className="flex h-12 items-center gap-4 border-b border-line bg-bg-1 px-4">
      <span className="text-sm font-medium">{workspaceName}</span>
      <span data-testid="connection" className="flex items-center gap-1.5 text-xs text-text-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${connection === 'connected' ? 'bg-status-working' : 'bg-status-warn'}`}
        />
        {connection}
      </span>
      {budget !== null && (
        <span data-testid="budget" className="ml-auto flex items-center gap-2 text-xs text-text-2">
          <span className="font-mono">
            ${budget.spentUsd.toFixed(2)} / ${budget.budgetUsd.toFixed(2)}
          </span>
          <span className="h-1.5 w-24 overflow-hidden rounded bg-bg-2">
            <span className={`block h-full ${barColor}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
          </span>
        </span>
      )}
    </header>
  )
}
