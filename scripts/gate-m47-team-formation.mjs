// M47's own gate (spec R7): the Supervisor chooses a worker by CAPABILITY, and the scheduler still
// dispatches by ROLE. One matching rule, proved end to end against a real daemon and the fake CLI.
//
// Seven stages, each measuring one rule the milestone claims:
//   1. The taxonomy is data: `capabilities sync` through the real CLI fills the table, a second
//      run changes nothing, and `capabilities add` puts an operator's own key in it.
//   2. The checked-in fixture catalog is imported through the real CLI. Each persona's capability
//      bullets resolve to KEYS, the bullet that matches nothing is kept verbatim and matches
//      nothing, and the collaboration line becomes ONE advisory edge pointing at the persona it
//      names, carrying the capability the sentence is about.
//   3. A workspace with ONE worker (`backend.api-design`, dispatchable as backend and manager) and
//      a goal. The planning run is answered from `plan-graph-capabilities`: the tasks come back
//      with `requiredCapabilities`, with a `requiredRole` DERIVED from them where the plan named
//      none, with the planner's own role where it did, and the unknown key is dropped and named on
//      `workspace.plan_created.droppedCapabilities`.
//   4. The Supervisor raises `capability_unstaffed(security.application)` -- nobody can be
//      dispatched as `security` -- and PROPOSES `hire_from_catalog`, pending, with the rationale
//      sentence naming the capability. Nothing is hired while it waits.
//   5. A human approves it with the operator's own `approve-decision` as a real subprocess: a
//      project slave exists with `capabilities`, `runtimeRoles` including `security`,
//      `hiredFromTemplateId` and `selectionRationale` -- and the very next tick DISPATCHES the
//      authentication task to it by ROLE. That dispatch is the whole claim: the Supervisor reasoned
//      in capabilities and the scheduler matched a string, exactly as it always has.
//   6. A capability an existing idle worker already provides is assigned ROUTINELY: the worker is
//      given the capability and then stripped of the role it projects to, a task that needs it is
//      put on the board, and the Supervisor writes an `applied` row that grants the role back --
//      without asking anybody, because the worker's own row is the evidence. A SECOND task, asking
//      for a capability only the catalog's other persona provides, is put on the board in the same
//      breath and deliberately left unanswered: it is what stage 7's Needs section is about.
//   7. In a real browser: the Organization tab lists the workers with the capabilities they
//      provide and the sentence that says why each is here, the Needs section shows what is
//      missing, and the resolved collaboration edge is shown as advice.
//   8. Teardown, in FK order, on every exit path.
//
// NEVER A MODEL CALL. The daemon is spawned with SLAVEOFAI_CLAUDE_BIN=node,
// SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m8-flow --plan-fixture plan-graph-capabilities"
// and SLAVEOFAI_REQUIRE_FAKE_CLI=1; the browser half needs SLAVEOFAI_CLAUDE_BIN to name an
// executable under scripts/gate-fakes/ or the preflight refuses to start at all.
//
// THE FIXTURE CATALOG IS COPIED TO A TEMP DIRECTORY AND `git init`ed THERE, like m46's: this gate
// must never modify a file in this repository, and `git status` after a green run has to be empty.
//
// WHY THE DAEMON RUNS FIRST AND THE BROWSER LAST (the one place this file departs from m46's
// order): stage 7 photographs a worker that stage 5's approval hired, so the rows have to exist
// before the page is opened. The daemon is stopped -- and its absence re-checked with
// `findRealDaemonPids()` -- before `next dev` is spawned, so the two never race the machine.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: it boots its own `next dev`
// against `apps/web/.next` on a free port, and two of those corrupt the build cache for both.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m47-team-formation
//
// Shape borrowed from `gate-m46-workforce-catalog.mjs` (the temp-repo copy of the fixture catalog,
// `preflightCleanup`, `dumpGateRows`, `fail`, `waitUntil`, `waitVisible`, `gotoReliably`, the free
// port + real `next dev` under `loopbackChildEnv()`, the ready-wait on next's own bound-port line,
// the browser preflight refusal, `exitCode` starting at 1, teardown in FK order in a `finally`)
// and from `gate-m38-supervisor.mjs` (the one-worker workspace built out of rows, `describeDecision`
// and the `approve-decision` subprocess a human's answer really is).

import { execFileSync, spawn } from 'node:child_process'
import { accessSync, constants, cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids } from './lib/daemon-process.mjs'
import { prisma } from '../packages/db/dist/client.js'
import { CAPABILITY_SEED } from '../packages/db/dist/capabilities.js'
import { isAlive } from '../packages/control/dist/index.js'

const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 100
const DAEMON_PERIOD_MS = 500
const PLAN_TIMEOUT_MS = 180_000
const SUPERVISOR_TIMEOUT_MS = 180_000
const DISPATCH_TIMEOUT_MS = 120_000
const IDLE_TIMEOUT_MS = 240_000
/** `gate-m14-fidelity.mjs`'s own signature for next dev's torn `loadManifest` read. */
const MANIFEST_RACE_SIGNATURE = 'Unexpected end of JSON input'
const VIEWPORT = { width: 1440, height: 900 }

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

// Exact literals, never suffixed -- `preflightCleanup` removes whatever a prior crashed run left on
// these exact names, in the same FK order the `finally` block uses.
const CATALOG_NAME = 'catalog-m47'
const FIXTURE_CATALOG = join(repoRoot, 'scripts/fixtures', CATALOG_NAME)
const BUILDER = 'Gate Platform Builder'
const REVIEWER = 'Gate Security Reviewer'
const WORKSPACE_NAME = 'M47 Gate Project'
const WORKER_NAME = 'Dev'
const OPERATOR_KEY = 'legal.contracts'
const AUTH_TASK_TITLE = 'Add authentication to the endpoint'
const CORE_TASK_TITLE = 'Write the feature core'
const POLISH_TASK_TITLE = 'Document and polish'
const QA_TASK_TITLE = 'M47 Gate Automated Test Sweep'
const EXPORT_TASK_TITLE = 'M47 Gate Nightly Metrics Export'
const GOAL = 'Ship the endpoint, with an authentication path somebody who does security has read.'
/** Every template name this gate can create. Addressed by name as well as by `sourceId`, so a run
 *  interrupted before its own teardown leaves no row behind in a shared dev database. */
