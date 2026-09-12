// M52's own gate (spec R8): "the wall a worker cannot move, and the secret it never holds".
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m52-broker
//
// NEVER A MODEL CALL. NEVER A REAL DEPLOYMENT. The fourth fake, `scripts/gate-fakes/fake-deploy.sh`,
// is what `BrokerBinding.command` points at, and the "credential" is a literal in this file.
//
// THE GATE ASSERTS, IT NEVER FIXES, and every stage prints every measured value before asserting it.
//
// Scaffolding cribbed function for function from `scripts/gate-m51-breaker.mjs` -- a free port, a
// real `next dev`, a real Chromium through `playwright-core` at `CHROMIUM_PATH`, prisma and the real
// CLI before the browser opens, `preflightCleanup` by name prefix, and a `finally` that kills every
// process and removes every temporary repository -- plus two things of its own:
//
//   - `SLAVEOFAI_STATE_DIR` is set to a temporary directory for EVERY daemon and CLI it spawns, and
//     on this process too. That variable exists because of Task 2 (`packages/control/src/paths.ts`):
//     a run's directory now lives under `$SLAVEOFAI_STATE_DIR ?? $XDG_STATE_HOME ?? ~/.local/state`
//     and escapes every repo-scoped cleanup, so a gate that did not set it would leave its run
//     directories in the operator's own `$HOME` forever. This is the first thing to use it, and the
//     `finally` removes the whole tree.
//   - `FAKE_DEPLOY_LOG` and `FAKE_DEPLOY_TOKEN` are set on the DAEMON's environment and on nothing
//     else. The token's value is a literal here (`m52-fake-deploy-token`) and is what stage 4 greps
//     the event log and the child's own environment dump for.
//
// The eleven stages, each measuring one thing the milestone claims:
//   1.  The baseline is what a fresh worker gets: `permissions.json` v2, exactly
//       `BASELINE_GRANTS.implementation`, a 64-hex `tokenHash`, `enforce: all-tools`, the whole
//       vocabulary -- and the file is NOT inside the repository the worker edits.
//   2.  An ungranted call is denied and the run survives: one `run.tool_denied`
//       `{WebFetch, network_fetch}`, zero guardrails, no pause, no checkpoint. m18's shape,
//       asserted for the opposite reason -- m18 proved a DENY does not stop a run, this proves the
//       same for a tool nobody ever denied.
//   3.  A person moves the wall: `permission grant`, `permission.changed` on the timeline, the run
//       already in flight keeps the verdict it started with, and the NEXT run's call passes.
//   4.  The broker, end to end: the fake on the far side records `token-present:yes`, the worker's
//       own environment dump contains NEITHER the credential NOR `DATABASE_URL`, `broker.executed`
//       is on the timeline, and the token's literal value appears nowhere in `ExecutionEvent`.
//   5.  No grant, no operation: `broker.refused { permission_denied }`, and the fake never ran.
//   6.  Two forgeries, both closed: another run's id, and a wrong token -- `identity_mismatch` both.
//   7.  An op with no binding: `not_brokered`.
//   8.  Nothing crosses from a simulation: an archived project is refused `simulation`.
//   9.  The Supervisor may point, not move: a `permission_blocked` situation, a `request_permission`
//       decision recorded `proposed`/`pending`, and NO row until a person approves it.
//   10. The browser: the panel's six lines and three glyphs, the sentence naming who granted and
//       when, the matrix's six word headers with the keys on `data-kind`, and a third click taking a
//       decision back.
//   11. The run directory is outside the repository (erratum E4) -- and `<repo>/.slaveofai/worktrees`
//       still exists, because a worktree is the worker's workspace and only the verdict moved.
//
// IT NEVER EDITS A FILE IN THIS REPOSITORY. The fixtures are read and never written; the temporary
// repositories and the state directory it makes are removed in the `finally`; `git status
// --porcelain` after a green run is what it was before.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: like `gate-m14-fidelity.mjs` and
// `gate-m51-breaker.mjs`, it boots `next dev` against the repo's own `apps/web/.next` on a freshly
// chosen free port, and a second `next dev` sharing that directory corrupts the on-disk build cache
// for both. Stop any running dev server first (`pgrep -af "next dev"`).

import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { approveDecision, createUser, deleteUser, runDirPathFor } from '../packages/control/dist/index.js'
import { brokerChannelPathFor, brokerReplyPathFor, permissionsFilePathFor, runTokenHash } from '../packages/providers/dist/index.js'
import {
  BASELINE_GRANTS,
  BROKER_OP_LABEL,
  BROKER_REFUSAL_LABEL,
  PERMISSION_KINDS,
  PERMISSION_LABEL,
  PERMISSION_TRIP_COUNT,
  TOOL_VOCABULARY,
} from '../packages/domain/dist/index.js'

const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 100
const DAEMON_PERIOD_MS = 500
const WORKING_TIMEOUT_MS = 120_000
/** A brokered round trip: the daemon's own pass is `BROKER_PASS_MS` (500 ms) and the fake deploy is
 *  instant, so this is forty passes' worth of room and not a guess about the machine. */
const BROKER_TIMEOUT_MS = 20_000
/** `gate-m14-fidelity.mjs`'s own signature for next dev's torn `loadManifest` read. */
const MANIFEST_RACE_SIGNATURE = 'Unexpected end of JSON input'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const FAKE_DEPLOY = join(repoRoot, 'scripts/gate-fakes/fake-deploy.sh')
const PASS_LINE = 'the wall a worker cannot move, and the secret it never holds'

// Suffixed per run (`gate-m51-breaker.mjs`'s idiom): `Workspace.name` IS unique, and a distinct name
// per run keeps two overlapping executions from colliding on it. `preflightCleanup` removes
// leftovers by PREFIX, which is what makes both projects one sweep.
const STAMP = new Date().toISOString().slice(11, 19)
const SAFE_STAMP = STAMP.replaceAll(':', '-')
const WORKSPACE_PREFIX = 'M52 Gate Project'
const WORKSPACE_NAME = `${WORKSPACE_PREFIX} ${STAMP}`
const SUPERVISED_WORKSPACE_NAME = `${WORKSPACE_PREFIX} Supervised ${STAMP}`
const TEAM_NAME = 'M52 Gate Department'
const WORKER_NAME = 'Dev'
/** The worker stage 9's wall belongs to, in a project of its own so the Supervisor has exactly one
 *  situation to think about and this gate is measuring its answer rather than its shortlist. */
const BLOCKED_WORKER_NAME = 'Bo'
const WORKER_ROLE = 'backend'
/** No `reviewer` in `runtimeRoles` anywhere in either project, and deliberately: `dispatchReview`
 *  staffs on that literal (`review.ts:329`), so a project without one raises `no_reviewer` once and
 *  dispatches no review run at all. Every implementation run this gate measures is therefore the
 *  only run its task ever produces. */
const RUNTIME_ROLES = [WORKER_ROLE]

/** The person. E18: every web surface renders the granter as a USERNAME (`SlaveGrant.byName`), so
 *  the principal this gate grants with has to be a real `User` row or stage 10 reads a fallback
 *  sentence instead of a name. */
const GATE_USERNAME = `m52-gate-${SAFE_STAMP}`
const GATE_PASSWORD = 'm52-gate-password'

/** The "credential". A literal here, never a secret: the whole milestone is about where a value
 *  goes, and a gate that needed a real one could not run in CI. */
const FAKE_DEPLOY_TOKEN = 'm52-fake-deploy-token'
const CREDENTIAL_NAME = 'deploy'
const CREDENTIAL_ENV_VAR = 'FAKE_DEPLOY_TOKEN'
const DEPLOY_OP = 'deploy_release'
const DEPLOY_ENVIRONMENT = 'staging'
/** Seven lowercase hex -- a short sha, the narrow end of `BROKERED_OPERATIONS.deploy_release`'s own
 *  `/^[a-f0-9]{7,64}$/`. */
const DEPLOY_DIGEST = 'a1b2c3d'

