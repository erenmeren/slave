'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { DECIDER_LABEL, DECISION_STATUS_LABEL, PROFILE_MAX_CHARS, SITUATION_LABEL, type Action } from '@slave-of-ai/domain'
// Type-only, so nothing from `server/supervisor.ts` (and nothing it imports -- control, and the
// Prisma client under it) reaches the client bundle. The same rule `useOverview.ts` states for
// `OverviewSnapshot`.
import type { SupervisorView } from '../server/supervisor'
import { errorMessage, sendControl } from '../lib/postControl'
import { onUnauthorized } from '../lib/onUnauthorized'
import { Button } from './ui/Button'
import { EmptyState } from './ui/EmptyState'
import { Panel } from './ui/Panel'

/**
 * The shortest interval between two reads this panel will make on its own (fix round 1, Important
 * 2 + the controller's ruling).
 *
 * `refreshKey` is the overview's SSE-driven refetch, debounced at 250 ms -- during an active run
 * that fires several times a second, and each read here is a `RepeatableRead` world load plus two
 * decision queries, per open tab. A Supervisor decision is made at most once per tick and answered
 * by a human at human speed, so five seconds of staleness costs nothing that a wake-up every
 * quarter-second buys. The last wake-up inside a window still lands, as a TRAILING read after it,
 * so the panel never settles on a snapshot older than the window; and the panel's own writes
 * bypass this entirely, because an operator who just clicked Approve must see the result now.
 */
export const SUPERVISOR_PANEL_MIN_REFRESH_MS = 5_000

type Decision = SupervisorView['pending'][number]
type Draft = NonNullable<Decision['draft']>
type Question = SupervisorView['questions'][number]

/**
 * One chosen action in a sentence, with its subject (M38 §6).
 *
 * The kind alone (`set_runtime_roles`) says what would happen but never to WHOM, and "approve" is
 * a decision a person can only make with the subject in front of them. Exhaustive over `Action`,
 * so a kind added to the catalogue fails this file's build rather than rendering as a blank.
 *
 * `taskTitles` (M40 §6) is the board's titles by id, from the same world the decision was read
 * with. Used by `cancel_task`, whose subject is a task a human is being asked to give up: a raw
 * uuid is not something anyone can say yes or no to. A task the world no longer holds falls back to
 * its id, which is findable, rather than to a name this function would have to invent.
 */
export function actionText(action: Action, taskTitles: Readonly<Record<string, string>> = {}): string {
  switch (action.kind) {
    case 'unblock_task':
      return `unblock task ${action.taskId}`
    case 'raise_max_attempts':
      return `raise the attempt cap on task ${action.taskId} and unblock it`
    case 'set_runtime_roles':
      return `set the runtime roles of ${action.slaveId} to ${action.roles.length === 0 ? 'none' : action.roles.join(', ')}`
    // M47 R4, the three ways to fill a missing capability. Each names the CAPABILITY it is for:
    // the situation chip says "Missing a capability" and this line says which one -- in the
    // taxonomy's WORDS, which the action carries (`capabilityLabel`, final review Minor 5b). This
    // function runs in the browser and has no taxonomy to look a key up in, and the key is in the
    // decision row for anyone who needs it.
    case 'assign_capability':
      return `give ${action.slaveId} the "${action.role}" runtime role, for ${action.capabilityLabel}`
    case 'materialise_company_worker':
      return `bring ${action.name} onto this project from the company roster, for ${action.capabilityLabel}`
    case 'hire_from_catalog':
      return `hire ${action.name} from the catalog${action.temporary ? ' as a temporary specialist' : ''}, for ${action.capabilityLabel}`
    case 'answer_question':
      return `answer question ${action.messageId}`
    case 'reassign_question':
      return `re-address question ${action.messageId} to ${action.toSlaveId}`
    case 'mark_task_failed':
      return `mark task ${action.taskId} failed: ${action.reason}`
    case 'cancel_task':
      return `cancel task ${taskTitles[action.taskId] ?? action.taskId}: ${action.reason}`
    case 'escalate_to_human':
      return `escalate to a human: ${action.summary}`
    case 'no_action':
      return 'do nothing'
  }
}

