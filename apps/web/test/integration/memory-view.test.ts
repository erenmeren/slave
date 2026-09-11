import { prisma } from '@slave-of-ai/db/client'
import { syncCapabilityTaxonomy } from '@slave-of-ai/control'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_KNOWLEDGE_STATUSES, buildKnowledge, buildTaskMemories } from '../../src/server/memory'
import { GET as memoriesGET, POST as memoriesPOST } from '../../src/app/api/w/[workspaceId]/memories/route'
import { POST as verifyPOST } from '../../src/app/api/w/[workspaceId]/memories/[memoryId]/verify/route'
import { POST as supersedePOST } from '../../src/app/api/w/[workspaceId]/memories/[memoryId]/supersede/route'
import { POST as removePOST } from '../../src/app/api/w/[workspaceId]/memories/[memoryId]/remove/route'
import { GET as taskMemoriesGET } from '../../src/app/api/w/[workspaceId]/tasks/[taskId]/memories/route'
import KnowledgePage from '../../src/app/w/[workspaceId]/knowledge/page'
import { seedTask, seedWorkspace, truncateAll } from './projectFixture'

/** The one `next/headers` mock the route cases need (`organization.test.ts`'s idiom). Inert without
 *  `SLAVEOFAI_SESSION_SECRET`: `requirePrincipal` short-circuits before `cookies()`. */
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (): undefined => undefined }),
}))

/**
 * The web's two knowledge read models against a real database (M49 R6).
 *
 * `buildKnowledge`'s filters, its counts and the chain pointers a row carries are SQL, not
 * rendering, and the component test upstairs proves nothing about any of them: it renders a view
 * somebody typed. This is where the view comes from.
 */
let workspaceId = ''
let otherWorkspaceId = ''
let taskId = ''
let slaveId = ''

interface MemorySeed {
  readonly title: string
  readonly body?: string
  readonly type?: string
  readonly status?: string
  readonly scope?: string
  readonly sourceKind?: string
  readonly taskId?: string | null
  readonly runId?: string | null
  readonly workspaceId?: string | null
  readonly slaveId?: string | null
  readonly verifiedBy?: string | null
  readonly supersededById?: string | null
  readonly capabilities?: readonly string[]
  readonly goalVersion?: number | null
  readonly removedReason?: string | null
}

async function seedMemory(seed: MemorySeed): Promise<{ readonly id: string }> {
  const row = await prisma.memory.create({
    data: {
      type: (seed.type ?? 'fact') as never,
      scope: (seed.scope ?? 'workspace') as never,
      workspaceId: seed.workspaceId === undefined ? workspaceId : seed.workspaceId,
      slaveId: seed.slaveId ?? null,
      title: seed.title,
      body: seed.body ?? 'the body of the thing this organisation knows',
      status: (seed.status ?? 'verified') as never,
      confidence: 'sourced',
      sourceKind: (seed.sourceKind ?? 'verification') as never,
      sourceRef: '412',
      createdBy: 'system',
      taskId: seed.taskId === undefined ? taskId : seed.taskId,
      runId: seed.runId ?? null,
      goalVersion: seed.goalVersion === undefined ? 2 : seed.goalVersion,
      capabilities: [...(seed.capabilities ?? [])],
      verifiedAt: (seed.status ?? 'verified') === 'verified' ? new Date() : null,
      verifiedBy: seed.verifiedBy === undefined ? 'verification' : seed.verifiedBy,
      supersededById: seed.supersededById ?? null,
      removedReason: seed.removedReason ?? null,
    },
    select: { id: true },
  })
  return row
}

