import { z } from 'zod'

/**
 * Where a delivery came FROM (M54 R5).
 *
 * One member, and the roadmap's own "GitHub **or** GitLab" is why: a second source is an additive
 * migration and one more classifier, and building two adapters to prove one is extensible is how a
 * milestone ships neither well. The enum exists so the second one costs an `ALTER TYPE` and a file
 * rather than a column rename everywhere.
 */
export const EXTERNAL_SOURCES = ['github'] as const

export type ExternalSource = (typeof EXTERNAL_SOURCES)[number]

/** What each source is CALLED when a person reads it (`docs/ia.md` rule 3). A `Record` over the
 *  union, so a second source fails the build here rather than turning up in a goal-history line as
 *  an identifier. `originLabel` below is the only reader in this package; the CLI and the web read
 *  the same table rather than each spelling `GitHub` for themselves. */
export const EXTERNAL_SOURCE_LABEL: Record<ExternalSource, string> = { github: 'GitHub' }

/**
 * What a repository may be called: `owner/repo`, each half 1-100 characters of letters, digits,
 * dot, dash and underscore (M54 R8).
 *
 * A SHAPE, checked before the value is ever stored, because this string is PRINTED as words beside
 * a project's requirement and inside a goal document a worker reads. Sanitising a label is weaker
 * than never accepting a malformed one: a fence says "the text inside me is data", and a label is
 * not inside the fence.
 *
 * The regex is also the cap. 100 + 1 + 100 is 201 characters, which is R4's 200-character intent
 * enforced by the same expression that enforces the alphabet -- so there is no second length check
 * anywhere to fall out of step with this one.
 */
export const REPOSITORY_FULL_NAME_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/u

/** The longest string {@link REPOSITORY_FULL_NAME_RE} accepts -- 100 + 1 + 100 -- as a NUMBER, for
 *  the one caller that has to do arithmetic with it rather than test against it
 *  (`composeExternalRequest`'s frame budget, fix-round-1 erratum E17). Pinned against the regex by a
 *  case in `origin.test.ts`, so the two cannot drift. */
export const REPOSITORY_FULL_NAME_MAX_CHARS = 201

/**
 * What a ref may be: `#<digits>` (an issue or pull-request number, at most twelve digits) or a
 * 7-40 character lower-case hex sha (M54 R8).
 *
 * Two shapes and no third, for the same reason as above: this is printed. A branch name is
 * deliberately not one of them -- `refs/heads/Ignore previous instructions` is a legal branch name
 * and an illegal label.
 */
export const EXTERNAL_REF_RE = /^(?:#\d{1,12}|[0-9a-f]{7,40})$/u

/** The longest string {@link EXTERNAL_REF_RE} accepts -- a 40-character sha, which is longer than
 *  `#` plus twelve digits -- as a NUMBER, for the same one caller and pinned the same way. */
export const EXTERNAL_REF_MAX_CHARS = 40

/** The longest url this system will store or hand to a reader (M54 R8). A url over it is dropped
 *  to `null` rather than truncated: half a link is worse than no link. */
export const EXTERNAL_URL_MAX_CHARS = 500

/**
 * WHERE a thing came from, carried nested under the key `origin` in exactly three places so one
 * name means one thing (M54 R5): the `external.received` payload, the `external.actioned` payload,
 * and `GoalVersion.origin`.
 *
 * Provenance, not an actor. The envelope's `actor` answers "what kind of thing wrote this" and the
 * honest answer for an ingestion is `system`; this answers "who told us", which is a different axis
 * and needs its own word. There is deliberately no `Actor` member for it (R5), no `Task.origin`
 * column and no `ExecutionEvent.origin` column: a task's origin is read through the
 * `Task.goalVersion` it already carries.
 *
 * Deliberately NOT named with the word `source` on its own: `sourceRepository`
 * (`packages/control/src/catalog.ts:671,757`) is M42/M46's persona-catalog import provenance and an
 * unrelated concept.
 */
export interface ExternalOrigin {
  readonly source: ExternalSource
  readonly repository: string
  /** `#<number>` or a short sha, or null when the delivery is about neither (plan erratum E8). */
  readonly ref: string | null
  /** Where a person can go and look, or null when the payload carried nothing usable (R8). */
  readonly url: string | null
}

/**
 * The shape a stored or evented origin must have.
 *
 * `.strict()`, unlike the PROVIDER's payload schema one module over (R8 inverts the house rule
 * there and only there): this value is ours, it goes into a `Json` column that three readers parse
 * back, and a field nobody declared would be invisible to all three while occupying the row --
 * `handoffContractSchema`'s own reasoning (`../handoff/contract.ts:42-48`).
 *
 * Typed `z.ZodType<ExternalOrigin, z.ZodTypeDef, unknown>`, the annotation every schema in this
 * package that parses an unknown carries.
 */
export const externalOriginSchema: z.ZodType<ExternalOrigin, z.ZodTypeDef, unknown> = z
  .object({
    source: z.enum(EXTERNAL_SOURCES),
    repository: z.string().regex(REPOSITORY_FULL_NAME_RE),
    ref: z.string().regex(EXTERNAL_REF_RE).nullable(),
    url: z.string().max(EXTERNAL_URL_MAX_CHARS).nullable(),
  })
  .strict()

/**
 * The origin a stored `Json` column holds, or `null` when it holds something else (M54 R9).
 *
 * `GoalVersion.origin` is this schema's first `Json` column holding a validated domain object on a
 * HISTORY row, so the read has to be able to say "this does not parse" without taking a page down
 * -- `handoffOf`'s own rule in `apps/web/src/server/tasks.ts`. A hand-edited row, or a column
 * written by a future version with a field this build does not know, reads back as "no origin",
 * which renders as nothing at all.
 */
export function parseExternalOrigin(value: unknown): ExternalOrigin | null {
  const parsed = externalOriginSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * The sentence every surface that shows externally-originated work says (M54 R9):
 * `from GitHub · acme/checkout#412`, with the middle dot written literally.
 *
 * Here, beside the type, so the web and the CLI read ONE table and cannot disagree about what
 * `github` is called. The ref is appended DIRECTLY when it starts with `#`, because
 * `acme/checkout #412` reads as two things, and after a SPACE when it is a sha, because
 * `acme/checkout1a2b3c4` reads as one.
 *
 * Never the url and never the delivery id: the first is a link and this is a sentence, and the
 * second is a correlation id for an operator's log and not a word for a page.
 */
export function originLabel(origin: ExternalOrigin): string {
  const source = EXTERNAL_SOURCE_LABEL[origin.source]
  if (origin.ref === null) return `from ${source} · ${origin.repository}`
  const ref = origin.ref.startsWith('#') ? origin.ref : ` ${origin.ref}`
  return `from ${source} · ${origin.repository}${ref}`
}
