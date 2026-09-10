import Link from 'next/link'
import type React from 'react'

export interface TabSpec {
  readonly id: string
  readonly label: string
  /** A live count beside the label (the project strip's active-task badge). */
  readonly badge?: React.ReactNode
  /** A route tab renders as a `<Link role="tab">`; without it the tab is a `<button>`. */
  readonly href?: string
}

const BASE = 'flex items-center gap-[6px] rounded-chip border px-3 py-1.5 text-xs font-medium transition-colors'
const ON = 'border-line bg-bg-2 text-text-1'
const OFF = 'border-transparent text-text-3 hover:text-text-2'

/**
 * The segmented tab strip (M44 R3), in the idiom `ProjectTabs` already used: `role="tablist"` with
 * `role="tab"`, `aria-selected` and `aria-current="page"` on the live one. Four surfaces share it
 * now -- the project strip, Workforce, the Graph mode nav (which had plain buttons and an
 * `aria-current`, and a comment saying no shared component covered it) and the simulation tabs.
 *
 * It renders the CONTROLS, never the panels: every consumer here already owns its own content
 * switch, and a `role="tabpanel"` wrapper this component cannot see inside would only be a second
 * place for the two to disagree.
 */
export function Tabs({
  tabs,
  current,
  ariaLabel,
  testIdPrefix,
  onSelect,
  disabledIds = [],
}: {
  readonly tabs: readonly TabSpec[]
  readonly current: string
  readonly ariaLabel: string
  readonly testIdPrefix: string
  readonly onSelect?: (id: string) => void
  readonly disabledIds?: readonly string[]
}): React.JSX.Element {
  return (
    <div role="tablist" aria-label={ariaLabel} className="flex gap-1">
      {tabs.map((tab) => {
        const live = tab.id === current
        const className = `${BASE} ${live ? ON : OFF}`
        const badge =
          tab.badge === undefined ? null : (
            <span data-testid={`${testIdPrefix}-badge-${tab.id}`} className="font-mono text-[9.5px] font-medium text-text-faint">
              {tab.badge}
            </span>
          )
        if (tab.href !== undefined) {
          return (
            <Link
              key={tab.id}
              role="tab"
              data-testid={`${testIdPrefix}-${tab.id}`}
              href={tab.href}
              aria-selected={live}
              aria-current={live ? 'page' : undefined}
              className={className}
            >
              {tab.label}
              {badge}
            </Link>
          )
        }
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-testid={`${testIdPrefix}-${tab.id}`}
            aria-selected={live}
            aria-current={live ? 'page' : undefined}
            disabled={disabledIds.includes(tab.id)}
            onClick={() => onSelect?.(tab.id)}
            className={`${className} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {tab.label}
            {badge}
          </button>
        )
      })}
    </div>
  )
}
