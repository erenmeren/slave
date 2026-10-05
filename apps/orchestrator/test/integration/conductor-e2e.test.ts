/**
 * Conductor Plans 2, 4a and 4b, end to end: a conducted goal goes from requirements to a reported
 * package, onto its goal version's integration branch, through verification -- reworked where a
 * requirement fails, stopped for a person where one cannot be checked or the round cap runs out --
 * and from there into the base branch once, through nothing but `tick`. The injected decider
 * answers the conductor, the fake CLI (`m8-flow`) is every worker, the reviewer and the verifier.
 *
 * Each package worker is its own fake: `routingAdapter` reads the run's package off its row and
 * spawns the fake with that package's own `<slave-report>` (its requirement keys) and its own
 * `--work-file` (a file only that package owns), so a partitioned goal is driven end to end too.
 * The verifier is a fake of its own: every requirement passes, or, when a test scripts the loop,
 * `--verification-rounds-base64` answers each round (`Verification round N` in its prompt) in turn.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  confirmGoalMerge,
  loadGoalReport,
  loadSupervisorWorld,
  retryGoal,
  setGoal,
  syncCapabilityTaxonomy,
  syncPersonPool,
  workspaceSpend,
  type ModelDecider,
  type ModelOutcome,
} from '@slave-of-ai/control'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import {
  PACKAGE_WORKER_ROLE,
  VERIFIER_ROLE,
  integrationBranchName,
  observe,
  renderGoalReportMarkdown,
  reportCaveats,
  workspaceId as brandWorkspaceId,
} from '@slave-of-ai/domain'
import { ClaudeCodeAdapter, readSpawnExtras, type SlaveRuntimeAdapter } from '@slave-of-ai/providers'
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

/** A smoke script that fails its first `failures` runs the way the 2026-09-29 project's image did,
 *  then passes -- counted in a file outside the repository, so no package's commit resets it. */
function smokeScript(stateFile: string, failures: number): string {
  return [
    '#!/usr/bin/env bash',
    `n=$(cat '${stateFile}' 2>/dev/null || echo 0)`,
    `echo $((n + 1)) > '${stateFile}'`,
    'echo "smoke project: $SLAVEOFAI_SMOKE_PROJECT"',
    `if [ "$n" -lt ${String(failures)} ]; then echo 'npm error Missing script: "start"' >&2; exit 1; fi`,
    'echo "flow ok"',
    '',
  ].join('\n')
}

/** A real repository with files the conductor's map shows and the package worker commits beside. */
function makeRepo(smoke: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-conductor-e2e-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  for (const file of ['src/report/table.py', 'src/config.py']) {
    mkdirSync(join(dir, dirname(file)), { recursive: true })
    writeFileSync(join(dir, file), 'def main():\n    pass\n')
  }
  // Skeleton spec S7: every version conducted now carries RUN, so its goal pass runs this first.
  // The skeleton owns the file and no fake worker writes it.
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts/smoke.sh'), smoke)
  chmodSync(join(dir, 'scripts/smoke.sh'), 0o755)
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
/** Two packages with disjoint files, `config` depending on `report` (plus the integration package
 *  the conductor always adds, depending on both). */
const DEPENDENT = JSON.stringify({
  conductAnswer: {
    mode: 'partitioned',
    reason: 'config builds on the report modes',
    packages: [
      { key: 'report', title: 'Report modes', requirementKeys: ['R1'], ownedPaths: ['src/report/**'], newPaths: ['src/report/csv.py'], interface: 'render(rows, mode)', dependsOn: [], templateId: 't-backend' },
      { key: 'config', title: 'Config', requirementKeys: ['R2'], ownedPaths: ['src/config.py'], newPaths: [], interface: 'load()', dependsOn: ['report'], templateId: 't-backend' },
    ],
  },
})
/** Two independent packages with disjoint files (`conductor.test.ts`'s partitioned answer): `report`
 *  owns R1, `config` owns R2 -- so a failing R2 is `config`'s to fix, and only `config`'s. */
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
const ORIGINAL_SOURCE = 'def main():\n    pass\n'

/** One verifier item, as a scripted round lists it. */
function checked(key: string, status: 'pass' | 'fail' | 'unverifiable'): object {
  return {
    key,
    status,
    check: key === 'RUN' ? 'docker compose up -d && curl -fsS localhost:8080/health' : `pytest -k ${key}`,
    output: status === 'pass' ? '1 passed' : `1 ${status === 'fail' ? 'failed' : 'skipped'}`,
    reason: status === 'pass' ? '' : status === 'fail' ? `${key} prints nothing` : `${key} needs a network this checkout lacks`,
  }
}

/** The file each package's worker writes: one its own package owns. A `single` package owns
 *  everything, and each version writes a file of its own so its commit is never empty. */
function workFileFor(packageKey: string, goalVersion: number): string {
  if (packageKey === 'skeleton') return 'scripts/verify.d/skeleton.sh'
  if (packageKey === 'report') return 'src/report/csv.py'
  if (packageKey === 'config') return 'src/config.py'
  if (packageKey === 'integration') return 'wiring.txt'
  return goalVersion === 1 ? 'm8a-work.txt' : `m8a-work-v${String(goalVersion)}.txt`
}

/** What a package worker files: every requirement of its package done, its one file touched. */
function reportFor(requirementKeys: readonly string[], workFile: string): object {
  return {
    requirements: requirementKeys.map((key) => ({ key, status: 'done', evidence: `pytest -k ${key} passed` })),
    filesTouched: [workFile],
    workflow: [{ step: 1, done: true, note: '' }],
    questions: [],
  }
}

/** What the verifier reports: every requirement of the version passes. */
function verificationFor(requirements: readonly { readonly key: string }[]): object {
  return { items: requirements.map(({ key }) => ({ key, status: 'pass', check: `pytest -k ${key}`, output: '1 passed', reason: '' })) }
}

const answer = (text: string, costUsd: number): ModelOutcome => ({ kind: 'answer', text, costUsd, tokens: null, numTurns: 1 })

/** The conductor's two answers by prompt; anything else (a Supervisor situation) is counted and
 *  refused, so the test can say the happy path never needed one. */
function scripted(conductAnswer: string, conductorAnswers?: (prompt: string) => string): { readonly decider: ModelDecider; readonly others: string[] } {
  const others: string[] = []
  const decider: ModelDecider = async (input) => {
    if (input.prompt.includes('"requirementsAnswer"')) return answer(REQUIREMENTS, 0.02)
    if (input.prompt.includes('"conductAnswer"')) return answer(conductAnswer, 0.03)
    if (conductorAnswers !== undefined && input.prompt.includes('"conductorAnswers"')) return answer(conductorAnswers(input.prompt), 0.04)
    others.push(input.prompt)
    return { kind: 'failed', reason: 'not scripted in this test', costUsd: null, tokens: null }
  }
  return { decider, others }
}

/** What the repository looked like when a run was spawned -- the dispatch-time facts a test asserts
 *  (a finished run's worktree no longer shows what it was cut with). */
interface Start {
  readonly runId: string
  readonly kind: string
  readonly packageKey: string | null
  readonly goalVersion: number | null
  /** The files tracked at the run's worktree HEAD, before the worker wrote anything. */
  readonly worktreeFiles: readonly string[]
  /** `src/config.py` in that worktree, before the worker wrote anything. */
  readonly configSource: string
  readonly mainTip: string
  readonly mainFiles: readonly string[]
  /** The prompt the run was given (a rework's carries its rejection section). */
  readonly prompt: string
  readonly runDir: string
}

/**
 * One adapter per package worker, chosen per run: the run's package (read off its row) decides the
 * fake's `<slave-report>` and `--work-file`. Reviews go to a plain fake (its verdict arm ignores
 * both). `onImplementationStart` runs after a worker is spawned, while it is running.
 */
function routingAdapter(
  repoPath: () => string,
  starts: Start[],
  onImplementationStart: (goalVersion: number) => Promise<void>,
  verificationRounds?: readonly (readonly object[])[],
  reportExtras?: SeedOptions['reportExtras'],
): SlaveRuntimeAdapter {
  const make = (extra: readonly string[]): ClaudeCodeAdapter =>
    new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'm8-flow', ...extra], hookPath: REAL_GATE })
  const plain = make([])
  const byRun = new Map<string, SlaveRuntimeAdapter>()
  const pick = (runId: string): SlaveRuntimeAdapter => byRun.get(runId) ?? plain
  return {
    kind: plain.kind,
    getCapabilities: () => plain.getCapabilities(),
    listModels: () => plain.listModels(),
    async start(input) {
      const run = await prisma.slaveRun.findUniqueOrThrow({
        where: { id: input.runId },
        select: {
          kind: true,
          task: { select: { workspaceId: true, goalVersion: true, workPackage: { select: { key: true, requirementKeys: true } } } },
          goalDelivery: { select: { workspaceId: true, goalVersion: true } },
        },
      })
      const pkg = run.kind === 'implementation' ? (run.task?.workPackage ?? null) : null
      const goalVersion = run.task?.goalVersion ?? run.goalDelivery?.goalVersion ?? null
      let adapter: SlaveRuntimeAdapter = plain
      if (pkg !== null) {
        const workFile = workFileFor(pkg.key, goalVersion ?? 0)
        const implementationRuns = await prisma.slaveRun.count({
          where: { task: { workspaceId: run.task?.workspaceId ?? '', workPackage: { key: pkg.key } }, kind: 'implementation', id: { not: input.runId } },
        })
        const extra = reportExtras?.(pkg.key, goalVersion ?? 0, implementationRuns) ?? {}
        const report = Buffer.from(JSON.stringify({ ...reportFor(pkg.requirementKeys, workFile), ...extra })).toString('base64')
        adapter = make(['--work-file', workFile, '--report-json-base64', report])
      }
      if (run.kind === 'verification' && verificationRounds !== undefined) {
        // A scripted loop: the fake answers each round with that round's items.
        adapter = make(['--verification-rounds-base64', Buffer.from(JSON.stringify(verificationRounds)).toString('base64')])
      } else if (run.kind === 'verification' && run.goalDelivery !== null) {
        // Conductor Plan 4b (ruling Q7): the verifier checks every requirement of its version and
        // passes it, writing nothing in its checkout.
        const set = await prisma.requirementSet.findUniqueOrThrow({
          where: { workspaceId_goalVersion: { workspaceId: run.goalDelivery.workspaceId, goalVersion: run.goalDelivery.goalVersion } },
        })
        adapter = make(['--verification-json-base64', Buffer.from(JSON.stringify(verificationFor(set.items as { key: string }[]))).toString('base64')])
      }
      starts.push({
        runId: input.runId,
        kind: run.kind,
        packageKey: pkg?.key ?? null,
        goalVersion,
        worktreeFiles: git(['ls-files'], input.worktreePath).split('\n'),
        configSource: readFileSync(join(input.worktreePath, 'src/config.py'), 'utf8'),
        mainTip: git(['rev-parse', 'refs/heads/main'], repoPath()),
        mainFiles: git(['ls-tree', '-r', '--name-only', 'main'], repoPath()).split('\n'),
        prompt: input.prompt,
        runDir: input.runDir,
      })
      byRun.set(input.runId, adapter)
      const handle = await adapter.start(input)
      if (pkg !== null && goalVersion !== null) await onImplementationStart(goalVersion)
      return handle
    },
    events: (runId) => pick(runId).events(runId),
    cancel: (runId) => pick(runId).cancel(runId),
    resume: (runId, checkpoint, queuedInstruction, runToken) => pick(runId).resume(runId, checkpoint, queuedInstruction, runToken),
  }
}

