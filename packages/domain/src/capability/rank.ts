import { BASELINE_GRANTS, type PermissionKind, type PermissionRunKind } from '../permission/kinds.js'
import type { CapabilityKey } from './taxonomy.js'

/**
 * The smallest sample this project is willing to call evidence (M53 R11).
 *
 * FIVE, and the number is deliberate rather than conventional: four runs is a coin landing the same
 * way twice, and a rate over four denominators is a sentence a person would act on. Below it a
 * comparison is SKIPPED here and the words `Insufficient evidence` render on the page -- the same
 * threshold decides both, so the ranking and the surface can never disagree about which records are
 * thick enough to mean anything.
 *
 * It is the ONLY threshold this milestone owns. There is no per-workspace override and no settings
 * control for it (spec §4, M38 §8's rule): a configurable honesty threshold is a way of turning
 * honesty off.
 */
export const EVIDENCE_MIN_SAMPLE = 5

/**
 * The roadmap's six steps, in order, plus the one tie-break that makes the comparison TOTAL
 * (plan erratum E9).
 *
 * The order is the whole ruling and it is not a weighting: no two steps are ever traded off against
 * each other, which is precisely why this is a comparator chain and not a score. A candidate that
 * wins step 2 wins, whatever steps 3-6 would have said -- and a person's explicit refusal therefore
 * cannot be outvoted by a good record.
 *
 * `identity` is not one of the roadmap's six. It is the final `id` comparison R8 asks for, given a
 * NAME so {@link RankedCandidate.decidedBy} can be total: "nothing separated them but their names"
 * is a real answer, and a null there would be indistinguishable from "this is the last row".
 */
export const RANK_STEPS = [
  'capability_fit',
  'permission',
  'preference',
  'availability',
  'evidence',
  'cost_time',
  'identity',
] as const

export type RankStep = (typeof RANK_STEPS)[number]

/** What each step is CALLED when a person reads a rationale (`docs/ia.md` rule 3). */
export const RANK_STEP_LABEL: Record<RankStep, string> = {
  capability_fit: 'What they can do',
  permission: 'What they are allowed to do',
  preference: 'What somebody asked for',
  availability: 'Who is free',
  evidence: 'What their record says',
  cost_time: 'What it costs and how long it takes',
  identity: 'Nothing but their names',
}

/**
 * One profile's record as the RANKER reads it (M53 R3/R8) -- counts and two medians, never a rate.
 *
 * The rates are computed HERE rather than carried, so a denominator below {@link
 * EVIDENCE_MIN_SAMPLE} is a fact the comparator can see rather than a number somebody upstream
 * already rounded. The three denominators are independent because the three judgement columns
 * settle independently (R3): a profile can have twenty attempts, twenty verify verdicts and two
 * integrations, and the integration rate is thin while the other two are not.
 */
export interface RankEvidence {
  readonly attempted: number
  readonly firstPassJudged: number
  readonly firstPassPassed: number
  readonly reviewJudged: number
  readonly reviewRejected: number
  readonly integrationJudged: number
  readonly integrated: number
  /** Median `actualCostUsd` over the profile's `reported` and `estimated` rows. Null when none of
   *  them was measured -- which ties at step 6 rather than winning it. */
  readonly medianCostUsd: number | null
  readonly medianDurationMs: number | null
}

/** One candidate for one capability, with every fact the six steps read. Built by `teamPlanOf` from
 *  `SupervisorWorld` and by nothing else. */
export interface RankCandidate {
  /** The tie-break of last resort, and the id the caller will act on: a `Slave.id`, a
   *  `CompanySlave.id` or a `SlaveTemplate.id`, matching {@link RankCandidate.kind}. */
  readonly id: string
  readonly kind: 'slave' | 'company_slave' | 'template'
  readonly name: string
  /** R1: `template:<id>` or `slave:<id>` -- what {@link RankCandidate.evidence} was looked up by. */
  readonly profileKey: string
  /** The catalog template behind this candidate, or null for a bespoke worker. R9's preference
   *  names a template, so this is the half a preference matches on. */
  readonly templateId: string | null
  /** The model this candidate would run on -- the resolved chain, not a wish. Null when the chain
   *  names none, in which case a preference naming a model cannot match it. */
  readonly model: string | null
  /** Every still-missing capability this candidate would cover. Step 1 reads its LENGTH. */
  readonly covers: readonly CapabilityKey[]
  readonly busy: boolean
  /** R10: the `deny` rows this candidate carries. EMPTY for a template and for a company worker not
   *  yet materialised -- neither has a `SlavePermission` row, and neither is favoured nor penalised
   *  for it. There is no "would this profile be granted X" oracle in this milestone. */
  readonly deniedKinds: readonly PermissionKind[]
  /** This profile's record, or null when nothing has ever been recorded about it. */
  readonly evidence: RankEvidence | null
}

