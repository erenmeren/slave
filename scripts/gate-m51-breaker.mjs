// M51's own gate (spec R8): "twelve identical calls, one different, and a build that is not a loop".
//
// `gate-m45-project-experience.mjs`'s scaffolding -- a free port, a real `next dev`, a real Chromium
// through `playwright-core` at CHROMIUM_PATH, a scenario written with prisma and the real CLI before
// the browser opens -- plus `gate-m49-memory.mjs`'s several-projects/several-daemons shape, because
// three of the nine measuring stages need a daemon of their own driving a different fixture.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m51-breaker
//
// NEVER A MODEL CALL. Every daemon and every CLI invocation is spawned with SLAVEOFAI_CLAUDE_BIN=node
// and SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m8-flow --work-fixture <one of the three M51
// fixtures>", and the preflight REFUSES to start unless the operator's own SLAVEOFAI_CLAUDE_BIN points
// at an executable under `scripts/gate-fakes/` with SLAVEOFAI_REQUIRE_FAKE_CLI=1 beside it.
//
// The nine measuring stages, each measuring one thing the milestone claims:
//   1. The evidence is persisted and the HASH discriminates: thirteen `run.tool_call` rows, twelve
//      byte-equal `argsHash` values and one that is not, all thirteen with the SAME `summary`.
//   2. STEER -- the sweep's own rung, then the Supervisor's round trip: a `run_looping` decision
//      carrying the exact sentence, the pause it claims, and a resume recorded as the SYSTEM's.
//   3. CONSTRAIN -- one rung up, thirty calls left, and the `breaker` CLI verb says so.
//   4. STOP -- `guardrail.tripped`, a `failed` run (not `stopped`), a task back in `rework` and an
//      attempt charged.
//   5. The error storm trips on its own, on six DIFFERENT commands.
//   6. THE NEGATIVE: a run whose one tool call has not come back trips nothing across three beats.
//   7. Three cost figures on the brief -- and `stats.spentUsd` byte-equal on both sides of them.
//   8. Tokens mid-run, sampled while stage 1's run is still `working`.
//   9. In a real browser: the guardrail's LABEL and not its key, the breaker card, and the word
//      CONSTRAINED on a run card.
//
// THE GATE ASSERTS, IT NEVER FIXES. Every stage prints every measured value before asserting it, and
// every row it writes by hand is printed with the reason it was written.
//
// IT NEVER EDITS A FILE IN THIS REPOSITORY. The three fixtures are read and never written; the temp
// repositories it makes are removed in the `finally`; `git status --porcelain` after a green run is
// what it was before.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: like `gate-m14-fidelity.mjs` and
// `gate-m45-project-experience.mjs`, it boots `next dev` against the repo's own `apps/web/.next` on a
// freshly-chosen free port, and a second `next dev` sharing that directory corrupts the on-disk build
// cache for both. Stop any running dev server first (`pgrep -af "next dev"`).

import { execFileSync, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids } from './lib/daemon-process.mjs'
import { prisma } from '../packages/db/dist/client.js'
import { EVENT_TYPE_BY_DOMAIN_TYPE } from '../packages/db/dist/enums.js'
import { workspaceStats } from '../packages/control/dist/index.js'
import {
  BREAKER_LEVEL_LABEL,
  BREAKER_STEER_TEXT,
  BREAKER_TRIP_LABEL,
  CONSTRAIN_GRACE_CALLS,
  ERROR_STORM_COUNT,
  GUARDRAIL_LABEL,
  NO_PROGRESS_BEATS,
  RUN_UNMEASURED_CAP_USD,
  REPEAT_TRIP_COUNT,
  estimateCostUsd,
} from '../packages/domain/dist/index.js'

const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 100
const DAEMON_PERIOD_MS = 500
/** How long one rung is given after its beat has been back-dated. The daemon sweeps once per
 *  period, so this is twenty sweeps' worth of room and not a guess about the machine. */
const RUNG_TIMEOUT_MS = 20_000
const WORKING_TIMEOUT_MS = 90_000
/** `gate-m14-fidelity.mjs`'s own signature for next dev's torn `loadManifest` read. */
const MANIFEST_RACE_SIGNATURE = 'Unexpected end of JSON input'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const PASS_LINE = 'twelve identical calls, one different, and a build that is not a loop'

// Suffixed per run (`gate-m45-project-experience.mjs`'s idiom): `Workspace.name` IS unique, and a
// distinct name per run keeps two overlapping executions from colliding on it. `preflightCleanup`
// removes leftovers by PREFIX, which is what makes all four projects one sweep.
const STAMP = new Date().toISOString().slice(11, 19)
const WORKSPACE_PREFIX = 'M51 Gate Project'
const WORKSPACE_NAME = `${WORKSPACE_PREFIX} ${STAMP}`
const STORM_WORKSPACE_NAME = `${WORKSPACE_PREFIX} Storm ${STAMP}`
const QUIET_WORKSPACE_NAME = `${WORKSPACE_PREFIX} Quiet ${STAMP}`
const COST_WORKSPACE_NAME = `${WORKSPACE_PREFIX} Cost ${STAMP}`
const TEAM_NAME = 'M51 Gate Department'
const WORKER_NAME = 'Dev'
/** The worker the two hand-seeded rows of stages 2b and 9 belong to, so neither can be confused
 *  with the real looping run or read off the same card. */
const SPARE_WORKER_NAME = 'Bo'
const LOOP_TASK_TITLE = 'M51 Gate Looping Task'
const STORM_TASK_TITLE = 'M51 Gate Error Storm Task'
const QUIET_TASK_TITLE = 'M51 Gate Quiet Build Task'
const WORKER_ROLE = 'backend'

/** `BREAKER_BEAT_MS`. The gate does not wait sixty seconds three times -- it back-dates
 *  `breakerBeatAt` between rungs, exactly as `gate:m50-ephemeral` back-dates a decision to clear a
 *  cooldown (plan decision D22), and PRINTS each move so the log says what it did. */
const BEAT_BACKDATE_MS = 2 * 60 * 1000

/** The three cost rows stage 7 seeds, by hand: measured, unmeasured, estimable. */
const MEASURED_USD = 3.5
const ESTIMATE_MODEL = 'claude-opus-5'
const ESTIMATE_TOKENS_IN = 1_000_000
const COST_BUDGET_USD = 25

/**
 * The delay the fake CLI sleeps between two fixture lines, set on every daemon this gate spawns.
 *
 * The three M51 fixtures end with an idle tail of lines the parser answers `ignored`, so this number
 * is what turns that tail into TIME: the evidence lands in the first seconds and the run then stays
 * `working` -- with its pump alive -- for long enough that three back-dated beats, a cancel and the
 * pump's own conclusion all happen on a real live run rather than on a row the gate resurrected.
 */
const LINE_DELAY_MS = 400

/** The command every `loop.ndjson` call carries. Stage 1's negative: it is nowhere in the log. */
const LOOP_COMMAND = 'npm run build --workspace=@fixture/app'
/** The repeat arm's own trip: twelve trailing identical calls in `loop.ndjson`. */
const LOOP_REPEATS = 12
/** Every tool call `loop.ndjson` makes -- the twelve plus the odd one in front of them. */
const LOOP_CALLS = LOOP_REPEATS + 1
/** `error-storm.ndjson`'s six failing calls, and the class every one of them reports. */
const STORM_ERRORS = 6
const STORM_ERROR_CLASS = 'api_error'
/** How many beats the NEGATIVE stage drives. One more than `no_progress` needs, so a detector that
 *  forgot the outstanding-call suppression would have tripped by the second and be caught by the
 *  third. */
const QUIET_BEATS = NO_PROGRESS_BEATS + 1

/** The first viewport, `gate-m45`'s own. */
const VIEWPORT = { width: 1440, height: 900 }

const dbType = (domainType) => {
  const value = EVENT_TYPE_BY_DOMAIN_TYPE[domainType]
  if (value === undefined) throw new Error(`no database enum value for the event type ${domainType}`)
  return value
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Asks the OS for a free TCP port. `next dev -p <port>` still auto-increments if something grabs
 *  it between this call and the spawn, so the ready-wait parses the ACTUAL bound port back out of
 *  next dev's own ready line rather than trusting this one blindly.
 *  (`scripts/gate-m45-project-experience.mjs`, verbatim.) */
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

/** A throwaway git repository for one project to hold its worktrees in.
 *  (`gate-m50-ephemeral.mjs`'s `makeRepo`.) */
function makeRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `slaveofai-gate-m51-${label}-`))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  git(['config', 'core.hooksPath', ''])
  writeFileSync(join(dir, 'README.md'), `# ${label} fixture\n`)
  git(['add', '-A'])
  git(['commit', '-q', '--no-verify', '-m', 'initial'])
  return dir
}

/** Removes anything a prior interrupted run left behind, by NAME PREFIX -- all four projects, in the
 *  same FK order the `finally` block below uses. Safe against an empty database. */
async function preflightCleanup() {
  const stale = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true },
  })
  for (const workspace of stale) {
    console.log(`preflight: removing leftover workspace ${workspace.id} (${workspace.name})`)
    await removeWorkspace(workspace.id)
  }
}

/** Teardown for one project, in FK order. `ExecutionEvent` has no FK to `Workspace` (M2's
 *  append-only log outlives entity lifecycles by design) so it goes explicitly first; the workspace
 *  delete then cascades SupervisorDecision, Memory, RunContext, Checkpoint, SlaveRun,
 *  TaskDependency, Task, Slave and Team. */
