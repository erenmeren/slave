'use client'

import { useState } from 'react'
import { GOAL_REPORT_CLOSE_WORDS, PROVIDER_LABEL, SITUATION_LABEL, type Action, type TeamSource } from '@slave-of-ai/domain'
// Type-only, so nothing from `server/supervisor.ts` (and nothing it imports -- control, and the
// Prisma client under it) reaches the client bundle. The same rule `useOverview.ts` states for
// `OverviewSnapshot`.
import type { SupervisorView } from '../../server/supervisor'
import { formatUtcMinute } from '../../lib/format'
import { Button } from '../ui/Button'
import { CardDecisions, whereItGoes } from './CardDecisions'

/**
 * One proposal, and the drafted answer under it (M57 R8 / spec erratum E18).
 *
 * Moved here WHOLE when `SupervisorPanel.tsx` was deleted -- not rewritten. Three surfaces render
 * this row (the six-lane timeline's DECISION REQUIRED lane, the Organization tab's needs list, and
 * the Supervisor's own panel before this milestone replaced it with a conversation), four gates
 * read its testids, and a proposal has to read and answer identically wherever it is shown.
 */

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
/** M58 R16: the middle tier is the POOL now -- somebody who already works here, seated on a second
 *  project with the same memory and the same skills. The word an operator reads says so. */
const SOURCE_LABEL: Record<TeamSource, string> = {
  existing_worker: 'ALREADY HERE',
  pool_person: 'FROM THE POOL',
  project_worker: 'NEW SLAVE',
  temporary: 'FOR ONE ASSIGNMENT',
}

function sourceOf(action: Action): TeamSource | null {
  switch (action.kind) {
    case 'assign_capability':
      return 'existing_worker'
    case 'materialise_company_worker':
      return 'pool_person'
    case 'hire_from_catalog':
      return action.temporary ? 'temporary' : 'project_worker'
    default:
      return null
  }
}

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
    // M58 R16: the KIND keeps its name (a stored decision must still say what it said), and the
    // sentence says what it now does -- seat somebody who already works here.
    case 'materialise_company_worker':
      return `seat ${action.name} on this project from the pool, for ${action.capabilityLabel}`
    case 'hire_from_catalog':
      return `hire ${action.name} from the catalog${action.temporary ? ' as a temporary specialist' : ''}, for ${action.capabilityLabel}`
    // M48 R5: the runbook's NAME, off the action itself -- this function runs in the browser and
    // has no runbook table, exactly as it has no taxonomy for `capabilityLabel` above.
    case 'adopt_runbook':
      return `adopt the "${action.name}" runbook for this project`
    case 'answer_question':
      return `answer question ${action.messageId}`
    case 'reassign_question':
      return `re-address question ${action.messageId} to ${action.toSlaveId}`
    case 'mark_task_failed':
      return `mark task ${action.taskId} failed: ${action.reason}`
    case 'cancel_task':
      return `cancel task ${taskTitles[action.taskId] ?? action.taskId}: ${action.reason}`
    // M49 R2: the COUNT is the whole subject -- there is no one row to name, and "withdraw" is the
    // word that says the rows stay (nothing here is ever deleted).
    case 'discard_stale_candidates':
      return `withdraw ${String(action.count)} unverified report(s) nothing ever checked`
    // M50 R3: the NAME, off the action -- this function runs in the browser and has no roster to
    // look a slave id up in, exactly as it has no taxonomy for `capabilityLabel` above.
    case 'release_worker':
      return `release ${action.name}: their one assignment is over`
    // M51 R3: the SENTENCE is on the action, so this reads what was actually sent rather than
    // re-deriving it -- this function runs in the browser and has no breaker constants to consult.
    case 'steer_run':
      return `tell that run to stop and rethink: \u201c${action.text}\u201d`
    // M52 R5: the worker's NAME and the operation's LABEL, both off the action -- this function
    // runs in the browser and may not import the domain's label table through control's barrel,
    // which is the same reason `capabilityLabel` rides on `assign_capability` above.
    case 'request_permission':
      return `ask a person to let ${action.name} ${action.kindLabel.toLowerCase()}`
    // Self-running-project R3: the TITLE is on the action, this function's own reason for every
    // other action that names a task without a `taskTitles` map to look one up in.
    case 'retry_task':
      return `retry "${action.title}": ${action.reason}`
    case 'retry_review':
      return `send "${action.title}" back through review: ${action.reason}`
    // Self-running-project R4: the one remedy for a halted workspace.
    case 'clear_halt':
      return `clear the halt on this workspace: ${action.reason}`
    // Supervisor chat R3: the two a CONVERSATION asked for. Both quote the person's own words,
    // because that is the whole of what is being approved -- a goal change is their sentence
    // amending the standing goal, and a note is their sentence committed for the next planner.
    case 'request_goal_change':
      return `ask for the goal to change: “${action.request}”`
    case 'note_for_planner':
      return `leave a note for the next planner: “${action.text}”`
    // H4a: the two remedies for planning that cannot start. Both are about the PROJECT and name no
    // row, so neither needs a title map -- and the runtime is named in the WORDS a person reads
    // (`PROVIDER_LABEL`), never as the column value the action stores.
    case 'configure_runtime':
      return `give this project a runtime: ${PROVIDER_LABEL[action.provider]}`
    case 'retry_planning':
      return 'let planning start over, once, for this goal'
    case 'escalate_to_human':
      return `escalate to a human: ${action.summary}`
    case 'no_action':
      return 'do nothing'
    // Conductor R2: the conductor's own size decision, recorded already carried out.
    case 'conduct':
      return action.mode === 'single'
        ? `deliver goal v${String(action.goalVersion)} as one package`
        : `split goal v${String(action.goalVersion)} into ${String(action.packageKeys.length)} packages: ${action.packageKeys.join(', ')}`
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
 * proposal reads and answers identically wherever it is shown. It lived in `SupervisorPanel.tsx`
 * until M57 deleted that panel, and moved here unchanged rather than dying with it.
 */
