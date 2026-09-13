import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  amendRunOutcome,
  evidenceByModel,
  evidenceByProfile,
  evidenceForProfiles,
  listEvidence,
  recordRunEvidence,
  settleTaskEvidence,
} from '../../src/evidence.js'
import { seedEvidenceFixture, seedEvidenceRows as seedRows, type EvidenceFixture } from './fixtures/evidence.js'

let fixture: EvidenceFixture
beforeEach(async (): Promise<void> => {
  fixture = await seedEvidenceFixture()
})

describe('recordRunEvidence (M53 R1, R3)', () => {
  it('writes ONE row keyed on the four dimensions, with the profile name snapshotted', async (): Promise<void> => {
    const result = await recordRunEvidence(fixture.runId)
    expect(result.ok).toBe(true)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.profileKey).toBe(`template:${fixture.templateId}`)
    expect(row.profileName).toBe('Backend Developer')
    expect(row.model).toBe('claude-sonnet-4-20250514')
    expect(row.repositoryKey).toBe(fixture.repoPath)
    expect(row.domains).toEqual(['backend'])
    expect(row.workspaceId).toBe(fixture.workspaceId)
    expect(row.runKind).toBe('implementation')
    expect(row.outcome).toBe('succeeded')
  })

  it('keys a HAND-MADE worker on itself -- there is always a profile (R1)', async (): Promise<void> => {
    await prisma.slave.update({ where: { id: fixture.slaveId }, data: { hiredFromTemplateId: null, name: 'Sam' } })
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.profileKey).toBe(`slave:${fixture.slaveId}`)
    expect(row.profileName).toBe('Sam')
  })

  it('writes nothing for a run that has not concluded -- a live run is evidence about nothing', async (): Promise<void> => {
    await prisma.slaveRun.update({ where: { id: fixture.runId }, data: { status: 'working', terminalAt: null, endedAt: null } })
    const result = await recordRunEvidence(fixture.runId)
    expect(result.ok).toBe(true)
    expect(await prisma.evidenceRecord.count({ where: { runId: fixture.runId } })).toBe(0)
  })

  it('is IDEMPOTENT: two calls leave one row, and `recordedAt` is never rewritten (R7, erratum E15)', async (): Promise<void> => {
    await recordRunEvidence(fixture.runId)
    const first = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    await recordRunEvidence(fixture.runId)
    const second = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(await prisma.evidenceRecord.count()).toBe(1)
    expect(second).toEqual(first)
  })

  it('refuses a runId that names no run, writing nothing (R13, erratum E3)', async (): Promise<void> => {
    const result = await recordRunEvidence('00000000-0000-0000-0000-000000000000')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.kind).toBe('run_not_found')
    expect(await prisma.evidenceRecord.count()).toBe(0)
  })

  it('counts a run toward EVERY domain its task asked for, in ONE row (R2)', async (): Promise<void> => {
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { requiredCapabilities: ['backend.services', 'qa.test-automation'] },
    })
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.domains).toEqual(['backend', 'qa'])
    expect(await prisma.evidenceRecord.count()).toBe(1)
  })

  it('counts a task-less planning run toward `general` (R2)', async (): Promise<void> => {
    await prisma.slaveRun.update({ where: { id: fixture.runId }, data: { taskId: null, kind: 'planning' } })
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.domains).toEqual(['general'])
    expect(row.taskId).toBeNull()
  })

  it('derives the attempt from the reworks BELOW this run started (R4)', async (): Promise<void> => {
    // Two reworks before the run, one after: attempt 3, rework cycles 1.
    await appendEvent({ type: 'task.rework', workspaceId: fixture.workspaceId, taskId: fixture.taskId, actor: 'system', payload: { reason: 'a', attempt: 1 } })
    await appendEvent({ type: 'task.rework', workspaceId: fixture.workspaceId, taskId: fixture.taskId, actor: 'system', payload: { reason: 'b', attempt: 2 } })
    await appendEvent({ type: 'run.started', workspaceId: fixture.workspaceId, taskId: fixture.taskId, slaveId: fixture.slaveId, runId: fixture.runId, actor: 'system', payload: { sessionId: 's' } })
    await appendEvent({ type: 'task.rework', workspaceId: fixture.workspaceId, taskId: fixture.taskId, actor: 'system', payload: { reason: 'c', attempt: 3 } })
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.attempt).toBe(3)
    expect(row.reworkCycles).toBe(1)
  })

  it('counts an operator stop and the two pause/resume requests as interventions, and a sweep stop as none (R5)', async (): Promise<void> => {
    await prisma.slaveRun.update({ where: { id: fixture.runId }, data: { status: 'stopped', stopRequestedBy: 'meren' } })
    await appendEvent({ type: 'run.started', workspaceId: fixture.workspaceId, slaveId: fixture.slaveId, runId: fixture.runId, actor: 'system', payload: { sessionId: 's' } })
    await appendEvent({ type: 'run.pause_requested', workspaceId: fixture.workspaceId, slaveId: fixture.slaveId, runId: fixture.runId, actor: 'human', payload: { requestedBy: 'meren' } })
    await appendEvent({ type: 'run.resume_requested', workspaceId: fixture.workspaceId, slaveId: fixture.slaveId, runId: fixture.runId, actor: 'human', payload: { requestedBy: 'meren', message: '' } })
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.humanInterventions).toBe(3)
    expect(row.outcome).toBe('stopped')
  })

  it('counts a sweep conclusion as ONE recovery, from the CALLER and never from reason text (R5)', async (): Promise<void> => {
    await recordRunEvidence(fixture.runId, { recoveredBySweep: true })
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.recoveries).toBe(1)
  })

  it('counts every `task.unblocked` after the run started as a recovery too (R5)', async (): Promise<void> => {
    await appendEvent({ type: 'run.started', workspaceId: fixture.workspaceId, taskId: fixture.taskId, slaveId: fixture.slaveId, runId: fixture.runId, actor: 'system', payload: { sessionId: 's' } })
    await appendEvent({ type: 'task.unblocked', workspaceId: fixture.workspaceId, taskId: fixture.taskId, actor: 'human', payload: { attempt: 1, maxAttempts: 3, status: 'rework' } })
    await recordRunEvidence(fixture.runId)
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).recoveries).toBe(1)
  })

  it('keeps the REPORTED figure and its word (R6)', async (): Promise<void> => {
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.actualCostUsd).toBeCloseTo(0.42)
    expect(row.costProvenance).toBe('reported')
  })

  it('writes NULL and not 0 for a run nobody measured (R6)', async (): Promise<void> => {
    await prisma.slaveRun.update({
      where: { id: fixture.runId },
      data: { costUsd: null, tokensIn: null, tokensOut: null, model: null, provider: 'cursor' },
    })
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.actualCostUsd).toBeNull()
    expect(row.costProvenance).toBe('unmeasured')
    expect(row.model).toBeNull()
  })

  it('leaves all three judgement columns NULL at the write -- nobody has judged this yet (R3)', async (): Promise<void> => {
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.verifiedFirstPass).toBeNull()
    expect(row.reviewRejected).toBeNull()
    expect(row.integrated).toBeNull()
    expect(row.settledAt).toBeNull()
  })
})

