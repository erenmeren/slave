import { RUNBOOK_SEED } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Situation } from '@slave-of-ai/domain'
import {
  addRunbook,
  adoptRunbook,
  listRunbooks,
  readRunbook,
  runbookForWorkspace,
  runbookStatus,
  syncRunbooks,
} from '../../src/runbook.js'
import { recordDecision } from '../../src/supervisor.js'

const WORKSPACE = 'M48 Runbook Control'
let workspaceId = ''

beforeAll(async () => {
  await syncRunbooks()
  const workspace = await prisma.workspace.create({
    data: { name: WORKSPACE, repoPath: '/tmp/m48', verifyCommands: ['true'], setupCommands: [], goal: 'Ship the endpoint' },
  })
  workspaceId = workspace.id
})

afterAll(async () => {
  await prisma.task.deleteMany({ where: { workspaceId } })
  await prisma.executionEvent.deleteMany({ where: { workspaceId } })
  await prisma.workspace.deleteMany({ where: { id: workspaceId } })
  await prisma.runbookTemplate.deleteMany({ where: { key: { startsWith: 'gate-' } } })
  await prisma.$disconnect()
})

describe('syncRunbooks', () => {
  it('is idempotent: a second run creates nothing and changes nothing', async () => {
    const again = await syncRunbooks()
    expect(again).toEqual({ created: 0, updated: 0 })
  })

  it('brings a seed row that was edited back to the checked-in list', async () => {
    await prisma.runbookTemplate.update({ where: { key: 'bug-fix' }, data: { name: 'Something else' } })
    expect(await syncRunbooks()).toEqual({ created: 0, updated: 1 })
    const row = await prisma.runbookTemplate.findUniqueOrThrow({ where: { key: 'bug-fix' } })
    expect(row.name).toBe('Bug fix')
  })

  // On a SEED key, which is the only way the `existing.source !== 'seed'` guard is reached at all:
  // a row under a key the checked-in list does not hold is never visited by the loop.
  it('never touches a human row that holds a seed key', async () => {
    await prisma.runbookTemplate.update({ where: { key: 'bug-fix' }, data: { source: 'human', name: 'Mine' } })

    expect(await syncRunbooks()).toEqual({ created: 0, updated: 0 })

    const row = await prisma.runbookTemplate.findUniqueOrThrow({ where: { key: 'bug-fix' } })
    expect(row.name).toBe('Mine')
    expect(row.source).toBe('human')

    // Handed back, so every case below reads the seeded table the file's first line established.
    await prisma.runbookTemplate.update({ where: { key: 'bug-fix' }, data: { source: 'seed' } })
    expect(await syncRunbooks()).toEqual({ created: 0, updated: 1 })
  })
})

describe('listRunbooks / readRunbook', () => {
  // The brief compared `rows.slice(0, RUNBOOK_SEED.length)` with the sorted seed keys, which the
  // `gate-hand-written` row the describe above leaves standing (and a persona runbook another file
  // wrote) falls into the middle of. What the verb actually promises is the ORDER -- key ascending
  // over whatever the table holds -- and that every seed key is in it.
  it('lists key ascending and carries how many projects use each', async () => {
    const rows = await listRunbooks()
    const keys = rows.map((row) => row.key)
    expect(keys).toEqual(keys.toSorted())
    expect(rows.filter((row) => row.source === 'seed').map((row) => row.key)).toEqual(
      RUNBOOK_SEED.map((runbook) => runbook.key).toSorted(),
    )
    expect(rows.every((row) => typeof row.workspaceCount === 'number')).toBe(true)
  })

  // Fix round 1, Minor 4: one coercion for both readers of a stored `source`.
  it('reads a source nothing recognises as human, never as the word on the row', async () => {
    await prisma.runbookTemplate.update({ where: { key: 'security-review' }, data: { source: 'imported' } })
    const result = await readRunbook('security-review')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.source).toBe('human')
    await prisma.runbookTemplate.update({ where: { key: 'security-review' }, data: { source: 'seed' } })
  })

  it('refuses a key nobody has, by name', async () => {
    const result = await readRunbook('nope')
    expect(result).toEqual({ ok: false, error: { kind: 'runbook_not_found', key: 'nope' } })
  })
})

