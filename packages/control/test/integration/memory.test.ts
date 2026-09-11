import { type Prisma, prisma } from '@slave-of-ai/db/client'
import { MEMORIES_IN_PROMPT, MEMORY_CANDIDATE_STALE_MS, MEMORY_CAPABILITIES_MAX } from '@slave-of-ai/domain'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  addMemory,
  condenseWorkspaceMemories,
  discardStaleCandidates,
  listMemories,
  listMemoriesByIds,
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
  // The events go too: several cases below count the `memory.changed` rows one verb wrote, and an
  // event the case before it left behind would be indistinguishable from one this verb produced.
  await prisma.executionEvent.deleteMany({ where: { workspaceId } })
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

  // M49 t3: a worker's lesson has no workspace of its own, so without a home the event reaches no
  // stream at all and a rejection being learnt from is invisible on the Activity page. The caller
  // that knows the project passes it; the ROW stays the worker's.
  it('files a worker-scoped memory’s event in the project its caller names', async () => {
    const before = await prisma.executionEvent.count({ where: { workspaceId, type: 'memory_recorded' } })
    const written = await recordMemory(
      draft({
        type: 'lesson',
        scope: 'worker',
        workspaceId: null,
        slaveId,
        status: 'verified',
        confidence: 'sourced',
        verifiedBy: 'review',
        title: 'Rework on Ship the checkout API',
        body: 'The empty-input case was not handled.',
      }),
      undefined,
      workspaceId,
    )
    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(written.value.workspaceId).toBeNull()
    expect(written.value.slaveId).toBe(slaveId)
    expect(await prisma.executionEvent.count({ where: { workspaceId, type: 'memory_recorded' } })).toBe(before + 1)
  })

  it('writes no event at all for a worker-scoped memory nobody gave a home', async () => {
    const before = await prisma.executionEvent.count({ where: { type: 'memory_recorded' } })
    const written = await recordMemory(
      draft({
        type: 'lesson',
        scope: 'worker',
        workspaceId: null,
        slaveId: otherSlaveId,
        status: 'verified',
        confidence: 'sourced',
        verifiedBy: 'review',
        title: 'Rework on Ship the checkout API',
        body: 'Nobody said which project.',
      }),
    )
    expect(written.ok).toBe(true)
    expect(await prisma.executionEvent.count({ where: { type: 'memory_recorded' } })).toBe(before)
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
    expect(chain.value.supersedes.map((one) => one.id)).toEqual([candidate.value.id])
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

  // Fix round 1, minor 4: provenance is decided here, and so is the TARGET -- a caller that sends a
  // companyId beside a workspace scope must not have it written into the row the scope does not name.
  it('nulls every target but the one the scope names', async () => {
    const added = await addMemory(
      {
        workspaceId,
        companyId,
        slaveId,
        scope: 'workspace',
        type: 'fact',
        title: 'Only the project',
        body: 'one target, and it is the one the scope names',
        capabilities: [],
      },
      { userId },
    )
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.value.workspaceId).toBe(workspaceId)
    expect(added.value.companyId).toBeNull()
    expect(added.value.slaveId).toBeNull()
  })

  // Fix round 1, minor 3: a corrected condensation still knows what it is a summary of.
  it('carries the old row’s sources onto the correction', async () => {
    const first = await recordMemory(draft({ title: 'source one' }))
    const second = await recordMemory(draft({ title: 'source two' }))
    const summary = await recordMemory(
      draft({
        type: 'procedure',
        status: 'verified',
        confidence: 'sourced',
        verifiedBy: 'human',
        title: 'what those two say',
        provenance: { ...(draft().provenance as Record<string, unknown>), sourceKind: 'condensation', sourceRef: null },
      }),
    )
    expect(first.ok && second.ok && summary.ok).toBe(true)
    if (!first.ok || !second.ok || !summary.ok) return
    await prisma.memorySource.createMany({
      data: [
        { memoryId: summary.value.id, sourceMemoryId: first.value.id },
        { memoryId: summary.value.id, sourceMemoryId: second.value.id },
      ],
    })

    const corrected = await supersedeMemory(summary.value.id, { title: 'what those two really say', body: 'both' }, { userId })
    expect(corrected.ok).toBe(true)
    if (!corrected.ok) return
    const expected = [first.value.id, second.value.id].sort((a, b) => a.localeCompare(b))
    expect([...corrected.value.created.sourceIds]).toEqual(expected)
    const chain = await readMemory(corrected.value.created.id)
    expect(chain.ok).toBe(true)
    if (!chain.ok) return
    expect(chain.value.sources.map((one) => one.id).sort((a, b) => a.localeCompare(b))).toEqual(expected)
  })

  // Fix round 1, minor 5: one memory can retire SEVERAL -- a verified fact retires every candidate
  // its task left behind -- so the chain reads the whole set, not the first one found.
  it('reads every row a memory replaced, oldest first', async () => {
    const one = await recordMemory(draft({ title: 'first claim' }))
    const two = await recordMemory(draft({ title: 'second claim' }))
    expect(one.ok && two.ok).toBe(true)
    if (!one.ok || !two.ok) return
    const fact = await recordMemory(
      draft({
        type: 'fact',
        status: 'verified',
        confidence: 'sourced',
        verifiedBy: 'verification',
        supersedesTaskCandidates: true,
        title: 'what actually happened',
        provenance: { ...(draft().provenance as Record<string, unknown>), sourceKind: 'verification', sourceRef: null },
      }),
    )
    expect(fact.ok).toBe(true)
    if (!fact.ok) return
    const chain = await readMemory(fact.value.id)
    expect(chain.ok).toBe(true)
    if (!chain.ok) return
    expect(chain.value.supersedes.map((row) => row.title)).toEqual(['first claim', 'second claim'])
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

  /**
   * M49 t4 fix round 1, minor 2: the task drawer's "what this run was GIVEN" list has ids off a
   * recorded manifest and no interest in any of their chains, so it asks for the rows and nothing
   * else.
   */
  it('reads a set of ids in one query, at every status, skipping an id nothing answers to', async () => {
    const first = await recordMemory(draft({ title: 'A' }))
    const second = await recordMemory(
      draft({ title: 'B', type: 'fact', status: 'verified', confidence: 'sourced', verifiedBy: 'verification' }),
    )
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    await removeMemory(first.value.id, 'it turned out to be wrong')

    const rows = await listMemoriesByIds([second.value.id, first.value.id, 'no-such-memory'])
    // Oldest first, `readMemory`'s own chain ordering -- not the order the caller asked in.
    expect(rows.map((one) => one.title)).toEqual(['A', 'B'])
    // A WITHDRAWN row is still what a run was handed, so it comes back with its status intact.
    expect(rows[0]?.status).toBe('removed')
    expect(await listMemoriesByIds([])).toEqual([])
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
    expect(given.memories.map((one) => one.title)).toEqual(['mine', 'project fact', 'company fact'])
    // Nothing was left out, so nothing was capped (fix round 1, item 3).
    expect(given.eligible).toBe(3)
  })

  // Fix round 1, item 3: `capped` has to mean "there was more to say", and the only honest source
  // for that is how many rows QUALIFIED -- not how many came back, which is twelve both when
  // twelve qualified and when six hundred did.
  it('counts every memory that qualified, not only the twelve it hands over', async () => {
    for (let index = 0; index < MEMORIES_IN_PROMPT; index += 1) {
      const written = await recordMemory(
        draft({
          type: 'fact',
          status: 'verified',
          confidence: 'sourced',
          verifiedBy: 'verification',
          title: `fact ${String(index)}`,
        }),
      )
      expect(written.ok).toBe(true)
    }
    const exactly = await memoriesForRun({ workspaceId, slaveId, taskId, kind: 'implementation' })
    expect(exactly.memories).toHaveLength(MEMORIES_IN_PROMPT)
    expect(exactly.eligible).toBe(MEMORIES_IN_PROMPT)

    const extra = await recordMemory(
      draft({
        type: 'fact',
        status: 'verified',
        confidence: 'sourced',
        verifiedBy: 'verification',
        title: 'one more',
      }),
    )
    expect(extra.ok).toBe(true)
    const over = await memoriesForRun({ workspaceId, slaveId, taskId, kind: 'implementation' })
    expect(over.memories).toHaveLength(MEMORIES_IN_PROMPT)
    expect(over.eligible).toBe(MEMORIES_IN_PROMPT + 1)
  })

  // R3's first eligibility rule, enforced in the QUERY and not only in the ranking: a candidate is
  // a worker's claim, and a run must never be handed one as knowledge.
  it('never loads an unverified candidate, however well it matches the task', async () => {
    const claim = await recordMemory(draft({ title: 'a claim nobody checked' }))
    expect(claim.ok).toBe(true)
    expect(await memoriesForRun({ workspaceId, slaveId, taskId, kind: 'implementation' })).toEqual({
      memories: [],
      eligible: 0,
    })
  })

  it('answers an unknown project with nothing at all rather than throwing', async () => {
    expect(await listMemories({ workspaceId: 'nope' })).toEqual([])
    expect(await memoriesForRun({ workspaceId: 'nope', slaveId: null, taskId: null, kind: 'planning' })).toEqual({
      memories: [],
      eligible: 0,
    })
  })
})

/**
 * Fix round 1, Important 1: every one of these verbs reads a row, decides, and then writes. The
 * write is conditional on the status the READ saw -- `supersedeMemory`'s own idiom -- so a
 * concurrent verb that moved the row in between wins it, and this one is refused rather than
 * stamping over somebody else's decision.
 *
 * Each case reassigns one Prisma delegate method to a wrapper that still forwards to the real
 * implementation, so the race happens for real against Postgres in the exact window the guard
 * exists for. `vi.spyOn` does not survive the delegate's Proxy (M49 note; `skill-graph.test.ts`
 * has the same escape hatch), and every wrapper is restored in a `finally`.
 */
describe('the write is conditional on the status the read saw (fix round 1)', () => {
  /**
   * Runs `during` once around the next `prisma.memory.<method>` call, then forwards; every later
   * call goes straight through.
   *
   * `when` is the whole point. Racing a READ means the other writer lands AFTER the read returns,
   * so the verb decides on a value that is already out of date. Racing a WRITE means it lands
   * BEFORE, so the write's own `where` is what has to notice. Each case below picks the one that
   * puts the race in the window its guard exists for.
   */
  async function racing<T>(
    method: 'findUnique' | 'updateMany',
    when: 'after' | 'before',
    during: () => Promise<unknown>,
    body: () => Promise<T>,
  ): Promise<T> {
    const delegate = prisma.memory as unknown as Record<string, (args: unknown) => unknown>
    const original = (delegate[method] as (args: unknown) => unknown).bind(prisma.memory)
    let raced = false
    delegate[method] = (args: unknown): unknown => {
      if (raced) return original(args)
      raced = true
      return (async (): Promise<unknown> => {
        if (when === 'before') {
          await during()
          return original(args)
        }
        const result = await original(args)
        await during()
        return result
      })()
    }
    try {
      return await body()
    } finally {
      delegate[method] = original
    }
  }

  it('refuses a verify whose row somebody withdrew after the read, and leaves it withdrawn', async () => {
    const one = await recordMemory(draft())
    expect(one.ok).toBe(true)
    if (!one.ok) return

    const result = await racing(
      'findUnique',
      'after',
      () =>
        prisma.memory.update({
          where: { id: one.value.id },
          data: { status: 'removed', removedReason: 'somebody else withdrew it' },
        }),
      () => verifyMemory(one.value.id, { userId }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('memory_not_editable')
    const row = await prisma.memory.findUniqueOrThrow({ where: { id: one.value.id } })
    // Still withdrawn, and still for the reason the person who withdrew it gave.
    expect(row.status).toBe('removed')
    expect(row.removedReason).toBe('somebody else withdrew it')
    expect(row.verifiedBy).toBeNull()
  })

  it('refuses a removal whose row somebody verified after the read', async () => {
    const one = await recordMemory(draft())
    expect(one.ok).toBe(true)
    if (!one.ok) return

    const result = await racing(
      'findUnique',
      'after',
      () =>
        prisma.memory.update({
          where: { id: one.value.id },
          data: { status: 'superseded', supersededById: null },
        }),
      () => removeMemory(one.value.id, 'out of date', { userId }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('memory_not_editable')
    const row = await prisma.memory.findUniqueOrThrow({ where: { id: one.value.id } })
    expect(row.status).toBe('superseded')
    expect(row.removedReason).toBeNull()
  })

  it('refuses a correction whose row moved after the read, and leaves NO half-written replacement', async () => {
    const one = await recordMemory(draft())
    expect(one.ok).toBe(true)
    if (!one.ok) return
    const before = await prisma.memory.count({ where: { workspaceId } })

    const result = await racing(
      'findUnique',
      'after',
      () =>
        prisma.memory.update({
          where: { id: one.value.id },
          data: { status: 'removed', removedReason: 'somebody else withdrew it' },
        }),
      () => supersedeMemory(one.value.id, { title: 'a better title', body: 'better words' }, { userId }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('memory_not_editable')
    // The insert and the stamp are one transaction: the refusal THROWS inside it, so the row it
    // had already written is rolled back rather than committed as an orphan.
    expect(await prisma.memory.count({ where: { workspaceId } })).toBe(before)
  })

  it('skips a stale candidate somebody verified between the discard’s read and its write', async () => {
    const longAgo = new Date(Date.now() - MEMORY_CANDIDATE_STALE_MS - 60_000)
    const lucky = await recordMemory(draft({ title: 'lucky' }))
    const doomed = await recordMemory(draft({ title: 'doomed' }))
    expect(lucky.ok && doomed.ok).toBe(true)
    if (!lucky.ok || !doomed.ok) return
    await prisma.memory.updateMany({
      where: { id: { in: [lucky.value.id, doomed.value.id] } },
      data: { createdAt: longAgo },
    })

    const withdrawn = await racing(
      'updateMany',
      'before',
      () =>
        prisma.memory.update({
          where: { id: lucky.value.id },
          data: { status: 'verified', verifiedAt: new Date(), verifiedBy: 'human' },
        }),
      () => discardStaleCandidates(workspaceId, new Date(), { userId }),
    )

    // One, not two: a thing somebody verified in that window is knowledge, and calling it "never
    // verified" would be a lie the row would carry forever.
    expect(withdrawn).toBe(1)
    expect((await prisma.memory.findUniqueOrThrow({ where: { id: lucky.value.id } })).status).toBe('verified')
    expect((await prisma.memory.findUniqueOrThrow({ where: { id: doomed.value.id } })).status).toBe('removed')
    const events = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'memory_changed' } })
    const about = events.map((event) => (event.payload as { memoryId: string }).memoryId)
    expect(about).toEqual([doomed.value.id])
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

  // Fix round 1, minor 2: the discard pages rather than loading a year of unverified reports into
  // memory at once. Three rows through a batch of two is the smallest shape that proves the loop
  // takes a second page and stops on the third.
  it('withdraws every stale candidate across as many pages as it takes', async () => {
    const longAgo = new Date(Date.now() - MEMORY_CANDIDATE_STALE_MS - 60_000)
    const ids: string[] = []
    for (const title of ['one', 'two', 'three']) {
      const written = await recordMemory(draft({ title }))
      expect(written.ok).toBe(true)
      if (!written.ok) return
      ids.push(written.value.id)
    }
    await prisma.memory.updateMany({ where: { id: { in: ids } }, data: { createdAt: longAgo } })

    expect(await discardStaleCandidates(workspaceId, new Date(), { userId }, { batch: 2 })).toBe(3)
    expect(await prisma.memory.count({ where: { id: { in: ids }, status: 'removed' } })).toBe(3)
    expect(await prisma.executionEvent.count({ where: { workspaceId, type: 'memory_changed' } })).toBe(3)
  })
})

/**
 * M49 R5. Deterministic text, no model call, and nothing replaced: the twenty sources stay
 * `verified` and stay in the table, and it is retrieval that prefers the summary over them.
 */
describe('condenseWorkspaceMemories (R5)', () => {
  it('writes one summary with twenty MemorySource rows, and the next run gets it instead of them', async () => {
    for (let index = 0; index < 20; index += 1) {
      const written = await recordMemory(
        draft({
          type: 'fact',
          status: 'verified',
          confidence: 'sourced',
          verifiedBy: 'verification',
          title: `Fact ${String(index)}`,
        }),
      )
      expect(written.ok).toBe(true)
    }
    const result = await condenseWorkspaceMemories(workspaceId, 'fact')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const made = result.value
    expect(made).toHaveLength(1)
    // The type WRITTEN, which for a fact is the type summarised (fix round 1, ruling 3).
    expect(made[0]?.type).toBe('fact')
    expect(made[0]?.sources).toBe(20)
    const memoryId = made[0]?.memoryId ?? ''
    expect(await prisma.memorySource.count({ where: { memoryId } })).toBe(20)
    // The sources are untouched: a summary is an index, not a replacement.
    expect(await prisma.memory.count({ where: { workspaceId, type: 'fact', status: 'verified' } })).toBe(21)

    const summary = await readMemory(memoryId)
    expect(summary.ok).toBe(true)
    if (!summary.ok) return
    expect(summary.value.memory.provenance.sourceKind).toBe('condensation')
    expect(summary.value.memory.title).toMatch(/^Fact summary \(20 sources, /)
    expect(summary.value.sources).toHaveLength(20)
    // The event a person reads on the timeline: twenty promotions and the summary that indexes
    // them, all filed in this project (`beforeEach` empties the stream).
    expect(await prisma.executionEvent.count({ where: { workspaceId, type: 'memory_recorded' } })).toBe(21)

    // Plan erratum E4, through the database: the summary is what a run is given, and its twenty
    // sources are not given again beside it.
    const given = await memoriesForRun({ workspaceId, slaveId, taskId, kind: 'implementation' })
    expect(given.memories.map((one) => one.id)).toEqual([memoryId])
    expect(given.eligible).toBe(1)

    // Idempotent by construction: every loose fact is now covered, so a second pass finds nothing.
    const twice = await condenseWorkspaceMemories(workspaceId, 'fact')
    expect(twice.ok && twice.value).toEqual([])
  })

  it('condenses a worker’s twenty lessons into a procedure, and leaves the company alone', async () => {
    const companyFacts: string[] = []
    for (let index = 0; index < 20; index += 1) {
      const lesson = await recordMemory(
        draft({
          type: 'lesson',
          scope: 'worker',
          workspaceId: null,
          slaveId,
          status: 'verified',
          confidence: 'sourced',
          verifiedBy: 'review',
          title: `Lesson ${String(index)}`,
        }),
        undefined,
        workspaceId,
      )
      expect(lesson.ok).toBe(true)
      const fact = await recordMemory(
        draft({
          type: 'fact',
          scope: 'company',
          workspaceId: null,
          companyId,
          status: 'verified',
          confidence: 'sourced',
          verifiedBy: 'verification',
          title: `Company fact ${String(index)}`,
        }),
        undefined,
        workspaceId,
      )
      expect(fact.ok).toBe(true)
      if (fact.ok) companyFacts.push(fact.value.id)
    }

    const result = await condenseWorkspaceMemories(workspaceId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const made = result.value
    // One summary, and it is the worker's: a project's cron must never rewrite what the company
    // knows, because that knowledge is shared between projects.
    expect(made).toHaveLength(1)
    // The type WRITTEN (fix round 1, ruling 3): twenty lessons are a PROCEDURE.
    expect(made[0]?.type).toBe('procedure')
    const summary = await readMemory(made[0]?.memoryId ?? '')
    expect(summary.ok).toBe(true)
    if (!summary.ok) return
    expect(summary.value.memory.type).toBe('procedure')
    expect(summary.value.memory.scope).toBe('worker')
    expect(summary.value.memory.slaveId).toBe(slaveId)
    expect(summary.value.memory.title).toMatch(/^What this worker has learned to do \(20 sources, /)
    expect(await prisma.memory.count({ where: { id: { in: companyFacts }, status: 'verified' } })).toBe(20)
  })

  it('says nothing at all below the threshold, and refuses a project that is not there', async () => {
    for (let index = 0; index < 19; index += 1) {
      const written = await recordMemory(
        draft({
          type: 'fact',
          status: 'verified',
          confidence: 'sourced',
          verifiedBy: 'verification',
          title: `Fact ${String(index)}`,
        }),
      )
      expect(written.ok).toBe(true)
    }
    const none = await condenseWorkspaceMemories(workspaceId, 'fact')
    expect(none.ok && none.value).toEqual([])

    // Fix round 1, minor 6: an id nobody answers to is a typo, not "nothing to summarise".
    const missing = await condenseWorkspaceMemories('no-such-workspace')
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error).toEqual({ kind: 'workspace_not_found', workspaceId: 'no-such-workspace' })
  })

  /** Bulk fixtures: `recordMemory` per row would be five hundred round trips for a window test. */
  const bulk = async (
    count: number,
    from: number,
    overrides: (index: number) => Pick<Prisma.MemoryCreateManyInput, 'type' | 'title'> &
      Partial<Prisma.MemoryCreateManyInput>,
  ): Promise<void> => {
    await prisma.memory.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        scope: 'workspace' as const,
        workspaceId,
        body: 'It is true.',
        confidence: 'sourced' as const,
        sourceKind: 'verification' as const,
        createdBy: 'system' as const,
        // One minute apart, oldest first, so "the oldest five hundred" is a set a case can name.
        createdAt: new Date(Date.UTC(2026, 0, 1) + (from + index) * 60_000),
        ...overrides(index),
      })),
    })
  }

  /**
   * Fix round 1, critical 1. The old read took the oldest `MEMORIES_LOADED_MAX` rows of ANY status,
   * so once a project held more than five hundred the summary it had just written fell outside its
   * own window and the next run condensed the very same facts again -- a second summary, a second
   * set of `MemorySource` rows, and two prompt slots spent on one thing.
   */
  it('does not summarise the same facts twice once the project holds more than five hundred rows', async () => {
    await bulk(20, 0, (index) => ({
      type: 'fact' as const,
      status: 'verified' as const,
      title: `Old fact ${String(index)}`,
      verifiedAt: new Date(),
      verifiedBy: 'verification',
    }))
    await bulk(500, 20, (index) => ({
      type: 'observation' as const,
      status: 'candidate' as const,
      confidence: 'interpretation' as const,
      sourceKind: 'run_output' as const,
      createdBy: 'slave' as const,
      title: `Noise ${String(index)}`,
    }))
    expect(await prisma.memory.count({ where: { workspaceId } })).toBe(520)

    const first = await condenseWorkspaceMemories(workspaceId, 'fact')
    expect(first.ok && first.value).toHaveLength(1)

    // The summary is the NEWEST row of five hundred and twenty; the run that follows must still
    // see that it covers the twenty.
    const second = await condenseWorkspaceMemories(workspaceId, 'fact')
    expect(second.ok && second.value).toEqual([])
    expect(await prisma.memory.count({ where: { workspaceId, sourceKind: 'condensation' } })).toBe(1)
    expect(await prisma.memorySource.count({})).toBe(20)
  })

  /** The other half of critical 1: five hundred unverified reports must not crowd the knowledge out
   *  of the window that decides what gets summarised. */
  it('summarises thirty loose facts that sit behind five hundred stale candidates', async () => {
    await bulk(500, 0, (index) => ({
      type: 'observation' as const,
      status: 'candidate' as const,
      confidence: 'interpretation' as const,
      sourceKind: 'run_output' as const,
      createdBy: 'slave' as const,
      title: `Noise ${String(index)}`,
    }))
    await bulk(30, 500, (index) => ({
      type: 'fact' as const,
      status: 'verified' as const,
      title: `Late fact ${String(index)}`,
      verifiedAt: new Date(),
      verifiedBy: 'verification',
    }))

    const made = await condenseWorkspaceMemories(workspaceId, 'fact')
    expect(made.ok).toBe(true)
    if (!made.ok) return
    expect(made.value).toHaveLength(1)
    expect(made.value[0]?.sources).toBe(30)
  })

  /**
   * Fix round 1, ruling 4: the machine-built draft goes through `parseMemoryDraft` like every other
   * write. Twenty-five sources naming twenty-five distinct capability keys is the case that proves
   * it -- `memoryDraftSchema` caps `capabilities` at twenty, so without `condenseMemories`' own cap
   * the parse would refuse and NOTHING would be written.
   */
  it('validates the draft it built, and the capability cap is what lets it through', async () => {
    await bulk(25, 0, (index) => ({
      type: 'fact' as const,
      status: 'verified' as const,
      title: `Wide fact ${String(index)}`,
      capabilities: [`area.${String(index).padStart(2, '0')}`],
      verifiedAt: new Date(),
      verifiedBy: 'verification',
    }))
    const made = await condenseWorkspaceMemories(workspaceId, 'fact')
    expect(made.ok).toBe(true)
    if (!made.ok) return
    expect(made.value).toHaveLength(1)
    const summary = await readMemory(made.value[0]?.memoryId ?? '')
    expect(summary.ok).toBe(true)
    if (!summary.ok) return
    expect(summary.value.memory.capabilities).toHaveLength(MEMORY_CAPABILITIES_MAX)
  })

  /** Fix round 1, minor 8: a workspace-scoped LESSON summary is a procedure no run could ever be
   *  given -- `retrieveMemories` shows a lesson only to the worker who owns it. */
  it('never offers the workspace scope its lessons', async () => {
    await bulk(20, 0, (index) => ({
      type: 'lesson' as const,
      status: 'verified' as const,
      title: `Project lesson ${String(index)}`,
      verifiedAt: new Date(),
      verifiedBy: 'review',
    }))
    const made = await condenseWorkspaceMemories(workspaceId, 'lesson')
    expect(made.ok && made.value).toEqual([])
    const all = await condenseWorkspaceMemories(workspaceId)
    expect(all.ok && all.value).toEqual([])
  })

  /** Fix round 1, important 2, through the database: withdrawing a summary gives its sources back. */
  it('re-condenses the sources of a summary somebody withdrew', async () => {
    await bulk(20, 0, (index) => ({
      type: 'fact' as const,
      status: 'verified' as const,
      title: `Fact ${String(index)}`,
      verifiedAt: new Date(),
      verifiedBy: 'verification',
    }))
    const first = await condenseWorkspaceMemories(workspaceId, 'fact')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const summaryId = first.value[0]?.memoryId ?? ''
    expect(await condenseWorkspaceMemories(workspaceId, 'fact').then((one) => one.ok && one.value)).toEqual([])

    const withdrawn = await removeMemory(summaryId, 'it summarised the wrong thing')
    expect(withdrawn.ok).toBe(true)
    const again = await condenseWorkspaceMemories(workspaceId, 'fact')
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value).toHaveLength(1)
    expect(again.value[0]?.sources).toBe(20)
    expect(again.value[0]?.memoryId).not.toBe(summaryId)
  })
})
