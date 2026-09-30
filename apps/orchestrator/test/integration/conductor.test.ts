import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clearHalt,
  setGoal,
  syncCapabilityTaxonomy,
  syncPersonPool,
  workspaceSpend,
  type ModelDecider,
  type ModelOutcome,
} from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  CONDUCT_CALL_TIMEOUT_MS,
  CONDUCT_PER_CALL_CAP_USD,
  CONDUCT_RETRY_CAP,
  PACKAGE_WORKER_ROLE,
  RUN_REQUIREMENT_TEXT,
  SKELETON_INTERFACE,
  VERIFIER_ROLE,
  integrationBranchName,
  workspaceId as brandWorkspaceId,
} from '@slave-of-ai/domain'
import { ClaudeCodeAdapter, type AdapterRegistry } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { conduct } from '../../src/conductor.js'
import { dispatchPlanning } from '../../src/planning.js'
import { drainPumps, type TickDeps } from '../../src/tick.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

const repos: string[] = []

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A real repository, `planning.test.ts`'s: a planner dispatched by mistake would run in it. */
function makeRepo(files: readonly string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-conductor-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  for (const file of files) {
    mkdirSync(join(dir, dirname(file)), { recursive: true })
    writeFileSync(join(dir, file), 'def main():\n    pass\n')
  }
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  repos.push(dir)
  return dir
}

interface Fixture {
  readonly workspaceId: string
}

/**
 * `supervisor.test.ts`'s seed, cut to what the conductor reads: a workspace with a real repo, its
 * delivery, a goal set through `setGoal` (so a `GoalVersion` row and `goalVersion = 1` exist) and a
 * runtime. `withManager` adds a seat that `dispatchPlanning` would otherwise plan with.
 */
async function seed(options: {
  readonly delivery: 'conducted' | 'planned'
  readonly goal: string
  readonly withManager?: boolean
  readonly files?: readonly string[]
}): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: `Checkout ${String(Math.random()).slice(2)}`,
      repoPath: makeRepo(options.files),
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [],
      delivery: options.delivery,
    },
  })
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  if (options.withManager === true) {
    const person = await prisma.person.create({ data: { name: 'Atlas' } })
    await prisma.slave.create({ data: { teamId: team.id, role: 'Engineering Lead', runtimeRoles: ['manager'], personId: person.id } })
  }
  const goal = await setGoal(workspace.id, options.goal)
  if (!goal.ok) throw new Error('the fixture goal was refused')
  return { workspaceId: workspace.id }
}

function depsFor(fixture: Fixture, decider: ModelDecider | undefined): TickDeps {
  const registry: AdapterRegistry = {
    resolve: () => new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'm8-flow'], hookPath: REAL_GATE }),
  }
  return {
    workspaceId: brandWorkspaceId(fixture.workspaceId),
    registry,
    ...(decider === undefined ? {} : { supervisorDecider: decider, supervisorModel: 'claude-sonnet-5' }),
  }
}

const REQUIREMENTS = JSON.stringify({
  requirementsAnswer: [
    { text: 'hsql --format csv prints CSV', source: 'Add a CSV mode.' },
    { text: 'hsql --format json prints JSON', source: 'Add a JSON mode.' },
  ],
})

function scripted(answers: Record<'requirements' | 'conduct', () => ModelOutcome>): { decider: ModelDecider; prompts: string[] } {
  const prompts: string[] = []
  const decider: ModelDecider = async (input) => {
    prompts.push(input.prompt)
    return input.prompt.includes('"requirementsAnswer"') ? answers.requirements() : answers.conduct()
  }
  return { decider, prompts }
}
const answer = (text: string, costUsd: number | null = 0.02): ModelOutcome => ({ kind: 'answer', text, costUsd, tokens: null, numTurns: 1 })
const failed = (reason: string): ModelOutcome => ({ kind: 'failed', reason, costUsd: null, tokens: null })

/**
 * The templates this file makes, removed by id: a TRUNCATE of "SlaveTemplate" CASCADE would also
 * empty every table that references it (runbooks, hints, skills) under other files' feet, and
 * leftover templates change what other files' supervisors and pools see.
 */
async function removeTemplates(): Promise<void> {
  const ids = ['t-backend', 't-docs']
  // Their pool people first: a pooled person cannot outlive its template (poolSlot needs templateId).
  await prisma.person.deleteMany({ where: { templateId: { in: ids } } })
  await prisma.slaveTemplate.deleteMany({ where: { id: { in: ids } } })
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "ConductorCall", "RequirementSet", "WorkPackage", "RunReport", "SupervisorDecision", "GoalDecision", "GoalDelivery", "PackageHandOff", "SlaveMessage", "SlaveRun", "TaskDependency", "Task", "GoalVersion", "ProviderConfiguration", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
  await removeTemplates()
})