describe('recordRunEvidence settles, once, and never back (M53 R4, erratum E1)', () => {
  it('settles `verifiedFirstPass` true for a pass on attempt one, and stamps `settledAt`', async (): Promise<void> => {
    await recordRunEvidence(fixture.runId)
    await recordRunEvidence(fixture.runId, { settle: { kind: 'verify', verdict: 'passed' } })
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.verifiedFirstPass).toBe(true)
    expect(row.settledAt).not.toBeNull()
  })

  it('settles `verifiedFirstPass` FALSE for a pass on attempt two', async (): Promise<void> => {
    await appendEvent({ type: 'task.rework', workspaceId: fixture.workspaceId, taskId: fixture.taskId, actor: 'system', payload: { reason: 'a', attempt: 1 } })
    await appendEvent({ type: 'run.started', workspaceId: fixture.workspaceId, taskId: fixture.taskId, slaveId: fixture.slaveId, runId: fixture.runId, actor: 'system', payload: { sessionId: 's' } })
    await recordRunEvidence(fixture.runId)
    await recordRunEvidence(fixture.runId, { settle: { kind: 'verify', verdict: 'passed' } })
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).verifiedFirstPass).toBe(false)
  })

  it('NEVER moves a settled column back -- a replayed conclusion writes nothing', async (): Promise<void> => {
    await recordRunEvidence(fixture.runId)
    await recordRunEvidence(fixture.runId, { settle: { kind: 'verify', verdict: 'passed' } })
    const settledAt = (await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).settledAt
    await recordRunEvidence(fixture.runId, { settle: { kind: 'verify', verdict: 'failed' } })
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.verifiedFirstPass).toBe(true)
    expect(row.settledAt).toEqual(settledAt)
  })

  it('settles `reviewRejected` only when the rejection names THIS attempt', async (): Promise<void> => {
    await recordRunEvidence(fixture.runId)
    await recordRunEvidence(fixture.runId, { settle: { kind: 'review', verdict: 'rejected', attempt: 7 } })
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).reviewRejected).toBe(false)
  })

  it('settles `integrated` from the merge and from a human confirmation alike', async (): Promise<void> => {
    await recordRunEvidence(fixture.runId)
    await recordRunEvidence(fixture.runId, { settle: { kind: 'integration', integrated: true } })
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).integrated).toBe(true)
  })

  it('settles nothing for a run with no row yet -- a settle never CREATES a fact', async (): Promise<void> => {
    await recordRunEvidence(fixture.runId, { settle: { kind: 'verify', verdict: 'passed' } })
    expect(await prisma.evidenceRecord.count()).toBe(0)
  })

  it('a REVIEW run keeps all three judgement columns null forever -- a reviewer gets no verdict (R4)', async (): Promise<void> => {
    await prisma.slaveRun.update({ where: { id: fixture.runId }, data: { kind: 'review' } })
    await recordRunEvidence(fixture.runId)
    await settleTaskEvidence(fixture.taskId, { kind: 'verify', verdict: 'passed' })
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.verifiedFirstPass).toBeNull()
  })
})

