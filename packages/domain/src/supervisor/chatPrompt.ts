import { z } from 'zod'
import { neutraliseMarkers } from '../run-context/render.js'
import { ACTION_KINDS, actionSchema, type Action, type ActionKind } from './actions.js'
import { sourceSchema, type SourceCitation } from './answerPrompt.js'
import { SOURCES_MAX } from './constants.js'
import { PROFILE_HEADING, firstJsonObject, workspaceLines } from './prompt.js'
import type { SupervisorWorld } from './world.js'

/**
 * The literal the reply must be keyed on, the parser reads back ({@link parseSupervisorReply}) and
 * the fake CLI keys its chat arm on -- the same three-way contract `"candidateIndex"` has carried
 * since M38 and `"intakeAnswer"` since M59.
 */
export const SUPERVISOR_CHAT_MARKER = '"supervisorReply"'

/** How many turns of the conversation the prompt carries (R2). Twelve is six exchanges: enough
 *  that "the one I mentioned earlier" still resolves, short enough that a long-running project's
 *  thread never becomes the whole call. */
export const CHAT_HISTORY_MAX = 12

/** How many feed sentences the prompt carries (R2) -- "what has been happening", not a log. */
export const CHAT_FEED_MAX = 20

/** How much of ONE text attachment is inlined (R6). */
export const CHAT_ATTACHMENT_CHARS = 20_000

/** How much of ALL of them is, together (R6). The per-file cap is not the bound that matters: five
 *  files under it would still be a hundred thousand characters of somebody else's text in one
 *  call, and the total is what actually bounds what a person can spend by dragging files in. */
export const CHAT_ATTACHMENTS_TOTAL_CHARS = 60_000

/**
 * One file a person attached to a message (R6). It lives in the repository, under
 * `docs/inbox/`, which is why the path is the whole identity of it: the Supervisor quotes it by
 * path and a worker later reads it by path, from the same checkout.
 *
 * `text` is present only for `kind: 'text'`, and only when the loader read it -- an image or a
 * binary is named in the prompt and never inlined, and `verifySources` refuses a citation of one
 * for exactly that reason.
 */
export interface ChatAttachment {
  readonly path: string
  readonly name: string
  readonly bytes: number
  readonly kind: 'text' | 'image' | 'binary'
  readonly text?: string
}

/**
 * Everything one chat turn is built from (R2). Assembled by control from the workspace's own rows;
 * nothing here is read from a clock, a database or a filesystem by this file.
 */
export interface ChatTurnInput {
  /** goal, tasks, slaves, questions, decisions, halted, autonomy -- the same world every other
   *  Supervisor call reads. */
  readonly world: SupervisorWorld
  readonly profile: string | null
  /** The workspace feed, oldest first or newest first -- {@link buildSupervisorChatPrompt} orders
   *  it by `seq` itself, so a caller cannot change what the model reads by handing it a list the
   *  other way round. */
  readonly feed: readonly { readonly seq: number; readonly sentence: string }[]
  readonly needsYou: readonly string[]
  readonly history: readonly { readonly role: 'human' | 'supervisor'; readonly text: string }[]
  /** The message this turn is answering. Not in {@link history} -- it is the last line of the
   *  conversation, and the prompt is what puts it there. */
  readonly message: string
  readonly attachments: readonly ChatAttachment[]
  /** R7: true when this call runs with the read-only tools (`Read,Glob,Grep`). The prompt only
   *  offers to open an image when it is -- a model told it may read a file it cannot read answers
   *  by guessing, which is worse than saying it cannot see the picture. */
  readonly imagesReadable: boolean
}

/**
 * THE ONE TABLE (R3): every {@link ActionKind}, and the JSON a reply writes to ask for it.
 *
 * Generated from `ACTION_KINDS` rather than hand-listed in the prompt, and held to it by a test:
 * an action kind added later and forgotten here is one the Supervisor can take on a tick and
 * cannot be asked for in the conversation -- silently, and forever, because nothing else in the
 * build would notice.
 *
 * The shapes are the ACTION's own fields, exactly as `actionSchema` validates them. A model that
 * writes one this table does not describe has its action dropped with a sentence, never guessed at.
 *
 * EVERY kind is here, including the ones the rules usually raise by themselves: a person may ask
 * for any of them in words, and a vocabulary that left some out would be a Supervisor that can do
 * a thing on a tick and cannot be asked to do it. `answer_question` is the one to watch when this
 * is wired up: the answer path's tier comes from a DRAFT a second model call wrote (`answerTier`),
 * and a conversation proposes it with none -- so whoever carries it out settles what an
 * `answer_question` with no draft means.
 */