afterEach(async (): Promise<void> => {
  await drainPumps()
})

afterAll(async (): Promise<void> => {
  await removeTemplates()
  for (const repo of repos) rmSync(repo, { recursive: true, force: true })
  await prisma.$disconnect()
})

describe('conduct: the model call', () => {
  it('gives every conductor call the conductor\'s own timeout, not the two-minute default', async () => {
    const f = await seed({ delivery: 'conducted', goal: 'Add a CSV mode. Add a JSON mode.' })
    const timeouts: (number | undefined)[] = []
    const decider: ModelDecider = async (input) => {
      timeouts.push(input.timeoutMs)
      return input.prompt.includes('"requirementsAnswer"') ? answer(REQUIREMENTS) : failed('not now')
    }
    await conduct(depsFor(f, decider))
    await conduct(depsFor(f, decider))
    expect(timeouts).toEqual([CONDUCT_CALL_TIMEOUT_MS, CONDUCT_CALL_TIMEOUT_MS])
    expect(CONDUCT_CALL_TIMEOUT_MS).toBeGreaterThan(120_000)
  })
})

describe('conduct: requirements', () => {
  it('extracts a keyed requirement set for the goal version, logs the call, emits the event', async () => {
    const f = await seed({ delivery: 'conducted', goal: 'Add a CSV mode. Add a JSON mode.' })
    const { decider } = scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => failed('not yet') })
    expect(await conduct(depsFor(f, decider))).toBe('requirements_set')
    const set = await prisma.requirementSet.findUniqueOrThrow({
      where: { workspaceId_goalVersion: { workspaceId: f.workspaceId, goalVersion: 1 } },
    })
    expect((set.items as { key: string }[]).map((i) => i.key)).toEqual(['R1', 'R2', 'RUN'])
    expect((set.items as { key: string; source: string }[]).at(-1)?.source).toBe('added by Slave: a verified version must run')
    const calls = await prisma.conductorCall.findMany({ where: { workspaceId: f.workspaceId } })
    expect(calls).toEqual([expect.objectContaining({ stage: 'requirements', outcome: 'ok', modelCostUsd: 0.02 })])
    const events = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_requirements_set' } })
    expect(events).toHaveLength(1)
  })

  it('does nothing for a planned workspace, and dispatchPlanning does nothing for a conducted one', async () => {
    const planned = await seed({ delivery: 'planned', goal: 'x' })
    expect(
      await conduct(depsFor(planned, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => failed('') }).decider)),
    ).toBe('none')
    const conducted = await seed({ delivery: 'conducted', goal: 'x', withManager: true })
    expect(await dispatchPlanning(depsFor(conducted, undefined))).toBeNull()
  })

  it('logs a failed call with its reason and halts after CONDUCT_RETRY_CAP failures', async () => {
    const f = await seed({ delivery: 'conducted', goal: 'x' })
    const { decider } = scripted({ requirements: () => answer('no json'), conduct: () => failed('') })
    for (let i = 0; i < CONDUCT_RETRY_CAP; i += 1) expect(await conduct(depsFor(f, decider))).toBe('requirements_failed')
    expect(await conduct(depsFor(f, decider))).toBe('halted')
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })
    expect(workspace.haltedReason).toContain('requirements')
    const calls = await prisma.conductorCall.findMany({ where: { workspaceId: f.workspaceId, outcome: 'failed' } })
    expect(calls).toHaveLength(CONDUCT_RETRY_CAP)
    expect(calls[0]?.reason).toContain('JSON')
  })

  /** Final review I2: only failures since the halt was last cleared count, or clearing does nothing. */
  it('makes a new call after the halt is cleared, and says how to recover in the halt', async () => {
    const f = await seed({ delivery: 'conducted', goal: 'x' })
    const { decider, prompts } = scripted({ requirements: () => answer('no json'), conduct: () => failed('') })
    for (let i = 0; i < CONDUCT_RETRY_CAP; i += 1) await conduct(depsFor(f, decider))
    expect(await conduct(depsFor(f, decider))).toBe('halted')
    const halted = await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })
    expect(halted.haltedReason).toContain(`clear-halt --workspace ${f.workspaceId}`)
    expect((await clearHalt(f.workspaceId)).ok).toBe(true)
    expect(await conduct(depsFor(f, decider))).toBe('requirements_failed')
    expect(prompts).toHaveLength(CONDUCT_RETRY_CAP + 1)
  })

  /** Final review M1 (Ruling 7): a decider that throws was a call made and never priced. */
  it('logs a throwing call as failed and unmeasured, and counts it toward the cap', async () => {
    const f = await seed({ delivery: 'conducted', goal: 'x' })
    const decider: ModelDecider = async () => {
      throw new Error('the socket closed')
    }
    for (let i = 0; i < CONDUCT_RETRY_CAP; i += 1) expect(await conduct(depsFor(f, decider))).toBe('requirements_failed')
    const calls = await prisma.conductorCall.findMany({ where: { workspaceId: f.workspaceId } })
    expect(calls).toHaveLength(CONDUCT_RETRY_CAP)
    for (const call of calls) {
      expect(call).toEqual(expect.objectContaining({ stage: 'requirements', outcome: 'failed', unmeasured: true, modelCostUsd: null }))
      expect(call.reason).toContain('the model call threw: the socket closed')
    }
    expect(await conduct(depsFor(f, decider))).toBe('halted')
  })

  it('keeps keys across goal versions', async () => {
    const f = await seed({ delivery: 'conducted', goal: 'Add a CSV mode. Add a JSON mode.' })
    await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => failed('') }).decider))
    await setGoal(f.workspaceId, 'Add a JSON mode. Add an HTML mode.')
    const v2 = JSON.stringify({
      requirementsAnswer: [
        { text: 'hsql --format json prints JSON', source: 'JSON' },
        { text: 'hsql --format html prints HTML', source: 'HTML' },
      ],
    })
    // D5: v1 has no live tasks yet, so v2 may be conducted at once.
    await conduct(depsFor(f, scripted({ requirements: () => answer(v2), conduct: () => failed('') }).decider))
    const set = await prisma.requirementSet.findUniqueOrThrow({
      where: { workspaceId_goalVersion: { workspaceId: f.workspaceId, goalVersion: 2 } },
    })
    expect((set.items as { key: string }[]).map((i) => i.key)).toEqual(['R2', 'R3', 'RUN'])
  })

  it('counts the conductor in the workspace spend, unmeasured calls at the per-call cap', async () => {
    const f = await seed({ delivery: 'conducted', goal: 'x' })
    await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS, null), conduct: () => failed('') }).decider))
    const spend = await workspaceSpend(f.workspaceId)
    expect(spend.conductorUnmeasuredCalls).toBe(1)
    expect(spend.spentUsd).toBe(CONDUCT_PER_CALL_CAP_USD)
  })
})

