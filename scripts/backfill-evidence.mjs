// scripts/backfill-evidence.mjs — "history counts from day one" (M53 R7).
//
//   npm run backfill:evidence
//   npm run backfill:evidence -- --batch 500
//   npm run backfill:evidence -- --dry-run
//
// Walks every CONCLUDED `SlaveRun` THAT EVER STARTED, in `id` order, in bounded batches, and calls the SAME
// `recordRunEvidence` the pipeline calls. There is one derivation in this system and this script
// does not add a second: a rule written twice is a rule that eventually disagrees with itself, and
// the thing it would disagree about here is whether a profile is any good.
//
// "CONCLUDED" IS A STATUS, NEVER A TIMESTAMP (fix round 1, Important 1). The walk selects
// `status NOT IN NON_TERMINAL_RUN_STATUSES` -- the same array `evidenceOutcomeOf`
// (`packages/domain/src/evidence/outcome.ts`) reads to decide the very same question, so there is
// one definition and it cannot drift. A `terminalAt IS NOT NULL` predicate would be a SECOND
// definition, and it disagrees with the first exactly on the rows this script exists for:
// `packages/control/src/stats.ts:123-127` records that `SlaveRun.terminalAt` has only been written
// by the pump since M5 Task 12 and that rows older than that still carry `null` -- it calls a bare
// `terminalAt` predicate "not merely imprecise, it is a trap". Such a run would have been never
// scanned, never recorded and in no counter, under a header claiming day one.
//
// It is `NON_TERMINAL_RUN_STATUSES` and not `stats.ts`'s `CONCLUDED_RUN_STATUSES`, which is a
// different question with a different answer: that list classifies `stopped` as
// `terminal_uncounted` because an operator stopping a run is not the run failing. A stop IS
// evidence -- `EVIDENCE_OUTCOME_LABEL.stopped` is `Stopped by somebody` and R5's
// `humanInterventions` counts it -- so this walk must see it.
//
// HISTORY IS RECORDED, NOT JUDGED (erratum E23). A run this script fills in gets its facts -- the
// dimension keys, the outcome, the attempt, the counters, the money -- and its three JUDGEMENT
// columns stay "nobody has judged this yet". This script never calls `settleTaskEvidence` and never
// settles a column: a verdict is the live site's act at the moment somebody reached it (erratum E1
// makes it irreversible), and deriving one from old events afterwards is carried backlog, not this
// pass. `alreadyJudged` below counts rows that were ALREADY judged, by the pipeline, before this
// script ran; it is a reading and never a write.
//
// SAFE ON A LIVE DATABASE, and this is the second reason it exists. Eight transitions write a fact
// the moment a run concludes (plan errata E22 and E25), and a crash between the terminal status write and
// its evidence write leaves a run with no fact that nothing re-derives on its own. THIS IS THE
// REPAIR: it is idempotent, it goes through the one writer, it reads and writes in bounded batches
// rather than locking a table, and it settles nothing. Run it while the daemon is running.
//
// DETERMINISTIC. Every input is a stored row or a stored event; the only clock it reads is
// `recordedAt`'s default on a row that does not yet exist; and the order it walks in cannot change
// the result, because each run's derivation reads only that run and its own task's events.
//
// IDEMPOTENT, AND NOT BY CHECKING. It has no "skip rows that already exist" branch, deliberately
// (plan erratum E15): `recordRunEvidence`'s upsert re-derives every column and its `update` half
// touches neither `recordedAt` nor `settledAt` nor any judgement column, so a second pass writes
// the same bytes. A skip branch would make the second pass prove nothing. The counters DO tell an
// operator how many rows were already there — that is a report about the pass, read once per batch
// in a single query, and it gates nothing.
//
// A RUN THAT NEVER STARTED IS NOT HISTORY, AND IS SKIPPED (erratum E25, final wave). The
// discriminator is one event: `run.started`, appended by the pump the moment a child is actually
// running (`pump.ts:715`). A `SlaveRun` row without one is a dispatch that failed at spawn -- the
// worktree could not be provisioned, the CLI could not be started -- and R3 says those write NO
// fact: nothing was attempted, and a profile whose dispatches failed to spawn has not been
// evidenced about. The pipeline's three spawn-failure arms stay silent, and this script now agrees
// with them instead of quietly filling in rows the live system refuses: before the final wave, a
// profile's `attempted` count, the by-model table and the step-6 duration median all changed
// depending on whether an operator had ever run this script, because each of those rows
// contributed a sub-second duration nobody worked. They are counted as `never started` and named
// in neither the created nor the skipped total.
//
// THE COST OF THAT RULE, STATED: a run that really ran and whose `run.started` event was later
// deleted is indistinguishable here from one that never started, and this script will not record
// it. That is the price of having ONE rule for the live sites and the repair, and it is the right
// way round -- inventing history for a dispatch that never happened is worse than declining to
// re-create history somebody deleted.
//
// RUNS WHOSE EVENTS ARE OTHERWISE INCOMPLETE are the normal case on an old database, and they are
// recorded honestly rather than skipped: the run-local columns (outcome, duration, cost, provenance,
// kind and all four dimension keys) come from the `SlaveRun` ROW, which always exists; the
// event-derived counters read a count over a possibly-empty set and record zero, because a count
// over nothing IS zero; and the three JUDGEMENT columns stay null -- "nobody judged this, or the
// record of the judgement is gone" -- rather than settling `false`, which would manufacture a
// failure. A `false` written here could never be taken back (erratum E1) and it feeds a staffing
// decision.
//
// A run this script cannot record is COUNTED AND REPORTED, never fatal: one unreadable row must not
// stop an operator filling in five years of history. The counters name the two classes apart --
// `run_not_found`, which is the BOUNDARY refusal (R13, erratum E3), and everything else.
//
// THE SIMULATION BOUNDARY (R6, R13). Nothing simulated can enter this walk: a simulated role is not
// a `Slave`, a simulated step is not a `SlaveRun`, and `SlaveRun` is the only table read here. The
// boundary is therefore a TRIPWIRE rather than a filter -- `recordRunEvidence` answers
// `run_not_found` for an id no `SlaveRun` carries, which is exactly what a `SimulationRun.id` meets,
// and `skippedSimulation` counts those. A filter that dropped rows BY PROJECT would be the opposite
// mistake: a project adopted from a simulation (`Workspace.adoptedFromSimulationId`) runs real
// workers against a real checkout, and skipping its runs would lose real history.
//
// WHAT A DRY RUN CANNOT KNOW (fix round 1, item 3). `--dry-run` hands no run to the writer, so it
// cannot know which runs the writer would refuse: `skipped`, `skippedSimulation` and
// `skippedIncomplete` come back `null` rather than `0`, and the summary says so instead of printing
// a clean pass nobody measured. What it CAN know it names: every run it would create is printed by
// id as it is reached, and `skippedNeverStarted` is a NUMBER even in a dry run -- that decision is
// a read this pass really makes, not an answer only the writer has.
//
// IT IS NOT A MIGRATION. `20260913090000_m53_evidence` is additive DDL and carries no data statement
// at all; the data arrives here, run once by a person who chose to run it. That is ADR 0003's
// discipline (one write gate, and data statements do not hide inside schema changes), not a style
// preference.
//
// IT WRITES THROUGH ONE VERB AND NOWHERE ELSE. Nothing in this file removes a row, edits one in
// place, or reaches Postgres with raw SQL -- and the check for that is a grep, so this sentence is
// deliberately written without naming the Prisma methods it forbids, which would make the grep
// match its own prose. The only write this script can cause is the upsert `recordRunEvidence`
// makes, on a table nothing else owns.

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { recordRunEvidence, refusalText } from '../packages/control/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'
import { NON_TERMINAL_RUN_STATUSES } from '../packages/domain/dist/index.js'

