import { z } from 'zod'
import type { HandoffContract } from '../handoff/contract.js'
import { neutraliseMarkers } from '../run-context/render.js'
import {
  ANSWER_MAX_CHARS,
  RUN_PROMPT_MAX_CHARS,
  SOURCES_MAX,
  SOURCE_QUOTE_MAX_CHARS,
  THREAD_BODY_MAX_CHARS,
} from './constants.js'
import { PROFILE_HEADING, firstJsonObject } from './prompt.js'
import { boundThread, type SupervisorQuestion, type SupervisorWorld, type ThreadMessage } from './world.js'

/**
 * The four places an answer may come from (M39 §1). Closed, and each one is a text the loader
 * already put in the world: the model cannot cite a file, a web page or its own memory, because
 * `verifySources` has nothing to check such a citation against.
 */
export const SOURCE_KINDS = ['task', 'goal', 'run_context', 'message'] as const

/**
 * One citation: where the answer came from, and the words it came from.
 *
 * `ref` matters only for `kind: 'message'`, where it is the thread message id (erratum E1) -- the
 * other three sources are single-valued for a question (its task, its workspace's goal, its asker's
 * recorded run context), so there is nothing for a ref to disambiguate and a model cannot know a
 * task id to write one anyway. It stays on every source so a stored draft has one shape.
 */
export interface Source {
  readonly kind: (typeof SOURCE_KINDS)[number]
  readonly ref: string | null
  readonly quote: string
}

/**
 * Validates one citation. Input is `unknown` -- a `ref` that is missing, null OR EMPTY becomes
 * `null` rather than a refusal, since erratum E1 makes it meaningless for three of the four kinds:
 * a model that wrote `"ref": ""` for a `task` citation said nothing wrong, and failing the parse
 * would throw away a whole well-sourced answer over a field that source kind ignores. An empty ref
 * on a `message` citation is the same as no ref -- `verifySources` rejects it as `unknown_ref`.
 */
export const sourceSchema: z.ZodType<Source, z.ZodTypeDef, unknown> = z.object({
  kind: z.enum(SOURCE_KINDS),
  ref: z
    .string()
    .nullish()
    .transform((ref) => (ref === undefined || ref === null || ref === '' ? null : ref)),
  quote: z.string().min(1).max(SOURCE_QUOTE_MAX_CHARS),
})

/** What the answer call asks the model for, once it has parsed. Nothing here is trusted: the
 *  quotes are verified in code and the tier comes from `answerTier`, never from `critical`. */
export interface ModelAnswer {
  readonly answer: string
  readonly sources: readonly Source[]
  /** The model's own "a human should handle this". A SECOND signal beside the lexicon, never a
   *  substitute for it -- and only ever consulted when an answer call actually happened (E2). */
  readonly critical: boolean
}

/**
 * What a decision row keeps about an answer it drafted (M39 §2): everything a human needs to
 * approve, edit or refuse it without re-running the call, and everything a reader needs months
 * later to see why it went out immediately or waited.
 */
export interface Draft {
  /** The answer text, or null when no call was made at all -- the shape erratum E2 writes for a
   *  question the lexicon stopped before the model ever saw it. */
  readonly body: string | null
  /** The citations that VERIFIED. A `sourced` draft has at least one and no rejections. */
  readonly sources: readonly Source[]
  /** The citations that did not, with the reason -- kept because "the model quoted something that
   *  is not there" is the single most useful thing a human can know when judging a draft. */
  readonly rejectedSources: readonly { readonly source: Source; readonly reason: string }[]
  readonly critical: { readonly lexicon: readonly string[]; readonly model: boolean }
  readonly confidence: 'sourced' | 'interpretation'
  /**
   * What a human typed instead, recorded at approval time; absent until then.
   *
   * Spelt `| undefined` because `exactOptionalPropertyTypes` is on and {@link draftSchema} is the
   * type's other half: a zod `.optional()` field infers `string | undefined`, and a `Draft` that
   * could not be validated by its own schema would be a type nobody could safely read a row into.
   */
  readonly editedBody?: string | undefined
}

