import { z } from 'zod'
import { err, ok, type Result } from '../result.js'
import { neutraliseMarkers } from '../run-context/markers.js'

/**
 * The typed handoff (M48 R1): what one worker is being asked for, in fields rather than in a
 * paragraph.
 *
 * Six fields and no seventh -- the schema below is `.strict()`, so a planner that invents
 * `deadline` is refused rather than silently losing it. Dependencies are deliberately NOT here:
 * they are `TaskDependency` rows, and a second copy of them inside a JSON column is a second thing
 * to keep in step with the board.
 */
export interface HandoffContract {
  /** What this task is FOR, in one sentence. Required: a handoff with no objective is a paragraph. */
  readonly objective: string
  /** What exists when it is done -- the artefact, not the activity. Required for the same reason. */
  readonly expectedOutput: string
  /** Every condition that must hold. The reviewer reads this list; so does the worker. */
  readonly acceptanceCriteria: readonly string[]
  /** What the work may NOT do, or must work around. */
  readonly knownConstraints: readonly string[]
  /** What the worker has to leave behind as proof. NOTHING VERIFIES THIS YET -- M53 owns
   *  evidence-based ranking; this is a list the worker reads. */
  readonly evidenceRequired: readonly string[]
  /** Files, docs and ids worth reading first. */
  readonly contextReferences: readonly string[]
}

/** Every string field and every list item is capped at this. A handoff is a contract, not a brief:
 *  four hundred characters is a sentence somebody can act on, and a prompt is not the place for an
 *  essay a planner wrote instead of decomposing the work. */
export const HANDOFF_MAX_FIELD_CHARS = 400

/** How many items one list may carry. Thirteen acceptance criteria is not one task. */
export const HANDOFF_MAX_LIST_ITEMS = 12

const line = z.string().min(1).max(HANDOFF_MAX_FIELD_CHARS)
const list = z.array(line).max(HANDOFF_MAX_LIST_ITEMS).default([])

/**
 * The shape a stored or planned contract must have.
 *
 * `.strict()` and not `.passthrough()`: this value goes into a `Json` column that three different
 * readers parse back, and a field nobody declared would be invisible to all three while occupying
 * the row. The two required fields are required at the SHAPE level because a contract without them
 * has nothing to hand over -- unlike `PlanTask.capabilities`, whose shape is deliberately loose so
 * a spelling mistake cannot make `parsePlanGraph` fall back to an earlier draft (`../planning/
 * graph.ts:40-46`). A handoff is a whole sub-object: a malformed one is refused by name at
 * `concludePlanning`, which is where a named refusal can reach a human (plan erratum E16).
 *
 * Typed `z.ZodType<HandoffContract, z.ZodTypeDef, unknown>` -- `answerPrompt.ts`'s own annotation
 * -- because four of the six fields carry a `.default([])`, so the schema's INPUT type is not its
 * output type and a two-parameter `z.ZodType<HandoffContract>` would be a lie in the input slot.
 */
export const handoffContractSchema: z.ZodType<HandoffContract, z.ZodTypeDef, unknown> = z
  .object({
    objective: line,
    expectedOutput: line,
    acceptanceCriteria: list,
    knownConstraints: list,
    evidenceRequired: list,
    contextReferences: list,
  })
  .strict()

export function parseHandoffContract(value: unknown): Result<HandoffContract, string> {
  const parsed = handoffContractSchema.safeParse(value)
  return parsed.success ? ok(parsed.data) : err(parsed.error.message)
}

/**
 * The five literals the fake CLI selects its arms on, WITH their quotes (M48 plan erratum E2).
 *
 * `packages/providers/test/fake-claude.mjs` checks `prompt.includes('"candidateIndex"')`,
 * `'"sources"'`, `'"replan"'`, `'"task graph"'` and `'"verdict"'`, first match wins. A handoff's
 * text is written by a MODEL (the planner) or by a person, so "this text never contains them" can
 * only be true if something makes it true.
 */
export const ROUTING_LITERALS = ['candidateIndex', 'sources', 'replan', 'task graph', 'verdict'] as const

/**
 * Replaces the ASCII quotes around a routing literal with typographic ones (U+201C/U+201D), the way
 * {@link neutraliseMarkers} replaces a protocol marker's leading `<` with U+2039: reversible for a
 * human reader, inert for the matcher. The BARE word is left alone -- "the verdict is in" routes
 * nothing, and rewriting ordinary English inside a person's constraint would be the cure being
 * worse than the disease.
 */
export function defuseRoutingLiterals(text: string): string {
  let result = text
  for (const literal of ROUTING_LITERALS) {
    result = result.split(`"${literal}"`).join(`“${literal}”`)
  }
  return result
}

const safe = (text: string): string => defuseRoutingLiterals(neutraliseMarkers(text))

const bullets = (heading: string, items: readonly string[]): readonly string[] =>
  items.length === 0 ? [] : ['', heading, ...items.map((item) => `- ${safe(item)}`)]

/**
 * The `handoff` run-context section's text (R4), heading and closing rule included.
 *
 * The whole section rather than a body: `apps/orchestrator/src/runContext.ts`'s `block()` shape is
 * `[heading, '', ...body, '', '---']`, and returning the finished text is what lets a test in this
 * package pin it byte for byte -- the same choice M37 made for `REVIEW_VERDICT_INSTRUCTIONS`,
 * which lives here and is appended verbatim.
 *
 * Deterministic: a fixed field order, lists in the order they were written (the ORDER of acceptance
 * criteria is meaning, so it is never sorted), and an empty field omitted entirely rather than
 * printed as an empty heading. Every field goes through {@link safe} -- another party's text.
 */
export function renderHandoff(contract: HandoffContract): string {
  return [
    'HANDOFF',
    '',
    `Objective: ${safe(contract.objective)}`,
    '',
    `Expected output: ${safe(contract.expectedOutput)}`,
    ...bullets('Acceptance criteria (every one of these must hold):', contract.acceptanceCriteria),
    ...bullets('Known constraints:', contract.knownConstraints),
    ...bullets('Evidence required:', contract.evidenceRequired),
    ...bullets('Context references:', contract.contextReferences),
    '',
    '---',
  ].join('\n')
}

/**
 * The contract as canonical JSON -- the text the `handoff` section source's `sha256` is taken over
 * (plan decision D2).
 *
 * The FIELD order, never the insertion order of whatever object arrived: two runs given the same
 * contract must record the same hash, and `JSON.stringify` preserves insertion order. Hashing the
 * RENDERED text instead would make the hash move whenever the wording of a heading changed, which
 * is a question about this file rather than about the contract.
 */
export function handoffCanonicalJson(contract: HandoffContract): string {
  return JSON.stringify({
    objective: contract.objective,
    expectedOutput: contract.expectedOutput,
    acceptanceCriteria: [...contract.acceptanceCriteria],
    knownConstraints: [...contract.knownConstraints],
    evidenceRequired: [...contract.evidenceRequired],
    contextReferences: [...contract.contextReferences],
  })
}
