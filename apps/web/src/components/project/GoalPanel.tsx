'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { errorMessage } from '../../lib/postControl'
import { onUnauthorized } from '../../lib/onUnauthorized'
import { FieldLabel, PrimaryButton, TextField } from '../ui/FormControls'
import { Panel } from '../ui/Panel'
import { GoalHistory } from './GoalHistory'

/** What one save came back with: the version it wrote, or the refusal it was answered with. The
 *  `kind` is what tells `goal_unchanged` -- a person pressing save on the words already there --
 *  from a refusal that is actually a failure. */
type SaveOutcome =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly kind: string | null; readonly error: string }

/**
 * The Settings tab's goal panel (M24 §4, moved off the Overview card of the same shape): a
 * set-once form until the workspace has a goal, then a read-only display of it with an `edit`
 * button back into the form. The Overview card never offered that button — a goal was something
 * a workspace was GIVEN once, not something an operator went back and changed — but the Settings
 * tab is precisely where that changes, so this panel adds the one control the card withheld.
 *
 * M40 §6 made the goal a VERSIONED requirement, and this panel is where an operator meets that:
 * the version number beside the goal, the history behind it ({@link GoalHistory}), the sentence
 * saying what a save on a non-empty board sets in motion, and the one refusal that is not a
 * failure.
 *
 * `router.refresh()` after a successful post (mirrors `RuntimePanel`'s `submit`) is this page's
 * only path back to a new value: there is no live stream feeding this tab, only the next server
 * render.
 *
 * A plain `fetch` rather than `postControl`: both outcomes of a save carry something this panel
 * has to render (the version it wrote; the refusal's KIND), and `postControl` decodes a response
 * down to `ok` plus a message. `TaskDetailPanel`'s artifact and run-context reads dial `fetch`
 * directly for the same reason, with the same try/catch/finally so `pending` always clears.
 */