export function DraftEditor({
  draft,
  question,
  body,
  onBody,
  readOnly = false,
}: {
  readonly draft: Draft
  /** The pending question this answers, when it is still in the world -- `undefined` once it has
   *  been settled by somebody else, in which case the row shows the situation summary alone
   *  rather than inventing a question that is no longer outstanding. */
  readonly question: Question | undefined
  readonly body: string
  readonly onBody: (text: string) => void
  /** Human cards plan B (rulings F43/F61): on a question card the draft is READ, not edited --
   *  `CardDecisions` is the one editor ("write my own answer"), so a second box cannot compete with
   *  it. Shows the words "send this answer" would send (an earlier edit first), as text. */
  readonly readOnly?: boolean
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
      {readOnly ? (
        <span data-testid="supervisor-draft-text" className="whitespace-pre-wrap rounded border border-line bg-bg-0 p-2 text-xs text-text-1">
          {draft.editedBody ?? draft.body ?? 'no drafted answer'}
        </span>
      ) : (
        <textarea
          data-testid="supervisor-draft-body"
          value={body}
          onChange={(event) => onBody(event.target.value)}
          placeholder="the answer this slave receives"
          className="rounded border border-line bg-bg-0 p-2 text-xs text-text-1"
          rows={4}
        />
      )}
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
          {/* Read-only, the box above already shows the edit; repeating it would say it twice. */}
          {readOnly ? 'edited by a human' : `edited by a human: ${draft.editedBody}`}
        </span>
      )}
      {draft.conductor !== undefined && <ConductorDetails conductor={draft.conductor} editable={!readOnly} />}
    </div>
  )
}

/**
 * Supervisor-as-conductor final wave I2: what approving a conductor answer DOES beyond sending it --
 * the shared decision it adds, the hand-off it routes, what it would change, what it rests on, and
 * what did not verify. A person approving the card must see all of it. Every value is the model's
 * or a worker's text, so each is a JSX child -- characters on the page, never markup.
 */
function ConductorDetails({
  conductor,
  editable,
}: {
  readonly conductor: NonNullable<Draft['conductor']>
  /** Whether the answer can be edited right here; a read-only draft's card decisions say what an
   *  answer of one's own applies instead (ruling F61). */
  readonly editable: boolean
}): React.JSX.Element {
  const { basis, newDecision, handOff } = conductor
  const cited = [
    ...(basis.requirements.length === 0 ? [] : [`requirements ${basis.requirements.join(', ')}`]),
    ...(basis.packages.length === 0 ? [] : [`packages ${basis.packages.join(', ')}`]),
    ...(basis.decisions.length === 0 ? [] : [`decisions ${basis.decisions.map((title) => `\u201c${title}\u201d`).join(', ')}`]),
  ]
  return (
    <div data-testid="supervisor-draft-conductor" className="flex flex-col gap-0.5 text-[11px] text-text-2">
      <span data-testid="supervisor-draft-conductor-decision">
        {newDecision === null ? 'new shared decision: none' : `new shared decision: \u201c${newDecision.title}\u201d \u2014 ${newDecision.decision}`}
      </span>
      <span data-testid="supervisor-draft-conductor-handoff">
        {handOff === null
          ? 'hand-off: none'
          : `hand-off to ${'path' in handOff ? `the owner of ${handOff.path}` : `the ${handOff.package} package`}: ${handOff.change}`}
      </span>
      <span data-testid="supervisor-draft-conductor-changes">changes: {conductor.changes}</span>
      <span data-testid="supervisor-draft-conductor-basis">basis: {cited.length === 0 ? 'nothing' : cited.join(' \u00b7 ')}</span>
      {conductor.unverified.map((note, index) => (
        <span key={String(index)} data-testid="supervisor-draft-conductor-unverified" className="text-tone-waiting">
          not verified: {note}
        </span>
      ))}
      {editable && (
        <span data-testid="supervisor-draft-conductor-edit-note" className="text-text-3">
          Editing the answer applies neither the decision nor the hand-off.
        </span>
      )}
    </div>
  )
}

