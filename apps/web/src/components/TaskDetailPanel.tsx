import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  NON_TERMINAL_RUN_STATUSES,
  costProvenanceOf,
  estimateCostUsd,
  type CostProvenance,
  type Manifest,
} from '@slave-of-ai/domain'
import { onUnauthorized } from '../lib/onUnauthorized'
import { errorMessage, sendControl } from '../lib/postControl'
import { sectionLine } from '../lib/runContextSummary'
import { formatUsd } from '../lib/realMoney'
import { priorityChip } from '../lib/taskColumns'
import type { TaskMemoriesView } from '../server/memory'
import type { TaskBoardItem, TaskRunSummary } from '../server/tasks'
import { taskStatusWord } from '../lib/tones'
import { TASK_STATUS_TEXT, goalStampText, isStale, whyOf } from './TaskCard'
import { Button } from './ui/Button'
import { Chip } from './ui/Chip'
import { DetailsGroup } from './ui/DetailsGroup'
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

/**
 * WHERE one run's figure came from, for a person (M51 R5, `docs/ia.md` rule 3).
 *
 * A `Record<CostProvenance, string>` so a fourth provenance is a build error here rather than a
 * card printing a raw member. The three words happen to read the same as the three keys -- they
 * are English, not identifiers -- and the table exists so that stays a choice rather than an
 * accident.
 */
const COST_PROVENANCE_WORD: Record<CostProvenance, string> = {
  reported: 'reported',
  estimated: 'estimated',
  unmeasured: 'unmeasured',
}

/**
 * The provenance word for ONE run, with the floor named while the run is still going (plan erratum
 * E4, fix round 1, review minor 3).
 *
 * A live run's tokens are what its stream has reported SO FAR -- the pump writes them on every
 * `usage` event and the terminal write replaces them -- so its estimate can only grow. `estimated
 * so far` says that in the one place the understatement is visible beside a total; a concluded run's
 * reading is final and says `estimated`. Nothing else moves: a reported figure is terminal-only by
 * construction, and an unmeasured run has no figure to be a floor of.
 */
function provenanceWordFor(run: TaskRunSummary): string {
  const provenance = costProvenanceOf(run)
  const live = (NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)
  return provenance === 'estimated' && live ? 'estimated so far' : COST_PROVENANCE_WORD[provenance]
}

/**
 * THE RULE, in one place (M51 R5): a reported figure wins, always.
 *
 * Every figure this panel prints goes through here -- the per-run rows, the Run group's one-line
 * total and the retried-work line -- so the panel cannot show one run an estimate and count it as a
 * reported figure a line later. `null` means nobody can name what this run cost, and `formatUsd`
 * prints that as `—` rather than as a zero somebody would believe.
 */
function costOf(run: TaskRunSummary): number | null {
  return (
    run.costUsd ??
    estimateCostUsd(
      run.model,
      run.tokensIn === null || run.tokensOut === null ? null : { input: run.tokensIn, output: run.tokensOut },
    )
  )
}