async function removeWorkspace(id) {
  await prisma.executionEvent.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.supervisorDecision.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.slaveMessage.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.memory.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.runContext.deleteMany({ where: { run: { slave: { team: { workspaceId: id } } } } }).catch(() => {})
  await prisma.checkpoint.deleteMany({ where: { run: { slave: { team: { workspaceId: id } } } } }).catch(() => {})
  await prisma.slaveRun.deleteMany({ where: { slave: { team: { workspaceId: id } } } }).catch(() => {})
  await prisma.taskDependency.deleteMany({ where: { task: { workspaceId: id } } }).catch(() => {})
  await prisma.goalVersion.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.task.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.slave.deleteMany({ where: { team: { workspaceId: id } } }).catch(() => {})
  await prisma.team.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.workspace.delete({ where: { id } }).catch(() => {})
}

let exitCode = 1
let nextServer = null
let nextOutput = ''
let browser = null
let page = null
let diagDir = null
/** Every workspace this gate created, in creation order, for the `finally`. */
const workspaceIds = []
/** Every temp repository this gate made. */
const repoPaths = []
/** Every daemon this gate has ever spawned, in order -- the `finally` kills whichever of them is
 *  somehow still alive, not just the last one. */
const daemons = []
/** The browser console, newest last, for `fail()`'s dump. */
const browserConsole = []
/** Every URL `gotoReliably` retried. */
const gotoRetries = []

/** One run row as this gate prints it: a failure that shows only ids is a failure nobody can
 *  diagnose from the log. */
const describeRun = (row) =>
  row === null
    ? '<no run>'
    : JSON.stringify({
        id: row.id,
        status: row.status,
        kind: row.kind,
        pid: row.pid,
        toolCalls: row.toolCalls,
        toolCallCap: row.toolCallCap,
        breakerLevel: row.breakerLevel,
        breakerTrips: row.breakerTrips,
        breakerSteers: row.breakerSteers,
        breakerQuietBeats: row.breakerQuietBeats,
        breakerBeatAt: row.breakerBeatAt === null ? null : row.breakerBeatAt.toISOString(),
        pauseReason: row.pauseReason,
        queuedMessage: row.queuedMessage,
        tokensIn: row.tokensIn,
        tokensOut: row.tokensOut,
        costUsd: row.costUsd,
        model: row.model,
        provider: row.provider,
      })

