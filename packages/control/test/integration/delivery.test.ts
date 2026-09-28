/**
 * Conductor Plan 2, Task 10: `setDelivery` (the CLI's `set-delivery`) and `conductorView` (the
 * CLI's `conductor` read) -- switching a workspace's delivery mode, and reading what the
 * conductor has decided and done for one goal version.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { conductorView, setDelivery } from '../../src/delivery.js'
import { truncateAll } from './helpers.js'

async function seedWorkspace(delivery: 'planned' | 'conducted' = 'planned'): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Report Modes',
      repoPath: '/tmp/conductor-view',
      verifyCommands: ['true'],
      setupCommands: [],
      delivery,
      ...(delivery === 'conducted' ? { goal: 'Add csv and json report modes', goalVersion: 1 } : {}),
    },
  })
  await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  return workspace.id
}

/** A conducted version with its requirements, its `conduct` decision, one package `main` (owning
 *  everything, staffed on one seat) and that package's pinned task -- the shape
 *  `apps/orchestrator/src/conductor.ts`'s `materialise` writes. No `ConductorCall` row for the
 *  requirements stage is added here on purpose, so the calls list can be checked with exactly one
 *  entry. */
async function seedConductedVersion(): Promise<string> {
  const workspaceId = await seedWorkspace('conducted')
  const team = await prisma.team.findFirstOrThrow({ where: { workspaceId } })

  await prisma.requirementSet.create({
    data: {
      workspaceId,
      goalVersion: 1,
      items: [{ key: 'R1', text: 'csv mode', source: 'add a csv mode' }],
    },
  })

  const subjectId = `${workspaceId}:v1`
  await prisma.supervisorDecision.create({
    data: {
      workspaceId,
      situationKind: 'conduct',
      subjectId,
      situation: { kind: 'conduct', subjectId, summary: 'v1: single, 1 package(s)', facts: {} },
      candidates: [{ action: { kind: 'conduct', goalVersion: 1, mode: 'single', packageKeys: ['main'] }, tier: 'applied', why: 'one package covers it' }],
      chosenIndex: 0,
      action: { kind: 'conduct', goalVersion: 1, mode: 'single', packageKeys: ['main'] },
      rationale: 'one package covers it',
      tier: 'applied',
      status: 'applied',
      decidedBy: 'model',
      modelCalled: true,
      modelCostUsd: 0.05,
    },
  })

  const seat = await prisma.slave.create({
    data: {
      teamId: team.id,
      role: 'Implementer',
      runtimeRoles: ['package_worker'],
      personId: (await prisma.person.create({ data: { name: 'Ivo' } })).id,
    },
  })

  const pkg = await prisma.workPackage.create({
    data: {
      workspaceId,
      goalVersion: 1,
      key: 'main',
      title: 'Report modes',
      requirementKeys: ['R1'],
      ownedPaths: ['**'],
      interface: '',
      isIntegration: true,
      templateId: 'tpl',
    },
  })
  await prisma.task.create({
    data: {
      workspaceId,
      title: 'Report modes',
      description: 'R1 csv mode',
      status: 'ready',
      requiredRole: 'package_worker',
      requiredCapabilities: [],
      createdBy: 'system',
      maxAttempts: 3,
      goalVersion: 1,
      assigneeId: seat.id,
      workPackageId: pkg.id,
    },
  })

  await prisma.conductorCall.create({
    data: { workspaceId, goalVersion: 1, stage: 'conduct', outcome: 'ok', modelCostUsd: 0.05 },
  })

  return workspaceId
}

beforeEach(async (): Promise<void> => {
  await truncateAll()
})

describe('setDelivery', () => {
  it('switches delivery and says whether it changed', async () => {
    const w = await seedWorkspace()
    expect(await setDelivery(w, 'conducted')).toEqual({ ok: true, value: { delivery: 'conducted', changed: true } })
    expect(await setDelivery(w, 'conducted')).toEqual({ ok: true, value: { delivery: 'conducted', changed: false } })
  })

  it('refuses an unknown workspace', async () => {
    expect((await setDelivery('nope', 'planned')).ok).toBe(false)
  })

  it('reports unchanged for planned -> planned, the delivery every workspace starts with', async () => {
    const w = await seedWorkspace()
    expect(await setDelivery(w, 'planned')).toEqual({ ok: true, value: { delivery: 'planned', changed: false } })
  })
})

describe('conductorView', () => {
  it('shows requirements, the decision, packages with seats and the conductor calls', async () => {
    const w = await seedConductedVersion()
    const view = await conductorView(w)
    expect(view.ok && view.value).toEqual(
      expect.objectContaining({
        goalVersion: 1,
        delivery: 'conducted',
        requirements: [expect.objectContaining({ key: 'R1' })],
        decision: expect.objectContaining({ mode: 'single' }),
        packages: [expect.objectContaining({ key: 'main', seat: expect.objectContaining({ name: expect.any(String) }), reported: false })],
      }),
    )
    expect(view.ok && view.value.calls).toEqual([
      expect.objectContaining({ stage: 'conduct', outcome: 'ok', modelCostUsd: 0.05 }),
    ])
  })

  it('names the seat holding the package, and the task it is pinned to', async () => {
    const w = await seedConductedVersion()
    const view = await conductorView(w)
    if (!view.ok) throw new Error('expected ok')
    const [pkg] = view.value.packages
    const task = await prisma.task.findFirstOrThrow({ where: { workspaceId: w } })
    expect(pkg?.seat?.name).toBe('Ivo')
    expect(pkg?.taskId).toBe(task.id)
    expect(pkg?.taskStatus).toBe('ready')
  })

  it('says a package is reported once its RunReport exists', async () => {
    const w = await seedConductedVersion()
    const task = await prisma.task.findFirstOrThrow({ where: { workspaceId: w } })
    const seat = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: w } } })
    const run = await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: seat.id, status: 'succeeded' } })
    await prisma.runReport.create({
      data: { runId: run.id, taskId: task.id, workPackageId: task.workPackageId ?? '', report: { requirements: [] } },
    })
    const view = await conductorView(w)
    expect(view.ok && view.value.packages[0]?.reported).toBe(true)
  })

  it('answers null requirements, null decision, no packages and no calls before the conductor has run', async () => {
    const w = await seedWorkspace('conducted')
    const view = await conductorView(w)
    expect(view.ok && view.value).toEqual({
      goalVersion: 1,
      delivery: 'conducted',
      requirements: null,
      decision: null,
      packages: [],
      calls: [],
    })
  })

  it('defaults to the workspace current version, and an explicit --version reads an older one', async () => {
    const w = await seedConductedVersion()
    await prisma.workspace.update({ where: { id: w }, data: { goalVersion: 2 } })
    const current = await conductorView(w)
    expect(current.ok && current.value.goalVersion).toBe(2)
    expect(current.ok && current.value.requirements).toBeNull()

    const older = await conductorView(w, 1)
    expect(older.ok && older.value.goalVersion).toBe(1)
    expect(older.ok && older.value.requirements).not.toBeNull()
  })

  it('refuses an unknown workspace', async () => {
    expect((await conductorView('nope')).ok).toBe(false)
  })
})
