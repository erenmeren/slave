import { capabilityIndex, normaliseCapabilityText, type CapabilityKey, type CapabilityRecord } from './taxonomy.js'

/**
 * One persona sentence, turned into an ADVISORY edge (M47 R5).
 *
 * `text` is the sentence exactly as M46's mapper stored it -- M46 kept collaboration hints verbatim
 * precisely so this milestone could trace one back to the persona that wrote it. Nothing here ever
 * dispatches: an edge is shown on a profile and on the Organization view, it breaks a tie in
 * {@link formTeam}'s rationale, and that is the whole of its authority.
 */
export interface CollaborationHintDraft {
  readonly text: string
  /** The template the sentence names, when it names one at all. NULL is the ORDINARY case: most
   *  real handoff sentences name a generic role ("escalate to the process owner") rather than a
   *  persona, and an edge to nobody is still a sentence a person can read. */
  readonly targetTemplateId: string | null
  readonly capability: CapabilityKey | null
}

/** A whole-phrase, case-insensitive occurrence test over normalised text -- `apidesigner` does not
 *  contain `api design`, and `Consult the Gate Security Reviewer.` does contain
 *  `gate security reviewer`. Both sides go through the same normaliser, so punctuation and
 *  separators cannot decide a match. */
function containsPhrase(haystack: string, phrase: string): boolean {
  if (phrase === '') return false
  const index = haystack.indexOf(phrase)
  if (index === -1) return false
  const before = index === 0 ? ' ' : haystack[index - 1]
  const after = index + phrase.length >= haystack.length ? ' ' : haystack[index + phrase.length]
  return before === ' ' && after === ' '
}

/** How short a spelling may be before it is too short to search a whole sentence for. Two-letter
 *  synonyms would match half the corpus; four characters is the shortest real one in the seed
 *  taxonomy (`ci-cd` normalises to `ci cd`). */
const MIN_SEARCHABLE = 4

/**
 * Normalise one hint (R5). The TARGET is the longest template name the sentence contains (ties on
 * id ascending); the CAPABILITY is the longest key/label/synonym it contains (ties on key
 * ascending). Longest-wins is what stops a template called `Security` from taking a sentence that
 * named the `Gate Security Reviewer`, and the tie-breaks are what make the result the same on
 * every run.
 *
 * CALLER CONTRACT: `templates` must not contain the template the hint belongs to -- a persona that
 * mentions its own title would otherwise advise consulting itself.
 */
export function normaliseCollaborationHint(
  sentence: string,
  templates: readonly { readonly id: string; readonly name: string }[],
  taxonomy: readonly CapabilityRecord[],
): CollaborationHintDraft {
  const haystack = ` ${normaliseCapabilityText(sentence)} `

  let target: { id: string; length: number } | null = null
  for (const template of [...templates].toSorted((a, b) => a.id.localeCompare(b.id))) {
    const name = normaliseCapabilityText(template.name)
    if (name.length < MIN_SEARCHABLE || !containsPhrase(haystack, name)) continue
    if (target === null || name.length > target.length) target = { id: template.id, length: name.length }
  }

  let capability: { key: CapabilityKey; length: number } | null = null
  for (const record of [...capabilityIndex(taxonomy).values()].toSorted((a, b) => a.key.localeCompare(b.key))) {
    for (const spelling of [record.key, record.label, ...record.synonyms]) {
      const text = normaliseCapabilityText(spelling)
      if (text.length < MIN_SEARCHABLE || !containsPhrase(haystack, text)) continue
      if (capability === null || text.length > capability.length) capability = { key: record.key, length: text.length }
    }
  }

  return {
    text: sentence,
    targetTemplateId: target?.id ?? null,
    capability: capability?.key ?? null,
  }
}
