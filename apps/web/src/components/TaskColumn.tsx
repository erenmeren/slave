import type { TaskStatus } from '@ai-team-os/domain'
import type { TaskBoardItem } from '../server/tasks'
import { TaskCard } from './TaskCard'

export function TaskColumn({
  status,
  tasks,
  onSelect,
}: {
  readonly status: TaskStatus
  readonly tasks: readonly TaskBoardItem[]
  readonly onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <div data-testid={`column-${status}`} className="flex w-64 shrink-0 flex-col gap-2">
      <header className="flex items-center justify-between px-1">
        {/* `ui/SectionLabel.tsx`'s recipe (font-mono 9px, uppercase, .09em tracking), not the
         * literal component — the board test (`tasks-components.test.tsx`) asserts this is an
         * `<h2>` via `getAllByRole('heading', { level: 2 })`, and `SectionLabel` renders a `<div>`. */}
        <h2 className="font-mono text-[9px] uppercase tracking-[.09em] text-text-3">{status}</h2>
        <span data-testid="column-count" className="font-mono text-[9px] text-text-3">
          {tasks.length}
        </span>
      </header>
      <div className="flex flex-col gap-2">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}
