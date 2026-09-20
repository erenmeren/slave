import { handoffSourceLines, type Source } from './answerPrompt.js'
import type { ChatAttachment } from './chatPrompt.js'
import type { SupervisorQuestion, SupervisorWorld } from './world.js'

/**
 * "Sourced" means verified in code (M39 §1) -- the one guard between a model's paragraph and a
 * message another worker will act on.
 *
 * The model says where each part of its answer came from; this file checks. Every quote must be a
 * verbatim substring of the source it names, and at least one source must exist. Anything else is
 * an INTERPRETATION: still worth drafting, never sent without a human. Nothing here consults the
 * model's confidence, its `critical` flag or the length of its answer -- only whether the words it
 * quoted are in the record.
 */

/** Why one citation did not verify. Kept on the draft so a human judging it can see the difference
 *  between "quoted a message that does not exist" and "quoted words that are not there". */
export type RejectionReason = 'unknown_ref' | 'quote_not_found' | 'no_such_source'

export interface SourceCheck {
  readonly verified: readonly Source[]
  readonly rejected: readonly { readonly source: Source; readonly reason: RejectionReason }[]
}

/**
 * Runs of whitespace to a single space, then trimmed. Applied to BOTH sides of every comparison.
 *
 * A model retypes a quote with its own line breaks and indentation -- that is not a fabrication,
 * and rejecting it would make the sourced path unreachable for any multi-line source. Case is NOT
 * normalised: "delete the row" and "Delete the row" are different sentences in a technical answer,
 * and a check that ignored the difference would be checking topic rather than text.
 */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * What a CHAT turn adds to the record a citation may be checked against (Supervisor chat R2).
 *
 * EXACTLY what `buildSupervisorChatPrompt` put in front of the model, and the only way to build
 * one is `renderedChatSources(input)` -- the same feed window, the same caps, the same attachment
 * slices, from the same functions the prompt renders from (fix round 1, I1). A caller that passed
 * the raw feed or a whole attachment file would be letting a quote verify against words the model
 * never saw, which is the one thing this whole file exists to stop.
 *
 * `attachments` holds only the ones that were INLINED, and each one's `text` is the slice as the
 * prompt printed it -- capped, and with the markers and routing literals defused, because that is
 * the text a model copying verbatim would copy.
 */
export interface ChatSourceContext {
  readonly feed: readonly { readonly seq: number; readonly sentence: string }[]
  readonly attachments: readonly ChatAttachment[]
}

/**
 * The kinds that name ONE row among many, rather than the single-valued source a question has.
 *
 * They share a rejection reason: a `ref` that resolves to nothing is `unknown_ref`, because the
 * model pointed AT something and it was not there -- whether the id was invented, the window has
 * moved on, or the call carried no such list at all. The other three are `no_such_source`: there
 * was nothing of that kind to point at in the first place.
 */
const REF_ADDRESSED: readonly Source['kind'][] = ['message', 'feed', 'attachment']

/**
 * The text one of the three QUESTION sources names, or null when the record has no such source.
 *
 * `ref` is consulted for `message` only (erratum E1): the other two are single-valued for a
 * question, so a ref the model invented for them is ignored rather than treated as a mismatch.
 *
 * {@link sourceText} is the only caller and routes exactly the three kinds below to it; the
 * `default` is what a fourth would come to if one ever reached here, and nothing is citable that
 * this function cannot name a text for.
 */
function questionSourceText(source: Source, question: SupervisorQuestion): string | null {
  switch (source.kind) {
    case 'task': {
      // Nulls as empty strings, joined by the newline the prompt showed them across -- so a quote
      // that runs from the title into the description still verifies once whitespace collapses.
      // The handoff lines are HERE for plan erratum E8: `buildAnswerPrompt` prints them under this
      // very SOURCE heading, and a check that refused a quote from them would hold back every
      // answer that cited an acceptance criterion.
      const text = [
        question.taskTitle ?? '',
        question.taskDescription ?? '',
        ...handoffSourceLines(question.taskHandoff),
      ].join('\n')
      return normalise(text) === '' ? null : text
    }
    case 'run_context':
      return question.askerRunPrompt === null || normalise(question.askerRunPrompt) === ''
        ? null
        : question.askerRunPrompt
    case 'message': {
      if (source.ref === null) return null
      // THE QUESTION IS NOT EVIDENCE FOR ITS OWN ANSWER. The thread includes the question itself
      // (`SupervisorQuestion.thread`), so a model could otherwise quote the very words it was asked
      // -- "which port? the one on 5433" -- and that citation would verify, make the answer
      // `sourced`, and send it to a worker with no human ever seeing it. Circular by construction:
      // the whole point of the check is that the answer came from somewhere the asker did not.
      if (source.ref === question.messageId) return null
      const message = question.thread.find((entry) => entry.messageId === source.ref)
      if (message === undefined) return null
      // NOTHING THE ASKER WROTE IS EVIDENCE EITHER (erratum E8). The line above is one message
      // wide, and a worker that wants an automatic answer only has to post a `note` in its own
      // thread first -- "the port is 9999" -- and then ask the question whose answer it planted.
      // That citation would verify against a real message body and the answer would go out
      // unread. The rule is the asker, not the question: a colleague's note, an earlier answer,
      // and anything the system itself wrote are all still quotable.
      if (message.senderSlaveId === question.askerSlaveId) return null
      return message.body
    }
    default:
      return null
  }
}