beforeEach(async () => {
  await truncateAll()
  await syncCapabilityTaxonomy()
  const fixture = await seedWorkspace({ goal: 'Ship the checkout API' })
  workspaceId = fixture.workspaceId
  slaveId = fixture.slaveId
  const task = await seedTask(workspaceId, { title: 'Ship the checkout API', status: 'done' })
  taskId = task.id
  // `seedWorkspace` hardcodes its name and `Workspace.name` is unique (M23 A1), so the second
  // project is created here rather than seeded twice.
  const other = await prisma.workspace.create({
    data: { name: 'Another Project', repoPath: '/tmp/m49-other', verifyCommands: [], setupCommands: [] },
    select: { id: true },
  })
  otherWorkspaceId = other.id
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('buildKnowledge', () => {
  it('is null for a project that is not there -- a page owes its caller a 404, not an empty list', async () => {
    expect(await buildKnowledge('no-such-workspace')).toBeNull()
  })

  it('shows the verified and the waiting by default, and nothing that is frozen', async () => {
    await seedMemory({ title: 'A verified fact' })
    await seedMemory({ title: 'A candidate observation', type: 'observation', status: 'candidate', verifiedBy: null })
    await seedMemory({ title: 'A withdrawn claim', status: 'removed', removedReason: 'it was wrong' })
    const view = await buildKnowledge(workspaceId)
    expect(view).not.toBeNull()
    if (view === null) return
    expect(view.rows.map((row) => row.memory.title).sort()).toEqual(['A candidate observation', 'A verified fact'])
    expect(DEFAULT_KNOWLEDGE_STATUSES).toEqual(['verified', 'candidate'])
  })

  it('is one filter away from what was withdrawn -- nothing is ever deleted, and it has to be checkable', async () => {
    await seedMemory({ title: 'A withdrawn claim', status: 'removed', removedReason: 'it was wrong' })
    const view = await buildKnowledge(workspaceId, { statuses: ['removed'] })
    expect(view?.rows.map((row) => row.memory.title)).toEqual(['A withdrawn claim'])
    expect(view?.rows[0]?.memory.removedReason).toBe('it was wrong')
  })

  it('counts over the whole project, never over the rows a filter left', async () => {
    await seedMemory({ title: 'One' })
    await seedMemory({ title: 'Two' })
    await seedMemory({ title: 'A candidate', status: 'candidate', verifiedBy: null })
    const view = await buildKnowledge(workspaceId, { type: 'procedure' })
    expect(view?.rows).toEqual([])
    expect(view?.counts).toEqual({ verified: 2, candidates: 1 })
  })

  it('projects every union member into words and keeps the keys out of the row’s own text', async () => {
    await seedMemory({ title: 'A verified fact', runId: null, capabilities: ['backend.api-design'] })
    const row = (await buildKnowledge(workspaceId))?.rows[0]
    expect(row?.typeLabel).toBe('Fact')
    expect(row?.scopeLabel).toBe('This project')
    expect(row?.statusLabel).toBe('Verified')
    expect(row?.confidenceLabel).toBe('Sourced')
    expect(row?.taskTitle).toBe('Ship the checkout API')
    // The DOMAIN's sentence, not one assembled here: the prompt's stamp and the CLI print it too.
    expect(row?.provenance).toBe('from a passed verification of “Ship the checkout API” · goal v2 · verified by verification')
    // The capability as a WORD, with its key beside it for `title` (docs/ia.md rule 3).
    expect(row?.capabilities).toEqual([{ key: 'backend.api-design', label: 'API design' }])
  })

  it('lists every memory a row replaced, oldest first, with the titles the chain prints', async () => {
    const fact = await seedMemory({ title: 'The fact that replaced them' })
    const first = await seedMemory({
      title: 'The first candidate',
      status: 'superseded',
      supersededById: fact.id,
      type: 'observation',
      verifiedBy: null,
    })
    const second = await seedMemory({
      title: 'The second candidate',
      status: 'superseded',
      supersededById: fact.id,
      type: 'observation',
      verifiedBy: null,
    })
    const view = await buildKnowledge(workspaceId)
    const row = view?.rows.find((one) => one.memory.id === fact.id)
    expect(row?.supersedesIds).toEqual([first.id, second.id])
    expect(view?.memoryTitles[first.id]).toBe('The first candidate')
    expect(view?.memoryTitles[second.id]).toBe('The second candidate')
  })

  it('filters by scope, by type and by a word in the title', async () => {
    await seedMemory({ title: 'How we release', type: 'procedure' })
    await seedMemory({ title: 'The orders route needs a session', type: 'fact' })
    await seedMemory({ title: 'A worker lesson', type: 'lesson', scope: 'worker', workspaceId: null, slaveId })

    expect((await buildKnowledge(workspaceId, { type: 'procedure' }))?.rows.map((r) => r.memory.title)).toEqual([
      'How we release',
    ])
    expect((await buildKnowledge(workspaceId, { q: 'orders' }))?.rows.map((r) => r.memory.title)).toEqual([
      'The orders route needs a session',
    ])
    // A worker-scoped memory hangs off the SLAVE, and this project's page reads it because the
    // worker is on this project's team -- `listMemories`' own three scopes (R3).
    expect((await buildKnowledge(workspaceId, { scope: 'worker' }))?.rows.map((r) => r.memory.title)).toEqual([
      'A worker lesson',
    ])
    // The COUNTS stay this project's own, whatever the rows carry: they are the two numbers the
    // Overview's knowledge line prints, and `server/brief.ts` counts them the same way.
    expect((await buildKnowledge(workspaceId))?.counts).toEqual({ verified: 2, candidates: 0 })
  })
})

describe('buildTaskMemories (plan erratum E7)', () => {
  async function seedRunWithManifest(
    memoryIds: readonly string[],
    sections?: unknown,
    createdAt?: Date,
  ): Promise<void> {
    const run = await prisma.slaveRun.create({ data: { slaveId, taskId, kind: 'implementation', status: 'succeeded' } })
    await prisma.runContext.create({
      data: {
        runId: run.id,
        prompt: 'the prompt this run was given',
        sections: (sections ?? {
          kind: 'implementation',
          sections: [{ kind: 'memory', memoryIds: [...memoryIds], capped: false }],
        }) as never,
        ...(createdAt === undefined ? {} : { createdAt }),
      },
    })
  }

  it('is null for a task that belongs to another project', async () => {
    expect(await buildTaskMemories(otherWorkspaceId, taskId)).toBeNull()
    expect(await buildTaskMemories(workspaceId, 'no-such-task')).toBeNull()
  })

  it('reads what this task’s runs were GIVEN off their recorded manifests', async () => {
    const given = await seedMemory({ title: 'Given to the run', taskId: null })
    await seedRunWithManifest([given.id])
    const view = await buildTaskMemories(workspaceId, taskId)
    expect(view?.received.map((row) => row.memory.title)).toEqual(['Given to the run'])
    expect(view?.received[0]?.typeLabel).toBe('Fact')
  })

  it('skips a manifest it cannot read rather than failing the whole panel', async () => {
    const given = await seedMemory({ title: 'Given to the good run', taskId: null })
    await seedRunWithManifest([], { kind: 'implementation', sections: [{ kind: 'not-a-kind-anybody-knows' }] })
    await seedRunWithManifest([given.id])
    const view = await buildTaskMemories(workspaceId, taskId)
    expect(view?.received.map((row) => row.memory.title)).toEqual(['Given to the good run'])
  })

  /**
   * Plan erratum E7, the whole point of reading the MANIFEST: "received" is a record of what a run
   * was handed, and a memory somebody has since withdrawn is still what that run was handed. A
   * list that quietly dropped it would be a false record of what happened.
   */
  it('keeps a memory the run was given and somebody later withdrew', async () => {
    const given = await seedMemory({ title: 'What the run was told', taskId: null })
    await seedRunWithManifest([given.id])
    await prisma.memory.update({
      where: { id: given.id },
      data: { status: 'removed', removedReason: 'it turned out to be wrong' },
    })
    const view = await buildTaskMemories(workspaceId, taskId)
    expect(view?.received.map((row) => row.memory.title)).toEqual(['What the run was told'])
    expect(view?.received[0]?.statusLabel).toBe('Removed')
  })

  /**
   * Fix round 1, minor 2: `readMemory` per id is one point read plus three chain reads EACH -- four
   * queries for every memory in a list whose chain nobody asked for. `listMemoriesByIds` is one.
   *
   * The delegate method is reassigned to a counting wrapper and restored in a `finally` rather than
   * spied on: `vi.spyOn` on a Prisma delegate captures `undefined` through the client's Proxy and
   * breaks every later test in the file (the repo's own escape hatch, `skill-graph.test.ts`).
   */
  it('reads the memories a run was given in ONE query, however many there are', async () => {
    const ids: string[] = []
    for (const title of ['One', 'Two', 'Three', 'Four']) {
      ids.push((await seedMemory({ title, taskId: null })).id)
    }
    await seedRunWithManifest(ids)

    const delegate = prisma.memory as unknown as { findMany: (...args: never[]) => unknown }
    const real = delegate.findMany.bind(prisma.memory)
    let calls = 0
    delegate.findMany = ((...args: never[]) => {
      calls += 1
      return real(...args)
    }) as never
    try {
      const view = await buildTaskMemories(workspaceId, taskId)
      expect(view?.received).toHaveLength(4)
      // ONE for the four received ids; the rest belong to `decorate` and to `listMemories`, and
      // none of them grows with the number of ids.
      expect(calls).toBeLessThanOrEqual(5)
    } finally {
      delegate.findMany = real as never
    }
  })

  /**
   * Fix round 1, minor 3: the read is bounded. A task at its attempt ceiling has a handful of runs,
   * but nothing in the schema says so -- a resumed, re-planned, re-run task can accumulate them,
   * and this panel opens on a click rather than on a poll only because it is cheap.
   */
  it('reads at most the newest 50 run contexts', async () => {
    const old = await seedMemory({ title: 'Given to the oldest run', taskId: null })
    await seedRunWithManifest([old.id], undefined, new Date('2020-01-01T00:00:00.000Z'))
    const recent = await seedMemory({ title: 'Given to a recent run', taskId: null })
    for (let index = 0; index < 50; index += 1) {
      await seedRunWithManifest([recent.id], undefined, new Date(`2026-09-11T00:${String(index).padStart(2, '0')}:00.000Z`))
    }
    const view = await buildTaskMemories(workspaceId, taskId)
    expect(view?.received.map((row) => row.memory.title)).toEqual(['Given to a recent run'])
  })

  it('shows what the task PRODUCED at every status, superseded candidates included', async () => {
    const fact = await seedMemory({ title: 'The fact this task proved' })
    await seedMemory({
      title: 'The candidate it retired',
      type: 'observation',
      status: 'superseded',
      supersededById: fact.id,
      verifiedBy: null,
    })
    const view = await buildTaskMemories(workspaceId, taskId)
    expect(view?.produced.map((row) => row.statusLabel).sort()).toEqual(['Superseded', 'Verified'])
  })
})

describe('the five routes', () => {
  const params = async (extra: Record<string, string> = {}): Promise<never> =>
    Promise.resolve({ workspaceId, ...extra }) as never

  it('answers the page’s view, and 404s a project that is not there', async () => {
    await seedMemory({ title: 'A verified fact' })
    const ok = await memoriesGET(new Request(`http://x/api/w/${workspaceId}/memories`), { params: await params() })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { rows: unknown[] }).rows).toHaveLength(1)

    const missing = await memoriesGET(new Request('http://x/api/w/nope/memories'), {
      params: Promise.resolve({ workspaceId: 'nope' }),
    })
    expect(missing.status).toBe(404)
  })

  it('ignores a filter value the union does not have rather than refusing the page', async () => {
    await seedMemory({ title: 'A verified fact' })
    const response = await memoriesGET(
      new Request(`http://x/api/w/${workspaceId}/memories?type=not-a-type&status=nonsense&scope=elsewhere`),
      { params: await params() },
    )
    expect(response.status).toBe(200)
    expect(((await response.json()) as { rows: unknown[] }).rows).toHaveLength(1)
  })

  it('reads one status when it is asked for one', async () => {
    await seedMemory({ title: 'A withdrawn claim', status: 'removed', removedReason: 'wrong' })
    const response = await memoriesGET(new Request(`http://x/api/w/${workspaceId}/memories?status=removed`), {
      params: await params(),
    })
    expect(((await response.json()) as { rows: { memory: { title: string } }[] }).rows[0]?.memory.title).toBe(
      'A withdrawn claim',
    )
  })

  it('adds a memory a person typed, verified by a person, and refuses a malformed body', async () => {
    const bad = await memoriesPOST(
      new Request(`http://x/api/w/${workspaceId}/memories`, { method: 'POST', body: JSON.stringify({ title: 'x' }) }),
      { params: await params() },
    )
    expect(bad.status).toBe(400)

    const response = await memoriesPOST(
      new Request(`http://x/api/w/${workspaceId}/memories`, {
        method: 'POST',
        body: JSON.stringify({ type: 'procedure', title: 'How we release', body: 'Tag, then deploy.' }),
      }),
      { params: await params() },
    )
    expect(response.status).toBe(200)
    const created = (await response.json()) as { id: string }
    const row = await prisma.memory.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.status).toBe('verified')
    expect(row.workspaceId).toBe(workspaceId)
  })

  it('verifies, corrects and withdraws through their own routes', async () => {
    const candidate = await seedMemory({
      title: 'A candidate',
      type: 'observation',
      status: 'candidate',
      verifiedBy: null,
    })
    const verified = await verifyPOST(new Request('http://x', { method: 'POST' }), {
      params: await params({ memoryId: candidate.id }),
    })
    expect(verified.status).toBe(200)
    expect((await prisma.memory.findUniqueOrThrow({ where: { id: candidate.id } })).status).toBe('verified')

    const corrected = await supersedePOST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ title: 'Better', body: 'Better words' }) }),
      { params: await params({ memoryId: candidate.id }) },
    )
    expect(corrected.status).toBe(200)
    const { id: newId, replaced } = (await corrected.json()) as { id: string; replaced: string }
    expect(replaced).toBe(candidate.id)
    expect((await prisma.memory.findUniqueOrThrow({ where: { id: candidate.id } })).status).toBe('superseded')

    const withdrawn = await removePOST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ reason: 'no longer true' }) }),
      { params: await params({ memoryId: newId }) },
    )
    expect(withdrawn.status).toBe(200)
    const row = await prisma.memory.findUniqueOrThrow({ where: { id: newId } })
    expect(row.status).toBe('removed')
    expect(row.removedReason).toBe('no longer true')
  })

  it('accepts a write on a worker’s memory the page shows, because the worker is on this team', async () => {
    const lesson = await seedMemory({
      title: 'A worker lesson',
      type: 'lesson',
      scope: 'worker',
      workspaceId: null,
      slaveId,
      status: 'candidate',
      verifiedBy: null,
    })
    const response = await verifyPOST(new Request('http://x', { method: 'POST' }), {
      params: await params({ memoryId: lesson.id }),
    })
    expect(response.status).toBe(200)
  })

  it('refuses a write on a memory that is not this project’s, and one nothing can change any more', async () => {
    const elsewhere = await seedMemory({ title: 'Another project’s knowledge', workspaceId: otherWorkspaceId, taskId: null })
    const crossed = await verifyPOST(new Request('http://x', { method: 'POST' }), {
      params: await params({ memoryId: elsewhere.id }),
    })
    expect(crossed.status).toBe(404)

    const gone = await seedMemory({ title: 'Withdrawn', status: 'removed', removedReason: 'wrong' })
    const refused = await supersedePOST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ title: 'a', body: 'b' }) }),
      { params: await params({ memoryId: gone.id }) },
    )
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { kind: string }).kind).toBe('memory_not_editable')
  })

  /** Fix round 1, minor 4: the filters are in the URL, and the SERVER render is given them -- so a
   *  shared `?status=removed` link paints the withdrawn rows rather than the default ones and then
   *  replacing them a request later. */
  it('seeds the page’s first paint from the link it was opened with', async () => {
    await seedMemory({ title: 'A verified fact' })
    await seedMemory({ title: 'A withdrawn claim', status: 'removed', removedReason: 'wrong' })
    const element = await KnowledgePage({
      params: Promise.resolve({ workspaceId }),
      searchParams: Promise.resolve({ status: 'removed' }),
    })
    const props = (element as { props: { initial: { rows: { memory: { title: string } }[] } } }).props
    expect(props.initial.rows.map((row) => row.memory.title)).toEqual(['A withdrawn claim'])
  })

  it('answers the task drawer’s two lists, and 404s a task on another project', async () => {
    await seedMemory({ title: 'What this task taught' })
    const response = await taskMemoriesGET(new Request('http://x'), { params: await params({ taskId }) })
    expect(response.status).toBe(200)
    const view = (await response.json()) as { received: unknown[]; produced: unknown[] }
    expect(view.received).toEqual([])
    expect(view.produced).toHaveLength(1)

    const missing = await taskMemoriesGET(new Request('http://x'), {
      params: Promise.resolve({ workspaceId: otherWorkspaceId, taskId }),
    })
    expect(missing.status).toBe(404)
  })
})
