// M50's own gate (spec R5, R7): a specialist is brought in for exactly ONE assignment, does it, and
// is released by the system itself -- with every run, message and thing it learnt still exactly
// where it was. One lifecycle, proved end to end against a real daemon, the real CLI and a real
// browser.
//
// Nine stages, each measuring one rule the milestone claims:
//   1. The checked-in fixture catalog is imported through the real CLI: two personas, one providing
//      `security.application` and one providing `qa.test-automation`, and neither naming the other
//      (this gate is about a lifecycle, and an advisory edge would be a second thing to assert).
//   2. A project with ONE worker and a goal; the planning run is answered from
//      `plan-graph-lifecycle` and the board comes back with four tasks -- one the worker can do,
//      one needing application security, and TWO needing test automation.
//   3. ONE assignment and ONE seat, side by side, out of one plan: the `security.application` gap
//      belongs to a single startable task, so the offer is `hire_from_catalog { temporary: true,
//      engagementTaskId }`; the `qa.test-automation` gap is two tasks' and so is an ordinary hire.
//      Both WAIT, and nothing is hired while they do.
//   4. A human approves the temporary one through the real `approve-decision`: the hired row reads
//      `lifecycle: ephemeral` with the auth task as its engagement -- and its rationale is the
//      sentence alone, because the column is the record now (R1).
//   5. It is dispatched by ROLE, works, and the assignment reaches `done`. The four kinds of
//      evidence it produced are counted here, before anything is released.
//   6. The next supervised pass raises `engagement_over` and applies `release_worker` ROUTINELY:
//      roles emptied, `releasedAt` written, the worktree gone from disk -- and all four counts
//      identical on the other side of it (R5).
//   7. The released worker is never picked again and never promoted: a FRESH gap for the same
//      capability names the TEMPLATE, not them, and ten more ticks leave `lifecycle` `ephemeral`
//      and `releasedAt` exactly where they were (R4).
//   8. The three by-hand paths, through real CLI subprocesses and in this order: a second
//      specialist (`Name 2`, because a released worker is never reused), a lifecycle moved by hand
//      (`set-lifecycle` -> `org.changed`), and a refusal (`release-worker` on a project worker).
//   9. In a real browser: the Organization tab's lifecycle chips and the `Released <date>` line
//      sorted last, the Overview's greyed card, and the Workforce slaves table's Lifecycle column.
//  10. Teardown, in FK order, on every exit path.
//
// NEVER A MODEL CALL. The daemon and the CLI are spawned with SLAVEOFAI_CLAUDE_BIN=node,
// SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m8-flow --plan-fixture plan-graph-lifecycle"
// and SLAVEOFAI_REQUIRE_FAKE_CLI=1; the browser half needs SLAVEOFAI_CLAUDE_BIN to name an
// executable under scripts/gate-fakes/ or the preflight refuses to start at all. `m8-flow` answers
// every `"verdict"` prompt with `review-approve`, which is what lets the ONE assignment reach
// `done` -- an engagement that never ends is one nothing can ever release.
//
// WHY THE SUPERVISOR IS SWITCHED OFF WHILE THE ENGAGEMENT RUNS (stage 4 to stage 5): `release_worker`
// is ROUTINE, so the very next tick after the assignment finishes applies it -- and this gate has to
// count the evidence on BOTH sides of that release. A daemon left supervising would decide when
// stage 5's four counts were taken. The column is put back before stage 6 asks for the supervised
// pass BY HAND, which is the pass this milestone is named for.
//
// THE FIXTURE CATALOG IS COPIED TO A TEMP DIRECTORY AND `git init`ed THERE, like m46's and m47's:
// this gate must never modify a file in this repository, and `git status` after a green run has to
// be empty.
//
// WHY THE DAEMON RUNS FIRST AND THE BROWSER LAST (m47's, m48's and m49's order): stage 9
// photographs rows the earlier stages created. The daemon is stopped -- and its absence re-checked
// with `findRealDaemonPids()` -- before `next dev` is spawned, so the two never race the machine.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: it boots its own `next dev`
// against `apps/web/.next` on a free port, and two of those corrupt the build cache for both.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m50-ephemeral
//
// Shape borrowed from `gate-m47-team-formation.mjs` file by file (`findFreePort`, `makeRepo`,
// `listTree`, `describeDecision`, `describeTask`, `deleteGateTemplates`, `preflightCleanup`,
// `dumpGateRows`, `fail`, `assertEqual`, `waitUntil`, `waitVisible`, `gotoReliably`, the temp-copy
// of the fixture catalog plus its `git init`, `loopbackChildEnv()`, the real `next dev` on a free
// port with the ready-wait on next's own bound-port line, the browser preflight refusal, `exitCode`
// starting at 1, and teardown in FK order inside a `finally`).

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
import { isAlive } from '../packages/control/dist/index.js'

const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 100
const DAEMON_PERIOD_MS = 500
const PLAN_TIMEOUT_MS = 180_000
const SUPERVISOR_TIMEOUT_MS = 180_000
const DISPATCH_TIMEOUT_MS = 180_000
const BOARD_TIMEOUT_MS = 420_000
/** `gate-m14-fidelity.mjs`'s own signature for next dev's torn `loadManifest` read. */
const MANIFEST_RACE_SIGNATURE = 'Unexpected end of JSON input'
const VIEWPORT = { width: 1440, height: 900 }

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

// Exact literals, never suffixed -- `preflightCleanup` removes whatever a prior crashed run left on
// these exact names, in the same FK order the `finally` block uses.
const CATALOG_NAME = 'catalog-m50'
const FIXTURE_CATALOG = join(repoRoot, 'scripts/fixtures', CATALOG_NAME)
const SECURITY_PERSONA = 'M50 Gate Security Reviewer'
const QA_PERSONA = 'M50 Gate Test Engineer'
const GATE_TEMPLATE_NAMES = [SECURITY_PERSONA, QA_PERSONA]
const WORKSPACE_NAME = 'M50 Gate Project'
const WORKER_NAME = 'Dev'
const GOAL = 'Ship the endpoint, with an authentication path somebody who does security has read and a sweep that keeps it honest.'
const AUTH_TASK_TITLE = 'M50 Gate Authentication Path'
const CORE_TASK_TITLE = 'M50 Gate Feature Core'
const SWEEP_TASK_TITLE = 'M50 Gate Test Sweep'
const REGRESSION_TASK_TITLE = 'M50 Gate Regression Suite'
const SECURITY_KEY = 'security.application'
const QA_KEY = 'qa.test-automation'
/** The second security task stage 7 puts on the board, to ask the gap again with the same key. */
const RERAISE_TASK_TITLE = 'M50 Gate Second Authentication Path'
/** Erratum E12: `filterFresh` blocks a situation key for COOLDOWN_MS (15 minutes). One hour back is
 *  comfortably past it and is written as a constant so the reason is readable. */
const COOLDOWN_BACKDATE_MS = 60 * 60 * 1000
/** The label `SLAVE_LIFECYCLE_LABEL` projects each raw value to, typed here rather than imported:
 *  stage 9 reads WORDS off a rendered page, and a gate that imported the same table the page
 *  renders from could not fail when both were renamed together. */