const GATE_TEMPLATE_NAMES = [BUILDER, REVIEWER]
/**
 * The seed row stage 1 DELETES before it runs `capabilities sync`.
 *
 * Without it stage 1 could not measure anything: this gate runs against a seeded database where
 * the whole taxonomy is already present, so a first `sync` would report `0 added` exactly as the
 * second one does and "a second run changes nothing" would be vacuous. `mobile.cross-platform` is
 * the one key nothing else in this file, in the fixture catalog or in the plan fixture mentions,
 * and `sync` itself is what puts it back -- so a crash between the delete and the sync is repaired
 * by the very next run of this stage.
 */
const SYNC_PROBE_KEY = 'mobile.cross-platform'

/** Asks the OS for a free TCP port. `next dev -p <port>` still auto-increments if something grabs
 *  it between this call and the spawn, so the ready-wait parses the ACTUAL bound port back out of
 *  next dev's own ready line. (`gate-m46-workforce-catalog.mjs`, verbatim.) */
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

/** A real repository, because the tick provisions a real worktree in it and the fake CLI commits
 *  into that worktree. (`gate-m46-workforce-catalog.mjs`'s `makeRepo`.) */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m47-repo-'))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/** Every file under `dir`, with its byte count -- printed so a failure can be read against what was
 *  actually on disk rather than against what the fixture is supposed to hold. */
function listTree(dir, prefix = '') {
  const out = []
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTree(full, `${prefix}${entry.name}/`))
    else out.push(`${prefix}${entry.name}  ${String(statSync(full).size)} bytes`)
  }
  return out
}

/** A decision row as this gate prints it: the JSON columns are what every assertion below reads,
 *  and a failure that shows only ids is a failure nobody can diagnose from the log.
 *  (`gate-m38-supervisor.mjs`'s helper.) */
const describeDecision = (row) =>
  JSON.stringify({
    id: row.id,
    situationKind: row.situationKind,
    subjectId: row.subjectId,
    tier: row.tier,
    status: row.status,
    decidedBy: row.decidedBy,
    modelCalled: row.modelCalled,
    action: row.action,
  })

/** A task row as this gate prints it -- the four columns M47 added or derives. */
const describeTask = (row) =>
  `${row.title} [${row.status}] role=${JSON.stringify(row.requiredRole)} caps=${JSON.stringify(row.requiredCapabilities)}`

/** The templates this catalog owns, by `sourceId` -- never by name, which is exactly the thing an
 *  operator is free to change. */
const catalogTemplates = () =>
  prisma.slaveTemplate.findMany({ where: { sourceId: { startsWith: `${CATALOG_NAME}/` } }, orderBy: { sourceId: 'asc' } })

/** Every template this gate can have created: the imported ones, addressed by the `sourceId` prefix
 *  only this catalog writes, plus anything left on the two exact names. A `CompanySlave` holds a
 *  non-cascading reference, so the roster links go first; `CollaborationHint` cascades on the
 *  template it belongs to and is nulled on the template it points at. */
async function deleteGateTemplates(label) {
  const rows = await prisma.slaveTemplate.findMany({
    where: { OR: [{ sourceId: { startsWith: `${CATALOG_NAME}/` } }, { name: { in: GATE_TEMPLATE_NAMES } }] },
    select: { id: true, name: true },
  })
  if (rows.length === 0) return
  console.log(`${label}: removing ${String(rows.length)} gate template(s): ${JSON.stringify(rows.map((r) => r.name))}`)
  const ids = rows.map((r) => r.id)
  await prisma.companySlave.deleteMany({ where: { templateId: { in: ids } } }).catch(() => {})
  await prisma.slaveTemplate.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
}

/** Removes what a prior interrupted run left behind, in the same order the `finally` block uses:
 *  the workspace's events (no FK) then the workspace (cascades Team/Slave/Task/SlaveRun/RunContext/
 *  SupervisorDecision), then this catalog's templates and its import records, then the operator's
 *  own capability key. A seed row a crashed stage 1 removed is put back by stage 1 itself. */
async function preflightCleanup() {
  const stale = await prisma.workspace.findUnique({ where: { name: WORKSPACE_NAME } })
  if (stale !== null) {
    console.log(`preflight: removing a leftover ${WORKSPACE_NAME} (${stale.id}) from an earlier interrupted run`)
    await prisma.executionEvent.deleteMany({ where: { workspaceId: stale.id } }).catch(() => {})
    await prisma.slaveMessage.deleteMany({ where: { workspaceId: stale.id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: stale.id } }).catch(() => {})
  }
  await deleteGateTemplates('preflight')
  const staleImports = await prisma.catalogImport.deleteMany({ where: { catalog: CATALOG_NAME } })
  if (staleImports.count > 0) console.log(`preflight: removing ${String(staleImports.count)} leftover CatalogImport row(s)`)
  const staleKey = await prisma.capability.deleteMany({ where: { key: OPERATOR_KEY } })
  if (staleKey.count > 0) console.log(`preflight: removing a leftover operator capability ${OPERATOR_KEY}`)
}

let exitCode = 1
let nextServer = null
let nextOutput = ''
let browser = null
let page = null
let diagDir = null
let repoPath = null
let catalogRoot = null
let catalogDir = null
let workspaceId = null
/** Every daemon this gate has ever spawned, in order -- the `finally` block kills whichever of them
 *  is somehow still alive, not just the last one. */
const daemons = []
/** The browser console, newest last, for `fail()`'s dump. */
const browserConsole = []
/** Every URL `gotoReliably` retried, printed beside the PASS line so a rising rate is visible in
 *  GREEN runs too (`gate-m14-fidelity.mjs`'s accounting). */
const gotoRetries = []