/** Validates a `SupervisorDecision.draft` `Json` value at read, the way `actionSchema` validates
 *  the action beside it -- a hand-edited or pre-migration row must not crash the panel or the CLI. */
export const draftSchema: z.ZodType<Draft, z.ZodTypeDef, unknown> = z.object({
  // Both bodies carry the same cap the model's own answer was held to. `body` is what
  // `answerQuestion` sends and `editedBody` is what a human sent instead; a row that stored more
  // than `ANSWER_MAX_CHARS` would be a way past the one limit on how much text reaches a worker.
  // `body` stays NULLABLE -- erratum E2's escalated draft has no body at all.
  body: z.string().max(ANSWER_MAX_CHARS).nullable(),
  sources: z.array(sourceSchema),
  rejectedSources: z.array(z.object({ source: sourceSchema, reason: z.string().min(1) })),
  critical: z.object({ lexicon: z.array(z.string().min(1)), model: z.boolean() }),
  confidence: z.enum(['sourced', 'interpretation']),
  editedBody: z.string().max(ANSWER_MAX_CHARS).optional(),
})

/** `text` at most `max` characters. The loader caps too; this is the cap that actually bounds the
 *  call, applied where the prompt is built rather than trusted from upstream. The question's own
 *  body is capped by the same rule as a thread message's: it IS one, and a worker that pasted a
 *  file into its question must not be able to spend the whole call on it. */
