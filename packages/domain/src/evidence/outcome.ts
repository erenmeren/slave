import { NON_TERMINAL_RUN_STATUSES, type RunStatus } from '../run/state.js'

/**
 * How a run ENDED, as evidence sees it (M53 R3).
 *
 * Exactly the three terminal members of {@link RunStatus} and closed: a run that has not finished
 * is not evidence about anything, and {@link evidenceOutcomeOf} answers `null` for every status
 * that can still move. The Postgres enum of the same name is pinned against this list in
 * `packages/db/test/integration/enum-parity.test.ts`, which is where every other enum parity
 * assertion in this repository lives.
 *
 * `stopped` is kept apart from `failed` deliberately, and it is the same distinction
 * `apps/web/src/server/analytics.ts`'s seven-day series already makes: an operator's cancel is not
 * the system failing, and folding it into the failure count would charge a worker's record for a
 * person's decision.
 */
export const EVIDENCE_OUTCOMES = ['succeeded', 'failed', 'stopped'] as const

export type EvidenceOutcome = (typeof EVIDENCE_OUTCOMES)[number]

/** What each outcome is CALLED when a person reads a row (`docs/ia.md` rule 3). A `Record` over the
 *  union, so a fourth outcome fails the build here rather than turning up in a table cell as an
 *  identifier. */
export const EVIDENCE_OUTCOME_LABEL: Record<EvidenceOutcome, string> = {
  succeeded: 'Finished',
  failed: 'Failed',
  // Not "Stopped": the word that matters is that somebody DID it, which is what keeps this column
  // from reading as a third kind of failure.
  stopped: 'Stopped by somebody',
}

/** The outcome for a run's status, or `null` while the run can still move. Total over `RunStatus`,
 *  by construction rather than by a second list: everything not in
 *  {@link NON_TERMINAL_RUN_STATUSES} is one of the three. */
export function evidenceOutcomeOf(status: RunStatus): EvidenceOutcome | null {
  if ((NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(status)) return null
  return status as EvidenceOutcome
}

/**
 * What a row says INSTEAD of a rate when its own denominator is below `EVIDENCE_MIN_SAMPLE`
 * (M53 R11).
 *
 * Spelled once, here, because three things read it: the table cell, the `evidence-insufficient-*`
 * testid's own row, and `scripts/gate-m53-evidence.mjs` stage 9, which asserts the words in the
 * browser. Not a dash, not a zero and not a greyed percentage -- all three were considered and all
 * three are a claim about a record nobody has enough of. `MappingQuality`'s `full|partial|none` and
 * `CostProvenance`'s `reported|estimated|unmeasured` are the precedents: an honest small state,
 * never a fabricated number.
 */
export const INSUFFICIENT_EVIDENCE = 'Insufficient evidence'

/** What the by-model table calls the group of runs whose `SlaveRun.model` was never written
 *  (M53 R1) -- every pre-M51 run, and any run whose profile chain named no model. A real group
 *  with real counts; the RANKER skips it, because a model nobody recorded cannot be preferred. */
export const MODEL_NOT_RECORDED_LABEL = 'Model not recorded'

/** The chip beside a profile that is one hand-made worker rather than a catalog persona (M53 R1) --
 *  a `Slave` with `hiredFromTemplateId` null, which every pre-M46 row and every "New slave" row is.
 *  The chip is what stops a reader taking a bespoke row for a template's record. */
export const BESPOKE_PROFILE_LABEL = 'Bespoke'