/**
 * Human cards H1/H3: how the card's question stands. A parked run whose resume was refused still
 * waits, and the card says why; a run that continued without an answer says where a decision taken
 * now goes; a late answer no run will read says so (the card stays open for it); any other close
 * says how, by whom and when. Nothing while the question is simply open. Every value is a JSX child:
 * the refusal and the names are data, never markup.
 */
function QuestionState({ card }: { readonly card: NonNullable<Decision['card']> }): React.JSX.Element | null {
  if (card.askerWaiting && card.timeoutRefusal !== null) {
    return (
      <span data-testid="card-question-state" className="text-[11px] text-tone-blocked">
        Still waiting: the wait is over, but the run cannot continue: {card.timeoutRefusal}
      </span>
    )
  }
  const closed = card.closed
  if (closed === null) return null
  if (closed.reason === 'timed_out' && !closed.runContinued) {
    // Final wave, finding 7: an expired card timed its question out with nobody parked on it.
    return (
      <span data-testid="card-question-state" className="text-[11px] text-text-2">
        The card expired with no decision at {formatUtcMinute(closed.at)}
        {card.lateAnswerNote !== null ? `. ${card.lateAnswerNote}` : whereItGoes(card)}
      </span>
    )
  }
  if (closed.reason === 'timed_out') {
    return (
      <span data-testid="card-question-state" className="text-[11px] text-tone-waiting">
        The run continued without an answer at {formatUtcMinute(closed.at)}
        {card.lateAnswerNote !== null ? `. ${card.lateAnswerNote}` : whereItGoes(card)}
      </span>
    )
  }
  const words = GOAL_REPORT_CLOSE_WORDS[closed.reason]
  return (
    <span data-testid="card-question-state" className="text-[11px] text-text-2">
      {`${words.charAt(0).toUpperCase()}${words.slice(1)} by ${closed.byName} at ${formatUtcMinute(closed.at)}.`}
    </span>
  )
}

/**
 * Human cards plan B (ruling F55, Plan A final review I7): a question card whose proposed action is
 * the machine's own move -- hire, seat, give a capability, re-address the question -- keeps an
 * approve that names that move (spec H2: "cards whose action is the machine's keep approve and
 * reject"; dismiss is the reject on a question card). An answer, an escalation or "do nothing" has
 * no move of its own to approve: on those cards the decisions are the only buttons, "send this
 * answer" being the approve. Exported for the Supervisor panel's card, which answers by the same rule.
 */
export function machineMove(action: Action): boolean {
  return action.kind !== 'answer_question' && action.kind !== 'escalate_to_human' && action.kind !== 'no_action'
}

/**
 * One proposal, with everything a person needs to answer it: the situation it was made on, what
 * would happen, and why the Supervisor picked that. Split out of the panel so the pending list and
 * its per-row reject box stay readable.
 *
 * Exported since M45: the Supervisor timeline's DECISION REQUIRED lane renders the same row, so a
 * proposal reads and answers identically wherever it is shown. It lived in `SupervisorPanel.tsx`
 * until M57 deleted that panel, and moved here unchanged rather than dying with it.
 */
export function ProposalRow({
  decision,
  questions,
  taskTitles,
  busy,
  onApprove,
  onReject,
  onDecide,
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
  /** Human cards H2: present where the page can post to the decide route. A question card renders
   *  its decisions with it; without it the card shows no decisions and never a bare approve. */
  readonly onDecide?: (body: Record<string, unknown>) => void
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
  const source = sourceOf(decision.action)
  return (
    <li
      data-testid="supervisor-proposal"
      {...(source === null ? {} : { 'data-source': source })}
      className="flex flex-col gap-1 rounded border border-line p-2"
    >
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
        {source !== null && (
          <span
            data-testid="supervisor-proposal-source"
            data-source={source}
            title={source}
            className="shrink-0 font-mono text-[10px] text-text-3"
          >
            {SOURCE_LABEL[source]}
          </span>
        )}
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
      {decision.card != null && <QuestionState card={decision.card} />}
      {draft !== null && <DraftEditor draft={draft} question={question} body={body} onBody={setBody} readOnly={decision.card != null} />}
      {decision.card != null ? (
        // Human cards H2 / Plan A final review I7: a question card is decided, not approved -- no
        // bare "approve" on it. Its draft above is read-only (F43); the decisions are the editor.
        <>
          {machineMove(decision.action) && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" data-testid="supervisor-approve" disabled={busy} onClick={() => onApprove(undefined)}>
                {`approve: ${actionText(decision.action, taskTitles)}`}
              </Button>
              <span data-testid="supervisor-approve-or-decide" className="text-[11px] text-text-3">
                or decide the question below instead, which sets this proposal aside
              </span>
            </div>
          )}
          {onDecide !== undefined && <CardDecisions card={decision.card} draft={draft} busy={busy} onDecide={onDecide} />}
        </>
      ) : (
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
      )}
    </li>
  )
}
