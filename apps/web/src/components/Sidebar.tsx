import type React from 'react'

const NAV = [
  { label: 'Overview', enabled: true },
  { label: 'Tasks', enabled: false },
  { label: 'Activity', enabled: false },
  { label: 'Graph', enabled: false },
] as const

/** The roadmap rendered as chrome: future pages are visible but inert (spec §7). */
export function Sidebar(): React.JSX.Element {
  return (
    <nav aria-label="Primary" className="flex w-44 shrink-0 flex-col gap-1 border-r border-line bg-bg-1 p-3">
      {NAV.map((item) =>
        item.enabled ? (
          <span key={item.label} aria-current="page" className="rounded px-2 py-1.5 text-sm bg-bg-2 text-text-1">
            {item.label}
          </span>
        ) : (
          <span key={item.label} aria-disabled="true" title="arrives in a later milestone" className="rounded px-2 py-1.5 text-sm text-text-3">
            {item.label}
          </span>
        ),
      )}
    </nav>
  )
}
