'use client'

import type React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LIVE = [
  { label: 'Overview', path: (workspaceId: string) => `/w/${workspaceId}` },
  { label: 'Tasks', path: (workspaceId: string) => `/w/${workspaceId}/tasks` },
  { label: 'Activity', path: (workspaceId: string) => `/w/${workspaceId}/activity` },
  { label: 'Graph', path: (workspaceId: string) => `/w/${workspaceId}/graph` },
] as const

// Empty now that Graph (the roadmap's last inert item) has gone live -- kept, not deleted: the
// `INERT.map(...)` rendering below is the mechanism for "future page, visible but honestly
// disabled" (spec §7), and M7 was the last milestone with a roadmap item still pending, not
// necessarily the last milestone ever to add one. An empty array costs nothing to keep; removing
// the machinery would just mean re-adding it verbatim the next time a page ships behind the rest.
const INERT: readonly string[] = []

/** The roadmap rendered as chrome: future pages are visible but inert (spec §7). */
export function Sidebar({ workspaceId }: { readonly workspaceId: string }): React.JSX.Element {
  const pathname = usePathname()
  return (
    <nav aria-label="Primary" className="flex w-44 shrink-0 flex-col gap-1 border-r border-line bg-bg-1 p-3">
      {LIVE.map((item) => {
        const href = item.path(workspaceId)
        const current = pathname === href
        return (
          <Link
            key={item.label}
            href={href}
            aria-current={current ? 'page' : undefined}
            className={`rounded px-2 py-1.5 text-sm ${current ? 'bg-bg-2 text-text-1' : 'text-text-2 hover:text-text-1'}`}
          >
            {item.label}
          </Link>
        )
      })}
      {INERT.map((label) => (
        <span key={label} aria-disabled="true" title="arrives in a later milestone" className="rounded px-2 py-1.5 text-sm text-text-3">
          {label}
        </span>
      ))}
    </nav>
  )
}
