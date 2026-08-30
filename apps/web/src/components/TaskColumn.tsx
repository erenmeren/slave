import { COLUMN_STATE, type BoardColumn } from '../lib/taskColumns'
import { CARD_STATE_TONE } from '../lib/tones'
import type { TaskBoardItem } from '../server/tasks'
import { TaskCard } from './TaskCard'
import { TONE_DOT } from './ui/StatusPill'

export function TaskColumn({
  column,
  tasks,
  onSelect,
}: {
  readonly column: BoardColumn
  readonly tasks: readonly TaskBoardItem[]
  readonly onSelect: (id: string) => void
}): React.JSX.Element {
  // One tone table (Decision 2): the column's state, then that state's tone. Never a colour
  // chosen here.
  const tone = CARD_STATE_TONE[COLUMN_STATE[column]].tone
  return (
    <div data-testid="column" data-column={column} className="flex min-w-0 flex-col gap-2">
      <header className="flex items-center gap-[7px] border-b border-line pb-[7px]">
        <span data-testid={`column-dot-${column}`} data-tone={tone} className={`h-[5px] w-[5px] rounded-full ${TONE_DOT[tone]}`} />
        {/* An `<h2>`, not `SectionLabel`'s `<div>`: `tasks-components.test.tsx` reaches these by
          * `getAllByRole('heading', { level: 2 })`, and the recipe is the same 9.5px mono. */}
        <h2 className="font-mono text-[9.5px] font-medium uppercase tracking-[.06em] text-text-2">{column}</h2>
        <span data-testid={`column-count-${column}`} className="font-mono text-[9.5px] text-text-3">
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
