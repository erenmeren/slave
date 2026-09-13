import { Prisma, prisma } from '@slave-of-ai/db/client'
import {
  actualCostFrom,
  attemptFrom,
  domainsFor,
  durationMsFrom,
  evidenceOutcomeOf,
  err,
  humanInterventionsFrom,
  normaliseRepositoryKey,
  ok,
  profileKeyOf,
  recoveriesFrom,
  reviewRejectedFrom,
  reworkCyclesFrom,
  verifiedFirstPassFrom,
  type CapabilityRecord,
  type CostProvenance,
  type EvidenceOutcome,
  type RankEvidence,
  type Result,
} from '@slave-of-ai/domain'
import type { ControlRefusal } from './refusal.js'

/**
 * THE ONE WRITER of `EvidenceRecord`, and the one place a run becomes a fact (M53 R3).
 *
 * Everything else in this milestone reads. The pipeline calls this at a run's terminal transition
 * (`pump.ts`'s four arms and `sweep.ts`'s two), the four verdict sites call it again to SETTLE, and
 * `scripts/backfill-evidence.mjs` calls exactly the same function over history -- which is what
 * makes "a fact is re-derivable from events" true by construction rather than by assertion. A
 * second derivation, in SQL or in a script, would be a second answer to one question.
 */

/** R4: what a verdict site has to say. Three shapes for four sites -- `merge.ts` and
 *  `confirmIntegration` both settle the same column, from the same fact, for the same reason. */
export type EvidenceSettle =
  | { readonly kind: 'verify'; readonly verdict: 'passed' | 'failed' }
  | { readonly kind: 'review'; readonly verdict: 'approved' | 'rejected'; readonly attempt: number | null }
  | { readonly kind: 'integration'; readonly integrated: boolean }

export interface RecordRunEvidenceOptions {
  /** R5(a): the SWEEP wrote this run's terminal row -- its orphan or dead-pid arm. Known from the
   *  caller and never by matching the reason text of a `run.failed`, which is our own prose. */
  readonly recoveredBySweep?: boolean
  /** Absent for the terminal write; present for one of the four verdicts. */
  readonly settle?: EvidenceSettle
}

/** The `SlaveRun` columns and joins one derivation needs. Selected once, explicitly, so this
 *  function's cost is a single indexed read and a reader can see exactly what it depends on. */
const RUN_SELECT = {
  id: true,
  taskId: true,
  slaveId: true,
  kind: true,
  status: true,
  model: true,
  provider: true,
  costUsd: true,
  tokensIn: true,
  tokensOut: true,
  stopRequestedBy: true,
  startedAt: true,
  terminalAt: true,
  endedAt: true,
  slave: {
    select: {
      name: true,
      hiredFromTemplateId: true,
      hiredFromTemplate: { select: { name: true } },
      team: { select: { workspaceId: true, workspace: { select: { repoPath: true } } } },
    },
  },
  task: { select: { requiredCapabilities: true } },
} satisfies Prisma.SlaveRunSelect

/**
 * The event-derived counters, in ONE pair of queries rather than six (R4, R5).
 *
 * Bounded twice over: by `(workspaceId, taskId, seq)` for the task's reworks and unblocks, and by
 * `(runId, seq)` for this run's own pause/resume/start -- the two indexes `ExecutionEvent` actually
 * carries. Never a predicate on `type` and `ts` alone, which is the unindexed full-history scan
 * `loadDenials`'s own docstring measures and refuses (`supervisorWorld.ts:340-352`).
 */
