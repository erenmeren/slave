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

/** The four keys APG's tabs pattern puts inside a horizontal tablist. Every other key falls
 *  through untouched -- Tab still leaves the strip, and Enter/Space still click the focused tab. */
const ARROW_KEYS = ['ArrowRight', 'ArrowLeft', 'Home', 'End'] as const

/**
 * APG tabs keyboard support for the BUTTON form (M44 final review, minor d), with AUTOMATIC
 * activation: an arrow moves focus AND selects, because every consumer's panel switch is local
 * state rather than a fetch (APG reserves manual activation for panels that are expensive to
 * reveal). With the roving tabindex below, the whole strip is one Tab stop and these four keys are
 * how a person moves inside it.
 *
 * Reads its siblings off the DOM rather than out of a `useRef` array ON PURPOSE: this module has
 * no `'use client'` directive and must not grow one. The `href` form renders `<Link>`s and no
 * handlers at all so a SERVER component can use it, and a hook here would forbid that. The
 * `:not([disabled])` filter is what steps over a tab that cannot be selected, and `data-tab-id`
 * carries the id a `data-testid` prefix would only half-tell us.
 */
function moveWithinTablist(event: React.KeyboardEvent<HTMLButtonElement>, onSelect?: (id: string) => void): void {
  const key = event.key
  if (!(ARROW_KEYS as readonly string[]).includes(key)) return
  const list = event.currentTarget.closest('[role="tablist"]')
  if (list === null) return
  const stops = [...list.querySelectorAll<HTMLButtonElement>('button[role="tab"]:not([disabled])')]
  if (stops.length === 0) return
  const from = stops.indexOf(event.currentTarget)
  const to =
    key === 'Home'
      ? 0
      : key === 'End'
        ? stops.length - 1
        : ((from === -1 ? 0 : from) + (key === 'ArrowRight' ? 1 : -1) + stops.length) % stops.length
  const target = stops[to]
  if (target === undefined) return
  // Only once a target is certain: an unhandled key must keep whatever the browser does with it.
  event.preventDefault()
  target.focus()
  const id = target.dataset['tabId']
  if (id !== undefined) onSelect?.(id)
}

/**
 * The segmented tab strip (M44 R3), in the idiom `ProjectTabs` already used: `role="tablist"` with
 * `role="tab"`, `aria-selected` and `aria-current="page"` on the live one. Four surfaces share it
 * now -- the project strip, Workforce, the Graph mode nav (which had plain buttons and an
 * `aria-current`, and a comment saying no shared component covered it) and the simulation tabs.
 *
 * The `href` form renders `<Link>`s and nothing else, so it is safe in a SERVER component; the
 * `onSelect` form takes a handler and therefore only works inside a client component. A tab strip
 * that mixes the two is a strip whose consumer must be a client component.
 *
 * It renders the CONTROLS, never the panels: every consumer here already owns its own content
 * switch, and a `role="tabpanel"` wrapper this component cannot see inside would only be a second
 * place for the two to disagree.
 *
 * The button form carries APG's keyboard contract (final review, minor d): a ROVING TABINDEX --
 * the strip is one Tab stop, and the selected tab is it -- plus ArrowLeft/ArrowRight/Home/End
 * inside it, via `moveWithinTablist` above. The route form keeps one Tab stop per link, because
 * those tabs are links to four different pages and `tabindex="-1"` would put three of them out of
 * the Tab key's reach.
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
            data-tab-id={tab.id}
            aria-selected={live}
            aria-current={live ? 'page' : undefined}
            tabIndex={live ? 0 : -1}
            disabled={disabledIds.includes(tab.id)}
            onClick={() => onSelect?.(tab.id)}
            onKeyDown={(event) => moveWithinTablist(event, onSelect)}
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
