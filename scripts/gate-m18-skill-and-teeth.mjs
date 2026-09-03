// M18's own gate (Task 13 brief): "a refused tool, a readable chain, and two honest chips, proven
// without spending a cent". Shape cribbed from `gate-m14-fidelity.mjs` verbatim where it applies --
// dist imports only, one top-level `try` with no `catch`, `let exitCode = 1` set to `0` only by
// falling off the end of the try, `process.exit(exitCode)` the literal last line; the real `next
// dev` + real Chromium + append-only browser-console collectors + `fail()`'s diagnostic dump +
// `gotoReliably`'s signature-gated retry, all reused unchanged. What differs from m14 is the
// daemon: this gate does not rehearse a LIVE-reacting fake CLI (`scripts/gate-fakes/fake-claude.sh`)
// -- it needs one canned, deterministic transcript (`permission-matrix-deny.ndjson`, Task 6's
// fixture) replayed byte-for-byte, which only `packages/providers/test/fake-claude.mjs --fixture
// <name>` can do. So this gate keeps m14's OUTER precondition (`AITEAMOS_CLAUDE_BIN` must already
// point at an executable under `scripts/gate-fakes/` -- the same zero-spend discipline check every
// post-M14 gate enforces, proving the operator invoked this correctly) and then, ONLY for its own
// daemon child's environment, overrides `AITEAMOS_CLAUDE_BIN`/`AITEAMOS_CLAUDE_ARGS` to the fixture
// player -- the exact pattern `gate-m8a-estop.mjs`/`gate-m8-plan.mjs`/`gate-m10-org.mjs`/
// `gate-m8a-merge.mjs` already use for a deterministic scripted run. Both are zero-spend; the outer
// check is the standing proof an operator cannot skip, the inner override is what makes the
// specific scenario reproducible.
//
// UNLIKE m14 this gate spends nothing by construction on ONE additional axis: the daemon it spawns
// itself never reaches a vendor account regardless of what `AITEAMOS_CLAUDE_BIN` names outside,
// because the override below always wins for the one dispatch this gate drives.
//
// The three proof stages (Task 13 brief):
//   1. Enforcement: an `AgentPermission` deny on 'run tests', a dispatched run that replays the
//      matrix-deny fixture, and the database proving the run survived it -- one `run.tool_denied`,
//      zero `guardrail.tripped`, never `paused` -- plus the Activity page rendering the denial card.
//   2. Skill tab: two runs' worth of ordered `Skill` events, the aggregate canvas, the Focus click
//      (DOM order + a ×N badge), the clear-back-to-aggregate control, a genuinely fresh empty
//      workspace's `skill-empty`, and the tab carrying no `· later`.
//   3. Chrome truths: the Activity chip reading `sse · <n>ms` once a real frame lands, and a seeded
//      paused checkpoint's `deniedToolUseIds` reaching the Task detail panel's reader line.
//
// DEV DB MIGRATION (Task 13 brief): the two m18 migrations must reach the dev database before this
// gate can run at all -- `npm run db:migrate` (Prisma's `dotenv/config` in
// `packages/db/prisma.config.ts` reads `.env`'s `DATABASE_URL` automatically, so no `--env-file`
// wrapper is needed). This gate does not run that itself (a gate that silently migrates a database
// out from under an operator is a gate nobody trusts); it REFUSES with a named, cheap SELECT probe
// instead of failing cryptically mid-run if the migration was skipped.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { chromium } from 'playwright-core'
import { appendEvent } from '../packages/events/dist/index.js'
import { isAlive } from '../packages/control/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'

const POLL_INTERVAL_MS = 25
const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const DISPATCH_TIMEOUT_MS = 180_000
const RUN_CONCLUDE_TIMEOUT_MS = 120_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const runTimestamp = new Date().toISOString()

// `gate-m14-fidelity.mjs`'s naming idiom: a per-run suffix (wall clock, not the full ISO stamp)
// keeps two overlapping executions from reading each other's rows, and `preflightCleanup` still
// removes leftovers by PREFIX. One shared prefix covers both workspaces this gate seeds (the main
// one and stage 2's genuinely-fresh empty one) so cleanup/dump only ever needs one `startsWith`.
const WORKSPACE_PREFIX = 'M18 Gate'
const WORKSPACE_NAME = `${WORKSPACE_PREFIX} Project ${runTimestamp.slice(11, 19)}`
const EMPTY_WORKSPACE_NAME = `${WORKSPACE_PREFIX} Empty ${runTimestamp.slice(11, 19)}`
const WORKER_NAME = 'Gate Worker'
const PASS_LINE = 'a refused tool, a readable chain, and two honest chips'

const WORKER_MODEL = 'sonnet'
const WORKER_PROVIDER = 'claude_code'

let exitCode = 1
let repoPath = null
let workspaceId = null
let emptyWorkspaceId = null
let teamId = null
let agentId = null
let daemon = null
let daemonOutput = ''
/** Append-only for the life of one gate run -- see `gate-m14-fidelity.mjs`'s identical field for
 *  the full rationale (the cap-and-shift bug it replaced silently killed `gotoReliably`'s retry
 *  signature check for the rest of a run once the array had ever reached the old cap). */
const browserConsole = []

