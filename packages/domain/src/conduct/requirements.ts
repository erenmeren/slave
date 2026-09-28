import { z } from 'zod'
import { sanitisePersonText } from '../handoff/contract.js'
import { err, ok, type Result } from '../result.js'
import { firstJsonObject } from '../supervisor/prompt.js'
import { REQUIREMENT_TEXT_MAX_CHARS, REQUIREMENTS_MAX_ITEMS } from './constants.js'

/**
 * The key the requirements answer is read back by (spec R1). Also a fake-CLI routing literal
 * (`ROUTING_LITERALS`), so a goal that quotes it cannot steer the call.
 */
export const REQUIREMENTS_ANSWER_KEY = 'requirementsAnswer'

export interface RequirementItem {
  readonly key: string
  readonly text: string
  /** The goal sentence the item came from, quoted -- the person checks the extraction against it. */
  readonly source: string
}

export interface RequirementDraft {
  readonly text: string
  readonly source: string
}

export const requirementItemsSchema = z
  .array(z.object({ key: z.string().regex(/^R[1-9][0-9]*$/u), text: z.string().min(1), source: z.string() }))
  .readonly()

const draftSchema = z.object({
  text: z.string().trim().min(1).max(REQUIREMENT_TEXT_MAX_CHARS),
  source: z.string().trim().max(REQUIREMENT_TEXT_MAX_CHARS),
})
const answerSchema = z.object({
  [REQUIREMENTS_ANSWER_KEY]: z.array(z.unknown()).min(1).max(REQUIREMENTS_MAX_ITEMS),
})

/** Whitespace collapsed, case folded: what "textually equal" means for R1's stable keys. */
function normalise(text: string): string {
  return text.trim().replace(/\s+/gu, ' ').toLowerCase()
}

/**
 * The prompt that turns a goal into requirements (spec R1). No approval step follows (ruling 6),
 * so the rules are the whole quality bar: one testable statement each, from the goal, nothing
 * invented. The goal goes through {@link sanitisePersonText} (controller ruling 4) so neither a
 * quoted worker-protocol marker nor a quoted routing literal inside it routes or reopens anything.
 */
export function buildRequirementsPrompt(goal: string): string {
  return [
    'You turn a software goal into its list of requirements. A requirement is one testable',
    'statement a reviewer can check against the finished work.',
    '',
    'Rules:',
    '- Each item is one testable statement, quoted or paraphrased from the goal.',
    '- Do not invent scope: no requirement the goal does not state or clearly imply.',
    `- Between 1 and ${REQUIREMENTS_MAX_ITEMS} items. Merge trivial ones; split a sentence that states two checks.`,
    '- "source" is the goal sentence the item came from, copied exactly.',
    '',
    'The goal:',
    '<<<GOAL',
    sanitisePersonText(goal),
    'GOAL>>>',
    '',
    'Answer with one JSON object and nothing after it:',
    `{"${REQUIREMENTS_ANSWER_KEY}": [{"text": "...", "source": "..."}]}`,
  ].join('\n')
}

/** Reads the model's answer: the items, trimmed, exact duplicates dropped, or why not. */
export function parseRequirementsAnswer(text: string): Result<readonly RequirementDraft[], string> {
  const json = firstJsonObject(text)
  if (json === null) return err('the answer carried no JSON object')
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return err('the answer\'s JSON did not parse')
  }
  const answer = answerSchema.safeParse(value)
  if (!answer.success) {
    return err(`the answer must be {"${REQUIREMENTS_ANSWER_KEY}": [1..${REQUIREMENTS_MAX_ITEMS} items]}`)
  }
  const drafts: RequirementDraft[] = []
  const seen = new Set<string>()
  for (const [index, raw] of answer.data[REQUIREMENTS_ANSWER_KEY].entries()) {
    const item = draftSchema.safeParse(raw)
    if (!item.success) return err(`item ${index + 1} needs a non-empty "text" of at most ${REQUIREMENT_TEXT_MAX_CHARS} characters`)
    const text = item.data.text.replace(/\s+/gu, ' ')
    if (seen.has(normalise(text))) continue
    seen.add(normalise(text))
    drafts.push({ text, source: item.data.source })
  }
  return ok(drafts)
}

/**
 * Keys for a new set (spec R1: "items that are textually equal keep their key"). A new item gets
 * the next number after the HIGHEST key the previous set used, never a retired one's number: a
 * report that said "R3 failed" must not later mean a different requirement.
 */
export function assignRequirementKeys(
  drafts: readonly RequirementDraft[],
  previous: readonly RequirementItem[] | null,
): readonly RequirementItem[] {
  const byText = new Map((previous ?? []).map((item) => [normalise(item.text), item.key] as const))
  let next = Math.max(0, ...(previous ?? []).map((item) => Number(item.key.slice(1)))) + 1
  const used = new Set<string>()
  return drafts.map((draft) => {
    const text = draft.text.trim().replace(/\s+/gu, ' ')
    const kept = byText.get(normalise(draft.text))
    if (kept !== undefined && !used.has(kept)) {
      used.add(kept)
      return { key: kept, text, source: draft.source }
    }
    const key = `R${next}`
    next += 1
    return { key, text, source: draft.source }
  })
}
