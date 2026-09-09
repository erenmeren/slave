'use client'

import { useCallback, useEffect, useState } from 'react'
import { PROFILE_MAX_CHARS, type Action } from '@slave-of-ai/domain'
// Type-only, so nothing from `server/supervisor.ts` (and nothing it imports -- control, and the
// Prisma client under it) reaches the client bundle. The same rule `useOverview.ts` states for
// `OverviewSnapshot`.
import type { SupervisorView } from '../server/supervisor'
import { sendControl } from '../lib/postControl'
import { Button } from './ui/Button'
import { Panel } from './ui/Panel'

type Decision = SupervisorView['pending'][number]

/**
 * One chosen action in a sentence, with its subject (M38 §6).
 *
 * The kind alone (`set_runtime_roles`) says what would happen but never to WHOM, and "approve" is
 * a decision a person can only make with the subject in front of them. Exhaustive over `Action`,
 * so a kind added to the catalogue fails this file's build rather than rendering as a blank.
 */
export function actionText(action: Action): string {
  switch (action.kind) {
    case 'unblock_task':
      return `unblock task ${action.taskId}`
    case 'raise_max_attempts':
      return `raise the attempt cap on task ${action.taskId} and unblock it`
    case 'set_runtime_roles':
      return `set the runtime roles of ${action.slaveId} to ${action.roles.length === 0 ? 'none' : action.roles.join(', ')}`
    case 'nudge_answer':
      return `nudge the holders of question ${action.messageId}`
    case 'mark_task_failed':
      return `mark task ${action.taskId} failed: ${action.reason}`
    case 'escalate_to_human':
      return `escalate to a human: ${action.summary}`
    case 'no_action':
      return 'do nothing'
  }
}

/** One proposal, with everything a person needs to answer it: the situation it was made on, what
 *  would happen, and why the Supervisor picked that. Split out of the panel so the pending list
 *  and its per-row reject box stay readable. */
function ProposalRow({
  decision,
  busy,
  onApprove,
  onReject,
}: {
  readonly decision: Decision
  readonly busy: boolean
  readonly onApprove: () => void
  readonly onReject: (reason: string) => void
}): React.JSX.Element {
  const [reason, setReason] = useState('')
  return (
    <li data-testid="supervisor-proposal" className="flex flex-col gap-1 rounded border border-line p-2">
      <div className="flex items-baseline gap-2">
        <span data-testid="supervisor-proposal-kind" className="shrink-0 font-mono text-[10px] text-text-3">
          {decision.situationKind}
        </span>
        {/* Every one of these is another party's text -- the situation the rules wrote, and a
          * rationale a MODEL may have written. Interpolated as JSX children, so it is characters
          * on the page and never elements (spec §1: another party's text is data). */}
        <span data-testid="supervisor-proposal-summary" className="min-w-0 text-xs text-text-1">
          {decision.situation.summary}
        </span>
      </div>
      <span data-testid="supervisor-proposal-action" className="text-xs text-tone-waiting">
        {actionText(decision.action)}
      </span>
      <span data-testid="supervisor-proposal-rationale" className="text-[11px] text-text-2">
        {decision.rationale}
      </span>
      <div className="flex items-center gap-2">
        <input
          data-testid="supervisor-reject-reason"
          value={reason}
          placeholder="why not (optional)"
          onChange={(event) => setReason(event.target.value)}
          className="min-w-0 flex-1 rounded border border-line bg-bg-0 px-2 py-1 text-[11px] text-text-1"
        />
        <Button variant="primary" data-testid="supervisor-approve" disabled={busy} onClick={onApprove}>
          approve
        </Button>
        <Button variant="ghost" data-testid="supervisor-reject" disabled={busy} onClick={() => onReject(reason)}>
          reject
        </Button>
      </div>
    </li>
  )
}

/**
 * The Supervisor's face on the overview page, under the halt banner (M38 §6).
 *
 * It owns its own read rather than riding the overview snapshot: the whole view is one route
 * (`GET …/supervisor`), it is worthless when nothing is stuck, and folding a `RepeatableRead`
 * world load plus two decision queries into the overview's own snapshot would make every poll of
 * every project pay for it. It re-reads on `refreshKey` -- the overview's poll tick -- so an
 * action taken in the CLI, or a decision the daemon recorded, shows up here without a reload.
 *
 * Every write goes through a control route; this component has no idea what a decision does, only
 * which URL says yes to it.
 */
