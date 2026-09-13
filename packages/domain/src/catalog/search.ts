import { sliceCodePoints, type ProfileSpec } from '../profile/spec.js'
import { normalisePersona } from './duplicate.js'

/**
 * What `SlaveTemplate.searchText` holds (M55 R3): the lower-cased, whitespace-collapsed join of the
 * seven fields a catalog ROW displays.
 *
 * It exists because a filter vocabulary inside a JSON column cannot be a `where`, which is the
 * exact sentence M47 wrote when it denormalised `capabilityKeys`, applied a second time. Before
 * this milestone `listWorkforceCatalog` read every row, built its effective spec in memory and
 * matched `name`, `summary`, `description`, `capabilities` and `expertise` against the query
 * (`packages/control/src/catalog.ts:780-791`); this is that same haystack, computed once at write
 * time, so the match can be a `contains` clause Postgres runs.
 *
 * A `name`-only search would have been a regression this milestone cannot afford:
 * `gate:m46-workforce-catalog` stage 2a types `rollout` and expects the release steward alone, and
 * that word is in the persona's Identity section and in a capability bullet -- in neither its name
 * (`Gate Release Steward`) nor its description (`Gets a change out and watches what it does.`).
 *
 * SEVEN fields and not fourteen, stated as the cost it is: `operatingPrinciples`, `constraints`,
 * `workflow`, `deliverables`, `successCriteria`, `collaborationHints` and `body` are not here, and
 * the milestone's section 6 carries that as item 4.
 *
 * Built from the EFFECTIVE spec by its caller, not the upstream one (plan erratum E6): a row whose
 * operator rewrote its summary must be findable by the summary the row SHOWS.
 */
export const SEARCH_TEXT_MAX_CHARS = 2000

/**
 * The NAME first, then the description, then the five spec fields -- so a cut at the cap can only
 * ever cost the tail of the prose and never the one thing every operator searches by.
 *
 * `normalisePersona` rather than a second lower-caser (the module next door): the query side folds
 * with exactly this function too, so a column and a search box cannot disagree about what a double
 * space or a decomposed accent is. `sliceCodePoints` rather than `slice`, so a cut never leaves a
 * lone surrogate in a stored column.
 */
export function catalogSearchText(input: {
  readonly name: string
  readonly description: string
  readonly spec: ProfileSpec | null
}): string {
  const parts: string[] = [input.name, input.description]
  if (input.spec !== null) {
    parts.push(
      input.spec.identity,
      input.spec.summary,
      ...input.spec.capabilities,
      ...input.spec.expertise,
      ...input.spec.recommendedSkills,
    )
  }
  return sliceCodePoints(normalisePersona(parts.join('\n')), SEARCH_TEXT_MAX_CHARS)
}
