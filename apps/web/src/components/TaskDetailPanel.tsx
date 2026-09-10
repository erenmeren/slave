import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Manifest } from '@slave-of-ai/domain'
import { onUnauthorized } from '../lib/onUnauthorized'
import { errorMessage, sendControl } from '../lib/postControl'
import { sectionLine } from '../lib/runContextSummary'
import { priorityChip } from '../lib/taskColumns'
import type { TaskBoardItem } from '../server/tasks'
import { TASK_STATUS_TEXT, goalStampText, isStale } from './TaskCard'
import { Button } from './ui/Button'
import { SectionLabel } from './ui/SectionLabel'
import { TONE_TEXT } from './ui/StatusPill'

interface OpenArtifact {
  readonly id: string
  readonly text: string
  readonly truncated: boolean
}

/** The context of ONE run, opened at a time (M37 §6) -- `runId` is what keys it to the row it was
 *  opened from, so opening a second run's context replaces the first rather than stacking. */
interface OpenRunContext {
  readonly runId: string
  readonly prompt: string
  readonly manifest: Manifest
}

export function TaskDetailPanel({
  task,
  workspaceId,
  workspaceGoalVersion,
  onClose,
}: {
  readonly task: TaskBoardItem
  readonly workspaceId: string
  /** The goal version the PROJECT is on (M40 §6) -- the other half of the stale badge. */
  readonly workspaceGoalVersion: number
  readonly onClose: () => void
}): React.JSX.Element {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [collectError, setCollectError] = useState<string | null>(null)
  const [artifact, setArtifact] = useState<OpenArtifact | null>(null)
  const [artifactPending, setArtifactPending] = useState(false)
  const [artifactError, setArtifactError] = useState<string | null>(null)
  const [runContext, setRunContext] = useState<OpenRunContext | null>(null)
  const [runContextPending, setRunContextPending] = useState(false)
  const [runContextError, setRunContextError] = useState<string | null>(null)

  // M23 B4 (controller ruling): `task.collectable` is computed server-side on the DTO
  // (`buildTasksSnapshot`) -- this panel never imports `TERMINAL` from `@slave-of-ai/domain`.
  const collectable = task.collectable

  const collect = async (): Promise<void> => {
    setPending(true)
    // A retry starts clean: a prior refusal's text must not linger through a second attempt that
    // then also fails on the same DELETE, or that then succeeds and never gets a chance to clear
    // it before `router.refresh()` (controller ruling: `DangerZone.tsx`'s `reseed()` clears its
    // own error the same way, at the top of its handler, not just on success).
    setCollectError(null)
    const error = await sendControl(`/api/w/${workspaceId}/tasks/${task.id}/worktree`, { method: 'DELETE' })
    setPending(false)
    setConfirming(false)
    if (error === null) router.refresh()
    else setCollectError(error)
  }

  // Reads one artifact's log text (M23 C2/C3). Not `sendControl`: a 200 body here is the raw log
  // text, not `{ ok: true }`, so this dials `fetch` directly -- same try/catch/finally shape as
  // `ProjectsPanel.submit` (Task 3), so `artifactPending` always clears even on a thrown fetch.
  const openArtifact = async (artifactId: string): Promise<void> => {
    setArtifactPending(true)
    setArtifactError(null)
    try {
      const response = await fetch(`/api/w/${workspaceId}/tasks/${task.id}/artifacts/${artifactId}`)
      if (response.status === 401) {
        onUnauthorized()
        return
      }
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => null)
        setArtifactError(errorMessage(data, response.status))
        return
      }
      const text = await response.text()
      setArtifact({ id: artifactId, text, truncated: response.headers.get('x-artifact-truncated') === '1' })
    } catch (cause) {
      setArtifactError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setArtifactPending(false)
    }
  }

  /**
   * Reads what one run was told (M37 §6). Same shape as `openArtifact` above -- a plain `fetch`,
   * because a 200 here is `{ prompt, manifest }` rather than the `{ ok: true }` envelope
   * `sendControl` decodes, and the same try/catch/finally so the pending flag always clears.
   *
   * The body is taken as the route's own shape rather than re-validated: the route parses the
   * stored `Json` with `runContextManifestSchema` before serving it and refuses a row it cannot
   * read, so a second parse here would only pull the domain's zod schemas into the browser bundle
   * to re-answer a question already answered server-side.
   */
  const openRunContext = async (runId: string): Promise<void> => {
    setRunContextPending(true)
    setRunContextError(null)
    try {
      const response = await fetch(`/api/w/${workspaceId}/runs/${runId}/context`)
      if (response.status === 401) {
        onUnauthorized()
        return
      }
      const data: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        // A run that never started has no row (spec §4: the row is written BEFORE the spawn), and
        // the route's own sentence for that is better than anything this panel could invent.
        setRunContextError(errorMessage(data, response.status))
        return
      }
      setRunContext({ runId, ...(data as { prompt: string; manifest: Manifest }) })
    } catch (cause) {
      setRunContextError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRunContextPending(false)
    }
  }

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
          <p className="flex items-baseline gap-[7px] font-mono text-[9.5px] font-medium">
            <span data-testid="task-panel-ref" className="text-text-3">TASK-{task.id.slice(0, 8)}</span>
            <span className="text-text-faint">·</span>
            <span data-testid="task-panel-priority" className={TONE_TEXT[priorityChip(task.priority).tone]}>{priorityChip(task.priority).label}</span>
            <span className="text-text-faint">·</span>
            {/* Which requirement produced this task (M40 §1) -- "unstamped" for one a human made,
              * which was derived from no goal version at all. */}
            <span data-testid="task-panel-goal-version" className="text-text-3">{goalStampText(task.goalVersion)}</span>
            {isStale(task.goalVersion, workspaceGoalVersion) && (
              <span data-testid="task-panel-stale" className="uppercase tracking-wide text-tone-waiting">stale</span>
            )}
          </p>
          <h2 className="text-sm font-medium text-text-1">{task.title}</h2>
          <span data-testid="detail-status" className={`text-xs ${TASK_STATUS_TEXT[task.status]}`}>
            {task.status}
          </span>
          {/* M35 t2: `done` means reviewed, not necessarily on the base branch yet -- the
              `!autoMerge` path leaves `integratedAt` null on purpose (branch/worktree left for a
              human). The smallest honest marker for that: no redesign, just a line the same size
              and place `lastRejectionReason` already uses below. */}
          {task.status === 'done' && task.integratedAt === null && (
            <span data-testid="awaiting-integration" className="block text-xs text-tone-waiting">
              awaiting integration
            </span>
          )}
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
          // One column, two meanings, named apart (M40 §6): `cancelTask` writes the CANCELLATION
          // reason into `lastRejectionReason`, and labelling that "rejection" would tell an
          // operator a reviewer turned the work down when nobody reviewed it at all. Muted for a
          // cancelled task, like its card: nothing here needs anybody.
          <>
            <dt className="text-text-3">{task.status === 'cancelled' ? 'cancelled' : 'rejection'}</dt>
            <dd
              data-testid={task.status === 'cancelled' ? 'detail-cancel-reason' : 'detail-rejection-reason'}
              className={task.status === 'cancelled' ? 'text-text-3' : 'text-tone-waiting'}
            >
              {task.lastRejectionReason}
            </dd>
          </>
        )}
      </dl>

      {collectable && (
        <div className="flex items-center gap-2">
          {!confirming ? (
            <Button variant="ghost" size="sm" data-testid="collect-worktree" onClick={() => setConfirming(true)}>
              Collect worktree
            </Button>
          ) : (
            <>
              <Button variant="danger" size="sm" data-testid="collect-worktree-confirm" disabled={pending} onClick={() => void collect()}>
                remove the tree, keep the branch
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>cancel</Button>
            </>
          )}
          {collectError !== null && (
            <span role="alert" data-testid="collect-worktree-error" className="text-xs text-tone-blocked">
              {collectError}
            </span>
          )}
        </div>
      )}

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
                    {/* M36 t3: a run waiting for another slave's answer is `paused`, but "paused at
                      * step N" reads as a pause a human is being asked to end. Name what it is
                      * actually waiting on instead. */}
                    {run.waitingFor === null
                      ? `paused at step ${run.checkpoint.pausedAtStep}`
                      : `waiting for ${run.waitingFor} at step ${run.checkpoint.pausedAtStep}`}{' '}
                    · session {run.checkpoint.sessionId} · {run.checkpoint.dirtyFileCount} dirty files
                  </div>
                )}
                {run.checkpoint !== null && run.checkpoint.deniedDuringPause.length > 0 && (
                  // `summary` is always `null` today (see `TaskRunSummary.checkpoint`'s own
                  // comment: no join key exists), so this always renders the id-prefix fallback --
                  // not a bug, a fact of the data. Same 8-char id-prefix convention as
                  // `TaskCard`/`SlaveCard`'s `TASK-{id.slice(0, 8)}`; unlike a task's random UUID
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
                {/* M37 §6. Fetched on demand rather than with the snapshot: a prompt is the whole
                  * text a model was given, and shipping one per run into every board poll would
                  * dwarf the snapshot it rides in. */}
                <button
                  type="button"
                  data-testid="run-context-open"
                  disabled={runContextPending}
                  onClick={() => void openRunContext(run.id)}
                  className="mt-1 text-left text-[10.5px] text-text-3 underline decoration-dotted hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  What this run saw
                </button>
                {runContext !== null && runContext.runId === run.id && (
                  <div data-testid="run-context" className="mt-1 flex flex-col gap-1">
                    <ul className="flex flex-col gap-0.5">
                      {runContext.manifest.sections.map((source, index) => {
                        const line = sectionLine(source)
                        return (
                          // The index belongs in the key: the manifest is an ORDERED record and a
                          // kind can legitimately repeat, so `kind` alone is not a stable identity.
                          <li key={`${line.kind}-${String(index)}`} data-testid="run-context-section" className="text-[10.5px]">
                            <span data-testid={`run-context-section-${String(index)}`}>
                              <span className="font-mono text-text-3">{line.kind}</span> {line.detail}
                            </span>
                            {line.missing.length > 0 && (
                              // The one thing on this list an operator may have to act on: a skill
                              // the worker was assigned that its run never got (spec §4 -- the run
                              // proceeds without it).
                              <span data-testid="run-context-missing" className="text-tone-blocked">
                                {' '}
                                · missing: {line.missing.join(', ')}
                              </span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                    <details data-testid="run-context-prompt">
                      <summary className="cursor-pointer text-[10.5px] text-text-3">the prompt, in full</summary>
                      {/* A `<pre>`, so another party's text is characters and never elements
                        * (spec §1: another party's text is data). */}
                      <pre
                        data-testid="run-context-prompt-body"
                        className="mt-1 max-h-64 overflow-auto rounded border border-line bg-bg-2 p-2 font-mono text-[10px] text-text-2"
                      >
                        {runContext.prompt}
                      </pre>
                    </details>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {runContextError !== null && (
          <span role="alert" data-testid="run-context-error" className="text-xs text-tone-blocked">
            {runContextError}
          </span>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <SectionLabel>Artifacts</SectionLabel>
        {task.artifacts.length === 0 ? (
          <p className="text-xs text-text-3">no artifacts yet</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {task.artifacts.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  data-testid="artifact-row"
                  disabled={artifactPending}
                  onClick={() => void openArtifact(row.id)}
                  className="w-full rounded border border-line p-2 text-left text-xs text-text-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="flex items-center justify-between">
                    <span>{row.label}</span>
                    <span className="font-mono">{row.createdAt.slice(11, 19)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        {artifactError !== null && (
          <span role="alert" data-testid="artifact-error" className="text-xs text-tone-blocked">
            {artifactError}
          </span>
        )}
        {artifact !== null && (
          <>
            <pre
              data-testid="artifact-body"
              className="max-h-64 overflow-auto rounded border border-line bg-bg-2 p-2 font-mono text-[10px] text-text-2"
            >
              {artifact.text}
            </pre>
            {artifact.truncated && (
              <span data-testid="artifact-truncated" className="text-xs text-text-3">
                truncated to the last 256 KiB
              </span>
            )}
          </>
        )}
      </section>
    </aside>
  )
}