function cap(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/** A source the loader did not fill says so, in the prompt, in words -- a heading with nothing
 *  under it reads as "there was nothing to say", which is how a model comes to invent one. */
const NONE = 'none recorded'

function threadLines(thread: readonly ThreadMessage[]): string {
  if (thread.length === 0) return `  ${NONE}`
  return thread
    .map(
      (message) =>
        `  [${message.messageId}] ${message.kind} from ${message.senderSlaveId ?? 'the system'}:\n    ${cap(message.body, THREAD_BODY_MAX_CHARS)}`,
    )
    .join('\n')
}

function rosterLines(world: SupervisorWorld): string {
  if (world.slaves.length === 0) return `  ${NONE}`
  return world.slaves
    .map(
      (slave) =>
        `  - ${slave.name} (${slave.id}), titled "${slave.role}", roles: ${slave.runtimeRoles.length === 0 ? 'none' : slave.runtimeRoles.join(', ')}${slave.busy ? ', busy' : ''}`,
    )
    .join('\n')
}

/** The handoff lines the `task` source shows (M48 R4), or nothing. Kept as its own function because
 *  `sourceText` in `./sourced.ts` must be able to join EXACTLY these lines: what the prompt shows
 *  under a SOURCE heading is what a quote may be taken from (plan erratum E8). */
export function handoffSourceLines(handoff: HandoffContract | null): readonly string[] {
  if (handoff === null) return []
  return [
    `  objective: ${handoff.objective}`,
    `  expected output: ${handoff.expectedOutput}`,
    ...(handoff.acceptanceCriteria.length === 0
      ? []
      : [`  acceptance criteria: ${handoff.acceptanceCriteria.join('; ')}`]),
  ]
}

/**
 * The SECOND model call of a supervised question (M39 §3): not "which action", but "what is the
 * answer, and where in the record did you find it".
 *
 * Everything the model may quote is in this prompt, and nothing else is: the question, the asking
 * task, the workspace goal, the thread, and the asker run's own recorded context. That is not a
 * politeness -- {@link verifySources} checks every quote against exactly these texts, so a source
 * the prompt did not show is a source no answer can be built on.
 *
 * The literal `"sources"` is load-bearing twice over: it is the key {@link parseAnswer} reads back,
 * and the string the fake CLI's answer arm keys on to tell this call from the choose-a-candidate
 * call (erratum E3). A rewrite that phrased it away would silently break both.
 *
 * The whole prompt goes through `neutraliseMarkers` (M37), like {@link buildDecisionPrompt}: every
 * text in it -- the question body, the task, the goal, the thread, the run prompt, the operator's
 * profile -- was written by somebody else, and none of it may be able to close a `<slave-ask>` or
 * `<slave-answer>` block. This prompt teaches no markers of its own, so there is nothing the pass
 * can damage.
 */
export function buildAnswerPrompt(input: {
  question: SupervisorQuestion
  world: SupervisorWorld
  profile: string | null
}): string {
  const { question, world, profile } = input
  const blocks: string[] = [
    'You are the Supervisor of an AI workspace. One worker asked another a question and nobody has',
    'answered it. Answer it yourself -- but ONLY from the recorded context below, and quote the',
    'exact words you took each part of your answer from. Every quote is checked against the source',
    'you name; an answer whose quotes do not check out is held back for a human instead of sent.',
    '',
  ]

  if (profile !== null && profile !== '') blocks.push(PROFILE_HEADING, profile, '')

  blocks.push(
    'QUESTION',
    `  from: ${question.askerSlaveId}`,
    `  to: ${question.recipientSlaveId ?? (question.recipientRole === null ? 'nobody' : `the "${question.recipientRole}" role`)}`,
    `  body: ${cap(question.body, THREAD_BODY_MAX_CHARS)}`,
    '',
    'SOURCE "task" -- the task the asker is working on',
    `  title: ${question.taskTitle ?? NONE}`,
    `  description: ${question.taskDescription ?? NONE}`,
    ...handoffSourceLines(question.taskHandoff),
    '',
    'SOURCE "goal" -- the workspace goal',
    `  ${world.goal ?? NONE}`,
    '',
    'SOURCE "run_context" -- the instructions the asker was given for this run',
    `  ${question.askerRunPrompt === null ? NONE : cap(question.askerRunPrompt, RUN_PROMPT_MAX_CHARS)}`,
    '',
    'SOURCE "message" -- the thread, oldest first; cite one by its [id]. Do NOT cite ANYTHING the',
    `asker (${question.askerSlaveId}) wrote -- neither the question itself nor any earlier message`,
    'of its own: what the asker said is not evidence for its own answer, and such a citation is',
    'thrown away.',
    threadLines(boundThread(question.thread, question.messageId)),
    '',
    'ROSTER (context only -- never a source)',
    rosterLines(world),
    '',
    'Reply with exactly one JSON object and nothing else on its line:',
    '{"answer": "...", "sources": [{"kind": "task" | "goal" | "run_context" | "message", "ref": "<message id, or null>", "quote": "..."}], "critical": false}',
    '',
    `Keep the answer under ${ANSWER_MAX_CHARS} characters and cite at most ${SOURCES_MAX} sources, each quote at most ${SOURCE_QUOTE_MAX_CHARS} characters and copied VERBATIM from the source you name.`,
    'Set "critical" to true if answering this needs a human: a change of scope, permissions or credentials, secrets, money, anything destructive, or contact with anyone outside the workspace.',
    'If the record does not answer the question, say so plainly in "answer" and cite nothing.',
  )

  return neutraliseMarkers(blocks.join('\n'))
}

/**
 * Reads the answer call's reply, or refuses it (M39 §3). `null` means "the model did not answer" --
 * the caller escalates by rules rather than sending anything, which is what keeps a truncated or
 * malformed reply from becoming a message another worker acts on.
 *
 * Like {@link parseDecisionAnswer}, only the FIRST JSON object is considered: a model that printed
 * a malformed answer must not get a second go at the same prompt.
 *
 * An answer with NO sources parses cleanly. That is not an oversight -- "the record does not say"
 * is a real answer, and it is `verifySources`/`isSourced` that turn an uncited answer into an
 * interpretation a human approves, not the parser.
 */
export function parseAnswer(text: string): ModelAnswer | null {
  const source = firstJsonObject(text)
  if (source === null) return null

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return null
  }

  const schema = z.object({
    answer: z.string().trim().min(1).max(ANSWER_MAX_CHARS),
    sources: z.array(sourceSchema).max(SOURCES_MAX),
    critical: z.boolean(),
  })
  const parsed = schema.safeParse(value)
  if (!parsed.success) return null
  return { answer: parsed.data.answer, sources: parsed.data.sources, critical: parsed.data.critical }
}
