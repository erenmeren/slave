'use client'

import { useId, useState } from 'react'
import {
  ANSWER_MAX_CHARS,
  CARD_PATH_MAX_CHARS,
  HANDOFF_CHANGE_MAX_CHARS,
  HANDOFF_REOPENS_MAX,
  PERSON_CARD_TEXT_MAX_CHARS,
  SHARED_DECISION_TEXT_MAX_CHARS,
  SHARED_DECISION_TITLE_MAX_CHARS,
  type CardDecisionKind,
} from '@slave-of-ai/domain'
// Type-only, so nothing from `server/supervisor.ts` (and nothing it imports -- control, and the
// Prisma client under it) reaches the client bundle: the rule `ProposalRow.tsx` states.
import type { SupervisorView } from '../../server/supervisor'
import { Button } from '../ui/Button'
import { DangerConfirm } from '../ui/DangerConfirm'

type Decision = SupervisorView['pending'][number]
export type QuestionCard = NonNullable<Decision['card']>
type Draft = NonNullable<Decision['draft']>

/** What each decision is called on its button (spec H2). */
const LABEL: Readonly<Record<CardDecisionKind, string>> = {
  send_answer: 'send this answer',
  write_answer: 'write my own answer',
  give_work: 'give a package work',
  give_file: 'give a file to a package',
  record_decision: 'record a shared decision',
  change_requirement: 'change a requirement',
  dismiss: 'dismiss and close',
}

/**
 * Spec H3: where an answer or a decision taken now on a question its run continued past goes -- the
 * one sentence the card's question state ends with (ruling F37: the late answer's fate as Plan A
 * reads it, never the asker's package alone). Final review I2: a decision other than a dismissal
 * reaches the asking package as a hand-off exactly when an answer would (`decideCard` routes it by
 * the same fate, read again under the question's lock), and otherwise reaches no run. Moved here from
 * `ProposalRow`, which imports it, so the two cannot say different things.
 */
export function whereItGoes(card: QuestionCard): string {
  if (card.lateAnswerFate === 'next_run') return "; an answer now reaches the task's next run, if it has one; a decision reaches no run."
  if (card.lateAnswerFate === 'unread') return '; no run would read an answer or be told of a decision.'
  if (card.lateAnswerFate === 'hand_off') return `; an answer or a decision (not a dismissal) now reaches the ${card.askerPackageKey ?? 'asking'} package as a hand-off.`
  return '; an answer stays in its thread.'
}

/** Final review I2: what one decision taken now on a question its run continued past reaches -- the
 *  per-decision half of {@link whereItGoes}, by the same fate. */
function lateReach(kind: CardDecisionKind, card: QuestionCard): string {
  const pkg = card.askerPackageKey ?? 'asking'
  if (kind === 'send_answer' || kind === 'write_answer') {
    if (card.lateAnswerFate === 'hand_off') return `; the answer reaches the ${pkg} package as a hand-off.`
    if (card.lateAnswerFate === 'next_run') return "; the answer reaches the task's next run, if it has one."
    return '; no run would read it.'
  }
  // A dismissal reopens nobody to say the question was closed.
  if (kind === 'dismiss' || card.lateAnswerFate !== 'hand_off') return '; the run is not told.'
  return `; the ${pkg} package gets it as a hand-off.`
}

/** What a draft adds beyond its words when it is sent as it is: a conductor draft's shared decision
 *  and hand-off, each only when the draft really carries it and nobody edited the words (an edit
 *  applies neither -- `approveDecision`'s rule, Supervisor-as-conductor plan B D7). */
function draftExtras(draft: Draft | null): { readonly decision: boolean; readonly handOff: boolean } {
  const conductor = draft?.conductor
  if (conductor === undefined) return { decision: false, handOff: false }
  return { decision: conductor.newDecision !== null, handOff: conductor.handOff !== null }
}

