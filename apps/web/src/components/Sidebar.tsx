'use client'

import type React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LIVE = [
  { label: 'Overview', path: (workspaceId: string) => `/w/${workspaceId}` },
  { label: 'Tasks', path: (workspaceId: string) => `/w/${workspaceId}/tasks` },
] as const

const INERT = ['Activity', 'Graph'] as const

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
