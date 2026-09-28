import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requestResume, runDirPathFor } from '@slave-of-ai/control'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { PACKAGE_WORKER_ROLE, globToRegExp, runId as brandRunId, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter, permissionsFilePathFor } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditOwnership, changedFiles, ownershipRuleForTask, permissionOwnership } from '../../src/ownership.js'
import { drainPumps, tick, type TickDeps } from '../../src/tick.js'
import { worktreeRootFor } from '../../src/worktree.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

function git(args: readonly string[], cwd: string): void {
  execFileSync('git', [...args], { cwd })
}

const repos: string[] = []
const scratch: string[] = []

/** A real repository: a dispatched task's worktree is provisioned from it. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-ownership-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  repos.push(dir)
  return dir
}

function depsFor(workspaceId: string, fixture: string): TickDeps {
  const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', fixture], hookPath: REAL_GATE })
  return { workspaceId: brandWorkspaceId(workspaceId), registry: { resolve: () => adapter } }
}

interface Conducted {
  readonly workspaceId: string
  readonly teamId: string
  readonly repoPath: string
}

/** A conducted workspace at goal version 1 with its requirements, and a reviewer seat so a verified
 *  task has somewhere to go -- `run-report.test.ts`'s seed. */
async function seedConducted(): Promise<Conducted> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Ownership',
      repoPath,
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [],
      delivery: 'conducted',
      goal: 'Add a report and a config',
      goalVersion: 1,
    },
  })
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  await prisma.slave.create({
    data: { teamId: team.id, role: 'Reviewer', runtimeRoles: ['reviewer'], personId: (await prisma.person.create({ data: { name: 'Rhea' } })).id },
  })
  await prisma.requirementSet.create({
    data: {
      workspaceId: workspace.id,
      goalVersion: 1,
      items: [
        { key: 'R1', text: 'a report', source: 'add a report' },
        { key: 'R2', text: 'a config', source: 'and a config' },
      ],
    },
  })
  return { workspaceId: workspace.id, teamId: team.id, repoPath }
}

async function seedPackage(
  c: Conducted,
  key: string,
  ownedPaths: readonly string[],
  options: {
    readonly isIntegration?: boolean
    readonly goalVersion?: number
    readonly status?: 'ready' | 'backlog'
    readonly maxAttempts?: number
  } = {},
): Promise<string> {
  const pkg = await prisma.workPackage.create({
    data: {
      workspaceId: c.workspaceId,
      goalVersion: options.goalVersion ?? 1,
      key,
      title: key,
      requirementKeys: ['R1'],
      ownedPaths: [...ownedPaths],
      interface: '',
      isIntegration: options.isIntegration ?? false,
      templateId: 'tpl',
    },
  })
  const seat = await prisma.slave.create({
    data: { teamId: c.teamId, role: 'Implementer', runtimeRoles: [PACKAGE_WORKER_ROLE], personId: (await prisma.person.create({ data: { name: `Ivo ${key}` } })).id },
  })
  const task = await prisma.task.create({
    data: {
      workspaceId: c.workspaceId,
      title: key,
      description: `the ${key} package`,
      status: options.status ?? 'ready',
      requiredRole: PACKAGE_WORKER_ROLE,
      requiredCapabilities: [],
      createdBy: 'system',
      maxAttempts: options.maxAttempts ?? 3,
      goalVersion: options.goalVersion ?? 1,
      assigneeId: seat.id,
      workPackageId: pkg.id,
    },
  })
  return task.id
}

/** An ordinary planned-workspace task: no package, so no ownership. */
async function seedPlainTask(): Promise<{ readonly workspaceId: string; readonly taskId: string }> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: { name: 'Plain', repoPath, baseBranch: 'main', verifyCommands: ['true'], setupCommands: [], delivery: 'planned' },
  })
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  await prisma.slave.create({
    data: { teamId: team.id, role: 'backend', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: 'Beryl' } })).id },
  })
  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add the thing', description: 'make it work', status: 'ready', requiredRole: 'backend', maxAttempts: 3 },
  })
  return { workspaceId: workspace.id, taskId: task.id }
}

interface Verdict {
  readonly tokenHash: string
  readonly ownership?: { readonly worktreeRoot: string; readonly owned: readonly string[] | null; readonly excluded: readonly string[] }
}

