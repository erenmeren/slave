import { evidenceByModel, evidenceByProfile, listCapabilities } from '@slave-of-ai/control'
import {
  EVIDENCE_MIN_SAMPLE,
  GENERAL_DOMAIN,
  MODEL_NOT_RECORDED_LABEL,
  domainLabel,
  isBespokeProfileKey,
} from '@slave-of-ai/domain'

/**
 * The Evidence tab's whole read (M53 R12).
 *
 * NO SQL LIVES HERE (plan erratum E6). `packages/control/src/evidence.ts` owns the one aggregation
 * over `EvidenceRecord`; two `GROUP BY`s over one table would eventually disagree in front of a
 * person about how many runs a profile has attempted, and the disagreement would surface on this
 * page. What this module owns is what a person READS: the words for every key, the rate that
 * becomes `Insufficient evidence`, the sentence the sort is stated in, and the chips.
 *
 * GLOBAL, not per project: `/workforce` has no workspace scope, and R1's record spans every project
 * this installation holds. CONTROL's own filter (`packages/control/src/evidence.ts`'s
 * `EvidenceFilter`) carries a `workspaceId` for the per-project read a later milestone may want,
 * and this module never passes one -- which is why {@link EvidenceFilter} below, the filter this
 * page actually has, is one field. The two types share a name and are deliberately not the same
 * shape; the docstring said otherwise until the final wave.
 */

/** The chip row above both tables: the raw key for `data-domain` and the URL, the word for the eye
 *  (`docs/ia.md` rule 3). */
export interface EvidenceDomainChip {
  readonly domain: string
  readonly label: string
}

export interface EvidenceRate {
  /** The percentage, or NULL when this rate's own denominator is below `EVIDENCE_MIN_SAMPLE`. A
   *  null renders `INSUFFICIENT_EVIDENCE` and no progress bar at all -- not a dash, not a
   *  zero, and not a greyed percentage (R11), which is also what `gate:m16-chrome`'s moved check 5
   *  measures (plan erratum E11). */
  readonly pct: number | null
  /** The denominator, always shown: a count is a fact and only a rate is a claim. A `judged` of 0
   *  is "nobody has reached a verdict on any of these yet" rather than a verdict of no -- the
   *  three judgement columns are nullable for exactly that reason (R3), and the cell says so in
   *  its `title`. */
  readonly judged: number
}

/** One row of R12's by-profile table. The counts are FACTS and are always printed; only the three
 *  {@link EvidenceRate}s are claims, and only they can be withheld. */
export interface EvidenceProfileRow {
  readonly profileKey: string
  readonly name: string
  /** `slave:<id>` -- a hand-made worker rather than a persona the catalog holds (R1). */
  readonly bespoke: boolean
  readonly repositoryKey: string
  readonly attempted: number
  readonly firstPass: EvidenceRate
  readonly reviewRejected: EvidenceRate
  readonly integrated: EvidenceRate
  readonly reworkCycles: number
  readonly humanInterventions: number
  readonly recoveries: number
  readonly medianDurationMs: number | null
  /** R6: three figures, never one sum. Null is "no run in this group reported one", which is not a
   *  zero -- `formatUsd` prints a null as `—` for precisely that reason. */
  readonly reportedUsd: number | null
  readonly estimatedUsd: number | null
  readonly unmeasuredRuns: number
  /** The whole ROW is below the floor: every rate is withheld, and the table marks the row once. */
  readonly insufficient: boolean
}

/** One row of R12's by-model table -- seven columns and deliberately not the profile's eleven: a
 *  model has no rework cycles, interventions or recoveries in any sense a person can act on. */
export interface EvidenceModelRow {
  /** Null is a REAL group (a run recorded before M51 wrote a model), never a missing row. */
  readonly model: string | null
  readonly label: string
  readonly attempted: number
  readonly firstPass: EvidenceRate
  readonly reviewRejected: EvidenceRate
  readonly integrated: EvidenceRate
  readonly medianDurationMs: number | null
  readonly reportedUsd: number | null
  readonly estimatedUsd: number | null
  readonly unmeasuredRuns: number
  readonly insufficient: boolean
}

export interface EvidencePage {
  readonly domains: readonly EvidenceDomainChip[]
  readonly byProfile: readonly EvidenceProfileRow[]
  readonly byModel: readonly EvidenceModelRow[]
  readonly sortCaption: string
  /** `EVIDENCE_MIN_SAMPLE`, carried so the tab can say what the floor is instead of restating a
   *  number the domain owns. */
  readonly minSample: number
}

