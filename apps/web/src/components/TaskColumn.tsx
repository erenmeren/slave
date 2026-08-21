import type { TaskStatus } from '@ai-team-os/domain'
import type { TaskBoardItem } from '../server/tasks.js'
import { TaskCard } from './TaskCard.js'

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
        <h2 className="text-xs font-medium uppercase tracking-wide text-text-2">{status}</h2>
        <span data-testid="column-count" className="text-xs text-text-3">
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