interface Fixture {
  readonly workspaceId: string
  readonly repoPath: string
  /** `main` when the goal was set, before anything ran. */
  readonly initialTip: string
  readonly deps: TickDeps
  readonly others: readonly string[]
  readonly starts: readonly Start[]
}

interface SeedOptions {
  readonly conductAnswer?: string
  readonly autoMerge?: boolean
  readonly onImplementationStart?: (workspaceId: string, goalVersion: number) => Promise<void>
  /** The verifier's answer per round (`--verification-rounds-base64`); absent, everything passes. */
  readonly verificationRounds?: readonly (readonly object[])[]
  readonly verificationRoundCap?: number
  /** How many times the fixture's smoke script fails before it passes (default 0). */
  readonly smokeFailures?: number
  /** Extra fields merged into a package worker's `<slave-report>`; `attempt` counts the package's earlier implementation runs. */
  readonly reportExtras?: (packageKey: string, goalVersion: number, attempt: number) => object | undefined
  /** The batched answer call's reply, by prompt; absent, the fake refuses it (and the test counts it). */
  readonly conductorAnswers?: (prompt: string) => string
}

/** A conducted workspace with its goal set, the backend template's managed pool, a reviewer seat,
 *  the injected conductor and a routed `m8-flow` fake whose every work run ends with its report. */
async function seed(options: SeedOptions = {}): Promise<Fixture> {
  await syncCapabilityTaxonomy()
  await prisma.slaveTemplate.create({
    data: { id: 't-backend', name: 'Backend Developer', role: 'backend', description: 'x', active: true, capabilityKeys: [] },
  })
  await syncPersonPool()
  const repoPath = makeRepo(smokeScript(join(mkdtempSync(join(tmpdir(), 'e2e-smoke-')), 'count'), options.smokeFailures ?? 0))
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Report Modes E2E',
      repoPath,
      baseBranch: 'main',
      verifyCommands: ['true'],
      setupCommands: [],
      delivery: 'conducted',
      // Merged for real, so "merged" means the base branch has the worker's commit.
      autoMerge: options.autoMerge ?? true,
      ...(options.verificationRoundCap === undefined ? {} : { verificationRoundCap: options.verificationRoundCap }),
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

  const starts: Start[] = []
  const hook = options.onImplementationStart
  const adapter = routingAdapter(() => repoPath, starts, async (goalVersion) => {
    if (hook !== undefined) await hook(workspace.id, goalVersion)
  }, options.verificationRounds, options.reportExtras)
  const { decider, others } = scripted(options.conductAnswer ?? SINGLE, options.conductorAnswers)
  return {
    workspaceId: workspace.id,
    repoPath,
    initialTip: git(['rev-parse', 'main'], repoPath),
    others,
    starts,
    deps: {
      workspaceId: brandWorkspaceId(workspace.id),
      registry: { resolve: () => adapter },
      supervisorDecider: decider,
      supervisorModel: 'claude-sonnet-5',
    },
  }
}

/** Ticks, letting every pump finish between ticks, until `done` holds -- bounded, so a flow that
 *  never gets there fails instead of hanging. `after` runs after every tick (an invariant check). */
async function tickUntil(f: Fixture, done: () => Promise<boolean>, after?: () => Promise<void>): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await tick(f.deps)
    await drainPumps()
    if (after !== undefined) await after()
    if (await done()) return
  }
  throw new Error('tickUntil: the condition never held')
}

type Delivery = NonNullable<Awaited<ReturnType<typeof prisma.goalDelivery.findUnique>>>

async function delivery(f: Fixture, goalVersion: number): Promise<Delivery | null> {
  return prisma.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId: f.workspaceId, goalVersion } } })
}

const merged = (f: Fixture, goalVersion: number) => async (): Promise<boolean> => (await delivery(f, goalVersion))?.mergedAt != null