function extrasWords(extras: { readonly decision: boolean; readonly handOff: boolean }): string | null {
  if (extras.decision && extras.handOff) return 'shared decision and hand-off'
  if (extras.decision) return 'shared decision'
  if (extras.handOff) return 'hand-off'
  return null
}

/**
 * What giving a file does, and when it is refused. Review M2: the grant holds for the question's goal
 * version only -- a new version's packages start with nothing released. Final review I3: the asking
 * package's run parked on this question is not running, so a file may be given TO its package (it
 * holds from the moment that run continues, whose permissions are rewritten then), but not taken
 * FROM it while it waits.
 */
function giveFileNote(card: QuestionCard): string {
  const version = card.goalVersion === null ? 'this goal version' : `goal v${String(card.goalVersion)}`
  const asker =
    card.askerWaiting && card.askerPackageKey !== null
      ? ` The ${card.askerPackageKey} package, whose run waits on this question, may be given a file (it holds from when that run continues), but gives none away until the question is settled.`
      : ''
  return `Moves one file to another package for ${version} only -- the only way a file changes owner; a new goal version's packages start with nothing released -- and the goal report records it. It takes effect at that package's next run; refused while the version is being verified or either package has a run going.${asker}`
}

/**
 * What choosing a decision will do -- the sentence the spec asks each card to say (H2), said before
 * anything is sent. Rulings F43/F61: the send note names a draft's decision and hand-off only when the
 * draft is a conductor draft that carries them. Ruling F37: an answer on a question its run continued
 * past says where it goes by the late answer's fate.
 */
function noteFor(kind: CardDecisionKind, card: QuestionCard, draft: Draft | null): string {
  const extras = extrasWords(draftExtras(draft))
  const edited = draft?.editedBody !== undefined
  const timedOut = card.closed?.reason === 'timed_out'
  const late = timedOut ? ` ${card.closed?.runContinued === true ? 'The run continued without an answer' : 'The card expired with no decision'}${lateReach(kind, card)}` : ''
  switch (kind) {
    case 'send_answer':
      if (edited) return `Sends the drafted answer as a person edited it${extras === null ? '' : `; as it was edited, the draft's ${extras} do not apply`}.${late}`
      return `Sends the drafted answer as it is${extras === null ? '' : `; its ${extras} ${extras.includes(' and ') ? 'apply' : 'applies'}`}.${late}`
    case 'write_answer':
      return `Sends your words as the answer${extras === null || edited ? '' : `; the draft's ${extras.includes(' and ') ? 'decision and hand-off do' : `${extras} does`} not apply`}.${late}`
    case 'give_work':
      return `The package that owns it is asked for the change (reopened if it has finished; refused for a finished package already reopened ${String(HANDOFF_REOPENS_MAX)} times)${card.askerWaiting ? '; the waiting run is told it is that package’s to make, or to make it itself when the work is its own package’s' : ''}. Name a package, or a file whose owner gets the work.${late}`
    case 'give_file':
      return `${giveFileNote(card)}${late}`
    case 'record_decision':
      return `Adds a shared decision to ${card.goalVersion === null ? 'this goal version' : `goal v${String(card.goalVersion)}`}: every later contract of that version carries it.${late}`
    case 'change_requirement':
      // M6: on a question its run continued past, the timeout's close stands.
      return `Opens a new goal version from your change, planned anew; ${timedOut ? 'the question stays closed as it timed out (the first close stands)' : 'this question is closed as superseded'}.${late}`
    case 'dismiss':
      if (timedOut) return `Settles the card without an answer; the question stays closed as it timed out.${late}`
      return card.askerWaiting
        ? 'Closes the question without an answer; the waiting run continues on its safest assumption, told your reason.'
        : 'Closes the question without an answer; no run is waiting on it.'
  }
}

/** The words a person types for one decision, kept per decision so looking at another loses nothing. */
interface Fields {
  readonly text: string
  readonly title: string
  readonly pkg: string
  readonly path: string
}

