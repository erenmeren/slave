'use client'

import { useEffect } from 'react'
import { publishShellFacts } from '../hooks/useShellFacts'
import { publishStreamState } from '../hooks/useStreamState'
import { useSelectedId } from '../hooks/useSelectedId'
import { useTasks } from '../hooks/useTasks'
import { BOARD_COLUMNS, COLUMN_FOR_STATUS } from '../lib/taskColumns'
import type { TasksSnapshot } from '../server/tasks'
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
      <div className={`flex flex-1 flex-col ${error !== null ? 'opacity-60' : ''}`}>
        {view.workspace.haltedReason !== null && <HaltBanner reason={view.workspace.haltedReason} />}
        {error !== null && (
          <div role="alert" className="border-b border-tone-waiting/40 bg-tone-waiting/10 px-4 py-1.5 text-xs text-tone-waiting">
            showing stale data: {error}
          </div>
        )}
        <main className="grid grid-cols-6 gap-[10px] p-[16px]">
          {BOARD_COLUMNS.map((column) => (
            <TaskColumn
              key={column}
              column={column}
              tasks={view.tasks.filter((task) => COLUMN_FOR_STATUS[task.status] === column)}
              onSelect={setSelectedId}
            />
          ))}
        </main>
      </div>
      {selectedTask !== null && <TaskDetailPanel task={selectedTask} workspaceId={workspaceId} onClose={() => setSelectedId(null)} />}
    </>
  )
}
