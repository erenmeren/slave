// The gate's second unattended half (spec §8 / M8a design doc §6): "emergency stop pauses
// everything and clears clean". Drives the real CLI verbs an operator would reach for -- a live
// `daemon`, then `emergency-stop`, then `clear-halt` and `resume` -- against the fake `claude`
// CLI's `hook-deny` fixture, the same one `apps/orchestrator`'s milestone-gate test uses to
// produce a real pause.
//
// Driving a run that is genuinely mid-flight when the stop lands: `FAKE_CLAUDE_LINE_DELAY_MS`
// slows the fixture's replay to 150ms/line so the run is still `starting`/`working` by the time
// this script polls it, rather than already concluded to `paused` on its own by the time
// `emergency-stop` runs (`fake-claude.mjs` never reads the pause flag -- see that file's own
// header -- so `emergency-stop`'s effect is only ever visible once the run's own stream ends).
//
// Shape borrowed verbatim from `scripts/measure-graph-status-latency.mjs`: dist imports,
// everything created inside `try`, `finally` cleans up events before the workspace (no FK), a
// `PASS:`/`FAIL:` line, `exitCode` starts at 1, `process.exit(exitCode)` at the very end.

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '../packages/db/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'

const POLL_INTERVAL_MS = 15
const ACTIVE_RUN_TIMEOUT_MS = 20_000
const HALT_SETTLE_TIMEOUT_MS = 15_000
const STABLE_WINDOW_MS = 3_000
const RESUME_TIMEOUT_MS = 15_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

// Every child process below (the daemon, and the CLI's own `resume`) inherits these -- set once
// here rather than threaded through each spawn/execFileSync call, because `resume` has to reach
// the same fake CLI the daemon used without this script repeating the wiring at every call site.
process.env.AITEAMOS_CLAUDE_BIN = 'node'
process.env.AITEAMOS_CLAUDE_ARGS = `${FAKE_CLAUDE} --fixture hook-deny`
process.env.FAKE_CLAUDE_LINE_DELAY_MS = '150'

