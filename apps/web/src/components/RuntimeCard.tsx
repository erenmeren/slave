'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ProviderKind } from '@ai-team-os/control'
import { ProviderSelect } from './ProviderSelect'
import { FieldLabel, INPUT_SHELL, PrimaryButton, TextField } from './ui/FormControls'
import { Panel } from './ui/Panel'

/** Pulls a 409 refusal's `{ error }` text -- the same local helper `GoalCard.tsx` carries. */
function errorMessage(data: unknown, status: number): string {
  if (data !== null && typeof data === 'object') {
    const value = (data as { error?: unknown }).error
    if (typeof value === 'string') return value
  }
  return `request failed (${status})`
}

/** `GoalCard.tsx`'s `postControl` idiom with the verb Task 12's two routes use. */
async function putControl(url: string, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, {
      method: 'PUT',
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
 * The workspace's runtime and its spend ceiling, beside `GoalCard` on `/w/[workspaceId]`.
 *
 * No optimistic state: every control on this page follows M11's rule that the server's next
 * snapshot is what changes what is rendered. What actually delivers that snapshot here is the SSE
 * stream, not the router (fix round 1, Important finding 2): `setWorkspaceProvider`/`setWorkspaceBudget`
 * append `workspace.settings_changed`, `useWorkspaceStream` treats every event as a wake-up and
 * debounces a refetch of `/api/w/[workspaceId]/overview`, and the new props arrive down through
 * `OverviewClient`. A Next server re-render does NOT repaint this card, because `initial` is only
 * the `useState` seed of that hook's snapshot (`useWorkspaceStream.ts:36`) and is ignored on every
 * render after the first. `router.refresh()` is kept after each mutation anyway: it is the house
 * idiom for a mutation on this page, it costs one server render, and it is the only path left for
 * a client whose EventSource is down -- but it is not what the operator sees working.
 *
 * A 409 keeps whatever the operator typed, so a refused write is correctable rather than lost.
 *
 * `costBlindBudgeted` arrives as a plain boolean because deriving it needs `capabilitiesOf`, which
 * lives behind a package this client bundle must not evaluate. It describes the SAVED pair, not
 * the pending selection -- the point is to tell an operator what their current configuration will
 * do at dispatch, and the pending selection has not configured anything yet.
 */
export function RuntimeCard({
  workspaceId,
  provider,
  budgetUsd,
  costBlindBudgeted,
}: {
  readonly workspaceId: string
  readonly provider: ProviderKind | null
  readonly budgetUsd: number | null
  readonly costBlindBudgeted: boolean
}): React.JSX.Element {
  const router = useRouter()
  const [draftProvider, setDraftProvider] = useState<ProviderKind | ''>(provider ?? '')
  const [draftBudget, setDraftBudget] = useState(budgetUsd === null ? '' : String(budgetUsd))
  const [unbudgeted, setUnbudgeted] = useState(budgetUsd === null)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const submit = async (url: string, body: Record<string, unknown>): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const result = await putControl(url, body)
    setPending(false)
    if (result.ok) {
      router.refresh()
    } else {
      setErrorText(result.error)
    }
  }

  return (
    <Panel title="Runtime">
      <div className="flex flex-col gap-2">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            // `''` is the "(none)" option and means an explicit `null` -- "this workspace has no
            // configured default" -- which the route distinguishes from an omitted key.
            void submit(`/api/w/${workspaceId}/provider`, { provider: draftProvider === '' ? null : draftProvider })
          }}
        >
          <label className="flex flex-col gap-1">
            <FieldLabel>provider</FieldLabel>
            <ProviderSelect
              ariaLabel="workspace provider"
              testId="runtime-provider"
              value={draftProvider}
              onChange={setDraftProvider}
              disabled={pending}
              placeholder="(none)"
              className={INPUT_SHELL}
            />
          </label>
          <PrimaryButton type="submit" data-testid="runtime-provider-submit" disabled={pending}>
            set runtime
          </PrimaryButton>
        </form>

        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            // The two states stay apart in both directions: the checkbox -- and ONLY the checkbox
            // -- means `null`, and a typed `0` stays the number `0`, a real ceiling of "may spend
            // nothing" rather than "not budgeted". `required` is what keeps an emptied field from
            // taking the third road: `Number('')` is `0`, and submitting that would turn a cleared
            // input into the strictest budget there is without the operator ever typing a figure.
            void submit(`/api/w/${workspaceId}/budget`, {
              budgetUsd: unbudgeted ? null : Number(draftBudget),
            })
          }}
        >
          <TextField
            label="budget (usd)"
            inputProps={
              {
                type: 'number',
                step: '0.01',
                required: true,
                'data-testid': 'runtime-budget-input',
                'aria-label': 'workspace budget',
                value: draftBudget,
                onChange: (event) => setDraftBudget(event.target.value),
                disabled: pending || unbudgeted,
                className: 'w-32',
              } as React.InputHTMLAttributes<HTMLInputElement>
            }
          />
          <label className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[.09em] text-text-3">
            <input
              type="checkbox"
              aria-label="not budgeted"
              checked={unbudgeted}
              onChange={(event) => setUnbudgeted(event.target.checked)}
              disabled={pending}
            />
            not budgeted
          </label>
          <PrimaryButton type="submit" data-testid="runtime-budget-submit" disabled={pending}>
            set budget
          </PrimaryButton>
        </form>

        {costBlindBudgeted && (
          <span data-testid="runtime-cost-blind-warning" className="text-xs text-tone-waiting">
            this provider reports no cost; a budgeted workspace will refuse it at dispatch
          </span>
        )}
        {errorText !== null && (
          <span role="alert" data-testid="runtime-error" className="text-xs text-tone-blocked">
            {errorText}
          </span>
        )}
      </div>
    </Panel>
  )
}