const PARTITIONED = JSON.stringify({
  conductAnswer: {
    mode: 'partitioned',
    reason: 'two large disjoint parts',
    packages: [
      { key: 'report', title: 'Report modes', requirementKeys: ['R1'], ownedPaths: ['src/report/**'], newPaths: ['src/report/csv.py'], interface: 'render(rows, mode)', dependsOn: [], templateId: 't-backend' },
      { key: 'config', title: 'Config', requirementKeys: ['R2'], ownedPaths: ['src/config.py'], newPaths: [], interface: 'load()', dependsOn: [], templateId: 't-backend' },
    ],
  },
})

/**
 * `seed` plus what the size decision reads: a repository with real files to own, two active
 * templates with a managed pool (three people each, `syncPersonPool`'s whole allowance) so
 * `staffPackages` can seat people, and goal v1's requirement set, made by one `conduct` tick.
 *
 * Plan 4b Task 4: a reviewer seat of the docs persona, as intake staffs one, so the conductor has a
 * verifier to name -- without it `PARTITIONED`'s three backend packages take the backend pool's
 * three people and a verifier hired from the first package's persona has nobody left.
 * `withReviewer: false` leaves it out.
 */
async function seedWithRequirements(options: { readonly withReviewer?: boolean } = {}): Promise<Fixture> {
  await syncCapabilityTaxonomy()
  // Named with a file tag, not the plain "Backend Developer" / "Technical Writer" several other
  // integration files also use: `SlaveTemplate.name` is unique and those files reset it only in
  // their own `beforeEach` TRUNCATE, so their last test's row outlives the file and collides here.
  await prisma.slaveTemplate.create({
    data: { id: 't-backend', name: 'Backend Developer (conductor)', role: 'backend', description: 'x', active: true, capabilityKeys: [] },
  })
  await prisma.slaveTemplate.create({
    data: { id: 't-docs', name: 'Technical Writer (conductor)', role: 'docs', description: 'x', active: true, capabilityKeys: [] },
  })
  await syncPersonPool()
  const f = await seed({
    delivery: 'conducted',
    goal: 'Add a CSV mode. Add a JSON mode.',
    files: ['src/cli.py', 'src/report/table.py', 'src/config.py'],
  })
  if (options.withReviewer !== false) {
    const team = await prisma.team.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })
    const person = await prisma.person.findFirstOrThrow({ where: { templateId: 't-docs' }, orderBy: { id: 'asc' } })
    await prisma.slave.create({ data: { teamId: team.id, role: 'Technical Writer', runtimeRoles: ['docs', 'reviewer'], personId: person.id } })
  }
  const step = await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => failed('') }).decider))
  if (step !== 'requirements_set') throw new Error(`the fixture requirement set was not made: ${step}`)
  return f
}

