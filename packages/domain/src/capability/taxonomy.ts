import { z } from 'zod'

/**
 * A capability key: `<domain>.<name>`, both halves lower-case and dash-separated (M47 R1).
 *
 * A plain `string` alias rather than a branded type: these values cross a `String[]` Postgres
 * column, a JSON plan graph and a fetch response, and every one of those hands back a `string`.
 * The pattern below, `capabilityKeySchema` and the taxonomy table are what actually bound it --
 * NOTHING matches on a key that is not in the table (R1).
 */
export type CapabilityKey = string

export const CAPABILITY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/

export const capabilityKeySchema = z.string().regex(CAPABILITY_KEY_PATTERN, 'a capability key looks like <domain>.<name>')

/**
 * One row of the taxonomy, as the pure functions here see it. The DATA lives in a table
 * (`packages/db/src/capabilities.ts` seeds it, `syncCapabilityTaxonomy` keeps it in step); nothing
 * in `packages/domain` reads a database, so every function below takes the taxonomy as an
 * argument. That is also what makes each of them a one-line fixture in a test.
 *
 * `role` is NOT nullable (plan erratum E1): a task that declared capabilities and derived no role
 * would be dropped by BOTH loaders -- unschedulable and unstaffable at once, with no situation
 * raised about it.
 */
export interface CapabilityRecord {
  readonly key: CapabilityKey
  readonly label: string
  readonly domain: string
  readonly role: string
  readonly synonyms: readonly string[]
}

/**
 * The one normalisation both sides of a match go through (plan erratum E12).
 *
 * Lower-cased, every run of whitespace or `-`/`_`/`.` reduced to ONE space, and trailing
 * punctuation removed -- so `backend.api-design`, `API Design` and `api_design.` are the same
 * string here and a persona bullet does not miss its key over a full stop. Deliberately NOT a
 * stemmer and deliberately not applied to substrings: an inexact match would depend on the order
 * the taxonomy came back in, and this repository's rule is that the same input always produces the
 * same output.
 */
export function normaliseCapabilityText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s_\-.]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .trim()
}

export interface NormalisedCapabilities {
  /** The resolved keys, deduplicated, in the order they were first seen. */
  readonly keys: readonly CapabilityKey[]
  /** Every non-blank input that matched nothing, verbatim -- kept beside the row it came from
   *  (`SlaveTemplate.unresolvedCapabilities`) so an operator can see what the taxonomy is missing
   *  rather than losing the words the persona used. An unresolved string never matches anything. */
  readonly unresolved: readonly string[]
}

/**
 * Free text -> taxonomy keys (R2): the exact key, then the exact label, then an exact synonym,
 * every comparison made on {@link normaliseCapabilityText}'s output.
 *
 * Blank entries are dropped rather than reported: a persona with a stray empty bullet has not
 * named a capability the taxonomy is missing.
 */
export function normaliseCapabilities(
  values: readonly string[],
  taxonomy: readonly CapabilityRecord[],
): NormalisedCapabilities {
  const byText = new Map<string, CapabilityKey>()
  for (const record of taxonomy) {
    for (const spelling of [record.key, record.label, ...record.synonyms]) {
      const text = normaliseCapabilityText(spelling)
      // First spelling wins, so a synonym one row borrowed from another cannot hijack the key that
      // OWNS that word -- and the taxonomy's own order (key ascending, everywhere it is loaded) is
      // what decides.
      if (text !== '' && !byText.has(text)) byText.set(text, record.key)
    }
  }

  const keys: CapabilityKey[] = []
  const unresolved: string[] = []
  for (const value of values) {
    const text = normaliseCapabilityText(value)
    if (text === '') continue
    const key = byText.get(text)
    if (key === undefined) {
      if (!unresolved.includes(value)) unresolved.push(value)
      continue
    }
    if (!keys.includes(key)) keys.push(key)
  }
  return { keys, unresolved }
}

/** THE projection (R2): the runtime roles a set of capabilities makes a worker dispatchable as.
 *  Deduplicated and sorted, so a materialised worker's `runtimeRoles` are the same list whatever
 *  order its capabilities were written in. A key the taxonomy does not have projects nothing --
 *  matching on a key nobody defined is exactly what R1 forbids. */
export function projectRoles(
  keys: readonly CapabilityKey[],
  taxonomy: readonly CapabilityRecord[],
): readonly string[] {
  const index = capabilityIndex(taxonomy)
  const roles = new Set<string>()
  for (const key of keys) {
    const record = index.get(key)
    if (record !== undefined) roles.add(record.role)
  }
  return [...roles].sort()
}

export function capabilityIndex(taxonomy: readonly CapabilityRecord[]): ReadonlyMap<CapabilityKey, CapabilityRecord> {
  return new Map(taxonomy.map((record) => [record.key, record] as const))
}

/** What a person reads instead of the key. Falls back to the key so a chip is never empty: a row
 *  written by a newer build can carry a key this bundle's taxonomy has never heard of, and the key
 *  itself is the honest thing to show (the `SITUATION_LABEL` fallback idiom, M44 R5). */
export function capabilityLabel(key: CapabilityKey, taxonomy: readonly CapabilityRecord[]): string {
  return capabilityIndex(taxonomy).get(key)?.label ?? key
}
