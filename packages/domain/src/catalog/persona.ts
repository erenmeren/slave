import { goalSha256 } from '../goal/version.js'
import { err, ok, type Result } from '../result.js'
import { PROFILE_MAX_CHARS } from '../run-context/profile.js'

/**
 * A persona file, read (M42 §2). PURE: nothing in this package touches disk or Prisma -- the
 * directory walk is the CLI's (`apps/orchestrator/src/catalog.ts`) and the rows are the control
 * verb's (`packages/control/src/catalog.ts`). Deliberately NOT a YAML parser, the same judgment
 * `packages/control/src/skills.ts` records about a skill's front matter: an external catalog's
 * five scalar keys are a line format, and a real YAML dependency here would buy nothing and pull a
 * parser into a package that `apps/web`'s CLIENT bundle imports.
 */
export interface PersonaDraft {
  readonly name: string
  /** The catalog blurb, or `null` -- the mapper falls back to `meta.vibe` and then to nothing. */
  readonly description: string | null
  /** Everything after the closing delimiter, trimmed. The front matter is NOT part of it: what
   *  reaches a prompt is the persona, not its catalog metadata. */
  readonly body: string
  /** Every front-matter key, verbatim, including the ones this milestone does not act on --
   *  colour, emoji, a tool allowlist (§3, out of scope). Kept because throwing away what the source
   *  said is not something a re-import can undo. */
  readonly meta: Readonly<Record<string, string>>
}

export type PersonaError =
  | { readonly kind: 'no_front_matter' }
  | { readonly kind: 'unterminated_front_matter' }
  | { readonly kind: 'no_name' }
  | { readonly kind: 'empty_body' }

/** The reason an operator reads on a skipped row. */
export function personaErrorText(error: PersonaError): string {
  switch (error.kind) {
    case 'no_front_matter':
      return 'the file does not open with a --- front matter block'
    case 'unterminated_front_matter':
      return 'the front matter block is never closed with a second ---'
    case 'no_name':
      return 'the front matter has no name'
    case 'empty_body':
      return 'there is no persona text under the front matter'
  }
}

const DELIMITER = '---'
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/

/** Strips ONE matching pair of surrounding quotes; anything else is left exactly as written. */
function unquote(value: string): string {
  const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
  return quoted && value.length >= 2 ? value.slice(1, -1) : value
}

export function parsePersona(source: { readonly path: string; readonly text: string }): Result<PersonaDraft, PersonaError> {
  // A byte-order mark and CRLF are both ordinary in a catalog written on another machine, and
  // neither is a reason to refuse a persona.
  const lines = source.text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
  if ((lines[0] ?? '').trim() !== DELIMITER) return err({ kind: 'no_front_matter' })

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER)
  if (closing === -1) return err({ kind: 'unterminated_front_matter' })

  const meta: Record<string, string> = {}
  for (const line of lines.slice(1, closing)) {
    const match = KEY_LINE.exec(line)
    // A continuation line, a comment, a blank: not a key, and not a reason to refuse the file.
    if (match === null) continue
    meta[match[1] as string] = unquote((match[2] ?? '').trim())
  }

  const name = (meta['name'] ?? '').trim()
  if (name === '') return err({ kind: 'no_name' })

  const body = lines.slice(closing + 1).join('\n').trim()
  if (body === '') return err({ kind: 'empty_body' })

  const description = (meta['description'] ?? '').trim()
  return ok({ name, description: description === '' ? null : description, body, meta })
}

/**
 * The ONE line the product owns in an imported profile (R4).
 *
 * The persona's words are kept verbatim; this says whose they are and when they arrived, so a
 * reader of a prompt can tell an imported brief from one an operator wrote. The date, not the
 * timestamp: the hour a file was read is not a fact about the persona.
 */
export function importedProfilePrefix(sourceId: string, importedAt: Date): string {
  return `Imported from ${sourceId} on ${importedAt.toISOString().slice(0, 10)}; this text is the persona's own.`
}

export interface TemplateDraft {
  readonly sourceId: string
  readonly name: string
  readonly role: string
  readonly description: string
  readonly profile: string
  readonly profileSha256: string
  readonly sourceSha256: string
  readonly sourceDivision: string
}

export interface TemplateMapping {
  readonly catalog: string
  readonly division: string
  /** The file's path inside its division, without `.md` -- the third segment of `sourceId`. */
  readonly slug: string
  /** The file's text exactly as it was read, which is what `sourceSha256` is over. */
  readonly text: string
  readonly importedAt: Date
  /** `division -> role`, from `--role-map`. Nothing is inferred from a persona's name (R3). */
  readonly roleMap?: Readonly<Record<string, string>>
}

/**
 * A parsed persona as a catalog row would have it (R3, R4).
 *
 * `defaultModel`/`provider` are not here at all and never will be: a model choice is an operator
 * decision, which is the seed's own rule and the reason it ships every template with a null model.
 *
 * The cap is measured on the COMPOSED profile -- prefix line included -- because that is the text
 * that gets stored, and `buildRunContext` re-checks THAT length at dispatch and refuses the run.
 * Measuring the body alone would let a persona import cleanly and make every worker materialised
 * from it undispatchable.
 */
export function personaToTemplate(
  draft: PersonaDraft,
  mapping: TemplateMapping,
): Result<TemplateDraft, { readonly kind: 'profile_too_long'; readonly limit: number; readonly length: number }> {
  const sourceId = `${mapping.catalog}/${mapping.division}/${mapping.slug}`
  const profile = `${importedProfilePrefix(sourceId, mapping.importedAt)}\n\n${draft.body}`.trim()
  if (profile.length > PROFILE_MAX_CHARS) {
    return err({ kind: 'profile_too_long', limit: PROFILE_MAX_CHARS, length: profile.length })
  }
  return ok({
    sourceId,
    name: draft.name,
    role: mapping.roleMap?.[mapping.division] ?? mapping.division,
    description: draft.description ?? (draft.meta['vibe'] ?? '').trim(),
    profile,
    profileSha256: goalSha256(profile),
    sourceSha256: goalSha256(mapping.text),
    sourceDivision: mapping.division,
  })
}
