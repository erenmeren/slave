import type { Source } from './answerPrompt.js'
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
 * The text a source kind names for this question, or null when the record has no such source.
 *
 * `ref` is consulted for `message` only (erratum E1): the other three are single-valued for a
 * question, so a ref the model invented for them is ignored rather than treated as a mismatch.
 */
function sourceText(source: Source, question: SupervisorQuestion, world: SupervisorWorld): string | null {
  switch (source.kind) {
    case 'task': {
      // Nulls as empty strings, joined by the newline the prompt showed them across -- so a quote
      // that runs from the title into the description still verifies once whitespace collapses.
      const text = `${question.taskTitle ?? ''}\n${question.taskDescription ?? ''}`
      return normalise(text) === '' ? null : text
    }
    case 'goal':
      return world.goal === null || normalise(world.goal) === '' ? null : world.goal
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
      return message?.body ?? null
    }
  }
}

/**
 * Sorts an answer's citations into the ones that check out and the ones that do not (M39 §3).
 *
 * Order is preserved on both sides, so a draft shows a human the model's own citation order rather
 * than a reshuffled one. A missing source is `no_such_source` (the record has no goal, no task, no
 * recorded run context); a `message` citation naming an id that is not in the thread -- or naming
 * none at all -- is `unknown_ref`, since the model pointed at something rather than nothing;
 * everything else that fails is `quote_not_found`.
 *
 * One `message` ref is rejected on principle rather than for being absent: THE QUESTION'S OWN id.
 * The question is not evidence for its own answer -- it is in the thread, so quoting it would
 * verify, and an answer built out of the words it was asked in would go out automatically. It is
 * reported as `unknown_ref`, the reason for every message citation that points nowhere usable.
 */
export function verifySources(
  sources: readonly Source[],
  question: SupervisorQuestion,
  world: SupervisorWorld,
): SourceCheck {
  const verified: Source[] = []
  const rejected: { source: Source; reason: RejectionReason }[] = []

  for (const source of sources) {
    const text = sourceText(source, question, world)
    if (text === null) {
      rejected.push({ source, reason: source.kind === 'message' ? 'unknown_ref' : 'no_such_source' })
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