/**
 * One pass over every concluded run.
 *
 * `recordOne` is a seam for the test and for nothing else: it defaults to the pipeline's own verb,
 * and the point of the default is that a backfilled row is byte-identical to a live one.
 */
export async function backfillEvidence({ batchSize = 200, dryRun = false, recordOne = recordRunEvidence } = {}) {
  let cursor = null
  let scanned = 0
  let created = 0
  let alreadyPresent = 0
  let alreadyJudged = 0
  let skippedSimulation = 0
  let skippedIncomplete = 0
  let skippedNeverStarted = 0

  for (;;) {
    // A CURSOR and never an OFFSET: an offset re-reads and re-sorts everything it skips, which on a
    // five-year table is the whole table once per batch. `id` is the primary key, so this is an
    // index range scan whatever the batch size is -- which is also what makes the batch size not
    // change the result.
    const runs = await prisma.slaveRun.findMany({
      where: {
        status: { notIn: [...NON_TERMINAL_RUN_STATUSES] },
        ...(cursor === null ? {} : { id: { gt: cursor } }),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    })
    if (runs.length === 0) break

    // ONE read per BATCH, for the REPORT and never for a branch. An operator repairing a lost write
    // needs "how many of these were already here" and "how many already carry a verdict" to be able
    // to read the pass at all; both are answered here, and neither decides whether a run is
    // recorded -- every scanned run goes to the writer either way (erratum E15).
    const before = new Map(
      (
        await prisma.evidenceRecord.findMany({
          where: { runId: { in: runs.map((run) => run.id) } },
          select: { runId: true, settledAt: true },
        })
      ).map((row) => [row.runId, row.settledAt]),
    )

    // DID THIS RUN EVER START? One query per batch on the `(runId, seq)` index -- the same index
    // the derivation's own event read is bounded by, never a predicate on `type` alone -- and the
    // answer is the whole of erratum E25's rule: a `SlaveRun` row with no `run.started` event is a
    // dispatch that failed at spawn, the pipeline writes no fact for it, and neither does this.
    const started = new Set(
      (
        await prisma.executionEvent.findMany({
          where: { runId: { in: runs.map((run) => run.id) }, type: 'run_started' },
          select: { runId: true },
        })
      ).map((row) => row.runId),
    )

    /** What this run was before the pass touched it -- the `alreadyPresent` half, counted once. */
    const countPresence = (runId) => {
      alreadyPresent += 1
      // The row was judged by the PIPELINE, before this script ran. Counted so a repair pass can be
      // read; never written to (erratum E23).
      if (before.get(runId) !== null) alreadyJudged += 1
    }

    /** The runs the writer answered `ok` for and that had no row before: candidates for `created`,
     *  confirmed against the table below rather than assumed. */
    const wrote = []

    for (const run of runs) {
      scanned += 1
      // E25: never started, so nothing was attempted and there is no fact. Before the dry-run
      // branch, because this is a decision and not a write -- a dry run that named this run among
      // the ones it would create would be describing a pass that will not happen.
      if (!started.has(run.id)) {
        skippedNeverStarted += 1
        continue
      }
      // --dry-run decides everything and writes nothing. The run it would CREATE is named as it is
      // reached -- a count alone is not something an operator can check against their own records.
      if (dryRun) {
        if (before.has(run.id)) countPresence(run.id)
        else {
          process.stdout.write(`backfill: would record run ${run.id}\n`)
          created += 1
        }
        continue
      }
      const result = await recordOne(run.id)
      if (result.ok) {
        if (before.has(run.id)) countPresence(run.id)
        else wrote.push(run.id)
      } else {
        if (result.error.kind === 'run_not_found') skippedSimulation += 1
        else skippedIncomplete += 1
        // NAMED, not counted silently: an operator who runs this once needs to know which rows the
        // log is missing, and `refusalText` is the sentence this system already has for it.
        process.stderr.write(`backfill: skipped run ${run.id}: ${refusalText(result.error)}\n`)
      }
    }

    // `created` IS MEASURED, NOT ASSUMED (final wave, carried T4 minor). `recordRunEvidence`
    // answers `ok` without writing anything when the run it reads is no longer terminal -- a run
    // this walk saw as concluded and a resume claimed a moment later -- so counting a create on
    // every `ok` reports rows that do not exist. One read per batch, over the ids the writer
    // accepted and nothing else, and a write-less `ok` then lands in no counter at all: it is
    // `scanned`, and honestly nothing more.
    if (wrote.length > 0) {
      const now = await prisma.evidenceRecord.findMany({ where: { runId: { in: wrote } }, select: { runId: true } })
      created += now.length
    }
    cursor = runs[runs.length - 1].id
  }

  return {
    dryRun,
    scanned,
    // `recorded` is created PLUS already present, because both were re-derived and written. It is
    // not "rows that changed": on a second pass nothing changes and everything is still recorded.
    // Under `--dry-run` it is what a real pass WOULD record.
    recorded: created + alreadyPresent,
    created,
    alreadyPresent,
    alreadyJudged,
    // NULL under `--dry-run`, never 0: no run was handed to the writer, so nobody knows how many it
    // would refuse, and a zero here would be a measurement nobody made.
    skipped: dryRun ? null : skippedSimulation + skippedIncomplete,
    skippedSimulation: dryRun ? null : skippedSimulation,
    skippedIncomplete: dryRun ? null : skippedIncomplete,
    // A NUMBER IN BOTH MODES (E25), and deliberately not part of `skipped` above: "this run never
    // started" is decided by a read a dry run really makes, while every other skip is an answer
    // only the writer has. Kept apart in the summary too -- a run that never ran is not a row this
    // pass failed to record.
    skippedNeverStarted,
  }
}

/** What an operator reads before they run this on a database that matters. */
const USAGE = `usage: npm run backfill:evidence -- [--batch <n>] [--dry-run]

  --batch <n>   rows per query (default 200). The walk is a cursor on the primary key, so this
                changes how often the database is asked and never what the pass records.
  --dry-run     decide everything, write nothing, and name by id every run it would create. A dry
                run hands no run to the writer, so it cannot report what would be skipped, and it
                does not pretend to -- but it does count the runs that never started, which is a
                read and not a refusal.

Fills in the record for every concluded run that has none, and re-derives the ones that do -- safe
to run on a live database, and the repair when a crash lost a run's evidence write.

History is recorded, not judged: a backfilled run's verify, review and integration columns stay
"not judged yet". A verdict is the live pipeline's act at the moment somebody reached it, and this
script never settles one.

A run with no run.started event never ran -- a dispatch that failed at spawn -- and is skipped and
counted as "never started", exactly as the pipeline writes no fact for it.
`

/** `--batch <n>`, a positive integer, and `--dry-run`. Anything else is a typo worth refusing. */
function parseArgs(argv) {
  let batchSize = 200
  let dryRun = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--help' || arg === '-h') return { help: true, batchSize, dryRun }
    if (arg === '--batch') {
      const value = Number(argv[i + 1])
      if (!Number.isInteger(value) || value <= 0) throw new Error('--batch must be a positive integer')
      batchSize = value
      i += 1
      continue
    }
    throw new Error(`unknown option: ${arg}\n\n${USAGE}`)
  }
  return { help: false, batchSize, dryRun }
}

