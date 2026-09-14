'use client'

import type { TaskBoardItem } from '../server/tasks'
import { Segmented } from './ui/Segmented'

/** The README's filter row: a search box, a `Needs you · n` toggle, one chip per assignee and the
 *  Board/List segmented control. Everything here filters the snapshot the page is ALREADY holding
 *  — no query, no route, no server round trip. */
export function TaskFilters({
  query,
  onQuery,
  needsOnly,
  onNeedsOnly,
  needsCount,
  assignees,
  assignee,
  onAssignee,
  view,
  onView,
}: {
  readonly query: string
  readonly onQuery: (next: string) => void
  readonly needsOnly: boolean
  readonly onNeedsOnly: () => void
  readonly needsCount: number
  readonly assignees: readonly string[]
  readonly assignee: string | null
  readonly onAssignee: (next: string | null) => void
  readonly view: 'board' | 'list'
  readonly onView: (next: 'board' | 'list') => void
}): React.JSX.Element {
  // The two filter CHIPS keep their own recipe (they toggle independently and one of them is
  // amber); the Board/List control is `ui/Segmented` (M57 R21) -- no copied class strings.
  const chip = (on: boolean, tone?: 'waiting'): string =>
    `rounded-card border px-3 py-[5px] text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
      on
        ? tone === 'waiting'
          ? 'border-[color-mix(in_oklab,var(--s-waiting)_45%,var(--line2))] bg-[color-mix(in_oklab,var(--s-waiting)_14%,transparent)] text-s-waiting'
          : 'border-line2 bg-sel font-semibold text-t1'
        : 'border-line2 bg-transparent text-t2 hover:text-t1'
    }`
  return (
    <div className="flex flex-wrap items-center gap-2 px-[24px] pt-[18px] text-[13px]">
      <input
        data-testid="task-search"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        placeholder="Search tasks…"
        aria-label="Search tasks"
        className="w-[220px] rounded-card border border-line2 bg-card px-[10px] py-[6px] text-[13px] text-t1 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
      <button type="button" data-testid="task-filter-needs-you" aria-pressed={needsOnly} onClick={onNeedsOnly} className={chip(needsOnly, 'waiting')}>
        Needs you · {needsCount}
      </button>
      {assignees.map((name) => (
        <button
          key={name}
          type="button"
          data-testid="task-filter-assignee"
          data-assignee={name}
          aria-pressed={assignee === name}
          onClick={() => onAssignee(assignee === name ? null : name)}
          className={chip(assignee === name)}
        >
          {name}
        </button>
      ))}
      {/* `testIdPrefix="task-view"` gives `task-view-board` / `task-view-list` -- the two names
        * spec §3 lists and `gate-m57` stage 6 clicks. `task-view-toggle` stays on the wrapper, so
        * all three exist. */}
      <span className="ml-auto" data-testid="task-view-toggle" data-view={view}>
        <Segmented
          options={[
            { id: 'board', label: 'Board' },
            { id: 'list', label: 'List' },
          ]}
          value={view}
          onChange={onView}
          ariaLabel="Task view"
          testIdPrefix="task-view"
        />
      </span>
    </div>
  )
}

/** Which tasks survive the filter row. Exported so the page and its test agree on one rule. */
export function filterTasks(
  tasks: readonly TaskBoardItem[],
  options: { readonly query: string; readonly needsOnly: boolean; readonly assignee: string | null },
  needsYouIds: ReadonlySet<string>,
): readonly TaskBoardItem[] {
  const needle = options.query.trim().toLowerCase()
  return tasks.filter((task) => {
    if (needle.length > 0 && !task.title.toLowerCase().includes(needle) && !task.id.toLowerCase().includes(needle)) return false
    if (options.needsOnly && !needsYouIds.has(task.id)) return false
    if (options.assignee !== null && task.assigneeName !== options.assignee) return false
    return true
  })
}
