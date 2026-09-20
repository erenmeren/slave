'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { userTaskStatus } from '@slave-of-ai/domain'
import { publishShellFacts } from '../hooks/useShellFacts'
import { publishStreamState } from '../hooks/useStreamState'
import { useSelectedId } from '../hooks/useSelectedId'
import { useMode } from './mode/ModeProvider'
import { useRightPanel } from './shell/RightPanelProvider'
import { useTasks } from '../hooks/useTasks'
import { BOARD_COLUMNS, COLUMN_FOR_STATUS } from '../lib/taskColumns'
import type { TasksSnapshot } from '../server/tasks'
import { Alert } from './ui/Alert'
import { ScrollArea } from './ui/ScrollArea'
import { HaltBanner } from './HaltBanner'
import { TaskColumn } from './TaskColumn'
import { TaskDetailPanel } from './TaskDetailPanel'
import { TaskFilters, filterTasks } from './TaskFilters'
import { TaskList } from './TaskList'

export function TasksClient({
  workspaceId,
  initial,
}: {
  readonly workspaceId: string
  readonly initial: TasksSnapshot
}): React.JSX.Element {
  const { snapshot, connection, error, latencyMs } = useTasks(workspaceId, initial)
  // Renamed from `view` (Step 6): the new `view` state below is the board/list toggle, and the two
  // must not shadow each other.
  const snapshotView = snapshot ?? initial
  const [selectedId, setSelectedId] = useSelectedId('task')
  const selectedTask = snapshotView.tasks.find((task) => task.id === selectedId) ?? null

  const [query, setQuery] = useState('')
  const [needsOnly, setNeedsOnly] = useState(false)
  const [assignee, setAssignee] = useState<string | null>(null)
  const [view, setView] = useState<'board' | 'list'>('board')

  // The README's filter row filters the snapshot the page already holds -- no query, no route.
  const needsYouIds = useMemo(
    () => new Set(snapshotView.tasks.filter((task) => userTaskStatus({ status: task.status }).needsYou).map((task) => task.id)),
    [snapshotView.tasks],
  )
  const assignees = [...new Set(snapshotView.tasks.map((t) => t.assigneeName).filter((n): n is string => n !== null))].sort()
  // Fix round 1 (ruling T7-3): `assignee` is a name typed into state by a click, and the snapshot
  // that name came from keeps changing underneath it -- a reassignment, a cancellation, or the
  // task simply dropping off an SSE frame can all remove the last task that carried it. Without
  // this, `assignee` stays set while its own chip (which only renders for names in `assignees`)
  // disappears, `visible` goes empty, every column reads "Nothing here", and there is no control
  // left on screen to clear a filter nobody can see is still active. Derived at the call site
  // rather than an effect: the state itself is never wrong, only stale for one render, and this
  // is the one read of it that has to agree with what `TaskFilters` is about to draw.
  const effectiveAssignee = assignee !== null && assignees.includes(assignee) ? assignee : null
  const visible = filterTasks(snapshotView.tasks, { query, needsOnly, assignee: effectiveAssignee }, needsYouIds)

  // Controller ruling carried from Task 3/8, and re-aimed by M24 §2.2: this page already streams
  // the workspace this snapshot's `shellFacts` describes, so it publishes them to
  // `hooks/useShellFacts.ts` and the project header and the Tasks tab's badge read them there —
  // no second `EventSource` against `/api/w/:id/shell` (see `OverviewClient.tsx` for the exact
  // idiom this mirrors).
  useEffect((): void => {
    publishShellFacts(workspaceId, snapshotView.shellFacts)
  }, [workspaceId, snapshotView.shellFacts])
  // Retraction is its OWN effect, keyed only on the workspace: folding it into the cleanup of the
  // publish above would retract and re-publish on every snapshot, and the header would flip to
  // its fallback facts (this page's own SSR snapshot) between the two.
  useEffect((): (() => void) => () => publishShellFacts(workspaceId, null), [workspaceId])
  useEffect((): void => {
    publishStreamState(workspaceId, { connection, latencyMs })
  }, [workspaceId, connection, latencyMs])
  useEffect((): (() => void) => () => publishStreamState(workspaceId, null), [workspaceId])

  const { open: openPanel, close: closePanel, mode: panelMode } = useRightPanel()
  // M61 R9/Task 7: the panel's raw run/attempt/artifact details render only in developer mode
  // (`TaskDetailPanel`'s own `isDeveloper` prop) -- read here, once, rather than in the panel
  // itself, so every one of `TaskDetailPanel`'s many *direct*-render tests keeps seeing the
  // details section by default (the prop is optional there, defaulting to `true`) without every
  // one of those call sites needing a `<ModeProvider>` ancestor of its own.
  const { isDeveloper } = useMode()

  // What the URL names RIGHT NOW, readable from a closure created for an earlier subject. The
  // provider calls the PREVIOUS owner's clearer whenever a DIFFERENT subject takes the slot
  // (ruling T3-4) -- and that includes this page moving its own selection from one task to the
  // next, where the "previous owner" is this same page and its selection has already moved on.
  // Clearing then would cancel a selection one frame after a person made it, so the clearer only
  // fires while the URL still names the task it was created for.
  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedTask?.id ?? null

  /**
   * Ruling T5-1 -- the two refs that keep an UNMOUNTED page out of the slot.
   *
   * The provider outlives this page: it is the root layout's, and navigating from one section to
   * another unmounts the page under it. Without these, a task opened here left a clearer
   * behind that a LATER page's `open()` would run (ruling T3-4 fires the previous owner's clearer
   * whenever a different subject takes the slot) -- and that clearer calls `router.replace` with
   * the pathname this page was rendered on, bouncing a person off the page they just opened. The
   * panel itself also stayed on screen over a section that has nothing to do with it.
   *
   * `mounted` is re-armed on every mount rather than only cleared on unmount, because React's
   * StrictMode mounts, unmounts and remounts an effect in development.
   */
  const mounted = useRef(true)
  /** True while the slot holds THIS page's content. Set where `open()` is called, cleared the
   *  moment the clearer runs -- which is the provider telling us the slot has been taken or
   *  closed, whether by another owner, the slot's own `✕`, or the dock. */
  const owned = useRef(false)
  useEffect((): (() => void) => {
    mounted.current = true
    return (): void => {
      mounted.current = false
      // Hand the slot back on the way out, but only if it is still ours: another page may already
      // have taken it, and closing then would shut a panel this one does not own.
      if (owned.current) closePanel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount and unmount only. `closePanel`
    // is the provider's stable `useCallback`; depending on it would re-run this cleanup mid-life
    // and close a panel nobody asked to close.
  }, [])

  // M57 R8 / plan errata E4-E5: `?task=` is still the source of truth and still what a refresh
  // restores -- this only MIRRORS it into the shell's right panel, which is where the panel is
  // drawn now. The clearer handed to `open` is the same one the panel's own close used, so the
  // slot's `»`, the slot's `✕` and the panel's own control all clear the URL together.
  //
  // THE DEPENDENCY LIST IS `selectedTask?.id` AND NOTHING ELSE (scan finding 21): `snapshotView`
  // changes identity on every SSE frame, and an effect that re-`open()`s several times a second is an
  // effect that fights the person who just collapsed the panel. The fourth argument to `open` is
  // the content KEY, which is what lets the provider tell a re-assertion of the same task from a
  // new one. And it handles the CLEAR, because `?task=` can go away by navigation -- a link, a
  // Back -- rather than by the close button.
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
        workspaceGoalVersion={snapshotView.workspace.goalVersion}
        isDeveloper={isDeveloper}
        onClose={() => {
          setSelectedId(null)
          closePanel()
        }}
      />,
      () => {
        owned.current = false
        if (mounted.current && selectedIdRef.current === openedFor) setSelectedId(null)
      },
      openedFor,
    )
    // AFTER the call, not before: `open()` runs the OUTGOING clearer first, and that clearer is
    // this page's own when the selection simply moved -- setting the flag first would let it clear
    // the very ownership it is announcing.
    owned.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on the SELECTION
    // and not on the snapshot: see the note above. `panelMode` is read, not depended on, for the
    // same reason (it changes when this effect's own `close()` lands).
  }, [selectedTask?.id])

  return (
    // M61 R9/Task 7: the bare `flex min-h-0 flex-1 flex-col` frame -- `PageShell` is gone, so the
    // stale-data dim (M45 t3 idiom) rides on this same root now rather than a wrapper around it.
    <div className={`flex min-h-0 flex-1 flex-col ${error !== null ? 'opacity-60' : ''}`}>
      {snapshotView.workspace.haltedReason !== null && <HaltBanner reason={snapshotView.workspace.haltedReason} />}
      {/* M44 R3: the band three surfaces hand-rolled, each with its own class string, is
        * `ui/Alert` now. The one-line `role="alert"` refusal sentences under forms are NOT
        * alerts in this sense and stay exactly as they are (erratum E21). */}
      {error !== null && <Alert variant="notice">showing stale data: {error}</Alert>}
      <TaskFilters
        query={query}
        onQuery={setQuery}
        needsOnly={needsOnly}
        onNeedsOnly={() => setNeedsOnly((was) => !was)}
        needsCount={needsYouIds.size}
        assignees={assignees}
        assignee={effectiveAssignee}
        onAssignee={setAssignee}
        view={view}
        onView={setView}
      />
      {view === 'list' ? (
        <ScrollArea>
          <TaskList tasks={visible} onSelect={setSelectedId} />
        </ScrollArea>
      ) : (
        <ScrollArea axis="x" testId="board-scroll" className="px-[var(--gap-3)] pb-[var(--gap-3)]">
          <div className="grid h-full items-start gap-[var(--gap-2)] [grid-template-columns:repeat(5,minmax(220px,1fr))]">
            {BOARD_COLUMNS.map((column) => (
              <TaskColumn
                key={column}
                column={column}
                tasks={visible.filter((task) => COLUMN_FOR_STATUS[task.status] === column)}
                workspaceGoalVersion={snapshotView.workspace.goalVersion}
                onSelect={setSelectedId}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
