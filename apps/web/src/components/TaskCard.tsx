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
 * Which requirement produced this task (M40 §1), as a card says it.
 *
 * "unstamped" rather than a blank or a `v0`: a hand-made task was derived from no goal version at
 * all, which is a real and different fact from "we do not know", and a `v0` would name a
 * `GoalVersion` row that does not exist.
 */
export function goalStampText(goalVersion: number | null): string {
  return goalVersion === null ? 'unstamped' : `goal v${String(goalVersion)}`
}

/**
 * Whether a task is behind the goal the project is on (M40 §6) -- the **stale** badge's one rule,
 * shared by the card and the detail panel so the two cannot disagree about one task.
 *
 * A null stamp is never stale: no plan derived that task from a goal, so there is no version for it
 * to be behind. This is the same predicate `summarise`'s `next.stale` count uses in the domain,
 * restated here over the DTO rather than imported -- the domain's version reads a
 * `SupervisorWorld`, which is a model's input, not a board card's.
 */
export function isStale(goalVersion: number | null, workspaceGoalVersion: number): boolean {
  return goalVersion !== null && goalVersion < workspaceGoalVersion
}

/**
 * The handoff's compact card (design README §3a.3): title, status pill, assignee chip, step
 * counter (`attempt/maxAttempts`) — the id and priority live in the detail panel now (M24 §5.4).
 * Its state — and so its dot/pill tone — comes from
 * `lib/tones.ts`'s `cardStateForTask`, the ONE derivation for a card that is about a TASK
 * (Decision 2). It used to call `cardStateFor('idle', task.status)` — borrowing the slave-first
 * derivation with a fake idle slave — and so drew a grey **IDLE** pill on a `running` card sitting
 * under the teal **IN PROGRESS** column head (M14 fix wave, review I2). `cardStateForTask` reads
 * the card's own column state instead, so the pill and the column head cannot disagree.
 */
export function TaskCard({
  task,
  workspaceGoalVersion,
  onSelect,
}: {
  readonly task: TaskBoardItem
  /** The version of the goal the PROJECT is on (M40 §6) -- what this card's own stamp is compared
   *  against for the stale badge. */
  readonly workspaceGoalVersion: number
  readonly onSelect: (id: string) => void
}): React.JSX.Element {
  const state = cardStateForTask(task.status)
  const { tone, label, pulse } = CARD_STATE_TONE[state]
  const stale = isStale(task.goalVersion, workspaceGoalVersion)

  return (
    <button
      type="button"
      data-testid="task-card"
      data-status={task.status}
      onClick={() => onSelect(task.id)}
      // Greyed, not reddened (M40 §6): a cancelled card is still readable and still selectable --
      // an operator has to be able to open it and read why -- but it recedes, because the work it
      // stands for is not coming back.
      className={`flex w-full flex-col gap-1 rounded-tile border bg-bg-card-alt p-[10px] text-left transition-colors hover:border-white/[0.22] ${
        task.status === 'blocked' ? 'border-tone-blocked/30' : 'border-line'
      } ${task.status === 'cancelled' ? 'opacity-60' : ''}`}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span data-testid="task-goal-version" className="truncate font-mono text-[9.5px] text-text-3">
          {goalStampText(task.goalVersion)}
        </span>
        <span className="flex shrink-0 items-baseline gap-[6px]">
          {stale && (
            // The one thing on this card an operator may have to act on: the requirement moved and
            // this task is still the old one's work.
            <span data-testid="task-stale" className="font-mono text-[9px] uppercase tracking-wide text-tone-waiting">
              stale
            </span>
          )}
          <StatusPill tone={tone} label={label} pulse={pulse} />
        </span>
      </span>
      <span data-testid="task-title" className="text-[11.5px] leading-[1.35] text-[#dbe1ea]">
        {task.title}
      </span>
      {task.status === 'cancelled' && task.lastRejectionReason !== null && (
        // WHY it is off the board, on the card itself: `cancelTask` keeps the reason on the task,
        // and a cancelled card with no reason is the one an operator has to open to understand.
        // Another party's text -- a re-plan's own sentence, or an operator's -- as JSX children,
        // so it is characters and never elements (spec §1).
        <span data-testid="task-cancel-reason" className="text-[10px] leading-[1.35] text-text-3">
          {task.lastRejectionReason}
        </span>
      )}
      <span className="mt-[8px] flex items-center gap-[6px]">
        {task.assigneeName === null ? (
          <span data-testid="task-assignee" className="text-[10px] text-text-dim">
            unassigned
          </span>
        ) : (
          <>
            <AvatarTile name={task.assigneeName} tone={tone} />
            <span data-testid="task-assignee" className="truncate text-[10px] text-text-dim">
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
