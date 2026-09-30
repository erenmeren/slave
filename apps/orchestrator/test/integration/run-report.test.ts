import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { answerQuestion, listPendingQuestions, loadSupervisorWorld } from '@slave-of-ai/control'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { CONDUCTOR_ROLE, PACKAGE_WORKER_ROLE, observe, runId as brandRunId, workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inboxSection } from '../../src/inbox.js'
import { drainPumps, tick, type TickDeps } from '../../src/tick.js'
import { verifyConcludedRun } from '../../src/verify.js'
import { worktreeRootFor } from '../../src/worktree.js'

/** Task 6: how many of the next `routeHandOffs` calls fail as a busy delivery lock does (P2028). */
const busyLock = vi.hoisted(() => ({ failures: 0, calls: 0 }))
vi.mock('@slave-of-ai/control', async (importOriginal) => {
  const original = await importOriginal<typeof import('@slave-of-ai/control')>()
  return {
    ...original,
    routeHandOffs: async (...args: Parameters<typeof original.routeHandOffs>): ReturnType<typeof original.routeHandOffs> => {
      busyLock.calls += 1
      if (busyLock.failures > 0) {
        busyLock.failures -= 1
        throw Object.assign(new Error('Transaction API error: Unable to start a transaction in the given time.'), { code: 'P2028' })
      }
      return original.routeHandOffs(...args)
    },
  }
})

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
 *  `null`; a string is sent as it is, so a test can script a broken block) -- `--report-json-base64`
 *  on argv, the channel a run's child actually receives. */
function depsFor(workspaceId: string, report: unknown): TickDeps {
  const extraArgs = [FAKE, '--fixture', 'm8-flow']
  if (report !== null) {
    const body = typeof report === 'string' ? report : JSON.stringify(report)
    extraArgs.push('--report-json-base64', Buffer.from(body).toString('base64'))
  }
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
async function seedPackageTask(options: { readonly report: unknown; readonly maxAttempts?: number }): Promise<Fixture> {
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
      maxAttempts: options.maxAttempts ?? 3,
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
async function tickUntil(f: Fixture, done: () => Promise<boolean>, deps: TickDeps = f.deps): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await tick(deps)
    await drainPumps()
    if (await done()) return
  }
  throw new Error('tickUntil: the condition never held')
}

/** The domain event types written about one task, in order. */
async function taskEventTypes(taskId: string): Promise<readonly string[]> {
  const rows = await prisma.executionEvent.findMany({ where: { taskId }, orderBy: { seq: 'asc' }, select: { type: true } })
  return rows.map((row) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type)
}

