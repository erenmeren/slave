// H9a: the restart-chaos gate -- "every unfinished record has an owner".
//
// Eight hotfixes (H1-H8) each closed one dead spot found on a live project, and three of them were
// the same shape: the daemon restarted in the middle of a run transition and nobody picked the
// record up. This gate turns that from a list of patches into a measured invariant. It plans a
// small board with the fake CLI, drives it with a REAL daemon, and kills that daemon on a schedule
// -- a deploy (SIGTERM) and a crash (SIGKILL), turn and turn about -- until the board is done. The
// board finishing at all is the first assertion; how the records moved while nobody owned them is
// the rest.
//
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:h9-restart-chaos -- [--kills 4] [--seed 1] [--signals alternate|term|kill] \
//                                    [--known-gaps H9-F1,H9-F2] [--skip-control]
//
// NEVER A MODEL CALL. Every daemon is spawned with SLAVEOFAI_CLAUDE_BIN=node and
// SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture slow-work --plan-fixture plan-graph-diamond ...",
// and the preflight refuses to start unless the operator's own SLAVEOFAI_CLAUDE_BIN points at an
// executable under `scripts/gate-fakes/` with SLAVEOFAI_REQUIRE_FAKE_CLI=1 beside it.
//
// THE BOARD. One project, a runbook-free goal, five tasks in a diamond planned by the fake CLI's
// planning arm from `plan-graph-diamond.ndjson`: foundation -> (left, right) -> join -> roof, all
// `backend`. Two backend seats (so the two wings really run side by side under
// `maxConcurrentRuns: 2`), one reviewer, one manager for the planning run. `autoMerge: true` and
// `supervisorAutonomy: act`, because the whole question is whether the project continues ON ITS OWN.
// Every work run replays the fake's `slow-work` body: a tool call every SLOW_STEP_MS for SLOW_STEPS
// steps with one silent gap of SLOW_QUIET_MS -- about twenty seconds, long enough for a restart to
// land in the middle of it and short enough for CI.
//
// THE CHAOS, deterministic by `--seed`. Daemon-1 starts. After `KILL_EVERY_MS x [0.5, 1.5)` (the
// seed draws the factor, so two seeds land their kills in different transitions) the daemon is
// killed: SIGTERM on the odd kills, SIGKILL on the even ones (`--signals term` or `kill` makes every
// kill the same one -- a crash-looping host is `--signals kill`). A SIGTERM is what this daemon calls a
// deploy -- it finishes the tick in flight and drains every pump, i.e. it waits for the work it
// started -- so the gate waits up to DRAIN_TIMEOUT_MS for it and escalates to SIGKILL past that,
// and RECORDS which it was. The next daemon starts with the same environment. After `--kills`
// kills the last daemon runs the board to the end, or to CHAOS_TIMEOUT_MS. `--kills 0` is the
// CONTROL: the same board, one daemon, no chaos -- and by default a chaos run drives the control
// board FIRST, in its own project, so the two durations it prints were measured on the same
// machine in the same minute.
//
// THE ASSERTIONS, each with the row dump on failure:
//   all-done              every task ends `done` with `integratedAt` set.
//   dead-pid-grace        no run is ever non-terminal with a dead or never-recorded pid (a `paused`
//                         run's null pid is by design and is measured by `paused-grace` instead)
//                         for longer than RECONCILE_GRACE_MS, sampled every SAMPLE_MS across the
//                         whole phase, worst case kept.
//   stranded-task-grace   the task side of the same invariant: no task sits in a transitional
//                         status (`assigned`, `running`, `verifying`, `reviewing`, `merging`) with
//                         no non-terminal run on it for longer than RECONCILE_GRACE_MS. A claim
//                         held by a run that is already over is the shape H2 found; this measures
//                         how long every such record waits for an owner.
//   no-concurrency-halt   no `guardrail.tripped` of kind `concurrency` was ever written (H9c: a
//                         full workspace is "no room this tick", not a halt).
//   one-circuit-breaker   at most one `guardrail.tripped` of kind `circuit_breaker`.
//   paused-grace          every `paused` run resumed or concluded within PAUSED_GRACE_MS.
//   no-pending-decision   the final decision list has no `pending` row: nothing waited for a person.
//   run-failed-bound      `run.failed` events <= the number of runs the kills interrupted (a kill
//                         mid-run may fail that attempt; nothing else may fail, and the retry must
//                         land). Under `--kills 0` the bound is zero.
//   control-faster        the control board finished faster than the chaos board.
//
// THE LEDGER. One line per kill: the signal, whether a SIGTERM drained or was escalated, which
// runs and which transitional tasks the next daemon inherited, and what it did with each of them
// -- read back off the rows and the event log, never off the daemon's prose.
//
// THE GATE ASSERTS, IT NEVER FIXES. A failing assertion is a finding about the product, not a
// number to tune. `--known-gaps <ids>` downgrades the assertions the named findings fail to
// WARNINGS -- so CI can stay green on the rest of the gate until H9b lands -- and the PASS line
// names every id that was waived. An id this file does not know is a refusal, not a silent no-op.
//
// WHY THIS GATE MAY RUN BESIDE A PERSON'S OWN DAEMON. Every daemon-driven gate refuses while a real
// daemon runs (`findRealDaemonPids`), because a daemon on the same database would be ticking the
// gate's workspace. This gate's daemons run on GATE_DATABASE_URL and the state root
// `scripts/lib/state-dir.mjs` mints, so a developer's daemon on the dev database cannot touch them:
// name its pid in SLAVEOFAI_GATE_IGNORE_DAEMON_PIDS (see `scripts/lib/daemon-process.mjs` for the
// exact rule) to iterate on this gate without stopping it. Never for a daemon on the same database.
//
// Shape borrowed from `gate-m51-breaker.mjs` (the daemon lifecycle, `waitUntil`, `fail()` with the
// row dump, teardown in FK order) and `gate-m40-requirement-versioning.mjs` (the goal through the
// real CLI, the plan waited on the `workspace.plan_created` event).