/** The summary an operator reads. Two shapes, because a dry run measured two different things and
 *  must not borrow the words of a pass that actually happened. */
function summaryOf(report) {
  const facts =
    `scanned ${report.scanned}, ${report.dryRun ? 'would record' : 'recorded'} ${report.recorded} ` +
    `(${report.dryRun ? 'would create' : 'created'} ${report.created}, ` +
    `already present ${report.alreadyPresent}, already judged ${report.alreadyJudged}), ` +
    `never started ${report.skippedNeverStarted}`
  // The judgement sentence on EVERY pass, not only in the usage text: the operator who reads this
  // line is the one about to believe the record is complete (erratum E23).
  const judged =
    'history is recorded, not judged: a backfilled run\'s verify, review and integration columns stay\n' +
    '"not judged yet", and the already judged count above was judged by the pipeline, never here.\n' +
    'never started = runs with no run.started event: a dispatch that failed to spawn attempted\n' +
    'nothing, so it has no fact here and none in the pipeline either.\n'
  if (report.dryRun) {
    return (
      `${facts}\n` +
      '--dry-run: nothing was written, and no run was handed to the writer -- so this pass cannot\n' +
      'know how many would be skipped, and skipped / no such run / refused are not reported.\n' +
      judged
    )
  }
  return (
    `${facts}, skipped ${report.skipped} ` +
    `(no such run ${report.skippedSimulation}, refused ${report.skippedIncomplete})\n` +
    judged
  )
}

