// The gate's measured half (spec §8 / M8b design doc): "a goal becomes a task graph becomes
// merged branches, unattended". `apps/orchestrator/test/integration/milestone-gate.test.ts` proves
// the planning-to-merge pipeline by driving repeated `tick`s in-process against a hand-seeded
// board; this script proves it the way an operator would actually run it -- a workspace with a
// GOAL and ZERO tasks, a live `daemon` subprocess against the fake `claude` CLI's `m8-flow`
// fixture, observed with nothing but reads from the moment a plan lands to the moment every task
// it produced is `done`.
//
// Shape borrowed verbatim from `scripts/gate-m8a-merge.mjs` (itself borrowed from
// `scripts/measure-graph-status-latency.mjs`): dist imports, everything created inside `try`,
// `finally` cleans up events before the workspace (no FK), a `PASS:`/`FAIL:` line, `exitCode`
// starts at 1, `process.exit(exitCode)` at the very end. The FAIL-path diagnostic dumps follow
// `scripts/gate-m8a-estop.mjs`'s style -- a thrown error carries the run/task state that made the
// call, not just "it timed out".

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '../packages/db/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'

const POLL_INTERVAL_MS = 15
const STAGE_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

/** Same as `milestone-gate.test.ts`'s `makeRepo` -- a real repository, because the orchestrator's
 *  tick provisions a real worktree in it regardless of which CLI it spawns. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-gate-m8-plan-'))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

let exitCode = 1
let repoPath = null
let workspaceId = null
let daemon = null

try {
  // 1. Seed: a workspace that trusts auto-merge, one team, a manager (to plan), one backend
  // worker (to implement) and one reviewer (to gate the merge) -- and ZERO tasks. The whole point
  // of this gate is that the daemon produces the board itself.
  repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: `M8b Plan Gate ${new Date().toISOString()}`,
      repoPath,
      autoMerge: true,
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  workspaceId = workspace.id
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Gate Team' } })
  await prisma.agent.create({ data: { teamId: team.id, name: 'Manager', role: 'manager' } })
  await prisma.agent.create({ data: { teamId: team.id, name: 'Worker', role: 'backend' } })
  await prisma.agent.create({ data: { teamId: team.id, name: 'Reviewer', role: 'reviewer' } })
  console.log(`workspace: ${workspace.id}`)

  // 2. Set the goal via the real CLI, the human's own path -- and the one that emits the
  // `workspace.goal_set` event `dispatchPlanning`'s retry cap keys on.
  execFileSync('node', [ORCHESTRATOR_CLI, 'set-goal', '--workspace', workspace.id, '--goal', 'Ship the demo feature end to end'])

  // 3. The real daemon, in the background, against the fake CLI's `m8-flow` fixture (a planning
  // prompt -- containing the literal substring `"task graph"` -- replays `plan-graph`, which
  // hands back three chained tasks with no side effect; a review prompt -- containing `"verdict"`
  // -- replays `review-approve`; any other prompt is a work run that leaves a real commit before
  // replaying `complete`, so the merge pass downstream has something to merge).
  daemon = spawn(
    'node',
    [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspace.id, '--period', '500'],
    {
      env: {
        ...process.env,
        AITEAMOS_CLAUDE_BIN: 'node',
        AITEAMOS_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8-flow`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  daemon.stdout.on('data', (chunk) => process.stdout.write(`[daemon] ${chunk}`))
  daemon.stderr.on('data', (chunk) => process.stderr.write(`[daemon] ${chunk}`))
  let daemonExited = false
  daemon.on('exit', () => {
    daemonExited = true
  })
  daemon.on('error', (error) => {
    daemonExited = true
    console.error('[daemon] failed to start:', error)
  })

  // 4a. Poll -- zero writes -- until the plan lands: the board goes from empty to non-empty in one
  // transaction (`concludePlanning`), so the first non-zero count IS the whole plan.
  let planTaskCount = null
  {
    const deadline = Date.now() + STAGE_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (daemonExited) throw new Error('the daemon exited before the plan landed')
      const count = await prisma.task.count({ where: { workspaceId: workspace.id } })
      if (count > 0) {
        planTaskCount = count
        break
      }
      await delay(POLL_INTERVAL_MS)
    }
  }
  if (planTaskCount === null) {
    // m8a-estop-style diagnostic: dump exactly what happened instead of a bare timeout message --
    // the planning run(s) this workspace actually produced (id, status, pauseReason) and every
    // event type recorded so far, so a real failure here (vs. this gate's own flakiness) is
    // diagnosable from the log alone.
    const planningRuns = await prisma.agentRun.findMany({
      where: { agent: { team: { workspaceId: workspace.id } }, kind: 'planning' },
    })
    const eventRowsSoFar = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { seq: 'asc' },
    })
    const eventTypesSoFar = eventRowsSoFar.map((row) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type])
    throw new Error(
      `no task appeared within ${STAGE_TIMEOUT_MS}ms -- the plan never landed: ` +
        `planningRuns=${JSON.stringify(
          planningRuns.map((run) => ({ id: run.id, status: run.status, pauseReason: run.pauseReason })),
        )} eventTypes=${JSON.stringify(eventTypesSoFar)}`,
    )
  }
  console.log(`plan landed: ${planTaskCount} task(s)`)

  // 4b. Poll -- zero writes -- until every task the plan produced reaches `done`.
  let allDone = false
  {
    const deadline = Date.now() + STAGE_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (daemonExited) throw new Error('the daemon exited before every task reached done')
      const tasks = await prisma.task.findMany({ where: { workspaceId: workspace.id } })
      if (tasks.length > 0 && tasks.every((task) => task.status === 'done')) {
        allDone = true
        break
      }
      await delay(POLL_INTERVAL_MS)
    }
    if (!allDone) {
      const tasks = await prisma.task.findMany({ where: { workspaceId: workspace.id } })
      throw new Error(
        `not every task reached "done" within ${STAGE_TIMEOUT_MS}ms: ` +
          JSON.stringify(tasks.map((task) => ({ id: task.id, title: task.title, status: task.status, attempt: task.attempt }))),
      )
    }
  }
  console.log('every task reached done')

  // 5. Assert the pipeline actually ran, not a shortcut that happened to leave the board `done`.
  if (planTaskCount < 2) {
    throw new Error(`the plan produced only ${planTaskCount} task(s), expected at least 2`)
  }

  const eventRows = await prisma.executionEvent.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { seq: 'asc' },
  })
  const eventTypes = eventRows.map((row) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type])
  if (!eventTypes.includes('workspace.plan_created')) {
    throw new Error(
      `the event log never recorded workspace.plan_created -- events: ${JSON.stringify(eventTypes)}`,
    )
  }
  if (!eventTypes.includes('task.review_approved')) {
    throw new Error(
      `the event log never recorded task.review_approved -- events: ${JSON.stringify(eventTypes)}`,
    )
  }

  const mergeSubjects = execFileSync('git', ['log', '--merges', '--format=%s', 'main'], {
    cwd: repoPath,
    encoding: 'utf8',
  })
  const merges = mergeSubjects.split('\n').filter((line) => line.includes('merge(T-'))
  if (merges.length === 0) {
    throw new Error(`main's merge commits contain no "merge(T-...)" subject: ${JSON.stringify(mergeSubjects)}`)
  }

  console.log(`PASS: a goal became ${planTaskCount} tasks and ${merges.length} merged branches, unattended`)
  exitCode = 0
} finally {
  if (daemon !== null && daemon.exitCode === null) {
    daemon.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (daemon.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (daemon.exitCode === null) daemon.kill('SIGKILL')
  }
  if (workspaceId !== null) {
    // No FK from `ExecutionEvent` to `Workspace` (M2's append-only log outlives entity lifecycles
    // by design) -- deleted explicitly, before the workspace delete cascades everything else
    // (`Team`/`Agent`/`Task`/`AgentRun`/`Checkpoint`/`TaskDependency`/`Artifact`).
    await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
