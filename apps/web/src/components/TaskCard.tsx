import type { TaskStatus } from '@ai-team-os/domain'
import { priorityChip } from '../lib/taskColumns'
import { cardStateForTask, CARD_STATE_TONE } from '../lib/tones'
import type { TaskBoardItem } from '../server/tasks'
import { AvatarTile } from './ui/AvatarTile'
import { StatusPill, TONE_TEXT } from './ui/StatusPill'

// Reuses the M4 status vocabulary (design doc §8: "no new tokens expected") rather than minting
// task-specific colours. Several statuses share a token deliberately — e.g. both `ready` and
// `verifying` read as "in flight, not yet the agent's turn" (starting/cyan).
export const TASK_STATUS_DOT: Record<TaskStatus, string> = {
  backlog: 'bg-status-idle',
  ready: 'bg-status-starting',
  blocked: 'bg-status-warn',
  assigned: 'bg-status-starting',
  running: 'bg-status-working',
  verifying: 'bg-status-starting',
  reviewing: 'bg-status-paused',
  merging: 'bg-status-paused',
  rework: 'bg-status-warn',
  done: 'bg-status-working',
  failed: 'bg-status-danger',
  cancelled: 'bg-status-idle',
}

// Same status → colour mapping as `TASK_STATUS_DOT`, as literal `border-status-*` strings rather
// than a runtime `.replace('bg-', 'border-')` on the dot's own class: Tailwind v4 generates
// utilities by scanning source text for literal class names, so an assembled-at-runtime string
// (however mechanically derived from a literal) never gets generated — the graph's active-task
// satellite (`OrgNodes.tsx`) hit exactly this, fix-round-1 finding 4.
export const TASK_STATUS_BORDER: Record<TaskStatus, string> = {
  backlog: 'border-status-idle',
  ready: 'border-status-starting',
  blocked: 'border-status-warn',
  assigned: 'border-status-starting',
  running: 'border-status-working',
  verifying: 'border-status-starting',
  reviewing: 'border-status-paused',
  merging: 'border-status-paused',
  rework: 'border-status-warn',
  done: 'border-status-working',
  failed: 'border-status-danger',
  cancelled: 'border-status-idle',
}

// The border-flash's `--flash-color` source per `TaskStatus` (M7 task 8, spec §6's status-flash
// signal) — same "reuse the existing tokens through their `@theme inline` names" rule
// `AgentCard.tsx`'s own `FLASH_COLOR` follows, just keyed by the wider status vocabulary tasks use.
export const TASK_STATUS_FLASH_COLOR: Record<TaskStatus, string> = {
  backlog: 'var(--color-status-idle)',
  ready: 'var(--color-status-starting)',
  blocked: 'var(--color-status-warn)',
  assigned: 'var(--color-status-starting)',
  running: 'var(--color-status-working)',
  verifying: 'var(--color-status-starting)',
  reviewing: 'var(--color-status-paused)',
  merging: 'var(--color-status-paused)',
  rework: 'var(--color-status-warn)',
  done: 'var(--color-status-working)',
  failed: 'var(--color-status-danger)',
  cancelled: 'var(--color-status-idle)',
}

export const TASK_STATUS_TEXT: Record<TaskStatus, string> = {
  backlog: 'text-status-idle',
  ready: 'text-status-starting',
  blocked: 'text-status-warn',
  assigned: 'text-status-starting',
  running: 'text-status-working',
  verifying: 'text-status-starting',
  reviewing: 'text-status-paused',
  merging: 'text-status-paused',
  rework: 'text-status-warn',
  done: 'text-status-working',
  failed: 'text-status-danger',
  cancelled: 'text-status-idle',
}

/**
 * The handoff's compact card (design README §3a.3): mono id, priority chip, title, assignee
 * chip, step counter (`attempt/maxAttempts`). Its state — and so its dot/pill tone — comes from
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
  const priority = priorityChip(task.priority)
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
      <span className="flex items-baseline gap-[7px]">
        <span data-testid="task-ref" className="font-mono text-[9.5px] font-medium text-text-3">
          TASK-{task.id.slice(0, 8)}
        </span>
        <span data-testid="task-priority" className={`font-mono text-[9px] font-medium ${TONE_TEXT[priority.tone]}`}>
          {priority.label}
        </span>
        <span className="ml-auto">
          <StatusPill tone={tone} label={label} pulse={pulse} />
        </span>
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