const EMPTY: Fields = { text: '', title: '', pkg: '', path: '' }

/** The decide route's exact body for a decision (Task 6 shapes), or null while the form is not one
 *  the route would take -- decide stays down rather than earning a 400. The words go as typed: the
 *  route trims them. */
function bodyFor(kind: CardDecisionKind, fields: Fields): Record<string, unknown> | null {
  const filled = (value: string): boolean => value.trim() !== ''
  switch (kind) {
    case 'send_answer':
      return { kind }
    case 'write_answer':
      return filled(fields.text) ? { kind, body: fields.text } : null
    case 'give_work':
      // A package or a file whose owner gets the work: exactly one.
      if (!filled(fields.text) || filled(fields.path) === (fields.pkg !== '')) return null
      return { kind, target: filled(fields.path) ? { path: fields.path } : { package: fields.pkg }, request: fields.text }
    case 'give_file':
      return filled(fields.path) && fields.pkg !== '' ? { kind, path: fields.path, toPackage: fields.pkg } : null
    case 'record_decision':
      return filled(fields.title) && filled(fields.text) ? { kind, title: fields.title, text: fields.text } : null
    case 'change_requirement':
      return filled(fields.text) ? { kind, request: fields.text } : null
    case 'dismiss':
      return { kind, reason: filled(fields.text) ? fields.text : null }
  }
}

/** The plain-words confirm of a decision that cannot simply be taken back -- asked before it is
 *  sent (`DangerConfirm`, the app's one two-step control); null for the rest. */
function confirmFor(kind: CardDecisionKind, fields: Fields): string | null {
  switch (kind) {
    case 'give_file':
      return `give ${fields.path.trim()} to the ${fields.pkg} package`
    case 'change_requirement':
      return 'open a new goal version with this change'
    case 'dismiss':
      return 'close the question without an answer'
    default:
      return null
  }
}

/** The text box's label, what the over-limit sentence calls it, and the server's bound for it, per
 *  decision that has one. Ruling I1 (fix round 1): a written answer takes ANSWER_MAX_CHARS, the bound
 *  of the draft it starts from. */
const TEXT_BOX: Partial<Readonly<Record<CardDecisionKind, { readonly label: string; readonly name: string; readonly max: number }>>> = {
  write_answer: { label: 'your answer', name: 'your answer', max: ANSWER_MAX_CHARS },
  give_work: { label: 'the change you want made', name: 'the change', max: HANDOFF_CHANGE_MAX_CHARS },
  record_decision: { label: 'the decision', name: 'the decision', max: SHARED_DECISION_TEXT_MAX_CHARS },
  change_requirement: { label: 'the change to the requirements', name: 'the change', max: PERSON_CARD_TEXT_MAX_CHARS },
  dismiss: { label: 'why (optional)', name: 'your reason', max: PERSON_CARD_TEXT_MAX_CHARS },
}

type FieldKey = 'text' | 'title' | 'path'

/** Every text field of a decision with its bound, in the order the form shows them -- what the counts
 *  and the over-limit check read. The route trims before it measures, and so does this. */
function boundsFor(kind: CardDecisionKind): readonly { readonly field: FieldKey; readonly name: string; readonly max: number }[] {
  const text = TEXT_BOX[kind]
  return [
    ...(kind === 'give_work' || kind === 'give_file' ? [{ field: 'path' as const, name: 'the file', max: CARD_PATH_MAX_CHARS }] : []),
    ...(kind === 'record_decision' ? [{ field: 'title' as const, name: 'the title', max: SHARED_DECISION_TITLE_MAX_CHARS }] : []),
    ...(text === undefined ? [] : [{ field: 'text' as const, name: text.name, max: text.max }]),
  ]
}