describe('addRunbook', () => {
  it('refuses a stage list the spec rejects, quoting the structural reason', async () => {
    const result = await addRunbook({ key: 'gate-bad', name: 'Bad', description: 'x', stages: [{ key: 'a', title: 'A', objective: 'a', dependsOn: ['b'] }] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_runbook')
  })

  // Fix round 1, Minor 5: the pre-check is a read followed by an insert, and nothing serialises the
  // pair -- two operators adding the same key at once both read "free". Whichever way the two runs
  // interleave, exactly one row is written and the other caller gets the refusal rather than a
  // thrown P2002: the pre-check catches the serialised order, the `catch` catches the raced one.
  it('refuses a duplicate key rather than throwing, however the two adds interleave', async () => {
    const draft = { key: 'gate-raced', name: 'Raced', description: 'x', stages: [{ key: 'a', title: 'A', objective: 'a' }] }
    const [first, second] = await Promise.all([addRunbook(draft), addRunbook(draft)])

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1)
    const refused = first.ok ? second : first
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error.kind).toBe('invalid_runbook')
    expect(await prisma.runbookTemplate.count({ where: { key: 'gate-raced' } })).toBe(1)
    await prisma.runbookTemplate.deleteMany({ where: { key: 'gate-raced' } })
  })

  it('forces source to human, so a hand-written runbook can never be rewritten by a sync', async () => {
    const result = await addRunbook({ key: 'gate-hand-written-2', name: 'Mine', description: 'x', stages: [{ key: 'a', title: 'A', objective: 'a' }], source: 'seed' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.source).toBe('human')
    await prisma.runbookTemplate.deleteMany({ where: { key: 'gate-hand-written-2' } })
  })
})

describe('adoptRunbook', () => {
  it('sets the column and appends the fiftieth event type', async () => {
    const result = await adoptRunbook(workspaceId, 'feature-delivery')
    expect(result.ok).toBe(true)
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, include: { runbook: true } })
    expect(workspace.runbook?.key).toBe('feature-delivery')
    const events = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'workspace_runbook_adopted' } })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ key: 'feature-delivery', name: 'Feature delivery' })
  })

  it('is the one read the orchestrator makes, as the domain shape', async () => {
    const runbook = await runbookForWorkspace(workspaceId)
    expect(runbook?.key).toBe('feature-delivery')
    expect(runbook?.stages.map((stage) => stage.key)).toEqual(['design', 'implement', 'verify', 'review', 'release'])
    expect(await runbookForWorkspace('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('refuses an unknown key and leaves the adopted one standing', async () => {
    expect(await adoptRunbook(workspaceId, 'nope')).toEqual({ ok: false, error: { kind: 'runbook_not_found', key: 'nope' } })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).runbookId).not.toBeNull()
  })

  // Plan erratum E9: a clear has no runbook of its own to name, so it names the one it removed.
  it('clears with null, naming the runbook it removed, and writes nothing when there was none', async () => {
    const cleared = await adoptRunbook(workspaceId, null)
    expect(cleared.ok).toBe(true)
    if (!cleared.ok) return
    expect(cleared.value).toMatchObject({ cleared: true, changed: true })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).runbookId).toBeNull()
    const events = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'workspace_runbook_adopted' }, orderBy: { seq: 'asc' } })
    expect(events).toHaveLength(2)
    expect(events[1]?.payload).toMatchObject({ key: 'feature-delivery', cleared: true })

    const again = await adoptRunbook(workspaceId, null)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.changed).toBe(false)
    expect(await prisma.executionEvent.count({ where: { workspaceId, type: 'workspace_runbook_adopted' } })).toBe(2)
  })

  it('writes nothing when the project already follows the runbook asked for', async () => {
    expect((await adoptRunbook(workspaceId, 'bug-fix')).ok).toBe(true)
    const before = await prisma.executionEvent.count({ where: { workspaceId, type: 'workspace_runbook_adopted' } })
    const again = await adoptRunbook(workspaceId, 'bug-fix')
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value).toMatchObject({ cleared: false, changed: false })
    expect(await prisma.executionEvent.count({ where: { workspaceId, type: 'workspace_runbook_adopted' } })).toBe(before)
  })

  it('refuses a project nobody has', async () => {
    expect(await adoptRunbook('00000000-0000-0000-0000-000000000000', 'bug-fix')).toEqual({
      ok: false,
      error: { kind: 'workspace_not_found', workspaceId: '00000000-0000-0000-0000-000000000000' },
    })
  })
})