/**
 * What a drafted answer is made of (M39 §6), under the proposal it belongs to: the question it
 * would answer, the answer itself in a box a human may rewrite, and the evidence behind it.
 *
 * The box is a textarea and the citations are JSX children, so a model's words -- and a worker's
 * question -- are characters on the page and never elements (spec §1: another party's text is
 * data). The same reason `SlavePanel`'s profile box and the settings box below are textareas.
 *
 * Owned by {@link ProposalRow} rather than by itself: the Approve button lives on the row, and the
 * row is what decides whether the text has been touched, so the state has to sit above both.
 *
 * Exported since M45: the Supervisor timeline's DECISION REQUIRED lane renders the same row, so a
 * proposal reads and answers identically wherever it is shown. Exported IN PLACE rather than moved
 * to a file of its own, so `apps/web/test/supervisor-panel.test.tsx` keeps testing it where it has
 * always been tested.
 */
export function DraftEditor({
  draft,
  question,
  body,
  onBody,
}: {
  readonly draft: Draft
  /** The pending question this answers, when it is still in the world -- `undefined` once it has
   *  been settled by somebody else, in which case the row shows the situation summary alone
   *  rather than inventing a question that is no longer outstanding. */
  readonly question: Question | undefined
  readonly body: string
  readonly onBody: (text: string) => void
}): React.JSX.Element {
  // Both signals, named separately and joined only when both fired: the lexicon's own words are
  // what a human checks against the question, and "the model asked for a human" is a different
  // claim that stands on its own (spec §1 records both, never one instead of the other).
  const criticalParts = [
    ...(draft.critical.lexicon.length > 0 ? [draft.critical.lexicon.join(', ')] : []),
    ...(draft.critical.model ? ['the model asked for a human'] : []),
  ]
  return (
    <div data-testid="supervisor-draft" className="flex flex-col gap-1 rounded border border-line bg-bg-0 p-2">
      {question !== undefined && (
        <span data-testid="supervisor-draft-question" className="text-[11px] text-text-2">
          {question.body}
        </span>
      )}
      {criticalParts.length > 0 && (
        <span data-testid="supervisor-draft-critical" className="text-[11px] text-tone-blocked">
          critical: {criticalParts.join(' · ')}
        </span>
      )}
      <textarea
        data-testid="supervisor-draft-body"
        value={body}
        onChange={(event) => onBody(event.target.value)}
        placeholder="the answer this slave receives"
        className="rounded border border-line bg-bg-0 p-2 text-xs text-text-1"
        rows={4}
      />
      <span data-testid="supervisor-draft-confidence" className="font-mono text-[10px] text-text-3">
        {draft.confidence}
        {draft.confidence === 'sourced' ? '' : ' — nothing verified it; read it before you send it'}
      </span>
      {/* What actually verified, quoted, with the source it was found in -- the one thing that
        * tells a reader whether the answer is the project's own words or the model's. */}
      {draft.sources.map((source, index) => (
        <span key={`${source.kind}-${String(index)}`} data-testid="supervisor-draft-source" className="text-[11px] text-text-2">
          <span className="font-mono text-text-3">{source.kind}</span>
          {source.ref === null ? '' : ` ${source.ref}`}
          {' · '}
          {source.quote}
        </span>
      ))}
      {/* And what did NOT: "the model quoted something that is not there" is the single most
        * useful thing a human can know when judging a draft (`Draft.rejectedSources`). */}
      {draft.rejectedSources.map((rejected, index) => (
        <span
          key={`${rejected.source.kind}-${String(index)}`}
          data-testid="supervisor-draft-rejected"
          className="text-[11px] text-tone-waiting"
        >
          <span className="font-mono text-text-3">{rejected.source.kind}</span>
          {' · '}
          {rejected.source.quote}
          {' — '}
          {rejected.reason}
        </span>
      ))}
      {draft.editedBody !== undefined && (
        <span data-testid="supervisor-draft-edited" className="text-[11px] text-text-2">
          edited by a human: {draft.editedBody}
        </span>
      )}
    </div>
  )
}

/**
 * One proposal, with everything a person needs to answer it: the situation it was made on, what
 * would happen, and why the Supervisor picked that. Split out of the panel so the pending list and
 * its per-row reject box stay readable.
 *
 * Exported since M45: the Supervisor timeline's DECISION REQUIRED lane renders the same row, so a
 * proposal reads and answers identically wherever it is shown. Exported IN PLACE rather than moved
 * to a file of its own, so `apps/web/test/supervisor-panel.test.tsx` keeps testing it where it has
 * always been tested.
 */