/** The first field over its bound, as the sentence that says so; null when every field fits. */
function overCap(kind: CardDecisionKind, fields: Fields): string | null {
  for (const bound of boundsFor(kind)) {
    const over = fields[bound.field].trim().length - bound.max
    if (over > 0) return `${bound.name} is ${String(over)} character${over === 1 ? '' : 's'} over its limit of ${String(bound.max)}; shorten it to decide`
  }
  return null
}

const FIELD = 'rounded border border-line bg-bg-0 px-2 py-1 text-[11px] text-text-1'
const LABELLED = 'flex flex-col gap-1 text-[11px] text-text-2'

/**
 * Human cards H2: the decisions a question card offers, each one click or a short form, and the
 * sentence that says what it will do. Renders exactly `card.offers` -- the server's list, already
 * computed with the late answer's fate (ruling F37) -- and nothing else. It posts nothing itself:
 * `onDecide` gets the decide route's body, and the page that mounts it posts it through its own
 * `send`, which shows a settled card's notice and refreshes (rulings F41/F67).
 *
 * Every string a person types or a worker or model wrote is a JSX child or a form value --
 * characters, never markup.
 */
export function CardDecisions({
  card,
  draft,
  busy,
  onDecide,
}: {
  readonly card: QuestionCard
  /** The card's drafted answer, if it has one: what `write_answer` starts from, and (F61) whether
   *  sending it applies a conductor decision or hand-off. */
  readonly draft: Draft | null
  /** A decision on this card is in flight: every control is down, so nothing is sent twice. */
  readonly busy: boolean
  readonly onDecide: (body: Record<string, unknown>) => void
}): React.JSX.Element {
  const [picked, setKind] = useState<CardDecisionKind | null>(null)
  const [fields, setFields] = useState<Partial<Readonly<Record<CardDecisionKind, Fields>>>>({})
  // A refresh can withdraw what was picked (the question timed out, its draft went): a decision the
  // card no longer offers is neither shown nor sent (ruling F37).
  const kind = picked !== null && card.offers.includes(picked) ? picked : null
  const id = useId()
  const noteId = `${id}-note`

  const current = kind === null ? EMPTY : (fields[kind] ?? EMPTY)
  const set = (patch: Partial<Fields>): void => {
    if (kind === null) return
    setFields((was) => ({ ...was, [kind]: { ...(was[kind] ?? EMPTY), ...patch } }))
  }
  const choose = (offer: CardDecisionKind): void => {
    setKind(offer)
    // A written answer starts from the draft's words (an earlier edit first), once.
    const seed = draft?.editedBody ?? draft?.body ?? null
    if (offer === 'write_answer' && fields.write_answer === undefined && seed !== null) {
      setFields((was) => ({ ...was, write_answer: { ...EMPTY, text: seed } }))
    }
  }

  const tooLong = kind === null ? null : overCap(kind, current)
  // Blank or over a bound: not a body the route would take, so decide stays down (ruling I1).
  const body = kind === null || tooLong !== null ? null : bodyFor(kind, current)
  const confirm = kind === null ? null : confirmFor(kind, current)
  const textBox = kind === null ? undefined : TEXT_BOX[kind]
  const picksPackage = kind === 'give_work' || kind === 'give_file'
  /** A field's count against its bound, beside the field and named as its description. */
  const count = (field: FieldKey, max: number): React.JSX.Element => (
    <span id={`${id}-count-${field}`} data-testid={`card-count-${field}`} className="font-mono text-[10px] text-text-3">
      {`${String(current[field].trim().length)} / ${String(max)} characters`}
    </span>
  )
  const answerWithheld = card.closed?.reason === 'timed_out' && card.lateAnswerFate === 'unread'

  return (
    <div data-testid="card-decisions" className="flex flex-col gap-1">
      {answerWithheld && (
        <span data-testid="card-decisions-no-answer" className="text-[11px] text-text-2">
          No answer is offered{whereItGoes(card)}
        </span>
      )}
      {card.offers.length > 0 && (
        <div role="group" aria-label="decide this question" className="flex flex-wrap gap-1">
          {card.offers.map((offer) => (
            <Button
              key={offer}
              size="sm"
              variant={offer === kind ? 'primary' : 'ghost'}
              data-testid={`card-decision-${offer}`}
              aria-pressed={offer === kind}
              disabled={busy}
              onClick={() => choose(offer)}
            >
              {LABEL[offer]}
            </Button>
          ))}
        </div>
      )}
      {kind !== null && (
        <>
          <span id={noteId} data-testid="card-decision-note" className="text-[11px] text-text-2">
            {noteFor(kind, card, draft)}
          </span>
          {picksPackage && (
            <label className={LABELLED}>
              {kind === 'give_work' ? 'the package (or name a file below)' : 'the package that gets the file'}
              <select data-testid="card-target-package" value={current.pkg} onChange={(event) => set({ pkg: event.target.value })} className={FIELD}>
                <option value="">{kind === 'give_work' ? 'no package -- a file names it' : 'choose a package'}</option>
                {card.packages.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.key} — {p.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {picksPackage && (
            <label className={LABELLED}>
              {kind === 'give_work' ? `the file whose owner gets the work, instead (at most ${String(CARD_PATH_MAX_CHARS)} characters)` : `the file, e.g. backend/package.json (at most ${String(CARD_PATH_MAX_CHARS)} characters)`}
              <input data-testid="card-path" value={current.path} maxLength={CARD_PATH_MAX_CHARS} aria-describedby={`${id}-count-path`} onChange={(event) => set({ path: event.target.value })} className={FIELD} />
            </label>
          )}
          {picksPackage && count('path', CARD_PATH_MAX_CHARS)}
          {kind === 'record_decision' && (
            <label className={LABELLED}>
              {`title (at most ${String(SHARED_DECISION_TITLE_MAX_CHARS)} characters)`}
              <input data-testid="card-title" value={current.title} maxLength={SHARED_DECISION_TITLE_MAX_CHARS} aria-describedby={`${id}-count-title`} onChange={(event) => set({ title: event.target.value })} className={FIELD} />
            </label>
          )}
          {kind === 'record_decision' && count('title', SHARED_DECISION_TITLE_MAX_CHARS)}
          {textBox !== undefined && (
            <label className={LABELLED}>
              {`${textBox.label} (at most ${String(textBox.max)} characters)`}
              <textarea
                data-testid="card-text"
                value={current.text}
                rows={3}
                maxLength={textBox.max}
                aria-describedby={`${id}-count-text`}
                onChange={(event) => set({ text: event.target.value })}
                className="rounded border border-line bg-bg-0 p-2 text-xs text-text-1"
              />
            </label>
          )}
          {textBox !== undefined && count('text', textBox.max)}
          {tooLong !== null && (
            <span role="alert" data-testid="card-over-cap" className="text-[11px] text-tone-blocked">
              {tooLong}
            </span>
          )}
          <div className="flex items-center gap-2">
            {confirm === null ? (
              <Button
                variant="primary"
                size="sm"
                data-testid="card-decide"
                aria-describedby={noteId}
                disabled={busy || body === null}
                onClick={() => {
                  if (body !== null) onDecide(body)
                }}
              >
                decide
              </Button>
            ) : (
              // Irreversible, or not simply undone (a file's owner, a new goal version, a closed
              // question): the app's one two-step control asks with the sentence first.
              <DangerConfirm
                // Keyed by the decision and by the request in flight (fix round 1, M1): a confirm
                // opened for one decision never stays open on another, and none is open while busy.
                key={`${kind}:${busy ? 'busy' : 'idle'}`}
                label="decide"
                testId="card-decide"
                confirmText={confirm}
                confirmName={`confirm: ${confirm}`}
                describedBy={noteId}
                disabled={busy || body === null}
                onConfirm={async () => {
                  if (body !== null) onDecide(body)
                  return null
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