export function SupervisorPanel({
  workspaceId,
  refreshKey,
}: {
  readonly workspaceId: string
  /** Changes whenever the overview refetches. Any value: only its identity is read. */
  readonly refreshKey?: unknown
}): React.JSX.Element | null {
  const [view, setView] = useState<SupervisorView | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)
  // ONE flag for the whole panel, not one per decision: every write here is followed by a re-read
  // of the whole view, so a second click during the first write would act on a list that is about
  // to be replaced. Approving two proposals is two deliberate acts, a beat apart.
  const [busy, setBusy] = useState(false)
  const [profileDraft, setProfileDraft] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/w/${workspaceId}/supervisor`)
      if (!response.ok) return
      setView((await response.json()) as SupervisorView)
    } catch {
      // A failed read leaves the last good view on screen: this panel is a passenger on the
      // overview's poll, and a red band per dropped poll would be noise about nothing. A failed
      // WRITE is different -- that one an operator has to see, and `send` below shows it.
    }
  }, [workspaceId])

  useEffect((): void => {
    void load()
  }, [load, refreshKey])

  /** The one place this panel writes: mark it busy, clear the last refusal, dial the shared
   *  `sendControl`, show whatever it refused with, and re-read either way -- an approve that was
   *  refused still moved the row (`applyDecision` records a `failed` status), so the list on
   *  screen is stale whichever way it went. */
  const send = async (url: string, options: { method: 'POST' | 'PATCH'; body?: Record<string, unknown> }): Promise<void> => {
    setBusy(true)
    setErrorText(null)
    const error = await sendControl(url, options)
    if (error !== null) setErrorText(error)
    await load()
    setBusy(false)
  }

  // Nothing at all until the first read lands, rather than a skeleton: this panel sits between the
  // halt banner and the strip on a page that is already painted from its own SSR snapshot, and an
  // empty-shaped placeholder there would read as "the Supervisor has nothing to say" -- which is a
  // claim, and one this component cannot make yet.
  if (view === null) return null

  const { report, pending, recent, settings } = view
  const profileText = profileDraft ?? settings.profile ?? ''
  const decisions = `/api/w/${workspaceId}/supervisor/decisions`

  return (
    <div data-testid="supervisor-panel" className="px-[20px] pt-[16px]">
      <Panel title="supervisor">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="flex flex-col gap-1">
            <h4 className="text-[10px] uppercase tracking-wide text-text-3">done</h4>
            <span data-testid="supervisor-done" className="text-xs text-text-1">
              {report.done.integrated} integrated · {report.done.awaitingIntegration} awaiting integration
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <h4 className="text-[10px] uppercase tracking-wide text-text-3">stuck</h4>
            {report.stuck.length === 0 ? (
              <span data-testid="supervisor-stuck-empty" className="text-xs text-text-3">
                nothing is stuck
              </span>
            ) : (
              <ul className="flex flex-col gap-1">
                {report.stuck.map((situation) => (
                  <li
                    key={`${situation.kind}-${situation.subjectId}`}
                    data-testid="supervisor-stuck-row"
                    className="text-xs text-text-1"
                  >
                    {situation.summary}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <h4 className="text-[10px] uppercase tracking-wide text-text-3">next</h4>
            <span data-testid="supervisor-next" className="text-xs text-text-1">
              {report.next.ready} ready · {report.next.running} running · {report.next.waiting} waiting ·{' '}
              {report.next.blocked} blocked
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <h4 className="text-[10px] uppercase tracking-wide text-text-3">waiting on you</h4>
          {pending.length === 0 ? (
            <span data-testid="supervisor-pending-empty" className="text-xs text-text-3">
              nothing is waiting on you
            </span>
          ) : (
            <ul className="flex flex-col gap-2">
              {pending.map((decision) => (
                <ProposalRow
                  key={decision.id}
                  decision={decision}
                  busy={busy}
                  onApprove={() => void send(`${decisions}/${decision.id}/approve`, { method: 'POST' })}
                  onReject={(reason) =>
                    void send(`${decisions}/${decision.id}/reject`, {
                      method: 'POST',
                      // An empty box is no reason at all, not an empty one: `rejectDecision`
                      // stores a blank as `null`, and sending the field would only ask it to.
                      body: reason.trim() === '' ? {} : { reason },
                    })
                  }
                />
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <h4 className="text-[10px] uppercase tracking-wide text-text-3">recent decisions</h4>
          {recent.length === 0 ? (
            <span data-testid="supervisor-recent-empty" className="text-xs text-text-3">
              no decisions yet
            </span>
          ) : (
            <ul className="flex flex-col gap-1">
              {recent.map((decision) => (
                <li key={decision.id} data-testid="supervisor-decision-row" className="flex flex-col gap-0.5">
                  <span className="font-mono text-[10px] text-text-3">
                    {decision.situationKind} · {decision.tier} · {decision.status} · by {decision.decidedBy}
                    {decision.failureReason === null ? '' : ` · ${decision.failureReason}`}
                  </span>
                  <span data-testid="supervisor-decision-rationale" className="text-[11px] text-text-2">
                    {decision.rationale}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <h4 className="text-[10px] uppercase tracking-wide text-text-3">settings</h4>
          <label className="flex items-center gap-2 text-xs text-text-2">
            <input
              type="checkbox"
              data-testid="supervisor-enabled"
              checked={settings.enabled}
              disabled={busy}
              onChange={() =>
                void send(`/api/w/${workspaceId}/supervisor/settings`, {
                  method: 'PATCH',
                  body: { enabled: !settings.enabled },
                })
              }
            />
            {/* What OFF actually means, said here rather than left to be discovered: the panel
              * above keeps working, because `summarise` is a pure read of the world. */}
            supervisor decides ({settings.enabled ? 'on' : 'off — it reports but decides nothing'})
          </label>
          {/* A textarea, so a persona written elsewhere is characters in a form control and never
            * elements -- the same reason `SlavePanel`'s profile box is one. */}
          <textarea
            data-testid="supervisor-profile-input"
            value={profileText}
            onChange={(event) => setProfileDraft(event.target.value)}
            placeholder={`the Supervisor's persona and house rules (at most ${PROFILE_MAX_CHARS} characters)`}
            className="rounded border border-line bg-bg-0 p-2 text-xs text-text-1"
            rows={4}
          />
          <Button
            variant="ghost"
            data-testid="supervisor-profile-save"
            disabled={busy}
            // A blank box means "clear it", which only an explicit `null` expresses -- an empty
            // string would be stored as `null` by the verb anyway, and saying so here is what
            // makes the intent readable at the call site.
            onClick={() =>
              void send(`/api/w/${workspaceId}/supervisor/settings`, {
                method: 'PATCH',
                body: { profile: profileText.trim() === '' ? null : profileText },
              })
            }
            className="self-end"
          >
            save profile
          </Button>
        </div>

        {errorText !== null && (
          <span role="alert" data-testid="supervisor-error" className="text-xs text-tone-blocked">
            {errorText}
          </span>
        )}
      </Panel>
    </div>
  )
}