import { execFileSync, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids } from './lib/daemon-process.mjs'
import { prisma } from '../packages/db/dist/client.js'
import { EVENT_TYPE_BY_DOMAIN_TYPE } from '../packages/db/dist/enums.js'
import { isAlive } from '../packages/control/dist/index.js'
import { NON_TERMINAL_RUN_STATUSES } from '../packages/domain/dist/index.js'

// ---- Knobs. Every one is an environment variable with the brief's default, so a run of this gate
// ---- on a slow machine or a curious afternoon can move one without editing the file. ------------
const envInt = (name, fallback) => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name}=${raw} is not a non-negative integer`)
  return value
}
/** How long a daemon lives before the next kill, before the seed's factor. */
const KILL_EVERY_MS = envInt('KILL_EVERY_MS', 7_000)
/** The whole board's deadline, per phase: chaos included, from the first daemon to the last task. */
const CHAOS_TIMEOUT_MS = envInt('CHAOS_TIMEOUT_MS', 240_000)
/** The longest a non-terminal run may sit with a dead pid before somebody owns it. */
const RECONCILE_GRACE_MS = envInt('RECONCILE_GRACE_MS', 60_000)
/** The longest a `paused` run may sit before it is resumed or concluded. */
const PAUSED_GRACE_MS = envInt('PAUSED_GRACE_MS', 60_000)
/**
 * How long a SIGTERM is given to drain before it is escalated to SIGKILL.
 *
 * LONGER THAN ONE RUN, deliberately. A SIGTERM makes this daemon finish the tick in flight and wait
 * for every pump -- the work it started -- and a slow-work run is about twenty seconds. A bound
 * shorter than that turns every deploy into a crash with a nicer name, and the alternation the brief
 * asks for ("a deploy and a crash") would then measure two crashes. Thirty seconds is one run plus
 * the conclusion behind it; the ledger records the drain time, or the escalation, either way.
 */
const DRAIN_TIMEOUT_MS = envInt('DRAIN_TIMEOUT_MS', 30_000)
/** The sampler's period: liveness of every non-terminal run's pid, `paused` durations. */
const SAMPLE_MS = envInt('SAMPLE_MS', 2_000)
/** The fake's slow-work body, passed on ARGV (M52 R3: a run's child gets no daemon environment). */
const SLOW_STEP_MS = envInt('SLOW_STEP_MS', 1_500)
const SLOW_STEPS = envInt('SLOW_STEPS', 10)
const SLOW_QUIET_MS = envInt('SLOW_QUIET_MS', 4_000)
/**
 * The pace of the fixture REPLAYS this daemon makes -- the plan, every review, every Supervisor
 * decision. Not the work body, which keeps its own clock. A few seconds per replay rather than the
 * fake's 2ms default, so a kill has a real chance of landing inside a planning or a review run --
 * two of the transitions the reconciliation table has to own -- and not only inside the work.
 */
const LINE_DELAY_MS = envInt('LINE_DELAY_MS', 250)
/** The workspace's own run ceiling. Well past one slow-work run, and small on purpose: it is also a
 *  term of the stranded-claim grace (`strandedClaimGraceMs`), and the default half hour would make a
 *  kill that lands mid-verify a stall this gate could never wait out. */
const RUN_TIMEOUT_MS = envInt('RUN_TIMEOUT_MS', 60_000)

const POLL_INTERVAL_MS = 250
const DAEMON_PERIOD_MS = 500
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const PLAN_TIMEOUT_MS = 60_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const PLAN_FIXTURE = 'plan-graph-diamond'
const PASS_LINE = 'every unfinished record found an owner, through a deploy and a crash alike'

const STAMP = new Date().toISOString().slice(11, 19)
const WORKSPACE_PREFIX = 'H9 Restart Chaos'
const TEAM_NAME = 'H9 Chaos Crew'
const WORKER_ROLE = 'backend'
const GOAL = 'Build the H9 gate house: a foundation, two wings on it, the join between them, and the roof on top.'
/** What `plan-graph-diamond.ndjson` returns -- the board every phase must finish. */
const PLAN_TITLES = ['Lay the foundation', 'Build the left wing', 'Build the right wing', 'Join the wings', 'Finish the roof']

/**
 * The assertions, by key, and the finding each `--known-gaps` id waives.
 *
 * The keys are the vocabulary of the log and of the report. The ids are the findings the report
 * for H9b is written from: an id is added here the day its finding is written down, with the ONE
 * assertion it explains, so `--known-gaps H9-F2` can never quietly waive more than that finding
 * covers. Remove an id the day H9b closes it, and the gate is strict again.
 */
const ASSERTION_KEYS = [
  'all-done',
  'dead-pid-grace',
  'stranded-task-grace',
  'no-concurrency-halt',
  'one-circuit-breaker',
  'paused-grace',
  'no-pending-decision',
  'run-failed-bound',
  'control-faster',
]
const KNOWN_GAP_ASSERTIONS = {
  /** H9c: a full workspace writes `guardrail.tripped { concurrency }` on every tick it is full,
   *  once per daemon lifetime -- and a restart is a new lifetime. */
  'H9-F1': 'no-concurrency-halt',
  /** A restart-orphaned run is a `failed` row like any other to the failure streak, so three kills
   *  trip the circuit breaker; and `haltAnnounced` is in memory, so every daemon after that
   *  announces the same halt again. */
  'H9-F2': 'one-circuit-breaker',
  /** The breaker halt raised by F2 has no automatic exit: `clear_halt` needs an applied
   *  `retry_task`, which needs a `failed` TASK, and a restart-orphaned run leaves its task in
   *  `rework`. The Supervisor escalates to a person, and the board stops. */
  'H9-F3': 'no-pending-decision',
  /** F3's other face: the board never finishes. */
  'H9-F4': 'all-done',
  /** A restart-orphaned run's `run.failed` is counted like a worker's failure everywhere the
   *  product counts failures. */
  'H9-F5': 'run-failed-bound',
}

// ---- Flags -----------------------------------------------------------------------------------------
function parseFlags(argv) {
  const flags = { kills: 4, seed: 1, knownGaps: [], skipControl: false, signals: 'alternate' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`)
      i += 1
      return next
    }
    if (arg === '--kills') flags.kills = Number(value())
    else if (arg === '--seed') flags.seed = Number(value())
    else if (arg === '--known-gaps') flags.knownGaps = value().split(',').map((id) => id.trim()).filter((id) => id !== '')
    else if (arg === '--skip-control') flags.skipControl = true
    else if (arg === '--signals') flags.signals = value()
    else throw new Error(`unknown flag ${arg}`)
  }
  if (!Number.isInteger(flags.kills) || flags.kills < 0) throw new Error('--kills must be a non-negative integer')
  if (!Number.isInteger(flags.seed) || flags.seed < 0) throw new Error('--seed must be a non-negative integer')
  if (!['alternate', 'term', 'kill'].includes(flags.signals)) throw new Error('--signals must be alternate, term or kill')
  for (const id of flags.knownGaps) {
    if (!(id in KNOWN_GAP_ASSERTIONS)) {
      throw new Error(`--known-gaps names ${id}, which this gate does not know; known: ${Object.keys(KNOWN_GAP_ASSERTIONS).join(', ')}`)
    }
  }
  return flags
}
const flags = parseFlags(process.argv.slice(2))
const waived = new Set(flags.knownGaps.map((id) => KNOWN_GAP_ASSERTIONS[id]))
const waivedBy = (key) => flags.knownGaps.filter((id) => KNOWN_GAP_ASSERTIONS[id] === key)

