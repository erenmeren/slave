import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma } from '@slave-of-ai/db/client'
import { CONDUCTOR_ROLE, PACKAGE_WORKER_ROLE, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drainPumps, tick, type TickDeps } from '../../src/tick.js'
import { worktreeRootFor } from '../../src/worktree.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A real repository: the task's worktree is provisioned from it and verify runs in it. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-run-report-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  return dir
}

interface Fixture {
  readonly workspaceId: string
  readonly taskId: string
  readonly deps: TickDeps
}

const goodReport = {
  requirements: [
    { key: 'R1', status: 'done', evidence: 'pytest -k csv passed' },
    { key: 'R2', status: 'done', evidence: 'pytest -k json passed' },
  ],
  filesTouched: ['src/report/csv.py'],
  workflow: [{ step: 1, done: true, note: '' }],
  questions: [],
}

const repos: string[] = []

/** The `m8-flow` fake, whose work run ends with `report` as its `<slave-report>` block (none when
 *  `null`) -- `--report-json-base64` on argv, the channel a run's child actually receives. */
function depsFor(workspaceId: string, report: unknown): TickDeps {
  const extraArgs = [FAKE, '--fixture', 'm8-flow']
  if (report !== null) extraArgs.push('--report-json-base64', Buffer.from(JSON.stringify(report)).toString('base64'))
  const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs, hookPath: REAL_GATE })
  return { workspaceId: brandWorkspaceId(workspaceId), registry: { resolve: () => adapter } }
}

async function seedWorkspace(delivery: 'planned' | 'conducted'): Promise<{ readonly workspaceId: string; readonly teamId: string }> {
  const repoPath = makeRepo()
  repos.push(repoPath)
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Report Modes',
      repoPath,
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [],
      delivery,
      // A conducted version with packages already materialised: the conductor's turn in the tick
      // is `none`, and the package task is the ordinary scheduler's.
      ...(delivery === 'conducted' ? { goal: 'Add csv and json report modes', goalVersion: 1 } : {}),
    },
  })
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  // A reviewer seat, so a verified package task has somewhere to go.
  await prisma.slave.create({
    data: {
      teamId: team.id,
      role: 'Reviewer',
      runtimeRoles: ['reviewer'],
      personId: (await prisma.person.create({ data: { name: 'Rhea' } })).id,
    },
  })
  return { workspaceId: workspace.id, teamId: team.id }
}

/** A conducted workspace with requirements R1 and R2, one package `main` that owns everything and
 *  both requirements, and its task pinned to the one seat that holds the package-worker role --
 *  the shape `conductor.ts`'s `materialise` writes. */
async function seedPackageTask(options: { readonly report: unknown }): Promise<Fixture> {
  const { workspaceId, teamId } = await seedWorkspace('conducted')
  await prisma.requirementSet.create({
    data: {
      workspaceId,
      goalVersion: 1,
      items: [
        { key: 'R1', text: 'csv mode', source: 'add a csv mode' },
        { key: 'R2', text: 'json mode', source: 'and json' },
      ],
    },
  })
  const pkg = await prisma.workPackage.create({
    data: {
      workspaceId,
      goalVersion: 1,
      key: 'main',
      title: 'Report modes',
      requirementKeys: ['R1', 'R2'],
      ownedPaths: ['**'],
      interface: '',
      isIntegration: true,
      templateId: 'tpl',
    },
  })
  const seat = await prisma.slave.create({
    data: {
      teamId,
      role: 'Implementer',
      runtimeRoles: [PACKAGE_WORKER_ROLE],
      personId: (await prisma.person.create({ data: { name: 'Ivo' } })).id,
    },
  })
  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: 'Report modes',
      description: 'R1 csv mode, R2 json mode',
      status: 'ready',
      requiredRole: PACKAGE_WORKER_ROLE,
      requiredCapabilities: [],
      createdBy: 'system',
      maxAttempts: 3,
      goalVersion: 1,
      assigneeId: seat.id,
      workPackageId: pkg.id,
    },
  })
  return { workspaceId, taskId: task.id, deps: depsFor(workspaceId, options.report) }
}