describe('settleTaskEvidence (erratum E2)', () => {
  it('resolves the task newest terminal IMPLEMENTATION run and settles that row', async (): Promise<void> => {
    await recordRunEvidence(fixture.runId)
    await settleTaskEvidence(fixture.taskId, { kind: 'integration', integrated: true })
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).integrated).toBe(true)
  })

  it('is a silent no-op for a task with no implementation run at all', async (): Promise<void> => {
    await prisma.slaveRun.update({ where: { id: fixture.runId }, data: { kind: 'review' } })
    await expect(settleTaskEvidence(fixture.taskId, { kind: 'integration', integrated: true })).resolves.toBeUndefined()
  })

  it('finds a run whose STATUS concluded even though `terminalAt` was never written', async (): Promise<void> => {
    // The second definition of "concluded" the final wave removed from here. `SlaveRun.terminalAt`
    // has only been written by the pump since M5 Task 12, so a pre-M5 run the backfill records
    // carries null -- and a settle that filtered on it could never find that row, while a NEWER
    // such run being skipped means the verdict lands on an OLDER run's row.
    await recordRunEvidence(fixture.runId)
    await prisma.slaveRun.update({ where: { id: fixture.runId }, data: { terminalAt: null } })

    await settleTaskEvidence(fixture.taskId, { kind: 'verify', verdict: 'passed' })

    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).verifiedFirstPass).toBe(true)
  })
})

/**
 * M53 erratum E26: the outcome follows the run's FINAL status.
 *
 * Three sites walk a run back from `succeeded` to `failed` AFTER the pump has concluded it and
 * written its fact. This verb is what keeps the stored row honest at those three, and the whole of
 * what it may touch is one column.
 */
describe('amendRunOutcome (erratum E26)', () => {
  it('re-derives the outcome of a run walked back from succeeded to failed', async (): Promise<void> => {
    await recordRunEvidence(fixture.runId)
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).outcome).toBe('succeeded')
    await prisma.slaveRun.update({ where: { id: fixture.runId }, data: { status: 'failed' } })

    const result = await amendRunOutcome(fixture.runId)

    expect(result.ok).toBe(true)
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).outcome).toBe('failed')
  })

  it('touches NOTHING else: not a judgement column, not `recordedAt`, not `settledAt`', async (): Promise<void> => {
    await recordRunEvidence(fixture.runId)
    await recordRunEvidence(fixture.runId, { settle: { kind: 'verify', verdict: 'passed' } })
    const before = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    await prisma.slaveRun.update({ where: { id: fixture.runId }, data: { status: 'failed' } })

    await amendRunOutcome(fixture.runId)

    const after = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(after).toEqual({ ...before, outcome: 'failed' })
  })

  it('is idempotent, and CREATES no row for a run nobody recorded', async (): Promise<void> => {
    await prisma.slaveRun.update({ where: { id: fixture.runId }, data: { status: 'stopped' } })

    expect((await amendRunOutcome(fixture.runId)).ok).toBe(true)
    expect(await prisma.evidenceRecord.count()).toBe(0)

    await recordRunEvidence(fixture.runId)
    await amendRunOutcome(fixture.runId)
    await amendRunOutcome(fixture.runId)
    expect(await prisma.evidenceRecord.count()).toBe(1)
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).outcome).toBe('stopped')
  })

  it('writes nothing for a run that can still move -- there is no outcome to follow yet', async (): Promise<void> => {
    await recordRunEvidence(fixture.runId)
    await prisma.slaveRun.update({ where: { id: fixture.runId }, data: { status: 'working' } })

    expect((await amendRunOutcome(fixture.runId)).ok).toBe(true)

    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).outcome).toBe('succeeded')
  })

  it('refuses a runId that names no run, before any write (R13, erratum E3)', async (): Promise<void> => {
    const result = await amendRunOutcome('00000000-0000-0000-0000-000000000000')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('run_not_found')
  })
})

