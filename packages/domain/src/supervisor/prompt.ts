import { z } from 'zod'
import { neutraliseMarkers } from '../run-context/render.js'
import type { Candidate } from './actions.js'
import type { Situation } from './situations.js'
import type { SupervisorWorld } from './world.js'

/** The heading the workspace's `supervisorProfile` is rendered under, when it has one. */
export const PROFILE_HEADING = 'SUPERVISOR PROFILE'

/** The longest rationale a model may hand back. Two thousand characters is a paragraph or three:
 *  enough to say why, short enough that a row and a timeline card stay readable. */
export const RATIONALE_MAX_CHARS = 2000

function factLines(facts: Situation['facts']): string {
  return Object.entries(facts)
    .map(([key, value]) => `  - ${key}: ${value === null ? 'none' : String(value)}`)
    .join('\n')
}

function candidateLines(candidates: readonly Candidate[]): string {
  return candidates
    .map((candidate, index) => {
      const { kind, ...params } = candidate.action
      const rendered = Object.keys(params).length === 0 ? '' : ` ${JSON.stringify(params)}`
      return `${index}. ${kind}${rendered}\n   effect if chosen: ${candidate.tier}\n   why: ${candidate.why}`
    })
    .join('\n')
}

/**
 * The one prompt a Supervisor model call ever sends (M38 section 3).
 *
 * It asks for an INDEX into a rule-built catalogue, never for an action: the literal
 * `"candidateIndex"` below is what {@link parseDecisionAnswer} reads back, what
 * `packages/providers/test/fake-claude.mjs` keys its supervisor arm on, and the reason a model
 * cannot widen what the Supervisor may do (spec section 1).
 *
 * The WHOLE prompt goes through `neutraliseMarkers` (M37): the profile is operator-written and the
 * situation carries task titles and question metadata written by other models, and none of it may
 * be able to close a `<slave-ask>`/`<slave-answer>` block. Unlike a run context, a supervisor
 * prompt teaches no markers of its own, so there is nothing here the pass could damage.
 */
export function buildDecisionPrompt(input: {
  situation: Situation
  candidates: readonly Candidate[]
  profile: string | null
  world: SupervisorWorld
}): string {
  const { situation, candidates, profile, world } = input
  const blocks: string[] = [
    'You are the Supervisor of an AI workspace. Something is stuck. Rules have already worked out',
    'every action that may be taken about it; your only job is to choose one of them and say why.',
    '',
  ]

  if (profile !== null && profile !== '') blocks.push(PROFILE_HEADING, profile, '')

  blocks.push(
    'WORKSPACE',
    `  id: ${world.workspaceId}`,
    `  goal: ${world.goal ?? 'none set'}`,
    `  scheduling: ${world.halted === null ? 'running' : `halted (${world.halted.reason})`}`,
    `  tasks: ${world.tasks.length}, slaves: ${world.slaves.length}, pending questions: ${world.questions.length}`,
    '',
    'SITUATION',
    `  kind: ${situation.kind}`,
    `  subject: ${situation.subjectId}`,
    `  summary: ${situation.summary}`,
    '  facts:',
    factLines(situation.facts),
    '',
    'CANDIDATE ACTIONS',
    candidateLines(candidates),
    '',
    'Reply with exactly one JSON object and nothing else on its line:',
    `{"candidateIndex": <0..${Math.max(candidates.length - 1, 0)}>, "rationale": "one short paragraph"}`,
    '',
    `Pick by index only -- an action that is not in the list above cannot be taken. Keep the rationale under ${RATIONALE_MAX_CHARS} characters.`,
  )

  return neutraliseMarkers(blocks.join('\n'))
}

/**
 * The first `{...}` object in `text`, brace-matched with string awareness so a `{` inside a quoted
 * rationale does not end the scan early. Models wrap their JSON in prose and code fences; this is
 * what lets an otherwise correct answer through without accepting free text as an answer.
 *
 * Exported for `./answerPrompt.js`, the milestone's second model call, so both parsers agree
 * exactly on what "the model's JSON" means -- including that only the FIRST object counts.
 */
export function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

/**
 * Reads a model's answer, or refuses it (M38 section 3). `null` means "the model did not answer" --
 * the caller falls back to {@link chooseByRules}, which is what keeps an unparseable, truncated or
 * out-of-range answer from becoming an action (spec section 1).
 *
 * Only the FIRST JSON object is considered. Scanning on to a later one would let a model that
 * printed a malformed or out-of-range answer first have a second go at the same prompt, which is
 * exactly the "keep trying until something lands" behaviour the index range exists to stop.
 */
export function parseDecisionAnswer(
  text: string,
  candidateCount: number,
): { candidateIndex: number; rationale: string } | null {
  const source = firstJsonObject(text)
  if (source === null) return null

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return null
  }

  const schema = z.object({
    candidateIndex: z.number().int().min(0).max(candidateCount - 1),
    rationale: z.string().trim().min(1).max(RATIONALE_MAX_CHARS),
  })
  const parsed = schema.safeParse(value)
  return parsed.success ? { candidateIndex: parsed.data.candidateIndex, rationale: parsed.data.rationale } : null
}