function pushBrowserConsole(text) {
  browserConsole.push(text.slice(0, 300))
  if (browserConsole.length % 10_000 === 0) {
    console.warn(`browserConsole has grown to ${String(browserConsole.length)} entries this run -- unusually chatty, kept append-only on purpose`)
  }
}

let nextOutput = ''
let daemonExited = false
let nextServer = null
let browser = null
let page = null
let diagDir = null
const MANIFEST_RACE_SIGNATURE = 'Unexpected end of JSON input'
const gotoRetries = []

/** `gate-m14-fidelity.mjs`'s `makeRepo`, verbatim: a real repository, since the orchestrator's tick
 *  provisions a real worktree in it regardless of which CLI it spawns. */
function makeRepo(suffix) {
  const dir = mkdtempSync(join(tmpdir(), `aiteamos-gate-m18-${suffix}-`))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : null
      server.close(() => (port !== null ? resolve(port) : reject(new Error('could not determine a free port'))))
    })
  })
}

/** `gate-m13-runtime.mjs`'s location-based stray sweep, verbatim but for this gate's one repo
 *  root -- `fake-claude.mjs` spawns no detached grandchild of its own (unlike `fake-claude.sh`'s
 *  `fake-worker-server.sh`), so this mostly guards against a future fixture that does. */
function sweepStrayChildren(roots) {
  const scoped = roots.filter((root) => root !== null && root !== '')
  if (scoped.length === 0) return
  let entries = null
  try {
    entries = readdirSync('/proc').filter((name) => /^\d+$/.test(name))
  } catch {
    entries = null
  }
  if (entries === null) {
    for (const root of scoped) {
      try {
        const found = execFileSync('pgrep', ['-f', root], { encoding: 'utf8' }).trim()
        for (const line of found.split('\n').filter((value) => value !== '')) {
          const pid = Number(line)
          if (!Number.isInteger(pid) || pid === process.pid) continue
          console.log(`cleanup: killing stray process ${String(pid)} still running out of ${root} (pgrep fallback)`)
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Already gone between the match and the signal -- the outcome we wanted anyway.
          }
        }
      } catch {
        // `pgrep` exits 1 when nothing matches, which is the ordinary case.
      }
    }
    return
  }
  for (const entry of entries) {
    const pid = Number(entry)
    if (pid === process.pid) continue
    let haystack = ''
    try {
      haystack += readlinkSync(`/proc/${entry}/cwd`)
    } catch {
      // A process that ended between the listing and this read, or one this user may not inspect.
    }
    try {
      haystack += `\0${readFileSync(`/proc/${entry}/cmdline`, 'utf8')}`
    } catch {
      // Same.
    }
    if (haystack === '') continue
    const root = scoped.find((candidate) => haystack.includes(candidate))
    if (root === undefined) continue
    console.log(`cleanup: killing stray process ${String(pid)} still running out of ${root}`)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone between the match and the signal -- the outcome we wanted anyway.
    }
  }
}

/** `gate-m17-stability.mjs`'s hardened daemon check, cribbed verbatim (function body unchanged):
 *  `pgrep -f` alone false-matches this gate's own wrapper-shell ancestry, so a candidate PID is
 *  only trusted once its REAL argv (read from `/proc/<pid>/cmdline`, null-byte separated) shows
 *  `cli.js` immediately followed by the literal argv `daemon`. */
function isRealDaemonProcess(pid) {
  let cmdline
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'latin1')
  } catch {
    return false
  }
  const argv = cmdline.split('\0').filter((part) => part !== '')
  for (let i = 0; i < argv.length - 1; i += 1) {
    if ((argv[i] === 'cli.js' || argv[i].endsWith('/cli.js')) && argv[i + 1] === 'daemon') return true
  }
  return false
}

async function preflightCleanup() {
  const stale = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true },
  })
  for (const workspace of stale) {
    console.log(`preflight: removing leftover workspace ${workspace.id} (${workspace.name})`)
    const runs = await prisma.agentRun
      .findMany({ where: { agent: { team: { workspaceId: workspace.id } } }, select: { id: true, pid: true } })
      .catch(() => [])
    for (const run of runs) {
      if (run.pid === null || !isAlive(run.pid)) continue
      console.log(`preflight: killing leftover child ${String(run.pid)} for run ${run.id}`)
      try {
        process.kill(run.pid, 'SIGKILL')
      } catch {
        // Already gone between the check and the signal -- the outcome we wanted anyway.
      }
    }
    await prisma.executionEvent.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {})
  }
}

async function dumpGateRows() {
  const workspaces = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true, haltedReason: true },
  })
  const dump = []
  for (const workspace of workspaces) {
    const tasks = await prisma.task.findMany({
      where: { workspaceId: workspace.id },
      select: { id: true, title: true, status: true, attempt: true, maxAttempts: true, activeRunId: true },
    })
    const runs = await prisma.agentRun.findMany({
      where: { agent: { team: { workspaceId: workspace.id } } },
      include: { agent: { select: { name: true } } },
      orderBy: { startedAt: 'asc' },
    })
    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { seq: 'asc' },
      select: { seq: true, runId: true, type: true, payload: true },
    })
    dump.push({
      workspace,
      tasks,
      runs: runs.map((run) => ({
        id: run.id,
        agent: run.agent.name,
        provider: run.provider,
        status: run.status,
        pid: run.pid,
        pidAlive: isAlive(run.pid),
        startedAt: run.startedAt,
        terminalAt: run.terminalAt,
      })),
      events: events.map((event) => ({ seq: event.seq, runId: event.runId, type: event.type, payload: event.payload })),
    })
  }
  return JSON.stringify(dump, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
}

