'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { SidebarProject } from '../../server/sidebar'
import { WORKSPACE_TONE } from '../../lib/tones'
import { TONE_DOT } from '../ui/StatusPill'
import { useModalDismiss } from '../ui/useModalDismiss'
import { ChevronIcon } from './icons'

/** How long a fetch triggered by opening the switcher has to wait before it may ask again -- moved
 *  here, unchanged, from `SidebarTree.tsx` (spec erratum E11, scan finding 23) now that the tree
 *  itself is gone (M61 R5). */
const SIDEBAR_REFETCH_MS = 10_000

/**
 * The header's project list (M61 R5), replacing the tree `SidebarTree` used to draw down the left
 * side: a trigger that IS the breadcrumb's project crumb, and a popover listing every project from
 * the same `GET /api/sidebar` read the tree used to make.
 *
 * `projects` seeds the popover the way `SidebarTree`'s `initial` seeded the tree -- the root
 * layout's own server read, so the first open (before any fetch lands) is already right. The
 * refetch only runs while the popover is OPEN: nobody is looking at a closed trigger's stale list,
 * so there is nothing to keep current until somebody asks.
 */
export function ProjectSwitcher({
  projects,
  currentId,
  currentName,
}: {
  readonly projects: readonly SidebarProject[]
  readonly currentId: string | null
  readonly currentName: string | null
}): React.JSX.Element {
  const pathname = usePathname()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<readonly SidebarProject[]>(projects)
  const lastPathname = useRef(pathname)
  const lastFetchedAt = useRef(0)

  // The layout's own read moves on too (a project renamed, archived, created elsewhere) -- keep the
  // seed current even for a popover that never gets a chance to fetch.
  useEffect((): void => {
    setRows(projects)
  }, [projects])

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined
    const forced = lastPathname.current !== pathname
    lastPathname.current = pathname
    const now = Date.now()
    if (!forced && now - lastFetchedAt.current < SIDEBAR_REFETCH_MS) return undefined
    lastFetchedAt.current = now
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const response = await fetch('/api/sidebar')
        if (!response.ok) return
        const next = (await response.json()) as readonly SidebarProject[]
        if (!cancelled) setRows(next)
      } catch {
        // Keep the list we have. A popover that empties itself because one fetch failed is worse
        // than one that is a few seconds stale.
      }
    })()
    return (): void => {
      cancelled = true
    }
  }, [open, pathname])

  const menuRef = useModalDismiss<HTMLDivElement>({ open, onClose: () => setOpen(false) })

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="project-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className="inline-flex items-center gap-1"
      >
        {currentName ?? 'Projects'}
        <ChevronIcon className="text-t3" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          data-testid="project-switcher-menu"
          tabIndex={-1}
          className="glass absolute left-0 top-full z-30 mt-1 w-[280px] rounded-surface border border-line p-1 shadow-resting"
        >
          {rows.map((project) => (
            <Link
              key={project.id}
              role="menuitem"
              data-testid="project-switcher-item"
              data-workspace={project.id}
              data-status={project.status}
              data-needs-you={project.needsYouCount}
              title={project.statusLabel}
              aria-current={project.id === currentId ? 'page' : undefined}
              href={`/w/${project.id}`}
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2 rounded-card px-[10px] py-[7px] text-[13px] text-t2 hover:bg-hover hover:text-t1 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
            >
              <span aria-hidden className={`h-[6px] w-[6px] shrink-0 rounded-full ${TONE_DOT[WORKSPACE_TONE[project.status]]}`} />
              <span className="flex-1 truncate text-left">{project.name}</span>
              {project.needsYouCount > 0 && (
                <span className="font-mono text-[11px] font-medium text-s-waiting">{project.needsYouCount}</span>
              )}
            </Link>
          ))}
          <button
            type="button"
            data-testid="new-project"
            onClick={() => {
              setOpen(false)
              router.push('/?new=1')
            }}
            className="flex w-full items-center gap-2 rounded-card px-[10px] py-[7px] text-left text-[13px] font-medium text-accent hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
          >
            New project
          </button>
        </div>
      )}
    </div>
  )
}
