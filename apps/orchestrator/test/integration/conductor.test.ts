import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setGoal, workspaceSpend, type ModelDecider, type ModelOutcome } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { CONDUCT_PER_CALL_CAP_USD, CONDUCT_RETRY_CAP, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
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
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-conductor-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
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
}): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: `Checkout ${String(Math.random()).slice(2)}`,
      repoPath: makeRepo(),
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
    'TRUNCATE TABLE "ExecutionEvent", "ConductorCall", "RequirementSet", "WorkPackage", "RunReport", "SupervisorDecision", "SlaveMessage", "SlaveRun", "TaskDependency", "Task", "GoalVersion", "ProviderConfiguration", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
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
