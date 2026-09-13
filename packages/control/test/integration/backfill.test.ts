import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { beforeEach, describe, expect, it } from 'vitest'
import { backfillEvidence } from '../../../../scripts/backfill-evidence.mjs'
import { EVIDENCE_MODEL, seedEvidenceFixture, type EvidenceFixture } from './fixtures/evidence.js'

/**
 * `scripts/backfill-evidence.mjs`, driven as a FUNCTION (plan decision D28).
 *
 * No child process, no `--env-file`, no output parsing: a failure here names a line rather than an
 * exit code, and the pass runs against the same database fixture every other integration file uses.
 * The properties below are the ones nothing in Task 3 exercises -- idempotence, batch-size
 * independence, an incomplete event history, and a refusal that must not stop the pass.
 *
 * This file also RUNS THE BACKFILL FOR REAL, twice, against a real database. That is the only way
 * "running it again adds nothing" can be a measurement rather than a claim about an upsert.
 */

/** The same known span the shared fixture uses, so `durationMs` is a fact and never a clock. */
const RUN_STARTED_AT = new Date('2026-09-12T09:00:00.000Z')
const RUN_ENDED_AT = new Date('2026-09-12T09:00:03.500Z')

let fixture: EvidenceFixture

beforeEach(async (): Promise<void> => {
  fixture = await seedEvidenceFixture()
  // The fixture seeds ONE concluded run. Every case below states its own world in whole numbers,
  // so it starts from a project with no runs at all rather than from a project with one.
  await prisma.slaveRun.deleteMany({})
})

/** One concluded run, with the `run.started` event a real one leaves behind. */
async function seedTerminalRun(
  target: EvidenceFixture,
  status: 'succeeded' | 'failed' | 'stopped' = 'succeeded',
): Promise<string> {
  const run = await prisma.slaveRun.create({
    data: {
      taskId: target.taskId,
      slaveId: target.slaveId,
      kind: 'implementation',
      status,
      model: EVIDENCE_MODEL,
      provider: 'claude_code',
      costUsd: 0.42,
      tokensIn: 1_000,
      tokensOut: 2_000,
      startedAt: RUN_STARTED_AT,
      terminalAt: RUN_ENDED_AT,
      endedAt: RUN_ENDED_AT,
    },
  })
  await appendEvent({
    type: 'run.started',
    workspaceId: target.workspaceId,
    taskId: target.taskId,
    slaveId: target.slaveId,
    runId: run.id,
    actor: 'system',
    payload: { sessionId: 's' },
  })
  return run.id
}

/** A run that has not concluded: `terminalAt` null, which is the walk's whole `where`. */
async function seedLiveRun(target: EvidenceFixture): Promise<string> {
  const run = await prisma.slaveRun.create({
    data: {
      taskId: target.taskId,
      slaveId: target.slaveId,
      kind: 'implementation',
      status: 'working',
      model: EVIDENCE_MODEL,
      provider: 'claude_code',
      startedAt: RUN_STARTED_AT,
    },
  })
  return run.id
}

async function seedRuns(
  target: EvidenceFixture,
  counts: { readonly terminal?: number; readonly live?: number },
): Promise<readonly string[]> {
  const ids: string[] = []
  for (let i = 0; i < (counts.terminal ?? 0); i += 1) ids.push(await seedTerminalRun(target))
  for (let i = 0; i < (counts.live ?? 0); i += 1) await seedLiveRun(target)
  return ids
}

/**
 * Run something with `process.stdout.write` wrapped, and answer what it printed.
 *
 * A WRAPPER assigned and restored in a `finally`, never `vi.spyOn`: the house rule Task 3's fix
 * round wrote down after a spy left a Prisma delegate `undefined` for every case below it.
 */
