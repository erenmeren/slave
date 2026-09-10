'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { Tabs, type TabSpec } from '../ui/Tabs'
import { useShellFacts } from '../../hooks/useShellFacts'

/** The four tabs a person needs to answer "what is happening" (M44 R2). Overview matches its route
 *  exactly (it is the prefix of every other tab); the rest match by prefix, so a filter in the
 *  query string still lights its tab. */
const TABS = [
  { id: 'overview', label: 'Overview', path: (id: string) => `/w/${id}`, exact: true },
  { id: 'tasks', label: 'Tasks', path: (id: string) => `/w/${id}/tasks`, exact: false },
  { id: 'activity', label: 'Activity', path: (id: string) => `/w/${id}/activity`, exact: false },
  { id: 'settings', label: 'Settings', path: (id: string) => `/w/${id}/settings`, exact: false },
] as const

/** Graph and Office. COMPLETE and reachable -- by this menu and by their unchanged URLs. They left
 *  the strip because a normal user does not need five graph modes or a pixel office to find out
 *  what the project is doing, not because anything was taken away (`docs/ia.md`). */
const ADVANCED = [
  { id: 'graph', label: 'Graph', path: (id: string) => `/w/${id}/graph` },
  { id: 'office', label: 'Office', path: (id: string) => `/w/${id}/office` },
] as const

/**
 * The project's tab strip (M24 §2.2, rebuilt by M44 R2): four route links plus an `Advanced ▾`
 * menu holding Graph and Office. Only Tasks carries a badge -- the one live number in the strip.
 *
 * The menu copies `ProjectSwitcher`'s idiom, which is in the same header (erratum E22): a plain
 * popover with `role="menu"`, NOT a `Dialog`. A menu is not a modal -- it does not trap focus and
 * it does not scrim the page -- so it keeps its own Escape handler and its own trigger-refocus
 * rather than joining `useModalDismiss`'s stack.
 */
export function ProjectTabs({
  workspaceId,
  initialTasksActive,
}: {
  readonly workspaceId: string
  readonly initialTasksActive: number
}): React.JSX.Element {
  const pathname = usePathname()
  const facts = useShellFacts(workspaceId)
  const tasksActive = facts?.counts.tasksActive ?? initialTasksActive
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const isLive = (path: string, exact: boolean): boolean =>
    exact ? pathname === path : pathname === path || pathname.startsWith(`${path}/`)
  const current = TABS.find((tab) => isLive(tab.path(workspaceId), tab.exact))?.id ?? ''
  const advancedLive = ADVANCED.some((item) => isLive(item.path(workspaceId), false))

  const tabs: readonly TabSpec[] = TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    href: tab.path(workspaceId),
    ...(tab.id === 'tasks' ? { badge: tasksActive } : {}),
  }))

  return (
    <div className="relative flex items-center gap-1 border-b border-line bg-bg-1 px-4 py-[6px]">
      <Tabs tabs={tabs} current={current} ariaLabel="Project" testIdPrefix="project-tab" />
      <button
        ref={triggerRef}
        type="button"
        data-testid="project-advanced"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={advancedLive ? 'page' : undefined}
        onClick={() => setOpen((was) => !was)}
        className={`flex items-center gap-[6px] rounded-chip border px-3 py-1.5 text-xs font-medium transition-colors ${
          advancedLive ? 'border-line bg-bg-2 text-text-1' : 'border-transparent text-text-3 hover:text-text-2'
        }`}
      >
        Advanced
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Advanced"
          className="absolute right-4 top-[38px] z-30 flex min-w-[160px] flex-col rounded-panel border border-line bg-bg-1 p-1 shadow-resting"
        >
          {ADVANCED.map((item) => (
            <Link
              key={item.id}
              role="menuitem"
              data-testid={`advanced-item-${item.id}`}
              href={item.path(workspaceId)}
              aria-current={isLive(item.path(workspaceId), false) ? 'page' : undefined}
              onClick={() => setOpen(false)}
              className="rounded-nav px-2 py-1.5 text-xs text-text-2 hover:bg-white/[0.045] hover:text-text-1"
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
