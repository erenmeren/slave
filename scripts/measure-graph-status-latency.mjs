// The gate's measured half (spec §8 / M7 design doc §8): "live status reflected in nodes," within
// the same one-second budget M6's activity latency measured. `measure-activity-latency.mjs`'s
// sibling, reusing its shape (seed, start the real web server, clean up on every path) with one
// structural difference: that script drives events itself with no process behind them (nothing to
// spawn, nothing to observe transitioning); this one has to put a *real* `AgentRun` through
// `starting -> working -> paused`, which only the orchestrator's own tick can do.
//
// Driving the pause: the brief offered two routes -- the fake CLI's `hook-deny` fixture (the
// protocol `apps/orchestrator/test/integration/milestone-gate.test.ts`'s own pause case uses), or
// calling `requestPause` from `@ai-team-os/control` directly. `hook-deny` wins on "least
// contrived": `packages/providers/test/fake-claude.mjs` only ever replays a canned transcript, and
// never reads the pause-flag file or invokes the real hook script (see that file's own header
// comment) -- so `requestPause`'s write-the-flag-and-wait protocol has nothing to act on it while
// spawning the fake adapter. `hook-deny`'s canned transcript denies a tool call the same way a real
// pause gate would, producing a genuine `run.paused` row through the exact code path (`pump.ts`'s
// `hook_denied` case) a real pause takes, with no daemon, no second process and no flag-file
// coordination to set up.
//
// The M6 script's ledgered gap this one fixes: seeding used to run *outside* the try/finally, so a
// throw mid-seed orphaned a workspace with nothing to clean it up. Every write below -- the git
// repo, the workspace, the web server, the orchestrator subprocess -- happens inside the try, and
// the finally cleans up whatever got as far as being created, in every case.

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '../packages/db/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'

const PORT = process.env.PORT ?? '3000'
const BASE_URL = `http://127.0.0.1:${PORT}`
const BAR_MS = 1000
const POLL_INTERVAL_MS = 15
const TRANSITION_TIMEOUT_MS = 20_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