// Run only when invoked as a program: the integration test imports `backfillEvidence` directly, and
// a top-level call here would drive whatever database that test's environment names. The
// `realpathSync` is `cli.ts`'s own idiom -- Node leaves a symlink in `process.argv[1]` while
// `import.meta.filename` is already resolved, and a mismatch means exiting 0 having done nothing.
if (process.argv[1] !== undefined && import.meta.filename === realpathSync(resolve(process.argv[1]))) {
  try {
    const { help, batchSize, dryRun } = parseArgs(process.argv.slice(2))
    if (help) {
      process.stdout.write(USAGE)
      await prisma.$disconnect()
      process.exit(0)
    }
    const report = await backfillEvidence({ batchSize, dryRun })
    process.stdout.write(summaryOf(report))
    await prisma.$disconnect()
    // An operator who was told nothing was skipped and then finds a hole should have seen a non-zero
    // status. Every skipped run is named on stderr above; this is the same fact for a shell script.
    // A dry run skipped nothing because it attempted nothing, so it exits 0.
    process.exit(report.skipped !== null && report.skipped > 0 ? 1 : 0)
  } catch (error) {
    // The SENTENCE, never a stack trace: a typo in a flag is an operator's ordinary mistake, and
    // this is the shape `cli.ts`'s own entry point answers one with.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    await prisma.$disconnect()
    process.exit(1)
  }
}
