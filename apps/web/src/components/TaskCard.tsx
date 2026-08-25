import type { TaskStatus } from '@ai-team-os/domain'
import type { TaskBoardItem } from '../server/tasks'
import { Card } from './ui/Card'

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

// Chip's visual recipe (`ui/Chip.tsx`: `inline-flex items-center rounded-chip border px-2 py-0.5
// text-xs`, neutral surface `border-line bg-bg-2 text-text-2`), not the literal component — `Chip`
// takes only `tone`/`children`, no `data-testid` passthrough, and this card's priority/assignee
// chips must keep the `priority`/`assignee` test-ids `tasks-components.test.tsx` asserts on
// unmodified. Same judgment Task 10 applied to `AgentCard.tsx`'s provider badge.
const CHIP_CLASS = 'inline-flex items-center rounded-chip border border-line bg-bg-2 px-2 py-0.5 text-xs text-text-2'

export function TaskCard({
  task,
  onSelect,
}: {
  readonly task: TaskBoardItem
  readonly onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    // `Card` (spec §3a compact card): outer surface only. Its own `data-testid="card"` /
    // `data-selected` attributes are additive and asserted by no test here.
    <Card onClick={() => onSelect(task.id)}>
      <div className="flex items-center justify-between gap-2">
        <span data-testid="task-id" className="font-mono text-[10px] text-text-3">
          {task.id}
        </span>
        <span data-testid="priority" className={`${CHIP_CLASS} font-mono`}>
          p{task.priority}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span data-testid="status-dot" className={`inline-block h-2 w-2 shrink-0 rounded-full ${TASK_STATUS_DOT[task.status]}`} />
        <span className="text-sm text-text-1">{task.title}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-text-2">
        <span data-testid="status-label" className={TASK_STATUS_TEXT[task.status]}>
          {task.status}
        </span>
        <span data-testid="attempt" className="font-mono">
          {task.attempt}/{task.maxAttempts}
        </span>
        {task.assigneeName !== null && (
          <span data-testid="assignee" className={`${CHIP_CLASS} ml-auto`}>
            {task.assigneeName}
          </span>
        )}
      </div>
    </Card>
  )
}