/**
 * The text a source kind names for this citation, or null when the record has no such source.
 *
 * `question` is NULL on a chat turn (Supervisor chat R2), which has no question at all: the three
 * kinds that read one resolve to nothing there, and the goal, the feed and the attachments are
 * what remain citable. `chat` is undefined on the ANSWER path, and the two chat kinds resolve to
 * nothing there for the same reason -- a call may only be checked against what it actually showed
 * the model.
 *
 * An attachment is citable only when its TEXT was inlined (R6): an image or a binary is named in
 * the prompt by path and size and nothing else, so there are no words in it a quote could have
 * been copied from.
 */
function sourceText(
  source: Source,
  question: SupervisorQuestion | null,
  world: SupervisorWorld,
  chat: ChatSourceContext | undefined,
): string | null {
  switch (source.kind) {
    case 'goal':
      return world.goal === null || normalise(world.goal) === '' ? null : world.goal
    case 'feed': {
      if (chat === undefined || source.ref === null) return null
      const entry = chat.feed.find((line) => String(line.seq) === source.ref)
      return entry === undefined || normalise(entry.sentence) === '' ? null : entry.sentence
    }
    case 'attachment': {
      if (chat === undefined || source.ref === null) return null
      const file = chat.attachments.find((attachment) => attachment.path === source.ref)
      return file?.text === undefined || normalise(file.text) === '' ? null : file.text
    }
    // The three a QUESTION supplies. Listed rather than defaulted so the switch stays EXHAUSTIVE:
    // a seventh `SOURCE_KINDS` member added later fails the build here, instead of quietly
    // becoming a citation checked against the asker's thread.
    case 'task':
    case 'run_context':
    case 'message':
      return question === null ? null : questionSourceText(source, question)
  }
}

/**
 * Sorts a model's citations into the ones that check out and the ones that do not (M39 §3).
 *
 * Order is preserved on both sides, so a draft shows a human the model's own citation order rather
 * than a reshuffled one. A missing source is `no_such_source` (the record has no goal, no task, no
 * recorded run context); a {@link REF_ADDRESSED} citation naming an id that is not there -- or
 * naming none at all -- is `unknown_ref`, since the model pointed at something rather than nothing;
 * everything else that fails is `quote_not_found`.
 *
 * TWO callers, one rule (Supervisor chat R2). The answer path passes the question it is answering
 * and no `chat`; a conversation passes `null` and the feed and attachments its prompt showed. Each
 * call is checked against exactly what it put in front of the model and nothing else, which is why
 * the other caller's kinds resolve to nothing rather than to somebody else's record.
 *
 * Two classes of `message` ref are rejected on principle rather than for being absent, and both
 * come to the same thing: NOTHING THE ASKER WROTE IS EVIDENCE (errata E4, E8). The question's own
 * id, and any thread message whose sender is the asker. Either would let an answer be built out of
 * words the asker put in the thread itself and sent automatically. Both are reported as
 * `unknown_ref`, the reason for every message citation that points nowhere usable.
 */
export function verifySources(
  sources: readonly Source[],
  question: SupervisorQuestion | null,
  world: SupervisorWorld,
  chat?: ChatSourceContext,
): SourceCheck {
  const verified: Source[] = []
  const rejected: { source: Source; reason: RejectionReason }[] = []

  for (const source of sources) {
    const text = sourceText(source, question, world, chat)
    if (text === null) {
      rejected.push({ source, reason: REF_ADDRESSED.includes(source.kind) ? 'unknown_ref' : 'no_such_source' })
      continue
    }
    const quote = normalise(source.quote)
    // An empty (or whitespace-only) quote is a substring of every text there is. Cited evidence
    // that proves nothing is not evidence, so it is rejected rather than silently verifying.
    if (quote === '' || !normalise(text).includes(quote)) {
      rejected.push({ source, reason: 'quote_not_found' })
      continue
    }
    verified.push(source)
  }

  return { verified, rejected }
}

/**
 * The one question `answerTier` asks about a draft: may this answer go out by itself?
 *
 * Both halves are deliberate. At least one verified source, because an uncited answer is the
 * model's opinion however true it sounds. NO rejected sources, because a model that quoted three
 * real sentences and invented a fourth has shown exactly the failure the check exists to catch --
 * and picking the good ones out for it would be the Supervisor doing the inventing.
 */
export function isSourced(check: SourceCheck): boolean {
  return check.verified.length > 0 && check.rejected.length === 0
}