export interface EvidenceFilter {
  /** The domain chip in the URL, or null for every domain. A filtered count is "runs that touched
   *  this domain" and the filtered counts deliberately do not sum to the unfiltered total (R2). */
  readonly domain: string | null
}

/** R11: a rate is a claim, and a claim needs a sample. `pct` is null below the constant, whether the
 *  ROW is thin or only this one denominator is -- the three judgement columns settle independently
 *  (R3), so a row with twenty attempts and two integrations is ordinary rather than exotic. */
const rateOf = (numerator: number, judged: number): EvidenceRate => ({
  pct: judged < EVIDENCE_MIN_SAMPLE ? null : Math.round((numerator / judged) * 100),
  judged,
})

/** The sort, in the words the caption prints. Stated on the page rather than left to be inferred
 *  from the order (R11), and asserted against the caption itself by `gate:m53-evidence` stage 11. */
const SORT_CAPTION = 'Most runs first, then by name. Nothing here is a score.'

/**
 * The chip vocabulary (R2).
 *
 * Read off the TAXONOMY rather than off the facts, and the reason is E6: the grouped reads answer
 * counts and not domains, this module may not open a second read over `EvidenceRecord`, and the
 * domain of a fact is `Capability.domain` of each key its task asked for -- so every domain a fact
 * can possibly carry is in this list by construction. A chip list built this way can never MISS a
 * domain the data has, which is the safe direction for a filter: an empty chip says honestly that
 * nothing touched that domain, while a missing chip is a filter nobody can reach.
 *
 * `GENERAL_DOMAIN` is added unconditionally because it is not a `Capability.domain` value at all --
 * it is the reserved domain a task that asked for nothing counts under.
 */
async function domainChips(): Promise<readonly EvidenceDomainChip[]> {
  const taxonomy = await listCapabilities()
  const seen = [GENERAL_DOMAIN, ...taxonomy.map((row) => row.domain)]
  return [...new Set(seen)].toSorted().map((domain) => ({ domain, label: domainLabel(domain) }))
}

export async function buildEvidencePage(filter: EvidenceFilter): Promise<EvidencePage> {
  const [byProfileGroups, byModelGroups, domains] = await Promise.all([
    evidenceByProfile({ domain: filter.domain }),
    evidenceByModel({ domain: filter.domain }),
    domainChips(),
  ])

  const byProfile: readonly EvidenceProfileRow[] = byProfileGroups.map((group) => ({
    profileKey: group.profileKey,
    name: group.name,
    bespoke: isBespokeProfileKey(group.profileKey),
    repositoryKey: group.repositoryKey,
    attempted: group.attempted,
    firstPass: rateOf(group.firstPassPassed, group.firstPassJudged),
    reviewRejected: rateOf(group.reviewRejected, group.reviewJudged),
    integrated: rateOf(group.integrated, group.integrationJudged),
    reworkCycles: group.reworkCycles,
    humanInterventions: group.humanInterventions,
    recoveries: group.recoveries,
    medianDurationMs: group.medianDurationMs,
    reportedUsd: group.reportedUsd,
    estimatedUsd: group.estimatedUsd,
    unmeasuredRuns: group.unmeasuredRuns,
    insufficient: group.attempted < EVIDENCE_MIN_SAMPLE,
  }))

  const byModel: readonly EvidenceModelRow[] = byModelGroups.map((group) => ({
    model: group.model,
    label: group.model ?? MODEL_NOT_RECORDED_LABEL,
    attempted: group.attempted,
    firstPass: rateOf(group.firstPassPassed, group.firstPassJudged),
    reviewRejected: rateOf(group.reviewRejected, group.reviewJudged),
    integrated: rateOf(group.integrated, group.integrationJudged),
    medianDurationMs: group.medianDurationMs,
    reportedUsd: group.reportedUsd,
    estimatedUsd: group.estimatedUsd,
    unmeasuredRuns: group.unmeasuredRuns,
    insufficient: group.attempted < EVIDENCE_MIN_SAMPLE,
  }))

  // The ORDER is the control reads' own (`attempted DESC, name ASC`) and is not re-sorted here: a
  // second sort would be a second answer to the question the caption states.
  return { domains, byProfile, byModel, sortCaption: SORT_CAPTION, minSample: EVIDENCE_MIN_SAMPLE }
}
