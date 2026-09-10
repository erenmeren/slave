'use client'

import { useEffect } from 'react'
import { publishShellFacts } from '../hooks/useShellFacts'
import { publishStreamState } from '../hooks/useStreamState'
import { useSelectedId } from '../hooks/useSelectedId'
import { useTasks } from '../hooks/useTasks'
import { BOARD_COLUMNS, COLUMN_FOR_STATUS } from '../lib/taskColumns'
import type { TasksSnapshot } from '../server/tasks'
import { Alert } from './ui/Alert'
import { PageShell } from './ui/PageShell'
import { HaltBanner } from './HaltBanner'
import { TaskColumn } from './TaskColumn'
import { TaskDetailPanel } from './TaskDetailPanel'

export function TasksClient({
  workspaceId,
  initial,
}: {
  readonly workspaceId: string
  readonly initial: TasksSnapshot
}): React.JSX.Element {
  const { snapshot, connection, error, latencyMs } = useTasks(workspaceId, initial)
  const view = snapshot ?? initial
  const [selectedId, setSelectedId] = useSelectedId('task')
  const selectedTask = view.tasks.find((task) => task.id === selectedId) ?? null

  // Controller ruling carried from Task 3/8, and re-aimed by M24 §2.2: this page already streams
  // the workspace this snapshot's `shellFacts` describes, so it publishes them to
  // `hooks/useShellFacts.ts` and the project header and the Tasks tab's badge read them there —
  // no second `EventSource` against `/api/w/:id/shell` (see `OverviewClient.tsx` for the exact
  // idiom this mirrors).
  useEffect((): void => {
    publishShellFacts(workspaceId, view.shellFacts)
  }, [workspaceId, view.shellFacts])
  // Retraction is its OWN effect, keyed only on the workspace: folding it into the cleanup of the
  // publish above would retract and re-publish on every snapshot, and the header would flip to
  // its fallback facts (this page's own SSR snapshot) between the two.
  useEffect((): (() => void) => () => publishShellFacts(workspaceId, null), [workspaceId])
  useEffect((): void => {
    publishStreamState(workspaceId, { connection, latencyMs })
  }, [workspaceId, connection, latencyMs])
  useEffect((): (() => void) => () => publishStreamState(workspaceId, null), [workspaceId])

  return (
    <>
      {/* The stale-data dim stays OUTSIDE the shell (the M45 t3 idiom on the Overview):
        * `PageShell` owns the frame and takes no `className`. */}
      <div className={`flex flex-1 flex-col ${error !== null ? 'opacity-60' : ''}`}>
        {/* M44 erratum E25 / M45 R5: `flush`, because this page already carries the design
        * handoff's own gutters and `gate:m14-fidelity` measures them. The shell is here for its
        * landmark and its `page-shell` marker, not for its padding -- not a pixel moves. */}
        <PageShell flush>
          {view.workspace.haltedReason !== null && <HaltBanner reason={view.workspace.haltedReason} />}
          {/* M44 R3: the band three surfaces hand-rolled, each with its own class string, is
            * `ui/Alert` now. The one-line `role="alert"` refusal sentences under forms are NOT
            * alerts in this sense and stay exactly as they are (erratum E21). */}
          {error !== null && <Alert variant="notice">showing stale data: {error}</Alert>}
          <div className="grid grid-cols-6 gap-[10px] p-[16px]">
            {BOARD_COLUMNS.map((column) => (
              <TaskColumn
                key={column}
                column={column}
                tasks={view.tasks.filter((task) => COLUMN_FOR_STATUS[task.status] === column)}
                workspaceGoalVersion={view.workspace.goalVersion}
                onSelect={setSelectedId}
              />
            ))}
          </div>
        </PageShell>
      </div>
      {selectedTask !== null && <TaskDetailPanel task={selectedTask} workspaceId={workspaceId} workspaceGoalVersion={view.workspace.goalVersion} onClose={() => setSelectedId(null)} />}
    </>
  )
}
