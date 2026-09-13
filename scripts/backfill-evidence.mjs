// scripts/backfill-evidence.mjs — "history counts from day one" (M53 R7).
//
//   npm run backfill:evidence
//   npm run backfill:evidence -- --batch 500
//   npm run backfill:evidence -- --dry-run
//
// Walks every CONCLUDED `SlaveRun`, in `id` order, in bounded batches, and calls the SAME
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
// SAFE ON A LIVE DATABASE, and this is the second reason it exists. Seven transitions write a fact
// the moment a run concludes (plan erratum E22), and a crash between the terminal status write and
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
// RUNS WHOSE EVENTS ARE INCOMPLETE are the normal case on an old database, and they are recorded
// honestly rather than skipped: the run-local columns (outcome, duration, cost, provenance, kind and
// all four dimension keys) come from the `SlaveRun` ROW, which always exists; the event-derived
// counters read a count over a possibly-empty set and record zero, because a count over nothing IS
// zero; and the three JUDGEMENT columns stay null -- "nobody judged this, or the record of the
// judgement is gone" -- rather than settling `false`, which would manufacture a failure. A `false`
// written here could never be taken back (erratum E1) and it feeds a staffing decision.
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
// id as it is reached.
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

    /** What this run was before the pass touched it -- counted once, whether written or dry-run. */
    const countPresence = (runId) => {
      if (!before.has(runId)) {
        created += 1
        return
      }
      alreadyPresent += 1
      // The row was judged by the PIPELINE, before this script ran. Counted so a repair pass can be
      // read; never written to (erratum E23).
      if (before.get(runId) !== null) alreadyJudged += 1
    }

    for (const run of runs) {
      scanned += 1
      // --dry-run decides everything and writes nothing. The run it would CREATE is named as it is
      // reached -- a count alone is not something an operator can check against their own records.
      if (dryRun) {
        if (!before.has(run.id)) process.stdout.write(`backfill: would record run ${run.id}\n`)
        countPresence(run.id)
        continue
      }
      const result = await recordOne(run.id)
      if (result.ok) {
        countPresence(run.id)
      } else {
        if (result.error.kind === 'run_not_found') skippedSimulation += 1
        else skippedIncomplete += 1
        // NAMED, not counted silently: an operator who runs this once needs to know which rows the
        // log is missing, and `refusalText` is the sentence this system already has for it.
        process.stderr.write(`backfill: skipped run ${run.id}: ${refusalText(result.error)}\n`)
      }
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
  }
}

/** What an operator reads before they run this on a database that matters. */
const USAGE = `usage: npm run backfill:evidence -- [--batch <n>] [--dry-run]

  --batch <n>   rows per query (default 200). The walk is a cursor on the primary key, so this
                changes how often the database is asked and never what the pass records.
  --dry-run     decide everything, write nothing, and name by id every run it would create. A dry
                run hands no run to the writer, so it cannot report what would be skipped, and it
                does not pretend to.

Fills in the record for every concluded run that has none, and re-derives the ones that do -- safe
to run on a live database, and the repair when a crash lost a run's evidence write.

History is recorded, not judged: a backfilled run's verify, review and integration columns stay
"not judged yet". A verdict is the live pipeline's act at the moment somebody reached it, and this
script never settles one.
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
    `already present ${report.alreadyPresent}, already judged ${report.alreadyJudged})`
  // The judgement sentence on EVERY pass, not only in the usage text: the operator who reads this
  // line is the one about to believe the record is complete (erratum E23).
  const judged =
    'history is recorded, not judged: a backfilled run\'s verify, review and integration columns stay\n' +
    '"not judged yet", and the already judged count above was judged by the pipeline, never here.\n'
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
