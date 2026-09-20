import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  acceptIntake,
  openIntake,
  reconcileTemplateCapabilities,
  sendIntakeMessage,
  setInstallationSettings,
  syncCapabilityTaxonomy,
  syncPersonPool,
} from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  emptyProfileSpec,
  isGeneratedEnglishName,
  workspaceId as brandWorkspaceId,
  type IntakeDraft,
} from '@slave-of-ai/domain'
import { ClaudeCodeAdapter, type AdapterRegistry } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drainPumps, tick, type TickDeps } from '../../src/tick.js'

/**
 * Catalog Person Pool Task 6: the whole chain, once, against the real test Postgres and the fake
 * runtime -- managed pool identity and sync, conservative taxonomy reconciliation, intake staffing
 * from the pool onto functional departments, live staffed-role planning, and the first
 * implementation run -- proven end to end rather than one seam at a time.
 *
 * `m8-flow` is the same fake CLI mode `planning.test.ts` drives: a `"task graph"` prompt is
 * answered with the stock `plan-graph` fixture (three `backend` tasks, `core -> api -> polish`),
 * and every task role it names is among the roles the pool-staffed team carries -- which is the
 * point of step 7/8, that a plan written in the staffed vocabulary lands with no `unservedRoles`.
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

/** Every operational table this proof writes to, plus the `SlaveTemplate` catalogue it seeds itself
 *  -- `CASCADE` reaches the FK-dependent rows (RunContext, ProviderConfiguration, seats,
 *  departments) the list does not name. `Capability` is deliberately ABSENT: it is the checked-in
 *  taxonomy every integration file in this database SHARES and none may leave empty (see
 *  `fixtures/evidence.ts`), so this proof re-syncs it from `CAPABILITY_SEED` in step 1 rather than
 *  truncating it out from under the files that run next. */
const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "IntakeMessage", "Intake", "GoalVersion", "SupervisorDecision", ' +
  '"EvidenceRecord", "SlaveMessage", "Checkpoint", "RunContext", "SlaveRun", "TaskDependency", ' +
  '"Task", "Slave", "Person", "Team", "ProviderConfiguration", "Workspace", "InstallationSettings", ' +
  '"SlaveTemplate", "User" RESTART IDENTITY CASCADE'

/** A structured template whose `profileSpec.capabilities` are the taxonomy's own LABELS, so
 *  `reconcileTemplateCapabilities` genuinely resolves text through the live taxonomy into
 *  `capabilityKeys` rather than the test writing the keys itself. */
async function seedTemplate(input: {
  readonly name: string
  readonly role: string
  readonly division: string
  readonly capabilityLabels: readonly string[]
}): Promise<string> {
  const template = await prisma.slaveTemplate.create({
    data: {
      name: input.name,
      role: input.role,
      description: `${input.name} does one thing.`,
      active: true,
      sourceDivision: input.division,
      // Left EMPTY on purpose: reconciliation is what fills it, off the labels below, which is the
      // step-3 behaviour under proof.
      capabilityKeys: [],
      profileSpec: {
        ...emptyProfileSpec(),
        runtimeRole: input.role,
        capabilities: [...input.capabilityLabels],
      } as unknown as object,
    },
  })
  return template.id
}

const managedPeople = (templateId: string) =>
  prisma.person.findMany({ where: { templateId }, orderBy: { poolSlot: 'asc' } })

function depsFor(workspaceId: string): TickDeps {
  const adapter = new ClaudeCodeAdapter({
    command: 'node',
    extraArgs: [FAKE, '--fixture', 'm8-flow'],
    hookPath: REAL_GATE,
  })
  const registry: AdapterRegistry = { resolve: () => adapter }
  return { workspaceId: brandWorkspaceId(workspaceId), registry }
}

