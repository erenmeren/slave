'use client'

import { useState } from 'react'
import { postControl } from '../lib/postControl'
import { FieldLabel, PrimaryButton, TextField } from './ui/FormControls'
import { Panel } from './ui/Panel'

/**
 * Overview's goal card: a set-once form until the workspace has a goal, then a read-only display
 * of it. No optimistic UI on success — the snapshot refetch (upstream of this component's `goal`
 * prop) is what flips the card from form to read-only, the standing rule this whole page follows.
 */
export function GoalCard({
  workspaceId,
  goal,
  suggestions,
}: {
  readonly workspaceId: string
  readonly goal: string | null
  /**
   * The last three DISTINCT goals this workspace has been set, newest first (`OverviewSnapshot.
   * goalSuggestions`) -- real history, never invented copy. Empty for a workspace that has never
   * had one, which draws no chip row at all rather than a row of placeholders. Required rather
   * than optional: a caller that forgot it would silently render a form that never offers the
   * shortcut, and nothing would fail.
   */
  readonly suggestions: readonly string[]
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const result = await postControl(`/api/w/${workspaceId}/goal`, { goal: draft })
    setPending(false)
    if (!result.ok) setErrorText(result.error)
  }

  if (goal !== null) {
    return (
      <Panel title="Goal">
        <p data-testid="workspace-goal" className="text-sm text-text-1">
          {goal}
        </p>
      </Panel>
    )
  }

  return (
    <Panel title="Goal">
      {/* The handoff's caption for an unset goal (design README §3a.1). Not an error and not a
        * placeholder standing in for a value: it names the state the workspace is actually in --
        * nothing has been asked of it yet, so nothing is planning. */}
      <p data-testid="goal-waiting">
        <FieldLabel>waiting for a goal</FieldLabel>
      </p>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              data-testid="goal-suggestion"
              // Fills the input; does NOT submit. A chip is a shortcut into the form, and a goal
              // set by a single click on last week's text is one nobody read before sending.
              onClick={() => setDraft(suggestion)}
              className="rounded-chip border border-line bg-bg-2 px-2 py-0.5 text-xs text-text-2 transition-colors hover:border-white/20 hover:text-text-1"
            >
              {suggestion}
            </button>
          ))}
        </div>
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