/** Every row this gate could have written, for a FAIL's diagnostic dump. BigInt `seq` stringified. */
async function dumpGateRows() {
  const workspace =
    workspaceId === null
      ? null
      : await prisma.workspace
          .findUnique({
            where: { id: workspaceId },
            include: { tasks: true, teams: { include: { slaves: { include: { runs: true } } } }, supervisorDecisions: true },
          })
          .catch(() => null)
  const templates = await prisma.slaveTemplate
    .findMany({ where: { OR: [{ sourceId: { startsWith: `${CATALOG_NAME}/` } }, { name: { in: GATE_TEMPLATE_NAMES } }] } })
    .catch(() => [])
  const hints = await prisma.collaborationHint.findMany({ where: { template: { sourceId: { startsWith: `${CATALOG_NAME}/` } } } }).catch(() => [])
  const daemonTails = daemons.map((d) => ({
    label: d.label,
    pid: d.proc.pid ?? null,
    exited: d.exited,
    output: d.output.length > 6_000 ? `…${d.output.slice(-6_000)}` : d.output,
  }))
  return JSON.stringify({ workspace, templates, hints, daemonTails }, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m47-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ============================================================================================
  // Stage 0: the preflight. Refusals, never fallbacks.
  // ============================================================================================

  // Zero spend, ENFORCED (Decision 10, M32 item 7). Stages 3 to 6 drive a real daemon; without this
  // refusal a lost fake binary would reach a vendor account instead.
  const fakeClaude = process.env['SLAVEOFAI_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'SLAVEOFAI_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m47-team-formation',
    )
  }
  try {
    accessSync(fakeClaude, constants.X_OK)
  } catch {
    throw new Error(`SLAVEOFAI_CLAUDE_BIN=${fakeClaude} is not an executable file`)
  }
  // `startsWith(<repo>/scripts/gate-fakes)` rather than a bare `includes('gate-fakes')`: only a
  // fake in THIS repository counts.
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
      `no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m47-team-formation passes ` +
        '--env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m47-team-formation`')
  }
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI} -- run \`npx tsc --build\` first`)
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)
  if (!existsSync(FIXTURE_CATALOG)) throw new Error(`the fixture catalog is missing at ${FIXTURE_CATALOG}`)
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- stage 7 reads a real rendered page, so set CHROMIUM_PATH to a ` +
        'real executable (e.g. a playwright-installed chromium under ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome).',
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
  // Refused rather than tolerated (`gate-m36-messaging.mjs`'s own refusal): another daemon would be
  // ticking this gate's workspace -- and every other one -- while it measures a single dispatch.
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m47-team-formation REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate spawns its own and measures the decisions it makes',
    )
  }
  console.log(`fake claude: ${fakeClaude}`)
  console.log(`chromium:    ${chromiumPath}`)

  await preflightCleanup()

  const childEnv = () =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      // The planning arm's answer is chosen on ARGV (M47 D7): `SLAVEOFAI_CLAUDE_ARGS` rides through
      // as `extraArgs` on every spawn, which is already how `--fixture` itself arrives.
      SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8-flow --plan-fixture plan-graph-capabilities`,
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
    })

  /** Runs the real orchestrator CLI as a subprocess, exactly as an operator's shell would. */
  const runCli = (args) => {
    try {
      return execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
        cwd: repoRoot,
        env: childEnv(),
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

  /** The diagnostic throw: the state that made the call, not just the sentence that noticed. */
  async function fail(message) {
    let screenshotPath = null
    if (page !== null && diagDir !== null) {
      screenshotPath = join(diagDir, `failure-${String(Date.now())}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
    }
    const pageUrl = page === null ? '<no page>' : page.url()
    const dump = await dumpGateRows().catch(
      (cause) => `<could not dump gate rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
    )
    throw new Error(
      `${message}\n--- browser url ---\n${pageUrl}\n--- screenshot ---\n${screenshotPath ?? '<none>'}\n` +
        `--- browser console (tail) ---\n${browserConsole.slice(-40).join('\n')}\n--- gateRows ---\n${dump}`,
    )
  }

  /** Deep equality over the plain JSON shapes this gate reads back, with BOTH values printed --
   *  a measured value in the log of a GREEN run is the point, not only of a red one. */
  async function assertEqual(actual, expected, what) {
    console.log(`${what}: ${JSON.stringify(actual)}`)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      await fail(`${what} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
    }
  }

  /** The daemon this gate currently expects to be alive, or `null` between two of them.
   *  `waitUntil` fails immediately when it dies rather than sitting out a whole timeout. */
  let activeDaemon = null

  /**
   * Polls `probe` until it returns something other than `null`/`undefined`, and returns it, or
   * fails naming what it last saw. (`gate-m40-requirement-versioning.mjs`'s `waitUntil`.)
   */
  async function waitUntil(description, timeoutMs, probe) {
    const deadline = Date.now() + timeoutMs
    let lastSeen = '<nothing yet>'
    for (;;) {
      const result = await probe((seen) => {
        lastSeen = seen
      })
      if (result !== null && result !== undefined && result !== false) return result
      if (activeDaemon !== null && activeDaemon.exited) {
        await fail(`the ${activeDaemon.label} exited while waiting for ${description} -- last seen: ${lastSeen}`)
      }
      if (Date.now() >= deadline) {
        await fail(`timed out after ${String(timeoutMs)}ms waiting for ${description} -- last seen: ${lastSeen}`)
      }
      await delay(POLL_INTERVAL_MS)
    }
  }

  /** The real daemon, in the background -- the same thing an operator leaves running. */
  function spawnDaemon(label) {
    const proc = spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspaceId, '--period', String(DAEMON_PERIOD_MS)], {
      cwd: repoRoot,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
    console.log(`${label} spawned as pid ${String(proc.pid)}`)
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

  /** Every task on the board, oldest first -- the order the plan created them in. */
  const board = () => prisma.task.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })

  // ============================================================================================
  // Stage 1: the taxonomy is DATA, and the CLI is how an operator touches it.
  // ============================================================================================

  const seedProbe = CAPABILITY_SEED.find((record) => record.key === SYNC_PROBE_KEY)
  if (seedProbe === undefined) await fail(`stage 1: ${SYNC_PROBE_KEY} is not in CAPABILITY_SEED any more -- pick another probe key`)
  const removed = await prisma.capability.deleteMany({ where: { key: SYNC_PROBE_KEY } })
  console.log(`stage 1: removed ${String(removed.count)} row(s) for ${SYNC_PROBE_KEY} so \`sync\` has something to do`)

  const firstSync = runCli(['capabilities', 'sync'])
  console.log(`stage 1 -- \`capabilities sync\` printed: ${JSON.stringify(firstSync.trim())}`)
  if (!firstSync.includes('1 added')) await fail(`stage 1: the first sync reported ${JSON.stringify(firstSync.trim())}, expected 1 added`)
  const restored = await prisma.capability.findUnique({ where: { key: SYNC_PROBE_KEY } })
  console.log(`stage 1 -- ${SYNC_PROBE_KEY} after the sync: ${JSON.stringify(restored)}`)
  if (restored === null) await fail(`stage 1: \`capabilities sync\` did not put ${SYNC_PROBE_KEY} back`)
  if (restored.label !== seedProbe.label || restored.role !== seedProbe.role) {
    await fail(`stage 1: ${SYNC_PROBE_KEY} came back as ${JSON.stringify(restored.label)} -> ${JSON.stringify(restored.role)}, expected the checked-in list's`)
  }

  // The non-vacuous negative: the SAME command, against a table that is now complete.
  const secondSync = runCli(['capabilities', 'sync'])
  console.log(`stage 1 -- the second \`capabilities sync\` printed: ${JSON.stringify(secondSync.trim())}`)
  if (!secondSync.includes('0 added') || !secondSync.includes('0 brought back')) {
    await fail(`stage 1: a second sync reported ${JSON.stringify(secondSync.trim())}, expected nothing to change`)
  }

  const added = runCli(['capabilities', 'add', '--key', OPERATOR_KEY, '--label', 'Contract review', '--role', 'legal'])
  console.log(`stage 1 -- \`capabilities add\` printed: ${JSON.stringify(added.trim())}`)
  const operatorRow = await prisma.capability.findUniqueOrThrow({ where: { key: OPERATOR_KEY } })
  console.log(`stage 1 -- the operator's own row: ${JSON.stringify(operatorRow)}`)
  // NOT `seed`: `syncCapabilityTaxonomy` repairs a seed row against the checked-in list and leaves
  // every other row alone, so this column is the whole of the promise that an operator's own key
  // survives the next sync (asserted below).
  if (operatorRow.createdBy !== 'human') {
    await fail(`stage 1: ${OPERATOR_KEY} was recorded as createdBy ${JSON.stringify(operatorRow.createdBy)}, expected human`)
  }
  if (operatorRow.domain !== 'legal' || operatorRow.role !== 'legal') {
    await fail(`stage 1: ${OPERATOR_KEY} projects to ${JSON.stringify(operatorRow.role)} in domain ${JSON.stringify(operatorRow.domain)}`)
  }
  const listed = runCli(['capabilities', 'list'])
  const listedKeys = listed.trim().split('\n').map((line) => line.split('\t')[0])
  console.log(`stage 1 -- \`capabilities list\` printed ${String(listedKeys.length)} key(s)`)
  for (const key of [SYNC_PROBE_KEY, OPERATOR_KEY, 'security.application', 'qa.test-automation', 'backend.api-design']) {
    if (!listedKeys.includes(key)) await fail(`stage 1: \`capabilities list\` does not carry ${key}: ${JSON.stringify(listedKeys)}`)
  }
  // A third sync, AFTER the operator's key: it must not be swept away by a list it is not on.
  const thirdSync = runCli(['capabilities', 'sync'])
  console.log(`stage 1 -- the sync after the operator's own key printed: ${JSON.stringify(thirdSync.trim())}`)
  if ((await prisma.capability.findUnique({ where: { key: OPERATOR_KEY } })) === null) {
    await fail("stage 1: a sync deleted the operator's own capability")
  }
  console.log('stage 1 complete: the taxonomy is a table an operator fills, repairs and extends through the CLI')

  // ============================================================================================
  // Stage 2: the fixture catalog, in a real git repository, through the real CLI.
  // ============================================================================================

  // The copy keeps the fixture's OWN directory name, because that name IS the catalog's name: with
  // no `--catalog`, the walk takes `basename(dir)` (M42 erratum E5), and that first segment is what
  // every `sourceId` asserted below is built from.
  catalogRoot = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m47-catalog-'))
  catalogDir = join(catalogRoot, CATALOG_NAME)
  cpSync(FIXTURE_CATALOG, catalogDir, { recursive: true })
  console.log(`catalog copied from ${FIXTURE_CATALOG} to ${catalogDir}:`)
  for (const line of listTree(catalogDir)) console.log(`  ${line}`)

  // `-c core.hooksPath= --no-verify` so a global git hook on the host cannot fail the fixture
  // commit; `-b main` so the branch name does not depend on the host's `init.defaultBranch`.
  execFileSync('git', ['init', '-q', '-b', 'main', catalogDir])
  execFileSync('git', ['-C', catalogDir, 'add', '-A'])
  execFileSync('git', [
    '-C', catalogDir,
    '-c', 'user.email=gate@example.invalid',
    '-c', 'user.name=Gate',
    '-c', 'core.hooksPath=',
    'commit', '-q', '--no-verify', '-m', 'fixture',
  ])
  const head = execFileSync('git', ['-C', catalogDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  console.log(`the temp catalog repository's HEAD: ${head}`)

  const importOutput = runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate'])
  console.log(`stage 2 -- import-catalog printed:\n${importOutput}`)

  const imported = await catalogTemplates()
  console.log(`stage 2 -- imported ${String(imported.length)} template(s): ${JSON.stringify(imported.map((row) => row.name))}`)
  if (imported.length !== 2) await fail(`stage 2: expected two templates, got ${String(imported.length)}`)

  const reviewer = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: REVIEWER } })
  const builder = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: BUILDER } })
  for (const row of [reviewer, builder]) {
    console.log(
      `stage 2 -- ${row.name}: role ${JSON.stringify(row.role)}, revision ${String(row.sourceRevision)}, ` +
        `licence ${String(row.sourceLicense)}, keys ${JSON.stringify(row.capabilityKeys)}, ` +
        `unresolved ${JSON.stringify(row.unresolvedCapabilities)}`,
    )
    if (row.sourceRevision !== head) {
      await fail(`stage 2: ${row.name} recorded revision ${String(row.sourceRevision)}, expected the temp repo's HEAD ${head}`)
    }
    if (row.sourceLicense !== 'MIT') await fail(`stage 2: ${row.name} recorded licence ${String(row.sourceLicense)}, expected MIT`)
  }
  await assertEqual(reviewer.capabilityKeys, ['security.application', 'security.authentication'], 'stage 2: the reviewer resolves two keys')
  await assertEqual(reviewer.unresolvedCapabilities, ["A calm read of somebody else's login flow"], 'stage 2: what matched nothing is kept verbatim')
  // The non-vacuous positive beside it: the other persona's bullets ALL resolved, so "kept
  // verbatim" is a property of the bullet and not of the import.
  await assertEqual(builder.capabilityKeys, ['backend.api-design', 'backend.services', 'data.pipelines'], 'stage 2: the builder resolves three keys')
  await assertEqual(builder.unresolvedCapabilities, [], 'stage 2: the builder left nothing unresolved')
  if (reviewer.role !== 'security') await fail(`stage 2: the reviewer's role is ${JSON.stringify(reviewer.role)}, expected its division`)

  // Scoped to THIS catalog's templates, never a global count: the database this gate runs against
  // is seeded, and a `findMany()` over the whole table would be measuring the seed as much as the
  // import (`gate-m46-workforce-catalog.mjs`'s own rule about counts).
  const hints = await prisma.collaborationHint.findMany({
    where: { templateId: { in: [reviewer.id, builder.id] } },
    include: { targetTemplate: true },
  })
  console.log(`stage 2 -- advisory edges: ${JSON.stringify(hints.map((h) => ({ from: h.templateId, to: h.targetTemplate?.name ?? null, capability: h.capability, text: h.text })))}`)
  if (hints.length !== 1) await fail(`stage 2: expected one advisory edge, got ${String(hints.length)}`)
  if (hints[0].templateId !== reviewer.id) await fail('stage 2: the edge does not belong to the persona whose file carries the sentence')
  if (hints[0].targetTemplate?.name !== BUILDER) await fail('stage 2: the hint does not point at the persona it names')
  if (hints[0].capability !== 'backend.api-design') await fail('stage 2: the hint did not resolve the capability its sentence is about')
  if (!hints[0].text.includes('Consult the Gate Platform Builder')) {
    await fail(`stage 2: the hint lost the persona's own sentence: ${JSON.stringify(hints[0].text)}`)
  }
  console.log(
    "stage 2 complete: two personas' capability bullets became taxonomy keys, the bullet that is nobody's capability is kept " +
      'in the persona\'s own words, and one sentence became one advisory edge carrying the capability it is about',
  )

  // ============================================================================================
  // Stage 3: a plan written in CAPABILITIES, and the roles it derives.
  // ============================================================================================

  repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath,
      baseBranch: 'main',
      autoMerge: false,
      verifyCommands: ['true'],
      setupCommands: [],
      maxAttempts: 5,
    },
  })
  workspaceId = workspace.id
  console.log(`workspace ${workspaceId} (${WORKSPACE_NAME}), repo ${repoPath}, supervisorEnabled ${String(workspace.supervisorEnabled)}`)
  if (!workspace.supervisorEnabled) await fail('a new workspace starts with its Supervisor switched off')
  // Without this row every dispatch refuses with `invalid_provider` (M12 Task 8) and nothing runs.
  await prisma.providerConfiguration.create({ data: { workspaceId, kind: 'claude_code', settings: {} } })

  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  // The ONLY worker. It PROVIDES `backend.api-design` and is dispatchable as backend (so the plan's
  // first task really can start) and as manager (so the planning run really can be staffed) -- and
  // as nothing else, which is what makes stage 4's gap a fact about this workspace rather than a
  // fixture. Its title deliberately does not read as a role: `staffingCandidates` orders offers by
  // whether the title reads as the role, and a gate whose candidate matched on the title would be
  // proving the ordering rather than the decision.
  const dev = await prisma.slave.create({
    data: {
      teamId: team.id,
      name: WORKER_NAME,
      role: 'Senior Engineer',
      runtimeRoles: ['backend', 'manager'],
      capabilities: ['backend.api-design'],
    },
  })
  const devId = dev.id
  console.log(`slave ${devId} (${WORKER_NAME}): runtimeRoles ${JSON.stringify(dev.runtimeRoles)}, capabilities ${JSON.stringify(dev.capabilities)}`)

  console.log(`stage 3 -- set-goal printed: ${JSON.stringify(runCli(['set-goal', '--workspace', workspaceId, '--goal', GOAL]).trim())}`)

  const daemon = spawnDaemon('daemon')

  // Waited on the EVENT rather than on the board: `concludePlanning` creates the whole graph in one
  // transaction and appends `workspace.plan_created` after it commits, so a gate that polled the
  // board would routinely catch a complete board and a log that has not caught up.
  const planEvent = await waitUntil('the plan to land', PLAN_TIMEOUT_MS, async (note) => {
    const row = await prisma.executionEvent.findFirst({ where: { workspaceId, type: 'workspace_plan_created' }, orderBy: { seq: 'asc' } })
    note(row === null ? 'no workspace.plan_created event yet' : 'landed')
    return row
  })
  const planned = await board()
  console.log(`stage 3 -- board (${String(planned.length)}):\n  ${planned.map(describeTask).join('\n  ')}`)
  if (planned.length !== 3) await fail(`stage 3: the plan produced ${String(planned.length)} tasks, expected 3`)

  const auth = await prisma.task.findFirstOrThrow({ where: { workspaceId, title: AUTH_TASK_TITLE } })
  await assertEqual(auth.requiredCapabilities, ['security.application'], 'stage 3: the task carries what it needs')
  if (auth.requiredRole !== 'security') await fail(`stage 3: the derived role is ${String(auth.requiredRole)}, expected security`)
  const core = await prisma.task.findFirstOrThrow({ where: { workspaceId, title: CORE_TASK_TITLE } })
  await assertEqual(core.requiredCapabilities, ['backend.api-design'], 'stage 3: the first task carries what it needs')
  if (core.requiredRole !== 'backend') await fail(`stage 3: the first task's derived role is ${String(core.requiredRole)}, expected backend`)
  const polish = await prisma.task.findFirstOrThrow({ where: { workspaceId, title: POLISH_TASK_TITLE } })
  if (polish.requiredRole !== 'backend') await fail('stage 3: the planner named a role and it did not win')
  await assertEqual(polish.requiredCapabilities, [], 'stage 3: the unknown key was dropped')
  console.log(`stage 3 -- workspace.plan_created payload: ${JSON.stringify(planEvent.payload)}`)
  await assertEqual(planEvent.payload.droppedCapabilities, ['nope.nothing'], 'stage 3: the dropped key is on the record')
  console.log(
    'stage 3 complete: a plan written in capabilities produced a board whose dispatch roles are DERIVED, kept the role a task ' +
      'named for itself, and named the key nobody defined rather than dropping it in silence',
  )

  // ============================================================================================
  // Stage 4: the gap, named by capability -- and a hire that WAITS.
  // ============================================================================================

  const decision = await waitUntil('the Supervisor to notice a capability nobody can be dispatched for', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.supervisorDecision.findFirst({
      where: { workspaceId, situationKind: 'capability_unstaffed' },
      orderBy: { createdAt: 'asc' },
    })
    note(row === null ? 'no capability_unstaffed decision yet' : 'written')
    return row
  })
  console.log(`stage 4 -- the decision: ${describeDecision(decision)}`)
  console.log(`stage 4 -- the situation it was made about: ${JSON.stringify(decision.situation)}`)
  if (decision.subjectId !== 'security.application') await fail(`stage 4: the situation is about ${decision.subjectId}`)
  if (decision.status !== 'pending' || decision.tier !== 'proposed') await fail(`stage 4: a hire must WAIT: ${describeDecision(decision)}`)
  if (decision.action.kind !== 'hire_from_catalog') await fail(`stage 4: the offer is ${decision.action.kind}`)
  if (decision.action.templateId !== reviewer.id) {
    await fail(`stage 4: the offer names template ${String(decision.action.templateId)}, expected the security persona ${reviewer.id}`)
  }
  if (!decision.action.rationale.includes('Application security')) await fail('stage 4: the rationale does not say what is missing')
  if ((await prisma.slave.count({ where: { team: { workspaceId } } })) !== 1) {
    await fail('stage 4: somebody was hired while the proposal was still pending')
  }
  // A proposal is a question, and a question has an envelope somebody can read.
  const proposedEvent = await prisma.executionEvent.findFirst({ where: { workspaceId, type: 'supervisor_proposed' }, orderBy: { seq: 'asc' } })
  console.log(`stage 4 -- supervisor.proposed event: ${proposedEvent === null ? 'none' : JSON.stringify(proposedEvent.payload)}`)
  if (proposedEvent === null) await fail('stage 4: no supervisor.proposed event was appended for the pending proposal')
  // The operator's own read of the queue, through the verb §2 names.
  const queue = JSON.parse(runCli(['supervisor-decisions', '--workspace', workspaceId, '--pending']))
  console.log(`stage 4 -- \`supervisor-decisions --pending\` returned ${String(queue.length)} row(s)`)
  if (!queue.some((row) => row.id === decision.id)) await fail('stage 4: the pending proposal is not in the operator\'s own queue')
  console.log('stage 4 complete: the gap is named by CAPABILITY, the offer is a hire, and it is waiting for a person')

  // ============================================================================================
  // Stage 5: a person answers -- and the scheduler matches a ROLE.
  // ============================================================================================

  console.log(`stage 5 -- approve-decision printed: ${JSON.stringify(runCli(['approve-decision', '--id', decision.id]).trim())}`)
  const approved = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: decision.id } })
  console.log(`stage 5 -- the decision after approval: ${describeDecision(approved)}`)
  if (approved.status !== 'approved') await fail(`stage 5: the approved decision is ${approved.status}, expected approved`)

  const hired = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId }, hiredFromTemplateId: reviewer.id } })
  console.log(
    `stage 5 -- the hire ${hired.id} (${hired.name}): role ${JSON.stringify(hired.role)}, runtimeRoles ` +
      `${JSON.stringify(hired.runtimeRoles)}, capabilities ${JSON.stringify(hired.capabilities)}, why ${JSON.stringify(hired.selectionRationale)}`,
  )
  if (!hired.runtimeRoles.includes('security')) await fail(`stage 5: the hire is not dispatchable as security: ${JSON.stringify(hired.runtimeRoles)}`)
  if (!hired.capabilities.includes('security.application')) await fail('stage 5: the hire does not provide what it was hired for')
  if (hired.selectionRationale === null) await fail('stage 5: nothing says why this worker is here')
  if ((await prisma.slave.count({ where: { team: { workspaceId } } })) !== 2) {
    await fail('stage 5: approving one hire did not put exactly one new worker on the project')
  }

  // THE claim: the scheduler matched a ROLE, and a real run started.
  const run = await waitUntil('the authentication task to be dispatched to the hired specialist BY ROLE', DISPATCH_TIMEOUT_MS, async (note) => {
    const row = await prisma.slaveRun.findFirst({ where: { slaveId: hired.id, task: { title: AUTH_TASK_TITLE } } })
    note(row === null ? 'no run for the authentication task on the hire yet' : 'dispatched')
    return row
  })
  console.log(`stage 5: run ${run.id} started for ${AUTH_TASK_TITLE} on ${hired.name}`)
  console.log(
    'stage 5 complete: the Supervisor reasoned in capabilities, a person approved, and the scheduler dispatched on one string ' +
      '-- exactly as it has since M37',
  )

  // ============================================================================================
  // Stage 6: the cheap fix nobody should be asked about.
  // ============================================================================================

  // A worker mid-run must never have its roles rewritten under it (`tierOf`'s busy check), so this
  // stage waits for the board to leave `Dev` alone before it measures a ROUTINE decision.
  await waitUntil(`${WORKER_NAME} to be idle`, IDLE_TIMEOUT_MS, async (note) => {
    const live = await prisma.slaveRun.count({ where: { slaveId: devId, endedAt: null } })
    note(`${String(live)} live run(s) on ${WORKER_NAME}`)
    return live === 0
  })

  console.log(
    `stage 6 -- set-capabilities printed: ` +
      JSON.stringify(runCli(['set-capabilities', '--slave', devId, '--capabilities', 'backend.api-design,qa.test-automation']).trim()),
  )
  // Stripped back to what it had: `set-capabilities` unions the projected role in, and this stage
  // is about the worker who PROVIDES a capability and does not hold its role.
  console.log(
    `stage 6 -- set-runtime-roles printed: ` +
      JSON.stringify(runCli(['set-runtime-roles', '--slave', devId, '--roles', 'backend,manager']).trim()),
  )
  const devBefore = await prisma.slave.findUniqueOrThrow({ where: { id: devId } })
  console.log(`stage 6 -- ${WORKER_NAME} before: runtimeRoles ${JSON.stringify(devBefore.runtimeRoles)}, capabilities ${JSON.stringify(devBefore.capabilities)}`)
  if (devBefore.runtimeRoles.includes('qa')) await fail('stage 6: the precondition failed -- Dev already holds the role its capability projects to')

  await prisma.task.create({
    data: {
      workspaceId,
      title: QA_TASK_TITLE,
      description: 'Sweep the endpoint with the automated suite.',
      status: 'ready',
      maxAttempts: 3,
      requiredRole: 'qa',
      requiredCapabilities: ['qa.test-automation'],
    },
  })
  // Stage 7's Needs section, put on the board in the same breath and deliberately never answered:
  // a capability nobody here provides and nobody here holds the role for, which exactly ONE persona
  // in the fixture catalog can cover. The Supervisor will offer to hire that persona; nobody
  // approves it, so the page has a real gap to show.
  await prisma.task.create({
    data: {
      workspaceId,
      title: EXPORT_TASK_TITLE,
      description: 'Build the nightly export the analytics dashboard reads.',
      status: 'ready',
      maxAttempts: 3,
      requiredRole: 'data',
      requiredCapabilities: ['data.pipelines'],
    },
  })

  const assigned = await waitUntil('the Supervisor to see a capability its own worker already provides', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.supervisorDecision.findFirst({
      where: { workspaceId, situationKind: 'capability_unstaffed', subjectId: 'qa.test-automation' },
    })
    note(row === null ? 'no capability_unstaffed(qa.test-automation) decision yet' : 'written')
    return row
  })
  console.log(`stage 6 -- the routine decision: ${describeDecision(assigned)}`)
  if (assigned.tier !== 'applied' || assigned.status !== 'applied') await fail(`stage 6: this one is routine and must not wait: ${describeDecision(assigned)}`)
  if (assigned.action.kind !== 'assign_capability') await fail(`stage 6: the offer is ${assigned.action.kind}, expected assign_capability`)
  const devAfter = await prisma.slave.findUniqueOrThrow({ where: { id: devId } })
  console.log(`stage 6 -- ${WORKER_NAME} after: runtimeRoles ${JSON.stringify(devAfter.runtimeRoles)}`)
  if (!devAfter.runtimeRoles.includes('qa')) await fail('stage 6: the role the capability projects to was not granted')
  if (!devAfter.runtimeRoles.includes('backend')) await fail('stage 6: a union took a role away')
  if (!devAfter.runtimeRoles.includes('manager')) await fail('stage 6: a union took a role away')

  // The negative that makes it a TIER and not a coincidence: the other gap raised in the same
  // breath is coverable only by hiring, and that one is still waiting for a person.
  const exportGap = await waitUntil('the Supervisor to offer the catalog for the gap only the catalog can fill', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.supervisorDecision.findFirst({
      where: { workspaceId, situationKind: 'capability_unstaffed', subjectId: 'data.pipelines' },
    })
    note(row === null ? 'no capability_unstaffed(data.pipelines) decision yet' : 'written')
    return row
  })
  console.log(`stage 6 -- the gap left open on purpose: ${describeDecision(exportGap)}`)
  if (exportGap.status !== 'pending' || exportGap.tier !== 'proposed') {
    await fail(`stage 6: a hire must WAIT even beside a routine assignment: ${describeDecision(exportGap)}`)
  }
  console.log(
    "stage 6 complete: the worker's own row was the evidence, so the role came back without anybody being asked -- and the gap " +
      'in the same tick that needs a NEW worker is still a question',
  )

  // The daemon has done its work. Stopped BEFORE the dev server starts so the two never race the
  // machine, and so stage 7 photographs rows that cannot move under it.
  await stopDaemon(daemon)
  const strayAfter = findRealDaemonPids()
  console.log(`orchestrator daemons still running after the stop: ${JSON.stringify(strayAfter)}`)
  if (strayAfter.length > 0) await fail(`stage 6: the gate's daemon is still running (pid ${strayAfter.join(', ')})`)

  // ============================================================================================
  // The real web shell, on a free port, loopback-bound.
  // ============================================================================================

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
    const textChunk = chunk.toString()
    nextOutput += textChunk
    process.stdout.write(`[next] ${textChunk}`)
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

  /** Bounded-waits for `locator` to become visible; a timeout routes through `fail`. */
  async function waitVisible(locator, description) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
    } catch {
      await fail(`timed out waiting for ${description} to become visible`)
    }
  }

  /** `page.goto`, retried ONCE and only on next dev's own manifest-race signature. */
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
  // Stage 7: who is here, what they can do, why -- and what is still missing.
  // ============================================================================================

  await gotoReliably(`${baseUrl}/w/${workspaceId}/organization`)
  await waitVisible(page.getByTestId('organization-rows'), 'the Organization table')

  // The fifth tab, on the page it names (E6): a tab strip that does not carry it is a page nobody
  // can reach without typing the URL.
  const tabHref = await page.getByTestId('project-tab-organization').getAttribute('href')
  console.log(`stage 7 -- the project strip's Organization tab points at ${JSON.stringify(tabHref)}`)
  if (tabHref !== `/w/${workspaceId}/organization`) await fail(`stage 7: the Organization tab points at ${String(tabHref)}`)

  await waitVisible(page.getByTestId(`organization-row-${hired.id}`), "the hired specialist's row")
  await waitVisible(page.getByTestId(`organization-row-${devId}`), "the worker who was already here")
  const why = await page.getByTestId(`organization-why-${hired.id}`).textContent()
  console.log(`stage 7: why ${hired.name} is here = ${JSON.stringify(why)}`)
  if (!String(why).includes('Application security')) await fail('stage 7: the row does not say why this worker was chosen')
  const chips = await page.getByTestId(`organization-row-${hired.id}`).getByTestId('capability-chip').allTextContents()
  if (!chips.includes('Application security')) await fail(`stage 7: the row shows ${JSON.stringify(chips)}`)
  // The LABEL is what a person reads; the key stays reachable on the chip's `title` (R5's rule).
  const chipTitles = await page.getByTestId(`organization-row-${hired.id}`).getByTestId('capability-chip').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('title')),
  )
  console.log(`stage 7 -- the hire's chips: ${JSON.stringify(chips)} with titles ${JSON.stringify(chipTitles)}`)
  if (!chipTitles.includes('security.application')) await fail(`stage 7: the raw key is not reachable on a chip: ${JSON.stringify(chipTitles)}`)

  // What is still missing: the gap stage 6 left open, with the offer nobody answered under it.
  await waitVisible(page.getByTestId('organization-needs'), 'the Needs section')
  const needTexts = await page.locator('[data-testid^="organization-need-"]').allTextContents()
  console.log(`stage 7 -- the needs on screen: ${JSON.stringify(needTexts)}`)
  const need = page.getByTestId('organization-need-data.pipelines')
  await waitVisible(need, 'the gap that was left open on purpose')
  const needText = (await need.textContent()) ?? ''
  // The seed row's own LABEL, read from the checked-in list rather than typed here twice.
  const dataLabel = CAPABILITY_SEED.find((record) => record.key === 'data.pipelines')?.label ?? ''
  if (!needText.includes(dataLabel)) {
    await fail(`stage 7: the need does not name ${JSON.stringify(dataLabel)}: ${JSON.stringify(needText)}`)
  }
  // R5 / `docs/ia.md` rule 3, asserted on the NEEDS section the way it already is on the advice
  // below (M47 final review, Minor 5). The summary a person reads here is written by `observe` in
  // the domain, and it used to print the dotted key inside an English sentence; the key stays on
  // the row's own testid, which is where this gate finds the section in the first place.
  for (const key of CAPABILITY_SEED.map((record) => record.key)) {
    if (needText.includes(key)) {
      await fail(`stage 7: the needs summary prints the raw key ${key} at a person: ${JSON.stringify(needText)}`)
    }
  }
  console.log(`stage 7 -- the need reads ${JSON.stringify(needText)} with no taxonomy key in it`)
  await waitVisible(need.getByTestId('supervisor-proposal'), 'the offer waiting under the gap')
  await waitVisible(need.getByTestId('supervisor-approve'), 'the Approve a person answers the offer with')
  // The negative beside it: a gap that was CLOSED is not still on the page.
  if ((await page.getByTestId('organization-need-security.application').count()) !== 0) {
    await fail('stage 7: the capability a hire already covers is still listed as a need')
  }

  await waitVisible(page.getByTestId('organization-advice'), "the caption over the persona's advice")
  await waitVisible(page.getByTestId('organization-hint'), 'the advisory edge from the persona')
  const hint = await page.getByTestId('organization-hint').first().textContent()
  console.log(`stage 7 -- the advice reads ${JSON.stringify(hint)}`)
  if (!String(hint).includes(BUILDER)) await fail('stage 7: the resolved hint does not name the persona it points at')
  // R5's whole authority: it is a sentence, and the key it resolved to is a data attribute a person
  // never reads on screen.
  const hintCapability = await page.getByTestId('organization-hint').first().getAttribute('data-capability')
  console.log(`stage 7 -- the advice resolved to ${JSON.stringify(hintCapability)}`)
  if (hintCapability !== 'backend.api-design') await fail(`stage 7: the hint carries ${String(hintCapability)}, expected backend.api-design`)
  if (String(hint).includes('backend.api-design')) await fail('stage 7: the advice prints a key at a person instead of a label')

  console.log(`gotoReliably retries this run: ${String(gotoRetries.length)}${gotoRetries.length === 0 ? '' : ` (${JSON.stringify(gotoRetries)})`}`)
  console.log(
    'PASS: a worker was chosen for what it can DO -- a persona\'s bullets became taxonomy keys, a plan written in capabilities ' +
      'derived its own dispatch roles, the Supervisor named the gap by capability and waited for a person, and the scheduler ' +
      'still matched one string',
  )
  exitCode = 0
} finally {
  // The vendor children and the processes first, then the rows they are named on.
  for (const state of daemons) {
    if (state.proc.exitCode === null && !state.exited) {
      state.proc.kill('SIGTERM')
      const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
      while (!state.exited && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
      if (!state.exited) state.proc.kill('SIGKILL')
    }
  }
  if (browser !== null) await browser.close().catch(() => {})
  if (nextServer !== null && nextServer.exitCode === null) {
    nextServer.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextServer.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextServer.exitCode === null) nextServer.kill('SIGKILL')
  }
  if (workspaceId !== null) {
    // Vendor children BEFORE the rows they are named on, `gate-m13-runtime`'s rule.
    const runs = await prisma.slaveRun.findMany({ where: { slave: { team: { workspaceId } } }, select: { pid: true } }).catch(() => [])
    for (const run of runs) {
      if (run.pid === null || !isAlive(run.pid)) continue
      try {
        process.kill(run.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    // `ExecutionEvent` has no FK to `Workspace` (M2's append-only log outlives entity lifecycles by
    // design), so it goes explicitly first; the workspace delete then cascades Team/Slave/Task/
    // SlaveRun/RunContext/SupervisorDecision.
    await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.slaveMessage.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  // The catalog rows belong to no workspace, so nothing above cascaded them. `CollaborationHint`
  // cascades on the template it belongs to; the operator's own capability key is a row this gate
  // wrote and nothing else references.
  await deleteGateTemplates('teardown').catch(() => {})
  await prisma.catalogImport.deleteMany({ where: { catalog: CATALOG_NAME } }).catch(() => {})
  await prisma.capability.deleteMany({ where: { key: OPERATOR_KEY } }).catch(() => {})
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  if (catalogRoot !== null) rmSync(catalogRoot, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
