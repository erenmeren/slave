'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { postControl } from '../../lib/postControl'
import { FieldLabel, PrimaryButton, TextField } from '../ui/FormControls'
import { Panel } from '../ui/Panel'

/**
 * The Settings tab's goal panel (M24 §4, moved off the Overview card of the same shape): a
 * set-once form until the workspace has a goal, then a read-only display of it with an `edit`
 * button back into the form. The Overview card never offered that button — a goal was something
 * a workspace was GIVEN once, not something an operator went back and changed — but the Settings
 * tab is precisely where that changes, so this panel adds the one control the card withheld.
 *
 * `router.refresh()` after a successful post (mirrors `RuntimePanel`'s `submit`) is this page's
 * only path back to a new value: there is no live stream feeding this tab, only the next server
 * render.
 */
export function GoalPanel({
  workspaceId,
  goal,
}: {
  readonly workspaceId: string
  readonly goal: string | null
}): React.JSX.Element {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const result = await postControl(`/api/w/${workspaceId}/goal`, { goal: draft })
    setPending(false)
    if (result.ok) {
      setEditing(false)
      router.refresh()
    } else {
      setErrorText(result.error)
    }
  }

  if (goal !== null && !editing) {
    return (
      <Panel title="Goal">
        <div className="flex items-center justify-between gap-2">
          <p data-testid="workspace-goal" className="text-sm text-text-1">
            {goal}
          </p>
          <button
            type="button"
            data-testid="goal-edit"
            // Seeds the draft from the CURRENT goal, not the empty string the unset form starts
            // from -- an edit is a change to what is there, not a second "set once" prompt.
            onClick={() => {
              setDraft(goal)
              setEditing(true)
            }}
            className="shrink-0 font-mono text-[10px] text-text-3 underline decoration-dotted underline-offset-2 hover:text-text-1"
          >
            edit
          </button>
        </div>
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
      {errorText !== null && (
        <span role="alert" data-testid="goal-error" className="text-xs text-tone-blocked">
          {errorText}
        </span>
      )}
    </Panel>
  )
}