const LIFECYCLE_WORD = { permanent: 'Permanent', project: 'Project', ephemeral: 'Ephemeral' }

/** Asks the OS for a free TCP port. `next dev -p <port>` still auto-increments if something grabs
 *  it between this call and the spawn, so the ready-wait parses the ACTUAL bound port back out of
 *  next dev's own ready line. (`gate-m47-team-formation.mjs`, verbatim.) */
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
 *  into that worktree -- and stage 6 asserts that worktree is GONE from disk. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m50-repo-'))
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
 *  (`gate-m47-team-formation.mjs`'s helper.) */
const describeDecision = (row) =>
  JSON.stringify({
    id: row.id,
    situationKind: row.situationKind,
    subjectId: row.subjectId,
    tier: row.tier,
    status: row.status,
    decidedBy: row.decidedBy,
    modelCalled: row.modelCalled,
    resolvedAt: row.resolvedAt,
    action: row.action,
  })

/** A task row as this gate prints it -- the columns a lifecycle decision is made from. */
const describeTask = (row) =>
  `${row.title} [${row.status}] role=${JSON.stringify(row.requiredRole)} caps=${JSON.stringify(row.requiredCapabilities)}`

/** A worker row as this gate prints it -- the four M50 columns and the two sets a release empties. */
const describeSlave = (row) =>
  JSON.stringify({
    id: row.id,
    name: row.name,
    lifecycle: row.lifecycle,
    engagementTaskId: row.engagementTaskId,
    releasedAt: row.releasedAt,
    releaseReason: row.releaseReason,
    runtimeRoles: row.runtimeRoles,
    capabilities: row.capabilities,
    hiredFromTemplateId: row.hiredFromTemplateId,
    selectionRationale: row.selectionRationale,
  })

/** The templates this catalog owns, by `sourceId` -- never by name, which is exactly the thing an
 *  operator is free to change. */
const catalogTemplates = () =>
  prisma.slaveTemplate.findMany({ where: { sourceId: { startsWith: `${CATALOG_NAME}/` } }, orderBy: { sourceId: 'asc' } })

/** Every template this gate can have created: the imported ones, addressed by the `sourceId` prefix
 *  only this catalog writes, plus anything left on the two exact names. A `CompanySlave` holds a
 *  non-cascading reference, so the roster links go first; a `RunbookTemplate` is `SetNull` on its
 *  source template, so it goes before the template too (m47's own teardown rule). */
async function deleteGateTemplates(label) {
  const rows = await prisma.slaveTemplate.findMany({
    where: { OR: [{ sourceId: { startsWith: `${CATALOG_NAME}/` } }, { name: { in: GATE_TEMPLATE_NAMES } }] },
    select: { id: true, name: true },
  })
  if (rows.length === 0) return
  console.log(`${label}: removing ${String(rows.length)} gate template(s): ${JSON.stringify(rows.map((r) => r.name))}`)
  const ids = rows.map((r) => r.id)
  await prisma.companySlave.deleteMany({ where: { templateId: { in: ids } } }).catch(() => {})
  await prisma.runbookTemplate.deleteMany({ where: { sourceTemplateId: { in: ids } } }).catch(() => {})
  await prisma.slaveTemplate.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
}

/** Removes what a prior interrupted run left behind, in the same order the `finally` block uses. */
async function preflightCleanup() {
  const stale = await prisma.workspace.findUnique({ where: { name: WORKSPACE_NAME } })
  if (stale !== null) {
    console.log(`preflight: removing a leftover ${WORKSPACE_NAME} (${stale.id}) from an earlier interrupted run`)
    await removeWorkspaceRows(stale.id)
  }
  await deleteGateTemplates('preflight')
  const staleImports = await prisma.catalogImport.deleteMany({ where: { catalog: CATALOG_NAME } })
  if (staleImports.count > 0) console.log(`preflight: removing ${String(staleImports.count)} leftover CatalogImport row(s)`)
}

/**
 * Every row this gate's workspace owns, in FK order (the brief's own order): the append-only log
 * first (it has no FK to `Workspace` -- M2's log outlives entity lifecycles by design), then the
 * decisions and the knowledge, then the run-shaped rows, then the board, then the roster, then the
 * project itself. The `workspace.delete` at the end would cascade most of this; it is spelled out
 * so a crashed prior run leaves nothing behind even when the cascade is the thing that failed.
 */
async function removeWorkspaceRows(id) {
  await prisma.executionEvent.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.slaveMessage.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.supervisorDecision.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.memory.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.runContext.deleteMany({ where: { run: { slave: { team: { workspaceId: id } } } } }).catch(() => {})
  await prisma.checkpoint.deleteMany({ where: { run: { slave: { team: { workspaceId: id } } } } }).catch(() => {})
  await prisma.slaveRun.deleteMany({ where: { task: { workspaceId: id } } }).catch(() => {})
  await prisma.slaveRun.deleteMany({ where: { slave: { team: { workspaceId: id } } } }).catch(() => {})
  await prisma.taskDependency.deleteMany({ where: { task: { workspaceId: id } } }).catch(() => {})
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
  const daemonTails = daemons.map((d) => ({
    label: d.label,
    pid: d.proc.pid ?? null,
    exited: d.exited,
    output: d.output.length > 6_000 ? `…${d.output.slice(-6_000)}` : d.output,
  }))
  return JSON.stringify({ workspace, templates, daemonTails }, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m50-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ============================================================================================
  // Stage 0: the preflight. Refusals, never fallbacks.
  // ============================================================================================

  // Zero spend, ENFORCED (Decision 10, M32 item 7). Stages 2 to 7 drive a real daemon; without this
  // refusal a lost fake binary would reach a vendor account instead.
  const fakeClaude = process.env['SLAVEOFAI_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'SLAVEOFAI_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m50-ephemeral',
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
      `no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m50-ephemeral passes ` +
        '--env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m50-ephemeral`')
  }
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI} -- run \`npx tsc --build\` first`)
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)
  if (!existsSync(FIXTURE_CATALOG)) throw new Error(`the fixture catalog is missing at ${FIXTURE_CATALOG}`)
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- stage 9 reads a real rendered page, so set CHROMIUM_PATH to a ` +
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
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m50-ephemeral REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
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
      SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8-flow --plan-fixture plan-graph-lifecycle`,
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

  /** The same subprocess, for a line that is SUPPOSED to be refused: the status and both streams,
   *  never a throw. A refusal an operator reads is part of the product, so it is measured rather
   *  than caught. */
  const runCliExpectingRefusal = (args) => {
    try {
      const stdout = execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
        cwd: repoRoot,
        env: childEnv(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { status: 0, stdout, stderr: '' }
    } catch (error) {
      return { status: error.status ?? null, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
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

  /** The daemon this gate currently expects to be alive, or `null` between two of them. */
  let activeDaemon = null

  /** Polls `probe` until it returns something other than `null`/`undefined`/`false`. */
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
  // Stage 1: the fixture catalog, in a real git repository, through the real CLI.
  // ============================================================================================

  // The copy keeps the fixture's OWN directory name, because that name IS the catalog's name: with
  // no `--catalog`, the walk takes `basename(dir)` (M42 erratum E5), and that first segment is what
  // every `sourceId` asserted below is built from.
  catalogRoot = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m50-catalog-'))
  catalogDir = join(catalogRoot, CATALOG_NAME)
  cpSync(FIXTURE_CATALOG, catalogDir, { recursive: true })
  console.log(`catalog copied from ${FIXTURE_CATALOG} to ${catalogDir}:`)
  for (const line of listTree(catalogDir)) console.log(`  ${line}`)

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

  console.log(`stage 1 -- import-catalog printed:\n${runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate'])}`)

  const imported = await catalogTemplates()
  console.log(`stage 1 -- imported ${String(imported.length)} template(s): ${JSON.stringify(imported.map((row) => row.name))}`)
  if (imported.length !== 2) await fail(`stage 1: expected two templates, got ${String(imported.length)}`)

  const securityTemplate = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: SECURITY_PERSONA } })
  const qaTemplate = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: QA_PERSONA } })
  for (const row of [securityTemplate, qaTemplate]) {
    console.log(
      `stage 1 -- ${row.name}: sourceId ${String(row.sourceId)}, role ${JSON.stringify(row.role)}, revision ` +
        `${String(row.sourceRevision)}, licence ${String(row.sourceLicense)}, keys ${JSON.stringify(row.capabilityKeys)}, ` +
        `unresolved ${JSON.stringify(row.unresolvedCapabilities)}`,
    )
    if (row.sourceRevision !== head) {
      await fail(`stage 1: ${row.name} recorded revision ${String(row.sourceRevision)}, expected the temp repo's HEAD ${head}`)
    }
    if (row.sourceLicense !== 'MIT') await fail(`stage 1: ${row.name} recorded licence ${String(row.sourceLicense)}, expected MIT`)
  }
  await assertEqual(securityTemplate.capabilityKeys, [SECURITY_KEY], 'stage 1: the security persona provides exactly one key')
  await assertEqual(qaTemplate.capabilityKeys, [QA_KEY], 'stage 1: the QA persona provides exactly one key')
  await assertEqual(securityTemplate.unresolvedCapabilities, [], 'stage 1: the security persona left nothing unresolved')
  await assertEqual(qaTemplate.unresolvedCapabilities, [], 'stage 1: the QA persona left nothing unresolved')
  // Neither persona names the other, so this catalog creates no advisory edge at all: this gate is
  // about a lifecycle, and a `CollaborationHint` would be a second thing for it to explain.
  const hints = await prisma.collaborationHint.findMany({ where: { templateId: { in: [securityTemplate.id, qaTemplate.id] } } })
  await assertEqual(hints.length, 0, 'stage 1: neither persona names the other, so there is no advisory edge')
  console.log('stage 1 complete: two personas, one capability each, imported from a real repository through the real CLI')

  // ============================================================================================
  // Stage 2: a project with ONE worker, a goal, and a plan of four tasks.
  // ============================================================================================

  repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath,
      baseBranch: 'main',
      // OFF: an unmerged `done` task keeps its worktree, which is the thing stage 6 watches
      // disappear. `autoMerge` would collect it before the release ever ran.
      autoMerge: false,
      verifyCommands: ['true'],
      setupCommands: [],
      maxAttempts: 3,
    },
  })
  workspaceId = workspace.id
  console.log(`workspace ${workspaceId} (${WORKSPACE_NAME}), repo ${repoPath}, supervisorEnabled ${String(workspace.supervisorEnabled)}`)
  if (!workspace.supervisorEnabled) await fail('a new workspace starts with its Supervisor switched off')
  // Without this row every dispatch refuses with `invalid_provider` (M12 Task 8) and nothing runs.
  await prisma.providerConfiguration.create({ data: { workspaceId, kind: 'claude_code', settings: {} } })

  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  // The ONLY worker. It PROVIDES `backend.api-design` and is dispatchable as backend (so the plan's
  // first task really can start), as manager (so the planning run really can be staffed) and as
  // reviewer (so the ONE assignment this gate is about really can reach `done` -- a project with no
  // reviewer never finishes a task, and an engagement that never ends is one nothing can release).
  // It is dispatchable as nothing else, which is what makes stage 3's two gaps facts about this
  // project rather than fixtures. Its title deliberately does not read as a role.
  const dev = await prisma.slave.create({
    data: {
      teamId: team.id,
      name: WORKER_NAME,
      role: 'Senior Engineer',
      runtimeRoles: ['backend', 'manager', 'reviewer'],
      capabilities: ['backend.api-design'],
    },
  })
  const devId = dev.id
  console.log(`slave ${devId} (${WORKER_NAME}): ${describeSlave(dev)}`)
  await assertEqual(dev.lifecycle, 'project', 'stage 2: a worker created by hand is a project worker')

  console.log(`stage 2 -- set-goal printed: ${JSON.stringify(runCli(['set-goal', '--workspace', workspaceId, '--goal', GOAL]).trim())}`)

  const daemon = spawnDaemon('daemon')

  // Waited on the EVENT rather than on the board: `concludePlanning` creates the whole graph in one
  // transaction and appends `workspace.plan_created` after it commits.
  await waitUntil('the plan to land', PLAN_TIMEOUT_MS, async (note) => {
    const row = await prisma.executionEvent.findFirst({ where: { workspaceId, type: 'workspace_plan_created' }, orderBy: { seq: 'asc' } })
    note(row === null ? 'no workspace.plan_created event yet' : 'landed')
    return row
  })
  const planned = await board()
  console.log(`stage 2 -- board (${String(planned.length)}):\n  ${planned.map(describeTask).join('\n  ')}`)
  if (planned.length !== 4) await fail(`stage 2: the plan produced ${String(planned.length)} tasks, expected 4`)

  const auth = await prisma.task.findFirstOrThrow({ where: { workspaceId, title: AUTH_TASK_TITLE } })
  const core = await prisma.task.findFirstOrThrow({ where: { workspaceId, title: CORE_TASK_TITLE } })
  const sweep = await prisma.task.findFirstOrThrow({ where: { workspaceId, title: SWEEP_TASK_TITLE } })
  const regression = await prisma.task.findFirstOrThrow({ where: { workspaceId, title: REGRESSION_TASK_TITLE } })
  await assertEqual(auth.requiredCapabilities, [SECURITY_KEY], 'stage 2: the authentication task asks for application security')
  if (auth.requiredRole !== 'security') await fail(`stage 2: the authentication task's derived role is ${String(auth.requiredRole)}, expected security`)
  await assertEqual(core.requiredCapabilities, ['backend.api-design'], 'stage 2: the core task asks for what the one worker provides')
  await assertEqual(sweep.requiredCapabilities, [QA_KEY], 'stage 2: the sweep asks for test automation')
  await assertEqual(regression.requiredCapabilities, [QA_KEY], 'stage 2: the regression suite asks for the SAME capability')
  console.log(
    'stage 2 complete: one plan, four tasks -- one gap that belongs to a single startable task and one that two tasks share',
  )

  // ============================================================================================
  // Stage 3: ONE assignment and ONE seat, side by side, out of one plan.
  // ============================================================================================

  const securityGap = await waitUntil('the Supervisor to name the security gap', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.supervisorDecision.findFirst({
      where: { workspaceId, situationKind: 'capability_unstaffed', subjectId: SECURITY_KEY },
      orderBy: { createdAt: 'asc' },
    })
    note(row === null ? `no capability_unstaffed(${SECURITY_KEY}) decision yet` : 'written')
    return row
  })
  const qaGap = await waitUntil('the Supervisor to name the QA gap', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.supervisorDecision.findFirst({
      where: { workspaceId, situationKind: 'capability_unstaffed', subjectId: QA_KEY },
      orderBy: { createdAt: 'asc' },
    })
    note(row === null ? `no capability_unstaffed(${QA_KEY}) decision yet` : 'written')
    return row
  })
  console.log(`stage 3 -- the security gap: ${describeDecision(securityGap)}`)
  console.log(`stage 3 -- the security situation: ${JSON.stringify(securityGap.situation)}`)
  console.log(`stage 3 -- the QA gap: ${describeDecision(qaGap)}`)
  console.log(`stage 3 -- the QA situation: ${JSON.stringify(qaGap.situation)}`)

  if (securityGap.tier !== 'proposed' || securityGap.status !== 'pending') {
    await fail(`stage 3: a hire must WAIT for a person: ${describeDecision(securityGap)}`)
  }
  if (securityGap.action.kind !== 'hire_from_catalog') await fail(`stage 3: the security offer is ${securityGap.action.kind}: ${describeDecision(securityGap)}`)
  if (securityGap.action.templateId !== securityTemplate.id) {
    await fail(`stage 3: the security offer names template ${String(securityGap.action.templateId)}, expected ${securityTemplate.id}: ${describeDecision(securityGap)}`)
  }
  if (securityGap.action.temporary !== true) {
    await fail(`stage 3: one startable task needs this capability, so the offer must be temporary: ${describeDecision(securityGap)}`)
  }
  if (securityGap.action.engagementTaskId !== auth.id) {
    await fail(`stage 3: the engagement is ${String(securityGap.action.engagementTaskId)}, expected the authentication task ${auth.id}: ${describeDecision(securityGap)}`)
  }
  if (!String(securityGap.action.rationale).includes('one assignment')) {
    await fail(`stage 3: the rationale does not say this is one assignment: ${describeDecision(securityGap)}`)
  }

  // The negative that makes `temporary` a MEASUREMENT and not a constant: the same verb, from the
  // same catalog, chosen by the same search, in the same project -- and not temporary, because two
  // startable tasks need it.
  if (qaGap.tier !== 'proposed' || qaGap.status !== 'pending') {
    await fail(`stage 3: a hire must WAIT for a person: ${describeDecision(qaGap)}`)
  }
  if (qaGap.action.kind !== 'hire_from_catalog') await fail(`stage 3: the QA offer is ${qaGap.action.kind}: ${describeDecision(qaGap)}`)
  if (qaGap.action.templateId !== qaTemplate.id) {
    await fail(`stage 3: the QA offer names template ${String(qaGap.action.templateId)}, expected ${qaTemplate.id}: ${describeDecision(qaGap)}`)
  }
  if (qaGap.action.temporary !== false) {
    await fail(`stage 3: two startable tasks need this capability, so the offer is a seat and not an assignment: ${describeDecision(qaGap)}`)
  }
  if (qaGap.action.engagementTaskId !== null) {
    await fail(`stage 3: an ordinary hire names no engagement: ${describeDecision(qaGap)}`)
  }
  if (String(qaGap.action.rationale).includes('one assignment')) {
    await fail(`stage 3: the ordinary hire's rationale claims one assignment: ${describeDecision(qaGap)}`)
  }

  const rosterWhilePending = await prisma.slave.count({ where: { team: { workspaceId } } })
  await assertEqual(rosterWhilePending, 1, 'stage 3: nobody is hired while two proposals wait')
  console.log(
    'stage 3 complete: one plan produced one temporary proposal and one ordinary one, differing in `temporary` alone -- and ' +
      'both are still questions',
  )

  // ============================================================================================
  // Stage 4: a person approves the temporary one, through the real `approve-decision`.
  // ============================================================================================

  console.log(`stage 4 -- approve-decision printed: ${JSON.stringify(runCli(['approve-decision', '--id', securityGap.id]).trim())}`)

  // The Supervisor is switched off from HERE (see the header): `release_worker` is routine, so the
  // first tick after the assignment finishes would apply it -- and stage 5 has to count this
  // worker's evidence while it is still here. Stage 6 puts the column back and asks for the
  // supervised pass by hand.
  await prisma.workspace.update({ where: { id: workspaceId }, data: { supervisorEnabled: false } })
  console.log('stage 4 -- the Supervisor is switched off while the engagement runs, so stage 5 can count before stage 6 releases')

  const approved = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: securityGap.id } })
  console.log(`stage 4 -- the decision after approval: ${describeDecision(approved)}`)
  if (approved.status !== 'approved') await fail(`stage 4: the approved decision is ${approved.status}, expected approved`)

  const hired = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId }, hiredFromTemplateId: securityTemplate.id } })
  const hiredId = hired.id
  console.log(`stage 4 -- the hire: ${describeSlave(hired)}`)
  await assertEqual(hired.lifecycle, 'ephemeral', 'stage 4: the hire is a specialist brought in for one assignment')
  await assertEqual(hired.engagementTaskId, auth.id, 'stage 4: the engagement is the one task the gap belonged to')
  if (hired.createdAt === null) await fail('stage 4: the hire has no createdAt')
  if (hired.releasedAt !== null) await fail(`stage 4: a fresh hire is not released: ${describeSlave(hired)}`)
  if (!hired.capabilities.includes(SECURITY_KEY)) await fail(`stage 4: the hire does not provide what it was hired for: ${describeSlave(hired)}`)
  if (!hired.runtimeRoles.includes('security')) await fail(`stage 4: the hire is not dispatchable as security: ${describeSlave(hired)}`)
  if (hired.hiredFromTemplateId !== securityTemplate.id) await fail(`stage 4: the hire does not name the template it came from: ${describeSlave(hired)}`)
  if (hired.selectionRationale === null || hired.selectionRationale === '') await fail('stage 4: nothing says why this worker is here')
  // R1: the suffix `(asked for as a temporary specialist)` is GONE. The column is the record, and a
  // sentence that repeated it would be the system saying twice what it can now say once.
  if (hired.selectionRationale.includes('asked for as a temporary specialist')) {
    await fail(`stage 4: the rationale still carries the pre-M50 suffix: ${JSON.stringify(hired.selectionRationale)}`)
  }
  await assertEqual(await prisma.slave.count({ where: { team: { workspaceId } } }), 2, 'stage 4: exactly one worker arrived')
  console.log('stage 4 complete: a person approved, and the row itself says this worker is here for one assignment')

  // ============================================================================================
  // Stage 5: dispatched by ROLE, worked, finished -- and the evidence counted.
  // ============================================================================================

  const authRun = await waitUntil('the authentication task to be dispatched to the specialist BY ROLE', DISPATCH_TIMEOUT_MS, async (note) => {
    const row = await prisma.slaveRun.findFirst({ where: { slaveId: hiredId, taskId: auth.id }, orderBy: { startedAt: 'asc' } })
    note(row === null ? 'no run for the authentication task on the hire yet' : `run ${row.id}`)
    return row
  })
  console.log(`stage 5 -- run ${authRun.id} started for ${AUTH_TASK_TITLE} on ${hired.name}`)

  await waitUntil(`"${AUTH_TASK_TITLE}" to be worked, verified, reviewed and done`, BOARD_TIMEOUT_MS, async (note) => {
    const rows = await board()
    note(rows.map((row) => `${row.title}=${row.status}`).join(', '))
    return rows.find((row) => row.id === auth.id)?.status === 'done'
  })
  console.log(`stage 5 -- board after the engagement:\n  ${(await board()).map(describeTask).join('\n  ')}`)

  // The daemon's work is done: the plan is written, the specialist was dispatched by role, and the
  // one assignment it was brought in for is finished. Stopped HERE so the counts below cannot move
  // under a tick, and so the browser half never races it for the machine.
  await stopDaemon(daemon)
  const strayAfterWork = findRealDaemonPids()
  console.log(`orchestrator daemons still running after the stop: ${JSON.stringify(strayAfterWork)}`)
  if (strayAfterWork.length > 0) await fail(`stage 5: the gate's daemon is still running (pid ${strayAfterWork.join(', ')})`)

  const runAfterWork = await prisma.slaveRun.findUniqueOrThrow({ where: { id: authRun.id } })
  console.log(`stage 5 -- the run's worktree: ${JSON.stringify(runAfterWork.worktreePath)}`)
  if (runAfterWork.worktreePath === null) await fail('stage 5: the run recorded no worktree, so stage 6 has nothing to watch disappear')
  const worktreePath = runAfterWork.worktreePath
  if (!existsSync(worktreePath)) await fail(`stage 5: the recorded worktree ${worktreePath} is not on disk`)

  /**
   * R5's whole claim, as four numbers taken BEFORE anything is released.
   *
   * The events are bounded by the highest `seq` this worker's name is on today, and deliberately:
   * the release itself APPENDS a `slave.released` event carrying this slave id, so an unbounded
   * count would move by one for a reason that is not a loss. What must not change is the rows that
   * already exist -- every event this worker produced is still readable afterwards -- and that is
   * exactly what a count over `seq <= <the maximum before the release>` measures.
   */
  const runIdsBefore = (await prisma.slaveRun.findMany({ where: { slaveId: hiredId }, select: { id: true } })).map((row) => row.id)
  const lastEvent = await prisma.executionEvent.findFirst({
    where: { workspaceId, slaveId: hiredId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  if (lastEvent === null) await fail('stage 5: this worker produced no events at all, so there is nothing for a release to keep')
  const eventCeiling = lastEvent.seq
  const evidence = async () => ({
    runs: await prisma.slaveRun.count({ where: { slaveId: hiredId } }),
    contexts: await prisma.runContext.count({ where: { run: { slaveId: hiredId } } }),
    events: await prisma.executionEvent.count({ where: { workspaceId, slaveId: hiredId, seq: { lte: eventCeiling } } }),
    memories: await prisma.memory.count({ where: { OR: [{ slaveId: hiredId }, { runId: { in: runIdsBefore } }] } }),
  })
  const before = await evidence()
  console.log(`stage 5 -- the evidence this worker produced, before the release: ${JSON.stringify(before)}`)
  if (before.runs < 1) await fail(`stage 5: this worker has no runs: ${JSON.stringify(before)}`)
  if (before.contexts < 1) await fail(`stage 5: this worker's runs recorded no context: ${JSON.stringify(before)}`)
  if (before.events < 1) await fail(`stage 5: this worker is on no event: ${JSON.stringify(before)}`)
  if (before.memories < 1) await fail(`stage 5: this worker's runs left nothing this project learnt: ${JSON.stringify(before)}`)
  console.log('stage 5 complete: the specialist was matched on one string, did the one thing it was brought in for, and left a record')

  // ============================================================================================
  // Stage 6: the next supervised pass releases it -- routinely.
  // ============================================================================================

  await prisma.workspace.update({ where: { id: workspaceId }, data: { supervisorEnabled: true } })
  console.log(`stage 6 -- supervise printed:\n${runCli(['supervise', '--workspace', workspaceId])}`)

  const release = await waitUntil('the Supervisor to notice the engagement is over', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.supervisorDecision.findFirst({
      where: { workspaceId, situationKind: 'engagement_over', subjectId: hiredId },
      orderBy: { createdAt: 'asc' },
    })
    note(row === null ? 'no engagement_over decision yet' : row.status)
    return row
  })
  console.log(`stage 6 -- the decision: ${describeDecision(release)}`)
  console.log(`stage 6 -- the situation it was made about: ${JSON.stringify(release.situation)}`)
  if (release.action.kind !== 'release_worker') await fail(`stage 6: the action is ${release.action.kind}, expected release_worker: ${describeDecision(release)}`)
  if (release.action.slaveId !== hiredId) await fail(`stage 6: the action names ${String(release.action.slaveId)}, expected ${hiredId}`)
  if (release.tier !== 'applied' || release.status !== 'applied') {
    await fail(`stage 6: this one is ROUTINE and must not wait for anybody: ${describeDecision(release)}`)
  }
  // An auto-applied decision is terminal at birth: it was never `pending`, so nobody ever resolved
  // it and `resolvedAt` is null. A row with a resolution is a row a person answered.
  if (release.resolvedAt !== null) {
    await fail(`stage 6: an applied decision was never pending, so nothing resolved it: ${describeDecision(release)}`)
  }

  const released = await prisma.slave.findUniqueOrThrow({ where: { id: hiredId } })
  console.log(`stage 6 -- the worker after the release: ${describeSlave(released)}`)
  if (released.releasedAt === null) await fail(`stage 6: the worker was not released: ${describeSlave(released)}`)
  if (released.releaseReason === null || released.releaseReason.trim() === '') {
    await fail(`stage 6: the release recorded no reason: ${describeSlave(released)}`)
  }
  await assertEqual(released.runtimeRoles, [], 'stage 6: nothing dispatches a released worker again')
  // The two columns a release does NOT touch (Task 3's hand-off): the record of what this worker
  // was and what it was here for outlives the engagement.
  await assertEqual(released.lifecycle, 'ephemeral', 'stage 6: a release does not rewrite the lifecycle')
  await assertEqual(released.engagementTaskId, auth.id, 'stage 6: a release does not forget the assignment')
  const releasedAtFirst = released.releasedAt.toISOString()

  const releaseEvents = await prisma.executionEvent.findMany({
    where: { workspaceId, type: 'slave_released', slaveId: hiredId },
    orderBy: { seq: 'asc' },
  })
  console.log(`stage 6 -- slave.released events: ${JSON.stringify(releaseEvents.map((row) => ({ actor: row.actor, payload: row.payload })))}`)
  if (releaseEvents.length !== 1) await fail(`stage 6: expected exactly one slave.released event, got ${String(releaseEvents.length)}`)
  await assertEqual(releaseEvents[0].payload.worktreesCollected, 1, 'stage 6: the release collected the ONE worktree this worker left')
  // A tick's release is the machine's own housekeeping, not somebody's button press (Task 3's
  // hand-off: the CLI's release is `human`, a supervised one is `system`).
  await assertEqual(releaseEvents[0].actor, 'system', 'stage 6: a release nobody asked for is recorded as the system\'s')

  console.log(`stage 6 -- the worktree ${worktreePath} on disk after the release: ${String(existsSync(worktreePath))}`)
  if (existsSync(worktreePath)) await fail(`stage 6: the worktree ${worktreePath} is still on disk`)
  const runAfterRelease = await prisma.slaveRun.findUniqueOrThrow({ where: { id: authRun.id } })
  await assertEqual(runAfterRelease.worktreePath, null, 'stage 6: the run no longer claims a worktree that is gone')

  const after = await evidence()
  console.log(`stage 6 -- the evidence this worker produced, after the release: ${JSON.stringify(after)}`)
  // Named one by one, so a failure says which KIND of evidence went missing rather than that a
  // JSON blob changed.
  await assertEqual(after.runs, before.runs, 'stage 6: every run this worker made is still there')
  await assertEqual(after.contexts, before.contexts, 'stage 6: every prompt this worker was given is still there')
  await assertEqual(after.events, before.events, 'stage 6: every event this worker is on is still there')
  await assertEqual(after.memories, before.memories, 'stage 6: everything this project learnt from it is still there')
  console.log(
    'stage 6 complete: the system released the specialist by itself -- roles emptied, worktree gone from disk, and every run, ' +
      'context, event and memory exactly where it was',
  )

  // ============================================================================================
  // Stage 7: never picked again, never promoted.
  // ============================================================================================

  const reraise = await prisma.task.create({
    data: {
      workspaceId,
      title: RERAISE_TASK_TITLE,
      description: 'A second endpoint needs the same read, and the specialist who did the first one has gone.',
      status: 'ready',
      maxAttempts: 3,
      requiredRole: 'security',
      requiredCapabilities: [SECURITY_KEY],
    },
  })
  console.log(`stage 7 -- a fresh startable task for the same capability: ${describeTask(reraise)}`)

  // Erratum E12: `filterFresh` blocks a situation key for COOLDOWN_MS after the decision about it
  // stopped being open, so the gap for this key cannot be asked again within fifteen minutes of
  // stage 4's approval. Both timestamps move, and both moves are printed.
  const staleDecision = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: securityGap.id } })
  const backdatedCreatedAt = new Date(staleDecision.createdAt.getTime() - COOLDOWN_BACKDATE_MS)
  const backdatedResolvedAt =
    staleDecision.resolvedAt === null ? null : new Date(staleDecision.resolvedAt.getTime() - COOLDOWN_BACKDATE_MS)
  console.log(
    `stage 7 -- back-dating the answered gap by ${String(COOLDOWN_BACKDATE_MS)}ms: createdAt ` +
      `${staleDecision.createdAt.toISOString()} -> ${backdatedCreatedAt.toISOString()}, resolvedAt ` +
      `${staleDecision.resolvedAt === null ? 'null' : staleDecision.resolvedAt.toISOString()} -> ` +
      `${backdatedResolvedAt === null ? 'null' : backdatedResolvedAt.toISOString()}`,
  )
  const moved = await prisma.supervisorDecision.updateMany({
    where: { id: securityGap.id },
    data: { createdAt: backdatedCreatedAt, ...(backdatedResolvedAt === null ? {} : { resolvedAt: backdatedResolvedAt }) },
  })
  await assertEqual(moved.count, 1, 'stage 7: exactly one decision was back-dated past the cooldown')

  console.log(`stage 7 -- supervise printed:\n${runCli(['supervise', '--workspace', workspaceId])}`)
  const reraised = await waitUntil('the gap for the same capability to be asked again', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.supervisorDecision.findFirst({
      where: { workspaceId, situationKind: 'capability_unstaffed', subjectId: SECURITY_KEY, id: { not: securityGap.id } },
      orderBy: { createdAt: 'desc' },
    })
    note(row === null ? `no second capability_unstaffed(${SECURITY_KEY}) decision yet` : 'written')
    return row
  })
  console.log(`stage 7 -- the second offer for the same capability: ${describeDecision(reraised)}`)
  if (reraised.action.kind !== 'hire_from_catalog') {
    await fail(`stage 7: the offer is ${reraised.action.kind} -- a released worker must never be picked again: ${describeDecision(reraised)}`)
  }
  if (reraised.action.templateId !== securityTemplate.id) {
    await fail(`stage 7: the offer names ${String(reraised.action.templateId)}, expected the TEMPLATE ${securityTemplate.id}: ${describeDecision(reraised)}`)
  }
  await assertEqual(reraised.action.name, SECURITY_PERSONA, 'stage 7: the offer names the persona, not the worker who has gone')
  if (JSON.stringify(reraised.action).includes(hiredId)) {
    await fail(`stage 7: the offer names the released worker's id: ${describeDecision(reraised)}`)
  }

  for (let n = 1; n <= 10; n += 1) {
    runCli(['tick', '--workspace', workspaceId])
  }
  console.log('stage 7 -- ten more ticks ran')
  const stillReleased = await prisma.slave.findUniqueOrThrow({ where: { id: hiredId } })
  console.log(`stage 7 -- the released worker after ten more ticks: ${describeSlave(stillReleased)}`)
  await assertEqual(stillReleased.lifecycle, 'ephemeral', 'stage 7: nothing promotes a worker automatically')
  await assertEqual(stillReleased.releasedAt?.toISOString() ?? null, releasedAtFirst, 'stage 7: the release timestamp did not move')
  await assertEqual(stillReleased.runtimeRoles, [], 'stage 7: ten ticks gave a released worker no role back')
  console.log('stage 7 complete: the gap was asked again and named the CATALOG; the worker who has gone was neither re-picked nor promoted')

  // ============================================================================================
  // Stage 8: the three by-hand paths, in the order that makes each of them measurable.
  //
  // 8b consumes the FIRST ephemeral worker -- moving it to `project` is the only way to prove
  // `set-lifecycle` really clears the engagement and the release -- and the browser still has to
  // photograph a live `Ephemeral` chip and a `Released <date>` line, which is what 8a's second
  // specialist provides. The order also decides the `Name 2` assertion: `hireFromTemplate`'s reuse
  // read requires `releasedAt: null`, so 8a must run while the FIRST worker is still released.
  // ============================================================================================

  const hireOutput = runCli([
    'hire',
    '--workspace', workspaceId,
    '--template', securityTemplate.id,
    '--why', 'a second read of the same path',
    '--temporary',
    '--for-task', auth.id,
  ]).trim()
  console.log(`stage 8a -- hire printed: ${JSON.stringify(hireOutput)}`)
  if (!hireOutput.startsWith('hired ')) await fail(`stage 8a: a released worker must never be reused: ${JSON.stringify(hireOutput)}`)
  if (hireOutput.startsWith('reused ')) await fail(`stage 8a: the released worker was reused: ${JSON.stringify(hireOutput)}`)
  if (!hireOutput.includes(`for one assignment (${auth.id})`)) {
    await fail(`stage 8a: the line does not name the one assignment: ${JSON.stringify(hireOutput)}`)
  }
  const second = await prisma.slave.findFirstOrThrow({
    where: { team: { workspaceId }, hiredFromTemplateId: securityTemplate.id, id: { not: hiredId } },
  })
  const secondId = second.id
  console.log(`stage 8a -- the second specialist: ${describeSlave(second)}`)
  // The released worker still holds the first name, because nothing deleted it.
  await assertEqual(second.name, `${SECURITY_PERSONA} 2`, 'stage 8a: the new worker is named beside the one who has gone')
  await assertEqual(second.lifecycle, 'ephemeral', 'stage 8a: a hand hire for one assignment is ephemeral too')
  await assertEqual(second.engagementTaskId, auth.id, 'stage 8a: the assignment is the task the operator named')

  const releaseOutput = runCli(['release-worker', '--slave', secondId, '--reason', 'the engagement is over']).trim()
  console.log(`stage 8a -- release-worker printed: ${JSON.stringify(releaseOutput)}`)
  // The whole line, verbatim: the NAME read back after the write, the `plural` helper's own count
  // (this worker never ran, so it left no worktree at all), and the promise R5 is named for.
  await assertEqual(
    releaseOutput,
    `released ${SECURITY_PERSONA} 2 (${secondId}): runtime roles cleared, 0 worktrees collected; ` +
      'every run, message and memory it produced is untouched',
    'stage 8a: what a person reads when they release somebody by hand',
  )
  const secondReleased = await prisma.slave.findUniqueOrThrow({ where: { id: secondId } })
  console.log(`stage 8a -- the second specialist after its release: ${describeSlave(secondReleased)}`)
  await assertEqual(secondReleased.runtimeRoles, [], 'stage 8a: the by-hand release empties the runtime roles too')
  if (secondReleased.releasedAt === null) await fail(`stage 8a: the by-hand release wrote no timestamp: ${describeSlave(secondReleased)}`)

  const lifecycleOutput = runCli(['set-lifecycle', '--slave', hiredId, '--lifecycle', 'project']).trim()
  console.log(`stage 8b -- set-lifecycle printed: ${JSON.stringify(lifecycleOutput)}`)
  await assertEqual(
    lifecycleOutput,
    `${hiredId} moved from ${LIFECYCLE_WORD.ephemeral} to ${LIFECYCLE_WORD.project}`,
    'stage 8b: what a person reads when they move a lifecycle by hand',
  )
  const promoted = await prisma.slave.findUniqueOrThrow({ where: { id: hiredId } })
  console.log(`stage 8b -- the worker after the move: ${describeSlave(promoted)}`)
  await assertEqual(promoted.lifecycle, 'project', 'stage 8b: the column moved')
  await assertEqual(promoted.engagementTaskId, null, 'stage 8b: a worker that is no longer temporary has no one assignment')
  await assertEqual(promoted.releasedAt, null, 'stage 8b: leaving ephemeral clears the release with it')
  await assertEqual(promoted.releaseReason, null, 'stage 8b: and the sentence it was released with')
  // R4 restores NOTHING: the roles are a person's own call through `set-runtime-roles`.
  await assertEqual(promoted.runtimeRoles, [], 'stage 8b: nothing gave the roles back')
  const changedEvents = await prisma.executionEvent.findMany({
    where: { workspaceId, type: 'org_changed', slaveId: hiredId },
    orderBy: { seq: 'asc' },
  })
  const lifecycleChanges = changedEvents.filter((row) => row.payload.field === 'lifecycle')
  console.log(`stage 8b -- org.changed(lifecycle) events: ${JSON.stringify(lifecycleChanges.map((row) => ({ actor: row.actor, payload: row.payload })))}`)
  if (lifecycleChanges.length !== 1) await fail(`stage 8b: expected exactly one org.changed lifecycle event, got ${String(lifecycleChanges.length)}`)
  await assertEqual(
    { entity: lifecycleChanges[0].payload.entity, field: lifecycleChanges[0].payload.field, from: lifecycleChanges[0].payload.from, to: lifecycleChanges[0].payload.to },
    { entity: 'slave', field: 'lifecycle', from: 'ephemeral', to: 'project' },
    'stage 8b: the log says exactly what moved',
  )

  const devBefore = await prisma.slave.findUniqueOrThrow({ where: { id: devId } })
  const refusal = runCliExpectingRefusal(['release-worker', '--slave', devId, '--reason', 'x'])
  console.log(`stage 8c -- release-worker on a project worker: status ${String(refusal.status)}, stdout ${JSON.stringify(refusal.stdout)}, stderr ${JSON.stringify(refusal.stderr)}`)
  if (refusal.status === 0) await fail('stage 8c: releasing a project worker was allowed')
  if (!refusal.stderr.includes('not a specialist brought in for one assignment')) {
    await fail(`stage 8c: the refusal does not say why: ${JSON.stringify(refusal.stderr)}`)
  }
  if (refusal.stdout.trim() !== '') await fail(`stage 8c: a refusal wrote to stdout: ${JSON.stringify(refusal.stdout)}`)
  const devAfter = await prisma.slave.findUniqueOrThrow({ where: { id: devId } })
  await assertEqual(devAfter.runtimeRoles, devBefore.runtimeRoles, 'stage 8c: a refused release changed nothing')
  await assertEqual(devAfter.releasedAt, null, 'stage 8c: and released nobody')
  console.log(
    'stage 8 complete: a second specialist was hired beside the one who had gone, a lifecycle moved by hand cleared the ' +
      'engagement and the release, and releasing a project worker is refused in words',
  )

  // ============================================================================================
  // The real web shell, on a free port, loopback-bound.
  // ============================================================================================

  const strayBeforeNext = findRealDaemonPids()
  console.log(`orchestrator daemons running before next dev: ${JSON.stringify(strayBeforeNext)}`)
  if (strayBeforeNext.length > 0) await fail(`stage 9: an orchestrator daemon is running (pid ${strayBeforeNext.join(', ')})`)

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
  // Stage 9: who is temporary, and who has gone -- on three real pages.
  // ============================================================================================

  // Nobody approved the QA proposal, so nobody was ever hired for it: the negative that keeps the
  // page's counts honest.
  const qaHires = await prisma.slave.count({ where: { team: { workspaceId }, hiredFromTemplateId: qaTemplate.id } })
  await assertEqual(qaHires, 0, 'stage 9: the proposal nobody answered hired nobody')

  await gotoReliably(`${baseUrl}/w/${workspaceId}/organization`)
  await waitVisible(page.getByTestId('organization-rows'), 'the Organization table')

  const rowIds = await page
    .locator('[data-testid^="organization-row-"]')
    .evaluateAll((nodes) => nodes.map((node) => (node.getAttribute('data-testid') ?? '').replace('organization-row-', '')))
  console.log(`stage 9 -- the Organization rows, in order: ${JSON.stringify(rowIds)}`)
  await assertEqual(rowIds.length, 3, 'stage 9: three workers, and a released one is not hidden')
  if (!rowIds.includes(devId) || !rowIds.includes(hiredId) || !rowIds.includes(secondId)) {
    await fail(`stage 9: the table is missing one of the three workers: ${JSON.stringify(rowIds)}`)
  }
  // The QA persona's NAME is legitimately on this page -- under "what this project still needs", as
  // the offer nobody has answered. What must be absent is a WORKER, so the absence is asserted over
  // the roster table alone, and the offer beside it is asserted as the positive that makes it mean
  // something: a gap nobody filled is still a gap, and the page says so.
  const rosterText = (await page.getByTestId('organization-rows').textContent()) ?? ''
  if (rosterText.includes(QA_PERSONA)) {
    await fail(`stage 9: the QA persona nobody hired is on the roster: ${JSON.stringify(rosterText)}`)
  }
  await waitVisible(page.getByTestId(`organization-need-${QA_KEY}`), 'the gap nobody answered')
  await waitVisible(
    page.getByTestId(`organization-need-${QA_KEY}`).getByTestId('supervisor-proposal'),
    'the offer still waiting under the QA gap',
  )

  const lifecycleOf = async (slaveId) => (await page.getByTestId(`organization-lifecycle-${slaveId}`).textContent())?.trim() ?? ''
  const devWord = await lifecycleOf(devId)
  const firstWord = await lifecycleOf(hiredId)
  const secondWord = await lifecycleOf(secondId)
  console.log(`stage 9 -- the lifecycle chips: ${JSON.stringify({ [WORKER_NAME]: devWord, first: firstWord, second: secondWord })}`)
  await assertEqual(devWord, LIFECYCLE_WORD.project, 'stage 9: the worker who was always here reads Project')
  await assertEqual(firstWord, LIFECYCLE_WORD.project, 'stage 9: the worker stage 8b moved reads Project')
  await assertEqual(secondWord, LIFECYCLE_WORD.ephemeral, 'stage 9: the specialist still labelled temporary reads Ephemeral')
  // The raw value stays reachable on the chip and never as words on the page (`docs/ia.md` rule 3).
  const chipTitle = await page.getByTestId(`organization-lifecycle-${secondId}`).getByTestId('chip').getAttribute('title')
  await assertEqual(chipTitle, 'ephemeral', 'stage 9: the raw value is one hover away')

  const allWords = await page
    .locator('[data-testid^="organization-lifecycle-"]')
    .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').trim()))
  console.log(`stage 9 -- every lifecycle word in the column: ${JSON.stringify(allWords)}`)
  await assertEqual(
    allWords.filter((word) => word === LIFECYCLE_WORD.ephemeral).length,
    1,
    'stage 9: exactly one row is temporary',
  )

  const releasedCells = await page
    .locator('[data-testid^="organization-released-"]')
    .evaluateAll((nodes) => nodes.map((node) => ({ testid: node.getAttribute('data-testid'), text: (node.textContent ?? '').trim() })))
  console.log(`stage 9 -- the released cells: ${JSON.stringify(releasedCells)}`)
  await assertEqual(releasedCells.length, 1, 'stage 9: exactly one row says when the engagement ended')
  await assertEqual(releasedCells[0].testid, `organization-released-${secondId}`, 'stage 9: and it is the specialist that was released')
  if (!releasedCells[0].text.startsWith('Released ')) {
    await fail(`stage 9: the released cell reads ${JSON.stringify(releasedCells[0].text)}, expected it to start "Released "`)
  }
  // A released worker is sorted LAST and is never hidden (D7).
  await assertEqual(rowIds[rowIds.length - 1], secondId, 'stage 9: the released row is the last row in the table')
  const releasedFlags = await page
    .locator('[data-testid^="organization-row-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-released')))
  console.log(`stage 9 -- data-released down the table: ${JSON.stringify(releasedFlags)}`)
  await assertEqual(releasedFlags.filter((flag) => flag === 'true').length, 1, 'stage 9: one row carries the released state')

  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await waitVisible(page.getByTestId('slave-card').first(), 'the Overview cards')
  const cards = await page
    .locator('[data-testid="slave-card"]')
    .evaluateAll((nodes) => nodes.map((node) => ({ released: node.getAttribute('data-released'), text: (node.textContent ?? '').trim().slice(0, 120) })))
  console.log(`stage 9 -- the Overview cards: ${JSON.stringify(cards)}`)
  const greyed = cards.filter((card) => card.released === 'true')
  await assertEqual(greyed.length, 1, 'stage 9: exactly one card on the Overview is greyed')
  if (!greyed[0].text.includes(`${SECURITY_PERSONA} 2`)) {
    await fail(`stage 9: the greyed card is not the released specialist: ${JSON.stringify(greyed[0])}`)
  }
  if (!cards.some((card) => card.released === null && card.text.includes(WORKER_NAME))) {
    await fail(`stage 9: the worker who is still here is greyed too: ${JSON.stringify(cards)}`)
  }

  await gotoReliably(`${baseUrl}/workforce`)
  await waitVisible(page.getByTestId('worker-lifecycle').first(), 'the Slaves table lifecycle column')
  const tableWords = await page
    .locator('[data-testid="worker-lifecycle"]')
    .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').trim()))
  console.log(`stage 9 -- the Slaves table's lifecycle column: ${JSON.stringify(tableWords)}`)
  if (!tableWords.includes(LIFECYCLE_WORD.project)) await fail(`stage 9: the column shows no Project row: ${JSON.stringify(tableWords)}`)
  if (!tableWords.includes(LIFECYCLE_WORD.ephemeral)) await fail(`stage 9: the column shows no Ephemeral row: ${JSON.stringify(tableWords)}`)
  const releasedRows = await page
    .locator('[data-testid="slave-row"][data-released="true"]')
    .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').trim().slice(0, 120)))
  console.log(`stage 9 -- the released rows in the Slaves table: ${JSON.stringify(releasedRows)}`)
  if (!releasedRows.some((text) => text.includes(`${SECURITY_PERSONA} 2`))) {
    await fail(`stage 9: the released specialist is not marked in the Slaves table: ${JSON.stringify(releasedRows)}`)
  }

  console.log(`gotoReliably retries this run: ${String(gotoRetries.length)}${gotoRetries.length === 0 ? '' : ` (${JSON.stringify(gotoRetries)})`}`)
  console.log(
    'PASS: a specialist was asked for for ONE assignment, approved by a person, dispatched by role, and released by the system ' +
      'when that assignment was over -- roles emptied, worktree gone, and every run, message and thing it learnt still exactly ' +
      'where it was',
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
    await removeWorkspaceRows(workspaceId)
  }
  // The catalog rows belong to no workspace, so nothing above cascaded them.
  await deleteGateTemplates('teardown').catch(() => {})
  await prisma.catalogImport.deleteMany({ where: { catalog: CATALOG_NAME } }).catch(() => {})
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  if (catalogRoot !== null) rmSync(catalogRoot, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
