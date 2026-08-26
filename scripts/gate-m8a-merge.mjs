// The gate's unattended half (spec §8 / M8a design doc §1): "a task → merged branch, unattended".
// `apps/orchestrator/test/integration/milestone-gate.test.ts` proves the same pipeline
// (`verifying -> reviewing -> merging -> done`) by driving repeated `tick`s in-process; this script
// proves it the way an operator would actually run it -- a live `daemon` subprocess against the
// fake `claude` CLI's `m8a-flow` fixture, observed with nothing but reads until the task concludes.
//
// Shape borrowed verbatim from `scripts/measure-graph-status-latency.mjs`: dist imports, everything
// created inside `try`, `finally` cleans up events before the workspace (no FK), a `PASS:`/`FAIL:`
// line, `exitCode` starts at 1, `process.exit(exitCode)` at the very end.

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '../packages/db/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'

const POLL_INTERVAL_MS = 15
const DONE_TIMEOUT_MS = 120_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

/** Same as `milestone-gate.test.ts`'s `makeRepo` -- a real repository, because the orchestrator's
 *  tick provisions a real worktree in it regardless of which CLI it spawns. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-gate-m8a-merge-'))
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
  // 1. Seed: a workspace that trusts auto-merge, one team, one backend worker, one reviewer, and
  // exactly one ready task -- the same shape `milestone-gate.test.ts`'s green M8a case seeds, with
  // a real git repository underneath it.
  repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: `M8a Merge Gate ${new Date().toISOString()}`,
      repoPath,
      autoMerge: true,
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  workspaceId = workspace.id
  // Without this row, dispatch refuses with `invalid_provider` (M12 Task 8) and nothing ever runs.
  await prisma.providerConfiguration.create({
    data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Gate Team' } })
  await prisma.agent.create({ data: { teamId: team.id, name: 'Worker', role: 'backend' } })
  await prisma.agent.create({ data: { teamId: team.id, name: 'Reviewer', role: 'reviewer' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Gate the M8a merge path',
      description: 'Synthetic task driven by scripts/gate-m8a-merge.mjs.',
      status: 'ready',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
    },
  })
  console.log(`workspace: ${workspace.id}`)

  // 2. The real daemon, in the background, against the fake CLI's `m8a-flow` fixture (a work run
  // leaves a real commit for the merge pass to merge; a review run is told apart by the literal
  // `"verdict"` substring the review prompt always carries and replays an approval).
  daemon = spawn(
    'node',
    [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspace.id, '--period', '500'],
    {
      env: {
        ...process.env,
        AITEAMOS_CLAUDE_BIN: 'node',
        AITEAMOS_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8a-flow`,
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

  // 3. Poll -- zero writes, only reads -- until the task reaches `done` or the timeout expires.
  const deadline = Date.now() + DONE_TIMEOUT_MS
  let finalTask = null
  while (Date.now() < deadline) {
    if (daemonExited) throw new Error('the daemon exited before the task reached done')
    const current = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    if (current.status === 'done') {
      finalTask = current
      break
    }
    await delay(POLL_INTERVAL_MS)
  }
  if (finalTask === null) throw new Error(`the task never reached "done" within ${DONE_TIMEOUT_MS}ms`)

  // 4. Assert the merge commit actually landed on `main`, and that a review really gated it.
  const taskKey = `T-${task.id.slice(0, 8)}`
  const mergeSubjects = execFileSync('git', ['log', '--merges', '--format=%s', 'main'], {
    cwd: repoPath,
    encoding: 'utf8',
  })
  if (!mergeSubjects.includes(`merge(${taskKey})`)) {
    throw new Error(`main's merge commits do not contain "merge(${taskKey})": ${JSON.stringify(mergeSubjects)}`)
  }

  const eventRows = await prisma.executionEvent.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { seq: 'asc' },
  })
  const eventTypes = eventRows.map((row) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type])
  if (!eventTypes.includes('task.review_approved')) {
    throw new Error('the event log never recorded task.review_approved -- the review did not gate the merge')
  }

  console.log(`PASS: task reached done and merge(${taskKey}) is on main`)
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
