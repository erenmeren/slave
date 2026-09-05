'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useShellFacts } from '../../hooks/useShellFacts'

const TABS = [
  { id: 'overview', label: 'Overview', path: (id: string) => `/w/${id}`, exact: true },
  { id: 'tasks', label: 'Tasks', path: (id: string) => `/w/${id}/tasks`, exact: false },
  { id: 'graph', label: 'Graph', path: (id: string) => `/w/${id}/graph`, exact: false },
  { id: 'office', label: 'Office', path: (id: string) => `/w/${id}/office`, exact: false },
  { id: 'activity', label: 'Activity', path: (id: string) => `/w/${id}/activity`, exact: false },
  { id: 'settings', label: 'Settings', path: (id: string) => `/w/${id}/settings`, exact: false },
] as const

/** The project's tab strip (M24 §2.2): six route links (Office joined in M28) in the Slaves page's tab idiom. Overview
 *  matches its route exactly (it is the prefix of every other tab); the rest match by prefix so a
 *  Graph mode in the query string still lights Graph. Only Tasks carries a badge. */
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

  return (
    <div role="tablist" aria-label="Project" className="flex gap-1 border-b border-line bg-bg-1 px-4 py-[6px]">
      {TABS.map((tab) => {
        const href = tab.path(workspaceId)
        const current = tab.exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)
        return (
          <Link
            key={tab.id}
            role="tab"
            data-testid={`project-tab-${tab.id}`}
            href={href}
            aria-current={current ? 'page' : undefined}
            aria-selected={current}
            className={`flex items-center gap-[6px] rounded-chip border px-3 py-1.5 text-xs font-medium transition-colors ${
              current ? 'border-line bg-bg-2 text-text-1' : 'border-transparent text-text-3 hover:text-text-2'
            }`}
          >
            {tab.label}
            {tab.id === 'tasks' && (
              <span data-testid="project-tab-badge-tasks" className="font-mono text-[9.5px] font-medium text-text-faint">
                {tasksActive}
              </span>
            )}
          </Link>
        )
      })}
    </div>
  )
}
