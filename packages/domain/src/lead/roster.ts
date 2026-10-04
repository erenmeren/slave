import { trimToFit } from '../conduct/verification.js'
import { neutraliseMarkers } from '../run-context/markers.js'
import { LEAD_ROSTER_JSON_MAX_BYTES, LEAD_ROSTER_MEMBER_PROMPT_MAX_CHARS } from './constants.js'

/** One person of the roster, as a subordinate-session definition is built from them. */
export interface RosterMember {
  readonly personId: string
  readonly name: string
  /** One line on when to use them. */
  readonly description: string
  /** The person's instructions with their skills, already gathered. */
  readonly instructions: string
}

/** A name as a definition key: lower-case ASCII letters, digits and hyphens, at most 40. */
export function rosterSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug === '' ? 'member' : slug
}

/**
 * UTF-8 length of `text`. `TextEncoder`, not `Buffer`: the domain is bundled into the web app's
 * browser build and imports no Node built-in (the `goalSha256` precedent).
 */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Lead-flow spec B2 (plan A L16): the roster as the `--agents` value -- one definition per member,
 * `{ description, prompt }`, keyed by a slug of the name. The instructions are catalogue text: their
 * protocol markers are defused and each is bounded. The whole is ONE argv string, so members that
 * would take it past `LEAD_ROSTER_JSON_MAX_BYTES` are dropped from the end and named in `dropped`.
 * `json` is null for an empty roster: no flag is passed.
 */
export function buildRosterDefinitions(members: readonly RosterMember[]): {
  readonly json: string | null
  readonly slugs: ReadonlyMap<string, string>
  readonly dropped: readonly string[]
} {
  const definitions: Record<string, { description: string; prompt: string }> = {}
  const slugs = new Map<string, string>()
  const dropped: string[] = []
  for (const member of members) {
    if (dropped.length > 0) {
      dropped.push(member.name)
      continue
    }
    const base = rosterSlug(member.name)
    let key = base
    for (let n = 2; slugs.has(key); n += 1) key = `${base}-${String(n)}`
    const candidate = {
      description: trimToFit(neutraliseMarkers(member.description).replace(/\s+/g, ' ').trim(), 300),
      prompt: trimToFit(neutraliseMarkers(member.instructions), LEAD_ROSTER_MEMBER_PROMPT_MAX_CHARS),
    }
    if (utf8Bytes(JSON.stringify({ ...definitions, [key]: candidate })) > LEAD_ROSTER_JSON_MAX_BYTES) {
      dropped.push(member.name)
      continue
    }
    definitions[key] = candidate
    slugs.set(key, member.personId)
  }
  return { json: slugs.size === 0 ? null : JSON.stringify(definitions), slugs, dropped }
}
