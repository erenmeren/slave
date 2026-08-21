import type { TaskStatus } from '@ai-team-os/domain'
import type { TaskBoardItem } from '../server/tasks.js'

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

export function TaskCard({
  task,
  onSelect,
}: {
  readonly task: TaskBoardItem
  readonly onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onSelect(task.id)}
      className="flex w-full flex-col gap-1.5 rounded border border-line bg-bg-1 p-3 text-left hover:border-text-3"
    >
      <div className="flex items-center gap-2">
        <span data-testid="status-dot" className={`inline-block h-2 w-2 shrink-0 rounded-full ${TASK_STATUS_DOT[task.status]}`} />
        <span className="text-sm text-text-1">{task.title}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-text-2">
        <span data-testid="attempt" className="font-mono">
          {task.attempt}/{task.maxAttempts}
        </span>
        {task.assigneeName !== null && <span data-testid="assignee">{task.assigneeName}</span>}
      </div>
    </button>
  )
}