export function ProposalRow({
  decision,
  questions,
  taskTitles,
  busy,
  onApprove,
  onReject,
}: {
  readonly decision: Decision
  /** Every pending question. The row picks its own out by the action's message id -- passed whole
   *  rather than pre-matched by the panel so the one `answer_question` narrowing lives here, beside
   *  the draft it also governs. */
  readonly questions: readonly Question[]
  /** The board's titles by id (M40 §6), for an action whose subject is a task -- see
   *  {@link actionText}. */
  readonly taskTitles: Readonly<Record<string, string>>
  readonly busy: boolean
  /** `body` is the human's replacement text, and `undefined` means "send what the Supervisor
   *  drafted" -- the route tells those two apart, and an untouched box must not be sent as an
   *  edit. */
  readonly onApprove: (body?: string) => void
  readonly onReject: (reason: string) => void
}): React.JSX.Element {
  const [reason, setReason] = useState('')
  const answering = decision.action.kind === 'answer_question' ? decision.action.messageId : null
  // A draft only means anything on an answer decision (every other action's column is null anyway
  // -- this is the reading that says so out loud).
  const draft = answering === null ? null : decision.draft
  const question = answering === null ? undefined : questions.find((one) => one.messageId === answering)
  // A human's earlier edit first, then the model's own body, then nothing at all -- erratum E2's
  // escalated draft has no body until somebody types one, and an empty box is exactly the right
  // invitation there. Seeded ONCE (a `useState` initial value): the panel re-reads itself every
  // few seconds, and a refetch that reset this box would delete what an operator was typing.
  const seed = draft?.editedBody ?? draft?.body ?? ''
  const [body, setBody] = useState(seed)
  return (
    <li data-testid="supervisor-proposal" className="flex flex-col gap-1 rounded border border-line p-2">
      <div className="flex items-baseline gap-2">
        {/* R5 leak 5: this chip printed the `SituationKind` member. The domain's own label says
          * what is stuck; the raw kind stays in `title`.
          *
          * `?? decision.situationKind` (final review, minor a) is a RUNTIME guard, not a type one:
          * `SITUATION_LABEL` is a `Record<SituationKind, string>`, so the compiler says this
          * lookup is total, but the value arrives from a database column and a row written by a
          * newer build carries a kind this bundle's table has never heard of. Unguarded that
          * renders as NOTHING -- an empty chip beside a summary, with no way to tell a missing
          * label from a missing situation. The fallback shows the member, which is the same text
          * `title` already carries here. */}
        <span data-testid="supervisor-proposal-kind" title={decision.situationKind} className="shrink-0 font-mono text-[10px] text-text-3">
          {SITUATION_LABEL[decision.situationKind] ?? decision.situationKind}
        </span>
        {/* Every one of these is another party's text -- the situation the rules wrote, and a
          * rationale a MODEL may have written. Interpolated as JSX children, so it is characters
          * on the page and never elements (spec §1: another party's text is data). */}
        <span data-testid="supervisor-proposal-summary" className="min-w-0 text-xs text-text-1">
          {decision.situation.summary}
        </span>
      </div>
      <span data-testid="supervisor-proposal-action" className="text-xs text-tone-waiting">
        {actionText(decision.action, taskTitles)}
      </span>
      <span data-testid="supervisor-proposal-rationale" className="text-[11px] text-text-2">
        {decision.rationale}
      </span>
      {draft !== null && <DraftEditor draft={draft} question={question} body={body} onBody={setBody} />}
      <div className="flex items-center gap-2">
        <input
          data-testid="supervisor-reject-reason"
          value={reason}
          placeholder="why not (optional)"
          onChange={(event) => setReason(event.target.value)}
          className="min-w-0 flex-1 rounded border border-line bg-bg-0 px-2 py-1 text-[11px] text-text-1"
        />
        <Button
          variant="primary"
          data-testid="supervisor-approve"
          disabled={busy}
          // An untouched box is not an edit. Sending it anyway would record every approval as a
          // human rewrite of the model's answer -- including the ones where the operator only read
          // it and said yes.
          onClick={() => onApprove(body === seed ? undefined : body)}
        >
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
 * The mailbox (M39 §6): every question still waiting on an answer, whether or not the Supervisor
 * has decided anything about it yet.
 *
 * Read-only, deliberately. Answering, re-addressing and approving a draft all happen through a
 * verb -- the answer box on the slave panel, `reassign-question` on the CLI, the Approve above --
 * and a fourth control here would be a fourth place to keep in step. What this block owes an
 * operator is the fact the panel otherwise cannot show: somebody is stuck, on whom, and since when.
 */
function QuestionsWaiting({ questions }: { readonly questions: readonly Question[] }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-[10px] uppercase tracking-wide text-text-3">questions waiting</h4>
      {questions.length === 0 ? (
        <span data-testid="supervisor-questions-empty" className="text-xs text-text-3">
          no question is waiting on an answer
        </span>
      ) : (
        <ul className="flex flex-col gap-1">
          {questions.map((question) => (
            <li key={question.messageId} data-testid="supervisor-question-row" className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] text-text-3">
                {/* The STAMP, trimmed to minutes, the same convention the `supervisor.*` timeline
                  * cards use -- a "2 hours ago" computed against now would be wrong the moment
                  * this panel stopped refreshing. */}
                {question.askerName} → {question.waitingOn} · asked {question.since.slice(0, 16).replace('T', ' ')}
                {' · '}
                {/* Zero holders is the `unanswerable_question` shape: nobody in this project may be
                  * dispatched the question, so no re-address can fix it -- staffing (or a human)
                  * has to. Said in words rather than left as a bare "0". */}
                {question.holders === 0 ? 'nobody can answer it' : `${String(question.holders)} could answer it`}
              </span>
              {/* Another slave's words, as characters (spec §1). */}
              <span className="text-xs text-text-1">{question.body}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The Supervisor's face on the overview page, under the halt banner (M38 §6).
 *
 * It owns its own read rather than riding the overview snapshot: the whole view is one route
 * (`GET …/supervisor`), it is worthless when nothing is stuck, and folding a `RepeatableRead`
 * world load plus two decision queries into the overview's own snapshot would make every poll of
 * every project pay for it. `refreshKey` is the overview's SSE-driven refetch -- an event on the
 * workspace stream, debounced at 250 ms, NOT a fixed poll -- so a decision the daemon recorded or
 * an approval taken on the CLI shows up here without a reload, throttled to one read per
 * {@link SUPERVISOR_PANEL_MIN_REFRESH_MS} with a trailing read for the last wake-up inside a
 * window.
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
  /** Monotonic guard, the same one `useWorkspaceStream`'s refetch uses: only the most recently
   *  ISSUED read may write state. Without it a slow read started before an approve can land after
   *  the read that followed the approve, and the proposal reappears under "waiting on you" having
   *  already been carried out. */
  const loadSeq = useRef(0)
  /** When the last read was issued (not when it resolved): this throttles REQUESTS. */
  const lastLoadAt = useRef(Number.NEGATIVE_INFINITY)
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current
    lastLoadAt.current = Date.now()
    // A read is happening now, so a trailing one booked for later has nothing left to catch up on.
    if (trailing.current !== null) {
      clearTimeout(trailing.current)
      trailing.current = null
    }
    try {
      const response = await fetch(`/api/w/${workspaceId}/supervisor`)
      if (!response.ok) {
        // An expired session lands on the door rather than on a red band that never clears (M20
        // §3.4) -- this read dials `fetch` directly, so it owes the same call `sendControl` makes.
        if (response.status === 401) onUnauthorized()
        const data: unknown = await response.json().catch(() => null)
        if (seq !== loadSeq.current) return
        // Named rather than swallowed (fix round 1, Minor 2): a panel that has silently stopped
        // updating is indistinguishable from a project where nothing is happening, which is the
        // one thing this panel exists to tell apart. The last good view stays on screen under it.
        setErrorText(errorMessage(data, response.status))
        return
      }
      const parsed = (await response.json()) as SupervisorView
      if (seq !== loadSeq.current) return
      setView(parsed)
      setErrorText(null)
    } catch (cause) {
      if (seq !== loadSeq.current) return
      setErrorText(cause instanceof Error ? cause.message : String(cause))
    }
  }, [workspaceId])

  /** The throttled entry the wake-ups use: read now if the window has passed, otherwise book the
   *  one trailing read that will carry the latest wake-up across it. */
  const requestRefresh = useCallback((): void => {
    const waited = Date.now() - lastLoadAt.current
    if (waited >= SUPERVISOR_PANEL_MIN_REFRESH_MS) {
      void load()
      return
    }
    if (trailing.current !== null) return
    trailing.current = setTimeout((): void => {
      trailing.current = null
      void load()
    }, SUPERVISOR_PANEL_MIN_REFRESH_MS - waited)
  }, [load])

  useEffect((): void => {
    requestRefresh()
  }, [requestRefresh, refreshKey])

  // Its own effect, keyed on nothing: a booked trailing read must not outlive the panel.
  useEffect(
    (): (() => void) => () => {
      if (trailing.current !== null) clearTimeout(trailing.current)
    },
    [],
  )

  /** The one place this panel writes: mark it busy, clear the last refusal, dial the shared
   *  `sendControl`, re-read either way -- an approve that was refused still moved the row
   *  (`applyDecision` records a `failed` status), so the list on screen is stale whichever way it
   *  went -- and then show whatever the WRITE refused with.
   *
   *  The re-read is `load()` directly, not `requestRefresh()`: the throttle governs the poll's
   *  wake-ups, and an operator who just clicked Approve is owed the result now. Setting the error
   *  after the read is deliberate for the same reason a successful read clears the band: the
   *  write's refusal is the newer, more specific fact and must outrank it. */
  const send = async (url: string, options: { method: 'POST' | 'PATCH'; body?: Record<string, unknown> }): Promise<void> => {
    setBusy(true)
    setErrorText(null)
    const error = await sendControl(url, options)
    await load()
    if (error !== null) setErrorText(error)
    setBusy(false)
  }

  // Nothing at all until the first read lands, rather than a skeleton: this panel sits between the
  // halt banner and the strip on a page that is already painted from its own SSR snapshot, and an
  // empty-shaped placeholder there would read as "the Supervisor has nothing to say" -- which is a
  // claim, and one this component cannot make yet.
  if (view === null) return null

  const { report, pending, recent, questions, settings, taskTitles } = view
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
                  questions={questions}
                  taskTitles={taskTitles}
                  busy={busy}
                  onApprove={(body) =>
                    void send(`${decisions}/${decision.id}/approve`, {
                      method: 'POST',
                      // No body at all unless the operator actually rewrote the draft: an absent
                      // body is legal on this route and means "send what the Supervisor wrote".
                      ...(body === undefined ? {} : { body: { body } }),
                    })
                  }
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

        <QuestionsWaiting questions={questions} />

        <div className="flex flex-col gap-1">
          <h4 className="text-[10px] uppercase tracking-wide text-text-3">recent decisions</h4>
          {recent.length === 0 ? (
            <EmptyState testId="supervisor-recent-empty" message="no decisions yet" />
          ) : (
            <ul className="flex flex-col gap-1">
              {recent.map((decision) => (
                <li key={decision.id} data-testid="supervisor-decision-row" className="flex flex-col gap-0.5">
                  {/* R5 leak 5: this line WAS the database record (`no_reviewer · proposed ·
                    * pending · by model`). It is a sentence now. `tier` leaves the visible line --
                    * `status` already says what happened to the decision, and the two read as a
                    * duplicate to anyone who does not know the difference -- but the whole record,
                    * tier included, is one hover away in `title`. */}
                  <span
                    data-testid="supervisor-decision-meta"
                    title={`${decision.situationKind} · ${decision.tier} · ${decision.status} · ${decision.decidedBy}`}
                    className="text-[10px] text-text-3"
                  >
                    {/* Each with the same runtime fallback as the proposal chip above (final
                      * review, minor a): a row whose kind, status or decider this bundle has no
                      * label for reads as the raw member rather than as a gap in the sentence. */}
                    {SITUATION_LABEL[decision.situationKind] ?? decision.situationKind} ·{' '}
                    {DECISION_STATUS_LABEL[decision.status] ?? decision.status} · decided by{' '}
                    {DECIDER_LABEL[decision.decidedBy] ?? decision.decidedBy}
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