async function eventCountsFor(
  tx: Prisma.TransactionClient,
  run: { readonly id: string; readonly taskId: string | null; readonly workspaceId: string },
): Promise<{
  readonly runStartedSeq: bigint | null
  readonly reworkSeqs: readonly bigint[]
  readonly unblockedSeqs: readonly bigint[]
  readonly pauseRequested: number
  readonly resumeRequested: number
}> {
  const own = await tx.executionEvent.findMany({
    where: { runId: run.id, type: { in: ['run_started', 'run_pause_requested', 'run_resume_requested'] } },
    select: { seq: true, type: true },
    orderBy: { seq: 'asc' },
  })
  const taskRows =
    run.taskId === null
      ? []
      : await tx.executionEvent.findMany({
          where: { workspaceId: run.workspaceId, taskId: run.taskId, type: { in: ['task_rework', 'task_unblocked'] } },
          select: { seq: true, type: true },
          orderBy: { seq: 'asc' },
        })
  return {
    runStartedSeq: own.find((row) => row.type === 'run_started')?.seq ?? null,
    reworkSeqs: taskRows.filter((row) => row.type === 'task_rework').map((row) => row.seq),
    unblockedSeqs: taskRows.filter((row) => row.type === 'task_unblocked').map((row) => row.seq),
    pauseRequested: own.filter((row) => row.type === 'run_pause_requested').length,
    resumeRequested: own.filter((row) => row.type === 'run_resume_requested').length,
  }
}

/**
 * Record, or settle, one run's evidence. Idempotent on both halves.
 *
 * REFUSES BEFORE ANY WRITE (R13, plan erratum E3): a runId naming no `SlaveRun` is
 * `run_not_found`, which is also the boundary tripwire -- `Slave.teamId` and `Team.workspaceId` are
 * both NOT NULL with foreign keys, so "this run's workspace cannot be resolved" and "there is no
 * such run" are the same fact, and a `SimulationRun.id` handed to this function meets exactly that
 * refusal. A simulated role is not a `Slave`, holds no `SlavePermission` and can reach no
 * `SlaveRun`; nothing crosses.
 *
 * NOT keyed on `Workspace.archivedAt`, which is where this differs from the broker
 * (`packages/control/src/broker.ts:204`) and why the difference is written down: an archived
 * project's runs are real history, and refusing them would lose it.
 */
export async function recordRunEvidence(
  runId: string,
  opts: RecordRunEvidenceOptions = {},
): Promise<Result<void, ControlRefusal>> {
  const run = await prisma.slaveRun.findUnique({ where: { id: runId }, select: RUN_SELECT })
  if (run === null) return err({ kind: 'run_not_found', runId })

  const outcome = evidenceOutcomeOf(run.status)
  // A live run is evidence about nothing. Returned as SUCCESS rather than refused: the pump calls
  // this from arms whose conditional terminal write may legitimately have lost a race, and a
  // refusal there would turn "somebody else concluded this run" into an error in the daemon log.
  if (outcome === null) return ok(undefined)

  const workspaceId = run.slave.team.workspaceId
  const counts = await eventCountsFor(prisma, { id: run.id, taskId: run.taskId, workspaceId })
  const attempt = attemptFrom(counts.reworkSeqs, counts.runStartedSeq)
  // The taxonomy, read once per call and only when there is something to resolve. An empty list
  // answers `general` without a query at all.
  const required = run.task?.requiredCapabilities ?? []
  const taxonomy: readonly CapabilityRecord[] =
    required.length === 0
      ? []
      : (await prisma.capability.findMany({ where: { key: { in: [...required] } } })).map((row) => ({
          key: row.key,
          label: row.label,
          domain: row.domain,
          role: row.role,
          synonyms: row.synonyms,
        }))
  const cost = actualCostFrom({
    costUsd: run.costUsd,
    provider: run.provider,
    status: run.status,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    model: run.model,
  })

  const derived = {
    workspaceId,
    slaveId: run.slaveId,
    taskId: run.taskId,
    profileKey: profileKeyOf({ slaveId: run.slaveId, hiredFromTemplateId: run.slave.hiredFromTemplateId }),
    // The template's name when it came from one, the worker's own otherwise. A deleted template
    // leaves `hiredFromTemplate` null while `hiredFromTemplateId` still reads -- `onDelete: SetNull`
    // fires on the column, so this fallback is the "a surface must print a word" half of R1.
    profileName: run.slave.hiredFromTemplate?.name ?? run.slave.name,
    model: run.model,
    repositoryKey: normaliseRepositoryKey(run.slave.team.workspace.repoPath),
    domains: [...domainsFor(required, taxonomy)],
    runKind: run.kind,
    attempt,
    outcome,
    reworkCycles: reworkCyclesFrom(counts.reworkSeqs, counts.runStartedSeq),
    humanInterventions: humanInterventionsFrom({
      pauseRequested: counts.pauseRequested,
      resumeRequested: counts.resumeRequested,
      operatorStopped: run.status === 'stopped' && run.stopRequestedBy !== null,
    }),
    recoveries: recoveriesFrom({
      recoveredBySweep: opts.recoveredBySweep === true,
      unblockedAfterStart:
        counts.runStartedSeq === null
          ? 0
          : counts.unblockedSeqs.filter((seq) => seq > (counts.runStartedSeq as bigint)).length,
    }),
    durationMs: durationMsFrom(run.startedAt, run.endedAt),
    actualCostUsd: cost.actualCostUsd,
    costProvenance: cost.costProvenance,
  }

  // The WRITE half. Either branch carries the dimension keys and the run-local measurements and
  // NOTHING else: not `recordedAt`, not `settledAt`, and not one of the three judgement columns.
  // That is what makes a second pass byte-equal to the first (plan erratum E15) and what makes "a
  // judgement moves from null exactly once" a property of the SQL rather than of a convention.
  //
  // A SETTLE NEVER CREATES A FACT (R4). The terminal write is the `upsert`; a verdict is an
  // `updateMany` on the run's own row, which writes nothing at all when there is no row to settle
  // -- a database that predates this milestone, or a run nobody recorded. Re-deriving on that path
  // costs one query and keeps the two branches one computation rather than two.
  if (opts.settle === undefined) {
    await prisma.evidenceRecord.upsert({ where: { runId }, create: { runId, ...derived }, update: derived })
    return ok(undefined)
  }
  await prisma.evidenceRecord.updateMany({ where: { runId }, data: derived })
  await applySettle(runId, opts.settle, attempt, run.kind)
  return ok(undefined)
}