/** The tool stage 2 and stage 3 put through the real hook. OUTSIDE every baseline
 *  (`BASELINE_GRANTS`), governed by `network_fetch`, and denied by nobody: that is what makes it a
 *  proof of default-deny rather than of a deny row. */
const GATE_TOOL = 'WebFetch'
const GATE_TOOL_KIND = 'network_fetch'

/** The delay the fake CLI sleeps between two fixture lines. `complete.ndjson` is eleven lines plus
 *  the four this gate's `--gate-tool` arm injects, so this is what turns a run into a few seconds of
 *  real time rather than a stream that is over before the row is written. */
const LINE_DELAY_MS = 200

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

/** Asks the OS for a free TCP port. `next dev -p <port>` still auto-increments if something grabs it
 *  between this call and the spawn, so the ready-wait parses the ACTUAL bound port back out of next
 *  dev's own ready line rather than trusting this one blindly.
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
 *  (`gate-m51-breaker.mjs`'s `makeRepo`.) */
function makeRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `slaveofai-gate-m52-${label}-`))
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

/** Removes anything a prior interrupted run left behind, by NAME PREFIX -- both projects, in the
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
  const staleUsers = await prisma.user.findMany({ where: { username: { startsWith: 'm52-gate-' } }, select: { id: true, username: true } })
  for (const user of staleUsers) {
    console.log(`preflight: removing leftover user ${user.id} (${user.username})`)
    await prisma.executionEvent.updateMany({ where: { userId: user.id }, data: { userId: null } }).catch(() => {})
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {})
  }
}

/** Teardown for one project, in FK order. `ExecutionEvent` has no FK to `Workspace` (M2's
 *  append-only log outlives entity lifecycles by design) so it goes explicitly first; the workspace
 *  delete then cascades SupervisorDecision, Credential, BrokerBinding, Memory, RunContext,
 *  Checkpoint, SlaveRun, SlavePermission, TaskDependency, Task, Slave and Team. */
