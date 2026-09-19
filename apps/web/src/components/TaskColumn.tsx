import { COLUMN_STATE, type BoardColumn } from '../lib/taskColumns'
import { CARD_STATE_TONE } from '../lib/tones'
import type { TaskBoardItem } from '../server/tasks'
import { TaskCard } from './TaskCard'
import { ScrollArea } from './ui/ScrollArea'
import { TONE_DOT } from './ui/StatusPill'

export function TaskColumn({
  column,
  tasks,
  workspaceGoalVersion,
  onSelect,
}: {
  readonly column: BoardColumn
  readonly tasks: readonly TaskBoardItem[]
  /** Passed straight through to every card (M40 §6): the goal version the PROJECT is on, which is
   *  what a card's own stamp is compared against for the stale badge. */
  readonly workspaceGoalVersion: number
  readonly onSelect: (id: string) => void
}): React.JSX.Element {
  // One tone table (Decision 2): the column's state, then that state's tone. Never a colour
  // chosen here.
  const tone = CARD_STATE_TONE[COLUMN_STATE[column]].tone
  return (
    // M61 R9/Task 7: `self-stretch min-h-0` -- the grid's own `items-start` (`TasksClient.tsx`)
    // sizes a track to its tallest column's CONTENT height by default, the same override
    // `ActivityClient`'s own family rail needed (ruling T8-4) for `column-scroll` below to have an
    // actual bounded box to scroll inside rather than just growing the whole board past the frame.
    <div data-testid="column" data-column={column} className="flex min-h-0 min-w-0 flex-col gap-2 self-stretch">
      <header className="flex items-center gap-[7px] border-b border-line pb-[7px]">
        <span data-testid={`column-dot-${column}`} data-tone={tone} className={`h-[7px] w-[7px] rounded-full ${TONE_DOT[tone]}`} />
        {/* An `<h2>`, not `SectionLabel`'s `<div>`: `tasks-components.test.tsx` reaches these by
          * `getAllByRole('heading', { level: 2 })`. */}
        <h2 className="text-[13px] font-semibold text-t1">{column}</h2>
        <span data-testid={`column-count-${column}`} className="font-mono text-[11.5px] font-medium text-t3">
          {tasks.length}
        </span>
      </header>
      <ScrollArea testId="column-scroll" className="flex flex-col gap-2">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} workspaceGoalVersion={workspaceGoalVersion} onSelect={onSelect} />
        ))}
        {tasks.length === 0 && (
          <p data-testid="column-empty" className="rounded-tile-lg border border-dashed border-line2 p-[14px] text-center text-[12.5px] text-t3">
            Nothing here
          </p>
        )}
      </ScrollArea>
    </div>
  )
}
