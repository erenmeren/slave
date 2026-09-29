/**
 * Conductor Plan 5, Task 7 (plan D10): the Supervisor chat is given a goal version's report summary
 * once per resting point -- merged, needs a person (per round), abandoned, verified and waiting
 * for a hand merge -- and never for a delivery the migration already marked, or twice.
 */
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { postGoalReportNotes, restingKey } from '../../src/goalReportNotes.js'

async function workspaceWith(autoMerge: boolean): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: { name: `Notes ${String(autoMerge)}`, repoPath: '/tmp/notes', verifyCommands: [], setupCommands: [], delivery: 'conducted', autoMerge },
  })
  return workspace.id
}

async function delivery(workspaceId: string, goalVersion: number, data: Record<string, unknown>): Promise<string> {
  await prisma.requirementSet.create({ data: { workspaceId, goalVersion, items: [{ key: 'R1', text: 'a', source: 'a' }] } })
  const row = await prisma.goalDelivery.create({
    data: { workspaceId, goalVersion, integrationBranch: `slaveofai/goal-v${String(goalVersion)}-x`, baseCommit: 'b'.repeat(40), ...data },
  })
  return row.id
}

const notes = (workspaceId: string) =>
  prisma.supervisorMessage.findMany({ where: { workspaceId, noteKey: { not: null } }, orderBy: { seq: 'asc' }, select: { noteKey: true, goalReportVersion: true, text: true } })

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorMessage", "RequirementSet", "GoalDelivery", "Workspace" RESTART IDENTITY CASCADE',
  )
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('restingKey', () => {
  it('names each resting point, and nothing for a version still moving', async (): Promise<void> => {
    const ws = await workspaceWith(true)
    const base = { id: 'x', workspaceId: ws, goalVersion: 1, round: 2, mergeError: null, acceptedAt: new Date() }
    expect(await restingKey({ ...base, status: 'accepted', mergedAt: new Date() }, true)).toBe('merged')
    expect(await restingKey({ ...base, status: 'abandoned', mergedAt: null }, true)).toBe('abandoned')
    expect(await restingKey({ ...base, status: 'needs_human', mergedAt: null }, true)).toBe('needs_human:r2')
    expect(await restingKey({ ...base, status: 'accepted', mergedAt: null }, false)).toBe('awaiting_merge:r2')
    expect(await restingKey({ ...base, status: 'accepted', mergedAt: null, mergeError: 'conflict' }, true)).toBe('awaiting_merge:r2')
    expect(await restingKey({ ...base, status: 'accepted', mergedAt: null }, true)).toBe(null)
    expect(await restingKey({ ...base, status: 'verifying', mergedAt: null }, true)).toBe(null)
  })

  it("counts an accepted version as waiting once the goal pass has tripped about it since its acceptance", async (): Promise<void> => {
    const ws = await workspaceWith(true)
    const acceptedAt = new Date(Date.now() - 1000)
    await appendEvent({ type: 'guardrail.tripped', workspaceId: ws, actor: 'system', payload: { guardrail: 'merge_failure', detail: 'goal v1 is accepted, but main has moved since the goal was cut from it' } })
    await appendEvent({ type: 'guardrail.tripped', workspaceId: ws, actor: 'system', payload: { guardrail: 'merge_failure', detail: 'goal v10 is accepted, but main has moved' } })
    const d = { id: 'x', workspaceId: ws, goalVersion: 1, round: 1, status: 'accepted' as const, mergedAt: null, mergeError: null, acceptedAt }
    expect(await restingKey(d, true)).toBe('awaiting_merge:r1')
    expect(await restingKey({ ...d, acceptedAt: new Date(Date.now() + 60_000) }, true)).toBe(null)
  })

  it('does not read goal v10 trips as goal v1', async (): Promise<void> => {
    const ws = await workspaceWith(true)
    await appendEvent({ type: 'guardrail.tripped', workspaceId: ws, actor: 'system', payload: { guardrail: 'merge_failure', detail: 'goal v10 is accepted, but main has moved' } })
    const d = { id: 'x', workspaceId: ws, goalVersion: 1, round: 1, status: 'accepted' as const, mergedAt: null, mergeError: null, acceptedAt: new Date(Date.now() - 1000) }
    expect(await restingKey(d, true)).toBe(null)
  })
})