/** mulberry32: a 32-bit seeded generator, small enough to read and good enough to jitter a clock. */
function seededRandom(seed) {
  let state = (seed >>> 0) || 0x9e3779b9
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const dbType = (domainType) => {
  const value = EVENT_TYPE_BY_DOMAIN_TYPE[domainType]
  if (value === undefined) throw new Error(`no database enum value for the event type ${domainType}`)
  return value
}
const TERMINAL = new Set(['stopped', 'succeeded', 'failed'])
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`

/** A throwaway git repository for one project to hold its worktrees in. */
function makeRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `slaveofai-gate-h9-${label}-`))
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

/** Teardown for one project, in FK order (`gate-m51-breaker.mjs`'s own). */
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

async function preflightCleanup() {
  const stale = await prisma.workspace.findMany({ where: { name: { startsWith: WORKSPACE_PREFIX } }, select: { id: true, name: true } })
  for (const workspace of stale) {
    console.log(`preflight: removing leftover workspace ${workspace.id} (${workspace.name})`)
    await removeWorkspace(workspace.id)
  }
}

let exitCode = 1
let diagDir = null
const workspaceIds = []
const repoPaths = []
/** Every daemon this gate has ever spawned, in order -- the `finally` kills whichever is alive. */
const daemons = []

const describeRun = (row) =>
  JSON.stringify({
    id: row.id,
    kind: row.kind,
    status: row.status,
    pid: row.pid,
    taskId: row.taskId,
    startedAt: row.startedAt?.toISOString?.() ?? row.startedAt,
    terminalAt: row.terminalAt?.toISOString?.() ?? row.terminalAt ?? null,
    pauseReason: row.pauseReason ?? null,
    resumeRequestedAt: row.resumeRequestedAt?.toISOString?.() ?? null,
    failureClass: row.failureClass ?? null,
  })

async function dumpGateRows() {
  const workspaces = []
  for (const id of workspaceIds) {
    const row = await prisma.workspace
      .findUnique({
        where: { id },
        include: { tasks: { include: { dependencies: true } }, teams: { include: { slaves: { include: { runs: true } } } }, supervisorDecisions: true },
      })
      .catch(() => null)
    const events = await prisma.executionEvent.findMany({ where: { workspaceId: id }, orderBy: { seq: 'asc' } }).catch(() => [])
    workspaces.push({ row, events })
  }
  const daemonTails = daemons.map((d) => ({
    label: d.label,
    pid: d.proc.pid ?? null,
    exited: d.exited,
    exit: d.exit,
    output: d.output.length > 8_000 ? `…${d.output.slice(-8_000)}` : d.output,
  }))
  return JSON.stringify({ workspaces, daemonTails }, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
}

async function fail(message) {
  const rows = await dumpGateRows().catch((cause) => `<could not dump rows: ${cause instanceof Error ? cause.message : String(cause)}>`)
  const dumpPath = diagDir === null ? null : join(diagDir, `rows-${String(Date.now())}.json`)
  if (dumpPath !== null) {
    try {
      writeFileSync(dumpPath, rows)
    } catch {
      /* the message below still carries the head */
    }
  }
  throw new Error(`${message}\n--- rows ---\n${dumpPath ?? '<not written>'}\n${rows.length > 4_000 ? `${rows.slice(0, 4_000)}…` : rows}`)
}

/** The daemon this gate currently expects alive, or null between two of them (and during chaos,
 *  where a daemon dying is the point and never a failure). */
let activeDaemon = null

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
    if (Date.now() > deadline) await fail(`timed out after ${String(timeoutMs)}ms waiting for ${description} -- last seen: ${lastDetail}`)
    await delay(POLL_INTERVAL_MS)
  }
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-h9-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)
  console.log(
    `flags: kills=${String(flags.kills)} seed=${String(flags.seed)} signals=${flags.signals} ` +
      `known-gaps=${flags.knownGaps.length === 0 ? '<none>' : flags.knownGaps.join(',')} skip-control=${String(flags.skipControl)}`,
  )
  console.log(
    `knobs: KILL_EVERY_MS=${String(KILL_EVERY_MS)} DRAIN_TIMEOUT_MS=${String(DRAIN_TIMEOUT_MS)} CHAOS_TIMEOUT_MS=${String(CHAOS_TIMEOUT_MS)} ` +
      `RECONCILE_GRACE_MS=${String(RECONCILE_GRACE_MS)} PAUSED_GRACE_MS=${String(PAUSED_GRACE_MS)} SAMPLE_MS=${String(SAMPLE_MS)} ` +
      `SLOW_STEP_MS=${String(SLOW_STEP_MS)} SLOW_STEPS=${String(SLOW_STEPS)} SLOW_QUIET_MS=${String(SLOW_QUIET_MS)} ` +
      `LINE_DELAY_MS=${String(LINE_DELAY_MS)} RUN_TIMEOUT_MS=${String(RUN_TIMEOUT_MS)}`,
  )

  // ============================================================================================
  // Stage 0: the preflight. Refusals, never fallbacks.
  // ============================================================================================
  const fakeClaude = process.env['SLAVEOFAI_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'SLAVEOFAI_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" SLAVEOFAI_REQUIRE_FAKE_CLI=1 npm run gate:h9-restart-chaos',
    )
  }
  try {
    accessSync(fakeClaude, constants.X_OK)
  } catch {
    throw new Error(`SLAVEOFAI_CLAUDE_BIN=${fakeClaude} is not an executable file`)
  }
  if (!fakeClaude.startsWith(join(repoRoot, 'scripts/gate-fakes'))) {
    throw new Error(`SLAVEOFAI_CLAUDE_BIN=${fakeClaude} is not under ${join(repoRoot, 'scripts/gate-fakes')}. This gate must not reach a vendor account.`)
  }
  if (process.env['SLAVEOFAI_REQUIRE_FAKE_CLI'] !== '1') {
    throw new Error('SLAVEOFAI_REQUIRE_FAKE_CLI is not 1. Set it beside SLAVEOFAI_CLAUDE_BIN so a lost fake binary is a refusal rather than a silent fallback.')
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:h9-restart-chaos`')
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI} -- run \`npx tsc --build\` first`)
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)
  const planFixturePath = join(repoRoot, 'packages/providers/test/fixtures', `${PLAN_FIXTURE}.ndjson`)
  if (!existsSync(planFixturePath)) throw new Error(`the diamond plan fixture is missing at ${planFixturePath}`)
  try {
    await prisma.$queryRaw`select 1`
  } catch (cause) {
    throw new Error(`the database at DATABASE_URL is not reachable (${cause instanceof Error ? cause.message : String(cause)})`)
  }
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:h9-restart-chaos REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate drives its own and would be measuring somebody else\'s ticks. A daemon on ANOTHER database and state ' +
        'directory may be named in SLAVEOFAI_GATE_IGNORE_DAEMON_PIDS (scripts/lib/daemon-process.mjs says when that is legitimate).',
    )
  }
  const ignoredPids = process.env['SLAVEOFAI_GATE_IGNORE_DAEMON_PIDS'] ?? ''
  if (ignoredPids !== '') console.log(`preflight: looking past daemon pid(s) ${ignoredPids} (SLAVEOFAI_GATE_IGNORE_DAEMON_PIDS)`)
  console.log(`fake claude: ${fakeClaude}`)
  await preflightCleanup()

  const childEnv = () =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS:
        `${FAKE_CLAUDE} --fixture slow-work --plan-fixture ${PLAN_FIXTURE} --line-delay-ms ${String(LINE_DELAY_MS)} ` +
        `--slow-step-ms ${String(SLOW_STEP_MS)} --slow-steps ${String(SLOW_STEPS)} --slow-quiet-ms ${String(SLOW_QUIET_MS)}`,
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
    })

  const runCli = (args) => {
    try {
      return execFileSync('node', [ORCHESTRATOR_CLI, ...args], { cwd: repoRoot, env: childEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      throw new Error(`the CLI refused \`${args.join(' ')}\` with status ${String(error.status)}\n  stdout: ${String(error.stdout)}\n  stderr: ${String(error.stderr)}`)
    }
  }

  /** One project: the workspace, a team, two backend seats, a reviewer, a manager, and the goal. */
  async function makeProject(label) {
    const repoPath = makeRepo(label)
    repoPaths.push(repoPath)
    const workspace = await prisma.workspace.create({
      data: {
        name: `${WORKSPACE_PREFIX} ${label} ${STAMP}`,
        repoPath,
        baseBranch: 'main',
        verifyCommands: ['true'],
        setupCommands: [],
        autoMerge: true,
        budgetUsd: 100,
        maxConcurrentRuns: 2,
        runTimeoutMs: RUN_TIMEOUT_MS,
        supervisorEnabled: true,
        supervisorAutonomy: 'act',
      },
    })
    workspaceIds.push(workspace.id)
    await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: TEAM_NAME } })
    const seedPerson = async (name) =>
      (
        await prisma.person.upsert({
          where: { name },
          create: { name },
          update: { templateId: null, profile: null, model: null, provider: null, capabilities: [], lifecycle: 'project', releasedAt: null, releaseReason: null, selectionRationale: null },
        })
      ).id
    const seat = async (name, role, runtimeRoles) => prisma.slave.create({ data: { teamId: team.id, role, runtimeRoles, personId: await seedPerson(name) } })
    const seats = [
      await seat(`H9 ${label} Builder One`, 'Builder', [WORKER_ROLE]),
      await seat(`H9 ${label} Builder Two`, 'Builder', [WORKER_ROLE]),
      await seat(`H9 ${label} Reviewer`, 'Reviewer', ['reviewer']),
      await seat(`H9 ${label} Manager`, 'Manager', ['manager']),
    ]
    const set = runCli(['set-goal', '--workspace', workspace.id, '--goal', GOAL])
    console.log(
      `${label}: project ${workspace.id} repo=${repoPath} team=${team.id} seats=${seats.map((one) => `${one.id.slice(0, 8)}:${one.runtimeRoles.join('/')}`).join(',')} ` +
        `goal=${set.trim()}`,
    )
    return { workspace, team, seats, repoPath }
  }

  // ---- The daemon lifecycle -------------------------------------------------------------------
  function spawnDaemon(label, workspaceId) {
    const proc = spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspaceId, '--period', String(DAEMON_PERIOD_MS)], {
      cwd: repoRoot,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const state = { label, proc, output: '', exited: false, exit: null, startedAt: Date.now() }
    // Echoed with consecutive repeats folded: a halted daemon prints the same tick line twice a
    // second for as long as the halt stands, and a gate log that is ninety percent that one line
    // hides the ledger. Every line still lands in `state.output` for the dump.
    let lastLine = null
    let repeats = 0
    const echo = (stream, chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (line === '') continue
        if (line === lastLine) {
          repeats += 1
          continue
        }
        if (repeats > 0) process.stdout.write(`[${label}] (the line above repeated ${String(repeats)} more time(s))\n`)
        repeats = 0
        lastLine = line
        stream.write(`[${label}] ${line}\n`)
      }
    }
    proc.stdout.on('data', (chunk) => {
      state.output += chunk.toString()
      echo(process.stdout, chunk)
    })
    proc.stderr.on('data', (chunk) => {
      state.output += chunk.toString()
      echo(process.stderr, chunk)
    })
    proc.on('exit', (code, signal) => {
      state.exited = true
      state.exit = { code, signal, at: Date.now() }
      state.output += `\n<${label} exited: code=${String(code)} signal=${String(signal)}>\n`
    })
    proc.on('error', (error) => {
      state.exited = true
      state.exit = { code: null, signal: null, at: Date.now(), error: String(error) }
      state.output += `\n<${label} failed to start: ${String(error)}>\n`
    })
    daemons.push(state)
    activeDaemon = state
    console.log(`${label} spawned as pid ${String(proc.pid)}`)
    return state
  }

  /**
   * Kills a daemon the way the chaos schedule says, and reports what it took.
   *
   * SIGTERM is a deploy: the daemon finishes its tick and drains its pumps, and the gate waits up to
   * DRAIN_TIMEOUT_MS for that -- then escalates to SIGKILL and SAYS SO, because "the deploy waited
   * and the daemon did not come back" is a different fact from "the daemon crashed". SIGKILL is the
   * crash: no drain, no tick, the children left to find out on their own.
   */
  async function killDaemon(state, signal) {
    activeDaemon = null
    const sentAt = Date.now()
    if (state.exited) return { signal, sentAt, exitedAt: state.exit.at, drained: false, escalated: false, alreadyExited: true }
    state.proc.kill(signal)
    if (signal === 'SIGKILL') {
      const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
      while (!state.exited && Date.now() < deadline) await delay(50)
      if (!state.exited) await fail(`${state.label} did not exit within ${String(PROCESS_EXIT_TIMEOUT_MS)}ms of SIGKILL`)
      return { signal, sentAt, exitedAt: state.exit.at, drained: false, escalated: false, alreadyExited: false }
    }
    const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS
    while (!state.exited && Date.now() < drainDeadline) await delay(50)
    if (state.exited) return { signal, sentAt, exitedAt: state.exit.at, drained: true, escalated: false, alreadyExited: false }
    state.proc.kill('SIGKILL')
    const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (!state.exited && Date.now() < deadline) await delay(50)
    if (!state.exited) await fail(`${state.label} did not exit within ${String(PROCESS_EXIT_TIMEOUT_MS)}ms of the escalated SIGKILL`)
    return { signal, sentAt, exitedAt: state.exit.at, drained: false, escalated: true, alreadyExited: false }
  }

  async function stopDaemon(state) {
    activeDaemon = null
    if (state.exited) return
    state.proc.kill('SIGTERM')
    const deadline = Date.now() + DRAIN_TIMEOUT_MS
    while (!state.exited && Date.now() < deadline) await delay(50)
    if (!state.exited) {
      state.proc.kill('SIGKILL')
      while (!state.exited && Date.now() < deadline + PROCESS_EXIT_TIMEOUT_MS) await delay(50)
    }
    console.log(`${state.label} stopped (pid ${String(state.proc.pid)})`)
  }

  // ---- Reads -----------------------------------------------------------------------------------
  const runsOf = (workspaceId) =>
    prisma.slaveRun.findMany({ where: { slave: { team: { workspaceId } } }, include: { task: { select: { title: true, status: true } } }, orderBy: { startedAt: 'asc' } })
  const tasksOf = (workspaceId) => prisma.task.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })
  const eventsOfType = (workspaceId, domainType) =>
    prisma.executionEvent.findMany({ where: { workspaceId, type: dbType(domainType) }, orderBy: { seq: 'asc' } })
  const boardDone = (tasks) => tasks.length === PLAN_TITLES.length && tasks.every((task) => task.status === 'done' && task.integratedAt !== null)
  const boardWord = (tasks) => tasks.map((task) => `${task.title.split(' ').at(-1)}:${task.status}`).join(' ')

  /**
   * What the next daemon inherits: every non-terminal run, and every task in a transitional status
   * -- `verifying`, `reviewing`, `merging` -- whether or not a run is holding it. Read at the
   * moment of the signal and again at the moment of exit, because a drained SIGTERM changes the
   * answer between the two.
   */
  async function snapshot(workspaceId) {
    const runs = (await runsOf(workspaceId)).filter((run) => !TERMINAL.has(run.status))
    const tasks = (await tasksOf(workspaceId)).filter((task) => ['verifying', 'reviewing', 'merging', 'assigned', 'running'].includes(task.status))
    return {
      at: Date.now(),
      runs: runs.map((run) => ({
        id: run.id,
        kind: run.kind,
        status: run.status,
        pid: run.pid,
        alive: run.pid === null ? null : isAlive(run.pid),
        taskId: run.taskId,
        taskTitle: run.task?.title ?? null,
        taskStatus: run.task?.status ?? null,
      })),
      tasks: tasks.map((task) => ({ id: task.id, title: task.title, status: task.status, activeRunId: task.activeRunId, mergeClaimedAt: task.mergeClaimedAt })),
    }
  }

  const short = (title) => (title === null ? '<no task>' : title.split(' ').at(-1))
  const describeInherited = (snap) => {
    const runs = snap.runs.map(
      (run) => `${run.kind}/${run.status}${run.pid === null ? '(no pid)' : run.alive ? `(pid ${String(run.pid)} alive)` : `(pid ${String(run.pid)} dead)`} ${short(run.taskTitle)}:${run.taskStatus ?? '-'}`,
    )
    const heldBy = new Set(snap.runs.map((run) => run.taskId))
    const tasks = snap.tasks.filter((task) => !heldBy.has(task.id)).map((task) => `task ${short(task.title)}:${task.status}${task.mergeClaimedAt === null ? '' : '(merge claimed)'}`)
    const all = [...runs, ...tasks]
    return all.length === 0 ? 'nothing in flight' : all.join(', ')
  }

  /**
   * What the next daemon did with everything it inherited: for each run and each transitional task,
   * the FIRST event written about it after the kill and how long after the kill it came, then where
   * it is now -- read off the log, never off the daemon's prose. The delay is the number that says
   * whether a record was picked up or sat: a task moved by a fresh `task.review_started` thirty
   * seconds later was reconciled by a grace, not by an owner.
   */
  async function resolveLedger(workspaceId, entry) {
    const exitedAt = new Date(entry.kill.exitedAt)
    const firstAfter = async (where) => {
      const event = await prisma.executionEvent.findFirst({ where: { ...where, ts: { gt: exitedAt } }, orderBy: { seq: 'asc' }, select: { type: true, payload: true, ts: true } })
      if (event === null) return ' (no event since)'
      const reason = typeof event.payload?.reason === 'string' ? ` "${event.payload.reason.slice(0, 60)}"` : ''
      return ` [${event.type}${reason} after ${seconds(event.ts.getTime() - exitedAt.getTime())}]`
    }
    const parts = []
    for (const inherited of entry.atExit.runs) {
      const run = await prisma.slaveRun.findUnique({ where: { id: inherited.id }, include: { task: { select: { status: true } } } })
      parts.push(
        `${inherited.kind}/${inherited.status} ${short(inherited.taskTitle)}${await firstAfter({ runId: inherited.id })} -> ${run?.status ?? '<gone>'}` +
          `${run?.task ? `, task now ${run.task.status}` : ''}`,
      )
    }
    const heldBy = new Set(entry.atExit.runs.map((run) => run.taskId))
    for (const inherited of entry.atExit.tasks.filter((task) => !heldBy.has(task.id))) {
      const task = await prisma.task.findUnique({ where: { id: inherited.id }, select: { status: true } })
      parts.push(`task ${short(inherited.title)}:${inherited.status}${await firstAfter({ taskId: inherited.id })} -> ${task?.status ?? '<gone>'}`)
    }
    return parts.length === 0 ? 'nothing to pick up' : parts.join('; ')
  }

  /**
   * One phase: a project, its daemon(s), the kill schedule, the sampler, and the board's end.
   *
   * Returns everything the assertions need, all of it measured here: the phase's duration, the
   * sampler's worst figures, the kill ledger and how many runs the kills interrupted.
   */
  async function runPhase(label, kills, rand) {
    const project = await makeProject(label)
    const workspaceId = project.workspace.id
    const phaseStart = Date.now()
    const deadline = phaseStart + CHAOS_TIMEOUT_MS
    const t = () => `t+${seconds(Date.now() - phaseStart)}`

    // ---- The sampler: liveness and durations, every SAMPLE_MS, for the whole phase. ----------
    const deadSince = new Map()
    const pausedSince = new Map()
    const strandedSince = new Map()
    const worst = { deadMs: 0, deadRun: null, pausedMs: 0, pausedRun: null, strandedMs: 0, strandedTask: null, samples: 0 }
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        const now = Date.now()
        const runs = await runsOf(workspaceId).catch(() => [])
        worst.samples += 1
        const seen = new Set()
        for (const run of runs) {
          seen.add(run.id)
          const terminal = TERMINAL.has(run.status)
          // paused: measured from first sight to the first sample that sees it elsewhere.
          if (!terminal && run.status === 'paused') {
            if (!pausedSince.has(run.id)) pausedSince.set(run.id, now)
            const sat = now - pausedSince.get(run.id)
            if (sat > worst.pausedMs) worst.pausedMs = sat, (worst.pausedRun = describeRun(run))
          } else if (pausedSince.has(run.id)) {
            pausedSince.delete(run.id)
          }
          // dead or never-recorded pid on a non-terminal, non-paused run.
          const ownerless = !terminal && run.status !== 'paused' && (run.pid === null || !isAlive(run.pid))
          if (ownerless) {
            if (!deadSince.has(run.id)) deadSince.set(run.id, now)
            const sat = now - deadSince.get(run.id)
            if (sat > worst.deadMs) worst.deadMs = sat, (worst.deadRun = describeRun(run))
          } else {
            deadSince.delete(run.id)
          }
        }
        for (const id of [...deadSince.keys()]) if (!seen.has(id)) deadSince.delete(id)
        for (const id of [...pausedSince.keys()]) if (!seen.has(id)) pausedSince.delete(id)
        // The task side of the same question: a task in a transitional status with no non-terminal
        // run on it is a record nobody owns -- a claim held by a run that is already over, a
        // `reviewing` nobody is reviewing, a `merging` nobody is merging. A tick or two of this is
        // the ordinary gap between two passes; the grace is what tells a gap from a stall.
        const liveOn = new Set(runs.filter((run) => !TERMINAL.has(run.status)).map((run) => run.taskId))
        const tasks = await tasksOf(workspaceId).catch(() => [])
        for (const task of tasks) {
          const transitional = ['assigned', 'running', 'verifying', 'reviewing', 'merging'].includes(task.status)
          if (transitional && !liveOn.has(task.id)) {
            if (!strandedSince.has(task.id)) strandedSince.set(task.id, now)
            const sat = now - strandedSince.get(task.id)
            if (sat > worst.strandedMs) worst.strandedMs = sat, (worst.strandedTask = `${task.title}:${task.status} activeRunId=${String(task.activeRunId)} mergeClaimedAt=${String(task.mergeClaimedAt)}`)
          } else {
            strandedSince.delete(task.id)
          }
        }
        await delay(SAMPLE_MS)
      }
    })()

    const ledger = []
    let daemonIndex = 1
    let daemon = spawnDaemon(`${label} daemon-${String(daemonIndex)}`, workspaceId)
    let planned = null

    // The plan must land before the first kill counts as chaos worth ledgering -- and it is the
    // one thing this phase waits on by name: a board that never appeared is a planning failure,
    // not a reconciliation one, and it is reported as such.
    planned = await waitUntil('the diamond plan to land', PLAN_TIMEOUT_MS, async () => {
      const rows = await eventsOfType(workspaceId, 'workspace.plan_created')
      if (rows.length === 0) return { done: false, detail: 'no workspace.plan_created yet' }
      const tasks = await tasksOf(workspaceId)
      if (tasks.length < PLAN_TITLES.length) return { done: false, detail: `${String(tasks.length)} task(s) on the board` }
      return { done: true, value: tasks }
    })
    console.log(`${label} ${t()}: the plan landed -- ${boardWord(planned)}`)
    for (const title of PLAN_TITLES) {
      if (!planned.some((task) => task.title === title)) await fail(`${label}: the plan has no task titled ${JSON.stringify(title)}`)
    }
    const dependencies = await prisma.taskDependency.count({ where: { task: { workspaceId } } })
    if (dependencies !== 5) await fail(`${label}: the diamond has ${String(dependencies)} dependency edge(s), expected 5`)

    // ---- The chaos schedule. --------------------------------------------------------------------
    let interruptedRuns = 0
    let done = false
    for (let kill = 1; kill <= kills && !done; kill += 1) {
      const factor = 0.5 + rand()
      const lifeMs = Math.round(KILL_EVERY_MS * factor)
      const killAt = daemon.startedAt + lifeMs
      while (Date.now() < killAt) {
        if (daemon.exited) await fail(`${daemon.label} exited on its own before its kill was due: ${JSON.stringify(daemon.exit)}`)
        const tasks = await tasksOf(workspaceId)
        if (boardDone(tasks)) {
          done = true
          break
        }
        await delay(POLL_INTERVAL_MS)
      }
      if (done) break
      const signal = flags.signals === 'term' ? 'SIGTERM' : flags.signals === 'kill' ? 'SIGKILL' : kill % 2 === 1 ? 'SIGTERM' : 'SIGKILL'
      const atSignal = await snapshot(workspaceId)
      console.log(`${label} ${t()}: kill #${String(kill)} ${signal} -> ${daemon.label} after ${seconds(lifeMs)} of life; in flight: ${describeInherited(atSignal)}`)
      const record = await killDaemon(daemon, signal)
      const atExit = await snapshot(workspaceId)
      // Every non-terminal run the next daemon inherits was interrupted -- a `starting` row whose
      // pid was never recorded as much as a `working` one whose child is still alive for a moment
      // -- except a `paused` one, which has no process by design and is not a restart's to fail. A
      // drained SIGTERM leaves none; an escalated one leaves whatever was in flight at the
      // escalation. Counted from the exit snapshot, which is what the next daemon actually sees.
      const interrupted = atExit.runs.filter((run) => run.status !== 'paused').length
      interruptedRuns += interrupted
      const entry = { index: kill, kill: record, atSignal, atExit, interrupted }
      ledger.push(entry)
      console.log(
        `${label} ${t()}: kill #${String(kill)} ${record.signal}${record.drained ? ` drained in ${seconds(record.exitedAt - record.sentAt)}` : record.escalated ? ` NOT drained in ${seconds(DRAIN_TIMEOUT_MS)}, escalated to SIGKILL` : ''}` +
          `; inherited by the next daemon: ${describeInherited(atExit)}`,
      )
      daemonIndex += 1
      daemon = spawnDaemon(`${label} daemon-${String(daemonIndex)}`, workspaceId)
    }

    // ---- The last daemon runs the board to the end, or to the deadline. -------------------------
    let finalTasks = null
    let lastWord = ''
    while (!done) {
      if (daemon.exited) await fail(`${daemon.label} exited on its own: ${JSON.stringify(daemon.exit)}`)
      const tasks = await tasksOf(workspaceId)
      const word = boardWord(tasks)
      if (word !== lastWord) {
        console.log(`${label} ${t()}: board ${word}`)
        lastWord = word
      }
      if (boardDone(tasks)) {
        done = true
        finalTasks = tasks
        break
      }
      if (Date.now() > deadline) {
        finalTasks = tasks
        break
      }
      await delay(POLL_INTERVAL_MS)
    }
    finalTasks ??= await tasksOf(workspaceId)
    const durationMs = Date.now() - phaseStart
    console.log(`${label} ${t()}: board ${done ? 'DONE' : 'NOT done at the deadline'} -- ${boardWord(finalTasks)} -- after ${String(daemonIndex)} daemon(s)`)

    // Let the conclusion settle, then stop the last daemon with a drain of its own so nothing it
    // owns is counted against the rows below mid-write.
    await delay(2 * DAEMON_PERIOD_MS)
    await stopDaemon(daemon)
    sampling = false
    await sampler

    for (const entry of ledger) {
      console.log(
        `${label} ledger: kill #${String(entry.index)} ${entry.kill.signal}${entry.kill.drained ? ' (drained)' : entry.kill.escalated ? ' (escalated to SIGKILL)' : ''}` +
          ` | inherited: ${describeInherited(entry.atExit)} | next daemon: ${await resolveLedger(workspaceId, entry)}`,
      )
    }

    return { label, workspaceId, project, durationMs, done, finalTasks, worst, ledger, interruptedRuns, daemonsStarted: daemonIndex }
  }

  // ============================================================================================
  // Stage 1: the control -- the same board, one daemon, no chaos.
  // ============================================================================================
  const results = []
  if (flags.kills === 0 || !flags.skipControl) {
    const control = await runPhase('control', 0, seededRandom(flags.seed))
    results.push(control)
    console.log(`control: the board took ${seconds(control.durationMs)} with no chaos`)
  }

  // ============================================================================================
  // Stage 2: the chaos.
  // ============================================================================================
  if (flags.kills > 0) {
    const chaos = await runPhase('chaos', flags.kills, seededRandom(flags.seed))
    results.push(chaos)
    console.log(`chaos: the board took ${seconds(chaos.durationMs)} through ${String(chaos.ledger.length)} kill(s), ${String(chaos.daemonsStarted)} daemon(s)`)
  }

  // ============================================================================================
  // Stage 3: the assertions, every measured value printed before it is asserted.
  // ============================================================================================
  const failures = []
  const waivedIds = new Set()
  const check = (key, ok, message) => {
    if (!ASSERTION_KEYS.includes(key)) throw new Error(`unknown assertion key ${key}`)
    if (ok) {
      console.log(`  ok   ${key}: ${message}`)
      return
    }
    if (waived.has(key)) {
      console.log(`  WARN ${key} (waived by ${waivedBy(key).join(',')}): ${message}`)
      for (const id of waivedBy(key)) waivedIds.add(id)
      return
    }
    console.log(`  FAIL ${key}: ${message}`)
    failures.push(`${key}: ${message}`)
  }

  for (const phase of results) {
    console.log(`assertions for the ${phase.label} board (${phase.workspaceId}):`)
    const notDone = phase.finalTasks.filter((task) => task.status !== 'done' || task.integratedAt === null)
    check(
      'all-done',
      notDone.length === 0,
      notDone.length === 0
        ? `all ${String(phase.finalTasks.length)} tasks done and integrated in ${seconds(phase.durationMs)}`
        : `${String(notDone.length)} task(s) not done+integrated after ${seconds(phase.durationMs)}: ${notDone.map((task) => `${task.title}=${task.status}${task.integratedAt === null ? '' : '(integrated)'}`).join(', ')}`,
    )
    check(
      'dead-pid-grace',
      phase.worst.deadMs <= RECONCILE_GRACE_MS,
      `worst ownerless non-terminal run sat ${seconds(phase.worst.deadMs)} (grace ${seconds(RECONCILE_GRACE_MS)}, ${String(phase.worst.samples)} samples)${phase.worst.deadRun === null ? '' : ` -- ${phase.worst.deadRun}`}`,
    )
    check(
      'stranded-task-grace',
      phase.worst.strandedMs <= RECONCILE_GRACE_MS,
      `worst transitional task with no live run sat ${seconds(phase.worst.strandedMs)} (grace ${seconds(RECONCILE_GRACE_MS)})${phase.worst.strandedTask === null ? '' : ` -- ${phase.worst.strandedTask}`}`,
    )
    check(
      'paused-grace',
      phase.worst.pausedMs <= PAUSED_GRACE_MS,
      `worst paused run sat ${seconds(phase.worst.pausedMs)} (grace ${seconds(PAUSED_GRACE_MS)})${phase.worst.pausedRun === null ? '' : ` -- ${phase.worst.pausedRun}`}`,
    )
    const tripped = await eventsOfType(phase.workspaceId, 'guardrail.tripped')
    const byKind = new Map()
    for (const event of tripped) byKind.set(event.payload.guardrail, (byKind.get(event.payload.guardrail) ?? 0) + 1)
    const kinds = [...byKind.entries()].map(([kind, count]) => `${kind}x${String(count)}`).join(' ') || '<none>'
    check('no-concurrency-halt', (byKind.get('concurrency') ?? 0) === 0, `guardrail.tripped by kind: ${kinds}`)
    check('one-circuit-breaker', (byKind.get('circuit_breaker') ?? 0) <= 1, `circuit_breaker announced ${String(byKind.get('circuit_breaker') ?? 0)} time(s)`)
    const decisions = await prisma.supervisorDecision.findMany({ where: { workspaceId: phase.workspaceId }, orderBy: { createdAt: 'asc' } })
    const pending = decisions.filter((decision) => decision.status === 'pending')
    const decisionWord = decisions.map((decision) => `${decision.situationKind}/${decision.action.kind}:${decision.status}`).join(' ') || '<none>'
    check('no-pending-decision', pending.length === 0, `${String(decisions.length)} decision(s): ${decisionWord}`)
    const runFailed = await eventsOfType(phase.workspaceId, 'run.failed')
    const bound = phase.interruptedRuns
    check(
      'run-failed-bound',
      runFailed.length <= bound,
      `${String(runFailed.length)} run.failed event(s), bound ${String(bound)} (runs the kills interrupted)` +
        (runFailed.length === 0 ? '' : `: ${runFailed.map((event) => `"${String(event.payload.reason).slice(0, 60)}"`).join('; ')}`),
    )
  }
  if (results.length === 2) {
    const [control, chaos] = results
    check('control-faster', control.durationMs < chaos.durationMs, `control ${seconds(control.durationMs)} vs chaos ${seconds(chaos.durationMs)}`)
  } else {
    console.log(`  skip control-faster: ${results.length === 1 && flags.kills === 0 ? 'control only' : 'no control board this run (--skip-control)'}`)
  }

  if (failures.length > 0) {
    await fail(`${String(failures.length)} assertion(s) failed:\n  ${failures.join('\n  ')}`)
  }
  console.log(`PASS: ${PASS_LINE}${waivedIds.size === 0 ? '' : ` (known gaps waived: ${[...waivedIds].join(', ')})`}`)
  exitCode = 0
} finally {
  for (const state of daemons) {
    if (state.exited) continue
    state.proc.kill('SIGTERM')
    const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (!state.exited && Date.now() < deadline) await delay(50)
    if (!state.exited) state.proc.kill('SIGKILL')
  }
  for (const id of workspaceIds) await removeWorkspace(id)
  for (const path of repoPaths) rmSync(path, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
