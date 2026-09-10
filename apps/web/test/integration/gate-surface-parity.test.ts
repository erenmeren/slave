import { prisma } from '@slave-of-ai/db/client'
import { listGoalVersions, loadSupervisorWorld, setGoal, workspaceSpend } from '@slave-of-ai/control'
import { summarise } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildGoalHistory } from '../../src/server/goal.js'
import { buildOverviewSnapshot } from '../../src/server/overview.js'
import { buildSupervisorView } from '../../src/server/supervisor.js'
import { buildTasksSnapshot } from '../../src/server/tasks.js'

/**
 * M41 ruling R6 / erratum E9: `scripts/gate-m41-scenario.mjs` asserts the operator's surfaces
 * WITHOUT importing them. It cannot import them -- `apps/web` compiles with `noEmit: true` under
 * a bundler resolver, so there is no built output for a plain `node` script to load -- and it does
 * not need a control helper of its own either, because every field it reads is already a control
 * or domain verb the builders themselves compose.
 *
 * That claim is only true while it stays true. These cases are the pin: each one asserts that a
 * builder's field IS the verb the gate reads instead of it. A builder that starts computing
 * something of its own fails here, and whoever changes it learns in the same commit that the gate
 * has stopped measuring the surface it says it measures.
 *
 * This file lives under `test/integration/` rather than beside the unit tests, because it reads
 * the real builders against a real database: the `unit` vitest project runs without
 * `test-setup/require-database.ts`, so `DATABASE_URL` is never pointed at the test database there
 * and every Prisma call in this file would reach for whatever the ambient environment happens to
 * name. The brief's own path put it one directory up; the mapping it pins is the same either way.
 */
describe('the gate reads the same facts the web builders publish', () => {
  let workspaceId: string

  beforeEach(async (): Promise<void> => {
    // `ExecutionEvent` carries `workspaceId` as a plain column with no relation on it (the append
    // path is deliberately FK-free), so the leftovers are cleared by id rather than through the
    // workspace -- and before it, because nothing cascades them.
    const stale = await prisma.workspace.findUnique({ where: { name: 'M41 Parity Project' }, select: { id: true } })
    if (stale !== null) {
      await prisma.executionEvent.deleteMany({ where: { workspaceId: stale.id } })
      await prisma.workspace.delete({ where: { id: stale.id } })
    }
    const workspace = await prisma.workspace.create({
      data: {
        name: 'M41 Parity Project',
        repoPath: '/tmp/m41-parity-does-not-need-to-exist',
        baseBranch: 'main',
        autoMerge: false,
        verifyCommands: ['true'],
        setupCommands: [],
        maxAttempts: 5,
      },
    })
    workspaceId = workspace.id
    const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
    await prisma.slave.create({
      data: { teamId: team.id, name: 'Dev', role: 'Senior Engineer', runtimeRoles: ['backend'] },
    })
    expect((await setGoal(workspaceId, 'Ship the thing')).ok).toBe(true)
    await prisma.task.create({
      data: { workspaceId, title: 'One', description: 'a task', status: 'ready', requiredRole: 'backend', maxAttempts: 5, goalVersion: 1 },
    })
  })

  it("the Supervisor view's report IS summarise() over loadSupervisorWorld()'s world", async (): Promise<void> => {
    const now = new Date()
    const view = await buildSupervisorView(workspaceId, now)
    const loaded = await loadSupervisorWorld(workspaceId, now)

    expect(view).not.toBeNull()
    expect(view?.report).toEqual(summarise(loaded.world))
    expect(view?.questions.length).toBe(loaded.world.questions.length)
  })

  it('the goal history IS listGoalVersions()', async (): Promise<void> => {
    const history = await buildGoalHistory(workspaceId)
    const versions = await listGoalVersions(workspaceId)

    expect(versions.ok).toBe(true)
    expect(history).toEqual(versions.ok ? versions.value : null)
  })

  it('the tasks snapshot publishes the Task and Workspace columns unchanged', async (): Promise<void> => {
    const snapshot = await buildTasksSnapshot(workspaceId)
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    const tasks = await prisma.task.findMany({ where: { workspaceId } })

    expect(snapshot?.workspace.goalVersion).toBe(workspace.goalVersion)
    expect(snapshot?.tasks.map((one) => [one.id, one.status, one.goalVersion, one.integratedAt])).toEqual(
      tasks.map((one) => [one.id, one.status, one.goalVersion, one.integratedAt === null ? null : one.integratedAt.toISOString()]),
    )
  })

  it("the overview's task counts are the board counted by status, and its spend IS workspaceSpend()", async (): Promise<void> => {
    const snapshot = await buildOverviewSnapshot(workspaceId)
    const tasks = await prisma.task.findMany({ where: { workspaceId } })
    const spend = await workspaceSpend(workspaceId)

    const countOf = (statuses: readonly string[]): number => tasks.filter((one) => statuses.includes(one.status)).length
    expect(snapshot?.tasks.ready).toBe(countOf(['ready']))
    expect(snapshot?.tasks.done).toBe(countOf(['done']))
    expect(snapshot?.tasks.failed).toBe(countOf(['failed']))
    expect(snapshot?.tasks.blocked).toBe(countOf(['blocked']))
    expect(snapshot?.workspace.spentUsd).toBe(spend.spentUsd)
  })
})