export const ACTION_SHAPES: Readonly<Record<ActionKind, string>> = {
  unblock_task: '{"kind": "unblock_task", "taskId": "<task id>"}',
  raise_max_attempts: '{"kind": "raise_max_attempts", "taskId": "<task id>"}',
  set_runtime_roles: '{"kind": "set_runtime_roles", "slaveId": "<worker id>", "roles": ["<role>"]}',
  assign_capability:
    '{"kind": "assign_capability", "slaveId": "<worker id>", "capability": "<key>", "capabilityLabel": "<words>", "role": "<role>"}',
  materialise_company_worker:
    '{"kind": "materialise_company_worker", "personId": "<person id>", "capability": "<key>", "capabilityLabel": "<words>", "name": "<their name>", "rationale": "<why them>"}',
  hire_from_catalog:
    '{"kind": "hire_from_catalog", "templateId": "<template id>", "capability": "<key>", "capabilityLabel": "<words>", "name": "<their name>", "rationale": "<why>", "temporary": false, "engagementTaskId": null}',
  adopt_runbook:
    '{"kind": "adopt_runbook", "runbookId": "<runbook id>", "key": "<key>", "name": "<name>", "rationale": "<why>"}',
  answer_question: '{"kind": "answer_question", "messageId": "<question id>"}',
  reassign_question: '{"kind": "reassign_question", "messageId": "<question id>", "toSlaveId": "<worker id>"}',
  mark_task_failed: '{"kind": "mark_task_failed", "taskId": "<task id>", "reason": "<why>"}',
  cancel_task: '{"kind": "cancel_task", "taskId": "<task id>", "reason": "<why>"}',
  discard_stale_candidates:
    '{"kind": "discard_stale_candidates", "workspaceId": "<this project id>", "count": <how many>}',
  release_worker: '{"kind": "release_worker", "slaveId": "<worker id>", "name": "<their name>", "reason": "<why>"}',
  steer_run: '{"kind": "steer_run", "runId": "<run id>", "slaveId": "<worker id>", "text": "<one sentence>"}',
  request_permission:
    '{"kind": "request_permission", "slaveId": "<worker id>", "name": "<their name>", "permissionKind": "<operation>", "kindLabel": "<words>", "why": "<why>"}',
  retry_task: '{"kind": "retry_task", "taskId": "<task id>", "title": "<its title>", "reason": "<why>"}',
  retry_review: '{"kind": "retry_review", "taskId": "<task id>", "title": "<its title>", "reason": "<why>"}',
  clear_halt: '{"kind": "clear_halt", "workspaceId": "<this project id>", "reason": "<why>"}',
  request_goal_change: '{"kind": "request_goal_change", "request": "<what they asked for, in their words>"}',
  note_for_planner: '{"kind": "note_for_planner", "text": "<the line the next planner should read>"}',
  escalate_to_human: '{"kind": "escalate_to_human", "summary": "<what a person must decide>"}',
  no_action: '{"kind": "no_action"}',
}

/** A heading with nothing under it reads as "there was nothing to say", which is how a model comes
 *  to invent one -- `buildAnswerPrompt`'s own rule, in the words each section needs. */
function noneLine(words: string): string {
  return `  ${words}`
}

/** `text` at most `max` characters. The cap that actually bounds the CALL is applied where the
 *  prompt is built, never trusted from upstream. */