/** The workspace's goal-delivery events, oldest first, as `type` + payload. */
async function goalEvents(f: Fixture): Promise<{ readonly type: string; readonly payload: unknown }[]> {
  const rows = await prisma.executionEvent.findMany({
    where: {
      workspaceId: f.workspaceId,
      type: {
        in: [
          'workspace_goal_accepted',
          'workspace_goal_merged',
          'workspace_goal_waiting',
          'workspace_goal_abandoned',
          'workspace_goal_needs_human',
          'workspace_goal_retried',
        ],
      },
    },
    orderBy: { seq: 'asc' },
    select: { type: true, payload: true },
  })
  return rows.map((row) => ({ type: DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type, payload: row.payload }))
}

/** The Supervisor chat's goal-report notes (Conductor Plan 5, D10), oldest first. */
async function reportNotes(f: Fixture): Promise<{ readonly noteKey: string | null; readonly text: string }[]> {
  return prisma.supervisorMessage.findMany({ where: { workspaceId: f.workspaceId, noteKey: { not: null } }, orderBy: { seq: 'asc' }, select: { noteKey: true, text: true } })
}

const filesOn = (f: Fixture, ref: string): string[] => git(['ls-tree', '-r', '--name-only', ref], f.repoPath).split('\n')

/** The verification worktrees still on disk under the repository's worktree root. */
function verifyWorktrees(f: Fixture): string[] {
  const root = worktreeRootFor(f.repoPath)
  return existsSync(root) ? readdirSync(root).filter((name) => name.startsWith('verify-')) : []
}

/** The implementation runs of the package `key`'s task, in the order they were spawned, with the
 *  prompt each was given. Every one of them was spawned through the routing adapter (checked). */
async function implementationRunsOf(f: Fixture, key: string): Promise<Start[]> {
  const task = await prisma.task.findFirstOrThrow({ where: { workspaceId: f.workspaceId, workPackage: { key } } })
  const ids = (await prisma.slaveRun.findMany({ where: { taskId: task.id, kind: 'implementation' }, select: { id: true } })).map((run) => run.id)
  const started = f.starts.filter((s) => ids.includes(s.runId))
  expect(started).toHaveLength(ids.length)
  return started
}

/** The `task.rework` events that verification sent, as `{ package key, verificationRound }`. */
async function verificationReworks(f: Fixture): Promise<{ readonly key: string; readonly round: unknown }[]> {
  const rows = await prisma.executionEvent.findMany({
    where: { workspaceId: f.workspaceId, type: 'task_rework' },
    orderBy: { seq: 'asc' },
    select: { payload: true, taskId: true },
  })
  const tasks = await prisma.task.findMany({ where: { workspaceId: f.workspaceId }, select: { id: true, workPackage: { select: { key: true } } } })
  const keyOf = (taskId: string | null): string => tasks.find((task) => task.id === taskId)?.workPackage?.key ?? ''
  return rows
    .filter((row) => (row.payload as { verificationRound?: number }).verificationRound !== undefined)
    .map((row) => ({ key: keyOf(row.taskId), round: (row.payload as { verificationRound?: number }).verificationRound }))
}

const status = (f: Fixture, goalVersion: number, wanted: string) => async (): Promise<boolean> => (await delivery(f, goalVersion))?.status === wanted

