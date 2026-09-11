import { capabilityLabel, normaliseCapabilityText, type CapabilityRecord } from '../capability/taxonomy.js'
import type { Runbook } from './spec.js'

/** How many runbooks one `runbook_recommended` situation offers. Three is a list a person reads in
 *  a glance -- `MAX_STAFFING_CANDIDATES`' own number and its own reason. */
export const RUNBOOK_RECOMMENDATIONS_MAX = 3

export interface RunbookRecommendation {
  readonly runbook: Runbook
  readonly score: number
  /** The keywords actually found in the goal, sorted -- what the rationale names. */
  readonly matchedKeywords: readonly string[]
  readonly coveredRequired: readonly string[]
  readonly missingRequired: readonly string[]
  /** One sentence a person judges the offer by, in the taxonomy's WORDS (docs/ia.md rule 3). */
  readonly rationale: string
}

/**
 * Which runbooks this goal looks like (R5).
 *
 * Whole-word, never fuzzy, and for `normaliseCapabilities`' own reason (M47 plan erratum E12): both
 * sides go through {@link normaliseCapabilityText}, the goal is bracketed with spaces, and a keyword
 * is looked for as ` keyword ` -- so `bug` does not match `debugging`, a multi-word keyword matches
 * as a PHRASE, and a full stop after the word does not hide it.
 *
 * A runbook with NO keyword hit scores nothing and is dropped before scoring: R5's "no keyword hit
 * anywhere, no situation", which is what keeps the Supervisor quiet on a goal it has no opinion
 * about. Capability coverage only ever moves a runbook the goal already named.
 *
 * Ties break on `key` ascending, so the same goal always produces the same three offers in the same
 * order -- which is what makes an approved `candidateIndex` mean the same thing twice.
 */
export function recommendRunbooks(
  goal: string,
  runbooks: readonly Runbook[],
  rosterCapabilities: readonly string[],
  taxonomy: readonly CapabilityRecord[],
): readonly RunbookRecommendation[] {
  const haystack = ` ${normaliseCapabilityText(goal)} `
  const provided = new Set(rosterCapabilities)

  const scored: RunbookRecommendation[] = []
  for (const runbook of runbooks) {
    const matchedKeywords = [
      ...new Set(
        runbook.keywords.filter((keyword) => {
          const needle = normaliseCapabilityText(keyword)
          return needle !== '' && haystack.includes(` ${needle} `)
        }),
      ),
    ].toSorted((a, b) => a.localeCompare(b))
    if (matchedKeywords.length === 0) continue

    const coveredRequired = runbook.requiredCapabilities.filter((key) => provided.has(key))
    const missingRequired = runbook.requiredCapabilities.filter((key) => !provided.has(key))
    scored.push({
      runbook,
      score: matchedKeywords.length * 10 + coveredRequired.length - missingRequired.length,
      matchedKeywords,
      coveredRequired,
      missingRequired,
      rationale: rationaleOf(matchedKeywords, coveredRequired, missingRequired, taxonomy),
    })
  }

  return scored
    .toSorted((a, b) => (a.score === b.score ? a.runbook.key.localeCompare(b.runbook.key) : b.score - a.score))
    .slice(0, RUNBOOK_RECOMMENDATIONS_MAX)
}

function rationaleOf(
  matched: readonly string[],
  covered: readonly string[],
  missing: readonly string[],
  taxonomy: readonly CapabilityRecord[],
): string {
  const words = (keys: readonly string[]): string =>
    keys.map((key) => capabilityLabel(key, taxonomy)).join(', ')
  const parts = [`The goal says ${matched.map((word) => `"${word}"`).join(' and ')}.`]
  if (covered.length > 0) parts.push(`Your team already covers ${words(covered)};`)
  parts.push(
    missing.length === 0
      ? covered.length > 0
        ? 'nothing it needs is missing.'
        : 'Nothing about your team was measured against it yet.'
      : `${covered.length > 0 ? 'it is missing' : 'Your team is missing'} ${words(missing)}.`,
  )
  return parts.join(' ')
}