/**
 * A task, expanded (M45 R4).
 *
 * Above the fold, ungrouped, is the row's IDENTITY -- the ref, the priority, the goal stamp, the
 * stale badge, the title, the projected status word, the awaiting-integration marker, the
 * description, and the one line about why it is not moving. Everything else is folded into a
 * `DetailsGroup`, and a closed group renders nothing at all: the artifacts and the run contexts
 * are fetched on demand, and ten groups that all rendered would have issued every one of those
 * requests to show a person nothing.
 *
 * There is NO `model`, `profile` or `skills` group here, and that is deliberate rather than an
 * omission: a task has no model, no profile and no skill. Its RUN's worker has all three, and the
 * worker panel (`SlavePanel`) is where they live. Three empty groups would be three promises this
 * panel cannot keep.
 */
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
  const [memories, setMemories] = useState<TaskMemoriesView | null>(null)
  const [memoriesPending, setMemoriesPending] = useState(false)
  const [memoriesError, setMemoriesError] = useState<string | null>(null)

  // M23 B4 (controller ruling): `task.collectable` is computed server-side on the DTO
  // (`buildTasksSnapshot`) -- this panel never imports `TERMINAL` from `@slave-of-ai/domain`.
  const collectable = task.collectable

  // M45 R4: the one line the Runs group keeps once the per-run figures move into Cost. Runs whose
  // runtime reported nothing are counted apart rather than folded in as zero -- "we spent $0.42
  // and do not know about two more runs" is a different fact from "we spent $0.42".
  //
  // M51 R7 widened "measured" from "reported" to "reported or priceable": a run that reported no
  // figure but carries tokens and a model is not a hole, it is an estimate, and `costOf` below is
  // the one place that decision is made for the rows and both totals alike.
  const measuredRuns = task.runs.filter((run) => costOf(run) !== null)
  const totalCostUsd = measuredRuns.reduce((sum, run) => sum + (costOf(run) ?? 0), 0)
  const unmeasuredRuns = task.runs.length - measuredRuns.length
  // `retried work` is every IMPLEMENTATION run of this task but its newest -- `task.runs` is
  // newest-first (`server/tasks.ts`'s `orderBy: { startedAt: 'desc' }`). A review run is not a
  // retry of the implementation, and folding one in would make "what did getting this wrong cost"
  // answer a different question. There is no `SlaveRun.attempt` column and M51 adds none (decision
  // D20): the ordinal IS the order this list is already in.
  const implRuns = task.runs.filter((run) => run.kind === 'implementation')
  // NULL-PRESERVING, exactly as `run-total-cost` above is (fix round 1, review Critical 1): a task
  // whose earlier attempts all ran on a runtime that reports no cost and no tokens -- every retried
  // Cursor task, and every task whose runs predate M51 -- must not be told its retries cost
  // `$0.00`. That is the measurement this milestone exists to abolish, and the line's own rule (it
  // is hidden on a first attempt so a zero cannot read as one) would be broken one rung down.
  const retriedCosts = implRuns.slice(1).map(costOf)
  const retriedUsd = retriedCosts.every((cost) => cost === null)
    ? null
    : retriedCosts.reduce((sum: number, cost) => sum + (cost ?? 0), 0)
  const retriedUnmeasured = retriedCosts.filter((cost) => cost === null).length
  const why = whyOf(task)

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

  /**
   * Reads what this task's runs were GIVEN and what the task left behind (M49 R6, plan erratum E7).
   *
   * `openRunContext`'s shape exactly -- a plain `fetch`, because a 200 here is a `TaskMemoriesView`
   * rather than the `{ ok: true }` envelope `sendControl` decodes, and the same try/catch/finally so
   * the pending flag always clears. On demand, because the board POLLS this panel's task: carrying
   * every task's memories on every poll to fill a group nobody has opened is the cost this avoids.
   */
  const openMemories = async (): Promise<void> => {
    setMemoriesPending(true)
    setMemoriesError(null)
    try {
      const response = await fetch(`/api/w/${workspaceId}/tasks/${task.id}/memories`)
      if (response.status === 401) {
        onUnauthorized()
        return
      }
      const data: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        setMemoriesError(errorMessage(data, response.status))
        return
      }
      setMemories(data as TaskMemoriesView)
    } catch (cause) {
      setMemoriesError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setMemoriesPending(false)
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
            {/* M48 R2: which stage of the adopted runbook this task belongs to, beside the goal
              * stamp because both answer "where did this task come from". A stage is a LABEL --
              * `decide()` has never read it and it is not a dependency -- so it is a chip, not a
              * status.
              *
              * The runbook's own TITLE for the stage, with the key in `title=` (fix round 1,
              * Important 2): every other surface prints the words. A stage the adopted runbook
              * does not list -- one stamped by an earlier runbook, or invented by a plan -- has no
              * words to print, and `Unlisted stage` says exactly that instead of leaking the key
              * (`docs/ia.md` rule 3, M44 R5). */}
            {task.stage !== null && (
              <Chip testId="task-stage-chip" title={task.stage}>
                {task.stageTitle ?? 'Unlisted stage'}
              </Chip>
            )}
          </p>
          <h2 className="text-sm font-medium text-text-1">{task.title}</h2>
          {/* M45 R4: the domain's word, the board column's colour, and the raw status kept in
            * `title` where a person can hover it and a gate can read it. */}
          <span data-testid="detail-status" title={task.status} className={`text-xs ${TASK_STATUS_TEXT[task.status]}`}>
            {taskStatusWord(task.status, task.integratedAt !== null)}
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

      {why !== null && (
        // M45 R4: the SAME one line the card shows, for the same reason -- a person who opened this
        // panel because a card was not moving should not have to hunt for why in a group.
        <span
          data-testid="task-why"
          className={`text-xs ${task.status === 'cancelled' ? 'text-text-3' : 'text-tone-waiting'}`}
        >
          {why}
        </span>
      )}

      {/* M48 R7: the contract this task was handed, directly after the identity block and before
        * anything about a RUN -- what the work is for is what a person reads first, and it is the
        * only thing here that a reviewer judges the diff against. Open by default for the same
        * reason. Every list is omitted when it is empty: an empty heading is a promise the planner
        * did not make (`renderHandoff`'s own rule, which the prompt follows too). */}
      {task.handoff !== null && (
        <DetailsGroup group="handoff" title="Handoff" defaultOpen>
          <HandoffField label="Objective" value={task.handoff.objective} />
          <HandoffField label="Expected output" value={task.handoff.expectedOutput} />
          <HandoffList label="Acceptance criteria" items={task.handoff.acceptanceCriteria} />
          <HandoffList label="Known constraints" items={task.handoff.knownConstraints} />
          <HandoffList label="Evidence required" items={task.handoff.evidenceRequired} />
          <HandoffList label="Context references" items={task.handoff.contextReferences} />
        </DetailsGroup>
      )}

      {/* The one group this panel leads with: what its runs are doing right now. */}
      <DetailsGroup group="run" title="Run" defaultOpen>
        {/*
          * The attempt counter the scheduler reads (final wave M1). A fact about the WORK, so it
          * belongs beside the runs it describes rather than under Messages, which is for the
          * sentences a reviewer or a re-plan left behind. Above the run list and outside its empty
          * case: a task that has never run still has an attempt counter, and `no runs yet` is a
          * fact about the LIST alone.
          *
          * Its OTHER half, the branch, went to the Worktree group instead of coming here with it:
          * a branch name is a raw git value, R4 folds raw values behind a disclosure, and this
          * group leads OPEN. `gate:m45-project-experience` stage 6 measures exactly that -- the
          * task's uuid, its branch and its worktree path must be absent from the panel until a
          * person opens the group holding them -- so an always-open branch would be a regression
          * against R4 dressed up as a tidy-up. Messages keeps only the sentence either way, which
          * is what M1 asked for.
          */}
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
          <dt className="text-text-3">attempt</dt>
          <dd className="font-mono text-text-2">
            {task.attempt}/{task.maxAttempts}
          </dd>
        </dl>
        {task.runs.length === 0 ? (
          <p className="text-xs text-text-3">no runs yet</p>
        ) : (
          <>
            {/* One line, not a figure per row (M45 R4): the per-run money moved into the Cost
              * group, and a run row that carried it was two questions in one line. `—` when no run
              * reported spend at all, never `$0.00` -- that would claim a measurement nobody made
              * (spec Decision 6). */}
            <p data-testid="run-total-cost" className="font-mono text-[10.5px] text-text-3">
              {measuredRuns.length === 0 ? '—' : formatUsd(totalCostUsd)} across {task.runs.length} run
              {task.runs.length === 1 ? '' : 's'}
              {unmeasuredRuns > 0 && ` · ${unmeasuredRuns} unmeasured`}
            </p>
            <ul className="flex flex-col gap-2">
              {task.runs.map((run) => (
                <li key={run.id} data-testid="run-row" className="rounded border border-line p-2 text-xs text-text-2">
                  <div className="flex items-center justify-between">
                    {/* The same 8-char id prefix the Cost group's rows carry, so the two lists can
                      * be matched row for row by eye (fix round 1, minor 3). */}
                    <span>
                      <span className="font-mono text-[10px] text-text-faint">{run.id.slice(0, 8)}</span> {run.status}
                    </span>
                    {/* The ceiling this run is actually counting against (M51 R7, decision D16):
                      * the breaker's cap STANDS after its word de-escalates, so a constrained run
                      * that reads WORKING again still has a ceiling nothing else on the page would
                      * mention. Absent for every run nothing capped. */}
                    <span
                      data-testid="run-tool-calls"
                      className="font-mono"
                      {...(run.toolCallCap === null
                        ? {}
                        : { title: `the behavioural breaker capped this run at ${run.toolCallCap} tool calls` })}
                    >
                      {run.toolCallCap === null ? `${run.toolCalls} calls` : `${run.toolCalls}/${run.toolCallCap} calls`}
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
                </li>
              ))}
            </ul>
          </>
        )}
      </DetailsGroup>

      {/* What was SAID to and about this task: the sentence a reviewer or a re-plan left behind,
        * and nothing else (final wave M1 -- the attempt counter and the branch moved into the Run
        * group, where the work they describe is). A task nobody has said anything about says so,
        * rather than opening onto an empty list. */}
      <DetailsGroup group="messages" title="Messages">
        {task.lastRejectionReason === null ? (
          <p className="text-xs text-text-3">nothing said about this task yet</p>
        ) : (
          // One column, two meanings, named apart (M40 §6): `cancelTask` writes the CANCELLATION
          // reason into `lastRejectionReason`, and labelling that "rejection" would tell an
          // operator a reviewer turned the work down when nobody reviewed it at all. Muted for a
          // cancelled task, like its card: nothing here needs anybody.
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
            <dt className="text-text-3">{task.status === 'cancelled' ? 'cancelled' : 'rejection'}</dt>
            <dd
              data-testid={task.status === 'cancelled' ? 'detail-cancel-reason' : 'detail-rejection-reason'}
              className={task.status === 'cancelled' ? 'text-text-3' : 'text-tone-waiting'}
            >
              {task.lastRejectionReason}
            </dd>
          </dl>
        )}
      </DetailsGroup>

      {/* M37 §6, one group lower. Fetched on demand rather than with the snapshot: a prompt is the
        * whole text a model was given, and shipping one per run into every board poll would dwarf
        * the snapshot it rides in -- which is also why this group renders nothing until it is
        * opened, so arriving at the panel costs no request at all. */}
      <DetailsGroup group="context" title="Context sources">
        {task.runs.length === 0 ? (
          <p className="text-xs text-text-3">no runs yet, so nothing was assembled for one</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {task.runs.map((run) => (
              <li key={run.id} data-testid="run-context-row" className="flex flex-col gap-1 text-xs text-text-2">
                <button
                  type="button"
                  data-testid="run-context-open"
                  disabled={runContextPending}
                  onClick={() => void openRunContext(run.id)}
                  className="text-left text-[10.5px] text-text-3 underline decoration-dotted hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  What this run saw
                </button>
                {runContext !== null && runContext.runId === run.id && (
                  <div data-testid="run-context" className="flex flex-col gap-1">
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
      </DetailsGroup>

      {/* M49 R6: the knowledge this task's runs were GIVEN (off their recorded manifests, which is
        * the only record of it) and what it PRODUCED. Fetched on demand, like the context group
        * above it: a board poll must not carry every task's memories. */}
      <DetailsGroup group="memories" title="Knowledge">
        <button
          type="button"
          data-testid="task-memories-open"
          disabled={memoriesPending}
          onClick={() => void openMemories()}
          className="text-left text-[10.5px] text-text-3 underline decoration-dotted hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          What this task knew, and what it taught
        </button>
        {memories !== null && (
          <div className="flex flex-col gap-2">
            {/* Two lists, one under the other, each with its own caption (final review, Minor 5):
              * without them a reader cannot tell the knowledge a run was GIVEN from the knowledge
              * this task PRODUCED, and the two mean opposite things about the same task. */}
            <SectionLabel testId="task-memory-received-label">Received by its runs</SectionLabel>
            <ul data-testid="task-memory-received" className="flex flex-col gap-0.5">
              {memories.received.length === 0 ? (
                <li className="text-[10.5px] text-text-3">no run of this task was given anything yet</li>
              ) : (
                memories.received.map((row) => (
                  <li key={row.memory.id} data-testid="task-memory-row" className="text-[10.5px] text-text-2">
                    {/* The LABEL, with the key one hover away (`docs/ia.md` rule 3), and the
                      * memory's own words as JSX children (spec section 1). */}
                    <span title={row.memory.type}>{row.typeLabel}</span> · {row.memory.title}
                  </li>
                ))
              )}
            </ul>
            <SectionLabel testId="task-memory-produced-label">Produced by this task</SectionLabel>
            <ul data-testid="task-memory-produced" className="flex flex-col gap-0.5">
              {memories.produced.length === 0 ? (
                <li className="text-[10.5px] text-text-3">this task has not taught anybody anything yet</li>
              ) : (
                memories.produced.map((row) => (
                  <li key={row.memory.id} data-testid="task-memory-row" className="text-[10.5px] text-text-2">
                    <span title={row.memory.type}>{row.typeLabel}</span> · {row.memory.title} —{' '}
                    <span title={row.memory.status}>{row.statusLabel}</span>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
        {memoriesError !== null && (
          <span role="alert" data-testid="task-memories-error" className="text-xs text-tone-blocked">
            {memoriesError}
          </span>
        )}
      </DetailsGroup>

      {/* The verify/merge logs a run wrote (M23 C1-C3) -- the attempts that proved, or failed to
        * prove, that this task's work holds. Read on click, one at a time. */}
      <DetailsGroup group="verification" title="Verification attempts">
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
      </DetailsGroup>

      {/* What this task's runs actually spent, run by run. `—` for a run whose runtime reported no
        * spend (spec Decision 6) -- never `$0.00`, which claims a measurement nobody made. */}
      <DetailsGroup group="cost" title="Cost">
        {task.runs.length === 0 ? (
          <p className="text-xs text-text-3">no runs yet, so nothing has been spent</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs text-text-2">
            {task.runs.map((run) => (
              <li key={run.id} data-testid="run-cost-row" className="flex items-center justify-between font-mono text-[10.5px]">
                <span className="text-text-3">{run.id.slice(0, 8)}</span>
                {/* WHERE the figure came from, beside it (M51 R5): a reported figure and a priced
                  * guess are different kinds of number, and a column of dollars that does not say
                  * which is which invites a reader to add them up as if they were the same. */}
                <span className="flex items-baseline gap-1.5">
                  <span data-testid="run-cost-provenance" className="text-[9.5px] uppercase text-text-3">
                    {provenanceWordFor(run)}
                  </span>
                  <span>{formatUsd(costOf(run))}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {/* What getting this wrong already cost (M51 R7). Only on a task that has been tried more
          * than once -- on a first attempt the figure would be $0.00, which reads as a measurement
          * rather than as "there was no retry". */}
        {implRuns.length > 1 && (
          <p data-testid="task-cost-retried" className="text-xs text-tone-waiting">
            retried work {formatUsd(retriedUsd)}
            {/* The hole, counted apart rather than folded in as zeros -- `run-total-cost`'s own
              * idiom, for the same reason. Absent when nothing is priceable, because the em dash
              * on the left has already said it. */}
            {retriedUsd !== null && retriedUnmeasured > 0 && ` · ${retriedUnmeasured} unmeasured`}
          </p>
        )}
      </DetailsGroup>

      {/* M23 B4: the tree comes off disk, the branch stays. Only a terminal task whose runs still
        * have a worktree can be collected -- `task.collectable` is computed server-side on the DTO
        * (`buildTasksSnapshot`), so this panel never imports `TERMINAL` from the domain. */}
      <DetailsGroup group="worktree" title="Worktree">
        {/* WHICH branch the work lives on (final wave M1): the same kind of raw git value as the
          * paths below it, folded the same way, and beside the one button that talks about it
          * ("remove the tree, keep the branch"). `—` for a task no run has branched yet. */}
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
          <dt className="text-text-3">branch</dt>
          <dd data-testid="detail-branch" className="font-mono text-text-2">{task.branch ?? '—'}</dd>
        </dl>
        {/* WHICH tree, on disk, per run (M45 R4 fix round 1). `worktreePath` has been on the DTO
          * since M23 B4 and was rendered nowhere -- so `collectable` said a tree existed and
          * nothing on screen said where. A path is exactly the kind of raw value R4 folds rather
          * than hides: absent while the group is closed, and there in full once it is open. */}
        {task.runs.some((run) => run.worktreePath !== null) && (
          <ul className="flex flex-col gap-0.5">
            {task.runs
              .filter((run) => run.worktreePath !== null)
              .map((run) => (
                <li key={run.id} className="flex items-baseline gap-2">
                  <span className="font-mono text-[10px] text-text-faint">{run.id.slice(0, 8)}</span>
                  <span data-testid="worktree-path" className="font-mono text-[10px] text-text-3">{run.worktreePath}</span>
                </li>
              ))}
          </ul>
        )}
        {!collectable ? (
          <p className="text-xs text-text-3">nothing to collect — no run of this task has a tree left on disk</p>
        ) : (
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
      </DetailsGroup>

      {/* A task has no event feed of its own, and inventing one here would be a second reader of the
        * stream the Activity page already owns. `?tasks=` is `lib/activityFilters.ts`'s own
        * parameter name for a task filter, so this link lands on that page already narrowed. */}
      <DetailsGroup group="events" title="Events">
        <Link
          data-testid="task-events-link"
          href={`/w/${workspaceId}/activity?tasks=${task.id}`}
          className="text-xs text-text-3 underline decoration-dotted hover:text-text-1"
        >
          every event for this task →
        </Link>
      </DetailsGroup>
    </aside>
  )
}

/** One required field of a handoff: a caption and the planner's sentence, interpolated as children
 *  so another party's text is characters on the page and never elements (spec §1). */
function HandoffField({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div data-testid="handoff-field" data-field={label} className="flex flex-col gap-0.5">
      <SectionLabel>{label}</SectionLabel>
      <span className="text-xs text-text-1">{value}</span>
    </div>
  )
}

/** One of a handoff's four lists, or NOTHING when it is empty -- an empty heading reads as a field
 *  somebody left blank, and a planner that wrote no constraints did not leave one blank. */
function HandoffList({ label, items }: { readonly label: string; readonly items: readonly string[] }): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div data-testid="handoff-field" data-field={label} className="flex flex-col gap-0.5">
      <SectionLabel>{label}</SectionLabel>
      <ul className="flex list-disc flex-col gap-0.5 pl-4">
        {/* Keyed on the POSITION as well as the text (M48 final review, Minor 5): a handoff list is
          * a planner's prose, and nothing stops two acceptance criteria reading the same. React
          * drops the duplicate and warns; the list is static, so the index is stable. */}
        {items.map((item, index) => (
          <li key={`${String(index)}-${item}`} className="text-xs text-text-2">
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}