function readVerdict(runId: string): Verdict {
  return JSON.parse(readFileSync(permissionsFilePathFor(runDirPathFor(brandRunId(runId))), 'utf8')) as Verdict
}

const source = (glob: string): string => globToRegExp(glob).source

describe('a package run is given its ownership', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "Artifact", "Checkpoint", "SlaveMessage", "RunReport", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
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
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
    await prisma.$disconnect()
  }, 30_000)

  it('reads a package task its own globs, and the integration task everything the others do not own', async (): Promise<void> => {
    const c = await seedConducted()
    const report = await seedPackage(c, 'report', ['src/report/**'])
    await seedPackage(c, 'config', ['src/config.py'])
    const integration = await seedPackage(c, 'integration', [], { isIntegration: true })

    expect(await ownershipRuleForTask(report)).toEqual({ owned: ['src/report/**'], excluded: [] })
    const rule = await ownershipRuleForTask(integration)
    expect(rule?.owned).toBeNull()
    expect(new Set(rule?.excluded)).toEqual(new Set(['src/report/**', 'src/config.py']))
    expect(rule?.excluded).toHaveLength(2)
  })

  it('reads no rule for a plain task, a missing task, or a package that owns everything', async (): Promise<void> => {
    const plain = await seedPlainTask()
    expect(await ownershipRuleForTask(plain.taskId)).toBeNull()
    expect(await ownershipRuleForTask('00000000-0000-0000-0000-000000000000')).toBeNull()
    const c = await seedConducted()
    const main = await seedPackage(c, 'main', ['**'], { isIntegration: true })
    expect(await ownershipRuleForTask(main)).toBeNull()
    expect(await permissionOwnership(main, '/w')).toBeUndefined()
  })

  it('hands the gate regex sources and the worktree root', async (): Promise<void> => {
    const c = await seedConducted()
    const report = await seedPackage(c, 'report', ['src/report/**'])
    await seedPackage(c, 'integration', [], { isIntegration: true })
    // `/w` does not exist, so realpath throws and the given path is kept as it is.
    expect(await permissionOwnership(report, '/w')).toEqual({ worktreeRoot: '/w', owned: [source('src/report/**')], excluded: [] })
  })

  /** Controller Ruling 2: the gate resolves the session's paths against `worktreeRoot`, and the
   *  session sees the realpath -- a root reached through a symlink must be written resolved. */
  it('writes the real path of a worktree reached through a symlink', async (): Promise<void> => {
    const c = await seedConducted()
    const report = await seedPackage(c, 'report', ['src/report/**'])
    const real = mkdtempSync(join(tmpdir(), 'slaveofai-ownership-real-'))
    const linkDir = mkdtempSync(join(tmpdir(), 'slaveofai-ownership-link-'))
    scratch.push(real, linkDir)
    const link = join(linkDir, 'worktree')
    symlinkSync(real, link)
    const ownership = await permissionOwnership(report, link)
    expect(ownership?.worktreeRoot).toBe(realpathSync(real))
    expect(ownership?.worktreeRoot).not.toBe(link)
  })

  it("writes a package run's ownership into its permissions file at dispatch, and none for a plain task", async (): Promise<void> => {
    const c = await seedConducted()
    const report = await seedPackage(c, 'report', ['src/report/**'])
    await seedPackage(c, 'config', ['src/config.py'], { status: 'backlog' })
    await tick(depsFor(c.workspaceId, 'm8-flow'))
    await drainPumps()
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: report, kind: 'implementation' } })
    const verdict = readVerdict(run.id)
    expect(verdict.ownership?.owned).toEqual([source('src/report/**')])
    expect(verdict.ownership?.excluded).toEqual([])
    const root = verdict.ownership?.worktreeRoot ?? ''
    expect(root.startsWith(`${realpathSync(worktreeRootFor(c.repoPath))}/`)).toBe(true)
    expect(realpathSync(root)).toBe(root)

    const plain = await seedPlainTask()
    await tick(depsFor(plain.workspaceId, 'm8-flow'))
    await drainPumps()
    const plainRun = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: plain.taskId, kind: 'implementation' } })
    expect(readVerdict(plainRun.id)).not.toHaveProperty('ownership')
  }, 60_000)

  it('keeps the ownership when a paused package run is resumed', async (): Promise<void> => {
    const c = await seedConducted()
    const report = await seedPackage(c, 'report', ['src/report/**'])
    await tick(depsFor(c.workspaceId, 'hook-deny'))
    await drainPumps()
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: report, kind: 'implementation' } })
    expect(run.status).toBe('paused')
    const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId: run.id } })
    const permissionsPath = permissionsFilePathFor(dirname(checkpoint.pauseFlagPath))
    const before = JSON.parse(readFileSync(permissionsPath, 'utf8')) as Verdict

    expect((await requestResume(run.id, 'carry on', 'web')).ok).toBe(true)
    await tick(depsFor(c.workspaceId, 'env-echo'))
    await drainPumps()

    const after = JSON.parse(readFileSync(permissionsPath, 'utf8')) as Verdict
    // Rewritten, not left over: the token rotated on resume.
    expect(after.tokenHash).not.toBe(before.tokenHash)
    expect(after.ownership).toEqual({ worktreeRoot: realpathSync(checkpoint.worktreePath), owned: [source('src/report/**')], excluded: [] })
  }, 60_000)
})

