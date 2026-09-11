import { prisma } from '@slave-of-ai/db/client'
import { MEMORY_CANDIDATE_STALE_MS } from '@slave-of-ai/domain'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  addMemory,
  discardStaleCandidates,
  listMemories,
  memoriesForRun,
  readMemory,
  recordMemory,
  removeMemory,
  staleCandidateCount,
  supersedeMemory,
  verifyMemory,
} from '../../src/memory.js'

let companyId = ''
let workspaceId = ''
let slaveId = ''
let otherSlaveId = ''
let taskId = ''
let userId = ''

const draft = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'observation',
  scope: 'workspace',
  companyId: null,
  workspaceId,
  slaveId: null,
  title: 'Task: Ship the checkout API',
  body: 'Both files are created in the worktree.',
  status: 'candidate',
  confidence: 'interpretation',
  capabilities: ['backend.api-design'],
  verifiedBy: null,
  supersedesTaskCandidates: false,
  provenance: {
    sourceKind: 'run_output',
    sourceRef: '412',
    createdBy: 'slave',
    createdByUserId: null,
    taskId,
    runId: null,
    goalVersion: 2,
  },
  ...overrides,
})

beforeAll(async () => {
  // A real row: every event this file provokes carries `userId`, and `ExecutionEvent.userId` is a
  // foreign key -- a made-up 'u1' is refused by the database, not by the code under test.
  const user = await prisma.user.create({ data: { username: `m49-memory-${String(Date.now())}`, passwordHash: 'x' } })
  userId = user.id
  const company = await prisma.company.create({ data: { name: 'M49 Control Co' } })
  companyId = company.id
  const workspace = await prisma.workspace.create({
    data: {
      name: 'M49 Control Project',
      repoPath: '/tmp/m49-control',
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [],
      companyId,
      goal: 'Ship the checkout flow.',
      goalVersion: 2,
    },
  })
  workspaceId = workspace.id
  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  const slave = await prisma.slave.create({
    data: { teamId: team.id, name: 'Dev', role: 'backend', runtimeRoles: ['backend'] },
  })
  slaveId = slave.id
  const other = await prisma.slave.create({
    data: { teamId: team.id, name: 'Reader', role: 'reviewer', runtimeRoles: ['reviewer'] },
  })
  otherSlaveId = other.id
  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: 'Ship the checkout API',
      description: 'do it',
      requiredRole: 'backend',
      maxAttempts: 3,
      requiredCapabilities: ['backend.api-design'],
    },
  })
  taskId = task.id
})

/**
 * Every case owns the rows it reads back.
 *
 * R1 is the reason this hook has to exist at all: nothing is ever deleted, so a case that
 * removes or supersedes a memory deliberately LEAVES it in the table -- and the next case, which
 * asks the project what it knows, would otherwise be answered with the one before it.
 */
beforeEach(async () => {
  await prisma.memorySource.deleteMany({})
  await prisma.memory.deleteMany({
    where: { OR: [{ workspaceId }, { companyId }, { slaveId: { in: [slaveId, otherSlaveId] } }] },
  })
})

afterAll(async () => {
  await prisma.memorySource.deleteMany({})
  await prisma.memory.deleteMany({
    where: { OR: [{ workspaceId }, { companyId }, { slaveId: { in: [slaveId, otherSlaveId] } }] },
  })
  await prisma.executionEvent.deleteMany({ where: { workspaceId } })
  await prisma.task.deleteMany({ where: { workspaceId } })
  await prisma.slave.deleteMany({ where: { team: { workspaceId } } })
  await prisma.team.deleteMany({ where: { workspaceId } })
  await prisma.workspace.deleteMany({ where: { id: workspaceId } })
  await prisma.company.deleteMany({ where: { id: companyId } })
  await prisma.user.deleteMany({ where: { id: userId } })
  await prisma.$disconnect()
})