// M48 final wave, Task 4 ruling: a by-hand adoption ANSWERS the Supervisor's pending recommendation.
describe('adoptRunbook and the pending recommendation', () => {
  const situation = (): Situation => ({
    kind: 'runbook_recommended',
    subjectId: workspaceId,
    summary: 'A way of working to adopt',
    facts: { runbook: 'feature-delivery' },
  })

  /** The proposal `observe`/`candidates` produce for this project, recorded the way a tick does. */
  const propose = async (): Promise<string> => {
    const recorded = await recordDecision({
      workspaceId,
      situation: situation(),
      candidates: [
        {
          action: {
            kind: 'adopt_runbook',
            runbookId: (await prisma.runbookTemplate.findUniqueOrThrow({ where: { key: 'feature-delivery' } })).id,
            key: 'feature-delivery',
            name: 'Feature delivery',
            rationale: 'The goal says "ship".',
          },
          tier: 'proposed',
          why: 'The goal says "ship".',
        },
      ],
      chosenIndex: 0,
      rationale: 'The goal says "ship".',
      decidedBy: 'rules',
      modelCostUsd: null,
    })
    if (!recorded.ok) throw new Error(`recordDecision refused: ${recorded.error.kind}`)
    expect(recorded.value.status).toBe('pending')
    return recorded.value.id
  }

  beforeEach(async () => {
    // The decisions AND the events about them: this file shares one project across its blocks, and
    // each case below counts `supervisor.resolved` rows rather than diffing a running total.
    await prisma.supervisorDecision.deleteMany({ where: { workspaceId } })
    await prisma.executionEvent.deleteMany({ where: { workspaceId, type: 'supervisor_resolved' } })
    await adoptRunbook(workspaceId, null)
  })

  it('resolves the waiting proposal when a person adopts a DIFFERENT runbook by hand', async () => {
    const decisionId = await propose()
    expect((await adoptRunbook(workspaceId, 'bug-fix', { origin: 'human' })).ok).toBe(true)

    const row = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: decisionId } })
    expect(row.status).toBe('rejected')
    expect(row.resolvedAt).not.toBeNull()
    const resolved = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'supervisor_resolved' } })
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.actor).toBe('human')
    expect(resolved[0]?.payload).toMatchObject({ decisionId, outcome: 'rejected' })
    expect(String((resolved[0]?.payload as { reason: string }).reason)).toContain('adopted by hand')
  })

  it('resolves it on a CLEAR too -- "no runbook" is an answer to "which runbook"', async () => {
    await adoptRunbook(workspaceId, 'bug-fix', { origin: 'human' })
    await prisma.supervisorDecision.deleteMany({ where: { workspaceId } })
    const decisionId = await propose()

    expect((await adoptRunbook(workspaceId, null, { origin: 'human' })).ok).toBe(true)
    const row = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: decisionId } })
    expect(row.status).toBe('rejected')
    const resolved = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'supervisor_resolved' } })
    expect(resolved).toHaveLength(1)
    expect(String((resolved[0]?.payload as { reason: string }).reason)).toContain('cleared by hand')
  })

  it('leaves the proposal alone when the TICK carries one out -- that row was claimed already', async () => {
    const decisionId = await propose()
    // `origin: 'system'` is `applyDecision` acting on a decision a human approved: the claim
    // happened in `approveDecision`, and a second resolution here would be a second path over rows
    // somebody else owns.
    expect((await adoptRunbook(workspaceId, 'feature-delivery', { origin: 'system' })).ok).toBe(true)
    expect((await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: decisionId } })).status).toBe('pending')
    expect(await prisma.executionEvent.count({ where: { workspaceId, type: 'supervisor_resolved' } })).toBe(0)
  })
})