describe('Catalog Person Pool: end-to-end proof (Task 6)', () => {
  const tempDirs: string[] = []

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  afterEach(async (): Promise<void> => {
    // The pump outlives the tick by design; a pump still writing while the next test (or the
    // cleanup below) truncates is a cross-test failure that reads as a bug in whichever ran second.
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
    await prisma.$disconnect()
  })

  it(
    'syncs a managed pool, staffs a new project from it onto functional departments, and starts the first implementation run',
    async (): Promise<void> => {
      const reposRoot = await mkdtemp(join(tmpdir(), 'catalog-pool-flow-'))
      tempDirs.push(reposRoot)

      try {
        // --- Step 1: no operational rows, catalogue + capability seed retained/synced. -----------
        await syncCapabilityTaxonomy()
        await setInstallationSettings({ reposRoot })
        expect(await prisma.workspace.count()).toBe(0)
        expect(await prisma.person.count()).toBe(0)
        expect(await prisma.slave.count()).toBe(0)
        expect(await prisma.task.count()).toBe(0)
        expect(await prisma.slaveRun.count()).toBe(0)
        expect(await prisma.intake.count()).toBe(0)
        expect(await prisma.capability.count()).toBeGreaterThan(0)

        // --- Step 2: two active templates with structured capabilities. --------------------------
        const backendId = await seedTemplate({
          name: 'Backend Specialist',
          role: 'backend',
          division: 'engineering',
          capabilityLabels: ['Service implementation', 'API design'],
        })
        const designId = await seedTemplate({
          name: 'Visual Designer',
          role: 'design',
          division: 'design',
          capabilityLabels: ['Visual design', 'Interaction design'],
        })

        // --- Step 3: taxonomy reconciliation (which finishes with a pool sync). -------------------
        const reconcile = await reconcileTemplateCapabilities()
        expect(reconcile.templates).toBe(2)
        // The labels resolved through the LIVE taxonomy into keys on both templates.
        expect([...(await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: backendId } })).capabilityKeys].sort()).toEqual(
          ['backend.api-design', 'backend.services'],
        )
        expect([...(await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: designId } })).capabilityKeys].sort()).toEqual(
          ['design.interaction', 'design.visual'],
        )
        // `reconcileTemplateCapabilities` runs `syncPersonPool` last, so the pool already exists;
        // a second sync is a no-op, which is the idempotence step 4 then reads.
        expect(await syncPersonPool()).toMatchObject({ created: 0 })

        // --- Step 4: exactly three managed people per template, slots 1-3, unique English names,
        //             and nobody unmanaged. -----------------------------------------------------
        for (const templateId of [backendId, designId]) {
          const pool = await managedPeople(templateId)
          expect(pool).toHaveLength(3)
          expect(pool.map((person) => person.poolSlot)).toEqual([1, 2, 3])
        }
        const allPeople = await prisma.person.findMany()
        expect(allPeople).toHaveLength(6)
        // No unmanaged person exists at all -- every row was minted by the pool sync.
        expect(allPeople.every((person) => person.poolSlot !== null)).toBe(true)
        const names = allPeople.map((person) => person.name)
        expect(new Set(names).size).toBe(6)
        for (const name of names) expect(isGeneratedEnglishName(name)).toBe(true)
        const peopleBeforeIntake = allPeople.length

        // --- Step 5: a NEW-repository intake draft selecting both templates, spanning two
        //             functional departments (Engineering + Design). --------------------------
        const intake = await openIntake()
        expect(intake.ok).toBe(true)
        if (!intake.ok) throw new Error('openIntake refused')
        await sendIntakeMessage(intake.value.id, 'I have an idea and no repository yet')

        const draft: IntakeDraft = {
          name: 'Catalog Pool Flow',
          goal: 'Build the thing the catalogue can staff',
          repo: { mode: 'new', path: null },
          baseBranch: 'main',
          verifyCommands: [{ command: 'true', source: 'draft' }],
          setupCommands: [],
          budgetUsd: null,
          provider: 'claude_code',
          autoMerge: true,
          autonomy: 'act',
          team: [
            { templateId: backendId, runtimeRoles: ['backend'] },
            { templateId: designId, runtimeRoles: ['design'] },
          ],
        }
        const accepted = await acceptIntake(intake.value.id, draft)
        expect(accepted.ok).toBe(true)
        if (!accepted.ok) throw new Error('acceptIntake refused')
        const workspaceId = accepted.value.workspaceId

        // --- Step 6: acceptance created zero new Person rows, only the expected functional
        //             departments, and seated managed ids from the pool. ---------------------
        expect(await prisma.person.count()).toBe(peopleBeforeIntake)
        expect((await prisma.person.findMany()).every((person) => person.poolSlot !== null)).toBe(true)

        const teams = await prisma.team.findMany({
          where: { workspaceId },
          include: { slaves: { where: { closedAt: null } } },
        })
        expect(teams.map((team) => team.name).sort()).toEqual(['Design', 'Engineering'])
        // No catch-all department named after the project.
        expect(teams.some((team) => team.name === 'Catalog Pool Flow')).toBe(false)

        const seatedPersonIds = teams.flatMap((team) => team.slaves.map((seat) => seat.personId))
        expect(seatedPersonIds).toHaveLength(2)
        const seated = await prisma.person.findMany({ where: { id: { in: seatedPersonIds } } })
        expect(seated.every((person) => person.poolSlot !== null)).toBe(true)
        // The engineering seat carries the plan's vocabulary plus the manager/reviewer roles
        // `ensureStaffRoles` guarantees, so planning has a manager and review has a reviewer.
        const engineering = teams.find((team) => team.name === 'Engineering')
        expect(engineering?.slaves[0]?.runtimeRoles).toEqual(['backend', 'manager', 'reviewer'])

        // --- Step 7: planning through the normal orchestrator path (the tick dispatches it). ------
        const deps = depsFor(workspaceId)
        const planningTick = await tick(deps)
        expect(planningTick.planningStarted).not.toBeNull()
        await drainPumps()

        // The plan-graph fixture's three `backend` tasks landed on the board.
        const tasks = await prisma.task.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })
        expect(tasks).toHaveLength(3)
        expect(tasks.every((task) => task.requiredRole === 'backend')).toBe(true)

        // --- Step 8 + 9: the board carries no unserved role, and the next tick starts an
        //                 implementation run for the first ready task. -----------------------
        const implTick = await tick(deps)
        expect(implTick.unservedRoles).toEqual([])
        expect(implTick.started).toHaveLength(1)

        const core = await prisma.task.findFirstOrThrow({
          where: { workspaceId, title: 'Write the feature core' },
        })
        const run = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'implementation' } })
        expect(run.taskId).toBe(core.id)
        expect(['starting', 'working']).toContain(run.status)

        // The whole flow minted nobody new: the six managed people are still the only people, and
        // the two seats belong to two of them.
        expect(await prisma.person.count()).toBe(6)
      } finally {
        // Step 10: clean every test-owned row and file. Drain first so no pump writes into a table
        // this is about to truncate; the temp repositories root (and the worktrees under it) is
        // removed in afterAll. The real Maratus workspace/repo is never named here.
        await drainPumps()
        await prisma.$executeRawUnsafe(TRUNCATE)
      }
    },
    60_000,
  )
})