describe('recordMemory', () => {
  it('writes the row, returns the view, and appends memory.recorded with the task on the envelope', async () => {
    const result = await recordMemory(draft())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('candidate')
    expect(result.value.provenance.sourceRef).toBe('412')
    expect(result.value.sourceIds).toEqual([])
    const event = await prisma.executionEvent.findFirst({
      where: { workspaceId, type: 'memory_recorded' },
      orderBy: { seq: 'desc' },
    })
    expect(event?.taskId).toBe(taskId)
    expect(event?.actor).toBe('slave')
    expect(event?.payload).toEqual({
      memoryId: result.value.id,
      type: 'observation',
      scope: 'workspace',
      status: 'candidate',
      sourceKind: 'run_output',
    })
  })

  it('refuses a draft that names two targets, and writes nothing', async () => {
    const before = await prisma.memory.count({ where: { workspaceId } })
    const result = await recordMemory(draft({ slaveId }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_memory')
    expect(await prisma.memory.count({ where: { workspaceId } })).toBe(before)
  })

  // Plan decision D3: the fact a passed verification produces retires the task's own candidate, in
  // ONE transaction, and says so with an event.
  it('retires the task’s open candidates when the draft says it should', async () => {
    const candidate = await recordMemory(draft())
    expect(candidate.ok).toBe(true)
    if (!candidate.ok) return
    const fact = await recordMemory(
      draft({
        type: 'fact',
        status: 'verified',
        confidence: 'sourced',
        verifiedBy: 'verification',
        supersedesTaskCandidates: true,
        title: 'Task: Ship the checkout API',
        body: 'Every orders route requires a signed session.',
        provenance: {
          ...(draft().provenance as Record<string, unknown>),
          sourceKind: 'verification',
          sourceRef: null,
        },
      }),
    )
    expect(fact.ok).toBe(true)
    if (!fact.ok) return
    const retired = await prisma.memory.findUniqueOrThrow({ where: { id: candidate.value.id } })
    expect(retired.status).toBe('superseded')
    expect(retired.supersededById).toBe(fact.value.id)
    const changed = await prisma.executionEvent.findFirst({
      where: { workspaceId, type: 'memory_changed' },
      orderBy: { seq: 'desc' },
    })
    expect(changed?.payload).toEqual({ memoryId: candidate.value.id, from: 'candidate', to: 'superseded' })
  })

  // The guard that keeps a fact from pointing at itself: a draft that retires the task's
  // candidates is itself written in that transaction, and a candidate-status one would otherwise
  // match its own `updateMany`.
  it('never supersedes the row it is writing', async () => {
    const written = await recordMemory(draft({ supersedesTaskCandidates: true }))
    expect(written.ok).toBe(true)
    if (!written.ok) return
    const row = await prisma.memory.findUniqueOrThrow({ where: { id: written.value.id } })
    expect(row.status).toBe('candidate')
    expect(row.supersededById).toBeNull()
  })
})

describe('the verbs a person uses', () => {
  it('adds, verifies, supersedes and removes -- and nothing is ever deleted', async () => {
    const added = await addMemory(
      {
        workspaceId,
        type: 'procedure',
        scope: 'workspace',
        title: 'How we release',
        body: 'Tag, then deploy.',
        capabilities: [],
      },
      { userId },
    )
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.value.status).toBe('verified')
    expect(added.value.verifiedBy).toBe('human')
    expect(added.value.provenance).toMatchObject({
      sourceKind: 'human',
      createdBy: 'human',
      createdByUserId: userId,
    })

    const candidate = await recordMemory(draft())
    expect(candidate.ok).toBe(true)
    if (!candidate.ok) return
    const verified = await verifyMemory(candidate.value.id, { userId })
    expect(verified.ok && verified.value.status).toBe('verified')
    expect(verified.ok && verified.value.verifiedBy).toBe('human')
    expect(verified.ok && verified.value.verifiedAt).not.toBeNull()

    const corrected = await supersedeMemory(
      candidate.value.id,
      { title: 'Task: Ship the checkout API', body: 'Only the orders routes require a session.' },
      { userId },
    )
    expect(corrected.ok).toBe(true)
    if (!corrected.ok) return
    expect(corrected.value.superseded.status).toBe('superseded')
    expect(corrected.value.superseded.supersededById).toBe(corrected.value.created.id)
    // The old row's provenance travels, with a pointer back to what it replaced.
    expect(corrected.value.created.provenance.sourceKind).toBe('human')
    expect(corrected.value.created.provenance.sourceRef).toBe(candidate.value.id)
    expect(corrected.value.created.status).toBe('verified')

    const removed = await removeMemory(corrected.value.created.id, 'we changed our mind', { userId })
    expect(removed.ok && removed.value.status).toBe('removed')
    expect(removed.ok && removed.value.removedReason).toBe('we changed our mind')
    // Still there. Nothing is ever deleted (R1).
    expect(await prisma.memory.count({ where: { id: corrected.value.created.id } })).toBe(1)

    const chain = await readMemory(corrected.value.created.id)
    expect(chain.ok).toBe(true)
    if (!chain.ok) return
    expect(chain.value.supersedes?.id).toBe(candidate.value.id)
    expect(chain.value.supersededBy).toBeNull()
    expect(chain.value.sources).toEqual([])
  })

  it('refuses a memory that is not there, and one that is frozen', async () => {
    const missing = await verifyMemory('nope')
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error.kind).toBe('memory_not_found')

    const one = await recordMemory(draft())
    expect(one.ok).toBe(true)
    if (!one.ok) return
    expect((await removeMemory(one.value.id, 'wrong')).ok).toBe(true)
    const again = await removeMemory(one.value.id, 'wrong again')
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.error.kind).toBe('memory_not_editable')
    expect((await supersedeMemory(one.value.id, { title: 'x', body: 'y' })).ok).toBe(false)
    expect((await verifyMemory(one.value.id)).ok).toBe(false)
  })

  it('refuses an empty removal reason rather than withdrawing knowledge silently', async () => {
    const one = await recordMemory(draft())
    expect(one.ok).toBe(true)
    if (!one.ok) return
    const result = await removeMemory(one.value.id, '   ')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_memory')
    expect((await prisma.memory.findUniqueOrThrow({ where: { id: one.value.id } })).status).toBe('candidate')
  })

  it('reads a memory that is not there as a refusal rather than an empty chain', async () => {
    const chain = await readMemory('nope')
    expect(chain.ok).toBe(false)
    if (chain.ok) return
    expect(chain.error.kind).toBe('memory_not_found')
  })
})

