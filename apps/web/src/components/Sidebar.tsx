'use client'

import type React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useProjectName } from '../hooks/useProjectName'

/** The shell's global section (M11 spec §4): always visible, on every page. `Projects` (Task 7),
 *  `Agents` (Task 8), and `Settings` (Task 9) are this milestone's own pages -- all three now
 *  live; `GLOBAL_INERT` stays as the "future page, visible but honestly disabled" idiom for
 *  whatever the next milestone adds, the old single-section Sidebar used it for Graph before M7
 *  (spec §7). */
const GLOBAL_LIVE = [
  { label: 'Projects', href: '/' },
  { label: 'Agents', href: '/agents' },
  { label: 'Settings', href: '/settings' },
] as const
const GLOBAL_INERT: readonly string[] = []

const PROJECT_LIVE = [
  { label: 'Overview', path: (workspaceId: string) => `/w/${workspaceId}` },
  { label: 'Tasks', path: (workspaceId: string) => `/w/${workspaceId}/tasks` },
  { label: 'Graph', path: (workspaceId: string) => `/w/${workspaceId}/graph` },
  { label: 'Activity', path: (workspaceId: string) => `/w/${workspaceId}/activity` },
] as const

/**
 * Pulls a `w/:id` workspace id straight out of the pathname. The global shell mounts one
 * `<Sidebar>` in `app/layout.tsx` with no per-route props (a root layout gets no dynamic-segment
 * params of its own) -- this is how it still knows which project section to show. Existing
 * `w/[workspaceId]` pages that already know their id keep passing it explicitly via the
 * `workspaceId` prop instead (see `SidebarProps`), which this defers to when given.
 */
function workspaceIdFromPathname(pathname: string): string | null {
  const match = /^\/w\/([^/]+)/.exec(pathname)
  return match?.[1] ?? null
}

export interface SidebarProps {
  /** Explicit override for call sites that already know it. Omit to derive it from the current
   *  pathname instead (the global shell mount's path). */
  readonly workspaceId?: string
  /** The open project's display name, headline for the project section. The global shell mount
   *  has no cheap way to resolve this today (a root layout gets no per-route data) and omits it,
   *  so the header falls back to a route-announced name (`useProjectName`, M11 Task 10 ruling 2)
   *  and, failing that, the bare workspace id. */
  readonly projectName?: string
}

/** The two-section shell nav (M11 spec §4): a global section (Projects/Agents/Settings, always
 *  visible) and, only on a `w/[workspaceId]/...` route, a project section headed by its name. */
export function Sidebar({ workspaceId: workspaceIdProp, projectName }: SidebarProps = {}): React.JSX.Element {
  const pathname = usePathname()
  const workspaceId = workspaceIdProp ?? workspaceIdFromPathname(pathname)
  const announcedName = useProjectName(workspaceId)

  return (
    <nav aria-label="Primary" className="flex w-44 shrink-0 flex-col gap-4 border-r border-line bg-bg-1 p-3">
      <div className="flex flex-col gap-1">
        {GLOBAL_LIVE.map((item) => {
          const current = pathname === item.href
          return (
            <Link
              key={item.label}
              href={item.href}
              aria-current={current ? 'page' : undefined}
              className={`rounded px-2 py-1.5 text-sm ${current ? 'bg-bg-2 text-text-1' : 'text-text-2 hover:text-text-1'}`}
            >
              {item.label}
            </Link>
          )
        })}
        {GLOBAL_INERT.map((label) => (
          <span key={label} aria-disabled="true" title="arrives in a later milestone" className="rounded px-2 py-1.5 text-sm text-text-3">
            {label}
          </span>
        ))}
      </div>

      {workspaceId !== null && (
        <div data-testid="project-section" className="flex flex-col gap-1">
          <div className="truncate px-2 py-1 font-mono text-[9px] uppercase tracking-[.09em] text-text-3">
            {projectName ?? announcedName ?? workspaceId}
          </div>
          {PROJECT_LIVE.map((item) => {
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
        </div>
      )}
    </nav>
  )
}