describe('the reads (M53 R3, R6, R12, erratum E6)', () => {
  it('groups by profile AND repository, taking the NEWEST profile name for a renamed template', async (): Promise<void> => {
    await seedRows(fixture, [
      { profileName: 'Backend Developer', recordedAt: new Date(1_000) },
      { profileName: 'Backend Engineer', recordedAt: new Date(2_000) },
    ])
    const groups = await evidenceByProfile({ domain: null })
    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('Backend Engineer')
    expect(groups[0]?.attempted).toBe(2)
    expect(groups[0]?.repositoryKey).toBe(fixture.repoPath)
  })

  it('splits the money three ways with M51 words beside it, never one SUM (R6)', async (): Promise<void> => {
    await seedRows(fixture, [
      { costProvenance: 'reported', actualCostUsd: 1 },
      { costProvenance: 'estimated', actualCostUsd: 2 },
      { costProvenance: 'unmeasured', actualCostUsd: null },
    ])
    const group = (await evidenceByProfile({ domain: null }))[0]
    expect(group?.reportedUsd).toBeCloseTo(1)
    expect(group?.estimatedUsd).toBeCloseTo(2)
    expect(group?.unmeasuredRuns).toBe(1)
  })

  it('filters by domain with a CONTAINMENT predicate, so a two-domain run counts under both (R2)', async (): Promise<void> => {
    await seedRows(fixture, [{ domains: ['backend', 'qa'] }, { domains: ['backend'] }])
    expect((await evidenceByProfile({ domain: 'backend' }))[0]?.attempted).toBe(2)
    expect((await evidenceByProfile({ domain: 'qa' }))[0]?.attempted).toBe(1)
    // The two filtered counts deliberately do not sum to the unfiltered total.
    expect((await evidenceByProfile({ domain: null }))[0]?.attempted).toBe(2)
  })

  it('groups the by-model table separately, and keeps the null model as its own group (R1)', async (): Promise<void> => {
    await seedRows(fixture, [{ model: 'opus' }, { model: 'opus' }, { model: null }])
    const groups = await evidenceByModel({ domain: null })
    expect(groups.map((one) => one.model)).toEqual(['opus', null])
    expect(groups[0]?.attempted).toBe(2)
  })

  it('sorts by attempted DESCENDING then by the row own name ASCENDING (R11)', async (): Promise<void> => {
    await seedRows(fixture, [{ profileKey: 'template:z', profileName: 'Zed' }])
    await seedRows(fixture, [{ profileKey: 'template:a', profileName: 'Ann' }, { profileKey: 'template:a', profileName: 'Ann' }])
    expect((await evidenceByProfile({ domain: null })).map((one) => one.name)).toEqual(['Ann', 'Zed'])
  })

  it('answers the ranker with counts and medians per profile, bounded by the candidate set', async (): Promise<void> => {
    await seedRows(fixture, [
      { profileKey: 'template:a', verifiedFirstPass: true, actualCostUsd: 1, durationMs: 1_000 },
      { profileKey: 'template:a', verifiedFirstPass: false, actualCostUsd: 3, durationMs: 3_000 },
      { profileKey: 'template:b', verifiedFirstPass: true },
    ])
    const byProfile = await evidenceForProfiles(['template:a'])
    expect([...byProfile.keys()]).toEqual(['template:a'])
    const record = byProfile.get('template:a')
    expect(record?.attempted).toBe(2)
    expect(record?.firstPassJudged).toBe(2)
    expect(record?.firstPassPassed).toBe(1)
    expect(record?.medianCostUsd).toBeCloseTo(2)
    expect(record?.medianDurationMs).toBe(2_000)
  })

  it('asks nothing at all for an empty candidate set', async (): Promise<void> => {
    expect((await evidenceForProfiles([])).size).toBe(0)
  })

  it('EXCLUDES unmeasured rows from the median cost -- unmeasured is not cheap (R8)', async (): Promise<void> => {
    await seedRows(fixture, [
      { profileKey: 'template:a', costProvenance: 'reported', actualCostUsd: 10 },
      { profileKey: 'template:a', costProvenance: 'unmeasured', actualCostUsd: null },
    ])
    expect((await evidenceForProfiles(['template:a'])).get('template:a')?.medianCostUsd).toBeCloseTo(10)
  })

  it('lists the raw rows newest first, bounded by a limit the caller may narrow (R12)', async (): Promise<void> => {
    await seedRows(fixture, [
      { profileName: 'Older', recordedAt: new Date(1_000) },
      { profileName: 'Newer', recordedAt: new Date(2_000) },
    ])
    expect((await listEvidence({ domain: null })).map((row) => row.profileName)).toEqual(['Newer', 'Older'])
    expect(await listEvidence({ domain: null, limit: 1 })).toHaveLength(1)
  })
})
