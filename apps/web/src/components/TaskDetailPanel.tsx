import type { TaskBoardItem } from '../server/tasks.js'
import { TASK_STATUS_TEXT } from './TaskCard.js'

export function TaskDetailPanel({
  task,
  onClose,
}: {
  readonly task: TaskBoardItem
  readonly onClose: () => void
}): React.JSX.Element {
  return (
    <aside
      aria-label="Task detail"
      // Slide-in (spec §8): `TasksClient` mounts this panel fresh on card select, so the
      // animation replays on every open by construction.
      className="fixed inset-y-0 right-0 z-10 flex w-96 flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-4 motion-safe:animate-[panel-in_160ms_ease-out]"
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-text-1">{task.title}</h2>
          <span data-testid="detail-status" className={`text-xs ${TASK_STATUS_TEXT[task.status]}`}>
            {task.status}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close task detail"
          className="rounded border border-line px-2 py-1 text-xs text-text-2"
        >
          close
        </button>
      </header>

      <p className="text-sm text-text-2">{task.description}</p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
        <dt className="text-text-3">attempt</dt>
        <dd className="font-mono text-text-2">
          {task.attempt}/{task.maxAttempts}
        </dd>
        <dt className="text-text-3">branch</dt>
        <dd className="font-mono text-text-2">{task.branch ?? '—'}</dd>
        {task.lastRejectionReason !== null && (
          <>
            <dt className="text-text-3">rejection</dt>
            <dd className="text-status-warn">{task.lastRejectionReason}</dd>
          </>
        )}
      </dl>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs uppercase tracking-wide text-text-3">Runs</h3>
        {task.runs.length === 0 ? (
          <p className="text-xs text-text-3">no runs yet</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {task.runs.map((run) => (
              <li key={run.id} data-testid="run-row" className="rounded border border-line p-2 text-xs text-text-2">
                <div className="flex items-center justify-between">
                  <span>{run.status}</span>
                  <span className="font-mono">
                    ${run.costUsd.toFixed(2)} · {run.toolCalls} calls
                  </span>
                </div>
                {run.checkpoint !== null && run.checkpoint.pausedAtStep !== null && (
                  <div className="mt-1 text-text-3">
                    paused at step {run.checkpoint.pausedAtStep} · session {run.checkpoint.sessionId} · {run.checkpoint.dirtyFileCount}{' '}
                    dirty files
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}