function cap(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/** How long ago, in the coarsest unit that is still true. The model is being asked to notice that
 *  something has been sitting for two days, not to do arithmetic on epoch milliseconds. */
function ago(now: number, at: number): string {
  const elapsed = now - at
  if (elapsed < 60_000) return 'just now'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `${String(minutes)}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${String(hours)}h ago`
  return `${String(Math.floor(hours / 24))}d ago`
}

/**
 * The BOARD digest: one line per task, `id/title — status — who — since`.
 *
 * The id leads because it is the only thing the model may write back: an action names a task by
 * id, and `parseSupervisorReply` drops one that names anything else. "Who" is read off the runs
 * in flight first (a task being worked on has somebody on it right now) and off a hand-assignment
 * second, by NAME -- a person reading the reply knows their colleagues by name, and the ids are in
 * this same line for the machine.
 */
function boardLines(world: SupervisorWorld): readonly string[] {
  if (world.tasks.length === 0) return [noneLine('nothing on the board yet')]
  const nameOf = (slaveId: string): string => world.slaves.find((one) => one.id === slaveId)?.name ?? slaveId
  return world.tasks.map((task) => {
    const run = world.runs.find((one) => one.taskId === task.id)
    const who = run !== undefined ? nameOf(run.slaveId) : task.assigneeId === null ? 'nobody' : nameOf(task.assigneeId)
    return `  ${task.id}/${task.title} — ${task.status} — ${who} — ${ago(world.now, task.statusSince)}`
  })
}

/**
 * The ATTACHMENTS section (R6/R7). Text is inlined under its own path; everything else is named
 * by path, kind and size, because a worker can open it later from the same checkout.
 *
 * The two caps are spent in the order the person attached the files, and a file the budget no
 * longer has room for is named rather than dropped: "there is a fourth file and I could not read
 * it" is a true thing to tell a model, and silence about it is not.
 */
function attachmentLines(attachments: readonly ChatAttachment[], imagesReadable: boolean): readonly string[] {
  if (attachments.length === 0) return [noneLine('none')]
  const lines: string[] = []
  let spent = 0
  let anyImage = false
  for (const attachment of attachments) {
    if (attachment.kind === 'image') anyImage = true
    const room = Math.min(CHAT_ATTACHMENT_CHARS, CHAT_ATTACHMENTS_TOTAL_CHARS - spent)
    const body = attachment.kind === 'text' && attachment.text !== undefined ? cap(attachment.text, room) : ''
    if (body === '') {
      const why = attachment.kind === 'text' ? ', not inlined -- the attachment budget is full' : ''
      lines.push(`  ${attachment.path} (${attachment.kind}, ${String(attachment.bytes)} bytes${why})`)
      continue
    }
    spent += body.length
    const truncated = body.length < (attachment.text?.length ?? 0) ? '\n... (truncated)' : ''
    lines.push(`--- ${attachment.path} ---`, `${body}${truncated}`)
  }
  lines.push('', 'Workers can read these by path.')
  // R7: only when the call really runs the read-only tools, and only when there is an image to
  // open. Every other turn is text-only, and a model told otherwise describes a picture it never saw.
  if (imagesReadable && anyImage) lines.push('You may open an image with Read.')
  return lines
}

/** Who said a line, as the model reads it -- the intake prompt's own two words. */
const SPEAKER: Record<ChatTurnInput['history'][number]['role'], string> = {
  human: 'PERSON',
  supervisor: 'YOU',
}

/**
 * The prompt one turn of the Supervisor conversation sends (R2).
 *
 * Unlike `buildDecisionPrompt`, this one does NOT ask for an index into a rule-built catalogue: a
 * conversation cannot be a menu, because the person is the one who says what the subject is. What
 * keeps the model's output from writing anything anyway is the other half of R3 -- every action it
 * names is validated by `actionSchema`, checked against the world by {@link parseSupervisorReply},
 * recorded as a `SupervisorDecision` under `operator_request`, and applied only at the tier
 * `tierOf` gives it. The conversation borrows the Supervisor's authority; it gets none of its own.
 *
 * The WHOLE prompt goes through `neutraliseMarkers` (M37), `buildDecisionPrompt`'s own rule and
 * for its own reason: the profile is operator-written, the message is a person's, an attachment is
 * a file somebody uploaded and a feed sentence was written by another model -- and none of it may
 * be able to close a `<slave-ask>`/`<slave-answer>` block. This prompt teaches no markers of its
 * own, so there is nothing the pass can damage.
 */
export function buildSupervisorChatPrompt(input: ChatTurnInput): string {
  const { world, profile, needsYou, message, attachments, imagesReadable } = input
  const blocks: string[] = [
    'You are the Supervisor of this project, talking to the person who owns it. Answer them.',
    'Everything you know about the project is below; you have no memory of this conversation',
    'beyond what it shows you. Write in the language they wrote in.',
    '',
  ]

  if (profile !== null && profile !== '') blocks.push(PROFILE_HEADING, profile, '')

  const feed = [...input.feed].sort((a, b) => a.seq - b.seq).slice(-CHAT_FEED_MAX)
  const history = input.history.slice(-CHAT_HISTORY_MAX)

  blocks.push(
    ...workspaceLines(world),
    '',
    'BOARD',
    ...boardLines(world),
    '',
    'NEEDS YOU',
    ...(needsYou.length === 0 ? [noneLine('nothing is waiting on a person')] : needsYou.map((line) => `  - ${line}`)),
    '',
    'RECENT',
    ...(feed.length === 0
      ? [noneLine('nothing has happened here yet')]
      : feed.map((line) => `  [${String(line.seq)}] ${line.sentence}`)),
    '',
    'ATTACHMENTS',
    ...attachmentLines(attachments, imagesReadable),
    '',
    'CONVERSATION',
    ...history.map((line) => `${SPEAKER[line.role]}: ${line.text}`),
    `PERSON: ${message}`,
    '',
    'ACTION VOCABULARY',
    'These are the only things you can ask this system to do. Each one names a row by its id, and',
    'an id that is not shown above is dropped before it reaches anything.',
    ...ACTION_KINDS.map((kind) => `  ${ACTION_SHAPES[kind]}`),
    '',
    'Reply with exactly one JSON object and nothing else on its line:',
    `{${SUPERVISOR_CHAT_MARKER}: {"text": "<your answer to them>", "actions": [], "sources": [{"kind": "task" | "goal" | "feed" | "message" | "attachment", "ref": "<task id, feed seq, message id or attachment path, or null>", "quote": "..."}]}}`,
    '',
    'Put an action in "actions" ONLY when the person asked for a change. A question about the',
    'project is answered in "text" and nothing else: an action they did not ask for is a decision',
    'card they have to dismiss. Most turns carry none.',
    'Some actions are carried out at once and some wait for the person to approve them; which is',
    'which is a setting on this project rather than something you decide, so never promise that a',
    'thing is already done.',
    `Cite what you took each claim from in "sources", at most ${String(SOURCES_MAX)} of them, each quote copied VERBATIM from the board, the goal, a feed sentence or an attachment above. An answer that quotes nothing is still an answer -- this is a conversation, not a report.`,
  )

  return neutraliseMarkers(blocks.join('\n'))
}

/**
 * What one reply came to, once it has been read and checked against the world (R2/R3).
 *
 * `dropped` are SENTENCES, not codes: control appends them to the reply text, so the person reads
 * "an action named a task that is not on the board: t-99" under the answer rather than silently
 * getting one card fewer than the model wrote.
 */
export interface ParsedReply {
  readonly text: string
  readonly actions: readonly Action[]
  readonly dropped: readonly string[]
  readonly sources: readonly SourceCitation[]
}

/**
 * The envelope. `text` is REQUIRED (a reply carries one, even when it is empty), while `actions`
 * and `sources` default to empty: most turns are an answer and nothing else, and a model that left
 * the keys out said so rather than failed.
 *
 * Each action is `unknown` here on purpose. Validating the array against `actionSchema` would make
 * ONE unreadable action throw away the whole reply -- the answer, the other actions and all -- and
 * the person would be told the Supervisor failed to reply when it had. They are checked one by one
 * below instead, and the ones that do not stand become a sentence.
 */
const envelopeSchema = z.object({
  supervisorReply: z.object({
    text: z.string(),
    actions: z.array(z.unknown()).default([]),
    sources: z.array(z.unknown()).default([]),
  }),
})

/** What a person is told about an action that never became one. Two sentences rather than one,
 *  because "there is no such verb" and "the verb is right and the details are missing" are
 *  different facts about what the Supervisor tried to do. */
function notAnAction(raw: unknown): string {
  const kind = typeof raw === 'object' && raw !== null ? (raw as { kind?: unknown }).kind : undefined
  if (typeof kind !== 'string' || kind === '') return 'the reply carried something that is not an action at all'
  if (!(ACTION_KINDS as readonly string[]).includes(kind)) {
    return `the reply asked for something this Supervisor cannot do: ${kind}`
  }
  return `the reply asked for "${kind}" without the details it needs`
}

/**
 * The one row an action names and the world does not hold, as a sentence -- or null when every id
 * on it is real.
 *
 * This is the whole of what stops a conversation from moving a task on another project: a model
 * writes ids, and an id it was not shown is an id it invented. Checked HERE rather than at apply
 * time as well as at apply time: `carryOut` refuses a missing row anyway, but a decision card
 * offering to cancel a task that does not exist is a card a person has to read and reject.
 *
 * The staffing ids (`templateId`, `runbookId`, `personId`) are deliberately NOT checked: the loader
 * fills `pool`, `catalog` and `runbooks` only under a staffing gate, so their absence from this
 * world is not evidence that the row is absent from the database.
 */
function unknownReference(action: Action, world: SupervisorWorld): string | null {
  const noSuchWorker = (id: string): string => `an action named somebody who is not on this project: ${id}`
  if ('taskId' in action && !world.tasks.some((task) => task.id === action.taskId)) {
    return `an action named a task that is not on the board: ${action.taskId}`
  }
  if ('slaveId' in action && !world.slaves.some((slave) => slave.id === action.slaveId)) {
    return noSuchWorker(action.slaveId)
  }
  if ('toSlaveId' in action && !world.slaves.some((slave) => slave.id === action.toSlaveId)) {
    return noSuchWorker(action.toSlaveId)
  }
  if ('messageId' in action && !world.questions.some((question) => question.messageId === action.messageId)) {
    return `an action named a question that is not open: ${action.messageId}`
  }
  if ('runId' in action && !world.runs.some((run) => run.id === action.runId)) {
    return `an action named a run that is not going on: ${action.runId}`
  }
  if ('workspaceId' in action && action.workspaceId !== world.workspaceId) {
    return `an action named a project that is not this one: ${action.workspaceId}`
  }
  // The grant a retry may ride with names a worker of its own (R3), and it is the half of that
  // action that actually changes what somebody may do.
  if (action.kind === 'retry_task' && action.grant !== undefined) {
    const granted = action.grant.slaveId
    if (!world.slaves.some((slave) => slave.id === granted)) return noSuchWorker(granted)
  }
  return null
}

/**
 * Reads one reply, or refuses it (R2).
 *
 * `null` means the model did not reply at all: no JSON object, nothing that parses, or an object
 * that is not this envelope. The caller records the turn as `failed` with that reason. It does NOT
 * mean "the reply did nothing" -- an envelope with an empty `actions` array is a perfectly good
 * reply, and so is one whose text is empty but whose actions stand, because throwing those away
 * would lose what the model actually decided over a field the panel could render blank.
 *
 * Only the FIRST JSON object is considered, `firstJsonObject`'s own rule and for its own reason: a
 * model that printed a malformed reply first must not get a second go at the same prompt.
 *
 * The sources come back RAW. Verifying them needs the feed and the attachments this turn was built
 * from, which control holds and this function is not given -- it runs `verifySources` with them
 * once the reply is in hand.
 */
export function parseSupervisorReply(text: string, world: SupervisorWorld): ParsedReply | null {
  const source = firstJsonObject(text)
  if (source === null) return null

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return null
  }

  const parsed = envelopeSchema.safeParse(value)
  if (!parsed.success) return null
  const reply = parsed.data.supervisorReply

  const actions: Action[] = []
  const dropped: string[] = []
  for (const raw of reply.actions) {
    const action = actionSchema.safeParse(raw)
    if (!action.success) {
      dropped.push(notAnAction(raw))
      continue
    }
    const missing = unknownReference(action.data, world)
    if (missing !== null) {
      dropped.push(missing)
      continue
    }
    actions.push(action.data)
  }

  // A citation that will not even parse is simply not a citation: it names nothing this system
  // could check, so it is left out rather than reported. `verifySources` rejects the rest by name.
  const sources = reply.sources
    .map((raw) => sourceSchema.safeParse(raw))
    .flatMap((result) => (result.success ? [result.data] : []))
    .slice(0, SOURCES_MAX)

  return { text: reply.text.trim(), actions, dropped, sources }
}