const taskStatus = async (taskId: string): Promise<string> =>
  (await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status

describe('a package run files its report before verify', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Checkpoint", "SlaveMessage", "PackageHandOff", "RunReport", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
    )
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
    busyLock.failures = 0
    busyLock.calls = 0
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
    expect(await taskEventTypes(f.taskId)).toContain('task.rework')
  })

  it('reworks a report that lists one requirement twice, naming the duplicate', async (): Promise<void> => {
    const duplicated = { ...goodReport, requirements: [...goodReport.requirements, { key: 'R1', status: 'done', evidence: 'again' }] }
    const f = await seedPackageTask({ report: duplicated })
    await tickUntil(f, async () => (await taskStatus(f.taskId)) === 'rework')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })).lastRejectionReason).toContain('R1 is reported 2 times')
    expect(await prisma.runReport.count()).toBe(0)
    expect((await prisma.slaveRun.findFirstOrThrow({ where: { taskId: f.taskId } })).status).toBe('failed')
  })

  /**
   * Final review I3: the rejection is the run's to make only while the task is still the run's.
   * The replay here is the crash window between the two writes -- the task rejected, the run not
   * yet failed -- which a restarted daemon concludes again.
   */
  it('charges one attempt when the same conclusion is replayed', async (): Promise<void> => {
    const f = await seedPackageTask({ report: null })
    await tickUntil(f, async () => (await taskStatus(f.taskId)) === 'rework')
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: f.taskId } })
    const after = await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { status: 'succeeded' } })

    await verifyConcludedRun(brandRunId(run.id))
    const replayed = await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })
    expect(replayed.attempt).toBe(after.attempt)
    expect(replayed.status).toBe('rework')
    expect((await taskEventTypes(f.taskId)).filter((t) => t === 'task.rework')).toHaveLength(1)
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('failed')
  })

  it('leaves a cancelled task cancelled when a late conclusion has no report', async (): Promise<void> => {
    const f = await seedPackageTask({ report: null })
    await tickUntil(f, async () => (await taskStatus(f.taskId)) === 'rework')
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: f.taskId } })
    // A person cancelled the task while its run's result was still on its way.
    await prisma.task.update({ where: { id: f.taskId }, data: { status: 'cancelled', activeRunId: null } })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { status: 'succeeded' } })
    const before = await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })

    await verifyConcludedRun(brandRunId(run.id))
    const task = await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })
    expect(task.status).toBe('cancelled')
    expect(task.attempt).toBe(before.attempt)
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('failed')
  })

  it('fails the task at the attempt cap, and says so with task.failed', async (): Promise<void> => {
    const f = await seedPackageTask({ report: null, maxAttempts: 1 })
    await tickUntil(f, async () => (await taskStatus(f.taskId)) === 'failed')
    const task = await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })
    expect(task.lastRejectionReason).toContain('no <slave-report> block')
    const events = await taskEventTypes(f.taskId)
    expect(events).toContain('task.failed')
    expect(events).not.toContain('task.rework')
  })

  it('accepts a well-formed report on the run after one without a usable report', async (): Promise<void> => {
    // One fake per phase: the report rides on the spawn's argv, so the second run is given one by
    // ticking with a second set of deps -- the worker that forgot, then the worker that remembered.
    const f = await seedPackageTask({ report: '{not json' })
    await tickUntil(f, async () => (await taskStatus(f.taskId)) === 'rework')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })).lastRejectionReason).toContain('not valid JSON')
    expect(await prisma.runReport.count()).toBe(0)

    await tickUntil(f, async () => (await taskStatus(f.taskId)) === 'reviewing', depsFor(f.workspaceId, goodReport))
    const runs = await prisma.slaveRun.findMany({ where: { taskId: f.taskId, kind: 'implementation' }, orderBy: { startedAt: 'asc' } })
    expect(runs.map((r) => r.status)).toEqual(['failed', 'succeeded'])
    const report = await prisma.runReport.findFirstOrThrow({ where: { taskId: f.taskId } })
    expect(report.runId).toBe(runs[1]?.id)
  })

  it('sends each report question to the conductor, tied to the task', async (): Promise<void> => {
    const f = await seedPackageTask({ report: { ...goodReport, questions: ['Omit JSON nulls?'] } })
    await tickUntil(f, async () => (await prisma.runReport.count()) === 1)
    const questions = await prisma.slaveMessage.findMany({ where: { workspaceId: f.workspaceId, kind: 'question' } })
    expect(questions).toEqual([
      expect.objectContaining({ recipientRole: CONDUCTOR_ROLE, taskId: f.taskId, expectsReply: true, body: 'Omit JSON nulls?' }),
    ])
  })

  /**
   * Final review C1: a report question is asked after its run concluded, so nobody is parked on it
   * -- and under the parked-run rule alone it was pending nowhere. It must be pending for the
   * Supervisor (which answers the conductor's questions), for `messages`, and until a reply lands;
   * the reply then reaches the seat's next run on the task.
   */
  it('keeps a report question pending for the Supervisor until answered, and hands the answer to the seat', async (): Promise<void> => {
    const f = await seedPackageTask({ report: { ...goodReport, questions: ['Omit JSON nulls?'] } })
    await tickUntil(f, async () => (await prisma.runReport.count()) === 1)
    const question = await prisma.slaveMessage.findFirstOrThrow({ where: { workspaceId: f.workspaceId, kind: 'question' } })

    const pending = await listPendingQuestions(f.workspaceId)
    expect(pending.ok && pending.value.map((m) => m.id)).toEqual([question.id])
    const { world } = await loadSupervisorWorld(f.workspaceId, new Date())
    expect(observe(world).some((s) => s.kind === 'unanswerable_question' && s.subjectId === question.id)).toBe(true)

    const answered = await answerQuestion(question.id, { body: 'Yes, omit them.', answeredBy: 'test' })
    expect(answered.ok).toBe(true)
    const after = await listPendingQuestions(f.workspaceId)
    expect(after.ok && after.value).toEqual([])
    const { world: later } = await loadSupervisorWorld(f.workspaceId, new Date())
    expect(observe(later).some((s) => s.subjectId === question.id)).toBe(false)

    const inbox = await inboxSection(question.slaveId, f.taskId)
    expect(inbox?.text).toContain('Omit JSON nulls?')
    expect(inbox?.text).toContain('Yes, omit them.')
    // Only on that task: the seat's run on another task is not told about it.
    expect(await inboxSection(question.slaveId, null)).toBeNull()
  })

  it('routes the report\'s hand-offs by ownership and asks the conductor about one with no target (spec C2)', async (): Promise<void> => {
    const f = await seedPackageTask({
      report: { ...goodReport, handOffs: [{ package: 'docs', change: 'document the csv flag' }, { package: 'billing', change: 'charge for exports' }] },
    })
    // A second package, not started: its task waits in backlog, so the request waits for its prompt.
    const docs = await prisma.workPackage.create({ data: { workspaceId: f.workspaceId, goalVersion: 1, key: 'docs', title: 'Docs', requirementKeys: [], ownedPaths: ['docs/**'], interface: '', templateId: 'tpl' } })
    await prisma.task.create({ data: { workspaceId: f.workspaceId, title: 'Docs', description: 'x', status: 'backlog', requiredRole: PACKAGE_WORKER_ROLE, maxAttempts: 3, goalVersion: 1, workPackageId: docs.id } })
    await tickUntil(f, async () => (await prisma.runReport.count()) === 1)
    const rows = await prisma.packageHandOff.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { sourceKey: 'asc' } })
    expect(rows.map((r) => [r.toPackageKey, r.status])).toEqual([['docs', 'pending'], [null, 'to_conductor']])
    const questions = await prisma.slaveMessage.findMany({ where: { workspaceId: f.workspaceId, kind: 'question' } })
    expect(questions).toEqual([expect.objectContaining({ recipientRole: CONDUCTOR_ROLE, taskId: f.taskId, body: expect.stringContaining('no package has the key "billing"') })])
  })

  it('files a report through a busy delivery lock: the routing is tried again and the run goes on to verify (Task 6)', async (): Promise<void> => {
    busyLock.failures = 1
    const f = await seedPackageTask({ report: { ...goodReport, handOffs: [{ package: 'billing', change: 'charge for exports' }] } })
    await tickUntil(f, async () => (await taskStatus(f.taskId)) !== 'running')
    expect(busyLock.calls).toBe(2)
    expect(await taskStatus(f.taskId)).toBe('reviewing')
    expect((await prisma.slaveRun.findFirstOrThrow({ where: { taskId: f.taskId } })).status).toBe('succeeded')
    const rows = await prisma.packageHandOff.findMany({ where: { workspaceId: f.workspaceId } })
    expect(rows.map((r) => r.status)).toEqual(['to_conductor'])
  })

  it('files a report without hand-offs exactly as before: nothing is routed (spec §4)', async (): Promise<void> => {
    const f = await seedPackageTask({ report: goodReport })
    await tickUntil(f, async () => (await taskStatus(f.taskId)) !== 'running')
    expect(busyLock.calls).toBe(0)
    expect(await prisma.packageHandOff.count()).toBe(0)
    expect(await taskStatus(f.taskId)).toBe('reviewing')
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
