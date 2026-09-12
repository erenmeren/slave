import { capabilityIndex, GENERAL_DOMAIN, type CapabilityKey, type CapabilityRecord } from '../capability/taxonomy.js'
import { estimateCostUsd } from '../guardrails/pricing.js'
import { costProvenanceOf, type CostProvenance, type CostRow } from '../guardrails/spend.js'

/**
 * Every column of an `EvidenceRecord` that can be computed without touching a database (M53 R1-R6).
 *
 * The rule this file exists to keep: `packages/control/src/evidence.ts` READS -- one `SlaveRun`
 * row and a handful of bounded event counts -- and this module DECIDES. Nothing here takes a Prisma
 * type, nothing here is async, and every case in `derive.test.ts` is a literal. It is also what
 * makes R7's backfill honest: the script and the pipeline call the same reader, which calls these
 * same functions, so a row derived from history and a row derived at conclusion cannot disagree.
 */

/**
 * The PROFILE half of the fact's identity (R1): the catalog persona a worker was hired from, or the
 * worker itself when nobody hired it from anything.
 *
 * `template:<id>` and `slave:<id>` are two namespaces on purpose -- a bespoke worker is its OWN
 * profile and is never unified with the template it resembles. `CompanySlave` is deliberately not
 * the key: its own comment (`schema.prisma:508-511`) claims statistics accrue to the durable name
 * across projects, nothing has ever implemented that, and choosing it would key a company-wide
 * record on a row a project hire does not have.
 */
export function profileKeyOf(input: {
  readonly slaveId: string
  readonly hiredFromTemplateId: string | null
}): string {
  return input.hiredFromTemplateId === null ? `slave:${input.slaveId}` : `template:${input.hiredFromTemplateId}`
}

/** True for a profile key that names one worker rather than a catalog persona -- what the `Bespoke`
 *  chip renders from. */
export function isBespokeProfileKey(key: string): boolean {
  return key.startsWith('slave:')
}

/**
 * The REPOSITORY half (R1): `Workspace.repoPath`, normalised and snapshotted at write time.
 *
 * Trailing separators only. Nothing else is touched -- no `realpath`, no case folding, no symlink
 * resolution -- because every one of those is I/O or a guess, and this function runs inside a
 * derivation that must be a pure function of stored values. The residual is R1's own and is stated
 * rather than hidden: a checkout moved to a new path splits its own history.
 */
