import { TASK_STATUSES } from '@slave-of-ai/db'
import type { TaskStatus } from '@slave-of-ai/domain'
import { cardStateForTask, CARD_STATE_TONE, toneForTaskStatus } from '../lib/tones'
import type { TaskBoardItem } from '../server/tasks'
import { AvatarTile } from './ui/AvatarTile'
import { StatusPill, TONE_BORDER_SOLID, TONE_DOT, TONE_FLASH_COLOR, TONE_TEXT, type StatusTone } from './ui/StatusPill'

// The four tables below are derived, not hand-maintained (M19 C7): each is one loop over every
// `TaskStatus` through `toneForTaskStatus` into the matching `StatusPill` `TONE_*` table, so this
// file cannot carry a second, independently-drifting copy of the status→tone mapping
// `lib/tones.ts` already owns (the defect M16 Task 8 fix round 1 only partially closed -- see
// `toneForTaskStatus`'s own comment). `graph/TaskNodes.tsx` and `graph/OrgNodes.tsx` still import
// these by name; `TaskCard` itself renders through `cardStateForTask` directly, below.
function taskStatusTable(tones: Record<StatusTone, string>): Record<TaskStatus, string> {
  return Object.fromEntries(TASK_STATUSES.map((status) => [status, tones[toneForTaskStatus(status)]])) as Record<
    TaskStatus,
    string
  >
}

export const TASK_STATUS_DOT: Record<TaskStatus, string> = taskStatusTable(TONE_DOT)
export const TASK_STATUS_BORDER: Record<TaskStatus, string> = taskStatusTable(TONE_BORDER_SOLID)
export const TASK_STATUS_FLASH_COLOR: Record<TaskStatus, string> = taskStatusTable(TONE_FLASH_COLOR)
export const TASK_STATUS_TEXT: Record<TaskStatus, string> = taskStatusTable(TONE_TEXT)

/**
 * The handoff's compact card (design README §3a.3): title, status pill, assignee chip, step
 * counter (`attempt/maxAttempts`) — the id and priority live in the detail panel now (M24 §5.4).
 * Its state — and so its dot/pill tone — comes from
 * `lib/tones.ts`'s `cardStateForTask`, the ONE derivation for a card that is about a TASK
 * (Decision 2). It used to call `cardStateFor('idle', task.status)` — borrowing the agent-first
 * derivation with a fake idle agent — and so drew a grey **IDLE** pill on a `running` card sitting
 * under the teal **IN PROGRESS** column head (M14 fix wave, review I2). `cardStateForTask` reads
 * the card's own column state instead, so the pill and the column head cannot disagree.
 */
export function TaskCard({
  task,
  onSelect,
}: {
  readonly task: TaskBoardItem
  readonly onSelect: (id: string) => void
}): React.JSX.Element {
  const state = cardStateForTask(task.status)
  const { tone, label, pulse } = CARD_STATE_TONE[state]

  return (
    <button
      type="button"
      data-testid="task-card"
      data-status={task.status}
      onClick={() => onSelect(task.id)}
      className={`flex w-full flex-col gap-1 rounded-tile border bg-[#0f1116] p-[10px] text-left transition-colors hover:border-white/[0.22] ${
        task.status === 'blocked' ? 'border-tone-blocked/30' : 'border-line'
      }`}
    >
      <span className="flex items-baseline justify-end">
        <StatusPill tone={tone} label={label} pulse={pulse} />
      </span>
      <span data-testid="task-title" className="text-[11.5px] leading-[1.35] text-[#dbe1ea]">
        {task.title}
      </span>
      <span className="mt-[8px] flex items-center gap-[6px]">
        {task.assigneeName === null ? (
          <span data-testid="task-assignee" className="text-[10px] text-[#7c8697]">
            unassigned
          </span>
        ) : (
          <>
            <AvatarTile name={task.assigneeName} tone={tone} />
            <span data-testid="task-assignee" className="truncate text-[10px] text-[#7c8697]">
              {task.assigneeName}
            </span>
          </>
        )}
        <span data-testid="task-step" className="ml-auto font-mono text-[9.5px] text-text-3">
          {task.attempt}/{task.maxAttempts}
        </span>
      </span>
    </button>
  )
}