/** An ordinary planned-workspace task: no package, so no report is asked for or read. */
async function seedPlainTask(): Promise<Fixture> {
  const { workspaceId, teamId } = await seedWorkspace('planned')
  await prisma.slave.create({
    data: {
      teamId,
      role: 'backend',
      runtimeRoles: ['backend'],
      personId: (await prisma.person.create({ data: { name: 'Beryl' } })).id,
    },
  })
  const task = await prisma.task.create({
    data: { workspaceId, title: 'Add the thing', description: 'make it work', status: 'ready', requiredRole: 'backend', maxAttempts: 3 },
  })
  return { workspaceId, taskId: task.id, deps: depsFor(workspaceId, null) }
}

/** Ticks, letting every pump (and the conclusion it awaits) finish between ticks, until `done`
 *  holds -- bounded, so a flow that never gets there fails instead of hanging. */
async function tickUntil(f: Fixture, done: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await tick(f.deps)
    await drainPumps()
    if (await done()) return
  }
  throw new Error('tickUntil: the condition never held')
}

const taskStatus = async (taskId: string): Promise<string> =>
  (await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status

describe('a package run files its report before verify', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "SlaveMessage", "RunReport", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
    )
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    for (const repo of repos) {
      rmSync(worktreeRootFor(repo), { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
    await prisma.$disconnect()
  })

  it('stores a well-formed report and goes on to verify', async (): Promise<void> => {
    const f = await seedPackageTask({ report: goodReport })
    await tickUntil(f, async () => (await taskStatus(f.taskId)) !== 'running')
    const report = await prisma.runReport.findFirstOrThrow({ where: { taskId: f.taskId } })
    expect((report.report as { requirements: unknown[] }).requirements).toHaveLength(2)
    const task = await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })
    expect(task.status).not.toBe('rework')
    // Verify passed (`true`), so the task went on to review.
    expect(task.status).toBe('reviewing')
  })

  it('fails the run and reworks the task when the report is missing, with the reason', async (): Promise<void> => {
    const f = await seedPackageTask({ report: null })
    const before = (await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })).attempt
    await tickUntil(f, async () => (await taskStatus(f.taskId)) === 'rework')
    const task = await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })
    expect(task.lastRejectionReason).toContain('no <slave-report> block')
    // Exactly one rejection's worth: `startRun` does not touch `attempt` and `rejectTask`
    // increments it once, so the missing report cost this task one attempt and nothing more.
    expect(task.attempt).toBe(before + 1)
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: f.taskId } })
    expect(run.status).toBe('failed')
    expect(await prisma.runReport.count()).toBe(0)
  })

  it('sends each report question to the conductor, tied to the task', async (): Promise<void> => {
    const f = await seedPackageTask({ report: { ...goodReport, questions: ['Omit JSON nulls?'] } })
    await tickUntil(f, async () => (await prisma.runReport.count()) === 1)
    const questions = await prisma.slaveMessage.findMany({ where: { workspaceId: f.workspaceId, kind: 'question' } })
    expect(questions).toEqual([
      expect.objectContaining({ recipientRole: CONDUCTOR_ROLE, taskId: f.taskId, expectsReply: true, body: 'Omit JSON nulls?' }),
    ])
  })

  it('leaves a non-package task exactly as before', async (): Promise<void> => {
    const f = await seedPlainTask()
    await tickUntil(f, async () => (await taskStatus(f.taskId)) !== 'running')
    expect(await prisma.runReport.count()).toBe(0)
    const task = await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })
    expect(task.lastRejectionReason ?? '').not.toContain('slave-report')
    expect(task.status).toBe('reviewing')
  })
})
