import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  setGoal,
  syncCapabilityTaxonomy,
  syncPersonPool,
  workspaceSpend,
  type ModelDecider,
  type ModelOutcome,
} from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  CONDUCT_PER_CALL_CAP_USD,
  CONDUCT_RETRY_CAP,
  PACKAGE_WORKER_ROLE,
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

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "ConductorCall", "RequirementSet", "WorkPackage", "RunReport", "SupervisorDecision", "SlaveMessage", "SlaveRun", "TaskDependency", "Task", "GoalVersion", "ProviderConfiguration", "Slave", "Person", "Team", "Workspace", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
})

afterEach(async (): Promise<void> => {
  await drainPumps()
})

afterAll(async (): Promise<void> => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true })
  await prisma.$disconnect()
})

describe('conduct: requirements', () => {
  it('extracts a keyed requirement set for the goal version, logs the call, emits the event', async () => {
    const f = await seed({ delivery: 'conducted', goal: 'Add a CSV mode. Add a JSON mode.' })
    const { decider } = scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => failed('not yet') })
    expect(await conduct(depsFor(f, decider))).toBe('requirements_set')
    const set = await prisma.requirementSet.findUniqueOrThrow({
      where: { workspaceId_goalVersion: { workspaceId: f.workspaceId, goalVersion: 1 } },
    })
    expect((set.items as { key: string }[]).map((i) => i.key)).toEqual(['R1', 'R2'])
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
    expect((set.items as { key: string }[]).map((i) => i.key)).toEqual(['R2', 'R3'])
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
 */
async function seedWithRequirements(): Promise<Fixture> {
  await syncCapabilityTaxonomy()
  await prisma.slaveTemplate.create({
    data: { id: 't-backend', name: 'Backend Developer', role: 'backend', description: 'x', active: true, capabilityKeys: [] },
  })
  await prisma.slaveTemplate.create({
    data: { id: 't-docs', name: 'Technical Writer', role: 'docs', description: 'x', active: true, capabilityKeys: [] },
  })
  await syncPersonPool()
  const f = await seed({
    delivery: 'conducted',
    goal: 'Add a CSV mode. Add a JSON mode.',
    files: ['src/cli.py', 'src/report/table.py', 'src/config.py'],
  })
  const step = await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => failed('') }).decider))
  if (step !== 'requirements_set') throw new Error(`the fixture requirement set was not made: ${step}`)
  return f
}

describe('conduct: the size decision', () => {
  it('materialises a partitioned plan: packages, pinned tasks, dependencies, a recorded decision, one seat each', async () => {
    const f = await seedWithRequirements()
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('conducted')
    const packages = await prisma.workPackage.findMany({ where: { workspaceId: f.workspaceId }, include: { tasks: true }, orderBy: { key: 'asc' } })
    expect(packages.map((p) => p.key)).toEqual(['config', 'integration', 'report'])
    const tasks = packages.flatMap((p) => p.tasks)
    expect(tasks).toHaveLength(3)
    expect(tasks.every((t) => t.status === 'ready' && t.requiredRole === PACKAGE_WORKER_ROLE && t.goalVersion === 1 && t.assigneeId !== null)).toBe(true)
    expect(new Set(tasks.map((t) => t.assigneeId)).size).toBe(3)
    expect(packages.find((p) => p.key === 'report')?.tasks[0]?.description).toBe('Requirements:\nR1: hsql --format csv prints CSV')
    const integrationTask = packages.find((p) => p.key === 'integration')?.tasks[0]
    expect(integrationTask?.description).toBe('Wire the packages together: report, config.')
    const deps = await prisma.taskDependency.findMany({ where: { taskId: integrationTask?.id ?? '' } })
    expect(deps).toHaveLength(2)
    const decision = await prisma.supervisorDecision.findFirstOrThrow({ where: { workspaceId: f.workspaceId, situationKind: 'conduct' } })
    expect(decision).toEqual(expect.objectContaining({ tier: 'applied', status: 'applied', subjectId: `${f.workspaceId}:v1`, modelCalled: false, rationale: 'two large disjoint parts', decidedBy: 'model' }))
    expect(decision.action).toEqual({ kind: 'conduct', goalVersion: 1, mode: 'partitioned', packageKeys: ['report', 'config', 'integration'] })
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'task_created' } })).toBe(3)
    const conducted = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_conducted' } })
    expect(conducted).toHaveLength(1)
    expect(conducted[0]?.payload).toEqual({ version: 1, mode: 'partitioned', packages: ['report', 'config', 'integration'], decisionId: decision.id, fallback: false })
    // idempotent: a second tick does nothing
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('none')
    expect(await prisma.conductorCall.count({ where: { workspaceId: f.workspaceId, stage: 'conduct' } })).toBe(1)
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
    // No open seat holds the package role yet, so the first template shown (by name) staffs it.
    expect(packages).toEqual([expect.objectContaining({ key: 'main', ownedPaths: ['**'], requirementKeys: ['R1', 'R2'], templateId: 't-backend' })])
    const decision = await prisma.supervisorDecision.findFirstOrThrow({ where: { workspaceId: f.workspaceId, situationKind: 'conduct' } })
    expect(decision.decidedBy).toBe('rules')
    expect(decision.rationale).toContain('single by default')
    const conducted = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId: f.workspaceId, type: 'workspace_conducted' } })
    expect(conducted.payload).toEqual(expect.objectContaining({ mode: 'single', fallback: true }))
  })

  it('waits while an older version still has live work (D5)', async () => {
    const f = await seedWithRequirements()
    await prisma.task.create({ data: { workspaceId: f.workspaceId, title: 'old', description: 'old', status: 'running', maxAttempts: 3, requiredRole: 'backend' } })
    const calls = await prisma.conductorCall.count({ where: { workspaceId: f.workspaceId } })
    expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('waiting')
    expect(await prisma.conductorCall.count({ where: { workspaceId: f.workspaceId } })).toBe(calls)
    expect(await prisma.workPackage.count({ where: { workspaceId: f.workspaceId } })).toBe(0)
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