/**
 * R4's settle, as three guarded updates (plan erratum E1).
 *
 * Each column is written by an `updateMany` conditioned on THAT COLUMN being null, so a verdict
 * moves it from "nobody judged this" to a verdict exactly once and can never move it back -- and a
 * replayed conclusion, which `concludeReview` legitimately allows, writes nothing. `settledAt` is
 * stamped by its own guarded update and means "somebody has judged this run at least once".
 *
 * A REVIEW run's row and a PLANNING run's row are left alone entirely: a reviewer receives no
 * verdict, and attributing one to it would make the reviewer's record a copy of the implementer's.
 * Enforced HERE rather than at the four call sites (plan decision D16): a rule enforced at the
 * writer holds for the backfill, for a future caller and for a test, and a rule enforced at four
 * call sites holds until somebody adds a fifth.
 */
async function applySettle(
  runId: string,
  settle: EvidenceSettle,
  attempt: number,
  runKind: 'implementation' | 'review' | 'planning',
): Promise<void> {
  if (runKind !== 'implementation') return

  if (settle.kind === 'verify') {
    await prisma.evidenceRecord.updateMany({
      where: { runId, verifiedFirstPass: null },
      data: { verifiedFirstPass: verifiedFirstPassFrom(settle.verdict, attempt) },
    })
  } else if (settle.kind === 'review') {
    await prisma.evidenceRecord.updateMany({
      where: { runId, reviewRejected: null },
      data: { reviewRejected: reviewRejectedFrom(settle.verdict, settle.attempt, attempt) },
    })
  } else {
    await prisma.evidenceRecord.updateMany({
      where: { runId, integrated: null },
      data: { integrated: settle.integrated },
    })
  }
  await prisma.evidenceRecord.updateMany({ where: { runId, settledAt: null }, data: { settledAt: new Date() } })
}