export function GoalPanel({
  workspaceId,
  goal,
  goalVersion,
  boardTaskCount,
  halted,
}: {
  readonly workspaceId: string
  readonly goal: string | null
  /** The version `goal` is (M40 §1). 0 means no version was recorded -- a project with no goal, or
   *  one whose column was written before M40; the panel then shows no `v` chip at all rather than
   *  naming a `GoalVersion` row that does not exist. */
  readonly goalVersion: number
  /** How many tasks the project has, at all. The re-plan trigger's own question (`dispatchPlanning`
   *  check 2): an EMPTY board takes the first-plan path, where a goal edit starts a plan rather
   *  than a re-plan, so the "a re-plan will run" sentence would be a promise the tick does not
   *  keep. */
  readonly boardTaskCount: number
  /**
   * Whether this project carries a recorded halt (`Workspace.haltedReason`), from the snapshot this
   * tab already reads for its own halt banner.
   *
   * `setGoal` is NOT refused on a halted workspace -- an operator revising the requirement while
   * everything is stopped is exactly what a halt is for -- but `tick` returns before
   * `dispatchPlanning` while one stands, so "a re-plan will run on the next tick" would be a
   * promise nothing is going to keep (fix round 1). An ARCHIVED project needs no flag of its own:
   * the route refuses the write before the verb runs, so there is no successful save to say
   * anything after.
   */
  readonly halted: boolean
}): React.JSX.Element {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  /** The version a save refused as unchanged, so the panel can say which one is still standing.
   *  Cleared by the next attempt, like the error band beside it. */
  const [unchangedAt, setUnchangedAt] = useState<number | null>(null)
  /** Set only by a save that actually moved the version, and only when the board is non-empty. */
  const [replanComing, setReplanComing] = useState(false)

  const save = async (): Promise<SaveOutcome> => {
    try {
      const response = await fetch(`/api/w/${workspaceId}/goal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: draft }),
      })
      if (response.status === 401) {
        onUnauthorized()
        return { ok: false, kind: null, error: 'your session has expired' }
      }
      const data: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const kind = typeof (data as { kind?: unknown } | null)?.kind === 'string' ? (data as { kind: string }).kind : null
        return { ok: false, kind, error: errorMessage(data, response.status) }
      }
      return { ok: true, version: (data as { version: number }).version }
    } catch (cause) {
      return { ok: false, kind: null, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  const submit = async (): Promise<void> => {
    setPending(true)
    // A retry starts clean: neither the last refusal nor the last "no change" may linger through an
    // attempt that then succeeds.
    setErrorText(null)
    setUnchangedAt(null)
    setReplanComing(false)
    const outcome = await save()
    setPending(false)
    if (outcome.ok) {
      setEditing(false)
      // The M40 §1 trigger, stated to the operator rather than left for them to discover: a goal
      // that moves past a board that already exists gets a delta re-plan on the next tick. Not a
      // promise about the OUTCOME -- the tick still needs a free manager and its retries -- which
      // is why the sentence says a re-plan will run, and nothing about what it will decide.
      setReplanComing(boardTaskCount > 0)
      router.refresh()
      return
    }
    // The one refusal that is not a failure (M40 erratum E5): the words are already the goal, so
    // nothing was recorded and nothing needed to be. A red band here would tell an operator they
    // broke something by saving what was already true.
    if (outcome.kind === 'goal_unchanged') {
      setEditing(false)
      setUnchangedAt(goalVersion)
      return
    }
    setErrorText(outcome.error)
  }

  /** The two lines a save leaves behind, shown in either mode -- an operator who saved and then
   *  pressed `edit` again must not lose the answer to what their save did. */
  const outcomeLines = (
    <>
      {unchangedAt !== null && (
        <span data-testid="goal-unchanged" className="text-xs text-text-3">
          no change — still v{unchangedAt}
        </span>
      )}
      {replanComing &&
        (halted ? (
          <span data-testid="goal-replan-halted" className="text-xs text-tone-waiting">
            the workspace is halted — re-plan waits for a resume
          </span>
        ) : (
          <span data-testid="goal-replan-note" className="text-xs text-tone-planning">
            a re-plan will run on the next tick
          </span>
        ))}
      {errorText !== null && (
        <span role="alert" data-testid="goal-error" className="text-xs text-tone-blocked">
          {errorText}
        </span>
      )}
    </>
  )

  if (goal !== null && !editing) {
    return (
      <Panel title="Goal">
        <div className="flex items-center justify-between gap-2">
          <p data-testid="workspace-goal" className="text-sm text-text-1">
            {goal}
          </p>
          <span className="flex shrink-0 items-baseline gap-2">
            {goalVersion > 0 && (
              <span data-testid="goal-version" className="font-mono text-[10px] text-text-3">
                v{goalVersion}
              </span>
            )}
            <button
              type="button"
              data-testid="goal-edit"
              // Seeds the draft from the CURRENT goal, not the empty string the unset form starts
              // from -- an edit is a change to what is there, not a second "set once" prompt.
              onClick={() => {
                setDraft(goal)
                setEditing(true)
              }}
              className="font-mono text-[10px] text-text-3 underline decoration-dotted underline-offset-2 hover:text-text-1"
            >
              edit
            </button>
          </span>
        </div>
        {outcomeLines}
        <GoalHistory workspaceId={workspaceId} />
      </Panel>
    )
  }

  return (
    <Panel title="Goal">
      {goal === null && (
        // The handoff's caption for an unset goal (design README §3a.1). Not an error and not a
        // placeholder standing in for a value: it names the state the workspace is actually in --
        // nothing has been asked of it yet, so nothing is planning. Shown only for a genuinely
        // unset goal, never while editing an existing one.
        <p data-testid="goal-waiting">
          <FieldLabel>waiting for a goal</FieldLabel>
        </p>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <TextField
          inputProps={
            {
              'data-testid': 'goal-input',
              'aria-label': 'workspace goal',
              value: draft,
              onChange: (event) => setDraft(event.target.value),
              disabled: pending,
              className: 'flex-1',
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
        <PrimaryButton type="submit" data-testid="goal-submit" disabled={pending}>
          set goal
        </PrimaryButton>
      </form>
      {outcomeLines}
      {/* Only once there is a history to read: a project whose goal has never been set has no
        * version, and a toggle that can only ever open an empty list is a control that lies. */}
      {goal !== null && <GoalHistory workspaceId={workspaceId} />}
    </Panel>
  )
}