describe('postGoalReportNotes', () => {
  it('posts one note per resting point, stamps it, and posts nothing on the next pass', async (): Promise<void> => {
    const ws = await workspaceWith(true)
    const id = await delivery(ws, 1, { status: 'needs_human', round: 1, needsHumanReason: 'only unverifiable items: R1' })
    expect(await postGoalReportNotes(ws)).toBe(1)
    expect(await postGoalReportNotes(ws)).toBe(0)
    expect(await notes(ws)).toEqual([expect.objectContaining({ noteKey: 'goal-report:v1:needs_human:r1', goalReportVersion: 1 })])
    expect((await prisma.goalDelivery.findUniqueOrThrow({ where: { id } })).reportNotedKey).toBe('needs_human:r1')

    // The person retries; the version stops again in round 2 -- a new resting point, a new note.
    await prisma.goalDelivery.update({ where: { id }, data: { round: 2 } })
    expect(await postGoalReportNotes(ws)).toBe(1)
    expect((await notes(ws)).map((n) => n.noteKey)).toEqual(['goal-report:v1:needs_human:r1', 'goal-report:v1:needs_human:r2'])
  })

  it('posts nothing for a delivery the migration marked, and nothing for a version still moving', async (): Promise<void> => {
    const ws = await workspaceWith(true)
    await delivery(ws, 1, { status: 'accepted', mergedAt: new Date(), reportNotedKey: 'merged' })
    await delivery(ws, 2, { status: 'verifying', round: 1 })
    expect(await postGoalReportNotes(ws)).toBe(0)
    expect(await notes(ws)).toEqual([])
  })

  it('does not post twice when the stamp was lost after the note (a crash in between)', async (): Promise<void> => {
    const ws = await workspaceWith(true)
    const id = await delivery(ws, 1, { status: 'abandoned' })
    await postGoalReportNotes(ws)
    await prisma.goalDelivery.update({ where: { id }, data: { reportNotedKey: null } })
    expect(await postGoalReportNotes(ws)).toBe(0)
    expect(await notes(ws)).toHaveLength(1)
    expect((await prisma.goalDelivery.findUniqueOrThrow({ where: { id } })).reportNotedKey).toBe('abandoned')
  })

  it('posts one note when two passes overlap', async (): Promise<void> => {
    const ws = await workspaceWith(true)
    const id = await delivery(ws, 1, { status: 'accepted', mergedAt: new Date() })
    const counts = await Promise.all([postGoalReportNotes(ws), postGoalReportNotes(ws)])
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1)
    expect(await notes(ws)).toEqual([expect.objectContaining({ noteKey: 'goal-report:v1:merged', goalReportVersion: 1 })])
    expect((await prisma.goalDelivery.findUniqueOrThrow({ where: { id } })).reportNotedKey).toBe('merged')
  })

  it('posts while the project is halted, and the summary is the report', async (): Promise<void> => {
    const ws = await workspaceWith(true)
    await prisma.workspace.update({ where: { id: ws }, data: { haltedReason: 'budget_exhausted', haltedAt: new Date() } })
    await delivery(ws, 1, { status: 'abandoned' })
    expect(await postGoalReportNotes(ws)).toBe(1)
    const [note] = await notes(ws)
    expect(note?.text.startsWith('Goal v1 report: abandoned; nothing of it reached ')).toBe(true)
    expect(await prisma.supervisorMessage.findFirst({ where: { workspaceId: ws }, select: { modelCostUsd: true, unmeasured: true } })).toEqual({ modelCostUsd: null, unmeasured: false })
  })

  it('posts nothing for an archived project', async (): Promise<void> => {
    const ws = await workspaceWith(true)
    await delivery(ws, 1, { status: 'abandoned' })
    await prisma.workspace.update({ where: { id: ws }, data: { archivedAt: new Date() } })
    expect(await postGoalReportNotes(ws)).toBe(0)
  })
})