async function fail(message) {
  let screenshotPath = null
  if (page !== null && diagDir !== null) {
    screenshotPath = join(diagDir, `failure-${String(Date.now())}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
  }
  const rows = await dumpGateRows().catch(
    (cause) => `<could not dump gate rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
  )
  const daemonTail = daemonOutput.length > 8_000 ? `…${daemonOutput.slice(-8_000)}` : daemonOutput
  const url = page === null ? '<no page>' : page.url()
  throw new Error(
    `${message}\n--- browser url ---\n${url}\n--- screenshot ---\n${screenshotPath ?? '<none>'}\n` +
      `--- daemon output (tail) ---\n${daemonTail}\n--- browser console (tail) ---\n${browserConsole.slice(-40).join('\n')}\n--- gate rows ---\n${rows}`,
  )
}

async function waitUntil(description, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs
  let lastDetail = '<never probed>'
  for (;;) {
    if (daemon !== null && daemonExited) {
      await fail(`the daemon exited while waiting for ${description}`)
    }
    const result = await probe()
    if (result.done) return result.value
    lastDetail = result.detail
    if (Date.now() > deadline) {
      await fail(`timed out after ${String(timeoutMs)}ms waiting for ${description} -- last seen: ${lastDetail}`)
    }
    await delay(POLL_INTERVAL_MS)
  }
}

async function waitVisible(locator, description) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
  } catch {
    await fail(`timed out waiting for ${description} to become visible`)
  }
}

/** `gate-m14-fidelity.mjs`'s `gotoReliably`, verbatim (see that file for the full rationale: one
 *  retry, ONLY on `next dev`'s own manifest-race signature, everything else fails immediately
 *  through `fail()`). */