export function normaliseRepositoryKey(repoPath: string): string {
  const trimmed = repoPath.replace(/\/+$/u, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * Which ATTEMPT this run is (R4): the `task.rework` events for this run's task whose `seq` is below
 * this run's own `run.started`, plus one.
 *
 * `bigint` because `ExecutionEvent.seq` is one, and comparing it as a `Number` would start lying at
 * 2^53. A run with no `run.started` event -- R7's incomplete history -- counts nothing and is
 * attempt 1, which is the honest floor: a count over nothing IS zero, and the first attempt is the
 * one nobody can be wrong about.
 */
export function attemptFrom(reworkSeqs: readonly bigint[], runStartedSeq: bigint | null): number {
  if (runStartedSeq === null) return 1
  return reworkSeqs.filter((seq) => seq < runStartedSeq).length + 1
}

/** R4: a run verified on its FIRST try. A run whose verify failed settles `false`, and so does one
 *  that passed on its third attempt -- which is the whole point of the column. */
export function verifiedFirstPassFrom(verdict: 'passed' | 'failed', attempt: number): boolean {
  return verdict === 'passed' && attempt === 1
}

/**
 * R4: the reviewer sent THIS run's work back.
 *
 * `task.review_rejected` is the only verify/review event carrying an attempt number
 * (`packages/domain/src/events/schema.ts:239-243`), and the comparison is what stops an older run's
 * row being charged for a rejection of newer work. A rejection carrying no attempt at all settles
 * `false` rather than guessing it is this one -- inventing an attribution is worse than recording
 * that nobody judged this run.
 */
export function reviewRejectedFrom(
  verdict: 'approved' | 'rejected',
  payloadAttempt: number | null,
  attempt: number,
): boolean {
  return verdict === 'rejected' && payloadAttempt !== null && payloadAttempt === attempt
}

/** R4: how many `task.rework` events were appended for this task AFTER this run started. 0 or 1 in
 *  today's pipeline; an `Int` and not a `Boolean` because nothing guarantees one, and a column that
 *  could silently be 2 must be able to say so. */
export function reworkCyclesFrom(reworkSeqs: readonly bigint[], runStartedSeq: bigint | null): number {
  if (runStartedSeq === null) return 0
  return reworkSeqs.filter((seq) => seq > runStartedSeq).length
}

/**
 * R5: how many times a PERSON stepped into this run. Closed, and bounded to the run's own stream.
 *
 * `run.pause_requested` + `run.resume_requested` + a `run.stopped` whose `SlaveRun.stopRequestedBy`
 * is non-null -- the operator-versus-sweep discriminator the column was added for
 * (`schema.prisma:809-816`). `supervisor.resolved` is deliberately excluded: it is a decision about
 * the WORKSPACE, carries no `runId` to be bounded by, and would make the count unbounded in exactly
 * the way the Supervisor-world loaders refuse.
 */
export function humanInterventionsFrom(input: {
  readonly pauseRequested: number
  readonly resumeRequested: number
  readonly operatorStopped: boolean
}): number {
  return input.pauseRequested + input.resumeRequested + (input.operatorStopped ? 1 : 0)
}

/**
 * R5: a recovery is exactly two things, and a breaker de-escalation is NOT one of them.
 *
 * (a) one, when this run's terminal row was written by the sweep's orphan or dead-pid arm -- known
 * because the SWEEP is the caller, never by matching the reason text of a `run.failed`, which is
 * our own prose and may be reworded; (b) every `task.unblocked` appended for this run's task after
 * this run started -- a parked task a person or the Supervisor brought back.
 *
 * Nothing else. M51 R2 made a de-escalation SILENT on purpose (`events/schema.ts:617-619`), so
 * there is no event to count and inventing one would be an M51 change wearing an M53 label. A
 * `run.resumed` after a pause is not counted either: the pause is already one
 * {@link humanInterventionsFrom} tick, and counting the resume would count one person's single act
 * twice.
 */
export function recoveriesFrom(input: {
  readonly recoveredBySweep: boolean
  readonly unblockedAfterStart: number
}): number {
  return (input.recoveredBySweep ? 1 : 0) + input.unblockedAfterStart
}

/** How long the run took, or null. Guarded on `endedAt >= startedAt`, the same guard
 *  `perSlaveRunAggregates` already applies in SQL (`apps/web/src/server/analytics.ts:101-103`): a
 *  negative span is a clock that moved, not a measurement. */
export function durationMsFrom(startedAt: Date | null, endedAt: Date | null): number | null {
  if (startedAt === null || endedAt === null) return null
  const span = endedAt.getTime() - startedAt.getTime()
  return Number.isFinite(span) && span >= 0 ? span : null
}

/**
 * R6: the money figure and the word beside it, from M51's own machinery and nothing new.
 *
 * `costProvenanceOf` decides the word; the figure is the reported `costUsd` when reported,
 * `estimateCostUsd(model, tokens)` when estimated, and `null` when unmeasured -- NEVER a zero
 * standing in for a gap, which is the reason `SlaveRun.costUsd` was made nullable in the first
 * place (`schema.prisma`'s own column comment).
 *
 * This is also where M52's carried `MODEL_PRICES` item stops being cosmetic: an unpriced model
 * makes every one of its runs read `unmeasured`, and R8's cost step then ties on it rather than
 * preferring it.
 */
export function actualCostFrom(row: CostRow): {
  readonly actualCostUsd: number | null
  readonly costProvenance: CostProvenance
} {
  const costProvenance = costProvenanceOf(row)
  if (costProvenance === 'reported') return { actualCostUsd: row.costUsd, costProvenance }
  if (costProvenance === 'unmeasured') return { actualCostUsd: null, costProvenance }
  const tokens =
    row.tokensIn === null || row.tokensOut === null ? null : { input: row.tokensIn, output: row.tokensOut }
  return { actualCostUsd: estimateCostUsd(row.model, tokens), costProvenance }
}

/**
 * R2: the domains one run's evidence counts toward -- every domain its task asked for, or the
 * reserved `general`.
 *
 * ONE row with a `domains` array, never one row per (run, domain) pair: that would double-count
 * money in the one place money must not be double-counted. Deduplicated and SORTED, so the column
 * is byte-equal whatever order the capabilities were written in -- which is what R7's "running it
 * twice writes the same rows" rests on.
 *
 * Never empty, which is what lets the column be NOT NULL: a key the taxonomy cannot resolve
 * contributes nothing, and a list that resolves to nothing at all falls back to
 * {@link GENERAL_DOMAIN}.
 */
export function domainsFor(
  requiredCapabilities: readonly CapabilityKey[],
  taxonomy: readonly CapabilityRecord[],
): readonly string[] {
  const index = capabilityIndex(taxonomy)
  const domains = new Set<string>()
  for (const key of requiredCapabilities) {
    const record = index.get(key)
    if (record !== undefined && record.domain !== '') domains.add(record.domain)
  }
  return domains.size === 0 ? [GENERAL_DOMAIN] : [...domains].toSorted()
}
