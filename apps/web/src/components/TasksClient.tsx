'use client'

import { useEffect } from 'react'
import { publishShellFacts } from '../hooks/useShellFacts'
import { useSelectedId } from '../hooks/useSelectedId'
import { useTasks } from '../hooks/useTasks'
import { announceProjectName } from '../hooks/useProjectName'
import { BOARD_COLUMNS, COLUMN_FOR_STATUS } from '../lib/taskColumns'
import type { TasksSnapshot } from '../server/tasks'
import { HaltBanner } from './HaltBanner'
import { TaskColumn } from './TaskColumn'
import { TaskDetailPanel } from './TaskDetailPanel'
import { TopBar } from './TopBar'

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

  // Fills the global shell's Sidebar project-section header with this workspace's real name
  // (M11 Task 10 ruling 2) — the root layout mounts one <Sidebar> with no per-route params of its
  // own, so this is how it learns the name rather than showing the bare workspaceId forever.
  useEffect((): void => {
    announceProjectName(workspaceId, view.workspace.name)
  }, [workspaceId, view.workspace.name])

  // Controller ruling carried from Task 3/8: this page already streams the workspace this
  // snapshot's `shellFacts` describes, so it publishes them to `hooks/useShellFacts.ts` and the
  // sidebar opens no second `EventSource` against `/api/w/:id/shell` (see `OverviewClient.tsx`
  // for the exact idiom this mirrors).
  useEffect((): void => {
    publishShellFacts(workspaceId, view.shellFacts)
  }, [workspaceId, view.shellFacts])
  // Retraction is its OWN effect, keyed only on the workspace: folding it into the cleanup of the
  // publish above would retract and re-publish on every snapshot, and the sidebar would flip to
  // its fallback stream (opening a connection) between the two.
  useEffect((): (() => void) => () => publishShellFacts(workspaceId, null), [workspaceId])

  return (
    <>
      <div className={`flex flex-1 flex-col ${error !== null ? 'opacity-60' : ''}`}>
        <TopBar
          workspaceId={workspaceId}
          workspaceName={view.workspace.name}
          connection={connection}
          latencyMs={latencyMs}
          budget={null}
          halted={view.workspace.haltedReason !== null}
        />
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
      {selectedTask !== null && <TaskDetailPanel task={selectedTask} onClose={() => setSelectedId(null)} />}
    </>
  )
}