async function gotoReliably(url) {
  const consoleStart = browserConsole.length
  const nextOutputStart = nextOutput.length
  const raced = () =>
    browserConsole.slice(consoleStart).some((line) => line.includes(MANIFEST_RACE_SIGNATURE)) ||
    nextOutput.slice(nextOutputStart).includes(MANIFEST_RACE_SIGNATURE)

  const describe = (response, error) => {
    if (error !== null) return `failed (${error instanceof Error ? error.message : String(error)})`
    if (response === null) return 'resolved with no response (an anchor/same-document navigation, per Playwright -- unexpected for a full page load)'
    return `returned ${String(response.status())}`
  }

  let first = null
  let firstError = null
  try {
    first = await page.goto(url, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  } catch (cause) {
    firstError = cause
  }
  if (first !== null && first.status() < 500) return first

  await delay(50)
  if (!raced()) {
    await fail(`gotoReliably: ${url} ${describe(first, firstError)} without the dev-server manifest-race signature`)
  }
  console.log(`gotoReliably: ${url} ${describe(first, firstError)}, signature matched -- retrying once`)
  gotoRetries.push(url)
  await delay(300)

  let second = null
  let secondError = null
  try {
    second = await page.goto(url, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  } catch (cause) {
    secondError = cause
  }
  if (secondError !== null || second === null || second.status() >= 500) {
    await fail(`gotoReliably: ${url} ${describe(second, secondError)} on the retry too`)
  }
  return second
}

async function clickUntil(locator, predicate, description) {
  for (const waitBudgetMs of [ACTION_TIMEOUT_MS, 10_000]) {
    let clickError = null
    try {
      await locator.click({ timeout: 5_000 })
    } catch (cause) {
      clickError = cause
    }
    const deadline = Date.now() + waitBudgetMs
    while (Date.now() < deadline) {
      if (await predicate().catch(() => false)) return
      await delay(100)
    }
    if (clickError !== null) {
      await fail(`clicking ${description} failed: ${clickError instanceof Error ? clickError.message : String(clickError)}`)
    }
  }
  await fail(`clicking ${description} did not produce the expected result even after a retry click`)
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'aiteamos-gate-m18-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ---- Preflight ------------------------------------------------------------------------------

  // The outer zero-spend precondition, `gate-m14-fidelity.mjs`'s verbatim (Decision 10): proves
  // the OPERATOR invoked this correctly, even though this gate's own daemon dispatch below never
  // actually reads this value -- see the file header for why the two are not the same check.
  const fakeClaude = process.env['AITEAMOS_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'AITEAMOS_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  AITEAMOS_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m18-skill-and-teeth',
    )
  }
  try {
    accessSync(fakeClaude, constants.X_OK)
  } catch {
    throw new Error(`AITEAMOS_CLAUDE_BIN=${fakeClaude} is not an executable file`)
  }
  if (!fakeClaude.includes('gate-fakes')) {
    throw new Error(
      `AITEAMOS_CLAUDE_BIN=${fakeClaude} is not one of scripts/gate-fakes/. This gate must not reach a vendor account.`,
    )
  }

  const envPath = join(repoRoot, '.env')
  if (!existsSync(envPath)) {
    throw new Error(`no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m18-skill-and-teeth passes --env-file=.env). Create it before running this gate.`)
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m18-skill-and-teeth`')
  }
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(`no Chromium binary at ${chromiumPath} -- set CHROMIUM_PATH to a real executable`)
  }
  if (!existsSync(ORCHESTRATOR_CLI)) {
    throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI} -- run \`npm run build\` (or the gate's own tsc --build)`)
  }
  if (!existsSync(FAKE_CLAUDE)) {
    throw new Error(`no fake CLI at ${FAKE_CLAUDE} -- packages/providers/test/fake-claude.mjs is expected to exist untouched`)
  }
  try {
    await prisma.$queryRaw`select 1`
  } catch (cause) {
    throw new Error(
      `the database at DATABASE_URL is not reachable (${cause instanceof Error ? cause.message : String(cause)}) -- ` +
        'start Postgres before running this gate.',
    )
  }

  // The dev-DB migration precondition (Task 13 brief): a cheap SELECT probe for the enum value
  // Task 1's migration adds, rather than this gate cryptically failing mid-run the first time it
  // tries to write a `run.tool_denied` event against a database that never migrated. `db:migrate`
  // is deliberately NOT run from inside this gate -- see the file header.
  const enumProbe = await prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'EventType' AND e.enumlabel = 'run.tool_denied'
    ) AS present`
  if (enumProbe[0]?.present !== true) {
    throw new Error(
      "the dev database at DATABASE_URL has no 'run.tool_denied' EventType member -- the two m18 migrations have not " +
        'reached it yet. Run `npm run db:migrate` (reads DATABASE_URL from .env via Prisma\'s own dotenv/config) before ' +
        're-running this gate.',
    )
  }
  console.log("preflight: dev DB carries 'run.tool_denied' -- the m18 migrations are applied")

  // Refuses under a genuinely running orchestrator daemon (`gate-m17-stability.mjs`'s hardened
  // check): this gate spawns its OWN daemon against one workspace, and a second live daemon on the
  // host could dispatch this gate's freshly-created `ready` task out from under it before this
  // gate's own daemon ever gets there.
  const daemonCandidates = spawnSync('pgrep', ['-f', 'cli.js daemon'], { encoding: 'utf8' })
  const candidatePids = (daemonCandidates.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => Number(line))
  const realDaemonPids = candidatePids.filter((pid) => isRealDaemonProcess(pid))
  if (realDaemonPids.length > 0) {
    throw new Error(`gate:m18-skill-and-teeth REFUSED -- an orchestrator daemon is already running (pid ${realDaemonPids.join(', ')})`)
  }

  console.log(`fake claude (outer precondition): ${fakeClaude}`)
  console.log(`fake claude (this gate's own dispatch): node ${FAKE_CLAUDE} --fixture permission-matrix-deny`)
  console.log(`chromium:    ${chromiumPath}`)

  await preflightCleanup()

  // ---- One workspace, one team, one agent with a matrix deny, one task ----------------------
  repoPath = makeRepo('repo')
  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath,
      autoMerge: true,
      verifyCommands: ['true'],
      setupCommands: [],
      goal: 'prove enforcement, the skill chain, and the two chrome truths',
    },
  })
  workspaceId = workspace.id
  teamId = (await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })).id
  agentId = (
    await prisma.agent.create({
      data: { teamId, name: WORKER_NAME, role: 'backend', provider: WORKER_PROVIDER, model: WORKER_MODEL },
    })
  ).id
  // Stage 1's deny: 'run tests' maps to Bash for claude_code (`CAPABILITY_TOOLS` in
  // `packages/control/src/permission.ts`) -- exactly the tool/capability pair the fixture's own
  // canned `hook_response` reason names.
  await prisma.agentPermission.create({ data: { agentId, tool: 'run tests', mode: 'deny' } })
  const enforcementTask = await prisma.task.create({
    data: {
      workspaceId,
      title: 'Read a file and try to run tests',
      description: 'Read target.txt, then run the test suite.',
      status: 'ready',
      requiredRole: 'backend',
      maxAttempts: 2,
    },
  })
  console.log(`workspace ${workspaceId}; team ${teamId}; agent ${agentId}; enforcement task ${enforcementTask.id}`)

  // A second, genuinely fresh, empty workspace for stage 2's `skill-empty` proof -- no team, no
  // agent, no events: the honest zero state a workspace looks like before anything has ever run.
  const emptyWorkspace = await prisma.workspace.create({
    data: {
      name: EMPTY_WORKSPACE_NAME,
      repoPath,
      autoMerge: false,
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  emptyWorkspaceId = emptyWorkspace.id
  console.log(`empty workspace (stage 2's fresh check) ${emptyWorkspaceId}`)

  // ---- The real web shell, on a free port, and a real browser -------------------------------
  const preferredPort = await findFreePort()
  nextServer = spawn('node', ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort)], {
    cwd: repoRoot,
    // M21 A1: the operator's AITEAMOS_SESSION_SECRET must not reach the child, or every page is /login.
    env: loopbackChildEnv({ AITEAMOS_GATE_WARM: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let nextExited = false
  let resolvedPort = null
  nextServer.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    nextOutput += text
    process.stdout.write(`[next] ${text}`)
    const match = /http:\/\/localhost:(\d+)/.exec(nextOutput)
    if (match) resolvedPort = Number(match[1])
  })
  nextServer.stderr.on('data', (chunk) => process.stderr.write(`[next] ${chunk}`))
  nextServer.on('exit', () => {
    nextExited = true
  })
  nextServer.on('error', (error) => {
    nextExited = true
    console.error('[next] failed to start:', error)
  })
  {
    const deadline = Date.now() + NEXT_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (nextExited) throw new Error(`next dev exited before becoming ready -- output so far: ${nextOutput}`)
      if (resolvedPort !== null && /Ready in \d+/.test(nextOutput)) break
      await delay(50)
    }
    if (resolvedPort === null || !/Ready in \d+/.test(nextOutput)) {
      throw new Error(`next dev did not become ready within ${String(NEXT_READY_TIMEOUT_MS)}ms -- output so far: ${nextOutput}`)
    }
  }
  const baseUrl = `http://localhost:${String(resolvedPort)}`
  console.log(`next dev ready at ${baseUrl}`)

  // Warm every route once, synchronously, before the browser exists -- `gate-m14-fidelity.mjs`'s
  // fix for `next dev`'s manifest-race 500s (M17 Task 7, Flake 6), cribbed verbatim.
  console.log('warming every route before the browser arrives (closes the dev-server manifest race)...')
  const WARMUP_APP_DIR = join(repoRoot, 'apps/web/src/app')
  const DUMMY_ID = '00000000-0000-4000-8000-000000000000'
  const warmupRouteFiles = []
  ;(function walkAppDir(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walkAppDir(join(dir, entry.name))
      else if (entry.name === 'route.ts' || entry.name === 'page.tsx') warmupRouteFiles.push(join(dir, entry.name))
    }
  })(WARMUP_APP_DIR)
  for (const file of warmupRouteFiles.sort()) {
    const routeDir = file.slice(WARMUP_APP_DIR.length).replace(/\/(route\.ts|page\.tsx)$/, '')
    const urlPath = routeDir === ''
      ? '/'
      : routeDir
          .split('/')
          .map((segment) => (segment === '[workspaceId]' ? workspaceId : segment.startsWith('[') ? DUMMY_ID : segment))
          .join('/')
    const response = await fetch(`${baseUrl}${urlPath}`).catch((cause) => {
      throw new Error(`warm-up request for ${urlPath} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
    await response.body?.cancel().catch(() => {})
    console.log(`warm-up: ${urlPath} -> ${String(response.status)}`)
  }
  console.log(`warm-up done: ${String(warmupRouteFiles.length)} route(s) compiled`)

  browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  page.on('pageerror', (error) => {
    console.error(`[browser:pageerror] ${error}`)
    pushBrowserConsole(`[pageerror] ${String(error)}`)
  })
  page.on('console', (message) => {
    pushBrowserConsole(`[${message.type()}] ${message.text()}`)
  })
  page.on('requestfailed', (request) => {
    pushBrowserConsole(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`)
  })

  // ============================================================================================
  // Stage 1: Enforcement -- a matrix deny survives the run, and the Activity page shows it.
  // ============================================================================================
  daemon = spawn(
    'node',
    [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspaceId, '--period', '500'],
    {
      cwd: repoRoot,
      // The inner override (see file header): this dispatch always replays the matrix-deny
      // fixture through `fake-claude.mjs`, regardless of what the outer `AITEAMOS_CLAUDE_BIN`
      // precondition named -- `buildAdapterRegistry` (`apps/orchestrator/src/cli.ts`) reads these
      // once, at THIS child's own start, so it never sees the outer value at all.
      env: {
        ...process.env,
        AITEAMOS_CLAUDE_BIN: 'node',
        AITEAMOS_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture permission-matrix-deny`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  daemon.stdout.on('data', (chunk) => {
    daemonOutput += chunk.toString()
    process.stdout.write(`[daemon] ${chunk}`)
  })
  daemon.stderr.on('data', (chunk) => {
    daemonOutput += chunk.toString()
    process.stderr.write(`[daemon] ${chunk}`)
  })
  daemon.on('exit', (code, signal) => {
    daemonExited = true
    daemonOutput += `\n<daemon exited: code=${String(code)} signal=${String(signal)}>\n`
  })
  daemon.on('error', (error) => {
    daemonExited = true
    daemonOutput += `\n<daemon failed to start: ${String(error)}>\n`
  })

  const dispatched = await waitUntil('the worker to be dispatched with a pid and a provider', DISPATCH_TIMEOUT_MS, async () => {
    const row = await prisma.agentRun.findFirst({ where: { agentId, taskId: enforcementTask.id }, orderBy: { startedAt: 'desc' } })
    if (row === null) return { done: false, detail: 'no run row yet' }
    if (row.pid === null || row.provider === null) {
      return { done: false, detail: `${row.status} pid=${String(row.pid)} provider=${String(row.provider)}` }
    }
    return { done: true, value: row }
  })
  console.log(`stage 1: run ${dispatched.id} dispatched (pid ${String(dispatched.pid)}, provider ${String(dispatched.provider)})`)

  const enforcementRun = await waitUntil('the run to conclude succeeded', RUN_CONCLUDE_TIMEOUT_MS, async () => {
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: dispatched.id } })
    if (row.status === 'paused') {
      await fail('stage 1: the run reached `paused` -- a matrix deny must never pause the run (Task 6\'s routing)')
    }
    return row.status === 'succeeded' ? { done: true, value: row } : { done: false, detail: `run is ${row.status}` }
  })
  console.log(`stage 1: run ${enforcementRun.id} concluded succeeded`)

  // Whatever can still spawn a child dies before its row is deleted, same ordering
  // `gate-m14-fidelity.mjs`'s `finally` uses -- but here it happens mid-run, since stage 1's
  // daemon has nothing left to dispatch and stages 2/3 seed data directly.
  if (daemon !== null && daemon.exitCode === null) {
    daemon.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (daemon.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (daemon.exitCode === null) daemon.kill('SIGKILL')
  }
  // Cleared once stopped ON PURPOSE: `waitUntil`'s own guard (`daemon !== null && daemonExited`)
  // exists to fail FAST when something this gate is still relying on has gone away unexpectedly --
  // stages 2/3 seed their data directly and never touch the daemon again, so leaving this set
  // would trip that guard on the very next `waitUntil` call for a daemon this gate itself, on
  // purpose, just finished with (caught live: the first run of this gate failed exactly this way).
  daemon = null
  if (enforcementRun.pid !== null && isAlive(enforcementRun.pid)) {
    try {
      process.kill(enforcementRun.pid, 'SIGKILL')
    } catch {
      // Already gone -- the outcome we wanted anyway.
    }
  }

  const toolDeniedEvents = await prisma.executionEvent.findMany({
    where: { runId: enforcementRun.id, type: 'run_tool_denied' },
  })
  if (toolDeniedEvents.length !== 1) {
    await fail(`stage 1: expected exactly one run.tool_denied event, found ${String(toolDeniedEvents.length)}`)
  }
  const toolDeniedPayload = toolDeniedEvents[0].payload
  if (toolDeniedPayload?.tool !== 'Bash' || toolDeniedPayload?.capability !== 'run tests') {
    await fail(`stage 1: run.tool_denied payload is ${JSON.stringify(toolDeniedPayload)}, expected {tool:'Bash', capability:'run tests'}`)
  }
  console.log(`stage 1: exactly one run.tool_denied event, payload ${JSON.stringify(toolDeniedPayload)}`)

  const guardrailEvents = await prisma.executionEvent.count({ where: { runId: enforcementRun.id, type: 'guardrail_tripped' } })
  if (guardrailEvents !== 0) {
    await fail(`stage 1: ${String(guardrailEvents)} guardrail.tripped event(s) on the matrix-denied run -- Task 6's routing must not trip a guardrail`)
  }
  console.log('stage 1: zero guardrail.tripped events')

  const pausedEvents = await prisma.executionEvent.count({ where: { runId: enforcementRun.id, type: 'run_paused' } })
  if (pausedEvents !== 0) {
    await fail(`stage 1: ${String(pausedEvents)} run.paused event(s) on the matrix-denied run -- it must never pause`)
  }
  if (enforcementRun.pausedAtStep !== null) {
    await fail(`stage 1: pausedAtStep is ${String(enforcementRun.pausedAtStep)}, expected null -- the run never paused`)
  }
  const enforcementCheckpoint = await prisma.checkpoint.findUnique({ where: { runId: enforcementRun.id } })
  if (enforcementCheckpoint !== null) {
    await fail('stage 1: a Checkpoint row exists for the matrix-denied run -- only a pause writes one, and this run never paused')
  }
  console.log('stage 1: run.paused absent, pausedAtStep null, no Checkpoint row -- the run never paused')

  await gotoReliably(`${baseUrl}/w/${workspaceId}/activity`)
  await waitVisible(page.getByTestId('timeline-viewport'), "the Activity page's timeline")
  await waitVisible(page.getByTestId('tool-denied-text'), 'the denial card')
  const deniedCardText = (await page.getByTestId('tool-denied-text').first().textContent())?.trim()
  if (deniedCardText !== 'Bash denied — run tests') {
    await fail(`stage 1: the denial card reads ${JSON.stringify(deniedCardText)}, expected "Bash denied — run tests"`)
  }
  console.log('stage 1 PASSED: one run.tool_denied, zero guardrail.tripped, never paused, and the Activity page renders the denial card')

  // ============================================================================================
  // Stage 2: Skill tab -- the aggregate canvas, the Focus click, the clear control, the empty
  // state on a genuinely fresh workspace, and the unlocked tab.
  // ============================================================================================

  // Two runs, ordered Skill events seeded directly via the real production write path
  // (`appendEvent` -- the same helper `apps/web/test/integration/skill-graph.test.ts` seeds
  // through), so `seq`/`ts` come from the database rather than being hand-assigned.
  const skillRunAlpha = await prisma.agentRun.create({ data: { agentId, status: 'succeeded' } })
  const skillRunBeta = await prisma.agentRun.create({ data: { agentId, status: 'working' } })

  async function skillCall(runId, name) {
    await appendEvent({
      type: 'run.tool_call',
      workspaceId,
      agentId,
      runId,
      actor: 'agent',
      payload: { name: 'Skill', summary: `Skill ${name}` },
    })
  }

  // Run alpha: A, A, B, B, B -- collapses to A×2, B×3 (two links, both carrying a badge).
  await skillCall(skillRunAlpha.id, 'gate-alpha')
  await skillCall(skillRunAlpha.id, 'gate-alpha')
  await skillCall(skillRunAlpha.id, 'gate-beta')
  await skillCall(skillRunAlpha.id, 'gate-beta')
  await skillCall(skillRunAlpha.id, 'gate-beta')
  // Run beta: C, D -- collapses to C×1, D×1 (no badge on either link), and contributes two more
  // names to the aggregate.
  await skillCall(skillRunBeta.id, 'gate-gamma')
  await skillCall(skillRunBeta.id, 'gate-delta')
  console.log(`stage 2: seeded ordered Skill events for run ${skillRunAlpha.id} (A×2,B×3) and run ${skillRunBeta.id} (C×1,D×1)`)

  await gotoReliably(`${baseUrl}/w/${workspaceId}/graph?mode=skill`)
  await waitVisible(page.getByTestId('graph-canvas'), 'the graph canvas in skill mode')

  // The tab carries no `· later` (Task 11 unlocked it).
  const skillTabText = (await page.getByTestId('graph-mode-skill').first().textContent())?.trim()
  if (skillTabText === null || skillTabText === undefined || skillTabText.includes('later')) {
    await fail(`stage 2: the Skill chain tab reads ${JSON.stringify(skillTabText)} -- it must carry no "· later"`)
  }
  console.log(`stage 2: the Skill chain tab reads ${JSON.stringify(skillTabText)}, no "· later"`)

  // Aggregate: four skill: nodes, with counts.
  await waitUntil('four aggregate skill nodes to render', ACTION_TIMEOUT_MS, async () => {
    const count = await page.getByTestId('skill-node').count()
    return count === 4 ? { done: true, value: count } : { done: false, detail: `${String(count)} skill-node(s) rendered` }
  })
  const aggregateEntries = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="skill-node"]')].map((node) => ({
      name: node.querySelector('[data-testid="skill-node-name"]')?.textContent ?? null,
      calls: node.querySelector('[data-testid="skill-node-calls"]')?.textContent ?? null,
    })),
  )
  const expectedAggregate = { 'gate-alpha': '2 calls', 'gate-beta': '3 calls', 'gate-gamma': '1 call', 'gate-delta': '1 call' }
  for (const [name, calls] of Object.entries(expectedAggregate)) {
    const entry = aggregateEntries.find((candidate) => candidate.name === name)
    if (entry === undefined || entry.calls !== calls) {
      await fail(`stage 2: expected an aggregate skill node ${name} reading "${calls}", found ${JSON.stringify(aggregateEntries)}`)
    }
  }
  console.log(`stage 2: aggregate canvas shows all four skill: nodes with their counts -- ${JSON.stringify(aggregateEntries)}`)

  // Focus: click run alpha's chip, assert DOM order + a ×N badge.
  await clickUntil(
    page.getByTestId('skill-run-chip').filter({ hasText: skillRunAlpha.id.slice(0, 8) }),
    async () => (await page.getByTestId('skillstep-node').count()) === 2,
    "run alpha's chip",
  )
  const chainNames = await page.locator('[data-testid="skillstep-node-name"]').allTextContents()
  if (chainNames.length !== 2 || chainNames[0] !== 'gate-alpha' || chainNames[1] !== 'gate-beta') {
    await fail(`stage 2: run alpha's chain reads ${JSON.stringify(chainNames)} in DOM order, expected ["gate-alpha","gate-beta"]`)
  }
  const chainBadges = await page.locator('[data-testid="skillstep-node-badge"]').allTextContents()
  if (chainBadges.length === 0) {
    await fail('stage 2: run alpha\'s chain rendered no ×N badge, expected one on both links (×2, ×3)')
  }
  console.log(`stage 2: run alpha's chain in DOM order ${JSON.stringify(chainNames)}, badges ${JSON.stringify(chainBadges)}`)

  // Clear: back to the aggregate.
  await clickUntil(
    page.getByTestId('skill-focus-clear'),
    async () => (await page.getByTestId('skill-node').count()) === 4 && (await page.getByTestId('skillstep-node').count()) === 0,
    'the "← aggregate" clear control',
  )
  console.log('stage 2: skill-focus-clear returned the canvas to the aggregate')

  // A genuinely fresh, empty workspace: skill-empty.
  await gotoReliably(`${baseUrl}/w/${emptyWorkspaceId}/graph?mode=skill`)
  await waitVisible(page.getByTestId('skill-empty'), 'the empty-state hint on a fresh workspace')
  console.log('stage 2 PASSED: aggregate nodes with counts, a Focus click in DOM order with a ×N badge, the clear control, skill-empty on a fresh workspace, no "· later"')

  // ============================================================================================
  // Stage 3: Chrome truths -- the Activity sse·ms chip, and the deniedToolUseIds reader line.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${workspaceId}/activity`)
  await waitVisible(page.getByTestId('connection'), 'the Activity connection chip')
  const beforeTick = (await page.getByTestId('connection').first().textContent())?.trim()
  console.log(`stage 3: connection chip before a fresh frame: ${JSON.stringify(beforeTick)}`)

  // One more real event, appended through the production write path (`pg_notify('events', ...)`
  // inside `appendEvent`) while the page's SSE connection is open -- the frame that gives the
  // chip something to measure. Tied to the concluded enforcement run/agent; `ExecutionEvent.runId`
  // carries no foreign key, so appending against an already-terminal run is inert to everything
  // but this one read.
  await appendEvent({
    type: 'run.tool_call',
    workspaceId,
    agentId,
    runId: enforcementRun.id,
    actor: 'agent',
    payload: { name: 'Bash', summary: 'gate stage 3 -- sse tick' },
  })
  await waitUntil('the connection chip to read sse · <n>ms once the stream ticks', ACTION_TIMEOUT_MS, async () => {
    const text = await page.getByTestId('connection').first().textContent().catch(() => null)
    return text !== null && /sse · \d+ms/.test(text) ? { done: true, value: text } : { done: false, detail: `chip reads ${JSON.stringify(text)}` }
  })
  console.log('stage 3: the Activity chip reads sse · <n>ms once the stream ticked')

  // The deniedToolUseIds reader: a paused task, a paused run, a Checkpoint carrying two denied ids.
  const readerTask = await prisma.task.create({
    data: {
      workspaceId,
      title: 'Gate stage 3 -- paused with denials',
      description: 'seeded directly, never dispatched',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: 2,
    },
  })
  const readerRun = await prisma.agentRun.create({
    data: {
      taskId: readerTask.id,
      agentId,
      status: 'paused',
      pausedAtStep: 3,
      pauseReason: 'human',
      sessionId: 'gate-stage3-session',
    },
  })
  const readerRunDir = join(repoPath, `reader-run-${readerRun.id}`)
  await prisma.checkpoint.create({
    data: {
      runId: readerRun.id,
      sessionId: 'gate-stage3-session',
      worktreePath: readerRunDir,
      pauseFlagPath: join(readerRunDir, 'pause.flag'),
      numTurns: 3,
      deniedToolUseIds: ['toolu_AA111111', 'toolu_BB222222'],
      headCommit: 'deadbeef',
      dirtyFiles: [],
      settingsPath: join(readerRunDir, 'settings.json'),
      hookPath: join(readerRunDir, 'hook.sh'),
      gitAuthorName: 'Gate',
      gitAuthorEmail: 'gate@example.com',
    },
  })
  console.log(`stage 3: seeded paused task ${readerTask.id} / run ${readerRun.id} with a checkpoint carrying 2 deniedToolUseIds`)

  await gotoReliably(`${baseUrl}/w/${workspaceId}/tasks`)
  await waitVisible(page.getByTestId('column'), 'the Tasks board')
  await clickUntil(
    page.getByTestId('task-card').filter({ hasText: 'Gate stage 3 -- paused with denials' }),
    async () => page.getByRole('complementary', { name: 'Task detail' }).isVisible(),
    "the seeded task's card",
  )
  const deniedLine = page.getByText('2 tool calls denied during pause · toolu_AA…, toolu_BB…')
  await waitVisible(deniedLine, "the panel's deniedToolUseIds reader line")
  console.log('stage 3 PASSED: the Activity chip measured a real frame, and the paused checkpoint\'s reader line rendered')

  console.log(
    gotoRetries.length === 0
      ? 'gotoReliably: no retries this run'
      : `gotoReliably retried ${String(gotoRetries.length)} time(s): ${JSON.stringify(gotoRetries)}`,
  )
  console.log(`PASS: ${PASS_LINE}`)
  exitCode = 0
} finally {
  if (daemon !== null && daemon.exitCode === null) {
    daemon.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (daemon.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (daemon.exitCode === null) daemon.kill('SIGKILL')
  }
  if (workspaceId !== null) {
    const runs = await prisma.agentRun
      .findMany({ where: { agent: { team: { workspaceId } } }, select: { id: true, pid: true } })
      .catch(() => [])
    for (const row of runs) {
      if (row.pid === null || !isAlive(row.pid)) continue
      console.log(`cleanup: killing child ${String(row.pid)} for run ${row.id}`)
      try {
        process.kill(row.pid, 'SIGKILL')
      } catch {
        // Already gone -- the outcome we wanted anyway.
      }
    }
  }
  sweepStrayChildren([repoPath])

  if (browser !== null) await browser.close().catch(() => {})
  if (nextServer !== null && nextServer.exitCode === null) {
    nextServer.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextServer.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextServer.exitCode === null) nextServer.kill('SIGKILL')
  }
  // FK-ordered: `ExecutionEvent` has no FK to `Workspace`, deleted explicitly first; the workspace
  // delete then cascades Team/Agent/Task/AgentRun/Checkpoint/AgentPermission. Both workspaces this
  // gate created share the `M18 Gate` prefix, so this also serves as belt-and-braces cleanup for
  // the empty one even though nothing but the workspace row itself was ever written there.
  for (const id of [workspaceId, emptyWorkspaceId]) {
    if (id === null) continue
    await prisma.executionEvent.deleteMany({ where: { workspaceId: id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id } }).catch(() => {})
  }
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
