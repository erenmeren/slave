import type { TaskBoardItem } from '../server/tasks'
import { TASK_STATUS_TEXT } from './TaskCard'
import { Button } from './ui/Button'
import { SectionLabel } from './ui/SectionLabel'

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
      // animation replays on every open by construction. Stays a hand-rolled `<aside>`, not
      // `ui/Panel` -- the motion test (`tasks-components.test.tsx`) asserts on
      // `container.querySelector('aside')` directly, and `Panel` renders a `<section>` with no
      // `className` passthrough for the fixed edge-anchored positioning this needs. Adopts
      // `Panel`'s `shadow-resting` token (its own radius doesn't apply -- this panel is flush
      // against the viewport's top/right/bottom edges, same precedent as
      // `AssignCompanyDialog.tsx`'s floating surface).
      className="fixed inset-y-0 right-0 z-10 flex w-96 flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-4 shadow-resting motion-safe:animate-[panel-in_160ms_ease-out]"
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-text-1">{task.title}</h2>
          <span data-testid="detail-status" className={`text-xs ${TASK_STATUS_TEXT[task.status]}`}>
            {task.status}
          </span>
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="Close task detail">
          close
        </Button>
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
            <dd className="text-tone-waiting">{task.lastRejectionReason}</dd>
          </>
        )}
      </dl>

      <section className="flex flex-col gap-2">
        <SectionLabel>Runs</SectionLabel>
        {task.runs.length === 0 ? (
          <p className="text-xs text-text-3">no runs yet</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {task.runs.map((run) => (
              <li key={run.id} data-testid="run-row" className="rounded border border-line p-2 text-xs text-text-2">
                <div className="flex items-center justify-between">
                  <span>{run.status}</span>
                  <span className="font-mono">
                    {/* `—` for a run whose runtime reported no spend (spec Decision 6). */}
                    {run.costUsd === null ? '—' : `$${run.costUsd.toFixed(2)}`} · {run.toolCalls} calls
                  </span>
                </div>
                {run.checkpoint !== null && run.checkpoint.pausedAtStep !== null && (
                  <div className="mt-1 text-text-3">
                    paused at step {run.checkpoint.pausedAtStep} · session {run.checkpoint.sessionId} · {run.checkpoint.dirtyFileCount}{' '}
                    dirty files
                  </div>
                )}
                {run.checkpoint !== null && run.checkpoint.deniedDuringPause.length > 0 && (
                  // `summary` is always `null` today (see `TaskRunSummary.checkpoint`'s own
                  // comment: no join key exists), so this always renders the id-prefix fallback --
                  // not a bug, a fact of the data. Same 8-char id-prefix convention as
                  // `TaskCard`/`AgentCard`'s `TASK-{id.slice(0, 8)}`; unlike a task's random UUID
                  // this can render two Claude `toolu_01…` ids identically (they share that fixed
                  // vendor prefix) -- an accepted limit of a best-effort display, not a bug to fix
                  // here. `font-mono text-[10px] text-text-3`, adjacent to `SECTION_LABEL_CLASS`
                  // (`ui/SectionLabel.tsx`) rather than reusing it: that class is for headings
                  // (uppercase, wide tracking), and this is a value line, same relationship the
                  // `paused at step` line above already has to it.
                  <div className="mt-1 font-mono text-[10px] text-text-3">
                    {run.checkpoint.deniedDuringPause.length} tool call{run.checkpoint.deniedDuringPause.length === 1 ? '' : 's'} denied
                    during pause · {run.checkpoint.deniedDuringPause.map((denied) => denied.summary ?? `${denied.id.slice(0, 8)}…`).join(', ')}
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