/** The `m8-flow` fake, whose work run writes and commits `m8a-work.txt` at the worktree's root and
 *  ends with a well-formed `<slave-report>` for R1 -- so an audit rejection is the only one left. */
function depsWithReport(workspaceId: string): TickDeps {
  const report = {
    requirements: [{ key: 'R1', status: 'done', evidence: 'the fake wrote it' }],
    filesTouched: ['m8a-work.txt'],
    workflow: [{ step: 1, done: true, note: '' }],
    questions: [],
  }
  const extraArgs = [FAKE, '--fixture', 'm8-flow', '--report-json-base64', Buffer.from(JSON.stringify(report)).toString('base64')]
  const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs, hookPath: REAL_GATE })
  return { workspaceId: brandWorkspaceId(workspaceId), registry: { resolve: () => adapter } }
}

/** Ticks, letting every pump finish between ticks, until `done` holds -- bounded, so a flow that
 *  never gets there fails instead of hanging. */
async function tickUntil(deps: TickDeps, done: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await tick(deps)
    await drainPumps()
    if (await done()) return
  }
  throw new Error('tickUntil: the condition never held')
}

async function taskEventTypes(taskId: string): Promise<readonly string[]> {
  const rows = await prisma.executionEvent.findMany({ where: { taskId }, orderBy: { seq: 'asc' }, select: { type: true } })
  return rows.map((row) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type)
}

