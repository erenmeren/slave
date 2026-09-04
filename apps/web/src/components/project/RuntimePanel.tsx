'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ProviderKind } from '@ai-team-os/control'
import { formatTimeout } from '../../lib/format'
import { sendControl } from '../../lib/postControl'
import { ProviderSelect } from '../ProviderSelect'
import { FieldLabel, INPUT_SHELL, PrimaryButton, TextField } from '../ui/FormControls'
import { Panel } from '../ui/Panel'

/**
 * The Settings tab's runtime panel (M24 §4, moved off the Overview card of the same shape): the
 * workspace's runtime and its spend ceiling, beside `GoalPanel`, plus the three dispatch limits
 * (concurrency, run timeout, attempts) shown read-only underneath -- the sidebar's old format,
 * now that Task 2 removed the sidebar row that used to carry them.
 *
 * No optimistic state: every control on this page follows M11's rule that the server's next
 * snapshot is what changes what is rendered. `router.refresh()` after a successful mutation is
 * the ONLY path back to a new value here (unlike the Overview card this panel replaced, there is
 * no SSE stream feeding the Settings tab) -- it costs one server render, and it is the house idiom
 * every write on this page follows.
 *
 * A 409 keeps whatever the operator typed, so a refused write is correctable rather than lost.
 *
 * `costBlindBudgeted` arrives as a plain boolean because deriving it needs `capabilitiesOf`, which
 * lives behind a package this client bundle must not evaluate. It describes the SAVED pair, not
 * the pending selection -- the point is to tell an operator what their current configuration will
 * do at dispatch, and the pending selection has not configured anything yet.
 */
export function RuntimePanel({
  workspaceId,
  provider,
  budgetUsd,
  costBlindBudgeted,
  limits,
}: {
  readonly workspaceId: string
  readonly provider: ProviderKind | null
  readonly budgetUsd: number | null
  readonly costBlindBudgeted: boolean
  readonly limits: {
    readonly maxConcurrentRuns: number
    readonly runTimeoutMs: number
    readonly maxAttempts: number
  }
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
    const error = await sendControl(url, { method: 'PUT', body })
    setPending(false)
    if (error === null) {
      router.refresh()
    } else {
      setErrorText(error)
    }
  }

  return (
    <Panel title="Runtime">
      <div className="flex flex-col gap-2">
        <form
          className="flex items-end gap-2"
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
          className="flex items-end gap-2"
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
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              aria-label="not budgeted"
              checked={unbudgeted}
              onChange={(event) => setUnbudgeted(event.target.checked)}
              disabled={pending}
            />
            <FieldLabel>not budgeted</FieldLabel>
          </label>
          <PrimaryButton type="submit" data-testid="runtime-budget-submit" disabled={pending}>
            set budget
          </PrimaryButton>
        </form>

        <dl data-testid="runtime-limits" className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-[6px] border-t border-line pt-3 font-mono text-[10.5px]">
          <dt className="text-text-faint">concurrency</dt>
          <dd data-testid="runtime-concurrency" className="text-text-1">{limits.maxConcurrentRuns}</dd>
          <dt className="text-text-faint">run timeout</dt>
          <dd data-testid="runtime-timeout" className="text-text-1">{formatTimeout(limits.runTimeoutMs)}</dd>
          <dt className="text-text-faint">attempts</dt>
          <dd data-testid="runtime-attempts" className="text-text-1">{limits.maxAttempts}</dd>
        </dl>
        <p className="font-mono text-[10px] text-text-3">set in the workspace record; not editable here yet</p>

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