async function removeWorkspace(id) {
  await prisma.executionEvent.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.supervisorDecision.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.slaveMessage.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.memory.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.brokerBinding.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.credential.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.runContext.deleteMany({ where: { run: { slave: { team: { workspaceId: id } } } } }).catch(() => {})
  await prisma.checkpoint.deleteMany({ where: { run: { slave: { team: { workspaceId: id } } } } }).catch(() => {})
  await prisma.slaveRun.deleteMany({ where: { slave: { team: { workspaceId: id } } } }).catch(() => {})
  await prisma.slavePermission.deleteMany({ where: { slave: { team: { workspaceId: id } } } }).catch(() => {})
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
/** The per-run state root (Task 2's C1). Every run directory this gate causes lands under it, and it
 *  is removed whole in the `finally` -- which is the difference between this gate and the 366
 *  directories an afternoon of test runs left in an operator's `$HOME`. */
let stateDir = null
let gateUserId = null
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
  row === null || row === undefined
    ? '<no run>'
    : JSON.stringify({
        id: row.id,
        kind: row.kind,
        status: row.status,
        pid: row.pid,
        toolCalls: row.toolCalls,
        pausedAtStep: row.pausedAtStep,
        pauseReason: row.pauseReason,
        // The HASH, never the token: there is no plaintext token on this row and there never was.
        runTokenHash: row.runTokenHash === null ? null : `${String(row.runTokenHash).slice(0, 12)}…`,
        startedAt: row.startedAt === null || row.startedAt === undefined ? null : row.startedAt.toISOString(),
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
          teams: { include: { slaves: { include: { runs: true, permissions: true } } } },
          supervisorDecisions: true,
          credentials: true,
          brokerBindings: true,
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
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m52-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ============================================================================================
  // Stage 0: the preflight. Refusals, never fallbacks -- then the projects.
  // ============================================================================================

  // Zero spend, ENFORCED (Decision 10, M32 item 7). This gate drives real daemons; without this
  // refusal a lost fake binary would reach a vendor account instead.
  const fakeClaude = process.env['SLAVEOFAI_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'SLAVEOFAI_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m52-broker',
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
      `no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m52-broker passes ` +
        '--env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m52-broker`')
  }
  if (!existsSync(ORCHESTRATOR_CLI)) {
    throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI} -- run \`npx tsc --build\` first`)
  }
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)
  try {
    accessSync(FAKE_DEPLOY, constants.X_OK)
  } catch {
    throw new Error(`the fourth fake is missing or not executable at ${FAKE_DEPLOY} -- \`chmod +x\` it`)
  }
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- stage 10 reads a real rendered page, so set CHROMIUM_PATH to a ` +
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
      `gate:m52-broker REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate drives its own and would be measuring somebody else\'s ticks.',
    )
  }

  // THE STATE ROOT, before anything can derive a path from it. Set on THIS process too, because the
  // gate itself calls `runDirPathFor` to find a run's channel -- and a gate deriving one root while
  // the daemon wrote under another would be measuring an empty directory.
  stateDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m52-state-'))
  process.env['SLAVEOFAI_STATE_DIR'] = stateDir
  const deployLog = join(stateDir, 'fake-deploy.log')
  const envOut = join(stateDir, 'child-env.ndjson')
  const brokerOut = join(stateDir, 'broker-client.ndjson')
  const gateOut = join(stateDir, 'gate-verdict.ndjson')
  writeFileSync(deployLog, '')
  console.log(`fake claude:  ${fakeClaude}`)
  console.log(`fake deploy:  ${FAKE_DEPLOY}`)
  console.log(`chromium:     ${chromiumPath}`)
  console.log(`state dir:    ${stateDir} (SLAVEOFAI_STATE_DIR, removed in the finally)`)
  console.log(`deploy log:   ${deployLog}`)
  console.log(
    `domain numbers: BASELINE_GRANTS.implementation=${JSON.stringify(BASELINE_GRANTS.implementation)} ` +
      `PERMISSION_TRIP_COUNT=${String(PERMISSION_TRIP_COUNT)}`,
  )
  assert(
    !BASELINE_GRANTS.implementation.includes(GATE_TOOL_KIND),
    `${GATE_TOOL_KIND} is in the implementation baseline -- stage 2 would be measuring a grant, not a default deny`,
  )
  assert(
    !BASELINE_GRANTS.implementation.includes(DEPLOY_OP),
    `${DEPLOY_OP} is in the implementation baseline -- stage 5 would never see permission_denied`,
  )

  await preflightCleanup()

  /**
   * The environment every child gets.
   *
   * `SLAVEOFAI_CLAUDE_ARGS` is the ONE per-daemon channel a gate can count on (M39 erratum E6, M52
   * R3): a RUN's child no longer inherits the daemon's environment at all (`buildChildEnv`'s
   * `CHILD_ENV_ALLOW`), so every knob the fake CLI reads rides on argv beside `--fixture`.
   *
   * `FAKE_DEPLOY_TOKEN` and `FAKE_DEPLOY_LOG` are set HERE, on the daemon, and are exactly what
   * stage 4 proves does not reach the worker.
   */
  const daemonEnv = () =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS: [
        FAKE_CLAUDE,
        '--fixture',
        'm8-flow',
        '--work-fixture',
        'complete',
        '--line-delay-ms',
        String(LINE_DELAY_MS),
        '--gate-tool',
        GATE_TOOL,
        '--gate-out',
        gateOut,
        '--env-out',
        envOut,
        '--broker-op',
        DEPLOY_OP,
        '--broker-environment',
        DEPLOY_ENVIRONMENT,
        '--broker-digest',
        DEPLOY_DIGEST,
        '--broker-out',
        brokerOut,
      ].join(' '),
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
      SLAVEOFAI_STATE_DIR: stateDir,
      FAKE_DEPLOY_TOKEN,
      FAKE_DEPLOY_LOG: deployLog,
    })

  /** Runs the real orchestrator CLI as a subprocess, exactly as an operator's shell would. No
   *  credential on it: an operator's shell is not where a secret lives either. */
  const runCli = (args) => {
    try {
      return execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
        cwd: repoRoot,
        env: loopbackChildEnv({
          SLAVEOFAI_CLAUDE_BIN: 'node',
          SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8-flow --work-fixture complete`,
          SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
          SLAVEOFAI_STATE_DIR: stateDir,
        }),
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
  function spawnDaemon(label, forWorkspaceId) {
    const proc = spawn(
      'node',
      [ORCHESTRATOR_CLI, 'daemon', '--workspace', forWorkspaceId, '--period', String(DAEMON_PERIOD_MS)],
      { cwd: repoRoot, env: daemonEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
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
    console.log(`${label} spawned as pid ${String(proc.pid)} (holding ${CREDENTIAL_ENV_VAR} and nothing else does)`)
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
  /** One NDJSON side-channel the fake CLI writes, newest last. `[]` when it has not been written. */
  const readNdjson = (path) =>
    existsSync(path)
      ? readFileSync(path, 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line))
      : []
  /** Every line `fake-deploy.sh` has recorded so far. The gate never reads a token out of it because
   *  the fake never writes one -- it writes `token-present:yes|no`. */
  const deployLines = () =>
    readFileSync(deployLog, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')

  /**
   * Writes one request line onto a run's own broker channel BY HAND, and waits for the reply file.
   *
   * By hand rather than through the thin client precisely because stages 6 to 8 are about a worker
   * that does NOT use the client: a forger writes the line itself, and so must this gate to measure
   * what happens to it.
   */
  async function askBroker(description, runDir, line) {
    const requestId = line.requestId
    appendFileSync(brokerChannelPathFor(runDir), `${JSON.stringify(line)}\n`, { mode: 0o600 })
    const replyPath = brokerReplyPathFor(runDir, requestId)
    const reply = await waitUntil(`a broker reply for ${description}`, BROKER_TIMEOUT_MS, async () => {
      if (!existsSync(replyPath)) return { done: false, detail: `no ${replyPath} yet` }
      try {
        return { done: true, value: JSON.parse(readFileSync(replyPath, 'utf8')) }
      } catch (cause) {
        return { done: false, detail: `reply not readable yet (${String(cause)})` }
      }
    })
    console.log(`${description}: reply = ${JSON.stringify(reply)}`)
    return reply
  }

  const freshRequestId = () => randomBytes(16).toString('hex')

  // ---- The person, and the two projects. --------------------------------------------------------
  const created = await createUser(GATE_USERNAME, GATE_PASSWORD)
  if (!created.ok) throw new Error(`could not create the gate's user: ${JSON.stringify(created.error)}`)
  gateUserId = created.value.id
  console.log(`stage 0: the person is ${GATE_USERNAME} (${gateUserId}) -- E18: a real User row, so every surface can print a name`)

  /** One project, its team, its worker. No reviewer role anywhere: see `RUNTIME_ROLES`. */
  async function makeProject({ name, label, supervisorEnabled, workerName }) {
    const repoPath = makeRepo(label)
    repoPaths.push(repoPath)
    const workspace = await prisma.workspace.create({
      data: {
        name,
        repoPath,
        // ONE command that passes, and not the empty list `gate-m51-breaker.mjs` uses: M51's runs
        // never conclude, so its verify pass never runs. Ours do, and `verify.ts` HALTS a workspace
        // whose verify command list is empty ("an empty list is a refusal to prove the work, not a
        // pass") -- which took the whole project down between the first run and the second the
        // first time this gate was run. `true` is the smallest command that proves nothing and
        // refuses nothing, which is exactly what a gate measuring permissions wants from a verify.
        verifyCommands: ['true'],
        setupCommands: [],
        autoMerge: false,
        budgetUsd: 100,
        supervisorEnabled,
      },
    })
    workspaceIds.push(workspace.id)
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: TEAM_NAME } })
    const worker = await prisma.slave.create({
      data: {
        teamId: team.id,
        name: workerName,
        role: WORKER_ROLE,
        runtimeRoles: RUNTIME_ROLES,
        model: 'sonnet',
        provider: 'claude_code',
      },
    })
    console.log(`stage 0: project ${workspace.id} (${name}) repo=${repoPath} team=${team.id} worker=${worker.id} (${workerName})`)
    return { workspace, team, worker, repoPath }
  }

  const main = await makeProject({
    name: WORKSPACE_NAME,
    label: 'main',
    // OFF, and deliberately: a Supervisor watching this project would see every wall stage 2 puts up
    // and start proposing grants under the stages that are measuring the absence of one. Stage 9
    // gets a project of its own for exactly that reason.
    supervisorEnabled: false,
    workerName: WORKER_NAME,
  })

  // The credential and the binding, through the real CLI -- the two rows only a person can write.
  console.log(runCli(['credential', 'add', '--workspace', main.workspace.id, '--name', CREDENTIAL_NAME, '--kind', 'deploy_token', '--env-var', CREDENTIAL_ENV_VAR]).trim())
  // `--command` once per argv element. The LOG PATH is argv and the CREDENTIAL is environment, and
  // that split is the executor's contract rather than a convenience: a brokered child gets `PATH`,
  // the one credential the binding names, and one `SLAVEOFAI_BROKER_PARAM_*` per parameter -- so a
  // `FAKE_DEPLOY_LOG` exported beside the daemon would not arrive, and a fake that expected it
  // refused with exit 3 the first time this gate was run. A binding's command is a row a person
  // wrote, which is where a deployment's own configuration belongs.
  console.log(
    runCli([
      'broker', 'bind',
      '--workspace', main.workspace.id,
      '--op', DEPLOY_OP,
      '--command', FAKE_DEPLOY,
      '--command', '--log',
      '--command', deployLog,
      '--credential', CREDENTIAL_NAME,
    ]).trim(),
  )

  const startingRows = await prisma.slavePermission.count({ where: { slaveId: main.worker.id } })
  await assertEqual(startingRows, 0, 'stage 0: SlavePermission rows for a fresh worker')
  console.log('stage 0 PASSED: two projects\' worth of seed, a person, a credential that is a NAME, and a binding pointing at the fourth fake')

  const firstTask = await prisma.task.create({
    data: {
      workspaceId: main.workspace.id,
      title: 'M52 Gate Baseline Task',
      description: 'Seeded by gate:m52-broker — the run whose verdict stage 1 reads.',
      status: 'ready',
      requiredRole: WORKER_ROLE,
      maxAttempts: 3,
    },
  })
  console.log(`stage 0: task ${firstTask.id} (${firstTask.title}) is ready`)

  const daemon = spawnDaemon('main-daemon', main.workspace.id)

  // ============================================================================================
  // Stage 1: the baseline is what a fresh worker gets.
  // ============================================================================================
  const firstRunId = await waitUntil(
    `${WORKER_NAME} to be dispatched and its permissions.json to be on disk`,
    WORKING_TIMEOUT_MS,
    async () => {
      const row = await prisma.slaveRun.findFirst({ where: { slaveId: main.worker.id }, orderBy: { startedAt: 'asc' } })
      if (row === null) return { done: false, detail: 'no run row yet' }
      const file = permissionsFilePathFor(runDirPathFor(row.id))
      if (!existsSync(file)) return { done: false, detail: `${row.status}, no ${file} yet` }
      return { done: true, value: row.id }
    },
  )
  const firstRun = await runRow(firstRunId)
  const firstRunDir = runDirPathFor(firstRunId)
  const firstPermissionsPath = permissionsFilePathFor(firstRunDir)
  console.log(`stage 1: the first run is ${describeRun(firstRun)}`)
  console.log(`stage 1: its verdict lives at ${firstPermissionsPath}`)
  const verdict = JSON.parse(readFileSync(firstPermissionsPath, 'utf8'))
  console.log(
    `stage 1: version=${String(verdict.version)} enforce=${String(verdict.enforce)} grants=${JSON.stringify(verdict.grants)} ` +
      `allow=${String(verdict.allow?.length)} entries vocabulary=${String(Object.keys(verdict.vocabulary ?? {}).length)} names ` +
      `tokenHash=${String(verdict.tokenHash).slice(0, 12)}…`,
  )
  await assertEqual(verdict.version, 2, 'stage 1: permissions.json version')
  await assertEqual(verdict.runId, firstRunId, 'stage 1: the run the verdict is about')
  await assertEqual(verdict.enforce, 'all-tools', 'stage 1: the enforcement word for claude_code')
  await assertEqual(verdict.grants, [...BASELINE_GRANTS.implementation], 'stage 1: the grants of a worker with no rows at all')
  if (!Array.isArray(verdict.allow)) await fail(`stage 1: allow is ${JSON.stringify(verdict.allow)}, expected an array`)
  const allowKinds = [...new Set(verdict.allow.map((entry) => entry.kind))]
  await assertEqual(allowKinds, [...BASELINE_GRANTS.implementation], 'stage 1: the distinct kinds on the allow list')
  if (typeof verdict.tokenHash !== 'string' || !/^[0-9a-f]{64}$/u.test(verdict.tokenHash)) {
    await fail(`stage 1: tokenHash is ${JSON.stringify(verdict.tokenHash)}, expected 64 lowercase hex`)
  }
  // The verdict's identity claim is the ROW's, not a number this file made up: a hash the row does
  // not carry would be a file no hook could ever match.
  await assertEqual(verdict.tokenHash, firstRun.runTokenHash, 'stage 1: the file hash against SlaveRun.runTokenHash')
  const vocabularyNames = Object.keys(verdict.vocabulary ?? {}).sort()
  const expectedNames = Object.keys(TOOL_VOCABULARY.claude_code).sort()
  await assertEqual(vocabularyNames.length, expectedNames.length, 'stage 1: how many tool names the verdict knows')
  const missingNames = expectedNames.filter((name) => verdict.vocabulary[name] !== TOOL_VOCABULARY.claude_code[name])
  if (missingNames.length > 0) {
    await fail(`stage 1: the verdict's vocabulary disagrees with TOOL_VOCABULARY on ${JSON.stringify(missingNames)}`)
  }
  // Stage 11's first half, measured where the file is first written (erratum E4).
  if (firstPermissionsPath.startsWith(main.repoPath)) {
    await fail(`stage 1: the verdict is INSIDE the repository the worker edits (${firstPermissionsPath} under ${main.repoPath})`)
  }
  console.log(`stage 1 PASSED: v2, ${JSON.stringify(verdict.grants)} and nothing else, ${String(vocabularyNames.length)} governed tool names, a 64-hex hash matching the row, outside ${main.repoPath}`)

  // ============================================================================================
  // Stage 2: an ungranted call is denied, and the run survives.
  // ============================================================================================
  const denial = await waitUntil(`the real hook's verdict on ${GATE_TOOL}`, WORKING_TIMEOUT_MS, async () => {
    const rows = readNdjson(gateOut).filter((entry) => entry.runId === firstRunId)
    if (rows.length === 0) return { done: false, detail: 'the fake CLI has not run the hook yet' }
    return { done: true, value: rows[0] }
  })
  console.log(`stage 2: the hook exited ${String(denial.exitCode)} and said ${JSON.stringify(denial.stdout.trim())}`)
  await assertEqual(denial.exitCode, 0, `stage 2: the hook's exit status on a ${GATE_TOOL} call`)
  if (!denial.stdout.includes(`permission matrix denies '${GATE_TOOL_KIND}' (${GATE_TOOL}) for this slave`)) {
    await fail(`stage 2: the hook's deny body does not name ${GATE_TOOL_KIND}/${GATE_TOOL}: ${JSON.stringify(denial.stdout)}`)
  }

  const toolDenied = await waitUntil('the run.tool_denied event the pump writes from it', WORKING_TIMEOUT_MS, async () => {
    const rows = await eventsOf(firstRunId, 'run.tool_denied')
    if (rows.length === 0) return { done: false, detail: 'no run.tool_denied row yet' }
    return { done: true, value: rows }
  })
  await assertEqual(toolDenied.length, 1, 'stage 2: run.tool_denied rows on the first run')
  console.log(`stage 2: the payload = ${JSON.stringify(toolDenied[0].payload)}`)
  await assertEqual(toolDenied[0].payload.tool, GATE_TOOL, 'stage 2: run.tool_denied payload.tool')
  await assertEqual(toolDenied[0].payload.capability, GATE_TOOL_KIND, 'stage 2: run.tool_denied payload.capability')

  // m18's shape, for the opposite reason: m18 proved a DENY does not stop a run; this proves the
  // same for a tool nobody ever denied. Measured once the run has CONCLUDED, so "it never paused"
  // is a statement about the whole run and not about a moment in it.
  const firstConcluded = await waitUntil('the first run to conclude', WORKING_TIMEOUT_MS, async () => {
    const row = await runRow(firstRunId)
    if (row.endedAt !== null) return { done: true, value: row }
    return { done: false, detail: describeRun(row) }
  })
  console.log(`stage 2: the concluded run = ${describeRun(firstConcluded)}`)
  await assertEqual(firstConcluded.status, 'succeeded', 'stage 2: the status a matrix-denied run concludes with')
  const guardrails = await prisma.executionEvent.count({ where: { runId: firstRunId, type: dbType('guardrail.tripped') } })
  await assertEqual(guardrails, 0, 'stage 2: guardrail.tripped rows on the denied run')
  const pauses = await prisma.executionEvent.count({ where: { runId: firstRunId, type: dbType('run.paused') } })
  await assertEqual(pauses, 0, 'stage 2: run.paused rows on the denied run')
  await assertEqual(firstConcluded.pausedAtStep, null, 'stage 2: pausedAtStep')
  const firstCheckpoint = await prisma.checkpoint.findUnique({ where: { runId: firstRunId } })
  if (firstCheckpoint !== null) {
    await fail('stage 2: a Checkpoint row exists for the denied run -- only a pause writes one, and this run never paused')
  }
  console.log(`stage 2 PASSED: one ${GATE_TOOL} refusal nobody had to configure, zero guardrails, never paused, no checkpoint, and the run reached succeeded`)

  // ============================================================================================
  // Stage 5, measured HERE because it is the SAME run: no grant, no operation.
  // (Numbered 5 in the brief; the call happens inside the run stages 1 and 2 measured, and the
  // worker holds no `deploy_release` grant yet, which is precisely the thing being measured.)
  // ============================================================================================
  const refusedCall = await waitUntil('the thin client to report a refusal', BROKER_TIMEOUT_MS, async () => {
    const rows = readNdjson(brokerOut).filter((entry) => entry.runId === firstRunId)
    if (rows.length === 0) return { done: false, detail: 'the worker has not called the broker yet' }
    return { done: true, value: rows[0] }
  })
  console.log(`stage 5: the client exited ${String(refusedCall.status)} saying ${JSON.stringify(refusedCall.stderr.trim())}`)
  await assertEqual(refusedCall.spawned, true, 'stage 5: the worker really spawned the thin client')
  await assertEqual(refusedCall.status, 1, 'stage 5: the thin client exit status on a refusal')
  await assertEqual(
    refusedCall.stderr.trim(),
    `${DEPLOY_OP}: ${BROKER_REFUSAL_LABEL.permission_denied.toLowerCase()}`,
    "stage 5: the sentence the worker's shell saw",
  )
  const refusals = await eventsOf(firstRunId, 'broker.refused')
  await assertEqual(refusals.length, 1, 'stage 5: broker.refused rows on the ungranted run')
  console.log(`stage 5: the payload = ${JSON.stringify(refusals[0].payload)}`)
  await assertEqual(refusals[0].payload.reason, 'permission_denied', 'stage 5: broker.refused payload.reason')
  await assertEqual(refusals[0].payload.op, DEPLOY_OP, 'stage 5: broker.refused payload.op')
  await assertEqual(deployLines(), [], 'stage 5: the lines fake-deploy.sh recorded')
  console.log('stage 5 PASSED: refused before anything ran, and the fake on the far side was never invoked')

  // ============================================================================================
  // Stage 11: the run directory is outside the repository (erratum E4).
  // ============================================================================================
  console.log(`stage 11: runDir = ${firstRunDir}`)
  if (!firstRunDir.startsWith(stateDir)) {
    await fail(`stage 11: the run directory ${firstRunDir} is not under SLAVEOFAI_STATE_DIR ${stateDir}`)
  }
  const repoRunsDir = join(main.repoPath, '.slaveofai', 'runs')
  const repoWorktreesDir = join(main.repoPath, '.slaveofai', 'worktrees')
  console.log(`stage 11: ${repoRunsDir} exists? ${String(existsSync(repoRunsDir))}`)
  console.log(`stage 11: ${repoWorktreesDir} exists? ${String(existsSync(repoWorktreesDir))}`)
  if (existsSync(repoRunsDir)) await fail(`stage 11: ${repoRunsDir} still exists -- the verdict is back inside the repository`)
  // Asserting BOTH is what keeps this stage honest: "`.slaveofai` is gone" would be false, and a
  // gate that asserted it would have to be weakened the first time somebody read it.
  if (!existsSync(repoWorktreesDir)) {
    await fail(`stage 11: ${repoWorktreesDir} does NOT exist -- a worktree is the worker's workspace and must not have moved`)
  }
  console.log('stage 11 PASSED: the verdict left the repository and the worktree stayed')

  // ============================================================================================
  // Stage 3: a person moves the wall -- and the run already in flight keeps its own verdict.
  // ============================================================================================
  console.log(runCli(['permission', 'grant', '--slave', main.worker.id, '--kind', GATE_TOOL_KIND, '--by', GATE_USERNAME]).trim())
  console.log(runCli(['permission', 'grant', '--slave', main.worker.id, '--kind', DEPLOY_OP, '--by', GATE_USERNAME]).trim())

  const changes = await prisma.executionEvent.findMany({
    where: { workspaceId: main.workspace.id, type: dbType('permission.changed') },
    orderBy: { seq: 'asc' },
  })
  console.log(`stage 3: permission.changed payloads = ${JSON.stringify(changes.map((row) => row.payload))}`)
  await assertEqual(changes.length, 2, 'stage 3: permission.changed rows')
  const fetchChange = changes.find((row) => row.payload.kind === GATE_TOOL_KIND)
  if (fetchChange === undefined) await fail(`stage 3: no permission.changed names ${GATE_TOOL_KIND}`)
  await assertEqual(fetchChange.payload.from, null, 'stage 3: permission.changed from')
  await assertEqual(fetchChange.payload.to, 'allow', 'stage 3: permission.changed to')
  await assertEqual(fetchChange.payload.by, gateUserId, 'stage 3: permission.changed by (the person, resolved from --by)')
  await assertEqual(fetchChange.actor, 'human', 'stage 3: the permission.changed envelope actor')

  // THE RESTART IS THE POINT. A verdict is written once per spawn and never merged, so the run the
  // grant did not reach is the one whose file still says so -- read back off disk, after the grant.
  const verdictAfterGrant = JSON.parse(readFileSync(firstPermissionsPath, 'utf8'))
  console.log(`stage 3: the FIRST run's verdict, re-read after the grant = ${JSON.stringify(verdictAfterGrant.grants)}`)
  await assertEqual(verdictAfterGrant.grants, [...BASELINE_GRANTS.implementation], "stage 3: the already-started run's grants after a person granted more")

  const secondTask = await prisma.task.create({
    data: {
      workspaceId: main.workspace.id,
      title: 'M52 Gate Granted Task',
      description: 'Seeded by gate:m52-broker — the run that starts AFTER the grant.',
      status: 'ready',
      requiredRole: WORKER_ROLE,
      maxAttempts: 3,
    },
  })
  console.log(`stage 3: task ${secondTask.id} (${secondTask.title}) is ready -- the next run starts with the new verdict`)

  const secondRunId = await waitUntil('a SECOND run to be dispatched with the granted verdict', WORKING_TIMEOUT_MS, async () => {
    const row = await prisma.slaveRun.findFirst({
      where: { slaveId: main.worker.id, id: { not: firstRunId } },
      orderBy: { startedAt: 'desc' },
    })
    if (row === null) return { done: false, detail: 'no second run row yet' }
    const file = permissionsFilePathFor(runDirPathFor(row.id))
    if (!existsSync(file)) return { done: false, detail: `${row.status}, no ${file} yet` }
    return { done: true, value: row.id }
  })
  const secondRunDir = runDirPathFor(secondRunId)
  const secondVerdict = JSON.parse(readFileSync(permissionsFilePathFor(secondRunDir), 'utf8'))
  console.log(`stage 3: the SECOND run (${secondRunId}) starts with grants ${JSON.stringify(secondVerdict.grants)}`)
  if (!secondVerdict.grants.includes(GATE_TOOL_KIND)) {
    await fail(`stage 3: the second run's verdict does not carry ${GATE_TOOL_KIND}: ${JSON.stringify(secondVerdict.grants)}`)
  }
  if (secondVerdict.tokenHash === verdict.tokenHash) {
    await fail('stage 3: the second run carries the FIRST run\'s token hash -- a token is minted per spawn')
  }

  const allowed = await waitUntil(`the real hook's verdict on ${GATE_TOOL} for the granted run`, WORKING_TIMEOUT_MS, async () => {
    const rows = readNdjson(gateOut).filter((entry) => entry.runId === secondRunId)
    if (rows.length === 0) return { done: false, detail: 'the fake CLI has not run the hook on this run yet' }
    return { done: true, value: rows[0] }
  })
  console.log(`stage 3: the hook exited ${String(allowed.exitCode)} and wrote ${JSON.stringify(allowed.stdout)} -- Claude's allow is silence`)
  await assertEqual(allowed.exitCode, 0, 'stage 3: the hook exit status on the granted call')
  await assertEqual(allowed.stdout, '', 'stage 3: the hook body on the granted call')
  console.log(`stage 3 PASSED: a person granted ${GATE_TOOL_KIND}, the run in flight kept the verdict it started with, and the next run's ${GATE_TOOL} call passed`)

  // ============================================================================================
  // Stage 4: the broker, end to end.
  // ============================================================================================
  const executedCall = await waitUntil('the thin client to report the operation ran', BROKER_TIMEOUT_MS, async () => {
    const rows = readNdjson(brokerOut).filter((entry) => entry.runId === secondRunId)
    if (rows.length === 0) return { done: false, detail: 'the granted worker has not called the broker yet' }
    return { done: true, value: rows[0] }
  })
  console.log(`stage 4: the client exited ${String(executedCall.status)} and printed ${JSON.stringify(executedCall.stdout)}`)
  await assertEqual(executedCall.status, 0, 'stage 4: the thin client exit status')
  await assertEqual(executedCall.stdout.trim(), 'deployed', "stage 4: the operation's own output, verbatim to the worker")

  // (a) The far side really ran, with the credential in hand.
  const lines = deployLines()
  console.log(`stage 4: fake-deploy.sh recorded ${JSON.stringify(lines)}`)
  await assertEqual(lines, [`${DEPLOY_ENVIRONMENT}|${DEPLOY_DIGEST}|token-present:yes`], 'stage 4: the lines fake-deploy.sh recorded')

  // (b) THE MILESTONE: the worker's own environment, dumped by the worker, holds neither.
  const childEnvs = readNdjson(envOut).filter((entry) => entry.runId === secondRunId)
  if (childEnvs.length === 0) await fail('stage 4: the worker never dumped its own environment')
  const childEnv = childEnvs[0].env
  const childNames = Object.keys(childEnv).sort()
  console.log(`stage 4: the worker's environment carries ${String(childNames.length)} names: ${JSON.stringify(childNames)}`)
  if (Object.hasOwn(childEnv, CREDENTIAL_ENV_VAR)) {
    await fail(`stage 4: ${CREDENTIAL_ENV_VAR} IS in the worker's own environment -- the worker holds the credential`)
  }
  if (Object.hasOwn(childEnv, 'DATABASE_URL')) {
    await fail("stage 4: DATABASE_URL IS in the worker's own environment -- the worker can reach the database")
  }
  // ...and the ORCHESTRATOR is where it DOES live, asserted rather than assumed: the environment
  // every daemon in this gate was spawned with carries the value, and this process -- which is not
  // the orchestrator -- does not.
  await assertEqual(daemonEnv()[CREDENTIAL_ENV_VAR], FAKE_DEPLOY_TOKEN, "stage 4: the credential on the daemon's own environment")
  await assertEqual(process.env[CREDENTIAL_ENV_VAR], undefined, "stage 4: the credential on the GATE's environment")
  console.log(`stage 4: the daemon held ${CREDENTIAL_ENV_VAR}, the worker did not, and ${lines[0]} is the far side saying it arrived`)

  // (c) The timeline.
  const executed = await eventsOf(secondRunId, 'broker.executed')
  await assertEqual(executed.length, 1, 'stage 4: broker.executed rows')
  console.log(`stage 4: the payload = ${JSON.stringify(executed[0].payload)}`)
  await assertEqual(executed[0].payload.op, DEPLOY_OP, 'stage 4: broker.executed payload.op')
  await assertEqual(executed[0].payload.environment, DEPLOY_ENVIRONMENT, 'stage 4: broker.executed payload.environment')
  await assertEqual(executed[0].payload.exitCode, 0, 'stage 4: broker.executed payload.exitCode')

  // (d) One findMany, one JSON.stringify, one includes.
  const everyEvent = await prisma.executionEvent.findMany({ where: { workspaceId: main.workspace.id } })
  const serialised = JSON.stringify(everyEvent, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  console.log(`stage 4: ${String(everyEvent.length)} ExecutionEvent rows searched for the credential's literal value`)
  if (serialised.includes(FAKE_DEPLOY_TOKEN)) {
    await fail("stage 4: the credential's VALUE is in the event log")
  }
  console.log(`stage 4 PASSED: ${BROKER_OP_LABEL[DEPLOY_OP]} ran, the far side got the credential, the worker's own environment had neither it nor DATABASE_URL, and no event carries the value`)

  const secondConcluded = await waitUntil('the second run to conclude', WORKING_TIMEOUT_MS, async () => {
    const row = await runRow(secondRunId)
    if (row.endedAt !== null) return { done: true, value: row }
    return { done: false, detail: describeRun(row) }
  })
  console.log(`stage 4: the granted run concluded ${secondConcluded.status}`)

  // ============================================================================================
  // Stages 6, 7 and 8: the forgeries, the unbound op, and the simulation.
  //
  // All three are measured against ONE hand-seeded run, and that is not a shortcut: a forger does
  // not use the client, so the gate must not either -- and a request written by hand needs a live
  // run with a directory the daemon is tailing. `pid: null` keeps the sweep's per-run loop away from
  // it entirely (`gate-m51-breaker.mjs`'s own idiom), and it is seeded while the daemon is ALREADY
  // running, because a daemon's startup pass treats a run with no pid as an orphan.
  // ============================================================================================
  const forgeToken = randomBytes(32).toString('hex')
  const seededRun = await prisma.slaveRun.create({
    data: {
      slaveId: main.worker.id,
      status: 'working',
      kind: 'implementation',
      provider: 'claude_code',
      model: 'sonnet',
      pid: null,
      runTokenHash: runTokenHash(forgeToken),
    },
  })
  const seededDir = runDirPathFor(seededRun.id)
  mkdirSync(seededDir, { recursive: true, mode: 0o700 })
  writeFileSync(brokerChannelPathFor(seededDir), '', { mode: 0o600 })
  console.log(`stages 6-8: seeded run ${seededRun.id} (working, no pid) with its own channel at ${brokerChannelPathFor(seededDir)}`)

  const deployParams = { environment: DEPLOY_ENVIRONMENT, digest: DEPLOY_DIGEST }

  // ---- Stage 6a: another run's id, in this run's directory (erratum E15). -----------------------
  const stolenIdReply = await askBroker('stage 6a (a line naming another run)', seededDir, {
    requestId: freshRequestId(),
    runId: secondRunId,
    runToken: forgeToken,
    op: DEPLOY_OP,
    params: deployParams,
  })
  await assertEqual(stolenIdReply.ok, false, 'stage 6a: the reply ok')
  await assertEqual(stolenIdReply.reason, 'identity_mismatch', 'stage 6a: the refusal reason')

  // ---- Stage 6b: a token that hashes to nothing. ------------------------------------------------
  const wrongTokenReply = await askBroker('stage 6b (a wrong token)', seededDir, {
    requestId: freshRequestId(),
    runId: seededRun.id,
    runToken: randomBytes(32).toString('hex'),
    op: DEPLOY_OP,
    params: deployParams,
  })
  await assertEqual(wrongTokenReply.ok, false, 'stage 6b: the reply ok')
  await assertEqual(wrongTokenReply.reason, 'identity_mismatch', 'stage 6b: the refusal reason')

  await assertEqual(deployLines().length, 1, 'stage 6: the lines fake-deploy.sh has recorded after both forgeries')
  console.log(`stage 6 PASSED: both forged lines answered ${JSON.stringify('identity_mismatch')} and neither ran anything`)

  // ---- Stage 7: an op with no binding. ----------------------------------------------------------
  const removed = await prisma.brokerBinding.deleteMany({ where: { workspaceId: main.workspace.id, op: DEPLOY_OP } })
  console.log(`stage 7: deleted ${String(removed.count)} BrokerBinding row(s) for ${DEPLOY_OP}`)
  const unboundReply = await askBroker('stage 7 (a granted worker, an unbound op)', seededDir, {
    requestId: freshRequestId(),
    runId: seededRun.id,
    runToken: forgeToken,
    op: DEPLOY_OP,
    params: deployParams,
  })
  await assertEqual(unboundReply.ok, false, 'stage 7: the reply ok')
  await assertEqual(unboundReply.reason, 'not_brokered', 'stage 7: the refusal reason')
  await assertEqual(deployLines().length, 1, 'stage 7: the lines fake-deploy.sh has recorded')
  console.log('stage 7 PASSED: the grant was there, the binding was not, and nothing ran')

  // ---- Stage 8: nothing crosses from a simulation. ----------------------------------------------
  // ARCHIVED, briefly and out loud. `simulation` is asked BEFORE `permission_denied` and before the
  // binding check, so this measures the archive and nothing else. The project is un-archived below,
  // because stage 10 reads its pages -- the refusal was measured on the archived state, and the log
  // says exactly when it went back.
  await prisma.workspace.update({ where: { id: main.workspace.id }, data: { archivedAt: new Date() } })
  console.log(`stage 8: project ${main.workspace.id} archived`)
  const archivedReply = await askBroker('stage 8 (an archived project)', seededDir, {
    requestId: freshRequestId(),
    runId: seededRun.id,
    runToken: forgeToken,
    op: DEPLOY_OP,
    params: deployParams,
  })
  await assertEqual(archivedReply.ok, false, 'stage 8: the reply ok')
  await assertEqual(archivedReply.reason, 'simulation', 'stage 8: the refusal reason')
  await assertEqual(deployLines().length, 1, 'stage 8: the lines fake-deploy.sh has recorded')
  await prisma.workspace.update({ where: { id: main.workspace.id }, data: { archivedAt: null } })
  console.log('stage 8: project un-archived — the refusal above was measured while it was archived, and stage 10 reads these pages')
  console.log('stage 8 PASSED: a workspace that reaches nothing real was told so, by name')

  // The seeded run has served its purpose; concluding it keeps the sweep and the Supervisor away
  // from a `working` row with no process behind it for the rest of the gate.
  await prisma.slaveRun.update({ where: { id: seededRun.id }, data: { status: 'stopped', endedAt: new Date() } })
  await stopDaemon(daemon)

  // ============================================================================================
  // Stage 9: the Supervisor may point, not move.
  // ============================================================================================
  const supervised = await makeProject({
    name: SUPERVISED_WORKSPACE_NAME,
    label: 'supervised',
    supervisorEnabled: true,
    workerName: BLOCKED_WORKER_NAME,
  })
  // A live run to hold the denials: `world.denials` counts `run.tool_denied` rows off NON-TERMINAL
  // runs only, which is what keeps a wall somebody moved last week from raising a situation today.
  // No daemon is ever spawned for this project -- `supervise` is the one-shot verb with the model
  // seam, and a daemon's startup orphan pass would fail this pid-less row before it could be read.
  const blockedRun = await prisma.slaveRun.create({
    data: { slaveId: supervised.worker.id, status: 'working', kind: 'implementation', provider: 'claude_code', model: 'sonnet', pid: null },
  })
  for (let i = 0; i < PERMISSION_TRIP_COUNT; i += 1) {
    await prisma.executionEvent.create({
      data: {
        workspaceId: supervised.workspace.id,
        slaveId: supervised.worker.id,
        runId: blockedRun.id,
        type: dbType('run.tool_denied'),
        actor: 'slave',
        payload: { tool: GATE_TOOL, capability: GATE_TOOL_KIND, toolUseId: `toolu_m52_gate_${String(i)}` },
      },
    })
  }
  console.log(
    `stage 9: ${BLOCKED_WORKER_NAME} has ${String(PERMISSION_TRIP_COUNT)} ${GATE_TOOL_KIND} denials on live run ${blockedRun.id} ` +
      '— one is a worker trying something, two is a worker retrying, three is a wall',
  )
  const report = runCli(['supervise', '--workspace', supervised.workspace.id])
  console.log(`stage 9: supervise printed:\n${report}`)

  const decision = await waitUntil('a request_permission decision', BROKER_TIMEOUT_MS, async () => {
    const row = await prisma.supervisorDecision.findFirst({
      where: { workspaceId: supervised.workspace.id, situationKind: 'permission_blocked' },
      orderBy: { createdAt: 'desc' },
    })
    if (row !== null) return { done: true, value: row }
    const all = await prisma.supervisorDecision.count({ where: { workspaceId: supervised.workspace.id } })
    return { done: false, detail: `${String(all)} decision(s), none of them permission_blocked` }
  })
  console.log(
    `stage 9: decision ${decision.id} situation=${decision.situationKind} subject=${String(decision.subjectId)} ` +
      `tier=${decision.tier} status=${decision.status}`,
  )
  console.log(`stage 9: the action = ${JSON.stringify(decision.action)}`)
  await assertEqual(decision.subjectId, `${supervised.worker.id}:${GATE_TOOL_KIND}`, 'stage 9: the situation subject')
  await assertEqual(decision.action.kind, 'request_permission', 'stage 9: the decision action kind')
  await assertEqual(decision.action.permissionKind, GATE_TOOL_KIND, 'stage 9: the operation it asks for')
  await assertEqual(decision.action.kindLabel, PERMISSION_LABEL[GATE_TOOL_KIND], 'stage 9: the WORD it asks in')
  await assertEqual(decision.tier, 'proposed', 'stage 9: the decision tier')
  await assertEqual(decision.status, 'pending', 'stage 9: the decision status')

  // THE ASSERTION THAT MATTERS. A proposal changes nothing.
  const beforeApproval = await prisma.slavePermission.findMany({ where: { slaveId: supervised.worker.id } })
  await assertEqual(beforeApproval, [], 'stage 9: SlavePermission rows while the proposal is pending')

  const approved = await approveDecision(decision.id, { userId: gateUserId })
  if (!approved.ok) await fail(`stage 9: the approval was refused: ${JSON.stringify(approved.error)}`)
  const afterApproval = await prisma.slavePermission.findMany({ where: { slaveId: supervised.worker.id } })
  console.log(`stage 9: after a person approved, the rows are ${JSON.stringify(afterApproval.map((row) => ({ kind: row.kind, mode: row.mode, grantedBy: row.grantedBy })))}`)
  await assertEqual(afterApproval.length, 1, 'stage 9: SlavePermission rows after the approval')
  await assertEqual(afterApproval[0].kind, GATE_TOOL_KIND, 'stage 9: the kind a person approved')
  await assertEqual(afterApproval[0].mode, 'allow', 'stage 9: the mode')
  // THE APPROVER IS THE GRANTER: the Supervisor only ever asked.
  await assertEqual(afterApproval[0].grantedBy, gateUserId, 'stage 9: who the row records as the granter')
  console.log('stage 9 PASSED: the Supervisor pointed at the wall, wrote nothing, and a person moved it')

  // ============================================================================================
  // The real web shell, on a free port, loopback-bound.
  // ============================================================================================
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
  // Stage 10: the browser -- the panel's six lines, and the matrix's six words.
  // ============================================================================================
  // One explicit REFUSAL first, so all three glyphs are on the panel at once. It is also the
  // sharpest thing M52 gave `mode` to say: `deny` is a person overruling a BASELINE -- something the
  // old two-state matrix could not express, because `allow` and absence resolved identically.
  console.log(runCli(['permission', 'deny', '--slave', main.worker.id, '--kind', 'write_repo', '--by', GATE_USERNAME]).trim())

  await gotoReliably(`${baseUrl}/w/${main.workspace.id}?slave=${main.worker.id}`)
  await waitVisible(page.getByTestId('status-label'), `${WORKER_NAME}'s panel`)
  // SCOPED to the group, not `getByRole('button', { name })` on the page: the project Overview
  // behind this panel has its own `Advanced` disclosure (`OverviewAdvanced`'s `<summary>`) and the
  // tab strip has another, so a page-wide role query opens the wrong thing and reports a timeout on
  // a sentence that was never going to render.
  const permissionsGroup = page.locator('[data-testid="details-group"][data-group="permissions"]')
  await waitVisible(permissionsGroup, "the panel's Permissions group")
  await permissionsGroup.locator('button').first().click()
  await waitVisible(page.getByTestId(`panel-permission-${PERMISSION_KINDS[0]}`), 'the first permission line')

  const panelLines = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="panel-permission-"]')]
      .filter((node) => node.tagName === 'LI')
      .map((node) => ({
        kind: node.getAttribute('data-kind'),
        mode: node.getAttribute('data-mode'),
        source: node.getAttribute('data-source'),
        title: node.getAttribute('title'),
        glyph: (node.querySelector('span[aria-hidden]')?.textContent ?? '').trim(),
        word: (node.querySelector('[data-testid="permission-mode-word"]')?.textContent ?? '').trim(),
        // The sr-only word is not something a person SEES; the visible text is the label beside the
        // glyph, which is what the raw-key check below has to read.
        visible: (node.lastElementChild?.textContent ?? '').trim(),
      })),
  )
  console.log(`stage 10: the panel's permission lines = ${JSON.stringify(panelLines)}`)
  await assertEqual(panelLines.length, PERMISSION_KINDS.length, 'stage 10: how many permission lines the panel draws')
  await assertEqual(panelLines.map((line) => line.kind), [...PERMISSION_KINDS], 'stage 10: the kinds, in order, on data-kind')
  await assertEqual(
    panelLines.map((line) => line.visible),
    PERMISSION_KINDS.map((kind) => PERMISSION_LABEL[kind]),
    'stage 10: the WORDS a person reads',
  )
  // LABELS NEVER KEYS: no raw key is visible text anywhere in the group. `title` and `data-kind`
  // carry them, which is where a raw value belongs (`docs/ia.md` rule 3).
  await assertEqual(panelLines.map((line) => line.title), [...PERMISSION_KINDS], 'stage 10: the keys, on title')
  for (const line of panelLines) {
    if (line.visible.includes('_')) {
      await fail(`stage 10: the panel prints a raw key as visible text: ${JSON.stringify(line)}`)
    }
  }
  const glyphs = [...new Set(panelLines.map((line) => line.glyph))]
  console.log(`stage 10: the distinct glyphs = ${JSON.stringify(glyphs)}`)
  await assertEqual(glyphs.length, 3, 'stage 10: how many distinct glyphs the six lines draw')
  // The whole three-state vocabulary, one line each: a baseline is a ✓ (the run really may do it), a
  // person's refusal is a ✕ even over a baseline, and never-asked is a –.
  const byKind = Object.fromEntries(panelLines.map((line) => [line.kind, line]))
  await assertEqual(byKind['read_repo'].source, 'baseline', 'stage 10: read_repo source')
  await assertEqual(byKind['read_repo'].word, 'allowed', 'stage 10: read_repo, said out loud')
  await assertEqual(byKind[GATE_TOOL_KIND].source, 'granted', `stage 10: ${GATE_TOOL_KIND} source`)
  await assertEqual(byKind[GATE_TOOL_KIND].word, 'allowed', `stage 10: ${GATE_TOOL_KIND}, said out loud`)
  await assertEqual(byKind['write_repo'].source, 'refused', 'stage 10: write_repo source after a person refused it')
  await assertEqual(byKind['write_repo'].word, 'refused', 'stage 10: write_repo, said out loud')
  await assertEqual(byKind['read_secret'].source, 'never', 'stage 10: read_secret source')
  await assertEqual(byKind['read_secret'].word, 'not set', 'stage 10: read_secret, said out loud')
  const distinct = new Set([byKind['read_repo'].glyph, byKind['write_repo'].glyph, byKind['read_secret'].glyph])
  if (distinct.size !== 3) {
    await fail(`stage 10: allowed, refused and not-set do not draw three different glyphs: ${JSON.stringify([...distinct])}`)
  }

  await permissionsGroup.locator('[data-testid="details-group"][data-group="advanced"] button').first().click()
  await waitVisible(page.getByTestId(`panel-permission-source-${GATE_TOOL_KIND}`), 'the policy sentences')
  const sentences = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-testid^="panel-permission-source-"]')].map((node) => [
        (node.getAttribute('data-testid') ?? '').replace('panel-permission-source-', ''),
        { text: (node.textContent ?? '').trim(), source: node.getAttribute('data-source'), title: node.getAttribute('title') },
      ]),
    ),
  )
  console.log(`stage 10: the policy sentences by kind = ${JSON.stringify(sentences)}`)
  await assertEqual(
    sentences['read_repo'].text,
    'Baseline (implementation runs)',
    'stage 10: what a baseline says about itself',
  )
  await assertEqual(sentences['read_secret'].text, 'Never granted — a brokered operation, not a tool', 'stage 10: what a never-granted broker operation says')
  if (!sentences['write_repo'].text.startsWith(`Refused by ${GATE_USERNAME} on `)) {
    await fail(`stage 10: the refused sentence is ${JSON.stringify(sentences['write_repo'].text)}, expected it to start "Refused by ${GATE_USERNAME} on "`)
  }
  const granted = sentences[GATE_TOOL_KIND]
  if (granted === undefined) await fail(`stage 10: no sentence for ${GATE_TOOL_KIND}: ${JSON.stringify(sentences)}`)
  await assertEqual(granted.source, 'granted', `stage 10: the ${GATE_TOOL_KIND} sentence's data-source`)
  // THE GRANTER IS A USERNAME (E18), and the raw id lives in `title`.
  if (!granted.text.startsWith(`Granted by ${GATE_USERNAME} on `)) {
    await fail(`stage 10: the granted sentence is ${JSON.stringify(granted.text)}, expected it to start "Granted by ${GATE_USERNAME} on "`)
  }
  await assertEqual(granted.title, gateUserId, "stage 10: the granter's User.id, in title and nowhere visible")
  if (granted.text.includes(gateUserId)) {
    await fail(`stage 10: the granter's raw id is visible text: ${JSON.stringify(granted.text)}`)
  }
  console.log(`stage 10: the sentence reads ${JSON.stringify(granted.text)}`)

  // ---- The Settings matrix. ---------------------------------------------------------------------
  await gotoReliably(`${baseUrl}/w/${main.workspace.id}/settings`)
  await waitVisible(page.getByTestId('perm-caption'), 'the permission matrix')
  const columns = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="perm-column"]')].map((node) => ({
      text: (node.textContent ?? '').trim(),
      kind: node.getAttribute('data-kind'),
      title: node.getAttribute('title'),
    })),
  )
  console.log(`stage 10: the matrix's column headers = ${JSON.stringify(columns)}`)
  await assertEqual(columns.map((column) => column.text), PERMISSION_KINDS.map((kind) => PERMISSION_LABEL[kind]), 'stage 10: the column headers, as words')
  await assertEqual(columns.map((column) => column.kind), [...PERMISSION_KINDS], 'stage 10: the keys, on data-kind')
  await assertEqual(columns.map((column) => column.title), [...PERMISSION_KINDS], 'stage 10: the keys, on title')

  // Three clicks on a cell nobody has decided: unset -> allow -> deny -> unset. The third is the one
  // M52 added, and the one a person who granted something in error needs.
  const cell = page.getByTestId(`perm-cell-${main.worker.id}-read_secret`)
  await waitVisible(cell, 'the read_secret cell')
  const readCell = async () =>
    await cell.evaluate((node) => ({ mode: node.getAttribute('data-mode'), title: node.getAttribute('title'), label: node.getAttribute('aria-label') }))
  const clickUntil = async (expected, what) => {
    await cell.click()
    const state = await waitUntil(what, ACTION_TIMEOUT_MS, async () => {
      const now = await readCell()
      if (now.mode === expected) return { done: true, value: now }
      return { done: false, detail: JSON.stringify(now) }
    })
    console.log(`${what} -> ${JSON.stringify(state)}`)
    return state
  }
  console.log(`stage 10: the read_secret cell starts at ${JSON.stringify(await readCell())}`)
  await assertEqual((await readCell()).mode, 'unset', 'stage 10: the cell before anybody clicks it')
  await clickUntil('allow', 'stage 10: the first click')
  await clickUntil('deny', 'stage 10: the second click')
  const backToUnset = await clickUntil('unset', 'stage 10: the third click, taking the decision back')
  await assertEqual(backToUnset.title, 'not set', 'stage 10: what the cell says after the third click')
  await assertEqual(
    backToUnset.label,
    `${WORKER_NAME} · ${PERMISSION_LABEL.read_secret} · not set`,
    'stage 10: the cell said out loud',
  )
  const afterThird = await prisma.slavePermission.findMany({ where: { slaveId: main.worker.id, kind: 'read_secret' } })
  await assertEqual(afterThird, [], 'stage 10: the read_secret row after the third click -- the DELETE really deleted')
  console.log('stage 10 PASSED: six words on the panel and six on the matrix, three glyphs, the granter by name, and a way back to nobody-has-decided')

  console.log(`gotoReliably retries this run: ${String(gotoRetries.length)}${gotoRetries.length === 0 ? '' : ` (${JSON.stringify(gotoRetries)})`}`)
  console.log(`PASS: ${PASS_LINE}`)
  exitCode = 0
} finally {
  // ============================================================================================
  // Teardown, in FK order, and every process this gate started.
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
  if (gateUserId !== null) {
    await prisma.executionEvent.updateMany({ where: { userId: gateUserId }, data: { userId: null } }).catch(() => {})
    await deleteUser(gateUserId).catch(() => {})
    await prisma.user.delete({ where: { id: gateUserId } }).catch(() => {})
  }
  for (const path of repoPaths) rmSync(path, { recursive: true, force: true })
  // THE WHOLE STATE TREE (Task 2's C1). Every run directory this gate caused is under it, which is
  // the difference between a gate that cleans up after itself and 366 directories in somebody's
  // `$HOME`.
  if (stateDir !== null) rmSync(stateDir, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