/**
 * The settle for a verdict that knows a TASK and not a run (plan erratum E2).
 *
 * `implementerOf` answers "who did the work" and an `EvidenceRecord` is keyed on a run, so the four
 * verdict sites need this resolver. It is the same `findFirst` `merge.ts`'s `latestImpl` already
 * makes (`merge.ts:167-170`) -- the task's newest implementation run -- and it calls the one writer
 * rather than duplicating a line of it.
 *
 * Silent when there is nothing to settle: a task whose implementation run has no evidence row (a
 * database that predates this milestone, a run that never concluded) is not an error, it is a run
 * nobody recorded.
 */
export async function settleTaskEvidence(taskId: string, settle: EvidenceSettle): Promise<void> {
  const run = await prisma.slaveRun.findFirst({
    where: { taskId, kind: 'implementation', terminalAt: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  })
  if (run === null) return
  await recordRunEvidence(run.id, { settle })
}

/**
 * WHAT a read is about: one domain or every domain, one project or every project (R2, R12).
 *
 * `domain` null means every domain. A named domain becomes an array CONTAINMENT predicate, which is
 * what the GIN index on `domains` exists for and what makes R2's arithmetic honest: a run whose task
 * asked for two domains counts under BOTH chips and is one row in neither total, so the filtered
 * counts deliberately do not sum to the unfiltered one.
 *
 * `workspaceId` null means every project. The Evidence tab lives on `/workforce`, which is global
 * (R1: "a record spans the workspaces one installation holds"); the column is here for the
 * per-project read a later milestone may want, and the index on `workspaceId` is already there.
 */
export interface EvidenceFilter {
  readonly domain?: string | null
  readonly workspaceId?: string | null
  readonly limit?: number
}

/** What `listEvidence` prints when nobody narrows it. A page of history, not a window on it: the
 *  CLI is the only caller, and an operator asking for "the evidence" wants the recent end of it. */
const LIST_EVIDENCE_LIMIT = 200

/** The two bounds every read below shares, as one predicate rather than three spellings of it. */
function whereOf(filter: EvidenceFilter): Prisma.Sql {
  const clauses: Prisma.Sql[] = []
  const domain = filter.domain ?? null
  if (domain !== null) clauses.push(Prisma.sql`"domains" && ARRAY[${domain}]::text[]`)
  const workspaceId = filter.workspaceId ?? null
  if (workspaceId !== null) clauses.push(Prisma.sql`"workspaceId" = ${workspaceId}`)
  return clauses.length === 0 ? Prisma.sql`TRUE` : Prisma.join(clauses, ' AND ')
}

/**
 * The counters every grouped read shares (R3, R6).
 *
 * Each judgement is TWO numbers -- how many rows were judged at all, and how many of those the
 * verdict went a particular way for -- because a rate over an unjudged denominator is not a rate.
 * `EVIDENCE_MIN_SAMPLE` decides whether a surface prints the rate or `Insufficient evidence`, and it
 * can only decide that if it can see the denominator.
 *
 * The money is THREE figures and never one `SUM("actualCostUsd")` (R6): a sum that silently absorbs
 * the runs nobody measured is the figure this milestone deletes from `/analytics`.
 */
const GROUP_COUNTERS = Prisma.sql`
  COUNT(*) AS attempted,
  COUNT(*) FILTER (WHERE "verifiedFirstPass" IS NOT NULL) AS "firstPassJudged",
  COUNT(*) FILTER (WHERE "verifiedFirstPass") AS "firstPassPassed",
  COUNT(*) FILTER (WHERE "reviewRejected" IS NOT NULL) AS "reviewJudged",
  COUNT(*) FILTER (WHERE "reviewRejected") AS "reviewRejected",
  COUNT(*) FILTER (WHERE "integrated" IS NOT NULL) AS "integrationJudged",
  COUNT(*) FILTER (WHERE "integrated") AS integrated,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY "durationMs"::float8) AS "medianDurationMs",
  (SUM("actualCostUsd") FILTER (WHERE "costProvenance"::text = 'reported'))::float8 AS "reportedUsd",
  (SUM("actualCostUsd") FILTER (WHERE "costProvenance"::text = 'estimated'))::float8 AS "estimatedUsd",
  COUNT(*) FILTER (WHERE "costProvenance"::text = 'unmeasured') AS "unmeasuredRuns"
`

/** The shape the driver hands back for {@link GROUP_COUNTERS}. `bigint` on every COUNT is `pg`'s
 *  behaviour for those aggregates, and every consumer converts with `Number()` at the point it reads
 *  the field and never earlier -- the rule `apps/web/src/server/analytics.ts`'s own aggregate
 *  docstring states. */
interface GroupCountersRow {
  readonly attempted: bigint
  readonly firstPassJudged: bigint
  readonly firstPassPassed: bigint
  readonly reviewJudged: bigint
  readonly reviewRejected: bigint
  readonly integrationJudged: bigint
  readonly integrated: bigint
  readonly medianDurationMs: number | null
  readonly reportedUsd: number | null
  readonly estimatedUsd: number | null
  readonly unmeasuredRuns: bigint
}

/** The counters a surface reads, with the bigints already spent. `medianDurationMs` is ROUNDED: a
 *  median of an even number of runs is an interpolation, and half a millisecond is not a fact about
 *  a run -- money keeps its fraction, because a fraction of a dollar is. */
interface EvidenceCounters {
  readonly attempted: number
  readonly firstPassJudged: number
  readonly firstPassPassed: number
  readonly reviewJudged: number
  readonly reviewRejected: number
  readonly integrationJudged: number
  readonly integrated: number
  readonly medianDurationMs: number | null
  readonly reportedUsd: number | null
  readonly estimatedUsd: number | null
  readonly unmeasuredRuns: number
}

function countersOf(row: GroupCountersRow): EvidenceCounters {
  return {
    attempted: Number(row.attempted),
    firstPassJudged: Number(row.firstPassJudged),
    firstPassPassed: Number(row.firstPassPassed),
    reviewJudged: Number(row.reviewJudged),
    reviewRejected: Number(row.reviewRejected),
    integrationJudged: Number(row.integrationJudged),
    integrated: Number(row.integrated),
    medianDurationMs: row.medianDurationMs === null ? null : Math.round(row.medianDurationMs),
    reportedUsd: row.reportedUsd,
    estimatedUsd: row.estimatedUsd,
    unmeasuredRuns: Number(row.unmeasuredRuns),
  }
}

/** One row of R12's by-profile table: the PROFILE and the REPOSITORY together, because the same
 *  persona on two checkouts is two records and folding them would average across codebases. */
export interface EvidenceProfileGroup extends EvidenceCounters {
  readonly profileKey: string
  /** The NEWEST `profileName` this key was written with -- a template renamed last week prints the
   *  name it has now, and the snapshot on every older row is what makes that possible without a
   *  join to a table the template may have left. */
  readonly name: string
  readonly repositoryKey: string
  readonly reworkCycles: number
  readonly humanInterventions: number
  readonly recoveries: number
}

/** One row of R12's by-model table -- seven columns, and deliberately not the profile's eleven: a
 *  model does not have rework cycles, interventions or recoveries in any sense a person can act on,
 *  and printing them beside a model name would invite exactly the confusion the two tables exist to
 *  prevent. */
export interface EvidenceModelGroup extends EvidenceCounters {
  /** Null is a REAL group -- a run recorded before M51 wrote no model -- and the table prints it as
   *  `MODEL_NOT_RECORDED_LABEL` rather than dropping the runs. */
  readonly model: string | null
}

/**
 * The by-profile table (R12), grouped in SQL over `(profileKey, repositoryKey)`.
 *
 * ONE aggregation for the whole milestone (plan erratum E6): `apps/web/src/server/evidence.ts` calls
 * this and owns only the labels and the shape, exactly as `server/organization.ts` calls
 * `listOrganization`. Two `GROUP BY`s over one table would eventually tell a person the profile has
 * attempted 40 runs on one page and 38 on another, with no way to tell which was right.
 */
export async function evidenceByProfile(filter: EvidenceFilter): Promise<readonly EvidenceProfileGroup[]> {
  // `ARRAY_AGG(... ORDER BY "recordedAt" DESC)[1]` is `loadDenials`' own idiom
  // (`supervisorWorld.ts:365`): the newest value of a column that is a SNAPSHOT rather than a key,
  // taken without a second query and without a join to a template the profile may have left.
  const rows = await prisma.$queryRaw<
    (GroupCountersRow & {
      readonly profileKey: string
      readonly name: string
      readonly repositoryKey: string
      readonly reworkCycles: bigint | null
      readonly humanInterventions: bigint | null
      readonly recoveries: bigint | null
    })[]
  >(Prisma.sql`
    SELECT "profileKey",
           "repositoryKey",
           (ARRAY_AGG("profileName" ORDER BY "recordedAt" DESC))[1] AS name,
           SUM("reworkCycles") AS "reworkCycles",
           SUM("humanInterventions") AS "humanInterventions",
           SUM("recoveries") AS "recoveries",
           ${GROUP_COUNTERS}
    FROM "EvidenceRecord"
    WHERE ${whereOf(filter)}
    GROUP BY "profileKey", "repositoryKey"
    ORDER BY attempted DESC, name ASC
  `)
  return rows.map((row) => ({
    profileKey: row.profileKey,
    name: row.name,
    repositoryKey: row.repositoryKey,
    reworkCycles: Number(row.reworkCycles ?? 0n),
    humanInterventions: Number(row.humanInterventions ?? 0n),
    recoveries: Number(row.recoveries ?? 0n),
    ...countersOf(row),
  }))
}

/**
 * The by-model table (R12), grouped on the model alone.
 *
 * `NULLS LAST` on the name, not on the count: a group with no name cannot sort by one, and putting
 * the unrecorded-model rows at the top of a table sorted by name would be an accident of collation
 * rather than a decision.
 */
export async function evidenceByModel(filter: EvidenceFilter): Promise<readonly EvidenceModelGroup[]> {
  const rows = await prisma.$queryRaw<(GroupCountersRow & { readonly model: string | null })[]>(Prisma.sql`
    SELECT "model",
           ${GROUP_COUNTERS}
    FROM "EvidenceRecord"
    WHERE ${whereOf(filter)}
    GROUP BY "model"
    ORDER BY attempted DESC, "model" ASC NULLS LAST
  `)
  return rows.map((row) => ({ model: row.model, ...countersOf(row) }))
}

/**
 * The RANKER's read (R8): one profile's record, for each candidate and for nobody else.
 *
 * BOUNDED BY THE CANDIDATE SET rather than by a window -- `WHERE "profileKey" = ANY(...)` is an
 * index probe on `(profileKey, model, repositoryKey)` over at most roster + company + catalog keys
 * (plan erratum E8) -- and it ASKS NOTHING AT ALL for an empty list, the bounded-loader rule M52
 * erratum E9 already applied to `denials`. A query whose `IN` list is empty is a query for nothing.
 *
 * `tx` DEFAULTS TO `prisma` and is the shape every other cross-module read the Supervisor's loader
 * makes already has -- `workspaceStats(workspaceId, client = prisma)` (`stats.ts:88-91`),
 * `staleCandidateCount(workspaceId, now, tx = prisma)` (`memory.ts:676-680`),
 * `waitingSenderRunIds(workspaceId, tx)` (fix round 1, Important 2). The Evidence tab and the CLI
 * pass nothing and are unchanged; `loadProfileEvidence` passes the world's transaction client, so
 * this count is read inside the same `RepeatableRead` snapshot as the roster it is about --
 * `SupervisorWorld`'s own contract is "at one instant" -- and no second pooled connection is
 * acquired while the loader's is pinned, which is the doctrine `apps/orchestrator/src/world.ts:165-167`
 * states.
 *
 * The cost median reads `FILTER (WHERE "costProvenance" <> 'unmeasured')`, which is what makes
 * "unmeasured is not cheap" (R8) a property of the SQL: a run nobody measured is excluded from the
 * figure rather than counted as a zero, and `rankCandidates` then puts a profile with no figure at
 * all in its UNMEASURED class rather than at the cheap end. The DURATION median carries no such
 * filter deliberately: how long a run took is measured by the clock, and dropping a run's duration
 * because nobody priced it would lose a fact we have.
 *
 * Grouped on `profileKey` ALONE, unlike {@link evidenceByProfile}: a candidate is a profile, a
 * ranking is about who to staff rather than about which checkout they last worked on, and splitting
 * the record by repository would leave every candidate thinner than the sample floor.
 */
export async function evidenceForProfiles(
  profileKeys: readonly string[],
  tx: Prisma.TransactionClient = prisma,
): Promise<ReadonlyMap<string, RankEvidence>> {
  if (profileKeys.length === 0) return new Map()
  const rows = await tx.$queryRaw<
    (GroupCountersRow & { readonly profileKey: string; readonly medianCostUsd: number | null })[]
  >(Prisma.sql`
    SELECT "profileKey",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY "actualCostUsd")
             FILTER (WHERE "costProvenance"::text <> 'unmeasured') AS "medianCostUsd",
           ${GROUP_COUNTERS}
    FROM "EvidenceRecord"
    WHERE "profileKey" = ANY(${[...profileKeys]}::text[])
    GROUP BY "profileKey"
  `)
  return new Map(
    rows.map((row) => {
      const counters = countersOf(row)
      return [
        row.profileKey,
        {
          attempted: counters.attempted,
          firstPassJudged: counters.firstPassJudged,
          firstPassPassed: counters.firstPassPassed,
          reviewJudged: counters.reviewJudged,
          reviewRejected: counters.reviewRejected,
          integrationJudged: counters.integrationJudged,
          integrated: counters.integrated,
          medianCostUsd: row.medianCostUsd,
          medianDurationMs: counters.medianDurationMs,
        } satisfies RankEvidence,
      ]
    }),
  )
}

/** One fact, as it is stored. The CLI's `evidence list` prints these and nothing else reads them:
 *  every surface that shows a RECORD reads a grouped verb above, because a person looking at a
 *  workforce is asking about a profile and not about a run. */
export interface EvidenceRow {
  readonly runId: string
  readonly workspaceId: string
  readonly slaveId: string
  readonly taskId: string | null
  readonly profileKey: string
  readonly profileName: string
  readonly model: string | null
  readonly repositoryKey: string
  readonly domains: readonly string[]
  readonly runKind: string
  readonly attempt: number
  readonly outcome: EvidenceOutcome
  readonly verifiedFirstPass: boolean | null
  readonly reviewRejected: boolean | null
  readonly integrated: boolean | null
  readonly reworkCycles: number
  readonly humanInterventions: number
  readonly recoveries: number
  readonly durationMs: number | null
  readonly actualCostUsd: number | null
  readonly costProvenance: CostProvenance
  readonly recordedAt: Date
  readonly settledAt: Date | null
}

/**
 * The rows themselves, newest first (R12).
 *
 * BOUNDED, always: `limit` defaults to {@link LIST_EVIDENCE_LIMIT} and a caller may narrow it but
 * cannot remove it. This is the one read that returns rows rather than counts, and an unbounded one
 * on a table with a row per run of an installation's whole history is the shape every other loader
 * in this package refuses.
 */
export async function listEvidence(filter: EvidenceFilter): Promise<readonly EvidenceRow[]> {
  const limit = filter.limit ?? LIST_EVIDENCE_LIMIT
  return prisma.$queryRaw<EvidenceRow[]>(Prisma.sql`
    SELECT "runId", "workspaceId", "slaveId", "taskId", "profileKey", "profileName", "model",
           "repositoryKey", "domains", "runKind"::text AS "runKind", "attempt",
           "outcome"::text AS "outcome", "verifiedFirstPass", "reviewRejected", "integrated",
           "reworkCycles", "humanInterventions", "recoveries", "durationMs", "actualCostUsd",
           "costProvenance"::text AS "costProvenance", "recordedAt", "settledAt"
    FROM "EvidenceRecord"
    WHERE ${whereOf(filter)}
    ORDER BY "recordedAt" DESC
    LIMIT ${limit}
  `)
}