/** R9: what a person asked for, for one capability. At least one half is non-null -- a row naming
 *  neither is refused by `setStaffingPreference` and never reaches here. */
export interface RankPreference {
  readonly templateId: string | null
  readonly model: string | null
}

export interface RankContext {
  readonly capability: CapabilityKey
  readonly preference: RankPreference | null
  /** Whose baseline the permission step reads (R10). `implementation` for every staffing decision
   *  the Supervisor makes today; a parameter because the baseline differs and both answers are
   *  true. */
  readonly runKind: PermissionRunKind
}

/**
 * One ranked candidate. **No number of any kind** (M53 R11): `decidedBy` is a step NAME and
 * `reason` is a sentence built from it.
 */
export interface RankedCandidate {
  readonly candidate: RankCandidate
  /** Which step put this candidate above the NEXT one in the order, or `null` when it is last. */
  readonly decidedBy: RankStep | null
  readonly reason: string
}

/** R10: this candidate carries an explicit `deny` on a kind its run kind would otherwise have. A
 *  deny on a kind outside the baseline walls nothing off this work, and does not rank. */
function isWalled(candidate: RankCandidate, runKind: PermissionRunKind): boolean {
  const baseline: readonly PermissionKind[] = BASELINE_GRANTS[runKind]
  return candidate.deniedKinds.some((kind) => baseline.includes(kind))
}

/**
 * R9: a preference names this candidate AND this candidate can take the job.
 *
 * The `!busy` clause is the rule the ruling spends a paragraph on: position gives the preference
 * half its power (it is step 3, below permission, so it can never beat a person's explicit
 * refusal), and this gives the other half -- availability is step 4, which position does NOT
 * protect, so a preference for a busy candidate would park the work. Availability is not an
 * opinion; it is a fact about the world.
 *
 * Both halves must match when both are named: "Atlas, and on opus" is one decision and not two.
 */
function isPreferred(candidate: RankCandidate, context: RankContext): boolean {
  const preference = context.preference
  if (preference === null || candidate.busy) return false
  if (preference.templateId !== null && preference.templateId !== candidate.templateId) return false
  if (preference.model !== null && preference.model !== candidate.model) return false
  return preference.templateId !== null || preference.model !== null
}

/** A rate, or null when its own denominator is thin (R11) or absent. Null NEVER compares, which is
 *  what makes a thin record tie rather than decide. */
function rateOf(numerator: number | undefined, denominator: number | undefined): number | null {
  if (numerator === undefined || denominator === undefined) return null
  if (denominator < EVIDENCE_MIN_SAMPLE) return null
  return numerator / denominator
}

/** The three named rates of step 5, in R8's fixed order. `higherWins` is the half that differs: a
 *  review REJECTION is the one figure where less is better. */
const EVIDENCE_RATES: readonly {
  readonly clause: string
  readonly higherWins: boolean
  readonly of: (evidence: RankEvidence | null) => number | null
}[] = [
  {
    clause: 'passes verification first time more often',
    higherWins: true,
    of: (e) => rateOf(e?.firstPassPassed, e?.firstPassJudged),
  },
  {
    clause: 'is sent back in review less often',
    higherWins: false,
    of: (e) => rateOf(e?.reviewRejected, e?.reviewJudged),
  },
  {
    clause: 'gets work onto the base branch more often',
    higherWins: true,
    of: (e) => rateOf(e?.integrated, e?.integrationJudged),
  },
]

/** Step 6's two measures, in order. No sample floor: a MEDIAN is not a rate, and R11's threshold is
 *  about claims made from a denominator. A null ties. */
const COST_MEASURES: readonly {
  readonly clause: string
  readonly of: (evidence: RankEvidence | null) => number | null
}[] = [
  { clause: 'median run has cost less', of: (e) => e?.medianCostUsd ?? null },
  { clause: 'median run has finished sooner', of: (e) => e?.medianDurationMs ?? null },
]

