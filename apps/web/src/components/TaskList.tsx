'use client'

import { USER_TASK_LABEL, userTaskStatus } from '@slave-of-ai/domain'
import { priorityChip } from '../lib/taskColumns'
import type { TaskBoardItem } from '../server/tasks'

/** The header and every row share this template (fix round 1, minor 4): one `const` rather than
 *  the same five-track string typed twice, so the two agree by construction and a column can
 *  never move under one without moving under the other. */
const LIST_COLUMNS = 'grid-cols-[70px_120px_minmax(0,1fr)_120px_60px]'

/** The README's list view: `70px 120px 1fr 120px 60px`, a mono header at 11px/.06em, one row per
 *  task. The same rows the board draws, in one column instead of five — for the day somebody wants
 *  to read the whole board rather than look at it. */
export function TaskList({
  tasks,
  onSelect,
}: {
  readonly tasks: readonly TaskBoardItem[]
  readonly onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="px-[24px] pb-[24px] pt-4">
      <div data-testid="task-list" className="overflow-hidden rounded-panel-card border border-line bg-card text-[13.5px]">
        <div className={`grid ${LIST_COLUMNS} gap-3 border-b border-line px-4 py-[9px] font-mono text-[11px] font-semibold uppercase tracking-[.06em] text-t3`}>
          <span>ID</span>
          <span>Status</span>
          <span>Title</span>
          <span>Assignee</span>
          <span>Pri</span>
        </div>
        {tasks.map((task) => {
          // `TaskBoardItem` carries `integratedAt` (`grep -n integratedAt apps/web/src/server/tasks.ts`),
          // so it is threaded through exactly as the board card's own `taskStatusWord` call does.
          const word = userTaskStatus({ status: task.status, integrated: task.integratedAt != null })
          const priority = priorityChip(task.priority)
          return (
            <button
              key={task.id}
              type="button"
              data-testid="task-list-row"
              data-task-id={task.id}
              data-status={task.status}
              onClick={() => onSelect(task.id)}
              className={`grid w-full ${LIST_COLUMNS} items-center gap-3 border-b border-line px-4 py-[10px] text-left last:border-b-0 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent`}
            >
              <span className="truncate font-mono text-[12px] font-medium text-t3">{task.id.slice(0, 8)}</span>
              {/* The DOMAIN's word, with the raw status one attribute away (`docs/ia.md` rule 3). */}
              <span title={task.status} className="truncate font-mono text-[11px] font-medium tracking-[.04em] text-t2">
                {USER_TASK_LABEL[word.state]}
              </span>
              <span className="truncate font-medium text-t1">{task.title}</span>
              <span className="truncate text-t2">{task.assigneeName ?? '—'}</span>
              <span className="font-mono text-[11.5px] font-medium text-t3">{priority.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