describe('listMemories and memoriesForRun', () => {
  it('filters by status, type and task, with a key-stable order', async () => {
    const first = await recordMemory(draft({ title: 'A' }))
    const second = await recordMemory(
      draft({ title: 'B', type: 'fact', status: 'verified', confidence: 'sourced', verifiedBy: 'verification' }),
    )
    expect(first.ok && second.ok).toBe(true)
    const candidates = await listMemories({ workspaceId, statuses: ['candidate'] })
    expect(candidates.map((one) => one.title)).toEqual(['A'])
    const facts = await listMemories({ workspaceId, type: 'fact' })
    expect(facts.map((one) => one.title)).toEqual(['B'])
    expect((await listMemories({ workspaceId, taskId })).length).toBe(2)
    expect((await listMemories({ workspaceId, q: 'b' })).map((one) => one.title)).toEqual(['B'])
    expect((await listMemories({ workspaceId, capability: 'backend.api-design' })).length).toBe(2)
    expect((await listMemories({ workspaceId, capability: 'frontend.forms' })).length).toBe(0)
  })

  it('hands a run the three scopes in one read and nothing another worker owns', async () => {
    await recordMemory(
      draft({
        type: 'fact',
        status: 'verified',
        confidence: 'sourced',
        verifiedBy: 'verification',
        title: 'project fact',
      }),
    )
    await recordMemory(
      draft({
        type: 'lesson',
        scope: 'worker',
        workspaceId: null,
        slaveId,
        status: 'verified',
        confidence: 'sourced',
        verifiedBy: 'review',
        title: 'mine',
      }),
    )
    await recordMemory(
      draft({
        type: 'lesson',
        scope: 'worker',
        workspaceId: null,
        slaveId: otherSlaveId,
        status: 'verified',
        confidence: 'sourced',
        verifiedBy: 'review',
        title: 'theirs',
      }),
    )
    await recordMemory(
      draft({
        type: 'fact',
        scope: 'company',
        workspaceId: null,
        companyId,
        status: 'verified',
        confidence: 'sourced',
        verifiedBy: 'human',
        title: 'company fact',
      }),
    )
    const given = await memoriesForRun({ workspaceId, slaveId, taskId, kind: 'implementation' })
    expect(given.map((one) => one.title)).toEqual(['mine', 'project fact', 'company fact'])
  })

  it('answers an unknown project with nothing at all rather than throwing', async () => {
    expect(await listMemories({ workspaceId: 'nope' })).toEqual([])
    expect(await memoriesForRun({ workspaceId: 'nope', slaveId: null, taskId: null, kind: 'planning' })).toEqual([])
  })
})

describe('the stale-candidate count and the discard (R2, plan errata E11/E12)', () => {
  it('counts only candidates older than a day, and withdraws exactly those', async () => {
    const fresh = await recordMemory(draft({ title: 'fresh' }))
    const old = await recordMemory(draft({ title: 'old' }))
    expect(fresh.ok && old.ok).toBe(true)
    if (!old.ok || !fresh.ok) return
    const longAgo = new Date(Date.now() - MEMORY_CANDIDATE_STALE_MS - 60_000)
    await prisma.memory.update({ where: { id: old.value.id }, data: { createdAt: longAgo } })

    expect(await staleCandidateCount(workspaceId, new Date())).toBe(1)
    expect(await discardStaleCandidates(workspaceId, new Date(), { userId })).toBe(1)

    const withdrawn = await prisma.memory.findUniqueOrThrow({ where: { id: old.value.id } })
    expect(withdrawn.status).toBe('removed')
    expect(withdrawn.removedReason).toBe('stale candidate, never verified')
    expect((await prisma.memory.findUniqueOrThrow({ where: { id: fresh.value.id } })).status).toBe('candidate')
    expect(await staleCandidateCount(workspaceId, new Date())).toBe(0)
    expect(await discardStaleCandidates(workspaceId, new Date())).toBe(0)
  })
})
