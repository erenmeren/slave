/**
 * The vocabulary organisational memory is written in (M49 R1).
 *
 * Four closed lists, each with a LABEL table beside it: `docs/ia.md` rule 3 forbids a surface from
 * printing a union member as its visible text, and `SITUATION_LABEL`'s own `Record<…, string>`
 * shape is what makes a forgotten label a build failure rather than an identifier on a page.
 */

/** What kind of knowledge this is. Ordered as R1 lists them; {@link MEMORY_TYPE_ORDER} in
 *  `./retrieve.js` is the RANKING order and is deliberately a different list. */
export const MEMORY_TYPES = ['fact', 'decision', 'procedure', 'lesson', 'observation', 'hypothesis'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

/** Who the knowledge belongs to. Exactly one target column is set for each (plan decision D1). */
export const MEMORY_SCOPES = ['company', 'workspace', 'worker'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

/**
 * A memory's life. NOTHING is ever deleted (R1): `superseded` points at what replaced it and
 * `removed` keeps the reason, and both rows stay in the table.
 */
export const MEMORY_STATUSES = ['candidate', 'verified', 'superseded', 'removed'] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

/** Where the knowledge came from -- the half of provenance that says WHAT produced it. */
export const MEMORY_SOURCE_KINDS = [
  'run_output',
  'verification',
  'review',
  'decision',
  'goal',
  'human',
  'condensation',
] as const
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number]

/**
 * How sure we are. M39's own words (`apps/orchestrator/src/supervisor.ts:411`), and deliberately
 * not a number: nothing in this system can honestly produce a 0.73, and a number invites ranking
 * by it -- which is M53's job, with evidence, not this milestone's.
 */
export const MEMORY_CONFIDENCES = ['sourced', 'interpretation'] as const
export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number]

/** Who said this is true. `verification` is the commands, `review` the reviewer, `human` a person. */
export const MEMORY_VERIFIERS = ['verification', 'review', 'human'] as const
export type MemoryVerifier = (typeof MEMORY_VERIFIERS)[number]

/** One line somebody can scan in a list. */
export const MEMORY_TITLE_MAX = 120

/** The knowledge itself. Two thousand code points is a paragraph somebody can act on; past it a
 *  memory has stopped being knowledge and started being a transcript, which is the thing R1
 *  exists to replace. */
export const MEMORY_BODY_MAX = 2000

/** How many retrieval references one memory may carry. */
export const MEMORY_CAPABILITIES_MAX = 20

export const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  fact: 'Fact',
  decision: 'Decision',
  procedure: 'Procedure',
  lesson: 'Lesson',
  observation: 'Observation',
  hypothesis: 'Hypothesis',
}

export const MEMORY_SCOPE_LABEL: Record<MemoryScope, string> = {
  company: 'The company',
  workspace: 'This project',
  worker: 'One worker',
}

export const MEMORY_STATUS_LABEL: Record<MemoryStatus, string> = {
  candidate: 'Candidate',
  verified: 'Verified',
  superseded: 'Superseded',
  removed: 'Removed',
}

/** Read after "from ": every one of these completes the sentence a provenance line starts. */
export const MEMORY_SOURCE_KIND_LABEL: Record<MemorySourceKind, string> = {
  run_output: 'a worker’s own report',
  verification: 'a passed verification',
  review: 'a review',
  decision: 'a decision somebody took',
  goal: 'a change to the goal',
  human: 'a person',
  condensation: 'a summary of other memories',
}

export const MEMORY_CONFIDENCE_LABEL: Record<MemoryConfidence, string> = {
  sourced: 'Sourced',
  interpretation: 'Interpretation',
}

/** Read after "verified by ". */
export const MEMORY_VERIFIER_LABEL: Record<MemoryVerifier, string> = {
  verification: 'verification',
  review: 'a review',
  human: 'a person',
}

/**
 * Caps text at `max` CODE POINTS, never UTF-16 units.
 *
 * `String.prototype.slice` counts units, so a cap that lands between the halves of a surrogate
 * pair leaves a lone surrogate in a column three readers parse back. R1's caps are stated in code
 * points, and this is what makes that true.
 */
export function capCodePoints(text: string, max: number): string {
  const points = [...text]
  return points.length <= max ? text : points.slice(0, max).join('')
}