/** The whole chain, as one comparison. Returns the sign AND the step that produced it, which is
 *  what lets the rationale be derived rather than invented. */
function compareStep(
  a: RankCandidate,
  b: RankCandidate,
  context: RankContext,
): { readonly order: number; readonly step: RankStep } {
  if (a.covers.length !== b.covers.length) {
    return { order: b.covers.length - a.covers.length, step: 'capability_fit' }
  }
  const walledA = isWalled(a, context.runKind)
  const walledB = isWalled(b, context.runKind)
  if (walledA !== walledB) return { order: walledA ? 1 : -1, step: 'permission' }

  const preferredA = isPreferred(a, context)
  const preferredB = isPreferred(b, context)
  if (preferredA !== preferredB) return { order: preferredA ? -1 : 1, step: 'preference' }

  if (a.busy !== b.busy) return { order: a.busy ? 1 : -1, step: 'availability' }

  for (const rate of EVIDENCE_RATES) {
    const left = rate.of(a.evidence)
    const right = rate.of(b.evidence)
    if (left === null || right === null || left === right) continue
    return { order: rate.higherWins ? right - left : left - right, step: 'evidence' }
  }

  for (const measure of COST_MEASURES) {
    const left = measure.of(a.evidence)
    const right = measure.of(b.evidence)
    if (left === null || right === null || left === right) continue
    return { order: left - right, step: 'cost_time' }
  }

  return { order: a.id.localeCompare(b.id), step: 'identity' }
}

/** The sentence for one adjacent pair. Every clause names a fact both candidates carry; nothing here
 *  is a judgement the function made up, and no clause contains a currency figure (erratum E10). */
function reasonFor(step: RankStep, above: RankCandidate, below: RankCandidate, context: RankContext): string {
  switch (step) {
    case 'capability_fit':
      return (
        `${above.name} covers ${String(above.covers.length)} of the capabilities still missing and ` +
        `${below.name} covers ${String(below.covers.length)}.`
      )
    case 'permission':
      return `${below.name} has been refused an operation this work needs, and ${above.name} has not.`
    case 'preference':
      return `somebody chose ${above.name} for ${context.capability}, and a person's choice comes before the record.`
    case 'availability':
      return `${above.name} is free and ${below.name} is busy.`
    case 'evidence': {
      const rate = EVIDENCE_RATES.find((one) => {
        const left = one.of(above.evidence)
        const right = one.of(below.evidence)
        return left !== null && right !== null && left !== right
      })
      return `${above.name} ${rate?.clause ?? 'has the stronger record'} than ${below.name}.`
    }
    case 'cost_time': {
      const measure = COST_MEASURES.find((one) => {
        const left = one.of(above.evidence)
        const right = one.of(below.evidence)
        return left !== null && right !== null && left !== right
      })
      return `${above.name}'s ${measure?.clause ?? 'record is cheaper'} than ${below.name}'s.`
    }
    case 'identity':
      return `nothing separates ${above.name} and ${below.name} but their names.`
  }
}

/**
 * The order the rules would staff this capability in (M53 R8) -- pure, total, deterministic, and
 * carrying no number anybody could sort by (R11).
 *
 * Six steps in the roadmap's order, and each one is a GATE rather than a weight: once a step has
 * separated two candidates the steps below it never run between them. That is what "user choices
 * win" means here and what bounds it -- a preference is step 3, so it beats the system's opinions
 * at 5 and 6 and never the person's own refusal at 2 nor the world's own fact at 4.
 *
 * `decide()` is not imported by this file, not read by it, and not changed by this milestone: this
 * function ranks a PROPOSAL a person will answer, and the scheduler goes on matching runtime roles.
 */
export function rankCandidates(
  candidates: readonly RankCandidate[],
  context: RankContext,
): readonly RankedCandidate[] {
  const ordered = [...candidates].toSorted((a, b) => compareStep(a, b, context).order)
  return ordered.map((candidate, index): RankedCandidate => {
    const next = ordered[index + 1]
    if (next === undefined) {
      return { candidate, decidedBy: null, reason: `${candidate.name} ranks last; nothing here ranks below them.` }
    }
    const { step } = compareStep(candidate, next, context)
    return { candidate, decidedBy: step, reason: reasonFor(step, candidate, next, context) }
  })
}
