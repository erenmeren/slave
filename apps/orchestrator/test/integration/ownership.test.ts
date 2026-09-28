import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requestResume, runDirPathFor } from '@slave-of-ai/control'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { PACKAGE_WORKER_ROLE, globToRegExp, integrationBranchName, runId as brandRunId, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { ClaudeCodeAdapter, permissionsFilePathFor } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureIntegrationBranch } from '../../src/goalBranch.js'
import { auditOwnership, changedFiles, ownershipRuleForTask, permissionOwnership } from '../../src/ownership.js'
import { drainPumps, taskKeyFor, tick, type TickDeps } from '../../src/tick.js'
import { verifyConcludedRun } from '../../src/verify.js'
import { provisionWorktree, worktreeRootFor } from '../../src/worktree.js'

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

  /** Final review I2: no trimming -- a leading space is part of the path. */
  it('keeps a path that starts with a space exactly as it is', async (): Promise<void> => {
    const dir = makeRepo()
    git(['checkout', '-q', '-b', 'work'], dir)
    writeFileSync(join(dir, ' a.txt'), 'leading space\n')
    git(['add', '-A'], dir)
    git(['commit', '-q', '-m', 'work'], dir)
    expect(await changedFiles(dir, 'main', 'work')).toEqual([' a.txt'])
  })

  /** Final review I2: an audit that throws left the task to the stranded-claim sweep, which put it
   *  back with no attempt charged -- a free endless loop. It is a rejection, charged and bounded. */
  it('sends the task back with a reason, charging an attempt, when the audit cannot read the branch', async (): Promise<void> => {
    const c = await seedConducted()
    const report = await seedPackage(c, 'report', ['src/report/**'])
    const seat = await prisma.task.findUniqueOrThrow({ where: { id: report }, select: { assigneeId: true } })
    const run = await prisma.slaveRun.create({
      data: { taskId: report, slaveId: seat.assigneeId ?? '', kind: 'implementation', status: 'succeeded', terminalAt: new Date(), endedAt: new Date() },
    })
    await prisma.task.update({ where: { id: report }, data: { status: 'running', branch: 'no-such-branch', activeRunId: run.id } })

    const verifyMayGoOn = await auditOwnership(
      { id: run.id, slaveId: run.slaveId },
      { id: report, workspaceId: c.workspaceId, branch: 'no-such-branch' },
      { repoPath: c.repoPath, baseBranch: 'main' },
    )

    expect(verifyMayGoOn).toBe(false)
    const task = await prisma.task.findUniqueOrThrow({ where: { id: report } })
    expect(task.status).toBe('rework')
    expect(task.attempt).toBe(1)
    expect(task.lastRejectionReason?.startsWith('the ownership audit could not read what this branch changed: ')).toBe(true)
    expect(task.lastRejectionReason).toContain('no-such-branch')
    const events = await taskEventTypes(report)
    expect(events).toContain('task.rework')
    // Not a violation: `foreign_file` must not count it.
    expect(events).not.toContain('task.ownership_violated')
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('failed')
  }, 60_000)

  it('sends a run that changed a file its package does not own back, naming the file', async (): Promise<void> => {
    const c = await seedConducted()
    const report = await seedPackage(c, 'report', ['src/report/**'])
    await tickUntil(depsWithReport(c.workspaceId), async () => (await taskStatus(report)) === 'rework')

    const task = await prisma.task.findUniqueOrThrow({ where: { id: report } })
    expect(task.lastRejectionReason?.startsWith('revert changes to files you do not own: ')).toBe(true)
    expect(task.lastRejectionReason).toContain('m8a-work.txt')
    // Final review I1: the reason says how to undo it, and that the write tools will not.
    expect(task.lastRejectionReason).toContain('m8a-work.txt. To undo committed changes to files you do not own')
    expect(task.lastRejectionReason).toContain(`git checkout $(git merge-base main HEAD) -- <file>`)
    expect(task.lastRejectionReason).toContain('git rm')
    expect(task.lastRejectionReason).toContain('Edit and Write on those files are denied')
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

  /** Final review I1 (controller Ruling 5): setup and tooling dirty files the package does not own;
   *  the leftover-work commit must not put them in the branch the audit judges. */
  it('sets foreign leftovers aside before verify: the audit passes, verify judges the branch, and they are saved', async (): Promise<void> => {
    const c = await seedConducted()
    // Verify fails on ANY uncommitted change: a pass proves it judged exactly the committed branch.
    await prisma.workspace.update({
      where: { id: c.workspaceId },
      data: { verifyCommands: ['test -z "$(git status --porcelain --untracked-files=all)"'] },
    })
    const report = await seedPackage(c, 'report', ['src/report/**'], { status: 'backlog' })
    const handle = await provisionWorktree({ repoPath: c.repoPath, baseBranch: 'main', taskKey: taskKeyFor(report), slug: 'report', setupCommands: [] })
    const seat = await prisma.task.findUniqueOrThrow({ where: { id: report }, select: { assigneeId: true } })
    const run = await prisma.slaveRun.create({
      data: {
        taskId: report,
        slaveId: seat.assigneeId ?? '',
        kind: 'implementation',
        status: 'succeeded',
        worktreePath: handle.path,
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })
    await prisma.task.update({ where: { id: report }, data: { status: 'running', branch: handle.branch, activeRunId: run.id } })
    const workerReport = {
      requirements: [{ key: 'R1', status: 'done', evidence: 'wrote it' }],
      filesTouched: ['src/report/a.ts', 'src/report/b.ts'],
      workflow: [{ step: 1, done: true, note: '' }],
      questions: [],
    }
    await appendEvent({
      type: 'run.output',
      workspaceId: c.workspaceId,
      taskId: report,
      slaveId: seat.assigneeId ?? '',
      runId: run.id,
      actor: 'slave',
      payload: { text: `done\n<slave-report>${JSON.stringify(workerReport)}</slave-report>` },
    })
    // The worker's own, owned work -- committed by it, and more of it left uncommitted.
    mkdirSync(join(handle.path, 'src/report'), { recursive: true })
    writeFileSync(join(handle.path, 'src/report/a.ts'), 'export const a = 1\n')
    git(['add', '-A'], handle.path)
    git(['-c', 'user.name=W', '-c', 'user.email=w@x', 'commit', '-q', '-m', 'owned work'], handle.path)
    writeFileSync(join(handle.path, 'src/report/b.ts'), 'export const b = 1\n')
    // What setup and tooling do after the worker's commit: rewrite a tracked file nobody in the
    // package owns, leave an untracked one, and stage one that is never committed.
    writeFileSync(join(handle.path, 'README.md'), '# fixture\nregenerated by setup\n')
    writeFileSync(join(handle.path, 'cache.json'), '{"generated":true}\n')
    writeFileSync(join(handle.path, 'staged.txt'), 'staged, never committed\n')
    git(['add', 'staged.txt'], handle.path)
    const stateDir = mkdtempSync(join(tmpdir(), 'slaveofai-ownership-state-'))
    scratch.push(stateDir)
    const previousStateDir = process.env['SLAVEOFAI_STATE_DIR']
    process.env['SLAVEOFAI_STATE_DIR'] = stateDir

    try {
      await verifyConcludedRun(brandRunId(run.id))
    } finally {
      if (previousStateDir === undefined) delete process.env['SLAVEOFAI_STATE_DIR']
      else process.env['SLAVEOFAI_STATE_DIR'] = previousStateDir
    }

    const task = await prisma.task.findUniqueOrThrow({ where: { id: report } })
    expect(task.lastRejectionReason).toBeNull()
    expect(task.status).toBe('reviewing')
    expect(await taskEventTypes(report)).not.toContain('task.ownership_violated')
    const branchFiles = execFileSync('git', ['diff', '--name-only', `main...${handle.branch}`], { cwd: c.repoPath, encoding: 'utf8' }).trim().split('\n')
    expect(branchFiles.toSorted()).toEqual(['src/report/a.ts', 'src/report/b.ts'])
    // Out of the tree, and saved under the run's own state directory.
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: handle.path, encoding: 'utf8' })).toBe('')
    const root = join(stateDir, 'runs', run.id, 'set-aside')
    const [saved] = readdirSync(root)
    const patch = readFileSync(join(root, saved ?? '', 'changes.patch'), 'utf8')
    expect(patch).toContain('regenerated by setup')
    expect(patch).toContain('staged, never committed')
    expect(readFileSync(join(root, saved ?? '', 'untracked', 'cache.json'), 'utf8')).toBe('{"generated":true}\n')
  }, 60_000)

  /** Plan 4a (D12): the audit's three-dot base is the branch the task was cut from. A dependency
   *  package's `src/config.py`, already merged into the integration branch, is not this run's change. */
  it("passes a run whose branch carries a dependency's merged work from its integration branch", async (): Promise<void> => {
    const c = await seedConducted()
    const branch = integrationBranchName(1, c.workspaceId)
    const { baseCommit } = await ensureIntegrationBranch(c.repoPath, 'main', branch)
    await prisma.goalDelivery.create({ data: { workspaceId: c.workspaceId, goalVersion: 1, integrationBranch: branch, baseCommit } })
    const scratchTree = join(mkdtempSync(join(tmpdir(), 'slaveofai-ownership-dep-')), 'tree')
    git(['worktree', 'add', '-q', scratchTree, branch], c.repoPath)
    mkdirSync(join(scratchTree, 'src'), { recursive: true })
    writeFileSync(join(scratchTree, 'src/config.py'), 'CONFIG = 1\n')
    git(['add', '-A'], scratchTree)
    git(['commit', '-q', '-m', 'the config package, merged'], scratchTree)
    git(['worktree', 'remove', '--force', scratchTree], c.repoPath)

    const report = await seedPackage(c, 'report', ['src/report/**'], { status: 'backlog' })
    await seedPackage(c, 'config', ['src/config.py'], { status: 'backlog' })
    const handle = await provisionWorktree({ repoPath: c.repoPath, baseBranch: branch, taskKey: taskKeyFor(report), slug: 'report', setupCommands: [] })
    expect(existsSync(join(handle.path, 'src/config.py'))).toBe(true)
    const seat = await prisma.task.findUniqueOrThrow({ where: { id: report }, select: { assigneeId: true } })
    const run = await prisma.slaveRun.create({
      data: {
        taskId: report,
        slaveId: seat.assigneeId ?? '',
        kind: 'implementation',
        status: 'succeeded',
        worktreePath: handle.path,
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })
    await prisma.task.update({ where: { id: report }, data: { status: 'running', branch: handle.branch, activeRunId: run.id } })
    const workerReport = {
      requirements: [{ key: 'R1', status: 'done', evidence: 'wrote it' }],
      filesTouched: ['src/report/x.py'],
      workflow: [{ step: 1, done: true, note: '' }],
      questions: [],
    }
    await appendEvent({
      type: 'run.output',
      workspaceId: c.workspaceId,
      taskId: report,
      slaveId: seat.assigneeId ?? '',
      runId: run.id,
      actor: 'slave',
      payload: { text: `done\n<slave-report>${JSON.stringify(workerReport)}</slave-report>` },
    })
    mkdirSync(join(handle.path, 'src/report'), { recursive: true })
    writeFileSync(join(handle.path, 'src/report/x.py'), 'X = 1\n')
    git(['add', '-A'], handle.path)
    git(['-c', 'user.name=W', '-c', 'user.email=w@x', 'commit', '-q', '-m', 'owned work'], handle.path)

    await verifyConcludedRun(brandRunId(run.id))

    const task = await prisma.task.findUniqueOrThrow({ where: { id: report } })
    expect(task.lastRejectionReason).toBeNull()
    expect(task.status).toBe('reviewing')
    expect(await taskEventTypes(report)).not.toContain('task.ownership_violated')
  }, 60_000)

  /**
   * Round 4 (re-review m4): the leftover-work commit is `skipped` when HEAD is not the task's own
   * branch (detached, or on some other branch), because a commit there would not reach the branch
   * review reads. `setAsideForeignChanges` restores a foreign tracked path "to HEAD" -- which is
   * only right when HEAD IS that branch tip. Before this fix the set-aside ran anyway and silently
   * restored the foreign path against whatever HEAD happened to be, not the task's branch.
   */
  it('does not set foreign leftovers aside when the leftover commit was skipped: HEAD is not the task branch', async (): Promise<void> => {
    const c = await seedConducted()
    const report = await seedPackage(c, 'report', ['src/report/**'], { status: 'backlog' })
    const handle = await provisionWorktree({ repoPath: c.repoPath, baseBranch: 'main', taskKey: taskKeyFor(report), slug: 'report', setupCommands: [] })
    const seat = await prisma.task.findUniqueOrThrow({ where: { id: report }, select: { assigneeId: true } })
    const run = await prisma.slaveRun.create({
      data: {
        taskId: report,
        slaveId: seat.assigneeId ?? '',
        kind: 'implementation',
        status: 'succeeded',
        worktreePath: handle.path,
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })
    await prisma.task.update({ where: { id: report }, data: { status: 'running', branch: handle.branch, activeRunId: run.id } })

    // `main` moves on in the PRIMARY checkout, after the worktree branched off it -- its README now
    // differs from the task branch's.
    writeFileSync(join(c.repoPath, 'README.md'), '# fixture, updated on main\n')
    git(['add', '-A'], c.repoPath)
    git(['-c', 'user.name=W', '-c', 'user.email=w@x', 'commit', '-q', '-m', 'main moves on'], c.repoPath)
    const mainSha = execFileSync('git', ['rev-parse', 'main'], { cwd: c.repoPath, encoding: 'utf8' }).trim()

    // The worktree ends up DETACHED at that commit -- something else's job entirely, not this
    // task's -- with a foreign change dirtied on top of it, never committed.
    git(['checkout', '-q', mainSha], handle.path)
    writeFileSync(join(handle.path, 'README.md'), 'dirtied by setup, never committed\n')

    const stateDir = mkdtempSync(join(tmpdir(), 'slaveofai-ownership-state-'))
    scratch.push(stateDir)
    const previousStateDir = process.env['SLAVEOFAI_STATE_DIR']
    process.env['SLAVEOFAI_STATE_DIR'] = stateDir

    try {
      await verifyConcludedRun(brandRunId(run.id))
    } finally {
      if (previousStateDir === undefined) delete process.env['SLAVEOFAI_STATE_DIR']
      else process.env['SLAVEOFAI_STATE_DIR'] = previousStateDir
    }

    // Untouched: no restore ran against the wrong HEAD, and nothing was saved anywhere.
    expect(readFileSync(join(handle.path, 'README.md'), 'utf8')).toBe('dirtied by setup, never committed\n')
    expect(existsSync(join(stateDir, 'runs', run.id, 'set-aside'))).toBe(false)
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