describe('runbookStatus', () => {
  /** The stage ladder, as the panel reads it: key then state, in `stageOrder`. */
  const ladder = async (): Promise<readonly (readonly [string, string])[]> => {
    const status = await runbookStatus(workspaceId)
    if (!status.ok) throw new Error('runbookStatus refused a project it was given')
    return status.value.stages.map((stage) => [stage.key, stage.state] as const)
  }

  beforeEach(async () => {
    await prisma.task.deleteMany({ where: { workspaceId } })
    await adoptRunbook(workspaceId, 'feature-delivery')
  })

  it('reports the current stage and each stage state from the board', async () => {
    await prisma.task.createMany({
      data: [
        { workspaceId, title: 'A', description: 'a', status: 'done', maxAttempts: 3, stage: 'design' },
        { workspaceId, title: 'B', description: 'b', status: 'running', maxAttempts: 3, stage: 'implement' },
      ],
    })
    const status = await runbookStatus(workspaceId)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.value.currentStage).toBe('implement')
    expect(status.value.stagesMissing).toEqual(['verify', 'review', 'release'])
    // Fix round 1, Important 1: a stage AFTER the current one with no tasks has not been SKIPPED --
    // it has not been reached. `missing` is reserved for a stage the plan went past.
    expect(status.value.stages.map((stage) => [stage.key, stage.state])).toEqual([
      ['design', 'done'],
      ['implement', 'active'],
      ['verify', 'pending'],
      ['review', 'pending'],
      ['release', 'pending'],
    ])
  })

  // Fix round 1, Important 1(a): the state a project is in the moment somebody adopts a runbook.
  // The old ladder called the current stage `missing`, so "current stage: Design" sat above a table
  // saying design had been skipped.
  it('calls the current stage active on an empty board, and the rest pending', async () => {
    expect(await ladder()).toEqual([
      ['design', 'active'],
      ['implement', 'pending'],
      ['verify', 'pending'],
      ['review', 'pending'],
      ['release', 'pending'],
    ])
    const status = await runbookStatus(workspaceId)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.value.currentStage).toBe('design')
    expect(status.value.stages.every((stage) => stage.taskCount === 0)).toBe(true)
  })

  // Fix round 1, Important 1(b): with every staged task terminal the current stage is the LAST one
  // (`measureAdherence`'s E7 rule), and the old ladder then said current = Release AND Release
  // missing in the same breath.
  //
  // M48 final review, Minor 2: nor is it `active`. Nothing is running and nothing will be -- the
  // work is over -- so every stage is judged by its own task count, and a release stage no task
  // ever carried reads `missing`, which is what `stagesMissing` says about it one field away.
  it('with every staged task terminal, no stage is active and the skipped ones are missing', async () => {
    await prisma.task.create({
      data: { workspaceId, title: 'A', description: 'a', status: 'done', maxAttempts: 3, stage: 'design' },
    })
    const status = await runbookStatus(workspaceId)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.value.currentStage).toBe('release')
    expect(status.value.stagesMissing).toContain('release')
    expect(status.value.stages.map((stage) => [stage.key, stage.state])).toEqual([
      ['design', 'done'],
      ['implement', 'missing'],
      ['verify', 'missing'],
      ['review', 'missing'],
      ['release', 'missing'],
    ])
  })

  // The case Minor 2 is actually about: a project that ran its runbook to the end. The last stage
  // HAS work in it and every bit of that work is finished, so the word beside it is `done`.
  it('calls the finished last stage done, never happening-now, when work reached it', async () => {
    await prisma.task.createMany({
      data: [
        { workspaceId, title: 'A', description: 'a', status: 'done', maxAttempts: 3, stage: 'design' },
        { workspaceId, title: 'B', description: 'b', status: 'done', maxAttempts: 3, stage: 'release' },
      ],
    })
    const status = await runbookStatus(workspaceId)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.value.currentStage).toBe('release')
    expect(status.value.stages.map((stage) => [stage.key, stage.state])).toEqual([
      ['design', 'done'],
      ['implement', 'missing'],
      ['verify', 'missing'],
      ['review', 'missing'],
      ['release', 'done'],
    ])
  })

  // And the other side of the same rule: one live task anywhere and the ladder is back to a team
  // standing on a stage.
  it('still calls the stage with live work active', async () => {
    await prisma.task.createMany({
      data: [
        { workspaceId, title: 'A', description: 'a', status: 'done', maxAttempts: 3, stage: 'design' },
        { workspaceId, title: 'B', description: 'b', status: 'ready', maxAttempts: 3, stage: 'release' },
      ],
    })
    expect(await ladder()).toEqual([
      ['design', 'done'],
      ['implement', 'missing'],
      ['verify', 'missing'],
      ['review', 'missing'],
      ['release', 'active'],
    ])
  })

  // Fix round 1, Important 1(c): a task stamped with a stage this runbook has no key for is a fact
  // about the board, reported beside the ladder rather than dropped or crashed on.
  it('reports a stage the runbook has no key for, mid-flight', async () => {
    await prisma.task.createMany({
      data: [
        { workspaceId, title: 'A', description: 'a', status: 'done', maxAttempts: 3, stage: 'design' },
        { workspaceId, title: 'B', description: 'b', status: 'running', maxAttempts: 3, stage: 'implement' },
        { workspaceId, title: 'C', description: 'c', status: 'ready', maxAttempts: 3, stage: 'shipit' },
        { workspaceId, title: 'D', description: 'd', status: 'ready', maxAttempts: 3 },
      ],
    })
    const status = await runbookStatus(workspaceId)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.value.unknownStages).toEqual(['shipit'])
    expect(status.value.currentStage).toBe('implement')
    expect(status.value.stages.map((stage) => [stage.key, stage.state])).toEqual([
      ['design', 'done'],
      ['implement', 'active'],
      ['verify', 'pending'],
      ['review', 'pending'],
      ['release', 'pending'],
    ])
    // An unknown stage is never a row of the ladder: the ladder is the runbook's own stages.
    expect(status.value.stages.map((stage) => stage.key)).not.toContain('shipit')
  })

  it('is empty rather than a refusal for a project that has adopted nothing', async () => {
    await adoptRunbook(workspaceId, null)
    const status = await runbookStatus(workspaceId)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.value).toEqual({
      runbook: null,
      currentStage: null,
      stagesCovered: [],
      stagesMissing: [],
      unknownStages: [],
      stages: [],
    })
  })
})