describe('conduct: the size decision', () => {
  it('stores the plan\'s shared decisions with the packages (plan A D10)', async () => {
    const f = await seedWithRequirements()
    const decided = JSON.parse(PARTITIONED) as { conductAnswer: Record<string, unknown> }
    decided.conductAnswer['decisions'] = [{ title: 'API field naming', decision: 'camelCase' }]
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(JSON.stringify(decided)) }).decider))).toBe('conducted')
    const rows = await prisma.goalDecision.findMany({ where: { workspaceId: f.workspaceId }, select: { goalVersion: true, title: true, titleKey: true, decision: true, source: true } })
    expect(rows).toEqual([{ goalVersion: 1, title: 'API field naming', titleKey: 'api field naming', decision: 'camelCase', source: 'conductor_plan' }])
  })

  it('stores a decision without the NUL bytes and controls Postgres refuses, keyed on the cleaned title (ruling F8)', async () => {
    const f = await seedWithRequirements()
    const decided = JSON.parse(PARTITIONED) as { conductAnswer: Record<string, unknown> }
    decided.conductAnswer['decisions'] = [{ title: 'API\u0000 Field\u0007  Naming', decision: 'camel\u0000Case' }]
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(JSON.stringify(decided)) }).decider))).toBe('conducted')
    const rows = await prisma.goalDecision.findMany({ where: { workspaceId: f.workspaceId }, select: { title: true, titleKey: true, decision: true } })
    expect(rows).toEqual([{ title: 'API Field  Naming', titleKey: 'api field naming', decision: 'camelCase' }])
  })

  it('stores no decision for a plan without them (spec §4)', async () => {
    const f = await seedWithRequirements()
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('conducted')
    expect(await prisma.goalDecision.count({ where: { workspaceId: f.workspaceId } })).toBe(0)
  })

  it('materialises a partitioned plan: packages, pinned tasks, dependencies, a recorded decision, one seat each', async () => {
    const f = await seedWithRequirements()
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('conducted')
    const packages = await prisma.workPackage.findMany({ where: { workspaceId: f.workspaceId }, include: { tasks: true }, orderBy: { key: 'asc' } })
    expect(packages.map((p) => p.key)).toEqual(['config', 'integration', 'report', 'skeleton'])
    const tasks = packages.flatMap((p) => p.tasks)
    expect(tasks).toHaveLength(4)
    expect(tasks.every((t) => t.status === 'ready' && t.requiredRole === PACKAGE_WORKER_ROLE && t.goalVersion === 1 && t.assigneeId !== null)).toBe(true)
    // Plan A D6: the skeleton runs first and integration last, so they share a seat.
    expect(new Set(tasks.map((t) => t.assigneeId)).size).toBe(3)
    const seatOf = (key: string): string | null | undefined => packages.find((p) => p.key === key)?.tasks[0]?.assigneeId
    expect(seatOf('skeleton')).toBe(seatOf('integration'))
    // Controller ruling F10: the skeleton's task says its job through SKELETON_INTERFACE, not a second copy.
    expect(packages.find((p) => p.key === 'skeleton')?.tasks[0]?.description).toContain(SKELETON_INTERFACE)
    expect(packages.find((p) => p.key === 'report')?.tasks[0]?.description).toBe('Requirements:\nR1: hsql --format csv prints CSV')
    const integrationTask = packages.find((p) => p.key === 'integration')?.tasks[0]
    // Final review: the wiring line survives RUN being the integration package's requirement.
    expect(integrationTask?.description).toBe(`Wire the packages together: skeleton, report, config.\nRequirements:\nRUN: ${RUN_REQUIREMENT_TEXT}`)
    const deps = await prisma.taskDependency.findMany({ where: { taskId: integrationTask?.id ?? '' } })
    expect(deps).toHaveLength(3)
    const reportDeps = await prisma.taskDependency.findMany({ where: { taskId: packages.find((p) => p.key === 'report')?.tasks[0]?.id ?? '' } })
    expect(reportDeps.map((d) => d.dependsOnTaskId)).toEqual([packages.find((p) => p.key === 'skeleton')?.tasks[0]?.id])
    const decision = await prisma.supervisorDecision.findFirstOrThrow({ where: { workspaceId: f.workspaceId, situationKind: 'conduct' } })
    expect(decision).toEqual(expect.objectContaining({ tier: 'applied', status: 'applied', subjectId: `${f.workspaceId}:v1`, modelCalled: false, rationale: 'two large disjoint parts', decidedBy: 'model' }))
    expect(decision.action).toEqual({ kind: 'conduct', goalVersion: 1, mode: 'partitioned', packageKeys: ['skeleton', 'report', 'config', 'integration'] })
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'task_created' } })).toBe(4)
    const conducted = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_conducted' } })
    expect(conducted).toHaveLength(1)
    expect(conducted[0]?.payload).toEqual({ version: 1, mode: 'partitioned', packages: ['skeleton', 'report', 'config', 'integration'], decisionId: decision.id, fallback: false })
    // idempotent: a second tick does nothing
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('none')
    expect(await prisma.conductorCall.count({ where: { workspaceId: f.workspaceId, stage: 'conduct' } })).toBe(1)
  })

  it('stores a package\'s registrations on its row', async () => {
    const f = await seedWithRequirements()
    const answerWith = JSON.stringify({
      conductAnswer: {
        mode: 'partitioned',
        reason: 'two large disjoint parts',
        packages: [
          { key: 'report', title: 'Report modes', requirementKeys: ['R1'], ownedPaths: ['src/report/**'], newPaths: [], interface: 'render(rows, mode)', dependsOn: [], templateId: 't-backend', registrations: [{ directory: 'db/migrations', prefix: '0100_report_' }] },
          { key: 'config', title: 'Config', requirementKeys: ['R2'], ownedPaths: ['src/config.py'], newPaths: [], interface: 'load()', dependsOn: [], templateId: 't-backend' },
        ],
      },
    })
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(answerWith) }).decider))).toBe('conducted')
    const report = await prisma.workPackage.findFirstOrThrow({ where: { workspaceId: f.workspaceId, key: 'report' } })
    expect(report.registrations).toEqual([{ directory: 'db/migrations', prefix: '0100_report_' }])
    expect(report.ownedPaths).toEqual(['src/report/**', 'db/migrations/0100_report_*', 'scripts/verify.d/report.sh'])
  })

  it('hands the refusal to the next attempt and falls back to single after the cap', async () => {
    const f = await seedWithRequirements()
    // Controller ruling 1: config owning `src/**` overlaps report's `src/report/table.py`.
    const overlapping = JSON.stringify({
      conductAnswer: {
        mode: 'partitioned',
        reason: 'two large disjoint parts',
        packages: [
          { key: 'report', title: 'Report modes', requirementKeys: ['R1'], ownedPaths: ['src/report/**'], newPaths: ['src/report/csv.py'], interface: 'render(rows, mode)', dependsOn: [], templateId: 't-backend' },
          { key: 'config', title: 'Config', requirementKeys: ['R2'], ownedPaths: ['src/**'], newPaths: [], interface: 'load()', dependsOn: [], templateId: 't-backend' },
        ],
      },
    })
    const { decider, prompts } = scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(overlapping) })
    for (let i = 0; i < CONDUCT_RETRY_CAP; i += 1) expect(await conduct(depsFor(f, decider))).toBe('conduct_failed')
    expect(prompts.at(-1)).toContain('Your previous answer was refused: ')
    expect(prompts.at(-1)).toContain('two packages own the same file')
    expect(await conduct(depsFor(f, decider))).toBe('conducted')
    // The fallback is not a model call: no fourth ConductorCall row.
    expect(prompts).toHaveLength(CONDUCT_RETRY_CAP)
    expect(await prisma.conductorCall.count({ where: { workspaceId: f.workspaceId, stage: 'conduct' } })).toBe(CONDUCT_RETRY_CAP)
    const packages = await prisma.workPackage.findMany({ where: { workspaceId: f.workspaceId } })
    // No open seat holds the package role yet, so the first template shown (by name) staffs it --
    // read from the catalogue, because the shared test database may hold another file's active
    // template that sorts before this file's own.
    const first = await prisma.slaveTemplate.findFirstOrThrow({ where: { active: true }, orderBy: { name: 'asc' } })
    expect(packages).toEqual([expect.objectContaining({ key: 'main', ownedPaths: ['**'], requirementKeys: ['R1', 'R2', 'RUN'], templateId: first.id })])
    const decision = await prisma.supervisorDecision.findFirstOrThrow({ where: { workspaceId: f.workspaceId, situationKind: 'conduct' } })
    expect(decision.decidedBy).toBe('rules')
    expect(decision.rationale).toContain('single by default')
    const conducted = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId: f.workspaceId, type: 'workspace_conducted' } })
    expect(conducted.payload).toEqual(expect.objectContaining({ mode: 'single', fallback: true }))
  })

  it('waits while a board left over from planned delivery still has live work (D5), said once as goal_waiting', async () => {
    const f = await seedWithRequirements()
    await prisma.task.create({ data: { workspaceId: f.workspaceId, title: 'old', description: 'old', status: 'running', maxAttempts: 3, requiredRole: 'backend' } })
    const calls = await prisma.conductorCall.count({ where: { workspaceId: f.workspaceId } })
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('waiting')
    expect(await prisma.conductorCall.count({ where: { workspaceId: f.workspaceId } })).toBe(calls)
    expect(await prisma.workPackage.count({ where: { workspaceId: f.workspaceId } })).toBe(0)
    // Plan D6: the wait is said once, with its own event, and is neither a halt nor a guardrail.
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('waiting')
    const waits = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_goal_waiting' } })
    expect(waits.map((w) => w.payload)).toEqual([{ version: 1, waitingOn: null }])
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'guardrail_tripped' } })).toBe(0)
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })).haltedReason).toBeNull()
  })

  it('conducts the next goal version only once the earlier one is merged (D6), saying the wait once', async () => {
    const f = await seedWithRequirements()
    await prisma.goalDelivery.create({
      data: { workspaceId: f.workspaceId, goalVersion: 1, integrationBranch: integrationBranchName(1, f.workspaceId), baseCommit: 'abc', status: 'accepted', acceptedAt: new Date() },
    })
    const moved = await setGoal(f.workspaceId, 'Add a CSV mode. Add a JSON mode. Add a YAML mode.')
    if (!moved.ok) throw new Error('the second goal was refused')
    const { decider, prompts } = scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) })
    expect(await conduct(depsFor(f, decider))).toBe('waiting')
    expect(await conduct(depsFor(f, decider))).toBe('waiting')
    expect(prompts).toHaveLength(0)
    const waits = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_goal_waiting' } })
    expect(waits.map((w) => w.payload)).toEqual([{ version: 2, waitingOn: 1 }])
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'guardrail_tripped' } })).toBe(0)
    await prisma.goalDelivery.update({ where: { workspaceId_goalVersion: { workspaceId: f.workspaceId, goalVersion: 1 } }, data: { mergedAt: new Date() } })
    expect(await conduct(depsFor(f, decider))).toBe('requirements_set')
    expect(await prisma.requirementSet.count({ where: { workspaceId: f.workspaceId, goalVersion: 2 } })).toBe(1)
  })

  it('does not hold the next goal version behind an abandoned one (D6)', async () => {
    const f = await seedWithRequirements()
    await prisma.goalDelivery.create({
      data: { workspaceId: f.workspaceId, goalVersion: 1, integrationBranch: integrationBranchName(1, f.workspaceId), baseCommit: 'abc', status: 'abandoned' },
    })
    const moved = await setGoal(f.workspaceId, 'Add a CSV mode. Add a JSON mode. Add a YAML mode.')
    if (!moved.ok) throw new Error('the second goal was refused')
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('requirements_set')
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'workspace_goal_waiting' } })).toBe(0)
  })

  it("cuts the version's integration branch from the base branch and records its delivery row", async () => {
    const f = await seedWithRequirements()
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('conducted')
    const { repoPath } = await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })
    const branch = integrationBranchName(1, f.workspaceId)
    const tip = git(['rev-parse', 'main'], repoPath)
    const deliveries = await prisma.goalDelivery.findMany({ where: { workspaceId: f.workspaceId } })
    expect(deliveries).toEqual([
      expect.objectContaining({ goalVersion: 1, status: 'integrating', integrationBranch: branch, baseCommit: tip, acceptedAt: null, mergedAt: null, smokeRequired: true }),
    ])
    expect(git(['rev-parse', branch], repoPath)).toBe(tip)
  })

  it('does not smoke-check a version whose stored set predates RUN (skeleton spec S7, legacy sets)', async () => {
    const f = await seedWithRequirements()
    // A set extracted before Plan A: R-keys only.
    const set = await prisma.requirementSet.findFirstOrThrow({ where: { workspaceId: f.workspaceId, goalVersion: 1 } })
    const items = (set.items as { key: string }[]).filter((item) => item.key !== 'RUN')
    await prisma.requirementSet.update({ where: { id: set.id }, data: { items } })
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('conducted')
    const delivery = await prisma.goalDelivery.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })
    expect(delivery.smokeRequired).toBe(false)
  })

  it('says once and writes nothing when the integration branch cannot be cut', async () => {
    const f = await seedWithRequirements()
    const { repoPath } = await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })
    const branch = integrationBranchName(1, f.workspaceId)
    git(['checkout', '-q', '-b', branch], repoPath)
    writeFileSync(join(repoPath, 'foreign.txt'), 'foreign\n')
    git(['add', '-A'], repoPath)
    git(['commit', '-q', '-m', 'foreign'], repoPath)
    git(['checkout', '-q', 'main'], repoPath)
    const { decider } = scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) })
    expect(await conduct(depsFor(f, decider))).toBe('conduct_failed')
    expect(await conduct(depsFor(f, decider))).toBe('conduct_failed')
    expect(await prisma.workPackage.count({ where: { workspaceId: f.workspaceId } })).toBe(0)
    expect(await prisma.goalDelivery.count({ where: { workspaceId: f.workspaceId } })).toBe(0)
    const trips = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'guardrail_tripped' } })
    expect(trips).toHaveLength(1)
    expect(trips[0]?.payload).toEqual(expect.objectContaining({ guardrail: 'conductor_failed' }))
    expect((trips[0]?.payload as { detail: string }).detail).toContain(branch)
  })

  it('says once, without halting, when the repository cannot be read for the size decision', async () => {
    const f = await seedWithRequirements()
    // A base branch that does not exist reads like an empty repository: `git ls-tree` refuses it.
    await prisma.workspace.update({ where: { id: f.workspaceId }, data: { baseBranch: 'no-such-branch' } })
    const { decider, prompts } = scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) })
    expect(await conduct(depsFor(f, decider))).toBe('conduct_failed')
    expect(await conduct(depsFor(f, decider))).toBe('conduct_failed')
    expect(prompts).toHaveLength(0)
    const trips = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'guardrail_tripped' } })
    expect(trips).toHaveLength(1)
    expect((trips[0]?.payload as { detail: string }).detail).toContain('could not read the repository for goal v1')
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })).haltedReason).toBeNull()
  })

  /** Final review M4: only the integration package wires the others together. */
  it('describes a non-integration package with no requirements by its own contract, not as the wiring', async () => {
    const f = await seedWithRequirements()
    const withCli = JSON.stringify({
      conductAnswer: {
        mode: 'partitioned',
        reason: 'three parts',
        integrationTemplateId: 't-docs',
        skeletonTemplateId: 't-docs',
        packages: [
          { key: 'cli', title: 'CLI flags', requirementKeys: [], ownedPaths: ['src/cli.py'], interface: 'parse(argv)', templateId: 't-backend' },
          { key: 'report', title: 'Report', requirementKeys: ['R1'], ownedPaths: ['src/report/**'], templateId: 't-backend' },
          { key: 'config', title: 'Config', requirementKeys: ['R2'], ownedPaths: ['src/config.py'], templateId: 't-backend' },
        ],
      },
    })
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(withCli) }).decider))).toBe('conducted')
    const packages = await prisma.workPackage.findMany({ where: { workspaceId: f.workspaceId }, include: { tasks: true } })
    const cli = packages.find((p) => p.key === 'cli')?.tasks[0]?.description
    expect(cli).not.toContain('Wire the packages together')
    expect(cli).toContain('CLI flags')
    expect(packages.find((p) => p.key === 'integration')?.tasks[0]?.description).toBe(
      `Wire the packages together: skeleton, cli, report, config.\nRequirements:\nRUN: ${RUN_REQUIREMENT_TEXT}`,
    )
  })

  /** Plan 4b D4 (spec R8): every conducted version has a verifier seat that implements none of it. */
  it('records a verifier seat on the delivery that holds the verifier role and none of the packages', async () => {
    const f = await seedWithRequirements()
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('conducted')
    const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { workspaceId_goalVersion: { workspaceId: f.workspaceId, goalVersion: 1 } } })
    expect(delivery.verifierSlaveId).not.toBeNull()
    const verifier = await prisma.slave.findUniqueOrThrow({ where: { id: delivery.verifierSlaveId ?? '' } })
    expect(verifier.runtimeRoles).toContain(VERIFIER_ROLE)
    expect(verifier.runtimeRoles).not.toContain(PACKAGE_WORKER_ROLE)
    const tasks = await prisma.task.findMany({ where: { workspaceId: f.workspaceId } })
    expect(tasks).toHaveLength(4)
    expect(tasks.map((t) => t.assigneeId)).not.toContain(verifier.id)
  })

  /** Fix round 1 (ruling V3): the plan's only persona is exhausted and there is no reviewer, so the
   *  verifier comes from another catalogue persona -- the version is conducted, not stuck. */
  it('conducts with no reviewer when the plan exhausts its persona, hiring the verifier elsewhere', async () => {
    const f = await seedWithRequirements({ withReviewer: false })
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('conducted')
    const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { workspaceId_goalVersion: { workspaceId: f.workspaceId, goalVersion: 1 } } })
    const verifier = await prisma.slave.findUniqueOrThrow({ where: { id: delivery.verifierSlaveId ?? '' }, include: { person: true } })
    expect(verifier.runtimeRoles).toContain(VERIFIER_ROLE)
    expect(verifier.person.templateId).not.toBe('t-backend')
    const tasks = await prisma.task.findMany({ where: { workspaceId: f.workspaceId } })
    expect(tasks.map((t) => t.assigneeId)).not.toContain(verifier.id)
  })

  it('says once and materialises nothing when no verifier can be staffed', async () => {
    const f = await seedWithRequirements({ withReviewer: false })
    // Every managed person but the backend pool (which PARTITIONED's three packages take) is
    // released: no open seat, no persona of the plan and no catalogue persona has anybody left.
    await prisma.person.updateMany({ where: { poolSlot: { not: null }, NOT: { templateId: 't-backend' } }, data: { releasedAt: new Date() } })
    const { decider } = scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) })
    expect(await conduct(depsFor(f, decider))).toBe('conduct_failed')
    expect(await conduct(depsFor(f, decider))).toBe('conduct_failed')
    expect(await prisma.workPackage.count({ where: { workspaceId: f.workspaceId } })).toBe(0)
    expect(await prisma.goalDelivery.count({ where: { workspaceId: f.workspaceId } })).toBe(0)
    const trips = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'guardrail_tripped' } })
    expect(trips).toHaveLength(1)
    expect(trips[0]?.payload).toEqual(expect.objectContaining({ guardrail: 'conductor_failed' }))
    expect((trips[0]?.payload as { detail: string }).detail).toContain('verifier')
  })

  it('staffs a bought plan again without buying it twice when the pool ran out, and says so once', async () => {
    const f = await seedWithRequirements()
    // Four packages of one persona: the managed pool holds three people, so the fourth has no seat.
    const four = JSON.stringify({
      conductAnswer: {
        mode: 'partitioned',
        reason: 'four parts',
        integrationTemplateId: 't-docs',
        packages: [
          { key: 'cli', title: 'CLI', requirementKeys: [], ownedPaths: ['src/cli.py'], templateId: 't-backend' },
          { key: 'report', title: 'Report', requirementKeys: ['R1'], ownedPaths: ['src/report/**'], templateId: 't-backend' },
          { key: 'config', title: 'Config', requirementKeys: ['R2'], ownedPaths: ['src/config.py'], templateId: 't-backend' },
          { key: 'readme', title: 'Readme', requirementKeys: [], ownedPaths: ['README.md'], templateId: 't-backend' },
        ],
      },
    })
    const { decider, prompts } = scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(four) })
    expect(await conduct(depsFor(f, decider))).toBe('conduct_failed')
    expect(await conduct(depsFor(f, decider))).toBe('conduct_failed')
    expect(prompts).toHaveLength(1)
    expect(await prisma.workPackage.count({ where: { workspaceId: f.workspaceId } })).toBe(0)
    const trips = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'guardrail_tripped' } })
    expect(trips).toHaveLength(1)
    expect(trips[0]?.payload).toEqual(expect.objectContaining({ guardrail: 'conductor_failed' }))
    expect((trips[0]?.payload as { detail: string }).detail).toContain('staffing goal v1')
    // Not a halt: a pool sync or a person may still make the staffing possible.
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })).haltedReason).toBeNull()
  })
})
