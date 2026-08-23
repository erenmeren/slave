'use client'

import { useState } from 'react'

/** Pulls a 409 refusal's `{ error }` text, falling back to something nameable for any other
 *  non-2xx or malformed body — same helper as `AgentPanel.tsx`'s `errorMessage`, copied rather
 *  than imported (the house pattern here is a small local copy, not a shared control-plane
 *  module). */
function errorMessage(data: unknown, status: number): string {
  if (data !== null && typeof data === 'object') {
    const value = (data as { error?: unknown }).error
    if (typeof value === 'string') return value
  }
  return `request failed (${status})`
}

/** Bare `fetch(url, { method: 'POST', ... })` — the `postControl` idiom from `AgentPanel.tsx`. */
async function postControl(url: string, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.ok) return { ok: true }
    const data: unknown = await response.json().catch(() => null)
    return { ok: false, error: errorMessage(data, response.status) }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Overview's goal card: a set-once form until the workspace has a goal, then a read-only display
 * of it. No optimistic UI on success — the snapshot refetch (upstream of this component's `goal`
 * prop) is what flips the card from form to read-only, the standing rule this whole page follows.
 */
export function GoalCard({
  workspaceId,
  goal,
}: {
  readonly workspaceId: string
  readonly goal: string | null
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
      <section className="flex flex-col gap-1 rounded border border-line bg-bg-1 p-3">
        <h3 className="text-xs uppercase tracking-wide text-text-3">Goal</h3>
        <p data-testid="workspace-goal" className="text-sm text-text-1">
          {goal}
        </p>
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-2 rounded border border-line bg-bg-1 p-3">
      <h3 className="text-xs uppercase tracking-wide text-text-3">Goal</h3>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <input
          data-testid="goal-input"
          aria-label="workspace goal"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={pending}
          className="flex-1 rounded border border-line bg-bg-0 px-2 py-1 text-sm text-text-1"
        />
        <button
          type="submit"
          data-testid="goal-submit"
          disabled={pending}
          className="rounded border border-line px-2 py-1 text-xs text-text-1 disabled:text-text-3"
        >
          set goal
        </button>
      </form>
      {errorText !== null && (
        <span role="alert" data-testid="goal-error" className="text-xs text-status-danger">
          {errorText}
        </span>
      )}
    </section>
  )
}