/** `milestone-gate.test.ts`'s own `makeRepo` -- a real repository, because the orchestrator's tick
 *  provisions a real worktree in it regardless of which CLI it spawns. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-graph-latency-'))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Latency'])
  git(['config', 'user.email', 'latency@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

async function waitForWebReady(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fetch(baseUrl)
      return
    } catch {
      if (Date.now() > deadline) throw new Error(`web server did not become reachable within ${timeoutMs}ms`)
      await delay(200)
    }
  }
}

async function fetchGraph(workspaceId) {
  const response = await fetch(`${BASE_URL}/api/w/${workspaceId}/graph`)
  if (!response.ok) throw new Error(`graph fetch failed: ${response.status} ${response.statusText}`)
  return response.json()
}

let exitCode = 1
let repoPath = null
let workspaceId = null
let web = null
let orchestrator = null

try {
  // 1. Seed: workspace, team, agent, one ready task -- the same shape
  // `milestone-gate.test.ts`'s `seed()` uses, with a real git repository underneath it.
  repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: `Graph Latency ${new Date().toISOString()}`,
      repoPath,
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  workspaceId = workspace.id
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Latency Team' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Lex', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Measure graph status latency',
      description: 'Synthetic task driven by scripts/measure-graph-status-latency.mjs.',
      status: 'ready',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
    },
  })
  console.log(`workspace: ${workspace.id}`)

  // 2. The real web server, in the background -- same entry point `npm run web` uses.
  web = spawn(
    'node',
    ['--env-file=.env', 'node_modules/next/dist/bin/next', 'dev', 'apps/web', '--port', PORT],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  web.stdout.on('data', (chunk) => process.stdout.write(`[web] ${chunk}`))
  web.stderr.on('data', (chunk) => process.stderr.write(`[web] ${chunk}`))
  let webExited = false
  web.on('exit', () => {
    webExited = true
  })
  web.on('error', (error) => {
    webExited = true
    console.error('[web] failed to start:', error)
  })

  await waitForWebReady(BASE_URL, 30_000)
  if (webExited) throw new Error('web server exited before becoming ready')
  console.log(`web ready on ${BASE_URL}`)

  // 3. One real tick, spawned against the fake CLI's `hook-deny` fixture (see the header comment
  // for why this beats `requestPause` here). `tick` claims the task, spawns the fake CLI, and
  // awaits every pump it started before its own process exits (`drainPumps` -- see `cli.ts`), so
  // by the time this child process exits the whole `starting -> working -> paused` sequence has
  // already happened; the concurrent poll loop below is what catches it happening rather than
  // only its aftermath.
  orchestrator = spawn('node', [ORCHESTRATOR_CLI, 'tick', '--workspace', workspace.id], {
    env: {
      ...process.env,
      AITEAMOS_CLAUDE_BIN: 'node',
      AITEAMOS_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture hook-deny`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  orchestrator.stdout.on('data', (chunk) => process.stdout.write(`[tick] ${chunk}`))
  orchestrator.stderr.on('data', (chunk) => process.stderr.write(`[tick] ${chunk}`))
  let orchestratorExited = false
  orchestrator.on('exit', () => {
    orchestratorExited = true
  })
  orchestrator.on('error', (error) => {
    orchestratorExited = true
    console.error('[tick] failed to start:', error)
  })

  // 4. Poll the read model until it reflects each transition. `atLeastWorking`/`paused` (rather
  // than an exact `=== 'working'` match for the first one) makes this robust to the two
  // transitions landing inside the same poll interval: if a poll's first-ever sighting of this
  // agent is already `paused`, `working` must have been reflected no later than that same poll,
  // so that poll's arrival is still a valid (if slightly conservative) upper bound on the first
  // transition's latency -- never an unmeasured gap.
  const ORDER = ['idle', 'starting', 'working', 'paused']
  const atLeast = (status, floor) => ORDER.indexOf(status) >= ORDER.indexOf(floor)

  let workingReflectedAt = null
  let pausedReflectedAt = null
  const deadline = Date.now() + TRANSITION_TIMEOUT_MS
  while ((workingReflectedAt === null || pausedReflectedAt === null) && Date.now() < deadline) {
    const graph = await fetchGraph(workspace.id)
    const graphAgent = graph.agents.find((a) => a.id === agent.id)
    const now = Date.now()
    if (graphAgent !== undefined) {
      if (workingReflectedAt === null && atLeast(graphAgent.status, 'working')) workingReflectedAt = now
      if (pausedReflectedAt === null && graphAgent.status === 'paused') pausedReflectedAt = now
    }
    await delay(POLL_INTERVAL_MS)
  }

  if (workingReflectedAt === null) throw new Error('the graph never reflected "working" within the timeout')
  if (pausedReflectedAt === null) throw new Error('the graph never reflected "paused" within the timeout')

  // 5. The tick's own process waits for its pump before exiting (see the spawn comment above) --
  // wait for it here too, rather than reading the event log while it might still be mid-write.
  {
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (!orchestratorExited && Date.now() < exitDeadline) await delay(50)
  }
  if (!orchestratorExited) {
    orchestrator.kill('SIGTERM')
    throw new Error(`orchestrator tick did not exit within ${PROCESS_EXIT_TIMEOUT_MS}ms`)
  }
  if (orchestrator.exitCode !== 0) {
    throw new Error(`orchestrator tick exited ${orchestrator.exitCode}`)
  }

  // 6. Each transition's own event, read straight from the log -- `ts` is assigned by Postgres at
  // INSERT, the same authority `measure-activity-latency.mjs` uses.
  const run = await prisma.agentRun.findFirstOrThrow({ where: { taskId: task.id } })
  const eventRows = await prisma.executionEvent.findMany({ where: { runId: run.id }, orderBy: { seq: 'asc' } })
  const eventsByType = new Map(eventRows.map((row) => [DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type], row]))

  const startedEvent = eventsByType.get('run.started')
  const pausedEvent = eventsByType.get('run.paused')
  if (startedEvent === undefined) throw new Error('run.started was never recorded for this run')
  if (pausedEvent === undefined) throw new Error('run.paused was never recorded for this run')

  const transitions = [
    { name: 'starting -> working', eventTs: startedEvent.ts.getTime(), reflectedAt: workingReflectedAt },
    { name: 'working -> paused', eventTs: pausedEvent.ts.getTime(), reflectedAt: pausedReflectedAt },
  ]

  // A negative gap is a legitimate reading, not a bug: the graph route derives status straight
  // from `AgentRun.status`, which `pump.ts` writes to the database *before* it appends the
  // corresponding domain event (see each case's own ordering) -- so a poll can observe the new
  // status before the event that names the transition has even been written. Reported as measured
  // either way; the bar below is about magnitude, not sign.
  let worstLatency = -Infinity
  for (const transition of transitions) {
    const latencyMs = transition.reflectedAt - transition.eventTs
    worstLatency = Math.max(worstLatency, latencyMs)
    console.log(`${transition.name}: ${latencyMs}ms`)
  }

  if (worstLatency >= BAR_MS) {
    console.error(`FAIL: worst transition latency (${worstLatency}ms) >= ${BAR_MS}ms`)
    exitCode = 1
  } else {
    console.log(`PASS: worst transition latency (${worstLatency}ms) < ${BAR_MS}ms`)
    exitCode = 0
  }
} finally {
  if (orchestrator !== null && orchestrator.exitCode === null) orchestrator.kill('SIGTERM')
  if (web !== null) web.kill('SIGTERM')
  if (workspaceId !== null) {
    // No FK from `ExecutionEvent` to `Workspace` (M2's append-only log outlives entity lifecycles
    // by design) -- deleted explicitly, same as `measure-activity-latency.mjs`, before the
    // workspace delete cascades everything else (`Team`/`Agent`/`Task`/`AgentRun`/`Checkpoint`/
    // `TaskDependency`/`Artifact`).
    await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