/** Same as `milestone-gate.test.ts`'s `makeRepo` -- a real repository, because the orchestrator's
 *  tick provisions a real worktree in it regardless of which CLI it spawns. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-gate-m8a-estop-'))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

const ACTIVE_STATUSES = new Set(['starting', 'working'])
// A run that hasn't yet landed on `paused` or somewhere terminal is still "in flight" from this
// gate's point of view; `stopping` counts as settling too -- it is already on its way out.
const SETTLED_STATUSES = new Set(['paused', 'stopping', 'stopped', 'succeeded', 'failed'])

let exitCode = 1
let repoPath = null
let workspaceId = null
let daemon = null

try {
  // 1. Seed: a workspace, one team, one backend worker (no reviewer -- this run never reaches
  // review), and exactly one ready task.
  repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: `M8a Estop Gate ${new Date().toISOString()}`,
      repoPath,
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  workspaceId = workspace.id
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Gate Team' } })
  await prisma.agent.create({ data: { teamId: team.id, name: 'Worker', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Gate the M8a emergency stop path',
      description: 'Synthetic task driven by scripts/gate-m8a-estop.mjs.',
      status: 'ready',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
    },
  })
  console.log(`workspace: ${workspace.id}`)

  // 2. The real daemon, in the background.
  daemon = spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspace.id, '--period', '500'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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

  // 3. Poll -- zero writes -- until one AgentRun for this task is non-terminal, catching it
  // mid-flight rather than after the fixture's own deny has already concluded it.
  let activeRun = null
  {
    const deadline = Date.now() + ACTIVE_RUN_TIMEOUT_MS
    while (activeRun === null && Date.now() < deadline) {
      if (daemonExited) throw new Error('the daemon exited before starting a run')
      const run = await prisma.agentRun.findFirst({ where: { taskId: task.id } })
      if (run !== null && ACTIVE_STATUSES.has(run.status)) activeRun = run
      await delay(POLL_INTERVAL_MS)
    }
  }
  if (activeRun === null) throw new Error(`no run went active within ${ACTIVE_RUN_TIMEOUT_MS}ms`)
  console.log(`run ${activeRun.id} is ${activeRun.status} -- engaging emergency stop`)

  // 4. Engage mid-run.
  execFileSync('node', [ORCHESTRATOR_CLI, 'emergency-stop', '--workspace', workspace.id, '--by', 'gate-script'])

  // 5. Bounded window: every run for the workspace settles (paused or terminal -- concluding runs
  // are tolerated noise), at least one lands on `paused` with `pauseReason: 'emergency_stop'`, and
  // the workspace itself records who engaged it.
  let pausedRun = null
  {
    const deadline = Date.now() + HALT_SETTLE_TIMEOUT_MS
    for (;;) {
      const runs = await prisma.agentRun.findMany({ where: { task: { workspaceId: workspace.id } } })
      const workspaceRow = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
      const allSettled = runs.length > 0 && runs.every((run) => SETTLED_STATUSES.has(run.status))
      const found = runs.find((run) => run.status === 'paused' && run.pauseReason === 'emergency_stop')
      const halted = workspaceRow.haltedReason !== null && workspaceRow.haltedReason.startsWith('emergency stop by')

      if (allSettled && found !== undefined && halted) {
        pausedRun = found
        break
      }
      if (Date.now() > deadline) {
        throw new Error(
          `emergency stop did not settle within ${HALT_SETTLE_TIMEOUT_MS}ms: ` +
            `runs=${JSON.stringify(runs.map((r) => ({ id: r.id, status: r.status, pauseReason: r.pauseReason })))} ` +
            `haltedReason=${JSON.stringify(workspaceRow.haltedReason)}`,
        )
      }
      await delay(POLL_INTERVAL_MS)
    }
  }
  console.log(`emergency stop settled: run ${pausedRun.id} paused with pauseReason=emergency_stop`)

  // 6. No NEW run starts while halted -- the run count for this workspace stays stable across a
  // further window.
  {
    const before = await prisma.agentRun.count({ where: { task: { workspaceId: workspace.id } } })
    const deadline = Date.now() + STABLE_WINDOW_MS
    while (Date.now() < deadline) {
      await delay(POLL_INTERVAL_MS)
      const now = await prisma.agentRun.count({ where: { task: { workspaceId: workspace.id } } })
      if (now !== before) {
        throw new Error(`a new run appeared while the workspace was halted (was ${before}, now ${now})`)
      }
    }
  }
  console.log('run count held steady while halted')

  // 7. Retract the halt, then resume the paused run -- `clear-halt` first: `resume` refuses
  // outright while the workspace is still halted.
  execFileSync('node', [ORCHESTRATOR_CLI, 'clear-halt', '--workspace', workspace.id])
  // Bounded: `resume`'s own process pumps the continuation's whole stream before it exits (the CLI
  // waits for what it started, same as `tick`), so the timeout below is this call's own window
  // rather than a separate poll loop.
  execFileSync('node', [ORCHESTRATOR_CLI, 'resume', '--run', pausedRun.id], { timeout: RESUME_TIMEOUT_MS })

  // 8. Work resumed: the event log carries `run.resumed` for this run -- proof the run actually
  // left `paused`, even though the same fixture's canned denial re-pauses it by the time the
  // `resume` process above returns (the fake CLI replays hook-deny's transcript unchanged, `--
  // resume <sessionId>` included and ignored, on every invocation -- see that file's own header).
  const eventRows = await prisma.executionEvent.findMany({
    where: { runId: pausedRun.id },
    orderBy: { seq: 'asc' },
  })
  const eventTypes = eventRows.map((row) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type])
  if (!eventTypes.includes('run.resumed')) {
    throw new Error(`run.resumed was never recorded for ${pausedRun.id} -- resume never actually happened`)
  }

  console.log('PASS: emergency stop paused the fleet and clear-halt + resume recovered it')
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
