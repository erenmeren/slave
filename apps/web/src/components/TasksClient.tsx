'use client'

import { useEffect, useRef } from 'react'
import { publishShellFacts } from '../hooks/useShellFacts'
import { publishStreamState } from '../hooks/useStreamState'
import { useSelectedId } from '../hooks/useSelectedId'
import { useRightPanel } from './shell/RightPanelProvider'
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

  // What the URL names RIGHT NOW, readable from a closure created for an earlier subject. The
  // provider calls the PREVIOUS owner's clearer whenever a DIFFERENT subject takes the slot
  // (ruling T3-4) -- and that includes this page moving its own selection from one task to the
  // next, where the "previous owner" is this same page and its selection has already moved on.
  // Clearing then would cancel a selection one frame after a person made it, so the clearer only
  // fires while the URL still names the task it was created for.
  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedTask?.id ?? null

  // M57 R8 / plan errata E4-E5: `?task=` is still the source of truth and still what a refresh
  // restores -- this only MIRRORS it into the shell's right panel, which is where the panel is
  // drawn now. The clearer handed to `open` is the same one the panel's own close used, so the
  // slot's `»`, the slot's `✕` and the panel's own control all clear the URL together.
  //
  // THE DEPENDENCY LIST IS `selectedTask?.id` AND NOTHING ELSE (scan finding 21): `view` changes
  // identity on every SSE frame, and an effect that re-`open()`s several times a second is an
  // effect that fights the person who just collapsed the panel. The fourth argument to `open` is
  // the content KEY, which is what lets the provider tell a re-assertion of the same task from a
  // new one. And it handles the CLEAR, because `?task=` can go away by navigation -- a link, a
  // Back -- rather than by the close button.
  const { open: openPanel, close: closePanel, mode: panelMode } = useRightPanel()
  useEffect((): void => {
    if (selectedTask === null) {
      if (panelMode === 'task') closePanel()
      return
    }
    const openedFor = selectedTask.id
    openPanel(
      'task',
      <TaskDetailPanel
        // KEYED on the task (final review, Minor 5): the panel keeps its three on-demand reads --
        // the knowledge, the artifact preview, the recorded run context -- in its own state, and
        // none of them is keyed to the task. Without this, React re-uses the one instance when
        // the selection moves and one task's knowledge stays on the screen under another task's
        // title. A new key is a new instance, so every such read starts closed and empty.
        key={selectedTask.id}
        task={selectedTask}
        workspaceId={workspaceId}
        workspaceGoalVersion={view.workspace.goalVersion}
        onClose={() => {
          setSelectedId(null)
          closePanel()
        }}
      />,
      () => {
        if (selectedIdRef.current === openedFor) setSelectedId(null)
      },
      openedFor,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on the SELECTION
    // and not on the snapshot: see the note above. `panelMode` is read, not depended on, for the
    // same reason (it changes when this effect's own `close()` lands).
  }, [selectedTask?.id])

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
    </>
  )
}
