'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ProviderKind } from '@slave-of-ai/control'
import { isWorkspaceLimitAllowed, WORKSPACE_LIMIT_BOUNDS, WORKSPACE_LIMIT_RULE, type WorkspaceLimitField } from '@slave-of-ai/domain'
import { sendControl } from '../../lib/postControl'
import { ProviderSelect } from '../ProviderSelect'
import { FieldLabel, INPUT_SHELL, TextField } from '../ui/FormControls'
import { Panel } from '../ui/Panel'
import { Button } from '../ui/Button'

/**
 * The Settings tab's runtime panel (M24 §4, moved off the Overview card of the same shape): the
 * workspace's runtime and its spend ceiling, beside `GoalPanel`, plus the three dispatch limits
 * (run timeout, runs at once, attempts) underneath. H9 F8 made those editable: until then they were
 * shown read-only and nothing anywhere could write them.
 *
 * No optimistic state: every control on this page follows M11's rule that the server's next
 * snapshot is what changes what is rendered. `router.refresh()` after a successful mutation is
 * the ONLY path back to a new value here (unlike the Overview card this panel replaced, there is
 * no SSE stream feeding the Settings tab) -- it costs one server render, and it is the house idiom
 * every write on this page follows.
 *
 * A 409 keeps whatever the operator typed, so a refused write is correctable rather than lost.
 *
 * E R7/R1 add the project's two switches under the limits -- auto-merge and the
 * Supervisor's autonomy -- the only editable settings on this panel that are not a text field, and
 * the two whose value is a whole policy rather than a figure.
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
  autoMerge,
  autonomy,
  limits,
}: {
  readonly workspaceId: string
  readonly provider: ProviderKind | null
  readonly budgetUsd: number | null
  readonly costBlindBudgeted: boolean
  /** E R7: whether an approved review merges the branch and stamps the task integrated. */
  readonly autoMerge: boolean
  /** E R1: whether the Supervisor's decisions wait for a person (`propose`) or are carried out. */
  readonly autonomy: 'propose' | 'act'
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

  const submit = async (url: string, body: Record<string, unknown>, method: 'PUT' | 'PATCH' = 'PUT'): Promise<void> => {
    setPending(true)
    setErrorText(null)
    // PATCH for the Supervisor's settings route and PUT for everything else on this page: that
    // route writes ONE field of a workspace that has several, which is the distinction the slave
    // profile and runtime-role routes draw too.
    const error = await sendControl(url, { method, body })
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
          <Button variant="primary" size="sm" type="submit" data-testid="runtime-provider-submit" disabled={pending}>
            set runtime
          </Button>
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
          <Button variant="primary" size="sm" type="submit" data-testid="runtime-budget-submit" disabled={pending}>
            set budget
          </Button>
        </form>

        <LimitsForm
          // Keyed on the SAVED figures, the `ProjectSettingsClient` idiom for the provider/budget
          // pair: a successful write refreshes the route, the key moves, and the drafts reseed from
          // what the server now holds. A refused write moves nothing, so what was typed stays.
          key={`${String(limits.runTimeoutMs)}|${String(limits.maxConcurrentRuns)}|${String(limits.maxAttempts)}`}
          limits={limits}
          pending={pending}
          onSave={(patch) => void submit(`/api/w/${workspaceId}/limits`, patch, 'PATCH')}
          onRefuse={setErrorText}
        />

        {/* E R7/R1 §4: the two switches, under the limits. Checkboxes rather
          * than a form with a button -- there is nothing to type, so the flip IS the instruction --
          * and NO local state behind them, this panel's own rule: the server's next snapshot is
          * what moves them, which is exactly why a refused write leaves the box where the project
          * actually has it instead of showing a state nobody saved. */}
        <div className="flex flex-col gap-1.5 border-t border-line pt-3">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              data-testid="runtime-auto-merge"
              aria-label="merge approved work automatically"
              checked={autoMerge}
              onChange={(event) => void submit(`/api/w/${workspaceId}/integration`, { autoMerge: event.target.checked })}
              disabled={pending}
            />
            <FieldLabel>merge approved work automatically</FieldLabel>
          </label>
          <p className="font-mono text-[10px] text-text-3">
            while this is off, a done task leaves its branch for you and confirm-integration is what unblocks its
            dependents; turning it on stamps nothing that is already done
          </p>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              data-testid="runtime-autonomy"
              aria-label="act on its own"
              checked={autonomy === 'act'}
              onChange={(event) =>
                void submit(
                  `/api/w/${workspaceId}/supervisor/settings`,
                  { autonomy: event.target.checked ? 'act' : 'propose' },
                  'PATCH',
                )
              }
              disabled={pending}
            />
            <FieldLabel>act on its own</FieldLabel>
          </label>
          <p className="font-mono text-[10px] text-text-3">
            the Supervisor carries out what it decides instead of proposing it; what it may decide is unchanged, and
            anything it escalates still waits for you
          </p>
        </div>

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

type Limits = { readonly maxConcurrentRuns: number; readonly runTimeoutMs: number; readonly maxAttempts: number }

/** The order a refusal is looked for in -- the order the fields are drawn. An emptied field is
 *  `Number('')`, `0`, which every bound refuses, so an empty box is answered by its own rule. */
const LIMIT_FIELDS: readonly WorkspaceLimitField[] = ['runTimeoutMs', 'maxConcurrentRuns', 'maxAttempts']

/**
 * The three dispatch limits as one form (H9 F8): the timeout in MINUTES, the unit a person thinks
 * in and the one `set-limits --run-timeout-min` takes, converted to the column's milliseconds here.
 *
 * Checked before anything is sent, against the domain's own bounds and in the domain's own words --
 * the sentence `setWorkspaceLimits` would answer with, so a figure out of range reads the same
 * whether the panel caught it or the route did. `required` keeps an emptied field from taking the
 * budget field's third road in the browser, and `LIMIT_FIELDS` says what an empty box is answered with.
 *
 * All three go in every save. The verb writes and records only what MOVED, so re-sending the two
 * nobody touched costs nothing and says nothing.
 */
function LimitsForm({
  limits,
  pending,
  onSave,
  onRefuse,
}: {
  readonly limits: Limits
  readonly pending: boolean
  readonly onSave: (patch: Limits) => void
  readonly onRefuse: (text: string) => void
}): React.JSX.Element {
  const [timeoutMin, setTimeoutMin] = useState(String(limits.runTimeoutMs / 60_000))
  const [concurrent, setConcurrent] = useState(String(limits.maxConcurrentRuns))
  const [attempts, setAttempts] = useState(String(limits.maxAttempts))

  const field = (
    label: string,
    testId: string,
    ariaLabel: string,
    value: string,
    onChange: (next: string) => void,
    bounds: { readonly min: number; readonly max: number },
  ): React.JSX.Element => (
    <TextField
      label={label}
      inputProps={
        {
          type: 'number',
          step: '1',
          min: bounds.min,
          max: bounds.max,
          required: true,
          'data-testid': testId,
          'aria-label': ariaLabel,
          value,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
          disabled: pending,
          className: 'w-20',
        } as React.InputHTMLAttributes<HTMLInputElement>
      }
    />
  )

  return (
    <form
      data-testid="runtime-limits"
      className="mt-2 flex flex-wrap items-end gap-2 border-t border-line pt-3"
      onSubmit={(event) => {
        event.preventDefault()
        const patch: Limits = {
          runTimeoutMs: Number(timeoutMin) * 60_000,
          maxConcurrentRuns: Number(concurrent),
          maxAttempts: Number(attempts),
        }
        const refused = LIMIT_FIELDS.find((name) => !isWorkspaceLimitAllowed(name, patch[name]))
        if (refused !== undefined) {
          onRefuse(WORKSPACE_LIMIT_RULE[refused])
          return
        }
        onSave(patch)
      }}
    >
      {field('run timeout (min)', 'runtime-timeout', 'run timeout in minutes', timeoutMin, setTimeoutMin, {
        min: WORKSPACE_LIMIT_BOUNDS.runTimeoutMs.min / 60_000,
        max: WORKSPACE_LIMIT_BOUNDS.runTimeoutMs.max / 60_000,
      })}
      {field('runs at once', 'runtime-concurrency', 'runs at once', concurrent, setConcurrent, WORKSPACE_LIMIT_BOUNDS.maxConcurrentRuns)}
      {field('attempts', 'runtime-attempts', 'attempts per task', attempts, setAttempts, WORKSPACE_LIMIT_BOUNDS.maxAttempts)}
      <Button variant="primary" size="sm" type="submit" data-testid="runtime-limits-submit" disabled={pending}>
        set limits
      </Button>
      <p className="w-full font-mono text-[10px] text-text-3">
        a longer timeout reaches a run already working; attempts reach tasks planned from now on
      </p>
    </form>
  )
}
