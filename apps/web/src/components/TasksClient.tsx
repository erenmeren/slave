'use client'

import type { TaskStatus } from '@ai-team-os/domain'
import { useSelectedId } from '../hooks/useSelectedId'
import { useTasks } from '../hooks/useTasks'
import type { TasksSnapshot } from '../server/tasks'
import { HaltBanner } from './HaltBanner'
import { Sidebar } from './Sidebar'
import { TaskColumn } from './TaskColumn'
import { TaskDetailPanel } from './TaskDetailPanel'
import { TopBar } from './TopBar'

/** The board's eight columns, in the spec's exact order (design doc §5 — "Columns exactly the
 * eight task statuses", no ninth). */
type BoardColumnStatus = 'backlog' | 'ready' | 'running' | 'verifying' | 'reviewing' | 'blocked' | 'done' | 'failed'

// `@ai-team-os/domain` exports the wider 12-value `TaskStatus` type (it also covers `assigned`,
// `merging`, `rework`, `cancelled`) but no ordered constant matching this narrower 8-column
// board, so the order is a literal here.
const BOARD_COLUMNS: readonly BoardColumnStatus[] = [
  'backlog',
  'ready',
  'running',
  'verifying',
  'reviewing',
  'blocked',
  'done',
  'failed',
]

// The four statuses outside the eight columns are live states, not dead ones (rework: a verify
// failure with attempts remaining, or a provisioning/resume failure — orchestrator's verify.ts
// and tick.ts). Every `TaskStatus` is bucketed onto a column here so such a task is still
// reachable on the board; `Record<TaskStatus, BoardColumnStatus>` makes the mapping exhaustive —
// a future `TaskStatus` addition is a compile error, not a silently-invisible task. The card
// itself still shows the task's true status (TaskCard's own status label), so a rework task
// visibly reads "rework" while sitting in the ready column.
const BOARD_COLUMN_FOR_STATUS: Record<TaskStatus, BoardColumnStatus> = {
  backlog: 'backlog',
  ready: 'ready',
  rework: 'ready',
  blocked: 'blocked',
  assigned: 'running',
  running: 'running',
  verifying: 'verifying',
  reviewing: 'reviewing',
  merging: 'reviewing',
  done: 'done',
  failed: 'failed',
  cancelled: 'failed',
}

export function TasksClient({
  workspaceId,
  initial,
}: {
  readonly workspaceId: string
  readonly initial: TasksSnapshot
}): React.JSX.Element {
  const { snapshot, connection, error } = useTasks(workspaceId, initial)
  const view = snapshot ?? initial
  const [selectedId, setSelectedId] = useSelectedId('task')
  const selectedTask = view.tasks.find((task) => task.id === selectedId) ?? null

  return (
    <div className="flex min-h-screen w-full">
      <Sidebar workspaceId={workspaceId} />
      <div className={`flex flex-1 flex-col ${error !== null ? 'opacity-60' : ''}`}>
        <TopBar
          workspaceId={workspaceId}
          workspaceName={view.workspace.name}
          connection={connection}
          budget={null}
          halted={view.workspace.haltedReason !== null}
        />
        {view.workspace.haltedReason !== null && <HaltBanner reason={view.workspace.haltedReason} />}
        {error !== null && (
          <div role="alert" className="border-b border-status-warn/40 bg-status-warn/10 px-4 py-1.5 text-xs text-status-warn">
            showing stale data: {error}
          </div>
        )}
        <main className="flex flex-1 gap-4 overflow-x-auto p-4">
          {BOARD_COLUMNS.map((status) => (
            <TaskColumn
              key={status}
              status={status}
              tasks={view.tasks.filter((task) => BOARD_COLUMN_FOR_STATUS[task.status] === status)}
              onSelect={setSelectedId}
            />
          ))}
        </main>
      </div>
      {selectedTask !== null && <TaskDetailPanel task={selectedTask} onClose={() => setSelectedId(null)} />}
    </div>
  )
}