const taskStatus = async (taskId: string): Promise<string> => (await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status

describe('the diff audit', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "Artifact", "Checkpoint", "SlaveMessage", "RunReport", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
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
  }, 30_000)

  it('lists the net change of a branch since it left the base, renames as both sides', async (): Promise<void> => {
    const dir = makeRepo()
    for (const name of ['a.txt', 'd.txt', 'e.txt', 'x.txt']) writeFileSync(join(dir, name), `${name}\n`)
    git(['add', '-A'], dir)
    git(['commit', '-q', '-m', 'base files'], dir)
    git(['checkout', '-q', '-b', 'work'], dir)
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    mkdirSync(join(dir, 'b'))
    writeFileSync(join(dir, 'b/c.txt'), 'new\n')
    git(['rm', '-q', 'd.txt'], dir)
    git(['mv', 'e.txt', 'f.txt'], dir)
    writeFileSync(join(dir, 'x.txt'), 'touched\n')
    git(['add', '-A'], dir)
    git(['commit', '-q', '-m', 'work'], dir)
    // Changed, then reverted on the branch: no net change, so not listed.
    writeFileSync(join(dir, 'x.txt'), 'x.txt\n')
    git(['commit', '-q', '-am', 'revert x'], dir)
    // A commit on the base after the branch left it is not the branch's change (three-dot range).
    git(['checkout', '-q', 'main'], dir)
    writeFileSync(join(dir, 'm.txt'), 'main moved on\n')
    git(['add', '-A'], dir)
    git(['commit', '-q', '-m', 'main'], dir)

    const files = await changedFiles(dir, 'main', 'work')
    expect(new Set(files)).toEqual(new Set(['a.txt', 'b/c.txt', 'd.txt', 'e.txt', 'f.txt']))
    expect(files).toHaveLength(5)
  })

  it('sends a run that changed a file its package does not own back, naming the file', async (): Promise<void> => {
    const c = await seedConducted()
    const report = await seedPackage(c, 'report', ['src/report/**'])
    await tickUntil(depsWithReport(c.workspaceId), async () => (await taskStatus(report)) === 'rework')

    const task = await prisma.task.findUniqueOrThrow({ where: { id: report } })
    expect(task.lastRejectionReason?.startsWith('revert changes to files you do not own: ')).toBe(true)
    expect(task.lastRejectionReason).toContain('m8a-work.txt')
    expect(task.attempt).toBe(1)
    const events = await taskEventTypes(report)
    expect(events).toContain('task.rework')
    expect(events).toContain('task.ownership_violated')
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: report, kind: 'implementation' } })
    expect(run.status).toBe('failed')
    const violated = await prisma.executionEvent.findFirstOrThrow({ where: { taskId: report, type: 'task_ownership_violated' } })
    expect(violated.runId).toBe(run.id)
    const payload = violated.payload as { runId: string; files: string[]; total: number }
    expect(payload.runId).toBe(run.id)
    expect(payload.files).toContain('m8a-work.txt')
    expect(payload.total).toBe(payload.files.length)
    expect(await prisma.runReport.count()).toBe(0)
  }, 60_000)

  /** Controller ruling 3: `foreign_file` counts these events, so a conclusion audited twice -- a
   *  replay after the task already went back -- must not write a second one or spend an attempt. */
  it('records one violation per rejection: auditing the same run again after rework writes nothing', async (): Promise<void> => {
    const c = await seedConducted()
    const report = await seedPackage(c, 'report', ['src/report/**'])
    await tickUntil(depsWithReport(c.workspaceId), async () => (await taskStatus(report)) === 'rework')
    const before = await prisma.task.findUniqueOrThrow({ where: { id: report } })
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: report, kind: 'implementation' } })
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: c.workspaceId } })
    expect(before.branch).not.toBeNull()

    const verifyMayGoOn = await auditOwnership(
      { id: run.id, slaveId: run.slaveId },
      { id: report, workspaceId: c.workspaceId, branch: before.branch ?? '' },
      { repoPath: workspace.repoPath, baseBranch: workspace.baseBranch },
    )

    expect(verifyMayGoOn).toBe(false)
    expect(await prisma.executionEvent.count({ where: { taskId: report, type: 'task_ownership_violated' } })).toBe(1)
    const after = await prisma.task.findUniqueOrThrow({ where: { id: report } })
    expect(after.attempt).toBe(before.attempt)
    expect(after.status).toBe('rework')
  }, 60_000)

  it('lets a run that changed only its own files go on to its report and review', async (): Promise<void> => {
    const c = await seedConducted()
    const report = await seedPackage(c, 'report', ['m8a-work.txt'])
    await tickUntil(depsWithReport(c.workspaceId), async () => (await taskStatus(report)) !== 'running' && (await taskStatus(report)) !== 'ready')

    expect(await taskStatus(report)).toBe('reviewing')
    expect(await prisma.runReport.count({ where: { taskId: report } })).toBe(1)
    expect(await taskEventTypes(report)).not.toContain('task.ownership_violated')
  }, 60_000)

  it('does not audit a main package that owns everything', async (): Promise<void> => {
    const c = await seedConducted()
    const main = await seedPackage(c, 'main', ['**'], { isIntegration: true })
    await tickUntil(depsWithReport(c.workspaceId), async () => (await taskStatus(main)) !== 'running' && (await taskStatus(main)) !== 'ready')

    expect(await taskStatus(main)).toBe('reviewing')
    expect(await prisma.runReport.count({ where: { taskId: main } })).toBe(1)
    expect(await taskEventTypes(main)).not.toContain('task.ownership_violated')
  }, 60_000)

  it('fails the task at the attempt cap, and says so with task.failed', async (): Promise<void> => {
    const c = await seedConducted()
    const report = await seedPackage(c, 'report', ['src/report/**'], { maxAttempts: 1 })
    await tickUntil(depsWithReport(c.workspaceId), async () => (await taskStatus(report)) === 'failed')

    const task = await prisma.task.findUniqueOrThrow({ where: { id: report } })
    expect(task.lastRejectionReason?.startsWith('revert changes to files you do not own: ')).toBe(true)
    const events = await taskEventTypes(report)
    expect(events).toContain('task.failed')
    expect(events).toContain('task.ownership_violated')
    expect(events).not.toContain('task.rework')
  }, 60_000)
})
