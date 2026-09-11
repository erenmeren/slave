import { RUNBOOK_SEED } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addRunbook,
  adoptRunbook,
  listRunbooks,
  readRunbook,
  runbookForWorkspace,
  runbookStatus,
  syncRunbooks,
} from '../../src/runbook.js'

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
  await prisma.runbookTemplate.deleteMany({ where: { key: 'gate-hand-written' } })
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

  it('never touches a human row', async () => {
    await prisma.runbookTemplate.create({
      data: {
        key: 'gate-hand-written',
        name: 'Hand written',
        description: 'mine',
        stages: [
          { key: 'only', title: 'Only', objective: 'Do it', capabilities: [], dependsOn: [], expectedOutputs: [], gates: [], retry: null, escalation: null },
        ],
        source: 'human',
      },
    })
    await syncRunbooks()
    expect((await prisma.runbookTemplate.findUniqueOrThrow({ where: { key: 'gate-hand-written' } })).name).toBe('Hand written')
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

describe('runbookStatus', () => {
  it('reports the current stage and each stage state from the board', async () => {
    await adoptRunbook(workspaceId, 'feature-delivery')
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
    expect(status.value.stages.map((stage) => [stage.key, stage.state])).toEqual([
      ['design', 'done'],
      ['implement', 'active'],
      ['verify', 'missing'],
      ['review', 'missing'],
      ['release', 'missing'],
    ])
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
