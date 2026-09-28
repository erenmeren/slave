/**
 * Conductor Plan 2, end to end: a conducted goal goes from requirements to a reported, merged
 * package through nothing but `tick` -- the injected decider answers the conductor, the fake CLI
 * (`m8-flow`) is every worker and the reviewer.
 *
 * `mode: 'single'` only: the fake replays one `<slave-report>` for every run and cannot tell
 * packages apart, and `parseSlaveReport` refuses keys a package does not own, so a partitioned run
 * cannot be driven end to end until Plan 4 gives the fake per-package reports. The partitioned path
 * is covered up to materialisation by `conductor.test.ts` and up to the report by `run-report.test.ts`.
 */
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
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { PACKAGE_WORKER_ROLE, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drainPumps, tick, type TickDeps } from '../../src/tick.js'
import { worktreeRootFor } from '../../src/worktree.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')
const TEMPLATE_IDS = ['t-backend']

const repos: string[] = []

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A real repository with files the conductor's map shows and the package worker commits beside. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-conductor-e2e-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  for (const file of ['src/report/table.py', 'src/config.py']) {
    mkdirSync(join(dir, dirname(file)), { recursive: true })
    writeFileSync(join(dir, file), 'def main():\n    pass\n')
  }
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  repos.push(dir)
  return dir
}

/**
 * The templates (and their pool people) this file makes, removed by id -- never a TRUNCATE of
 * "SlaveTemplate" CASCADE, which would empty every table that references it under other files.
 */
async function removeTemplates(): Promise<void> {
  await prisma.person.deleteMany({ where: { templateId: { in: TEMPLATE_IDS } } })
  await prisma.slaveTemplate.deleteMany({ where: { id: { in: TEMPLATE_IDS } } })
}

const REQUIREMENTS = JSON.stringify({
  requirementsAnswer: [
    { text: 'hsql --format csv prints CSV', source: 'Add a CSV mode.' },
    { text: 'hsql --format json prints JSON', source: 'Add a JSON mode.' },
  ],
})
const SINGLE = JSON.stringify({ conductAnswer: { mode: 'single', reason: 'fits one session', templateId: 't-backend' } })

/** What the package worker files: both requirements done. */
const REPORT = {
  requirements: [
    { key: 'R1', status: 'done', evidence: 'pytest -k csv passed' },
    { key: 'R2', status: 'done', evidence: 'pytest -k json passed' },
  ],
  filesTouched: ['m8a-work.txt'],
  workflow: [{ step: 1, done: true, note: '' }],
  questions: [],
}

const answer = (text: string, costUsd: number): ModelOutcome => ({ kind: 'answer', text, costUsd, tokens: null, numTurns: 1 })

/** The conductor's two answers by prompt; anything else (a Supervisor situation) is counted and
 *  refused, so the test can say the happy path never needed one. */
function scripted(): { readonly decider: ModelDecider; readonly others: string[] } {
  const others: string[] = []
  const decider: ModelDecider = async (input) => {
    if (input.prompt.includes('"requirementsAnswer"')) return answer(REQUIREMENTS, 0.02)
    if (input.prompt.includes('"conductAnswer"')) return answer(SINGLE, 0.03)
    others.push(input.prompt)
    return { kind: 'failed', reason: 'not scripted in this test', costUsd: null, tokens: null }
  }
  return { decider, others }
}

interface Fixture {
  readonly workspaceId: string
  readonly deps: TickDeps
  readonly others: readonly string[]
}

/** A conducted workspace with its goal set, the backend template's managed pool, a reviewer seat,
 *  the injected conductor and the `m8-flow` fake that ends every work run with `REPORT`. */
async function seed(): Promise<Fixture> {
  await syncCapabilityTaxonomy()
  await prisma.slaveTemplate.create({
    data: { id: 't-backend', name: 'Backend Developer', role: 'backend', description: 'x', active: true, capabilityKeys: [] },
  })
  await syncPersonPool()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Report Modes E2E',
      repoPath: makeRepo(),
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [],
      delivery: 'conducted',
      // Merged for real, so "merged" means the base branch has the worker's commit.
      autoMerge: true,
    },
  })
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  await prisma.slave.create({
    data: {
      teamId: team.id,
      role: 'Reviewer',
      runtimeRoles: ['reviewer'],
      personId: (await prisma.person.create({ data: { name: 'Rhea' } })).id,
    },
  })
  const goal = await setGoal(workspace.id, 'Add a CSV mode. Add a JSON mode.')
  if (!goal.ok) throw new Error('the fixture goal was refused')

  const extraArgs = [FAKE, '--fixture', 'm8-flow', '--report-json-base64', Buffer.from(JSON.stringify(REPORT)).toString('base64')]
  const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs, hookPath: REAL_GATE })
  const { decider, others } = scripted()
  return {
    workspaceId: workspace.id,
    others,
    deps: {
      workspaceId: brandWorkspaceId(workspace.id),
      registry: { resolve: () => adapter },
      supervisorDecider: decider,
      supervisorModel: 'claude-sonnet-5',
    },
  }
}