/** Every row this gate could have written, for a FAIL's diagnostic dump. BigInt `seq` stringified. */
async function dumpGateRows() {
  const workspaces = []
  for (const id of workspaceIds) {
    const row = await prisma.workspace
      .findUnique({
        where: { id },
        include: {
          tasks: true,
          teams: { include: { slaves: { include: { runs: true } } } },
          supervisorDecisions: true,
        },
      })
      .catch(() => null)
    workspaces.push(row)
  }
  const daemonTails = daemons.map((d) => ({
    label: d.label,
    pid: d.proc.pid ?? null,
    exited: d.exited,
    output: d.output.length > 6_000 ? `…${d.output.slice(-6_000)}` : d.output,
  }))
  return JSON.stringify({ workspaces, daemonTails }, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m51-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ============================================================================================
  // Stage 0: the preflight. Refusals, never fallbacks -- then the four projects.
  // ============================================================================================

  // Zero spend, ENFORCED (Decision 10, M32 item 7). Four of the nine stages drive a real daemon;
  // without this refusal a lost fake binary would reach a vendor account instead.
  const fakeClaude = process.env['SLAVEOFAI_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'SLAVEOFAI_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m51-breaker',
    )
  }
  try {
    accessSync(fakeClaude, constants.X_OK)
  } catch {
    throw new Error(`SLAVEOFAI_CLAUDE_BIN=${fakeClaude} is not an executable file`)
  }
  if (!fakeClaude.startsWith(join(repoRoot, 'scripts/gate-fakes'))) {
    throw new Error(
      `SLAVEOFAI_CLAUDE_BIN=${fakeClaude} is not under ${join(repoRoot, 'scripts/gate-fakes')}. ` +
        'This gate must not reach a vendor account.',
    )
  }
  if (process.env['SLAVEOFAI_REQUIRE_FAKE_CLI'] !== '1') {
    throw new Error(
      'SLAVEOFAI_REQUIRE_FAKE_CLI is not 1. Set it beside SLAVEOFAI_CLAUDE_BIN so a lost fake binary is a ' +
        'refusal rather than a silent fallback to the real `claude` (M32 item 7).',
    )
  }
  const envPath = join(repoRoot, '.env')
  if (!existsSync(envPath)) {
    throw new Error(
      `no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m51-breaker passes ` +
        '--env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m51-breaker`')
  }
  if (!existsSync(ORCHESTRATOR_CLI)) {
    throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI} -- run \`npx tsc --build\` first`)
  }
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)
  for (const fixture of ['loop', 'error-storm', 'quiet-build']) {
    const path = join(repoRoot, 'packages/providers/test/fixtures', `${fixture}.ndjson`)
    if (!existsSync(path)) throw new Error(`the M51 fixture ${fixture}.ndjson is missing at ${path}`)
  }
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- stage 9 reads a real rendered page, so set CHROMIUM_PATH to a ` +
        'real executable (e.g. a playwright-installed chromium under ~/.cache/ms-playwright/...).',
    )
  }
  try {
    await prisma.$queryRaw`select 1`
  } catch (cause) {
    throw new Error(
      `the database at DATABASE_URL is not reachable (${cause instanceof Error ? cause.message : String(cause)}) -- ` +
        'start Postgres and apply migrations before running this gate.',
    )
  }
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m51-breaker REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate drives its own and would be measuring somebody else\'s ticks.',
    )
  }
  console.log(`fake claude: ${fakeClaude}`)
  console.log(`chromium:    ${chromiumPath}`)
  console.log(
    `domain numbers: REPEAT_TRIP_COUNT=${String(REPEAT_TRIP_COUNT)} ERROR_STORM_COUNT=${String(ERROR_STORM_COUNT)} ` +
      `NO_PROGRESS_BEATS=${String(NO_PROGRESS_BEATS)} CONSTRAIN_GRACE_CALLS=${String(CONSTRAIN_GRACE_CALLS)}`,
  )
  assert(
    LOOP_REPEATS >= REPEAT_TRIP_COUNT,
    `loop.ndjson's ${String(LOOP_REPEATS)} trailing identical calls are fewer than REPEAT_TRIP_COUNT (${String(REPEAT_TRIP_COUNT)})`,
  )
  assert(
    STORM_ERRORS >= ERROR_STORM_COUNT,
    `error-storm.ndjson's ${String(STORM_ERRORS)} failures are fewer than ERROR_STORM_COUNT (${String(ERROR_STORM_COUNT)})`,
  )

  await preflightCleanup()

  /** The environment every child gets: the fake CLI, the fixture this daemon replays for WORK runs,
   *  and the line delay that turns each fixture's idle tail into time. */
  const childEnv = (workFixture) =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      // `SLAVEOFAI_CLAUDE_ARGS` rides through as `extraArgs` on every spawn, which is already how
      // `--fixture` itself arrives -- and it is the ONE per-daemon channel a gate can count on
      // (M39 erratum E6, M51 erratum E16).
      SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8-flow --work-fixture ${workFixture}`,
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
      FAKE_CLAUDE_LINE_DELAY_MS: String(LINE_DELAY_MS),
    })

  /** Runs the real orchestrator CLI as a subprocess, exactly as an operator's shell would. */
  const runCli = (args) => {
    try {
      return execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
        cwd: repoRoot,
        env: childEnv('loop'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw new Error(
        `the CLI refused \`${args.join(' ')}\` with status ${String(error.status)}\n` +
          `  stdout: ${String(error.stdout)}\n  stderr: ${String(error.stderr)}`,
      )
    }
  }

  /** The diagnostic throw: the state that made the call, not just "it timed out". */
  async function fail(message) {
    let screenshotPath = null
    if (page !== null && diagDir !== null) {
      screenshotPath = join(diagDir, `failure-${String(Date.now())}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
    }
    const pageUrl = page === null ? '<no page>' : page.url()
    const rows = await dumpGateRows().catch(
      (cause) => `<could not dump rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
    )
    const dumpPath = diagDir === null ? null : join(diagDir, `rows-${String(Date.now())}.json`)
    if (dumpPath !== null) {
      try {
        writeFileSync(dumpPath, rows)
      } catch {
        /* the message below still carries the tail */
      }
    }
    throw new Error(
      `${message}\n--- browser url ---\n${pageUrl}\n--- screenshot ---\n${screenshotPath ?? '<none>'}\n` +
        `--- rows ---\n${dumpPath ?? '<not written>'}\n${rows.length > 4_000 ? `${rows.slice(0, 4_000)}…` : rows}\n` +
        `--- browser console (tail) ---\n${browserConsole.slice(-40).join('\n')}`,
    )
  }

  /** Prints a measured value before asserting it, so a GREEN run's log carries the evidence too. */
  async function assertEqual(actual, expected, what) {
    console.log(`${what}: ${JSON.stringify(actual)}`)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      await fail(`${what} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
    }
  }

  /** The daemon this gate currently expects to be alive, or `null` between two of them. */
  let activeDaemon = null

  /** Polls `probe` until it reports `{ done: true }`, then returns its `value`. A daemon that died
   *  under the wait fails immediately rather than at the timeout. */
  async function waitUntil(description, timeoutMs, probe) {
    const deadline = Date.now() + timeoutMs
    let lastDetail = '<never probed>'
    for (;;) {
      const result = await probe()
      if (result.done) return result.value
      lastDetail = result.detail
      if (activeDaemon !== null && activeDaemon.exited) {
        await fail(`the ${activeDaemon.label} exited while waiting for ${description} -- last seen: ${lastDetail}`)
      }
      if (Date.now() > deadline) {
        await fail(`timed out after ${String(timeoutMs)}ms waiting for ${description} -- last seen: ${lastDetail}`)
      }
      await delay(POLL_INTERVAL_MS)
    }
  }

  /** The real daemon, in the background -- the same thing an operator leaves running. */
  function spawnDaemon(label, forWorkspaceId, workFixture) {
    const proc = spawn(
      'node',
      [ORCHESTRATOR_CLI, 'daemon', '--workspace', forWorkspaceId, '--period', String(DAEMON_PERIOD_MS)],
      { cwd: repoRoot, env: childEnv(workFixture), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const state = { label, proc, output: '', exited: false }
    proc.stdout.on('data', (chunk) => {
      state.output += chunk.toString()
      process.stdout.write(`[${label}] ${chunk}`)
    })
    proc.stderr.on('data', (chunk) => {
      state.output += chunk.toString()
      process.stderr.write(`[${label}] ${chunk}`)
    })
    proc.on('exit', (code, signal) => {
      state.exited = true
      state.output += `\n<${label} exited: code=${String(code)} signal=${String(signal)}>\n`
    })
    proc.on('error', (error) => {
      state.exited = true
      state.output += `\n<${label} failed to start: ${String(error)}>\n`
    })
    daemons.push(state)
    activeDaemon = state
    console.log(`${label} spawned as pid ${String(proc.pid)} replaying --work-fixture ${workFixture}`)
    return state
  }

  /** Stops a daemon and waits for the process to really be gone, so a stage that counts rows is
   *  never counting them against a tick still in flight. */
  async function stopDaemon(state) {
    activeDaemon = null
    if (state.exited) return
    state.proc.kill('SIGTERM')
    const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (!state.exited && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
    if (!state.exited) {
      state.proc.kill('SIGKILL')
      while (!state.exited && Date.now() < deadline + PROCESS_EXIT_TIMEOUT_MS) await delay(POLL_INTERVAL_MS)
    }
    console.log(`${state.label} stopped (pid ${String(state.proc.pid)})`)
  }

  const runRow = (id) => prisma.slaveRun.findUnique({ where: { id } })
  const eventsOf = (runId, domainType) =>
    prisma.executionEvent.findMany({ where: { runId, type: dbType(domainType) }, orderBy: { seq: 'asc' } })

  /**
   * Moves this run's beat clock `BEAT_BACKDATE_MS` into the past, and says so.
   *
   * The alternative is waiting out `BREAKER_BEAT_MS` -- sixty seconds, three rungs, two projects,
   * five minutes of a gate doing nothing, and CI is where that cost lands (plan decision D22). The
   * M50/E12 precedent is exact: that gate back-dates a decision row to clear a cooldown. Every
   * back-date is printed, so the log says what the gate did rather than leaving a reader to infer it.
   */
  async function backdateBeat(runId, why) {
    const at = new Date(Date.now() - BEAT_BACKDATE_MS)
    await prisma.slaveRun.update({ where: { id: runId }, data: { breakerBeatAt: at } })
    console.log(`  back-dated breakerBeatAt of run ${runId} to ${at.toISOString()} (${why})`)
  }

  /**
   * Back-dates the beat and waits for `probe` to report the rung landed, re-back-dating whenever the
   * sweep has consumed a beat without changing anything.
   *
   * A beat that ran while a tool call was outstanding is SUPPRESSED -- it measures nothing, writes
   * `breakerBeatAt` and returns -- so one back-date is not a guarantee of one measuring beat. The
   * loop is what makes the stage deterministic rather than a bet on where the fixture's stream had
   * got to.
   */
  async function driveRung(runId, description, probe) {
    const deadline = Date.now() + RUNG_TIMEOUT_MS
    let lastDetail = '<never probed>'
    for (let attempt = 1; Date.now() < deadline; attempt += 1) {
      await backdateBeat(runId, `${description}, attempt ${String(attempt)}`)
      const until = Math.min(deadline, Date.now() + 4 * DAEMON_PERIOD_MS + 1_500)
      for (;;) {
        const result = await probe()
        if (result.done) return result.value
        lastDetail = result.detail
        if (activeDaemon !== null && activeDaemon.exited) {
          await fail(`the ${activeDaemon.label} exited while waiting for ${description} -- last seen: ${lastDetail}`)
        }
        if (Date.now() >= until) break
        await delay(POLL_INTERVAL_MS)
      }
    }
    await fail(`timed out after ${String(RUNG_TIMEOUT_MS)}ms waiting for ${description} -- last seen: ${lastDetail}`)
    return undefined
  }

  /** Waits for one of the daemon's own `{"sweep":…}` lines to name this run under this rung's key.
   *  The line is the operator's only outward sign that the ladder moved (M51 R2, T4 fix round I5). */
  async function waitForSweepLine(state, key, runId, description) {
    const needle = `"${key}":["${runId}"]`
    return waitUntil(description, RUNG_TIMEOUT_MS, async () => {
      const line = state.output
        .split('\n')
        .find((one) => one.includes('{"sweep":') && one.includes(needle))
      if (line !== undefined) return { done: true, value: line.trim() }
      return { done: false, detail: `no sweep line naming ${needle} yet` }
    })
  }

  // ---- The four projects. Every row exists to make one assertion below mean something. ----------
  /** One project, its team, its worker and (optionally) the one task its daemon will dispatch. */
  async function makeProject({ name, label, taskTitle, budgetUsd, supervisorEnabled }) {
    const repoPath = makeRepo(label)
    repoPaths.push(repoPath)
    const workspace = await prisma.workspace.create({
      data: {
        name,
        repoPath,
        verifyCommands: [],
        setupCommands: [],
        autoMerge: false,
        budgetUsd,
        // OFF for the three run projects, and deliberately: a Supervisor watching the loop project
        // would steer its run the moment the sweep's steer rung landed, which parks it in
        // `pause_requested` and takes the constrain and stop rungs with it. Stage 2b turns it ON,
        // once, for the one run whose whole subject is that round trip.
        supervisorEnabled,
      },
    })
    workspaceIds.push(workspace.id)
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: TEAM_NAME } })
    const worker = await prisma.slave.create({
      data: {
        teamId: team.id,
        name: WORKER_NAME,
        role: WORKER_ROLE,
        runtimeRoles: [WORKER_ROLE],
        model: 'sonnet',
        provider: 'claude_code',
      },
    })
    const task =
      taskTitle === null
        ? null
        : await prisma.task.create({
            data: {
              workspaceId: workspace.id,
              title: taskTitle,
              description: `${taskTitle} — seeded by gate:m51-breaker.`,
              status: 'ready',
              requiredRole: WORKER_ROLE,
              // TWO attempts, because stage 4 asserts the stopped run's task goes back to `rework`
              // and not to `failed`: `releaseTaskAfterFailure` parks a task at its cap instead of
              // reworking it, and one attempt would make the stage measure the cap.
              maxAttempts: 2,
            },
          })
    console.log(
      `stage 0: project ${workspace.id} (${name}) repo=${repoPath} team=${team.id} worker=${worker.id}` +
        `${task === null ? '' : ` task=${task.id} (${task.title})`}`,
    )
    return { workspace, team, worker, task, repoPath }
  }

  const loop = await makeProject({
    name: WORKSPACE_NAME,
    label: 'loop',
    taskTitle: LOOP_TASK_TITLE,
    budgetUsd: 100,
    supervisorEnabled: false,
  })
  const spareWorker = await prisma.slave.create({
    data: {
      teamId: loop.team.id,
      name: SPARE_WORKER_NAME,
      // A role nothing dispatches on: this worker exists to HOLD the two hand-seeded rows of stages
      // 2b and 9, and a runtime role would let the daemon give it real work.
      role: 'observer',
      runtimeRoles: [],
      model: 'sonnet',
      provider: 'claude_code',
    },
  })
  console.log(`stage 0: spare worker ${spareWorker.id} (${SPARE_WORKER_NAME}/observer, no runtime roles)`)

  console.log('stage 0 PASSED: the loop project, a worker, a spare, and one ready task')

  // ============================================================================================
  // Stage 1: the evidence is persisted, and the hash discriminates.
  // ============================================================================================
  const loopDaemon = spawnDaemon('loop-daemon', loop.workspace.id, 'loop')

  const loopRunId = await waitUntil(
    `${WORKER_NAME} to be dispatched and working with all ${String(LOOP_CALLS)} calls AND their results recorded`,
    WORKING_TIMEOUT_MS,
    async () => {
      const row = await prisma.slaveRun.findFirst({ where: { slaveId: loop.worker.id }, orderBy: { startedAt: 'asc' } })
      if (row === null) return { done: false, detail: 'no run row yet' }
      const calls = await prisma.executionEvent.count({ where: { runId: row.id, type: dbType('run.tool_call') } })
      // Both counts, because a call's RESULT arrives one fixture line behind it: waiting on the
      // calls alone would read the log a few hundred milliseconds before it was complete.
      const results = await prisma.executionEvent.count({ where: { runId: row.id, type: dbType('run.tool_result') } })
      if (row.status === 'working' && calls >= LOOP_CALLS && results >= LOOP_CALLS) return { done: true, value: row.id }
      return { done: false, detail: `${row.status}, ${String(calls)} call(s), ${String(results)} result(s), pid=${String(row.pid)}` }
    },
  )
  const loopRunStarted = await runRow(loopRunId)
  console.log(`stage 1: the looping run is ${describeRun(loopRunStarted)}`)

  const callRows = await eventsOf(loopRunId, 'run.tool_call')
  await assertEqual(callRows.length, LOOP_CALLS, 'stage 1: run.tool_call rows')
  const callPayloads = callRows.map((row) => row.payload)
  const hashes = callPayloads.map((payload) => payload.argsHash)
  const ids = callPayloads.map((payload) => payload.toolUseId)
  const summaries = callPayloads.map((payload) => payload.summary)
  console.log(`stage 1: toolUseIds = ${JSON.stringify(ids)}`)
  console.log(`stage 1: argsHashes = ${JSON.stringify(hashes.map((hash) => `${String(hash).slice(0, 12)}…`))}`)
  for (const [index, payload] of callPayloads.entries()) {
    if (typeof payload.toolUseId !== 'string' || payload.toolUseId === '') {
      await fail(`stage 1: run.tool_call #${String(index)} carries no toolUseId: ${JSON.stringify(payload)}`)
    }
    if (typeof payload.argsHash !== 'string' || !/^[0-9a-f]{64}$/u.test(payload.argsHash)) {
      await fail(`stage 1: run.tool_call #${String(index)}'s argsHash is not 64 lowercase hex: ${JSON.stringify(payload)}`)
    }
  }
  await assertEqual(new Set(ids).size, LOOP_CALLS, 'stage 1: distinct toolUseIds')
  // The twelve are byte-equal to each other...
  const repeated = hashes.slice(1)
  await assertEqual(new Set(repeated).size, 1, 'stage 1: distinct argsHash values among the trailing twelve')
  // ...and the thirteenth is NOT. The odd call differs from them in `description` alone -- an
  // argument `summaryFor` never shows, since `command` comes first in CLAUDE_SUMMARY_ARG_KEYS -- so
  // this is munder-difflin #377 measured rather than asserted in prose: a detector keyed on the
  // human summary would have called all thirteen the same call, and the hash does not.
  if (hashes[0] === hashes[1]) {
    await fail(`stage 1: the odd call hashes the SAME as the twelve repeats (${String(hashes[0])}) -- the hash discriminates nothing`)
  }
  await assertEqual(new Set(summaries).size, 1, 'stage 1: distinct summaries across all thirteen calls')
  console.log(`stage 1: the one summary all thirteen share = ${JSON.stringify(summaries[0])}`)

  const resultRows = await eventsOf(loopRunId, 'run.tool_result')
  await assertEqual(resultRows.length, LOOP_CALLS, 'stage 1: run.tool_result rows')
  const unpaired = resultRows.filter((row) => !ids.includes(row.payload.toolUseId))
  if (unpaired.length > 0) {
    await fail(`stage 1: ${String(unpaired.length)} run.tool_result row(s) name a toolUseId no call made: ${JSON.stringify(unpaired.map((row) => row.payload))}`)
  }
  console.log(`stage 1: one run.tool_result payload = ${JSON.stringify(resultRows[0].payload)}`)
  const leaked = resultRows.filter((row) => JSON.stringify(row.payload).includes(LOOP_COMMAND))
  console.log(`stage 1: run.tool_result payloads carrying ${JSON.stringify(LOOP_COMMAND)}: ${String(leaked.length)}`)
  if (leaked.length > 0) {
    await fail(`stage 1: a run.tool_result payload carries the tool's ARGUMENTS: ${JSON.stringify(leaked[0].payload)}`)
  }
  console.log('stage 1 PASSED: thirteen calls, thirteen results, twelve hashes the same and one not, and no arguments anywhere in the log')

  // ============================================================================================
  // Stage 8, measured HERE because it is a fact about a live run: tokens mid-run.
  // (The stage is numbered 8 in the brief; stage 4 ends this run, so its measurement has to be
  // taken while the run is still `working`.)
  // ============================================================================================
  const midRun = await waitUntil('the looping run to report tokens while still working', RUNG_TIMEOUT_MS, async () => {
    const row = await runRow(loopRunId)
    if (row.status === 'working' && row.tokensIn !== null && row.tokensIn > 0) return { done: true, value: row }
    return { done: false, detail: `${row.status}, tokensIn=${String(row.tokensIn)}` }
  })
  console.log(`stage 8: mid-run row = ${describeRun(midRun)}`)
  await assertEqual(midRun.status, 'working', 'stage 8: the run status when its tokens were read')
  if (midRun.tokensIn === null || midRun.tokensIn <= 0) {
    await fail(`stage 8: tokensIn is ${String(midRun.tokensIn)} on a working run -- the mid-run usage floor was never written`)
  }
  console.log(`stage 8 PASSED: tokensIn=${String(midRun.tokensIn)} tokensOut=${String(midRun.tokensOut)} on a run that has not concluded`)

  // ============================================================================================
  // Stage 2b: the SUPERVISOR's round trip -- the sentence, the pause it claims, and a resume
  // recorded as the SYSTEM's.
  //
  // Measured BEFORE stage 2a, and that order is load-bearing: `observe`'s `run_looping` predicate
  // raises EVERY steered run in the project, so a Supervisor switched on after the real run had been
  // steered would steer that one too -- parking it in `pause_requested`, where the breaker never
  // beats it, and taking the constrain and stop rungs with it. With the real run still at level
  // `none` there is exactly one run for the Supervisor to see.
  //
  // Measured on a row this gate seeds in exactly the state stage 2a's rung leaves -- `working`,
  // level `steered`, one trip, no steer spent, with its own `run.breaker` row for the world to
  // project -- and NOT on the real looping run, for a reason the fake CLI makes unavoidable: it has
  // no PreToolUse gate, so a pause request never lands on it. A steered real run would sit in
  // `pause_requested` until its stream ended, and the constrain and stop rungs would die with it.
  // The seeded row has no child and no pump, so every effect below is the real control path's and
  // nothing races it. `pid: null` keeps the sweep's per-run loop away from it entirely.
  // ============================================================================================
  const steerText = BREAKER_STEER_TEXT.repeated_call(LOOP_REPEATS)
  const seededRun = await prisma.slaveRun.create({
    data: {
      slaveId: spareWorker.id,
      status: 'working',
      provider: 'claude_code',
      model: ESTIMATE_MODEL,
      toolCalls: 40,
      pid: null,
      breakerLevel: 'steered',
      breakerTrips: 1,
      breakerSteers: 0,
      breakerBeatAt: new Date(),
    },
  })
  await prisma.executionEvent.create({
    data: {
      workspaceId: loop.workspace.id,
      slaveId: spareWorker.id,
      runId: seededRun.id,
      type: dbType('run.breaker'),
      actor: 'system',
      payload: { level: 'steered', trip: 'repeated_call', count: LOOP_REPEATS, detail: `Bash:${hashes[1]}` },
    },
  })
  console.log(
    `stage 2b: seeded run ${seededRun.id} in the state the STEER rung leaves (working, steered, 1 trip, 0 steers, no pid) ` +
      'with its own run.breaker row — the fake CLI has no PreToolUse gate, so a real steered run can never park',
  )
  await prisma.workspace.update({ where: { id: loop.workspace.id }, data: { supervisorEnabled: true } })
  console.log('stage 2b: the project\'s Supervisor is switched ON for this one round trip')

  const decision = await waitUntil('a run_looping decision naming the seeded run', RUNG_TIMEOUT_MS, async () => {
    const row = await prisma.supervisorDecision.findFirst({
      where: { workspaceId: loop.workspace.id, situationKind: 'run_looping', subjectId: seededRun.id },
      orderBy: { createdAt: 'desc' },
    })
    if (row !== null) return { done: true, value: row }
    const all = await prisma.supervisorDecision.count({ where: { workspaceId: loop.workspace.id } })
    return { done: false, detail: `${String(all)} decision(s), none of them run_looping` }
  })
  console.log(
    `stage 2b: decision ${decision.id} situation=${decision.situationKind} subject=${String(decision.subjectId)} ` +
      `tier=${decision.tier} status=${decision.status} decidedBy=${String(decision.decidedBy)}`,
  )
  console.log(`stage 2b: decision action = ${JSON.stringify(decision.action)}`)
  await assertEqual(decision.subjectId, seededRun.id, 'stage 2b: the decision subject')
  await assertEqual(decision.tier, 'applied', 'stage 2b: the decision tier')
  await assertEqual(decision.status, 'applied', 'stage 2b: the decision status')
  await assertEqual(decision.action.kind, 'steer_run', 'stage 2b: the decision action kind')
  await assertEqual(decision.action.runId, seededRun.id, 'stage 2b: the action run id')
  // Byte-equal to the domain's own sentence, never a copy typed here: the whole reason `steer_run`
  // can be an `applied` action at all is that its text is a constant no model has ever seen.
  await assertEqual(decision.action.text, steerText, 'stage 2b: the steer sentence')

  const paused = await waitUntil('the seeded run to be claimed into pause_requested', RUNG_TIMEOUT_MS, async () => {
    const row = await runRow(seededRun.id)
    if (row.status === 'pause_requested') return { done: true, value: row }
    return { done: false, detail: describeRun(row) }
  })
  console.log(`stage 2b: the steered run = ${describeRun(paused)}`)
  await assertEqual(paused.pauseReason, 'guardrail', 'stage 2b: the pause reason')
  await assertEqual(paused.queuedMessage, steerText, 'stage 2b: the queued message')
  await assertEqual(paused.breakerSteers, 1, 'stage 2b: breakerSteers after the claim')
  const pauseEvents = await eventsOf(seededRun.id, 'run.pause_requested')
  await assertEqual(pauseEvents.length, 1, 'stage 2b: run.pause_requested rows')
  await assertEqual(pauseEvents[0].actor, 'system', 'stage 2b: the run.pause_requested actor')
  await assertEqual(pauseEvents[0].payload.requestedBy, 'circuit breaker', 'stage 2b: run.pause_requested requestedBy')

  // The park, BY HAND and with the note the brief asks for: on a real run the pump writes this row
  // and its checkpoint when the gate's deny lands mid-stream. This row has no child to deny, so the
  // gate writes what the pump would have written -- including the checkpoint, without which
  // `requestResume` refuses `no_checkpoint` and the delivery below could never happen.
  await prisma.slaveRun.update({ where: { id: seededRun.id }, data: { status: 'paused', pausedAtStep: 40 } })
  await prisma.checkpoint.create({
    data: {
      runId: seededRun.id,
      sessionId: 'fake-session-loop',
      provider: 'claude_code',
      model: ESTIMATE_MODEL,
      worktreePath: loop.repoPath,
      pauseFlagPath: join(loop.repoPath, '.slaveofai-pause'),
      settingsPath: join(loop.repoPath, '.slaveofai-settings.json'),
      hookPath: join(repoRoot, 'scripts/pause-gate.sh'),
      gitAuthorName: 'Gate',
      gitAuthorEmail: 'gate@example.com',
      headCommit: execFileSync('git', ['-C', loop.repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirtyFiles: [],
      deniedToolUseIds: [],
      lastToolName: 'Bash',
      numTurns: 40,
      pauseReason: 'paused by the behavioural breaker (seeded by gate:m51-breaker)',
    },
  })
  console.log('stage 2b: the gate parked the run BY HAND (paused + a checkpoint) — what the pump writes when a real gate deny lands')

  const resumeEvents = await waitUntil(
    "the sweep's delivery pass to resume the parked run",
    RUNG_TIMEOUT_MS,
    async () => {
      const rows = await eventsOf(seededRun.id, 'run.resume_requested')
      if (rows.length > 0) return { done: true, value: rows }
      const row = await runRow(seededRun.id)
      return { done: false, detail: describeRun(row) }
    },
  )
  console.log(`stage 2b: run.resume_requested = actor ${resumeEvents[0].actor}, payload ${JSON.stringify(resumeEvents[0].payload)}`)
  await assertEqual(resumeEvents[0].actor, 'system', 'stage 2b: the run.resume_requested actor')
  await assertEqual(resumeEvents[0].payload.requestedBy, 'circuit breaker', 'stage 2b: run.resume_requested requestedBy')
  await prisma.workspace.update({ where: { id: loop.workspace.id }, data: { supervisorEnabled: false } })
  console.log('stage 2b: the Supervisor is switched back OFF so it cannot speak over the rungs below')

  // The round trip is complete, so the seeded row is retired: the delivery really did resume it --
  // the tick's resume pass claims a delivered steer and spawns a fresh child from the checkpoint --
  // and a second live looping run would climb rungs of its own beside the one stage 2a is about to
  // measure. Its child is stopped and the row concluded, both printed.
  await delay(2 * DAEMON_PERIOD_MS)
  const resumedSeed = await runRow(seededRun.id)
  console.log(`stage 2b: after the delivery the seeded run is ${describeRun(resumedSeed)}`)
  if (resumedSeed.pid !== null) {
    try {
      process.kill(resumedSeed.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  await prisma.slaveRun.update({
    where: { id: seededRun.id },
    data: { status: 'failed', pid: null, terminalAt: new Date(), endedAt: new Date(), resumeRequestedAt: null },
  })
  // And its hand-written `run.breaker` row goes with it, so every breaker card stage 9 can land on
  // is one the SWEEP wrote on a real run rather than one this gate typed to give the Supervisor a
  // trip to read.
  await prisma.executionEvent.deleteMany({ where: { runId: seededRun.id, type: dbType('run.breaker') } })
  console.log(
    `stage 2b: the seeded row is retired (child ${String(resumedSeed.pid)} stopped, row concluded, its hand-written ` +
      'run.breaker row deleted) — its purpose is served',
  )
  console.log('stage 2b PASSED: one decision a person can read, the exact sentence, and a resume nobody was there to ask for')

  // ============================================================================================
  // Stage 2a: STEER -- the sweep's own rung. It does NOT speak to the run (decision D15): the words
  // are the Supervisor's, and stage 2b is where they are said.
  // ============================================================================================
  // Driven on the EVENT and not on the column: `beatBreaker` writes the row first and appends
  // `run.breaker` immediately after, so a probe that stopped at the column could read the log a
  // millisecond before the rung had finished announcing itself.
  await driveRung(loopRunId, 'the STEER rung', async () => {
    const rows = await eventsOf(loopRunId, 'run.breaker')
    if (rows.length >= 1) return { done: true, value: rows }
    const row = await runRow(loopRunId)
    return { done: false, detail: describeRun(row) }
  })
  const steered = await runRow(loopRunId)
  console.log(`stage 2a: the steered run = ${describeRun(steered)}`)
  await assertEqual(steered.breakerLevel, 'steered', 'stage 2a: breakerLevel after the first rung')
  await assertEqual(steered.breakerTrips, 1, 'stage 2a: breakerTrips after the first rung')
  await assertEqual(steered.status, 'working', 'stage 2a: the run status after the sweep steered it')
  const breakerRows = await eventsOf(loopRunId, 'run.breaker')
  await assertEqual(breakerRows.length, 1, 'stage 2a: run.breaker rows')
  const steerPayload = breakerRows[0].payload
  console.log(`stage 2a: run.breaker payload = ${JSON.stringify(steerPayload)}`)
  await assertEqual(steerPayload.level, 'steered', 'stage 2a: run.breaker level')
  await assertEqual(steerPayload.trip, 'repeated_call', 'stage 2a: run.breaker trip')
  await assertEqual(steerPayload.count, LOOP_REPEATS, 'stage 2a: run.breaker count')
  await assertEqual(steerPayload.detail, `Bash:${hashes[1]}`, 'stage 2a: run.breaker detail (toolName:argsHash)')
  const steerLine = await waitForSweepLine(loopDaemon, 'breakerSteered', loopRunId, "the daemon's own sweep line naming the steered run")
  console.log(`stage 2a: the daemon printed ${steerLine}`)
  console.log('stage 2a PASSED: one rung, one event, one line on the daemon\'s stdout')

  // ============================================================================================
  // Stage 3: CONSTRAIN -- one rung up, thirty calls left, and the `breaker` verb says so.
  // ============================================================================================
  await driveRung(loopRunId, 'the CONSTRAIN rung', async () => {
    const rows = await eventsOf(loopRunId, 'run.breaker')
    if (rows.length >= 2) return { done: true, value: rows }
    const row = await runRow(loopRunId)
    return { done: false, detail: describeRun(row) }
  })
  const constrained = await runRow(loopRunId)
  console.log(`stage 3: the constrained run = ${describeRun(constrained)}`)
  await assertEqual(constrained.breakerLevel, 'constrained', 'stage 3: breakerLevel after the second rung')
  await assertEqual(constrained.breakerTrips, 2, 'stage 3: breakerTrips after the second rung')
  // Read off the ROW, never re-derived from a constant this gate holds: `toolCallCap` is what the
  // ceiling check will actually compare against, and the grace is the domain's.
  await assertEqual(
    constrained.toolCallCap,
    constrained.toolCalls + CONSTRAIN_GRACE_CALLS,
    'stage 3: toolCallCap against this row\'s own toolCalls + CONSTRAIN_GRACE_CALLS',
  )
  const afterConstrain = await eventsOf(loopRunId, 'run.breaker')
  await assertEqual(afterConstrain.length, 2, 'stage 3: run.breaker rows')
  console.log(`stage 3: the second run.breaker payload = ${JSON.stringify(afterConstrain[1].payload)}`)
  await assertEqual(afterConstrain[1].payload.level, 'constrained', 'stage 3: the second run.breaker level')
  const constrainLine = await waitForSweepLine(
    loopDaemon,
    'breakerConstrained',
    loopRunId,
    "the daemon's own sweep line naming the constrained run",
  )
  console.log(`stage 3: the daemon printed ${constrainLine}`)

  // The operator's own view of all this (M51 R3, decision D18: READ-ONLY, there is no steer or
  // constrain verb). Asserted line by line, because those lines are the product.
  // Read against the ROW as it stands, never against numbers this gate predicts: the constrain rung
  // sends its sentence too (spec R3), so `breakerSteers` is 1 by the time the verb runs, and a
  // hard-coded 0 here would be the gate asserting its own guess about the ladder.
  const atVerb = await runRow(loopRunId)
  const breakerOut = runCli(['breaker', '--run', loopRunId])
  console.log(`stage 3: \`breaker --run ${loopRunId}\` printed:\n${breakerOut}`)
  const breakerLines = breakerOut.trimEnd().split('\n')
  await assertEqual(
    breakerLines[0],
    `run ${loopRunId} is ${BREAKER_LEVEL_LABEL.constrained.toLowerCase()} ` +
      `(${String(atVerb.breakerTrips)} trip(s), ${String(atVerb.breakerSteers)} steer(s))`,
    'stage 3: the breaker verb\'s first line',
  )
  await assertEqual(
    breakerLines[1],
    `  tool calls  ${String(atVerb.toolCalls)}, cap ${String(atVerb.toolCallCap)}`,
    'stage 3: the breaker verb\'s tool-call line',
  )
  await assertEqual(
    breakerLines[2],
    `  last trip   ${BREAKER_TRIP_LABEL.repeated_call} (repeated_call), ${String(LOOP_REPEATS)}x, Bash:${hashes[1]}`,
    'stage 3: the breaker verb\'s last-trip line',
  )
  console.log('stage 3 PASSED: the rung, the cap read off the row, a second event and the verb an operator would type')

  // The CONSTRAIN rung sends its sentence too (spec R3), so the run is `pause_requested` behind it.
  // On a real deployment `deliverBreakerSteers` + `claimResume` + the tick's resume pass put it back
  // to `working`; the fake CLI has no gate to park at, so the gate writes what they would have left
  // -- `sweep.test.ts`'s own `asIfSteerDelivered`, by hand and printed.
  const beforeRestore = await runRow(loopRunId)
  console.log(`stage 3: after the rung the run is ${describeRun(beforeRestore)}`)
  if (beforeRestore.status !== 'working') {
    await prisma.slaveRun.update({
      where: { id: loopRunId },
      data: { status: 'working', pauseReason: null, queuedMessage: null, resumeRequestedAt: null },
    })
    console.log(
      `stage 3: the gate put the run back to working BY HAND (it was ${beforeRestore.status}) — what a delivered steer, ` +
        'a claimed resume and a resumed spawn leave behind, which the fake CLI cannot perform because it has no gate',
    )
  }

  // ============================================================================================
  // Stage 4: STOP -- the loud rung.
  // ============================================================================================
  const taskBefore = await prisma.task.findUniqueOrThrow({ where: { id: loop.task.id } })
  console.log(`stage 4: the task before the stop = status=${taskBefore.status} attempt=${String(taskBefore.attempt)}`)
  // The worker's runtime roles are taken away first, so the reworked task stays where the assertions
  // below can read it instead of being picked up again half a tick later. The roles and NOT
  // `maxConcurrentRuns`, deliberately: concurrency is a GUARDRAIL as well as a dispatch limit
  // (`guardrails/evaluate.ts`), and setting it under a live run would breach it and halt the project
  // in the middle of the rung being measured. Printed, like every other write this gate makes by
  // hand.
  await prisma.slave.update({ where: { id: loop.worker.id }, data: { runtimeRoles: [] } })
  console.log(`stage 4: ${WORKER_NAME}'s runtime roles are taken away so the rework below is not re-dispatched under the assertions`)

  await driveRung(loopRunId, 'the STOP rung', async () => {
    const rows = await eventsOf(loopRunId, 'guardrail.tripped')
    if (rows.length > 0) return { done: true, value: rows }
    const row = await runRow(loopRunId)
    return { done: false, detail: describeRun(row) }
  })
  const guardrailRows = await eventsOf(loopRunId, 'guardrail.tripped')
  await assertEqual(guardrailRows.length, 1, 'stage 4: guardrail.tripped rows')
  console.log(`stage 4: guardrail.tripped payload = ${JSON.stringify(guardrailRows[0].payload)}`)
  await assertEqual(guardrailRows[0].payload.guardrail, 'behavioural_loop', 'stage 4: the guardrail name')
  if (!String(guardrailRows[0].payload.detail).includes('going in circles')) {
    await fail(`stage 4: the guardrail detail does not say what happened: ${JSON.stringify(guardrailRows[0].payload.detail)}`)
  }
  // One rung, one name (decision D9): the loud rung announces itself as a guardrail and NOT as a
  // third `run.breaker` row.
  const afterStop = await eventsOf(loopRunId, 'run.breaker')
  await assertEqual(afterStop.length, 2, 'stage 4: run.breaker rows after the STOP rung')
  const stopLine = await waitForSweepLine(loopDaemon, 'breakerStopped', loopRunId, "the daemon's own sweep line naming the stopped run")
  console.log(`stage 4: the daemon printed ${stopLine}`)

  const concluded = await waitUntil('the stopped run to be concluded by its own pump', WORKING_TIMEOUT_MS, async () => {
    const row = await runRow(loopRunId)
    if (row.status === 'failed' || row.status === 'stopped' || row.status === 'succeeded') return { done: true, value: row }
    return { done: false, detail: describeRun(row) }
  })
  console.log(`stage 4: the concluded run = ${describeRun(concluded)}`)
  // `failed`, NOT `stopped`: a behavioural stop must reach the existing failure streak, and a
  // `stopped` row is terminal_uncounted (M51 R3, `stopForBehaviour`'s own docstring).
  await assertEqual(concluded.status, 'failed', 'stage 4: the concluded run status')
  await assertEqual(concluded.breakerLevel, 'constrained', 'stage 4: the breaker level on the concluded row')

  const taskAfter = await waitUntil('the task to be released for rework', RUNG_TIMEOUT_MS, async () => {
    const row = await prisma.task.findUniqueOrThrow({ where: { id: loop.task.id } })
    if (row.status === 'rework') return { done: true, value: row }
    return { done: false, detail: `status=${row.status} attempt=${String(row.attempt)}` }
  })
  console.log(`stage 4: the task after the stop = status=${taskAfter.status} attempt=${String(taskAfter.attempt)}`)
  await assertEqual(taskAfter.status, 'rework', 'stage 4: the task status')
  await assertEqual(taskAfter.attempt, taskBefore.attempt + 1, 'stage 4: the task attempt')
  console.log('stage 4 PASSED: one guardrail, two rungs, a failed run the failure streak counts, and an attempt charged')

  await stopDaemon(loopDaemon)

  // ============================================================================================
  // Stage 5: the error storm trips on its own, on six DIFFERENT commands.
  // ============================================================================================
  const storm = await makeProject({
    name: STORM_WORKSPACE_NAME,
    label: 'storm',
    taskTitle: STORM_TASK_TITLE,
    budgetUsd: 100,
    supervisorEnabled: false,
  })
  const stormDaemon = spawnDaemon('storm-daemon', storm.workspace.id, 'error-storm')
  const stormRunId = await waitUntil(
    `the storm worker to be working with all ${String(STORM_ERRORS)} failures recorded`,
    WORKING_TIMEOUT_MS,
    async () => {
      const row = await prisma.slaveRun.findFirst({ where: { slaveId: storm.worker.id }, orderBy: { startedAt: 'asc' } })
      if (row === null) return { done: false, detail: 'no run row yet' }
      const results = await prisma.executionEvent.count({ where: { runId: row.id, type: dbType('run.tool_result') } })
      if (row.status === 'working' && results >= STORM_ERRORS) return { done: true, value: row.id }
      return { done: false, detail: `${row.status}, ${String(results)} tool result(s)` }
    },
  )
  const stormResults = await eventsOf(stormRunId, 'run.tool_result')
  console.log(`stage 5: tool results = ${JSON.stringify(stormResults.map((row) => [row.payload.outcome, row.payload.errorClass]))}`)
  const stormCalls = await eventsOf(stormRunId, 'run.tool_call')
  await assertEqual(new Set(stormCalls.map((row) => row.payload.argsHash)).size, STORM_ERRORS, 'stage 5: distinct argsHash values')

  await driveRung(stormRunId, 'the error storm rung', async () => {
    const rows = await eventsOf(stormRunId, 'run.breaker')
    if (rows.length >= 1) return { done: true, value: rows }
    const row = await runRow(stormRunId)
    return { done: false, detail: describeRun(row) }
  })
  const stormRun = await runRow(stormRunId)
  console.log(`stage 5: the storm run = ${describeRun(stormRun)}`)
  await assertEqual(stormRun.breakerLevel, 'steered', 'stage 5: breakerLevel after the storm rung')
  const stormBreaker = await eventsOf(stormRunId, 'run.breaker')
  await assertEqual(stormBreaker.length, 1, 'stage 5: run.breaker rows')
  const stormPayload = stormBreaker[0].payload
  console.log(`stage 5: run.breaker payload = ${JSON.stringify(stormPayload)}`)
  await assertEqual(stormPayload.trip, 'error_storm', 'stage 5: the trip kind')
  if (stormPayload.count < ERROR_STORM_COUNT) {
    await fail(`stage 5: the trip counted ${String(stormPayload.count)} errors, fewer than ERROR_STORM_COUNT (${String(ERROR_STORM_COUNT)})`)
  }
  // Its `detail` is an error CLASS, not a `toolName:argsHash` -- the six commands differ, so the
  // repeat arm (consulted first) could never have fired and this arm fired by itself.
  await assertEqual(stormPayload.detail, STORM_ERROR_CLASS, 'stage 5: the trip detail (an error class, not a call key)')
  if (String(stormPayload.detail).startsWith('Bash:')) {
    await fail(`stage 5: the storm trip carries a call key, which means the repeat arm fired: ${JSON.stringify(stormPayload)}`)
  }
  await waitForSweepLine(stormDaemon, 'breakerSteered', stormRunId, "the daemon's own sweep line naming the storm run")
  console.log('stage 5 PASSED: six different commands, six failures, one error_storm trip and no repeat trip anywhere')
  await stopDaemon(stormDaemon)

  // ============================================================================================
  // Stage 6: THE NEGATIVE THAT MATTERS. A quiet twenty-minute build is not a loop.
  // ============================================================================================
  const quiet = await makeProject({
    name: QUIET_WORKSPACE_NAME,
    label: 'quiet',
    taskTitle: QUIET_TASK_TITLE,
    budgetUsd: 100,
    supervisorEnabled: false,
  })
  console.log(
    'stage 6: the fixture is packages/providers/test/fixtures/quiet-build.ndjson — ONE tool call, no result for it, ' +
      'and then an idle tail. Deterministic by construction: nothing after that call can change what the detector reads.',
  )
  const quietDaemon = spawnDaemon('quiet-daemon', quiet.workspace.id, 'quiet-build')
  const quietRunId = await waitUntil('the quiet worker to be working with its one outstanding tool call', WORKING_TIMEOUT_MS, async () => {
    const row = await prisma.slaveRun.findFirst({ where: { slaveId: quiet.worker.id }, orderBy: { startedAt: 'asc' } })
    if (row === null) return { done: false, detail: 'no run row yet' }
    const calls = await prisma.executionEvent.count({ where: { runId: row.id, type: dbType('run.tool_call') } })
    if (row.status === 'working' && calls >= 1) return { done: true, value: row.id }
    return { done: false, detail: `${row.status}, ${String(calls)} tool call(s)` }
  })
  const quietCalls = await eventsOf(quietRunId, 'run.tool_call')
  const quietResults = await eventsOf(quietRunId, 'run.tool_result')
  await assertEqual(quietCalls.length, 1, 'stage 6: run.tool_call rows')
  await assertEqual(quietResults.length, 0, 'stage 6: run.tool_result rows (the call has not come back)')

  const quietWorktree = (await runRow(quietRunId)).worktreePath
  const worktreeHead = () =>
    quietWorktree === null
      ? '<no worktree>'
      : execFileSync('git', ['-C', quietWorktree, 'status', '--porcelain'], { encoding: 'utf8' }) +
        execFileSync('git', ['-C', quietWorktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  const worktreeBefore = worktreeHead()

  for (let beat = 1; beat <= QUIET_BEATS; beat += 1) {
    const before = await runRow(quietRunId)
    await backdateBeat(quietRunId, `the NEGATIVE stage's beat ${String(beat)} of ${String(QUIET_BEATS)}`)
    const after = await waitUntil(`beat ${String(beat)} of the quiet run to be taken`, RUNG_TIMEOUT_MS, async () => {
      const row = await runRow(quietRunId)
      // The beat clock moving forward again is the proof the beat really happened -- without it this
      // whole stage would pass against a sweep that never looked at the run at all.
      if (row.breakerBeatAt !== null && row.breakerBeatAt.getTime() > Date.now() - BEAT_BACKDATE_MS / 2) {
        return { done: true, value: row }
      }
      return { done: false, detail: describeRun(row) }
    })
    console.log(
      `stage 6: beat ${String(beat)} taken — level=${after.breakerLevel} trips=${String(after.breakerTrips)} ` +
        `quietBeats=${String(after.breakerQuietBeats)} (was ${String(before.breakerQuietBeats)}), beatAt=${after.breakerBeatAt.toISOString()}`,
    )
    if (after.breakerLevel !== 'none' || after.breakerTrips !== 0) {
      await fail(`stage 6: the breaker moved on a run whose one tool call has not come back: ${describeRun(after)}`)
    }
  }
  const quietFinal = await runRow(quietRunId)
  const quietBreaker = await eventsOf(quietRunId, 'run.breaker')
  const quietGuardrail = await eventsOf(quietRunId, 'guardrail.tripped')
  console.log(`stage 6: the quiet run after ${String(QUIET_BEATS)} beats = ${describeRun(quietFinal)}`)
  await assertEqual(quietFinal.breakerLevel, 'none', 'stage 6: breakerLevel after three beats')
  await assertEqual(quietFinal.breakerTrips, 0, 'stage 6: breakerTrips after three beats')
  await assertEqual(quietBreaker.length, 0, 'stage 6: run.breaker rows')
  await assertEqual(quietGuardrail.length, 0, 'stage 6: guardrail.tripped rows')
  await assertEqual(quietFinal.status, 'working', 'stage 6: the run status after three beats')
  // And the worktree really was untouched for the whole stage, so `no_progress`'s own clock read
  // false on every one of those beats and the suppression is what stopped it.
  await assertEqual(worktreeHead(), worktreeBefore, 'stage 6: the worktree across three beats')
  console.log('stage 6 PASSED: three beats, a still worktree, and the breaker said nothing')
  await stopDaemon(quietDaemon)

  const strayAfterRuns = findRealDaemonPids()
  console.log(`orchestrator daemons still running after the three run stages: ${JSON.stringify(strayAfterRuns)}`)
  if (strayAfterRuns.length > 0) await fail(`stage 6: a daemon this gate spawned is still running (pid ${strayAfterRuns.join(', ')})`)

  // ============================================================================================
  // Stage 7: three cost figures on the brief -- and `stats.spentUsd` byte-equal on both sides.
  // ============================================================================================
  const cost = await makeProject({
    name: COST_WORKSPACE_NAME,
    label: 'cost',
    taskTitle: null,
    budgetUsd: COST_BUDGET_USD,
    supervisorEnabled: false,
  })
  const costTask = await prisma.task.create({
    data: {
      workspaceId: cost.workspace.id,
      title: 'M51 Gate Cost Task',
      description: 'Three runs, three provenances — seeded by gate:m51-breaker.',
      status: 'done',
      requiredRole: WORKER_ROLE,
      maxAttempts: 3,
    },
  })
  const concludedRun = (data) =>
    prisma.slaveRun.create({
      data: {
        taskId: costTask.id,
        slaveId: cost.worker.id,
        status: 'succeeded',
        provider: 'claude_code',
        terminalAt: new Date(),
        endedAt: new Date(),
        ...data,
      },
    })
  const measuredRun = await concludedRun({ costUsd: MEASURED_USD, toolCalls: 12 })
  const unmeasuredRun = await concludedRun({ costUsd: null, toolCalls: 4 })
  // Estimable, but not YET: the tokens are here and the MODEL -- the M51 column `estimateCostUsd`
  // is keyed on -- is written below, after the first reading.
  const estimableRun = await concludedRun({ costUsd: null, toolCalls: 9, tokensIn: ESTIMATE_TOKENS_IN, tokensOut: 0 })
  console.log(
    `stage 7: three concluded runs — ${measuredRun.id} reported $${MEASURED_USD.toFixed(2)}, ` +
      `${unmeasuredRun.id} unmeasured, ${estimableRun.id} with ${String(ESTIMATE_TOKENS_IN)} input tokens and no model yet`,
  )

  // `stats.spentUsd` -- the field the budget guardrail reads and the one R5 says an estimate must
  // never move (`WorkspaceStatsSnapshot.stats`, `guardrails/evaluate.ts`).
  const statsBefore = await workspaceStats(cost.workspace.id)
  console.log(`stage 7: workspaceStats BEFORE any M51 column = ${JSON.stringify(statsBefore.stats)} spend=${JSON.stringify(statsBefore.spend)}`)

  await prisma.slaveRun.update({ where: { id: estimableRun.id }, data: { model: ESTIMATE_MODEL } })
  await prisma.slaveRun.update({
    where: { id: measuredRun.id },
    data: { model: ESTIMATE_MODEL, breakerLevel: 'steered', breakerTrips: 1, breakerSteers: 1, toolCallCap: 42 },
  })
  console.log('stage 7: the M51 columns are written (model on both, and a whole breaker ladder on the measured run)')

  const statsAfter = await workspaceStats(cost.workspace.id)
  console.log(`stage 7: workspaceStats AFTER = ${JSON.stringify(statsAfter.stats)} spend=${JSON.stringify(statsAfter.spend)}`)
  // THE assertion this gate exists to protect (spec R5): showing an upper bound and CHARGING for it
  // are different acts. If this fails, something reached into `workspaceSpend` or `stats.ts` -- and
  // the fix is to take that change back out, never to move this line.
  await assertEqual(statsAfter.stats.spentUsd, statsBefore.stats.spentUsd, 'stage 7: stats.spentUsd on both sides of the M51 columns')
  await assertEqual(statsAfter.stats.spentUsd, MEASURED_USD, 'stage 7: stats.spentUsd itself')

  const estimatedUsd = estimateCostUsd(ESTIMATE_MODEL, { input: ESTIMATE_TOKENS_IN, output: 0 })
  console.log(`stage 7: estimateCostUsd(${ESTIMATE_MODEL}, ${String(ESTIMATE_TOKENS_IN)} in / 0 out) = ${JSON.stringify(estimatedUsd)}`)
  const expectedActual = `actual $${MEASURED_USD.toFixed(2)}`
  const expectedEstimated = `estimated $${(MEASURED_USD + estimatedUsd).toFixed(2)}`
  const expectedUpperBound = `upper bound $${(MEASURED_USD + 2 * RUN_UNMEASURED_CAP_USD).toFixed(2)}`
  const expectedHeadline = `$${MEASURED_USD.toFixed(2)} / $${String(COST_BUDGET_USD)}`
  console.log('stage 7: the four strings the tile must carry are asserted in the browser, below')

  // ============================================================================================
  // Stage 9's rows: the word CONSTRAINED belongs to a run that is WORKING at that rung, and stage
  // 3 has already proved on a real run that this is exactly the state the constrain rung leaves.
  // Written now, with no daemon anywhere, so nothing can move it under the photograph.
  // ============================================================================================
  await prisma.slaveRun.update({
    where: { id: seededRun.id },
    data: {
      status: 'working',
      pauseReason: null,
      queuedMessage: null,
      resumeRequestedAt: null,
      breakerLevel: 'constrained',
      breakerTrips: 2,
      toolCalls: 61,
      toolCallCap: 91,
      endedAt: null,
      terminalAt: null,
    },
  })
  console.log(
    `stage 9 (seeded now, with every daemon down): run ${seededRun.id} on ${SPARE_WORKER_NAME} is working at level ` +
      'constrained with 61/91 calls — the state stage 3 measured the sweep writing on a real run',
  )

  // ---- The real web shell, on a free port, loopback-bound. -------------------------------------
  const strayBeforeNext = findRealDaemonPids()
  console.log(`orchestrator daemons running before next dev: ${JSON.stringify(strayBeforeNext)}`)
  if (strayBeforeNext.length > 0) await fail(`an orchestrator daemon is running (pid ${strayBeforeNext.join(', ')})`)

  const preferredPort = await findFreePort()
  nextServer = spawn(
    'node',
    ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort), '-H', '127.0.0.1'],
    // M21 A1: the operator's SLAVEOFAI_SESSION_SECRET must not reach the child, or every page is /login.
    { cwd: repoRoot, env: loopbackChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let nextExited = false
  let resolvedPort = null
  nextServer.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    nextOutput += text
    process.stdout.write(`[next] ${text}`)
    const match = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(nextOutput)
    if (match) resolvedPort = Number(match[1])
  })
  nextServer.stderr.on('data', (chunk) => {
    nextOutput += chunk.toString()
    process.stderr.write(`[next] ${chunk}`)
  })
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
  const baseUrl = `http://127.0.0.1:${String(resolvedPort)}`
  console.log(`next dev ready at ${baseUrl}, loopback-bound`)

  browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ viewport: VIEWPORT })
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  page.on('pageerror', (error) => {
    console.error(`[browser:pageerror] ${error}`)
    browserConsole.push(`[pageerror] ${String(error).slice(0, 300)}`)
  })
  page.on('console', (message) => browserConsole.push(`[${message.type()}] ${message.text().slice(0, 300)}`))
  page.on('requestfailed', (request) => browserConsole.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`))

  /** Bounded-waits for `locator` to become visible; a timeout routes through `fail` for the full
   *  diagnostic dump instead of a bare Playwright TimeoutError. */
  async function waitVisible(locator, description) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
    } catch {
      await fail(`timed out waiting for ${description} to become visible`)
    }
  }

  /** `page.goto`, retried ONCE and only on next dev's own manifest-race signature
   *  (`gate-m45-project-experience.mjs`'s `gotoReliably`). */
  async function gotoReliably(url) {
    const consoleStart = browserConsole.length
    const nextOutputStart = nextOutput.length
    const raced = () =>
      browserConsole.slice(consoleStart).some((line) => line.includes(MANIFEST_RACE_SIGNATURE)) ||
      nextOutput.slice(nextOutputStart).includes(MANIFEST_RACE_SIGNATURE)
    const describe = (response, error) => {
      if (error !== null) return `failed (${error instanceof Error ? error.message : String(error)})`
      if (response === null) return 'resolved with no response (an anchor/same-document navigation, per Playwright)'
      return `returned ${String(response.status())}`
    }

    let first = null
    let firstError = null
    try {
      first = await page.goto(url, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
    } catch (cause) {
      firstError = cause
    }
    if (first === null && firstError === null) return null
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
    if (secondError !== null || (second !== null && second.status() >= 500)) {
      await fail(`gotoReliably: ${url} ${describe(second, secondError)} on the retry too`)
    }
    return second
  }

  // ============================================================================================
  // Stage 7, continued: the three figures on the real page.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${cost.workspace.id}`)
  await waitVisible(page.getByTestId('brief'), 'the project brief on the cost project')
  const costTile = await page.evaluate(() => {
    const tile = document.querySelector('[data-testid="brief-tile"][data-brief="cost"]')
    if (tile === null) return null
    const read = (testId) => {
      const node = tile.querySelector(`[data-testid="${testId}"]`)
      return node === null ? null : (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    }
    return {
      all: (tile.textContent ?? '').replace(/\s+/g, ' ').trim(),
      actual: read('brief-cost-actual'),
      estimated: read('brief-cost-estimated'),
      upperBound: read('brief-cost-upper-bound'),
      unmeasuredRuns: read('brief-cost-unmeasured-runs'),
    }
  })
  console.log(`stage 7: the cost tile = ${JSON.stringify(costTile)}`)
  if (costTile === null) await fail('stage 7: there is no cost tile on the project brief')
  await assertEqual(costTile.actual, expectedActual, 'stage 7: brief-cost-actual')
  await assertEqual(costTile.estimated, expectedEstimated, 'stage 7: brief-cost-estimated')
  await assertEqual(costTile.upperBound, expectedUpperBound, 'stage 7: brief-cost-upper-bound')
  // The two runs the upper bound is built from, said out loud on the tile: `upperBoundUsd` is
  // `spentUsd` plus one `RUN_UNMEASURED_CAP_USD` per concluded run that left no figure, and BOTH the
  // unmeasured run and the estimable one are such runs -- an estimate is a display figure, not a
  // measurement (spec R5).
  await assertEqual(costTile.unmeasuredRuns, '2 unmeasured runs (not in the total)', 'stage 7: brief-cost-unmeasured-runs')
  if (!costTile.all.includes(expectedHeadline)) {
    await fail(`stage 7: the tile's big figure is not ${JSON.stringify(expectedHeadline)}: ${JSON.stringify(costTile.all)}`)
  }
  console.log(`stage 7 PASSED: ${expectedHeadline} · ${expectedActual} · ${expectedEstimated} · ${expectedUpperBound}, and spentUsd never moved`)

  // ============================================================================================
  // Stage 9: in a real browser -- the label and not the key, the breaker card, and the word.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${loop.workspace.id}/activity`)
  await waitVisible(page.getByTestId('guardrail-label'), 'the guardrail.tripped card on the activity page')
  // The card's words WITHOUT its raw-payload disclosure: that block is a closed `<details>` holding
  // the stored row verbatim -- the one place on an activity card where a key is meant to be
  // readable, and the one `gate:m44`'s own visible-text reading already excludes. Everything else
  // here is what a person actually sees.
  const guardrailCard = await page.evaluate(() => {
    const cardWordsOf = (card) => {
      if (card === null) return ''
      const clone = card.cloneNode(true)
      for (const raw of clone.querySelectorAll('[data-testid="payload-json"]')) raw.remove()
      return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
    }
    const label = document.querySelector('[data-testid="guardrail-label"]')
    if (label === null) return null
    const card = label.closest('[data-testid="activity-card"]')
    return {
      text: (label.textContent ?? '').trim(),
      attribute: label.getAttribute('data-guardrail'),
      title: label.getAttribute('title'),
      cardText: cardWordsOf(card),
    }
  })
  console.log(`stage 9: the guardrail card = ${JSON.stringify(guardrailCard)}`)
  await assertEqual(guardrailCard.text, GUARDRAIL_LABEL.behavioural_loop, 'stage 9: the guardrail card\'s visible label')
  await assertEqual(guardrailCard.attribute, 'behavioural_loop', 'stage 9: the guardrail card\'s data-guardrail')
  if (guardrailCard.cardText.includes('behavioural_loop')) {
    await fail(`stage 9: the raw guardrail key is visible text on the card: ${JSON.stringify(guardrailCard.cardText)}`)
  }

  const breakerCard = await page.evaluate(() => {
    const cardWordsOf = (card) => {
      if (card === null) return ''
      const clone = card.cloneNode(true)
      for (const raw of clone.querySelectorAll('[data-testid="payload-json"]')) raw.remove()
      return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
    }
    const trip = document.querySelector('[data-testid="breaker-trip"]')
    if (trip === null) return null
    const card = trip.closest('[data-testid="activity-card"]')
    return {
      text: (trip.textContent ?? '').trim(),
      attribute: trip.getAttribute('data-breaker-trip'),
      level: card === null ? null : (card.querySelector('[data-testid="breaker-level"]')?.getAttribute('data-breaker-level') ?? null),
      cardText: cardWordsOf(card),
    }
  })
  console.log(`stage 9: the breaker card = ${JSON.stringify(breakerCard)}`)
  if (breakerCard === null) await fail('stage 9: there is no run.breaker card on the activity page')
  await assertEqual(breakerCard.attribute, 'repeated_call', 'stage 9: the breaker card\'s data-breaker-trip')
  await assertEqual(breakerCard.text, BREAKER_TRIP_LABEL.repeated_call, 'stage 9: the breaker card\'s visible trip')
  if (breakerCard.cardText.includes('repeated_call')) {
    await fail(`stage 9: the raw trip key is visible text on the card: ${JSON.stringify(breakerCard.cardText)}`)
  }

  await gotoReliably(`${baseUrl}/w/${loop.workspace.id}`)
  await waitVisible(page.getByTestId('team'), 'the team strip on the project Overview')
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="slave-card"]')].map((card) => ({
      name: (card.querySelector('span')?.textContent ?? '').trim(),
      status: card.getAttribute('data-status'),
      state: card.getAttribute('data-card-state'),
      pill: (card.querySelector('[data-testid="status-pill"]')?.textContent ?? '').trim(),
    })),
  )
  console.log(`stage 9: the Overview's worker cards = ${JSON.stringify(cards)}`)
  const constrainedCard = cards.find((card) => card.pill === 'CONSTRAINED')
  if (constrainedCard === undefined) {
    await fail(`stage 9: no worker card reads CONSTRAINED on the project Overview: ${JSON.stringify(cards)}`)
  }
  console.log(`stage 9 PASSED: ${JSON.stringify(guardrailCard.text)} over ${JSON.stringify(guardrailCard.attribute)}, ${JSON.stringify(breakerCard.text)} over ${JSON.stringify(breakerCard.attribute)}, and a card that reads CONSTRAINED`)

  console.log(`gotoReliably retries this run: ${String(gotoRetries.length)}${gotoRetries.length === 0 ? '' : ` (${JSON.stringify(gotoRetries)})`}`)
  console.log(`PASS: ${PASS_LINE}`)
  exitCode = 0
} finally {
  // ============================================================================================
  // Stage 10: teardown, in FK order, and every process this gate started.
  // ============================================================================================
  for (const state of daemons) {
    if (state.exited) continue
    state.proc.kill('SIGTERM')
    const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (!state.exited && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
    if (!state.exited) state.proc.kill('SIGKILL')
  }
  if (browser !== null) await browser.close().catch(() => {})
  if (nextServer !== null && nextServer.exitCode === null) {
    nextServer.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextServer.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextServer.exitCode === null) nextServer.kill('SIGKILL')
  }
  for (const id of workspaceIds) await removeWorkspace(id)
  for (const path of repoPaths) rmSync(path, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