async function capturingStdout<T>(body: () => Promise<T>): Promise<{ readonly report: T; readonly printed: string }> {
  const real = process.stdout.write.bind(process.stdout)
  let printed = ''
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    printed += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return (real as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  try {
    return { report: await body(), printed }
  } finally {
    process.stdout.write = real
  }
}

describe('backfillEvidence (M53 R7)', () => {
  it('records every terminal run and skips every live one', async (): Promise<void> => {
    await seedRuns(fixture, { terminal: 3, live: 2 })

    const report = await backfillEvidence({ batchSize: 2 })

    expect(report.recorded).toBe(3)
    // The live runs are not "skipped" by a branch: `status NOT IN NON_TERMINAL_RUN_STATUSES` is the
    // walk's own `where` -- a STATUS and never a `terminalAt` predicate, which is the second
    // definition of "concluded" Task 4's fix round removed -- so they are never scanned at all. A
    // run still moving is evidence about nothing.
    expect(report.scanned).toBe(3)
    expect(await prisma.evidenceRecord.count()).toBe(3)
  })

  it('scans a run whose STATUS concluded even though `terminalAt` was never written', async (): Promise<void> => {
    const runId = await seedTerminalRun(fixture)
    // `SlaveRun.terminalAt` has only been written by the pump since M5 Task 12 -- rows older than
    // that carry null, and `packages/control/src/stats.ts:123-127` calls a bare `terminalAt`
    // predicate a trap for exactly this reason. "Concluded" is a STATUS, and the walk asks the same
    // array `evidenceOutcomeOf` asks (fix round 1, Important 1).
    await prisma.slaveRun.update({ where: { id: runId }, data: { terminalAt: null } })

    const report = await backfillEvidence({})

    expect(report.scanned).toBe(1)
    expect(report.created).toBe(1)
    expect(await prisma.evidenceRecord.count({ where: { runId } })).toBe(1)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })
    expect(row.outcome).toBe('succeeded')
  })

  it('is IDEMPOTENT to the byte, `recordedAt` included (stage 5, erratum E15)', async (): Promise<void> => {
    await seedRuns(fixture, { terminal: 4 })

    const first = await backfillEvidence({ batchSize: 2 })
    const firstRows = await prisma.evidenceRecord.findMany({ orderBy: { runId: 'asc' } })
    const second = await backfillEvidence({ batchSize: 2 })
    const secondRows = await prisma.evidenceRecord.findMany({ orderBy: { runId: 'asc' } })

    expect(secondRows).toEqual(firstRows)
    // Idempotence is a property of the WRITER and not of a skip branch: the second pass calls
    // `recordRunEvidence` for all four runs again and writes the same bytes. A `notIn` branch would
    // make this case pass by construction and prove nothing about the thing an operator trusts.
    expect(first.created).toBe(4)
    expect(second.created).toBe(0)
    expect(second.alreadyPresent).toBe(4)
    expect(second.recorded).toBe(4)
    expect(await prisma.evidenceRecord.count()).toBe(4)
  })

  it('walks in `id` order in bounded batches, so the order it walks cannot change the result', async (): Promise<void> => {
    await seedRuns(fixture, { terminal: 5 })

    const wide = await backfillEvidence({ batchSize: 100 })
    const rowsWide = await prisma.evidenceRecord.findMany({ orderBy: { runId: 'asc' } })
    await prisma.evidenceRecord.deleteMany({})
    const narrow = await backfillEvidence({ batchSize: 1 })

    expect(narrow.recorded).toBe(wide.recorded)
    expect((await prisma.evidenceRecord.findMany({ orderBy: { runId: 'asc' } })).map((r) => r.runId)).toEqual(
      rowsWide.map((r) => r.runId),
    )
  })

  it('SKIPS a run with no `run.started` event -- it never ran, so it has no fact (E25)', async (): Promise<void> => {
    // The spawn-failure shape: a `SlaveRun` row exists and is terminal, and nothing ever started.
    // R3 says the pipeline's own spawn-failure arms write no fact for it -- "nothing was attempted,
    // and a profile whose dispatches failed to spawn has not been evidenced about" -- and before
    // erratum E25 this script recorded one anyway, so a profile's attempted count, the by-model
    // table and the duration median all moved the first time an operator ran the repair.
    const neverStarted = await seedTerminalRun(fixture)
    await prisma.executionEvent.deleteMany({ where: { runId: neverStarted } })
    const ran = await seedTerminalRun(fixture)

    const report = await backfillEvidence({})

    expect(await prisma.evidenceRecord.count({ where: { runId: neverStarted } })).toBe(0)
    expect(await prisma.evidenceRecord.count({ where: { runId: ran } })).toBe(1)
    expect(report.scanned).toBe(2)
    expect(report.created).toBe(1)
    // Counted APART from the writer's refusals: nobody refused this row, and it is not a row the
    // pass failed to record.
    expect(report.skippedNeverStarted).toBe(1)
    expect(report.skipped).toBe(0)
  })

  it('records a run that STARTED whose other events are gone, with zeros and nulls (R7)', async (): Promise<void> => {
    const runId = await seedTerminalRun(fixture)
    // Everything except the one event that says it ran. This is the "incomplete history" case R7 is
    // actually about: the run happened, and the record of what happened during it is partial.
    await prisma.executionEvent.deleteMany({ where: { runId, type: { not: 'run_started' } } })

    await backfillEvidence({})

    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })
    // A count over nothing IS zero, so the event-derived counters record zero honestly...
    expect(row.attempt).toBe(1)
    expect(row.reworkCycles).toBe(0)
    expect(row.humanInterventions).toBe(0)
    expect(row.recoveries).toBe(0)
    // ...and the three JUDGEMENT columns stay null. Settling `false` here would manufacture a
    // failure out of a missing record, and E1 makes a judgement column irreversible.
    expect(row.verifiedFirstPass).toBeNull()
    expect(row.reviewRejected).toBeNull()
    expect(row.integrated).toBeNull()
    // The run-local columns come from the ROW, which always exists.
    expect(row.outcome).toBe('succeeded')
    expect(row.repositoryKey).toBe(fixture.repoPath)
  })

  it('REPORTS the runs it could not record rather than failing the pass', async (): Promise<void> => {
    await seedRuns(fixture, { terminal: 2 })

    const report = await backfillEvidence({
      batchSize: 1,
      recordOne: async () => ({ ok: false, error: { kind: 'run_not_found', runId: 'x' } }),
    })

    expect(report.recorded).toBe(0)
    expect(report.skipped).toBe(2)
    // `run_not_found` is the BOUNDARY refusal (R13, erratum E3) -- the one a simulated id meets --
    // so it is counted apart from every other reason a row could not be recorded. One unreadable
    // row must not stop an operator filling in five years of history.
    expect(report.skippedSimulation).toBe(2)
    expect(report.skippedIncomplete).toBe(0)
    expect(await prisma.evidenceRecord.count()).toBe(0)
  })

  it('counts a refusal that is NOT the boundary apart from one that is', async (): Promise<void> => {
    await seedRuns(fixture, { terminal: 2 })

    const report = await backfillEvidence({
      batchSize: 2,
      recordOne: async () => ({ ok: false, error: { kind: 'workspace_not_found', workspaceId: 'x' } }),
    })

    expect(report.skipped).toBe(2)
    expect(report.skippedSimulation).toBe(0)
    expect(report.skippedIncomplete).toBe(2)
  })

  it('never settles a judgement column -- history is filled in, never judged', async (): Promise<void> => {
    const runId = await seedTerminalRun(fixture)

    await backfillEvidence({})

    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })
    expect(row.settledAt).toBeNull()
    expect(row.verifiedFirstPass).toBeNull()
  })

  it('leaves a verdict somebody already reached exactly where it is, and counts it', async (): Promise<void> => {
    const runId = await seedTerminalRun(fixture)
    // The pipeline's own pair: the terminal write, then a verdict settling one column.
    await backfillEvidence({})
    const { recordRunEvidence } = await import('../../src/evidence.js')
    await recordRunEvidence(runId, { settle: { kind: 'verify', verdict: 'passed' } })
    const settled = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })

    // The repair pass runs again over history that has already been judged.
    const report = await backfillEvidence({})

    const after = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })
    expect(after.verifiedFirstPass).toBe(true)
    expect(after.settledAt).toEqual(settled.settledAt)
    expect(report.alreadyJudged).toBe(1)
    expect(report.created).toBe(0)
  })

  it('--dry-run says what it WOULD do, names it by id, and writes nothing at all', async (): Promise<void> => {
    const ids = await seedRuns(fixture, { terminal: 3 })

    const { report: dry, printed } = await capturingStdout(() => backfillEvidence({ dryRun: true }))

    expect(dry.scanned).toBe(3)
    expect(dry.created).toBe(3)
    expect(dry.recorded).toBe(3)
    // NOTHING was written -- the row count is the whole claim.
    expect(await prisma.evidenceRecord.count()).toBe(0)
    // Every run it would create, named. A count alone is not something an operator can check
    // against their own records.
    for (const id of ids) expect(printed).toContain(`backfill: would record run ${id}`)

    // And the same flag over history that is already filled in reports nothing to create.
    await backfillEvidence({})
    const { report: again, printed: quiet } = await capturingStdout(() => backfillEvidence({ dryRun: true }))
    expect(again.created).toBe(0)
    expect(again.alreadyPresent).toBe(3)
    expect(quiet).toBe('')
    expect(await prisma.evidenceRecord.count()).toBe(3)
  })

  it('--dry-run reports NULL for every skip counter, because it handed no run to the writer', async (): Promise<void> => {
    await seedRuns(fixture, { terminal: 2 })

    const dry = await backfillEvidence({ dryRun: true })

    // Not zero. A zero here would be a measurement nobody made: the writer was never called, so
    // nobody knows how many runs it would have refused.
    expect(dry.skipped).toBeNull()
    expect(dry.skippedSimulation).toBeNull()
    expect(dry.skippedIncomplete).toBeNull()
    expect(dry.dryRun).toBe(true)
    // ...and `skippedNeverStarted` IS a number, in both modes (E25): whether a run ever started is
    // decided by a read this pass really makes, not by an answer only the writer has.
    expect(dry.skippedNeverStarted).toBe(0)

    // A real pass measures them, and says so with numbers.
    const real = await backfillEvidence({})
    expect(real.skipped).toBe(0)
    expect(real.dryRun).toBe(false)
  })

  it('--dry-run counts a never-started run and does not offer to record it (E25)', async (): Promise<void> => {
    const neverStarted = await seedTerminalRun(fixture)
    await prisma.executionEvent.deleteMany({ where: { runId: neverStarted } })

    const { report, printed } = await capturingStdout(() => backfillEvidence({ dryRun: true }))

    expect(report.skippedNeverStarted).toBe(1)
    expect(report.created).toBe(0)
    expect(printed).not.toContain(`would record run ${neverStarted}`)
  })

  it('nothing simulated crosses into the record (R6, R13)', async (): Promise<void> => {
    const company = await prisma.company.create({ data: { name: 'Simulated Co' } })
    await prisma.simulationRun.create({
      data: { companyId: company.id, name: 'a run of a company that does not exist', sector: 'software', seed: 1, definition: {}, state: {} },
    })
    await seedRuns(fixture, { terminal: 2 })

    const report = await backfillEvidence({})

    // The boundary is structural rather than a filter: a simulated role is not a `Slave` and a
    // simulated step is not a `SlaveRun`, and `SlaveRun` is the only table this walk reads. So the
    // simulation is not skipped -- it is never scanned, and nothing had to be refused.
    expect(report.scanned).toBe(2)
    expect(report.skippedSimulation).toBe(0)
    expect(await prisma.evidenceRecord.count()).toBe(2)
  })
})