/** Ticks, letting every pump finish between ticks, until `done` holds -- bounded, so a flow that
 *  never gets there fails instead of hanging. */
async function tickUntil(f: Fixture, done: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await tick(f.deps)
    await drainPumps()
    if (await done()) return
  }
  throw new Error('tickUntil: the condition never held')
}

describe('conductor end to end', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "ConductorCall", "RequirementSet", "WorkPackage", "RunReport", "SupervisorDecision", "SlaveMessage", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "GoalVersion", "ProviderConfiguration", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
    )
    await removeTemplates()
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    await removeTemplates()
    for (const repo of repos) {
      rmSync(worktreeRootFor(repo), { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
    await prisma.$disconnect()
  })

  it('takes a conducted goal from requirements to a reported, merged package', async (): Promise<void> => {
    const f = await seed()
    const packageTask = async (): Promise<{ readonly id: string; readonly status: string } | null> =>
      prisma.task.findFirst({ where: { workspaceId: f.workspaceId, workPackageId: { not: null } }, select: { id: true, status: true } })
    await tickUntil(f, async () => (await packageTask())?.status === 'done')

    // The requirement set for v1, and the size decision recorded.
    const set = await prisma.requirementSet.findUniqueOrThrow({
      where: { workspaceId_goalVersion: { workspaceId: f.workspaceId, goalVersion: 1 } },
    })
    expect((set.items as { key: string }[]).map((i) => i.key)).toEqual(['R1', 'R2'])
    const decision = await prisma.supervisorDecision.findFirstOrThrow({ where: { workspaceId: f.workspaceId, situationKind: 'conduct' } })
    expect(decision.rationale).toContain('fits one session')
    const packages = await prisma.workPackage.findMany({ where: { workspaceId: f.workspaceId } })
    expect(packages).toEqual([expect.objectContaining({ goalVersion: 1, requirementKeys: ['R1', 'R2'], templateId: 't-backend' })])

    // The package task: pinned to a package-worker seat, ready -> running -> ... -> done.
    const task = await prisma.task.findUniqueOrThrow({ where: { id: (await packageTask())?.id ?? '' } })
    const seat = await prisma.slave.findUniqueOrThrow({ where: { id: task.assigneeId ?? '' } })
    expect(seat.runtimeRoles).toContain(PACKAGE_WORKER_ROLE)
    const events = await prisma.executionEvent.findMany({ where: { taskId: task.id }, orderBy: { seq: 'asc' }, select: { type: true } })
    const types = events.map((row) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type)
    expect(types).toEqual(expect.arrayContaining(['task.started', 'task.verify_passed', 'task.review_approved', 'task.done']))
    expect(types.indexOf('task.started')).toBeLessThan(types.indexOf('task.done'))

    // Merged: the worker's commit is on the base branch.
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })
    expect(git(['ls-tree', '--name-only', 'main'], workspace.repoPath).split('\n')).toContain('m8a-work.txt')

    // The worker's report, filed for its run.
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: task.id, kind: 'implementation', status: 'succeeded' } })
    const report = await prisma.runReport.findFirstOrThrow({ where: { taskId: task.id } })
    expect(report.runId).toBe(run.id)
    expect((report.report as { requirements: { key: string }[] }).requirements.map((r) => r.key)).toEqual(['R1', 'R2'])

    // The planner stayed out, and the conductor's two calls are in the spend.
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(0)
    expect(await prisma.conductorCall.count({ where: { workspaceId: f.workspaceId, outcome: 'ok' } })).toBe(2)
    const spend = await workspaceSpend(f.workspaceId)
    expect(spend.conductorMeasuredUsd).toBeCloseTo(0.05, 6)
    expect(spend.spentUsd).toBeGreaterThanOrEqual(0.05)
    expect(f.others).toEqual([])
  })
})