describe('conductor end to end', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SmokeAttempt", "PackageHandOff", "GoalDecision", "ConductorCall", "RequirementSet", "WorkPackage", "GoalDelivery", "RunReport", "SupervisorDecision", "SlaveMessage", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "GoalVersion", "ProviderConfiguration", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
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

  it('takes a conducted goal from requirements to a reported package, through its integration branch into the base branch', async (): Promise<void> => {
    const f = await seed()
    await tickUntil(f, merged(f, 1))
    const packageTask = await prisma.task.findFirstOrThrow({ where: { workspaceId: f.workspaceId, workPackageId: { not: null } } })
    expect(packageTask.status).toBe('done')

    // The requirement set for v1, and the size decision recorded.
    const set = await prisma.requirementSet.findUniqueOrThrow({
      where: { workspaceId_goalVersion: { workspaceId: f.workspaceId, goalVersion: 1 } },
    })
    expect((set.items as { key: string }[]).map((i) => i.key)).toEqual(['R1', 'R2', 'RUN'])
    const decision = await prisma.supervisorDecision.findFirstOrThrow({ where: { workspaceId: f.workspaceId, situationKind: 'conduct' } })
    expect(decision.rationale).toContain('fits one session')
    const packages = await prisma.workPackage.findMany({ where: { workspaceId: f.workspaceId } })
    expect(packages).toEqual([expect.objectContaining({ goalVersion: 1, requirementKeys: ['R1', 'R2', 'RUN'], templateId: 't-backend' })])

    // The package task: pinned to a package-worker seat, ready -> running -> ... -> done.
    const seat = await prisma.slave.findUniqueOrThrow({ where: { id: packageTask.assigneeId ?? '' } })
    expect(seat.runtimeRoles).toContain(PACKAGE_WORKER_ROLE)
    const events = await prisma.executionEvent.findMany({ where: { taskId: packageTask.id }, orderBy: { seq: 'asc' }, select: { type: true } })
    const types = events.map((row) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type)
    expect(types).toEqual(expect.arrayContaining(['task.started', 'task.verify_passed', 'task.review_approved', 'task.done']))
    expect(types.indexOf('task.started')).toBeLessThan(types.indexOf('task.done'))

    // The goal version's delivery: cut from main as it was, accepted, merged once.
    const d1 = await delivery(f, 1)
    expect(d1).toEqual(
      expect.objectContaining({
        status: 'accepted',
        integrationBranch: integrationBranchName(1, f.workspaceId),
        baseCommit: f.initialTip,
        mergeError: null,
      }),
    )
    expect(d1?.acceptedAt).not.toBeNull()
    expect(d1?.mergedAt).not.toBeNull()
    const branch = d1?.integrationBranch ?? ''
    // The worker's commit is on the integration branch AND on main, and main is exactly that branch
    // (the final merge is a fast-forward from the commit it was cut at).
    expect(filesOn(f, branch)).toContain('m8a-work.txt')
    expect(filesOn(f, 'main')).toContain('m8a-work.txt')
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(git(['rev-parse', branch], f.repoPath))
    // Nothing reached main while the package was worked on and reviewed.
    expect(f.starts.map((s) => s.mainTip)).toEqual(f.starts.map(() => f.initialTip))

    // Plan 4b: accepted only by a verification run that passed every requirement, on exactly the
    // tip that reached main; its checkout is gone.
    const verification = await prisma.slaveRun.findFirstOrThrow({ where: { kind: 'verification', goalDeliveryId: d1?.id ?? '' } })
    expect(verification).toMatchObject({ status: 'succeeded', taskId: null })
    expect(d1?.verifiedCommit).toBe(git(['rev-parse', 'main'], f.repoPath))
    expect(await prisma.verificationResult.findMany({ where: { runId: verification.id }, select: { key: true, status: true }, orderBy: { key: 'asc' } })).toEqual([
      { key: 'R1', status: 'pass' },
      { key: 'R2', status: 'pass' },
      { key: 'RUN', status: 'pass' },
    ])
    const verified = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_verified' } })
    expect(verified.map((event) => event.payload)).toEqual([
      { version: 1, round: 1, runId: verification.id, pass: 3, fail: 0, unverifiable: 0, failedKeys: [] },
    ])
    expect(git(['worktree', 'list'], f.repoPath)).not.toContain('verify-')
    expect(verifyWorktrees(f)).toEqual([])
    // Plan B: one smoke, passed in round 1 at the tip that was verified; the verifier was handed its output.
    const smokes = await prisma.smokeAttempt.findMany({ where: { goalDeliveryId: d1?.id ?? '' } })
    expect(smokes.map((a) => [a.round, a.status])).toEqual([[1, 'passed']])
    expect(smokes[0]?.tip).toBe(d1?.verifiedCommit)
    expect(f.starts.find((s) => s.kind === 'verification')?.prompt).toContain('flow ok')
    // By a seat that implemented nothing in this version and holds `verifier`, which left one check
    // per requirement in its own scratch directory, outside the repository.
    expect(verification.slaveId).not.toBe(packageTask.assigneeId)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: verification.slaveId } })).runtimeRoles).toContain(VERIFIER_ROLE)
    const verifierStart = f.starts.find((s) => s.runId === verification.id)
    expect(verifierStart?.prompt).toContain('Verification round 1 of goal v1.')
    expect(readdirSync(join(verifierStart?.runDir ?? '', 'verify')).sort()).toEqual(['check-R1.sh', 'check-R2.sh', 'check-RUN.sh'])
    expect(filesOn(f, 'main').filter((file) => file.startsWith('check-'))).toEqual([])

    // Accepted, then merged -- each once.
    const goal = await goalEvents(f)
    expect(goal.map((e) => e.type)).toEqual(['workspace.goal_accepted', 'workspace.goal_merged'])
    expect(goal[0]?.payload).toEqual({ version: 1, rounds: 1 })
    expect(goal[1]?.payload).toEqual(
      expect.objectContaining({ version: 1, branch, into: 'main', commit: git(['rev-parse', 'main'], f.repoPath), by: 'system' }),
    )

    // The worker's report, filed for its run.
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: packageTask.id, kind: 'implementation', status: 'succeeded' } })
    const report = await prisma.runReport.findFirstOrThrow({ where: { taskId: packageTask.id } })
    expect(report.runId).toBe(run.id)
    expect((report.report as { requirements: { key: string }[] }).requirements.map((r) => r.key)).toEqual(['R1', 'R2', 'RUN'])

    const runContextRow = await prisma.runContext.findFirstOrThrow({ where: { run: { kind: 'implementation' } } })
    expect(runContextRow.prompt).toContain('`bash scripts/smoke.sh`')

    // The planner stayed out, and the conductor's two calls are in the spend.
    expect(await prisma.slaveRun.count({ where: { kind: 'planning' } })).toBe(0)
    expect(await prisma.conductorCall.count({ where: { workspaceId: f.workspaceId, outcome: 'ok' } })).toBe(2)
    const spend = await workspaceSpend(f.workspaceId)
    expect(spend.conductorMeasuredUsd).toBeCloseTo(0.05, 6)
    expect(spend.spentUsd).toBeGreaterThanOrEqual(0.05)
    expect(f.others).toEqual([])

    // Conductor Plan 5 (spec R10, §7): the version's report, from what was recorded.
    const goalReport = await loadGoalReport(f.workspaceId, 1)
    expect(goalReport.ok).toBe(true)
    if (!goalReport.ok) return
    const r = goalReport.value
    expect(r.state).toBe('merged')
    expect(r.delivery?.merge).toEqual({ by: 'system', commit: git(['rev-parse', 'main'], f.repoPath), into: 'main' })
    expect(r.requirements?.map((item) => [item.key, item.verdict?.status, item.packageKey])).toEqual([
      ['R1', 'pass', packages[0]?.key],
      ['R2', 'pass', packages[0]?.key],
      ['RUN', 'pass', packages[0]?.key],
    ])
    expect(r.requirements?.[1]?.verdict).toEqual(expect.objectContaining({ round: 1, runId: verification.id, check: 'pytest -k R2', output: '1 passed' }))
    expect(r.rounds).toEqual([expect.objectContaining({ round: 1, runId: verification.id, pass: 3, fail: 0, unverifiable: 0, commit: d1?.verifiedCommit })])
    expect(r.packages).toHaveLength(1)
    // Git's own list at the package's merge, next to the worker's claim.
    expect(r.packages[0]?.mergedFiles).toEqual(['m8a-work.txt'])
    expect(r.packages[0]?.reportedFiles).toEqual(['m8a-work.txt'])
    expect(r.packages[0]?.seat).toBe((await prisma.person.findUniqueOrThrow({ where: { id: seat.personId ?? '' } })).name)
    expect(r.decision).toEqual(expect.objectContaining({ mode: 'single', decidedBy: 'model', fallback: false }))
    expect(r.decision?.reason).toContain('fits one session')
    expect(r.spend.conductorMeasuredUsd).toBeCloseTo(0.05, 6)
    expect(r.spend.projectSpentUsd).toBeCloseTo(spend.spentUsd, 6)
    expect(r.spend.versionUsd).toBeGreaterThanOrEqual(0.05)
    expect(r.spend.projectBudgetUsd).toBe((await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })).budgetUsd)
    expect(r.trail.length).toBeGreaterThan(0)
    expect(r.trailOmitted).toBe(0)
    // Merged by the goal pass as the verified commit, every run finished, every file recorded:
    // nothing left to caveat.
    expect(reportCaveats(r)).toEqual([])
    const md = renderGoalReportMarkdown(r)
    expect(md).toContain('| R1 |')
    expect(md).toContain('### Evidence for R2')
    expect(md).toContain('m8a-work.txt')
    expect(md).toContain('| Conductor calls | $0.05 |')
    expect(md).toMatch(/\| Project so far \| \$[0-9.]+ of a \$20(\.00)? budget \|/)
    expect(md.endsWith('\n')).toBe(true)
    // Deterministic across two reads of the same rows (plan D7).
    const again = await loadGoalReport(f.workspaceId, 1)
    expect(again.ok && renderGoalReportMarkdown(again.value)).toBe(md)
    // ... and the Supervisor chat's last word about it, posted on the tick it merged.
    const notes = await reportNotes(f)
    expect(notes.map((n) => n.noteKey)).toEqual(['goal-report:v1:merged'])
    expect(notes[0]?.text).toContain('Goal v1 report: merged into main')
    expect(notes[0]?.text).toContain('the verified commit')
    expect(notes[0]?.text).toContain('Requirements: 3 of 3 pass (round 1).')
    expect((await delivery(f, 1))?.reportNotedKey).toBe('merged')
  })

  it('the packages flow still reviews: a conducted goal in a project that is not in the lead flow takes none of the lead flow\'s paths', async (): Promise<void> => {
    const f = await seed()
    await tickUntil(f, merged(f, 1))

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })
    expect(workspace.flow).toBe('packages')
    // The size decision was the model's, the package was reviewed, and its branch went through the merge pass.
    expect((await prisma.conductorCall.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { createdAt: 'asc' }, select: { stage: true } })).map((c) => c.stage)).toEqual(['requirements', 'conduct'])
    expect(await prisma.slaveRun.count({ where: { kind: 'review' } })).toBeGreaterThan(0)
    const types = (await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId }, select: { type: true } })).map((row) => row.type)
    for (const present of ['task_verify_passed', 'task_review_started', 'task_review_approved']) expect(types).toContain(present)
    for (const absent of ['workspace_lead_state', 'workspace_lead_noted']) expect(types).not.toContain(absent)
    expect(await prisma.runReport.count()).toBe(1)

    // No run was a lead turn, a confirmation or a partial round, and none was spawned with the lead's extras.
    const runs = await prisma.slaveRun.findMany({ select: { leadTurn: true, leadResumed: true, confirmsRunId: true, verificationKeys: true } })
    expect(runs.every((run) => run.leadTurn === null && !run.leadResumed && run.confirmsRunId === null && run.verificationKeys.length === 0)).toBe(true)
    // The run directories are still there, so an empty read means no extras file was written.
    for (const start of f.starts) expect(existsSync(start.runDir)).toBe(true)
    for (const start of f.starts) expect(readSpawnExtras(start.runDir)).toEqual({})
    for (const start of f.starts) expect(start.prompt).not.toContain('you are the lead of this goal')

    const row = await delivery(f, 1)
    expect([row?.leadState, row?.stopReason, row?.leadProgress]).toEqual([null, null, null])
  })

  it('sends a partitioned goal whose smoke fails back to integration, then accepts it with RUN verified', async (): Promise<void> => {
    const f = await seed({ conductAnswer: PARTITIONED, smokeFailures: 1 })
    await tickUntil(f, merged(f, 1))
    const d1 = await delivery(f, 1)
    const attempts = await prisma.smokeAttempt.findMany({ where: { goalDeliveryId: d1?.id ?? '' }, orderBy: { startedAt: 'asc' } })
    expect(attempts.map((a) => [a.round, a.status])).toEqual([[1, 'failed'], [2, 'passed']])
    const integration = await implementationRunsOf(f, 'integration')
    expect(integration).toHaveLength(2)
    expect(integration[1]?.prompt).toContain('The smoke check of verification round 1 failed')
    expect(integration[1]?.prompt).toContain('Missing script: "start"')
    expect(await implementationRunsOf(f, 'skeleton')).toHaveLength(1)
    expect(await implementationRunsOf(f, 'report')).toHaveLength(1)
    // One verification run, in round 2, after the passing smoke.
    const verifications = f.starts.filter((s) => s.kind === 'verification')
    expect(verifications.map((s) => /Verification round (\d+)/.exec(s.prompt)?.[1])).toEqual(['2'])
    expect(verifications[0]?.prompt).toContain('flow ok')
    expect((await goalEvents(f)).find((e) => e.type === 'workspace.goal_accepted')?.payload).toEqual({ version: 1, rounds: 2 })
    expect(await prisma.verificationResult.findFirst({ where: { key: 'RUN' }, select: { status: true } })).toEqual({ status: 'pass' })
    const report = await loadGoalReport(f.workspaceId, 1)
    expect(report.ok && report.value.smoke.map((s) => [s.round, s.outcome, s.reworkedPackage])).toEqual([[1, 'failed', 'integration'], [2, 'passed', null]])
    // The fake's integration report names no handOff (plan B D11): nothing went to the skeleton.
    expect(report.ok && report.value.smoke.map((s) => s.handOff)).toEqual([null, null])
    expect(verifyWorktrees(f)).toEqual([])
  })

  it('cuts a dependent package from the integration branch after its dependency merged there; main gets both only at the final merge', async (): Promise<void> => {
    const f = await seed({ conductAnswer: DEPENDENT })
    await tickUntil(f, merged(f, 1))

    const packages = await prisma.workPackage.findMany({ where: { workspaceId: f.workspaceId }, include: { tasks: true }, orderBy: { key: 'asc' } })
    expect(packages.map((p) => p.key)).toEqual(['config', 'integration', 'report', 'skeleton'])
    const taskOf = (key: string): string => packages.find((p) => p.key === key)?.tasks[0]?.id ?? ''
    const configDeps = await prisma.taskDependency.findMany({ where: { taskId: taskOf('config') }, select: { dependsOnTaskId: true } })
    expect(configDeps).toEqual(expect.arrayContaining([{ dependsOnTaskId: taskOf('report') }, { dependsOnTaskId: taskOf('skeleton') }]))
    expect(configDeps).toHaveLength(2)
    expect(packages.every((p) => p.tasks[0]?.status === 'done')).toBe(true)

    const startOf = (key: string): Start | undefined => f.starts.find((s) => s.kind === 'implementation' && s.packageKey === key)
    // `report` was cut before any package merged: no csv.py anywhere yet.
    expect(startOf('skeleton')?.mainTip).toBe(f.initialTip)
    expect(f.starts.findIndex((s) => s.packageKey === 'skeleton')).toBe(0)
    expect(startOf('report')?.worktreeFiles).not.toContain('src/report/csv.py')
    // `config` was cut from the integration branch after `report` merged into it: its worktree has
    // report's file at dispatch time, while main does not.
    expect(startOf('config')?.worktreeFiles).toContain('src/report/csv.py')
    expect(startOf('config')?.mainFiles).not.toContain('src/report/csv.py')
    // The integration package sees both packages' work; main still has neither.
    expect(startOf('integration')?.worktreeFiles).toContain('src/report/csv.py')
    expect(startOf('integration')?.configSource).not.toBe(ORIGINAL_SOURCE)
    expect(startOf('integration')?.mainFiles).not.toContain('src/report/csv.py')
    // Nothing reached main until the final merge.
    expect(f.starts.length).toBeGreaterThanOrEqual(3)
    expect(f.starts.map((s) => s.mainTip)).toEqual(f.starts.map(() => f.initialTip))

    // The final merge lands all three at once, as the integration branch's exact tip.
    const d1 = await delivery(f, 1)
    const branch = d1?.integrationBranch ?? ''
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(git(['rev-parse', branch], f.repoPath))
    expect(filesOn(f, 'main')).toEqual(expect.arrayContaining(['src/report/csv.py', 'wiring.txt']))
    expect(git(['show', 'main:src/config.py'], f.repoPath)).not.toBe(ORIGINAL_SOURCE.trim())
    expect((await goalEvents(f)).map((e) => e.type)).toEqual(['workspace.goal_accepted', 'workspace.goal_merged'])
    expect(f.others).toEqual([])

    // Conductor Plan 5: the report names every package, each with the files git says its merge
    // into the integration branch changed -- its own file, not its dependency's.
    const report = await loadGoalReport(f.workspaceId, 1)
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.value.state).toBe('merged')
    expect(report.value.packages.map((p) => [p.key, p.isIntegration, p.dependsOn])).toEqual([
      ['config', false, ['skeleton', 'report']],
      ['integration', true, ['skeleton', 'report', 'config']],
      ['report', false, ['skeleton']],
      ['skeleton', false, []],
    ])
    const files = (key: string): readonly string[] | null => report.value.packages.find((p) => p.key === key)?.mergedFiles ?? null
    expect(files('report')).toEqual(['src/report/csv.py'])
    expect(files('config')).toEqual(['src/config.py'])
    expect(files('integration')).toEqual(['wiring.txt'])
    expect(files('skeleton')).toEqual(['scripts/verify.d/skeleton.sh'])
    expect(report.value.requirements?.map((r) => [r.key, r.packageKey, r.verdict?.status])).toEqual([
      ['R1', 'report', 'pass'],
      ['R2', 'config', 'pass'],
      ['RUN', 'integration', 'pass'],
    ])
    expect(report.value.decision).toEqual(expect.objectContaining({ mode: 'partitioned', reason: 'config builds on the report modes' }))
    const md = renderGoalReportMarkdown(report.value)
    expect(md).toContain('src/report/csv.py')
    expect(md).toContain('wiring.txt')
    const again = await loadGoalReport(f.workspaceId, 1)
    expect(again.ok && renderGoalReportMarkdown(again.value)).toBe(md)
    const notes = await reportNotes(f)
    expect(notes.map((n) => n.noteKey)).toEqual(['goal-report:v1:merged'])
    expect(notes[0]?.text).toContain('Packages: config (')
  })

  it('conducts the next goal version from main as the previous one left it', async (): Promise<void> => {
    const f = await seed()
    await tickUntil(f, merged(f, 1))
    const d1 = await delivery(f, 1)
    const v1Tip = git(['rev-parse', 'main'], f.repoPath)
    expect(v1Tip).toBe(git(['rev-parse', d1?.integrationBranch ?? ''], f.repoPath))

    const goal = await setGoal(f.workspaceId, 'Add a CSV mode. Add a JSON mode. Keep both fast.')
    expect(goal.ok).toBe(true)
    await tickUntil(f, merged(f, 2))

    const d2 = await delivery(f, 2)
    expect(d2).toEqual(expect.objectContaining({ status: 'accepted', integrationBranch: integrationBranchName(2, f.workspaceId), baseCommit: v1Tip }))
    expect(d2?.mergedAt).not.toBeNull()
    // v2's worker was cut from main's new tip: it had v1's work before it wrote anything.
    const v2Start = f.starts.find((s) => s.kind === 'implementation' && s.goalVersion === 2)
    expect(v2Start?.worktreeFiles).toContain('m8a-work.txt')
    expect(v2Start?.worktreeFiles).not.toContain('m8a-work-v2.txt')
    expect(filesOn(f, 'main')).toEqual(expect.arrayContaining(['m8a-work.txt', 'm8a-work-v2.txt']))
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(git(['rev-parse', d2?.integrationBranch ?? ''], f.repoPath))

    const goalTypes = (await goalEvents(f)).map((e) => e.type)
    expect(goalTypes).toEqual(['workspace.goal_accepted', 'workspace.goal_merged', 'workspace.goal_accepted', 'workspace.goal_merged'])
    expect(f.others).toEqual([])
  })

  it('holds the next goal version, conducted and dispatching nothing, while the previous one is still being worked on', async (): Promise<void> => {
    let v2Set: { readonly v1TaskStatus: string; readonly v1Delivery: string } | null = null
    const f = await seed({
      // Set v2 the moment v1's worker is spawned: v1 is running, not merely accepted.
      onImplementationStart: async (workspaceId, goalVersion) => {
        if (goalVersion !== 1 || v2Set !== null) return
        const task = await prisma.task.findFirstOrThrow({ where: { workspaceId, goalVersion: 1, workPackageId: { not: null } } })
        const d1 = await prisma.goalDelivery.findUniqueOrThrow({ where: { workspaceId_goalVersion: { workspaceId, goalVersion: 1 } } })
        const goal = await setGoal(workspaceId, 'Add a CSV mode. Add a JSON mode. Keep both fast.')
        if (!goal.ok) throw new Error('v2 was refused')
        v2Set = { v1TaskStatus: task.status, v1Delivery: d1.status }
      },
    })

    // Until v1 is on main, v2 has no package, no task, and no run.
    const v2Held = async (): Promise<void> => {
      if ((await delivery(f, 1))?.mergedAt != null) return
      expect(await prisma.workPackage.count({ where: { workspaceId: f.workspaceId, goalVersion: 2 } })).toBe(0)
      expect(await prisma.task.count({ where: { workspaceId: f.workspaceId, goalVersion: 2 } })).toBe(0)
      expect(await prisma.requirementSet.count({ where: { workspaceId: f.workspaceId, goalVersion: 2 } })).toBe(0)
    }
    await tickUntil(f, merged(f, 2), v2Held)

    expect(v2Set).toEqual({ v1TaskStatus: 'running', v1Delivery: 'integrating' })
    // Said once, naming what it waits on.
    const waiting = (await goalEvents(f)).filter((e) => e.type === 'workspace.goal_waiting')
    expect(waiting.map((e) => e.payload)).toEqual([{ version: 2, waitingOn: 1 }])
    // v2's worker was dispatched only once v1 was on main, and was cut from main's new tip.
    const d1 = await delivery(f, 1)
    const d2 = await delivery(f, 2)
    const v1Tip = git(['rev-parse', d1?.integrationBranch ?? ''], f.repoPath)
    expect(d2?.baseCommit).toBe(v1Tip)
    const v2Starts = f.starts.filter((s) => s.goalVersion === 2)
    expect(v2Starts.length).toBeGreaterThan(0)
    expect(v2Starts.every((s) => s.mainFiles.includes('m8a-work.txt'))).toBe(true)
    expect(v2Starts.find((s) => s.kind === 'implementation')?.worktreeFiles).toContain('m8a-work.txt')
    expect(filesOn(f, 'main')).toEqual(expect.arrayContaining(['m8a-work.txt', 'm8a-work-v2.txt']))
    expect(f.others).toEqual([])
  })

  it('with autoMerge off, holds the next goal version behind an accepted one until a person merges it and confirms', async (): Promise<void> => {
    const f = await seed({ autoMerge: false })
    await tickUntil(f, async () => (await delivery(f, 1))?.status === 'accepted')
    // A few more ticks: accepted is where it stays.
    for (let i = 0; i < 2; i += 1) {
      await tick(f.deps)
      await drainPumps()
    }
    const d1 = await delivery(f, 1)
    expect(d1?.mergedAt).toBeNull()
    expect(filesOn(f, 'main')).not.toContain('m8a-work.txt')
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(f.initialTip)
    // Conductor Plan 5: verified and waiting for a person is a resting point -- one note, telling
    // them how to land it; the report says accepted.
    const waiting = await reportNotes(f)
    expect(waiting.map((n) => n.noteKey)).toEqual(['goal-report:v1:awaiting_merge:r1:hand'])
    expect(waiting[0]?.text).toContain('it waits for you')
    expect(waiting[0]?.text).toContain('confirm-goal-merge')
    const accepted = await loadGoalReport(f.workspaceId, 1)
    expect(accepted.ok && accepted.value.state).toBe('accepted')
    expect(accepted.ok && reportCaveats(accepted.value)).toEqual([])

    expect((await setGoal(f.workspaceId, 'Add a CSV mode. Add a JSON mode. Keep both fast.')).ok).toBe(true)
    for (let i = 0; i < 3; i += 1) {
      await tick(f.deps)
      await drainPumps()
    }
    expect((await goalEvents(f)).filter((e) => e.type === 'workspace.goal_waiting').map((e) => e.payload)).toEqual([{ version: 2, waitingOn: 1 }])
    expect(await prisma.workPackage.count({ where: { workspaceId: f.workspaceId, goalVersion: 2 } })).toBe(0)
    expect(await prisma.task.count({ where: { workspaceId: f.workspaceId, goalVersion: 2 } })).toBe(0)

    // The person merges by hand and says so.
    git(['merge', '--no-edit', '--no-ff', d1?.integrationBranch ?? ''], f.repoPath)
    const handTip = git(['rev-parse', 'main'], f.repoPath)
    const confirmed = await confirmGoalMerge(f.workspaceId, 1)
    expect(confirmed).toEqual({ ok: true, value: { commit: handTip } })

    await tickUntil(f, async () => (await delivery(f, 2))?.status === 'accepted')
    const d2 = await delivery(f, 2)
    expect(d2?.baseCommit).toBe(handTip)
    expect(d2?.mergedAt).toBeNull()
    expect(f.starts.find((s) => s.kind === 'implementation' && s.goalVersion === 2)?.worktreeFiles).toContain('m8a-work.txt')
    expect((await goalEvents(f)).filter((e) => e.type === 'workspace.goal_waiting')).toHaveLength(1)
    expect(f.others).toEqual([])

    // The hand merge is v1's next resting point, and v2 waits in turn. The person's `--no-ff`
    // merge commit is not the verified commit: the note and the report say so. v2 was accepted by a
    // pump after the last tick, so its note is the next tick's.
    await tick(f.deps)
    await drainPumps()
    const notes = await reportNotes(f)
    expect(notes.map((n) => n.noteKey)).toEqual(['goal-report:v1:awaiting_merge:r1:hand', 'goal-report:v1:merged', 'goal-report:v2:awaiting_merge:r1:hand'])
    expect(notes[1]?.text).toContain('by a person')
    expect(notes[1]?.text).toContain('that tree was not itself verified')
    const v1 = await loadGoalReport(f.workspaceId, 1)
    expect(v1.ok && v1.value.delivery?.merge).toEqual({ by: 'human', commit: handTip, into: 'main' })
    expect(v1.ok && reportCaveats(v1.value).some((c) => c.includes('by hand') && c.includes('was not itself verified'))).toBe(true)
  })

  it('reworks only the package whose requirement failed verification, verifies again, and lands the verified tip', async (): Promise<void> => {
    const f = await seed({
      conductAnswer: PARTITIONED,
      verificationRounds: [
        [checked('R1', 'pass'), checked('R2', 'fail'), checked('RUN', 'pass')],
        [checked('R1', 'pass'), checked('R2', 'pass'), checked('RUN', 'pass')],
      ],
    })
    await tickUntil(f, merged(f, 1))

    // `config` owns R2: it ran twice, and its second run was told what round 1 found. `report` owns
    // R1, which passed: it ran once. The integration package owns no requirement: once.
    const config = await implementationRunsOf(f, 'config')
    expect(config).toHaveLength(2)
    expect(config[0]?.prompt).not.toContain('Verification round 1')
    expect(config[1]?.prompt).toContain('Verification round 1 found requirement(s) your package owns not met.')
    expect(config[1]?.prompt).toContain('R2 prints nothing')
    expect(await implementationRunsOf(f, 'report')).toHaveLength(1)
    expect(await implementationRunsOf(f, 'integration')).toHaveLength(1)
    expect(await implementationRunsOf(f, 'skeleton')).toHaveLength(1)
    expect(await verificationReworks(f)).toEqual([{ key: 'config', round: 1 }])
    const configTask = await prisma.task.findFirstOrThrow({ where: { workspaceId: f.workspaceId, workPackage: { key: 'config' } } })
    expect(configTask.status).toBe('done')

    // Two rounds, each with its own run and evidence; the second passed everything.
    const d1 = await delivery(f, 1)
    const runs = await prisma.slaveRun.findMany({ where: { kind: 'verification', goalDeliveryId: d1?.id ?? '' }, select: { id: true } })
    expect(runs).toHaveLength(2)
    const verified = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_verified' }, orderBy: { seq: 'asc' } })
    expect(verified.map((event) => event.payload)).toEqual([
      expect.objectContaining({ version: 1, round: 1, pass: 2, fail: 1, failedKeys: ['R2'] }),
      expect.objectContaining({ version: 1, round: 2, pass: 3, fail: 0, failedKeys: [] }),
    ])
    expect(await prisma.verificationResult.count({ where: { runId: { in: runs.map((run) => run.id) } } })).toBe(6)
    expect(f.starts.filter((s) => s.kind === 'verification').map((s) => /Verification round (\d+)/.exec(s.prompt)?.[1])).toEqual(['1', '2'])

    // Accepted after two rounds, and exactly the verified commit reached main, with both packages' work.
    expect(d1).toEqual(expect.objectContaining({ status: 'accepted', mergeError: null }))
    const goal = await goalEvents(f)
    expect(goal.map((e) => e.type)).toEqual(['workspace.goal_accepted', 'workspace.goal_merged'])
    expect(goal[0]?.payload).toEqual({ version: 1, rounds: 2 })
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(d1?.verifiedCommit)
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(git(['rev-parse', d1?.integrationBranch ?? ''], f.repoPath))
    expect(filesOn(f, 'main')).toContain('src/report/csv.py')
    expect(git(['show', 'main:src/config.py'], f.repoPath)).not.toBe(ORIGINAL_SOURCE.trim())
    // Nothing reached main before the final merge, and no verification checkout is left.
    expect(f.starts.map((s) => s.mainTip)).toEqual(f.starts.map(() => f.initialTip))
    expect(verifyWorktrees(f)).toEqual([])
    expect(f.others).toEqual([])
  })

  it('stops for a person when a requirement cannot be checked, escalates it, and accepts once a retry verifies it', async (): Promise<void> => {
    const f = await seed({
      verificationRounds: [
        [checked('R1', 'pass'), checked('R2', 'unverifiable'), checked('RUN', 'pass')],
        [checked('R1', 'pass'), checked('R2', 'pass'), checked('RUN', 'pass')],
      ],
    })
    await tickUntil(f, status(f, 1, 'needs_human'))

    // Stopped at once (another round would ask the same question), naming the key and why; nothing
    // reworked, nothing merged, the evidence kept, the checkout gone.
    const stopped = await delivery(f, 1)
    expect(stopped).toEqual(expect.objectContaining({ status: 'needs_human', round: 1, activeRunId: null, verifiedCommit: null, mergedAt: null }))
    expect(stopped?.needsHumanReason).toContain('R2')
    expect(stopped?.needsHumanReason).toContain('needs a network this checkout lacks')
    expect(await verificationReworks(f)).toEqual([])
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(f.initialTip)
    expect(await prisma.verificationResult.findMany({ where: { status: 'unverifiable' }, select: { key: true, reason: true } })).toEqual([
      { key: 'R2', reason: 'R2 needs a network this checkout lacks' },
    ])
    expect(verifyWorktrees(f)).toEqual([])

    // The Supervisor's world raises it for a person, keyed by the version and round.
    const { world } = await loadSupervisorWorld(f.workspaceId, new Date())
    expect(observe(world).filter((s) => s.kind === 'goal_needs_human').map((s) => s.subjectId)).toEqual([`${f.workspaceId}:v1:r1`])

    // A few more ticks change nothing: it waits for the person.
    for (let i = 0; i < 2; i += 1) {
      await tick(f.deps)
      await drainPumps()
    }
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(1)
    expect((await delivery(f, 1))?.status).toBe('needs_human')
    expect((await reportNotes(f)).map((n) => n.noteKey)).toEqual(['goal-report:v1:needs_human:r1'])
    const atStop = await loadGoalReport(f.workspaceId, 1)
    expect(atStop.ok && atStop.value.state).toBe('needs_human')
    expect(atStop.ok && reportCaveats(atStop.value)).toEqual(['The verifier could not check R2; the version cannot be accepted until it is.'])

    // The person retries: the unchanged tree is verified again (round 2), and this time it passes.
    expect(await prisma.smokeAttempt.count()).toBe(1)
    expect(await retryGoal(f.workspaceId, 1)).toEqual(expect.objectContaining({ ok: true }))
    await tickUntil(f, merged(f, 1))
    // Plan B D5: the unchanged tree was not smoked again.
    expect(await prisma.smokeAttempt.count()).toBe(1)
    const d1 = await delivery(f, 1)
    expect(d1).toEqual(expect.objectContaining({ status: 'accepted', round: 2, needsHumanReason: null }))
    const verifiers = f.starts.filter((s) => s.kind === 'verification')
    expect(verifiers.map((s) => /Verification round (\d+)/.exec(s.prompt)?.[1])).toEqual(['1', '2'])
    // No package was worked again: the retry re-verified what was already integrated.
    expect(f.starts.filter((s) => s.kind === 'implementation')).toHaveLength(1)
    expect((await goalEvents(f)).map((e) => e.type)).toEqual([
      'workspace.goal_needs_human',
      'workspace.goal_retried',
      'workspace.goal_accepted',
      'workspace.goal_merged',
    ])
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(d1?.verifiedCommit)
    expect(verifyWorktrees(f)).toEqual([])

    // Conductor Plan 5: one note per resting point -- the stop in round 1, then the merge.
    const notes = await reportNotes(f)
    expect(notes.map((n) => n.noteKey)).toEqual(['goal-report:v1:needs_human:r1', 'goal-report:v1:merged'])
    expect(notes[0]?.text).toContain('Goal v1 report: stopped, and needs you:')
    expect(notes[0]?.text).toContain('could not be checked: R2')
    // The report keeps both rounds, and R2's history says what round 1 found.
    const report = await loadGoalReport(f.workspaceId, 1)
    expect(report.ok && report.value.rounds.map((round) => [round.round, round.pass, round.unverifiable])).toEqual([
      [1, 2, 1],
      [2, 3, 0],
    ])
    expect(report.ok && report.value.requirements?.find((r) => r.key === 'R2')?.history).toEqual([
      { round: 1, status: 'unverifiable' },
      { round: 2, status: 'pass' },
    ])
    // Once R2 passed, the stop's caveat is gone.
    expect(report.ok && reportCaveats(report.value)).toEqual([])
  })

  it('ends in needs_human when the round cap runs out, without a rework the cap has no round left for', async (): Promise<void> => {
    const f = await seed({
      conductAnswer: PARTITIONED,
      verificationRoundCap: 2,
      verificationRounds: [[checked('R1', 'pass'), checked('R2', 'fail'), checked('RUN', 'pass')]],
    })
    await tickUntil(f, status(f, 1, 'needs_human'))

    const d1 = await delivery(f, 1)
    expect(d1).toEqual(expect.objectContaining({ status: 'needs_human', round: 2, activeRunId: null, verifiedCommit: null, mergedAt: null }))
    expect(d1?.needsHumanReason).toContain('the verification round cap (2) was reached; still failing: R2')
    // `config` ran twice: its first run and one rework after round 1. Round 2's failure spent the
    // cap, so no rework follows it -- the cap ends paid work.
    expect(await implementationRunsOf(f, 'config')).toHaveLength(2)
    expect(await implementationRunsOf(f, 'report')).toHaveLength(1)
    expect(await verificationReworks(f)).toEqual([{ key: 'config', round: 1 }])
    expect((await prisma.task.findFirstOrThrow({ where: { workspaceId: f.workspaceId, workPackage: { key: 'config' } } })).status).toBe('done')
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(2)

    // More ticks start nothing: no third round, no further rework, nothing on main.
    for (let i = 0; i < 2; i += 1) {
      await tick(f.deps)
      await drainPumps()
    }
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(2)
    expect(await implementationRunsOf(f, 'config')).toHaveLength(2)
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(f.initialTip)
    expect((await goalEvents(f)).map((e) => e.type)).toEqual(['workspace.goal_needs_human'])
    expect(verifyWorktrees(f)).toEqual([])

    // Conductor Plan 5: the report of a version the cap stopped, with the rework and why.
    const stopped = await loadGoalReport(f.workspaceId, 1)
    expect(stopped.ok).toBe(true)
    if (!stopped.ok) return
    expect(stopped.value.state).toBe('needs_human')
    expect(stopped.value.requirements?.map((r) => [r.key, r.verdict?.status, r.verdict?.round])).toEqual([
      ['R1', 'pass', 2],
      ['R2', 'fail', 2],
      ['RUN', 'pass', 2],
    ])
    expect(stopped.value.packages.find((p) => p.key === 'config')?.implementationRuns).toBe(2)
    expect(stopped.value.trail.map((e) => e.text)).toContain('config: sent back for rework by verification round 1.')
    expect(stopped.value.trail.find((e) => e.text === 'config: sent back for rework by verification round 1.')?.detail).toContain('R2 prints nothing')
    expect(renderGoalReportMarkdown(stopped.value)).toContain('sent back for rework by verification round 1')
    const notes = await reportNotes(f)
    expect(notes.map((n) => n.noteKey)).toEqual(['goal-report:v1:needs_human:r2'])
    expect(notes[0]?.text).toContain('the verification round cap (2) was reached')
    expect(notes[0]?.text).toContain('failing: R2')
  })

  it('routes a package\'s hand-offs: the integration package reads its endpoint contract, the finished skeleton is reopened for its gate, and every contract lists the plan\'s decisions (spec C2, C3)', async (): Promise<void> => {
    const decided = JSON.parse(PARTITIONED) as { conductAnswer: Record<string, unknown> }
    decided.conductAnswer['decisions'] = [{ title: 'API field naming', decision: 'camelCase JSON fields' }]
    const f = await seed({
      conductAnswer: JSON.stringify(decided),
      reportExtras: (key, _version, attempt) =>
        key === 'report' && attempt === 0
          ? { handOffs: [{ package: 'integration', change: 'expose GET /api/v1/reports returning {data,nextCursor}' }, { path: 'scripts/verify.sh', change: 'run pytest -k report' }] }
          : undefined,
    })
    await tickUntil(f, merged(f, 1))

    const handOffs = await prisma.packageHandOff.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { sourceKey: 'asc' } })
    // Final review I2: the skeleton's reopen run finished, so its request is delivered; `reopenedAt`
    // keeps that it was reopened for it, which the report below still says.
    expect(handOffs.map((h) => [h.toPackageKey, h.status, h.reopenedAt !== null])).toEqual([['integration', 'delivered', false], ['skeleton', 'delivered', true]])

    const integration = await implementationRunsOf(f, 'integration')
    expect(integration[0]?.prompt).toContain('Asked of your package by other packages')
    expect(integration[0]?.prompt).toContain('expose GET /api/v1/reports returning {data,nextCursor}')
    expect(integration[0]?.prompt).toContain('- API field naming: camelCase JSON fields')

    const skeleton = await implementationRunsOf(f, 'skeleton')
    expect(skeleton).toHaveLength(2)
    expect(skeleton[1]?.prompt).toContain('- from report (scripts/verify.sh): run pytest -k report')
    // Once, in the rework reason: not listed again as asked of the package.
    expect(skeleton[1]?.prompt.split('run pytest -k report')).toHaveLength(2)
    expect(skeleton[1]?.prompt).not.toContain('Asked of your package')
    expect((await prisma.workPackage.findFirstOrThrow({ where: { workspaceId: f.workspaceId, key: 'skeleton' } })).handOffReopens).toBe(1)

    const report = await loadGoalReport(f.workspaceId, 1)
    expect(report.ok && report.value.handOffs.map((h) => h.status)).toEqual(['delivered', 'reopened'])
    expect(report.ok && report.value.decisions.map((d) => d.title)).toEqual(['API field naming'])
    expect(f.others).toEqual([])
  })

  it('answers a package\'s design question from the plan, and the next package reads the decision (spec C3, C4)', async (): Promise<void> => {
    const f = await seed({
      conductAnswer: PARTITIONED,
      reportExtras: (key, _version, attempt) => (key === 'report' && attempt === 0 ? { questions: ['Which JSON field naming do the endpoints use?'] } : undefined),
      conductorAnswers: (prompt) =>
        JSON.stringify({
          conductorAnswers: [...prompt.matchAll(/^QUESTION (\S+) /gmu)].map((m) => ({
            messageId: m[1],
            answer: 'camelCase for every field.',
            basis: { requirements: ['R1'], packages: ['report'], decisions: [] },
            changes: 'none',
            newDecision: { title: 'JSON field naming', decision: 'camelCase for every field' },
            handOff: null,
          })),
        }),
    })
    await tickUntil(f, merged(f, 1))

    const decision = await prisma.goalDecision.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })
    expect(decision).toMatchObject({ title: 'JSON field naming', source: 'conductor_answer' })
    const integration = await implementationRunsOf(f, 'integration')
    expect(integration[0]?.prompt).toContain('- JSON field naming: camelCase for every field')
    expect(await prisma.conductorCall.count({ where: { workspaceId: f.workspaceId, stage: 'answer', outcome: 'ok' } })).toBe(1)
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, situationKind: 'unanswerable_question' } })).toBe(0)
    expect(f.others).toEqual([])
  })
})
