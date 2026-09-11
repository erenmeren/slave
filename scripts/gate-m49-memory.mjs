// M49's own gate (spec R7): what this organisation learns is kept as KNOWLEDGE with provenance
// rather than as a transcript. One story, proved end to end against two real daemons, the real CLI
// and a real browser.
//
// Eight stages, each measuring one rule the milestone claims:
//   1. A worker's own closing report becomes a CANDIDATE nobody is given, and the verification
//      that passes turns it into a FACT whose words are the contract it proved -- retiring the
//      candidate in the same breath. Read off the database: the run, the task, the seq of the last
//      `run.output` event and that event's own text on the observation; the handoff's
//      `expectedOutput` on the fact; `supersededById` pointing one at the other; and two
//      `memory.recorded` events plus one `memory.changed`, the first with the task on its ENVELOPE
//      (plan erratum E13).
//   2. A rejected review teaches the worker who WROTE the diff, never the one who caught it. On a
//      SECOND project, because `--review-fixture` rides on a daemon's argv (plan erratum E8) and
//      one daemon's argv decides every review it runs.
//   3. A person's approval and a changed goal are both recorded as DECISIONS, with the rationale
//      behind them.
//   4. The next implementation run is given exactly the verified knowledge of this project and
//      nothing else -- not the retired candidate, not the other project's worker's lesson, not a
//      worker-scoped row at all -- and its recorded PROMPT carries the section, with another
//      party's quoted routing literals defused inside it.
//   5. A correction typed at the CLI leaves a chain of two with the old wording still readable,
//      and the very next run is given the new words instead of the old.
//   6. Twenty facts become ONE summary that keeps every source linked, and the next run is given
//      the summary instead of them.
//   7. In a real BROWSER: six tabs with Knowledge fourth, the filters in the link, the provenance
//      sentence, the chain in the expanded row, Verify / Correct / Remove round-tripping with
//      nothing deleted, the Overview's own knowledge line, and the task drawer's memories group --
//      with no database value anywhere on screen.
//   8. Teardown, in FK order, on every exit path, and a repository this gate wrote nothing into.
//
// NEVER A MODEL CALL. The daemons and the CLI are spawned with SLAVEOFAI_CLAUDE_BIN=node,
// SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m8-flow --plan-fixture plan-graph-runbook"
// (the second project's daemon adds `--review-fixture review-reject`) and
// SLAVEOFAI_REQUIRE_FAKE_CLI=1; the browser half needs SLAVEOFAI_CLAUDE_BIN to name an executable
// under scripts/gate-fakes/ or the preflight refuses to start at all.
//
// WHY `plan-graph-runbook` AND AN ADOPTED RUNBOOK: this gate wants tasks with contracts, because
// the fact a passed verification writes is the contract's own `expectedOutput` -- the one measure
// that tells "the verification agreed" apart from "the worker said so".
//
// WHY THE DAEMONS RUN FIRST AND THE BROWSER LAST (m47's and m48's order): stage 7 photographs a
// project that has already learnt things, so the rows have to exist before the page is opened.
// Every daemon is stopped -- and its absence re-checked with `findRealDaemonPids()` -- before
// `next dev` is spawned, so the two never race the machine.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: it boots its own `next dev`
// against `apps/web/.next` on a free port, and two of those corrupt the build cache for both.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m49-memory
//
// Shape borrowed from `gate-m48-runbooks.mjs` in full: `preflightCleanup`, `dumpGateRows`, `fail`,
// `assertEqual`, `waitUntil`, `waitVisible`, `gotoReliably`, `clickUntil`, `runCli`, `spawnDaemon`
// / `stopDaemon`, the free port plus a real `next dev` under `loopbackChildEnv()`, the browser
// preflight refusal, `exitCode` starting at 1 and teardown in FK order in a `finally` -- with
// `MemorySource` and `Memory` deleted before the rows they point at.

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
import { isAlive } from '../packages/control/dist/index.js'
import { CONDENSE_THRESHOLD } from '../packages/domain/dist/index.js'

const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 100
const DAEMON_PERIOD_MS = 500
const SUPERVISOR_TIMEOUT_MS = 180_000
/** A whole board carried by a real daemon, on a machine whose Postgres every other gate shares. */
const BOARD_TIMEOUT_MS = 600_000
/** `gate-m14-fidelity.mjs`'s own signature for next dev's torn `loadManifest` read. */
const MANIFEST_RACE_SIGNATURE = 'Unexpected end of JSON input'
const VIEWPORT = { width: 1440, height: 900 }

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

// Exact literals, never suffixed -- `preflightCleanup` removes whatever a prior crashed run left
// on these exact names, in the same FK order the `finally` block uses.
const WORKSPACE_NAME = 'M49 Gate Project'
const GATE_WORKSPACE_2 = 'M49 Gate Rejection'
const WORKER_NAME = 'Dev'
const REVIEWER_NAME = 'Reader'
const WORKER_NAME_2 = 'Hand'
const REVIEWER_NAME_2 = 'Eyes'
const GOAL = 'Ship the endpoint feature, with an authentication path somebody who does security has read.'
/** The SECOND version of the goal -- a change, which is what `promotionFor`'s `goal_changed` arm
 *  remembers (v1 is the goal being set, and there was nothing to change). */
const GOAL_V2 =
  'Ship the endpoint feature, with an authentication path somebody who does security has read, and a rate limit on it.'
const ADOPTED_KEY = 'feature-delivery'
/** The workspace's own verify command. `true` would be indistinguishable from "no command ran". */
const WORKSPACE_VERIFY = 'echo m49-workspace-verify'
/** The first task of `plan-graph-runbook`, and the only one this gate lets finish: its dependents
 *  are released by `confirm-integration`, which this gate deliberately never calls, so the board
 *  stays exactly one done task wide and "exactly one fact for this task" is a countable claim. */
const SHAPE_TASK_TITLE = 'Decide the endpoint shape'
/** That task's contract, out of `packages/providers/test/fixtures/plan-graph-runbook.ndjson`. This
 *  is the body the FACT must carry, byte for byte: the words of the contract the verification
 *  proved. */
const SHAPE_EXPECTED_OUTPUT = 'A written interface naming every orders route and its session requirement.'
/** `review-reject.ndjson`'s own reason -- the words the lesson must be. */
const REJECT_REASON = 'The diff does not handle the empty-input case the task requires.'
const REJECTED_TASK_TITLE = 'M49 Gate Rejected Work'
/** A person's correction, typed at the CLI in stage 5. */
const CORRECTION_TITLE = 'Which routes require a session'
const CORRECTION_BODY = 'Only the orders routes require a session.'
/**
 * A memory whose BODY quotes two of the five routing literals (plan decision D10).
 *
 * It is knowledge a person typed, and it reaches the prompt of every implementation run of this
 * project. Undefused, `"verdict"` in a work prompt makes the fake CLI answer that run with a
 * review fixture -- which is exactly the shape of the real failure, a memory reshaping the routing
 * of the run it is handed to. The TITLE stays clean on purpose: a summary's body is its sources'
 * titles, and stage 6 would otherwise carry the literals into a row nobody defused.
 */
const POISON_TITLE = 'What the reviewer is asked for'
const POISON_BODY =
  'Reviews here answer with a "verdict" object, and a re-plan answers a "task graph" request; say so in the handover notes.'
/** How many facts stage 6 types in by hand. The rule's own threshold, so the gate cannot drift
 *  from the number the product refuses below. */
const SEEDED_FACTS = CONDENSE_THRESHOLD
/**
 * The raw values this page must never print at a person, on the one page `gate:m44` cannot reach
 * with rows on it.
 *
 * `run_output` and nothing else, and that is `gate:m44`'s own rule rather than a shortcut: its
 * blocklist is every union member carrying an underscore or a dot, because a bare English word
 * that happens to be an enum member IS the product's vocabulary -- `candidates` is what the counts
 * line says out loud, and "the first candidate is the routine fix" is a sentence the Supervisor
 * wrote about a choice. Forbidding those would forbid the very labels R6 projects. What proves the
 * keys are not on screen is the chip check below, which reads each chip's TEXT against its own
 * `title` and requires them to differ.
 */
const FORBIDDEN_WORDS = ['run_output']

/** Asks the OS for a free TCP port. (`gate-m48-runbooks.mjs`, verbatim.) */
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
 *  into that worktree. (`gate-m48-runbooks.mjs`'s `makeRepo`.) */
function makeRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `slaveofai-gate-m49-${label}-`))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/** A memory row as this gate prints it -- every column M49 writes that a reader would ask about. */
const describeMemory = (row) =>
  `${row.id} ${row.type}/${row.scope}/${row.status} "${row.title}" src=${row.sourceKind}` +
  `${row.sourceRef === null ? '' : `(${row.sourceRef})`} by=${row.createdBy}` +
  ` verifiedBy=${String(row.verifiedBy)} task=${String(row.taskId)} run=${String(row.runId)}` +
  ` goalV=${String(row.goalVersion)} supersededBy=${String(row.supersededById)}`

/** A decision row as this gate prints it. (`gate-m48-runbooks.mjs`'s helper.) */
const describeDecision = (row) =>
  JSON.stringify({
    id: row.id,
    situationKind: row.situationKind,
    subjectId: row.subjectId,
    tier: row.tier,
    status: row.status,
    decidedBy: row.decidedBy,
    modelCalled: row.modelCalled,
  })

const describeTask = (row) =>
  `${row.title} [${row.status}] stage=${JSON.stringify(row.stage)} attempts=${String(row.attempts)}/${String(row.maxAttempts)}`

/** Removes what a prior interrupted run left behind, in the same order the `finally` block uses. */
async function preflightCleanup() {
  for (const name of [WORKSPACE_NAME, GATE_WORKSPACE_2]) {
    const stale = await prisma.workspace.findUnique({ where: { name } })
    if (stale === null) continue
    console.log(`preflight: removing a leftover ${name} (${stale.id}) from an earlier interrupted run`)
    await deleteWorkspaceDeeply(stale.id)
  }
}

/**
 * Everything one of this gate's projects owns, in FK order.
 *
 * `MemorySource` before `Memory` (its two foreign keys are `Cascade`, but a row of a summary whose
 * sources live on another project would otherwise outlive this delete), and `Memory` before the
 * `Task`/`SlaveRun`/`Workspace` rows it names -- `Memory.taskId` and `Memory.runId` are `SetNull`,
 * so a worker-scoped lesson survives its project's deletion as a row nothing can address again.
 * That is exactly the row this gate writes most of.
 */
async function deleteWorkspaceDeeply(id) {
  const memories = await prisma.memory
    .findMany({
      where: {
        OR: [
          { workspaceId: id },
          { slave: { team: { workspaceId: id } } },
          { task: { workspaceId: id } },
          { run: { task: { workspaceId: id } } },
        ],
      },
      select: { id: true },
    })
    .catch(() => [])
  const memoryIds = memories.map((row) => row.id)
  if (memoryIds.length > 0) {
    await prisma.memorySource
      .deleteMany({ where: { OR: [{ memoryId: { in: memoryIds } }, { sourceMemoryId: { in: memoryIds } }] } })
      .catch(() => {})
    // `supersededById` is a self-reference with `SetNull`, so a chain deletes in any order; the
    // stamp is cleared first anyway, because a `deleteMany` over a set that points INTO itself is
    // one statement Postgres orders for itself and this makes the intent readable.
    await prisma.memory.updateMany({ where: { id: { in: memoryIds } }, data: { supersededById: null } }).catch(() => {})
    await prisma.memory.deleteMany({ where: { id: { in: memoryIds } } }).catch(() => {})
    console.log(`teardown: removed ${String(memoryIds.length)} memory row(s) of ${id}`)
  }
  // `ExecutionEvent` has no FK to `Workspace` (M2's append-only log outlives entity lifecycles by
  // design), so it goes explicitly; the workspace delete then cascades Team/Slave/Task/SlaveRun/
  // RunContext/SupervisorDecision/Artifact.
  await prisma.executionEvent.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.slaveMessage.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.workspace.delete({ where: { id } }).catch(() => {})
}

let exitCode = 1
let nextServer = null
let nextOutput = ''
let browser = null
let page = null
let diagDir = null
let repoPath = null
let repoPath2 = null
let workspaceId = null
let workspaceId2 = null
const daemons = []
const browserConsole = []
const gotoRetries = []

/** Every row this gate could have written, for a FAIL's diagnostic dump. BigInt `seq` stringified. */
async function dumpGateRows() {
  const workspaces = []
  for (const id of [workspaceId, workspaceId2]) {
    if (id === null) continue
    const row = await prisma.workspace
      .findUnique({
        where: { id },
        include: { tasks: true, teams: { include: { slaves: true } }, supervisorDecisions: true, memories: true },
      })
      .catch(() => null)
    workspaces.push(row)
  }
  const workerMemories = await prisma.memory
    .findMany({ where: { scope: 'worker' }, orderBy: { createdAt: 'asc' } })
    .catch(() => [])
  const daemonTails = daemons.map((d) => ({
    label: d.label,
    pid: d.proc.pid ?? null,
    exited: d.exited,
    output: d.output.length > 6_000 ? `…${d.output.slice(-6_000)}` : d.output,
  }))
  return JSON.stringify({ workspaces, workerMemories, daemonTails }, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m49-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ============================================================================================
  // Stage 0: the preflight. Refusals, never fallbacks.
  // ============================================================================================

  const fakeClaude = process.env['SLAVEOFAI_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'SLAVEOFAI_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m49-memory',
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
      `no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m49-memory passes ` +
        '--env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m49-memory`')
  }
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI} -- run \`npx tsc --build\` first`)
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)
  for (const fixture of ['plan-graph-runbook', 'review-reject', 'complete']) {
    if (!existsSync(join(repoRoot, `packages/providers/test/fixtures/${fixture}.ndjson`))) {
      throw new Error(`the fixture packages/providers/test/fixtures/${fixture}.ndjson is missing`)
    }
  }
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
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m49-memory REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate spawns its own and measures what it remembers',
    )
  }
  const adopted = await prisma.runbookTemplate.findUnique({ where: { key: ADOPTED_KEY } })
  if (adopted === null) {
    throw new Error(
      `gate:m49-memory REFUSED -- no runbook ${ADOPTED_KEY} in the table. Run \`npm run orchestrator -- runbooks sync\` ` +
        'first: this gate needs a project that follows a process, because the fact a passed verification writes is the ' +
        "contract's own expected output.",
    )
  }
  console.log(`fake claude: ${fakeClaude}`)
  console.log(`chromium:    ${chromiumPath}`)

  /** What `git status --porcelain` says NOW. Compared against the same reading at the end: a green
   *  run of this gate writes no file in this repository, and comparing two readings says so
   *  whether or not the tree was already dirty when it started. */
  const gitStatus = () => execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
  const gitStatusBefore = gitStatus()
  console.log(`git status --porcelain at the start: ${String(gitStatusBefore.trim().split('\n').filter(Boolean).length)} line(s)`)

  await preflightCleanup()

  const childEnv = (extraClaudeArgs = '') =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      // The planning arm's answer AND (M49 erratum E8) the review arm's are chosen on ARGV:
      // `SLAVEOFAI_CLAUDE_ARGS` rides through as `extraArgs` on every spawn, which is already how
      // `--fixture` itself arrives.
      SLAVEOFAI_CLAUDE_ARGS:
        `${FAKE_CLAUDE} --fixture m8-flow --plan-fixture plan-graph-runbook${extraClaudeArgs === '' ? '' : ` ${extraClaudeArgs}`}`,
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

  let activeDaemon = null

  /** Polls `probe` until it returns something truthy. (`gate-m48-runbooks.mjs`'s `waitUntil`.) */
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

  /**
   * The real daemon, in the background -- the same thing an operator leaves running.
   *
   * `extraClaudeArgs` is appended to THIS child's `SLAVEOFAI_CLAUDE_ARGS` only (plan erratum E8):
   * the second project's daemon carries `--review-fixture review-reject`, and the first one's
   * reviews stay approvals.
   */
  function spawnDaemon(label, forWorkspaceId, extraClaudeArgs = '') {
    const proc = spawn(
      'node',
      [ORCHESTRATOR_CLI, 'daemon', '--workspace', forWorkspaceId, '--period', String(DAEMON_PERIOD_MS)],
      { cwd: repoRoot, env: childEnv(extraClaudeArgs), stdio: ['ignore', 'pipe', 'pipe'] },
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
    console.log(`${label} spawned as pid ${String(proc.pid)}${extraClaudeArgs === '' ? '' : ` with ${extraClaudeArgs}`}`)
    return state
  }

  /** Stops a daemon and waits for the process to really be gone. */
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

  /** Every task on the first project, oldest first. */
  const board = () => prisma.task.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })

  /** This project's own memories, oldest first. */
  const memoriesOf = (id) => prisma.memory.findMany({ where: { workspaceId: id }, orderBy: { createdAt: 'asc' } })

  // ============================================================================================
  // The first project: a goal, a process a person adopted, a manager, a worker and a reviewer.
  // ============================================================================================

  repoPath = makeRepo('repo')
  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath,
      baseBranch: 'main',
      // OFF, and deliberately never confirmed: `confirm-integration` is what releases a finished
      // task's dependents on an autoMerge-off project (spec Decision 5), so leaving the first task
      // unmerged keeps the board exactly one done task wide -- which is what makes "exactly one
      // observation and exactly one fact for this task" a countable claim rather than a hope.
      autoMerge: false,
      verifyCommands: [WORKSPACE_VERIFY],
      setupCommands: [],
      maxAttempts: 3,
    },
  })
  workspaceId = workspace.id
  console.log(`workspace ${workspaceId} (${WORKSPACE_NAME}), repo ${repoPath}`)
  await prisma.providerConfiguration.create({ data: { workspaceId, kind: 'claude_code', settings: {} } })

  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
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
  const reader = await prisma.slave.create({
    data: { teamId: team.id, name: REVIEWER_NAME, role: 'Reviewer', runtimeRoles: ['reviewer'], capabilities: [] },
  })
  console.log(`slave ${devId} (${WORKER_NAME}) and slave ${reader.id} (${REVIEWER_NAME})`)

  console.log(`setup -- set-goal printed: ${JSON.stringify(runCli(['set-goal', '--workspace', workspaceId, '--goal', GOAL]).trim())}`)

  // A supervised pass by hand, BEFORE any tick: `runbook_recommended` fires only while the board
  // is still empty and no runbook is adopted. Its approval is stage 3's DECISION, taken here
  // because a way of working has to be adopted before the plan that follows it is written -- the
  // assertions about the memory it wrote are made in stage 3, where they belong.
  console.log(`setup -- supervise printed:\n${runCli(['supervise', '--workspace', workspaceId])}`)
  const adoptDecision = await waitUntil('the Supervisor to offer a way of working', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.supervisorDecision.findFirst({
      where: { workspaceId, situationKind: 'runbook_recommended' },
      orderBy: { createdAt: 'asc' },
    })
    note(row === null ? 'no runbook_recommended yet' : row.status)
    return row
  })
  console.log(`setup -- the decision: ${describeDecision(adoptDecision)}`)
  if (adoptDecision.status !== 'pending' || adoptDecision.tier !== 'proposed') {
    await fail(`setup: a way of working must WAIT for a person: ${describeDecision(adoptDecision)}`)
  }
  // The DECISION's own rationale -- the `rationale` column, which is the sentence whoever made the
  // call gave for choosing this candidate. `action.rationale` is a different sentence (why this
  // ACTION would help), and `rememberDecision` reads the column.
  const adoptRationale = adoptDecision.rationale
  console.log(`setup -- the rationale a person is answering: ${JSON.stringify(adoptRationale)}`)
  console.log(`setup -- the action it would carry out: ${JSON.stringify(adoptDecision.action)}`)
  console.log(
    `setup -- approve-decision printed: ${JSON.stringify(runCli(['approve-decision', '--id', adoptDecision.id]).trim())}`,
  )
  const followed = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { runbookId: true } })
  if (followed.runbookId !== adopted.id) {
    await fail(`setup: the project follows ${String(followed.runbookId)}, expected ${ADOPTED_KEY} (${adopted.id})`)
  }

  // The board asks for a security capability and a QA one; the ROLES are what the scheduler
  // matches (M47), granted through the operator's own verb.
  console.log(
    'setup -- set-runtime-roles printed: ' +
      JSON.stringify(runCli(['set-runtime-roles', '--slave', devId, '--roles', 'backend,manager,security,qa']).trim()),
  )

  console.log(`setup -- tick printed:\n${runCli(['tick', '--workspace', workspaceId])}`)
  const planned = await board()
  console.log(`setup -- board (${String(planned.length)}):\n  ${planned.map(describeTask).join('\n  ')}`)
  if (planned.length !== 3) await fail(`setup: the plan produced ${String(planned.length)} tasks, expected 3`)
  const shapeTask = await prisma.task.findFirstOrThrow({ where: { workspaceId, title: SHAPE_TASK_TITLE } })
  console.log(`setup -- the first task's contract: ${JSON.stringify(shapeTask.handoff)}`)
  if (shapeTask.handoff?.expectedOutput !== SHAPE_EXPECTED_OUTPUT) {
    await fail(
      `setup: the first task's expected output is ${JSON.stringify(shapeTask.handoff?.expectedOutput)}, expected ` +
        `${JSON.stringify(SHAPE_EXPECTED_OUTPUT)} -- the fact this gate measures is exactly this string`,
    )
  }

  const daemon = spawnDaemon('daemon', workspaceId)

  // ============================================================================================
  // Stage 1: a worker's report becomes a candidate, and a passed verification becomes a fact.
  // ============================================================================================

  await waitUntil(`"${SHAPE_TASK_TITLE}" to be worked, verified and reviewed`, BOARD_TIMEOUT_MS, async (note) => {
    const rows = await board()
    note(rows.map((row) => `${row.title}=${row.status}`).join(', '))
    return rows.find((row) => row.id === shapeTask.id)?.status === 'done'
  })
  console.log(`stage 1 -- board after the first task:\n  ${(await board()).map(describeTask).join('\n  ')}`)

  const workRun = await prisma.slaveRun.findFirstOrThrow({
    where: { taskId: shapeTask.id, kind: 'implementation' },
    orderBy: { startedAt: 'asc' },
  })
  console.log(`stage 1 -- the work run ${workRun.id} by slave ${workRun.slaveId}`)

  const taskMemories = await prisma.memory.findMany({ where: { taskId: shapeTask.id }, orderBy: { createdAt: 'asc' } })
  console.log(`stage 1 -- what this task is remembered by (${String(taskMemories.length)}):\n  ${taskMemories.map(describeMemory).join('\n  ')}`)
  const observations = taskMemories.filter((row) => row.type === 'observation')
  const facts = taskMemories.filter((row) => row.type === 'fact')
  await assertEqual(observations.length, 1, 'stage 1: observations promoted for this task')
  await assertEqual(facts.length, 1, 'stage 1: facts promoted for this task')
  const observation = observations[0]
  const fact = facts[0]

  const lastOutput = await prisma.executionEvent.findFirst({
    where: { runId: workRun.id, type: 'run_output' },
    orderBy: { seq: 'desc' },
  })
  if (lastOutput === null) await fail("stage 1: the work run left no run.output event to remember")
  console.log(`stage 1 -- the LAST run.output of that run is seq ${String(lastOutput.seq)}`)
  await assertEqual(
    {
      runId: observation.runId,
      taskId: observation.taskId,
      sourceKind: observation.sourceKind,
      sourceRef: observation.sourceRef,
      createdBy: observation.createdBy,
      scope: observation.scope,
    },
    {
      runId: workRun.id,
      taskId: shapeTask.id,
      sourceKind: 'run_output',
      sourceRef: String(lastOutput.seq),
      createdBy: 'slave',
      scope: 'workspace',
    },
    "stage 1: the candidate points at the run, the task and the seq of the worker's LAST word",
  )
  console.log(`stage 1 -- the candidate's body: ${JSON.stringify(observation.body)}`)
  console.log(`stage 1 -- that event's own text: ${JSON.stringify(lastOutput.payload.text)}`)
  // Capped in CODE POINTS, the unit R1's caps are stated in and the unit `capCodePoints` counts.
  const rememberedText = [...lastOutput.payload.text.trim()].slice(0, 2000).join('')
  if (observation.body !== rememberedText) {
    await fail(
      `stage 1: the candidate's body is ${JSON.stringify(observation.body)} and the event it names says ` +
        `${JSON.stringify(lastOutput.payload.text)} -- a memory must be the worker's own closing words`,
    )
  }

  await assertEqual(
    {
      type: fact.type,
      status: fact.status,
      verifiedBy: fact.verifiedBy,
      confidence: fact.confidence,
      sourceKind: fact.sourceKind,
      body: fact.body,
    },
    {
      type: 'fact',
      status: 'verified',
      verifiedBy: 'verification',
      confidence: 'sourced',
      sourceKind: 'verification',
      body: SHAPE_EXPECTED_OUTPUT,
    },
    "stage 1: the fact the verification wrote is the CONTRACT's own expected output",
  )
  await assertEqual(
    { status: observation.status, supersededById: observation.supersededById },
    { status: 'superseded', supersededById: fact.id },
    'stage 1: the candidate was retired in the same breath, pointing at what answered it',
  )

  const memoryEvents = await prisma.executionEvent.findMany({
    where: { workspaceId, taskId: shapeTask.id, type: { in: ['memory_recorded', 'memory_changed'] } },
    orderBy: { seq: 'asc' },
  })
  console.log(
    `stage 1 -- the memory events filed under this task:\n  ` +
      memoryEvents.map((e) => `${String(e.seq)} ${e.type} actor=${e.actor} ${JSON.stringify(e.payload)}`).join('\n  '),
  )
  await assertEqual(
    memoryEvents.map((e) => e.type),
    ['memory_recorded', 'memory_recorded', 'memory_changed'],
    'stage 1: two memories recorded and one changed, in that order',
  )
  // Plan erratum E13: the task rides on the ENVELOPE, which is where `appendEvent` indexes it and
  // where the Activity page's `?tasks=` filter and the task drawer both read it.
  await assertEqual(memoryEvents[0].taskId, shapeTask.id, "stage 1: the first memory.recorded carries the task on its ENVELOPE")
  await assertEqual(memoryEvents[0].payload.memoryId, observation.id, 'stage 1: and it is about the candidate')
  // Field by field, never the whole `payload`: Postgres stores a `jsonb` object with its OWN key
  // order (shortest key first, then alphabetical), so a comparison over the stored object compares
  // the database's spelling rather than the event's meaning (`canonicalStages`' own lesson).
  await assertEqual(
    {
      memoryId: memoryEvents[2].payload.memoryId,
      from: memoryEvents[2].payload.from,
      to: memoryEvents[2].payload.to,
    },
    { memoryId: observation.id, from: 'candidate', to: 'superseded' },
    'stage 1: what changed',
  )

  console.log(
    "stage 1 PASSED: the worker's own closing report is a candidate nobody is given, and the verification that passed turned " +
      'it into a fact whose words are the contract it proved -- retiring the candidate in the same breath',
  )

  // ============================================================================================
  // Stage 2: a rejection teaches the worker that did the work -- on a SECOND project, because one
  //          daemon's argv decides every review it runs (plan erratum E8).
  // ============================================================================================

  repoPath2 = makeRepo('repo2')
  const workspace2 = await prisma.workspace.create({
    data: {
      name: GATE_WORKSPACE_2,
      repoPath: repoPath2,
      baseBranch: 'main',
      autoMerge: false,
      verifyCommands: [WORKSPACE_VERIFY],
      setupCommands: [],
      maxAttempts: 1,
      // Off, deliberately: this project exists to measure ONE rejected review, and a Supervisor
      // proposing staffing for it would be noise in the log of a gate about knowledge.
      supervisorEnabled: false,
    },
  })
  workspaceId2 = workspace2.id
  console.log(`workspace ${workspaceId2} (${GATE_WORKSPACE_2}), repo ${repoPath2}`)
  await prisma.providerConfiguration.create({ data: { workspaceId: workspaceId2, kind: 'claude_code', settings: {} } })
  const team2 = await prisma.team.create({ data: { workspaceId: workspaceId2, name: 'Engineering' } })
  const hand = await prisma.slave.create({
    data: { teamId: team2.id, name: WORKER_NAME_2, role: 'Engineer', runtimeRoles: ['backend'], capabilities: [] },
  })
  const eyes = await prisma.slave.create({
    data: { teamId: team2.id, name: REVIEWER_NAME_2, role: 'Reviewer', runtimeRoles: ['reviewer'], capabilities: [] },
  })
  console.log(`slave ${hand.id} (${WORKER_NAME_2}) writes the diff; slave ${eyes.id} (${REVIEWER_NAME_2}) reads it`)
  const rejectedTask = await prisma.task.create({
    data: {
      workspaceId: workspaceId2,
      title: REJECTED_TASK_TITLE,
      description: 'Work whose diff a reviewer turns down.',
      status: 'ready',
      maxAttempts: 1,
      requiredRole: 'backend',
    },
  })
  console.log(`stage 2 -- the task a review will turn down: ${rejectedTask.id}`)

  const daemon2 = spawnDaemon('daemon-2', workspaceId2, '--review-fixture review-reject')
  const rejection = await waitUntil('the review to turn the work down', BOARD_TIMEOUT_MS, async (note) => {
    const row = await prisma.executionEvent.findFirst({
      where: { workspaceId: workspaceId2, type: 'task_review_rejected' },
      orderBy: { seq: 'asc' },
    })
    note(row === null ? 'no task.review_rejected yet' : 'written')
    return row
  })
  console.log(`stage 2 -- task.review_rejected payload: ${JSON.stringify(rejection.payload)}`)
  // The lesson is written after the event, so wait for the row rather than racing it.
  const lesson = await waitUntil('the lesson the rejection teaches', BOARD_TIMEOUT_MS, async (note) => {
    const rows = await prisma.memory.findMany({ where: { taskId: rejectedTask.id, type: 'lesson' } })
    note(`${String(rows.length)} lesson(s)`)
    return rows.length === 0 ? false : rows
  })
  console.log(`stage 2 -- the lessons this rejection wrote (${String(lesson.length)}):\n  ${lesson.map(describeMemory).join('\n  ')}`)
  await assertEqual(lesson.length, 1, 'stage 2: lessons written for one rejected review')
  await assertEqual(
    {
      type: lesson[0].type,
      scope: lesson[0].scope,
      slaveId: lesson[0].slaveId,
      workspaceId: lesson[0].workspaceId,
      verifiedBy: lesson[0].verifiedBy,
      body: lesson[0].body,
    },
    {
      type: 'lesson',
      scope: 'worker',
      slaveId: hand.id,
      workspaceId: null,
      verifiedBy: 'review',
      body: REJECT_REASON,
    },
    "stage 2: the lesson belongs to the worker that WROTE the diff, in the reviewer's own words",
  )
  // The negative beside the positive (plan erratum E2): the slave that CAUGHT it learns nothing.
  const reviewerLessons = await prisma.memory.count({ where: { slaveId: eyes.id } })
  console.log(`stage 2 -- memories belonging to ${REVIEWER_NAME_2}, who caught it: ${String(reviewerLessons)}`)
  if (reviewerLessons !== 0) await fail(`stage 2: the reviewer was taught ${String(reviewerLessons)} lesson(s), expected none`)
  if (lesson[0].slaveId === eyes.id) await fail('stage 2: the lesson was filed against the reviewer')
  const lessonId = lesson[0].id
  await stopDaemon(daemon2)

  console.log(
    'stage 2 PASSED: a rejected review taught the worker who wrote the diff, in the reviewer’s own words, and taught the ' +
      'reviewer who caught it nothing',
  )

  // ============================================================================================
  // Stage 3: a person's decision, and a changed goal, are both DECISIONS.
  // ============================================================================================

  const decisionMemories = await prisma.memory.findMany({
    where: { workspaceId, type: 'decision' },
    orderBy: { createdAt: 'asc' },
  })
  console.log(`stage 3 -- decision memories after one approval:\n  ${decisionMemories.map(describeMemory).join('\n  ')}`)
  await assertEqual(decisionMemories.length, 1, "stage 3: decisions remembered after a person answered one proposal")
  const approvalMemory = decisionMemories[0]
  await assertEqual(
    {
      type: approvalMemory.type,
      status: approvalMemory.status,
      verifiedBy: approvalMemory.verifiedBy,
      createdBy: approvalMemory.createdBy,
      sourceKind: approvalMemory.sourceKind,
      sourceRef: approvalMemory.sourceRef,
    },
    {
      type: 'decision',
      status: 'verified',
      verifiedBy: 'human',
      createdBy: 'human',
      sourceKind: 'decision',
      sourceRef: adoptDecision.id,
    },
    'stage 3: the approval is remembered as a decision a person took, pointing at the proposal they answered',
  )
  console.log(`stage 3 -- the decision memory's body: ${JSON.stringify(approvalMemory.body)}`)
  if (!approvalMemory.body.includes(adoptRationale)) {
    await fail(
      `stage 3: the decision memory's body is ${JSON.stringify(approvalMemory.body)} and does not carry the rationale ` +
        `${JSON.stringify(adoptRationale)} the person was answering`,
    )
  }

  console.log(
    `stage 3 -- set-goal (v2) printed: ${JSON.stringify(runCli(['set-goal', '--workspace', workspaceId, '--goal', GOAL_V2]).trim())}`,
  )
  const goalMemory = await waitUntil('the changed goal to be remembered', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.memory.findFirst({ where: { workspaceId, type: 'decision', title: 'Goal v2' } })
    note(row === null ? 'no Goal v2 memory yet' : 'written')
    return row
  })
  console.log(`stage 3 -- the goal decision: ${describeMemory(goalMemory)}`)
  await assertEqual(
    {
      title: goalMemory.title,
      body: goalMemory.body,
      sourceKind: goalMemory.sourceKind,
      sourceRef: goalMemory.sourceRef,
      goalVersion: goalMemory.goalVersion,
      verifiedBy: goalMemory.verifiedBy,
    },
    { title: 'Goal v2', body: GOAL_V2, sourceKind: 'goal', sourceRef: '2', goalVersion: 2, verifiedBy: 'human' },
    'stage 3: the second version of the goal is a decision with the words a person typed',
  )
  // The first version is NOT one: there was nothing to change, and the goal is already the first
  // section of every planning prompt.
  const v1Memories = await prisma.memory.count({ where: { workspaceId, sourceKind: 'goal', sourceRef: '1' } })
  console.log(`stage 3 -- memories written for goal v1 (the goal being SET): ${String(v1Memories)}`)
  if (v1Memories !== 0) await fail('stage 3: setting the first goal was remembered as a decision, and it changed nothing')

  console.log(
    "stage 3 PASSED: a person's approval carries the rationale they answered, and the version of the goal they typed is a " +
      'decision in their own words -- while setting the first goal is not',
  )

  // ============================================================================================
  // Stage 4: the next run is given exactly the right knowledge, and nothing else.
  // ============================================================================================

  // Knowledge a person typed, whose BODY quotes two routing literals. It reaches the very next
  // run's prompt, where it must arrive defused (plan decision D10).
  const poisonLine = runCli([
    'memories', 'add',
    '--workspace', workspaceId,
    '--type', 'fact',
    '--title', POISON_TITLE,
    '--body', POISON_BODY,
  ]).trim()
  console.log(`stage 4 -- \`memories add\` printed: ${JSON.stringify(poisonLine)}`)
  if (!poisonLine.endsWith('added: Fact, verified by a person')) {
    await fail(`stage 4: \`memories add\` printed ${JSON.stringify(poisonLine)}`)
  }

  /**
   * Waits until nothing on the first project is moving by itself.
   *
   * A goal change re-plans (M40), and the delta fixture adds a task of its own; every task that
   * finishes writes a fact. Measuring "exactly what this run was given" against the table means
   * nothing while another run is about to add a row to it, so each probe below is created onto a
   * still board. The tasks whose dependencies this gate deliberately never satisfies sit in
   * `blocked` and are quiet by definition.
   */
  // `ready` is deliberately NOT here. A task whose dependencies are satisfied but whose
  // predecessor's branch was never carried across reads `ready` and is never dispatched on an
  // autoMerge-off project -- which is exactly the state this gate leaves the second and third
  // tasks of the plan in, on purpose. Waiting for those to stop being ready would wait for ever.
  // What "moving" means here is "about to write a memory": a claimed task, or a live run.
  const MOVING = ['assigned', 'running', 'verifying', 'reviewing', 'merging', 'rework']
  async function waitForQuiet(stage) {
    await waitUntil(`${stage}: the board to stop moving on its own`, BOARD_TIMEOUT_MS, async (note) => {
      const rows = await prisma.task.findMany({ where: { workspaceId }, select: { title: true, status: true } })
      const busy = rows.filter((row) => MOVING.includes(row.status))
      const running = await prisma.slaveRun.count({
        where: { task: { workspaceId }, status: { in: ['starting', 'working', 'pause_requested', 'paused', 'resuming', 'stopping'] } },
      })
      note(`${String(busy.length)} task(s) moving ${JSON.stringify(busy)}, ${String(running)} run(s) live`)
      return busy.length === 0 && running === 0
    })
    console.log(`${stage} -- the board is still: ${JSON.stringify((await board()).map((row) => `${row.title}=${row.status}`))}`)
  }

  let probeCount = 0
  /**
   * A new task on the first project, worked by the running daemon, and the run context it was
   * really dispatched with.
   *
   * The manifest and the prompt are RECORDED at dispatch, before the vendor child is even spawned,
   * so this reads what the run was given without waiting for what it did.
   */
  async function nextRunContext(stage, title, description) {
    await waitForQuiet(stage)
    probeCount += 1
    const probe = await prisma.task.create({
      data: {
        workspaceId,
        title,
        description,
        status: 'ready',
        maxAttempts: 1,
        requiredRole: 'backend',
      },
    })
    console.log(`${stage} -- probe task ${String(probeCount)} ${probe.id} (${title})`)
    const run = await waitUntil(`an implementation run of "${title}" with a recorded context`, BOARD_TIMEOUT_MS, async (note) => {
      const row = await prisma.slaveRun.findFirst({ where: { taskId: probe.id, kind: 'implementation' } })
      if (row === null) {
        note('not dispatched yet')
        return false
      }
      const context = await prisma.runContext.findFirst({ where: { runId: row.id } })
      note(context === null ? `run ${row.id} has no recorded context yet` : 'recorded')
      return context === null ? false : { row, context }
    })
    const text = runCli(['show-context', '--run', run.row.id, '--prompt'])
    const [manifestText, promptText] = text.split(`${'-'.repeat(40)}\n`)
    const manifest = JSON.parse(manifestText)
    const memorySource = manifest.sections.find((section) => section.kind === 'memory')
    console.log(`${stage} -- the run's manifest: ${JSON.stringify(manifest.sections.map((s) => s.kind))}`)
    console.log(`${stage} -- its memory entry: ${JSON.stringify(memorySource)}`)
    if (memorySource === undefined) await fail(`${stage}: the run's recorded manifest carries no memory entry at all`)
    console.log(`${stage} -- its context was recorded at ${run.context.createdAt.toISOString()}`)
    return { task: probe, run: run.row, recordedAt: run.context.createdAt, manifest, memorySource, prompt: promptText ?? '' }
  }

  /** The ids of every VERIFIED memory this project owns, in `retrieveMemories`' order -- decisions
   *  before facts (`MEMORY_TYPE_ORDER`), then newest first, then by id. Every tie below this is a
   *  tie in the rule too: nothing here is company-scoped, no probe task asks for a capability, and
   *  none of these memories came out of the task being dispatched. */
  const expectedForRun = async (recordedAt) => {
    // Cut at the moment the context under measurement was RECORDED: a memory written after it --
    // the probe's own candidate when its run concludes, its own fact when the verify passes --
    // could not have been in it, and nothing else is writing, because `waitForQuiet` is what every
    // probe waits on before it is created.
    const rows = await prisma.memory.findMany({
      where: { workspaceId, status: 'verified', createdAt: { lte: recordedAt } },
    })
    const rank = { decision: 0, fact: 1, procedure: 2, lesson: 3, observation: 4, hypothesis: 5 }
    return [...rows]
      .sort(
        (a, b) =>
          rank[a.type] - rank[b.type] ||
          b.createdAt.getTime() - a.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      )
      .map((row) => row.id)
  }

  const given = await nextRunContext(
    'stage 4',
    'M49 Gate Probe One: what the next run knows',
    'A task whose only job is to be dispatched, so the knowledge it was handed is on the record.',
  )
  const expectedIds = await expectedForRun(given.recordedAt)
  const everyMemory = await memoriesOf(workspaceId)
  console.log(`stage 4 -- every memory this project owns:\n  ${everyMemory.map(describeMemory).join('\n  ')}`)
  await assertEqual(given.memorySource.memoryIds, expectedIds, "stage 4: the run was given this project's verified knowledge, in order")
  await assertEqual(given.memorySource.capped, false, 'stage 4: and the list was not capped')
  // Decisions outrank facts (R3), so the two a person took come first.
  await assertEqual(
    given.memorySource.memoryIds.slice(0, 2),
    [goalMemory.id, approvalMemory.id],
    'stage 4: what was DECIDED is what the run reads first',
  )
  // The three negatives, by id.
  for (const [what, id] of [
    ['the retired candidate', observation.id],
    ["the other project's worker's lesson", lessonId],
  ]) {
    console.log(`stage 4 -- ${what} (${id}) is in the manifest: ${String(given.memorySource.memoryIds.includes(id))}`)
    if (given.memorySource.memoryIds.includes(id)) await fail(`stage 4: the run was given ${what}`)
  }
  const scopes = await prisma.memory.findMany({
    where: { id: { in: given.memorySource.memoryIds } },
    select: { id: true, scope: true, type: true },
  })
  console.log(`stage 4 -- the scopes and types the run was given: ${JSON.stringify(scopes)}`)
  if (scopes.some((row) => row.scope !== 'workspace')) {
    await fail(`stage 4: a memory outside this project's own scope reached the run: ${JSON.stringify(scopes)}`)
  }
  if (scopes.some((row) => row.type === 'lesson')) {
    await fail(`stage 4: a lesson reached a run of a worker it does not belong to: ${JSON.stringify(scopes)}`)
  }

  // The PROMPT the worker was really given.
  if (!given.prompt.includes('WHAT THE ORGANISATION KNOWS')) {
    await fail("stage 4: the recorded prompt has no WHAT THE ORGANISATION KNOWS heading")
  }
  if (!given.prompt.includes(SHAPE_EXPECTED_OUTPUT)) {
    await fail("stage 4: the recorded prompt does not carry the fact's own words")
  }
  const section = given.prompt.split('WHAT THE ORGANISATION KNOWS')[1]?.split('\n---')[0] ?? ''
  console.log(`stage 4 -- the section the worker was really given:\n${section.trim()}`)
  for (const literal of ['candidateIndex', 'sources', 'replan', 'task graph', 'verdict']) {
    if (section.includes(`"${literal}"`)) {
      await fail(`stage 4: the memory section carries the routing literal "${literal}" with its ASCII quotes intact`)
    }
  }
  // The positive counterpart, so the five negatives above are not vacuous: the words ARE there,
  // with typographic quotes, and the run they reached was still a work run.
  for (const literal of ['verdict', 'task graph']) {
    if (!section.includes(`“${literal}”`)) {
      await fail(`stage 4: the memory section does not carry ${literal} defused -- the negative above proves nothing`)
    }
  }
  console.log(
    'stage 4 PASSED: the very next run was given exactly this project’s verified knowledge with what was DECIDED first, and ' +
      'none of the retired candidate, the other project’s lesson or anything scoped to a worker -- with another party’s ' +
      'quoted routing literals defused inside the prompt it really got',
  )

  // ============================================================================================
  // Stage 5: a correction typed at the CLI leaves a chain of two.
  // ============================================================================================

  const supersedeLine = runCli([
    'memories', 'supersede', fact.id, '--title', CORRECTION_TITLE, '--body', CORRECTION_BODY,
  ]).trim()
  console.log(`stage 5 -- \`memories supersede\` printed: ${JSON.stringify(supersedeLine)}`)
  const correctionId = supersedeLine.split(' replaces ')[0]
  if (supersedeLine !== `${correctionId} replaces ${fact.id}`) {
    await fail(`stage 5: \`memories supersede\` printed ${JSON.stringify(supersedeLine)}`)
  }
  const oldFact = await prisma.memory.findUniqueOrThrow({ where: { id: fact.id } })
  const correction = await prisma.memory.findUniqueOrThrow({ where: { id: correctionId } })
  console.log(`stage 5 -- the old row: ${describeMemory(oldFact)}`)
  console.log(`stage 5 -- the new row: ${describeMemory(correction)}`)
  await assertEqual(
    { status: oldFact.status, supersededById: oldFact.supersededById, body: oldFact.body },
    { status: 'superseded', supersededById: correctionId, body: SHAPE_EXPECTED_OUTPUT },
    'stage 5: the old wording is kept, marked replaced, and still readable',
  )
  await assertEqual(
    {
      status: correction.status,
      sourceKind: correction.sourceKind,
      sourceRef: correction.sourceRef,
      createdBy: correction.createdBy,
      body: correction.body,
      type: correction.type,
    },
    {
      status: 'verified',
      sourceKind: 'human',
      sourceRef: fact.id,
      createdBy: 'human',
      body: CORRECTION_BODY,
      type: 'fact',
    },
    'stage 5: the correction is a person’s words, pointing back at what it replaced',
  )
  const shownNew = runCli(['memories', 'show', correctionId])
  const shownOld = runCli(['memories', 'show', fact.id])
  console.log(`stage 5 -- \`memories show <new>\` printed:\n${shownNew}`)
  console.log(`stage 5 -- \`memories show <old>\` printed:\n${shownOld}`)
  if (!shownNew.includes(`  replaced: ${fact.id} `)) {
    await fail('stage 5: `memories show` on the correction does not name what it replaced')
  }
  if (!shownNew.includes(SHAPE_EXPECTED_OUTPUT.slice(0, 30)) && !shownNew.includes(`replaced: ${fact.id}`)) {
    await fail('stage 5: neither end of the chain is readable from the correction')
  }
  if (!shownOld.includes(`  replaced by: ${correctionId} ${CORRECTION_TITLE}`)) {
    await fail('stage 5: `memories show` on the old row does not name what replaced it')
  }

  const afterCorrection = await nextRunContext(
    'stage 5',
    'M49 Gate Probe Two: what the corrected run knows',
    'A task dispatched after a person corrected a fact, so which wording reached it is on the record.',
  )
  await assertEqual(
    afterCorrection.memorySource.memoryIds,
    await expectedForRun(afterCorrection.recordedAt),
    'stage 5: the corrected knowledge, in order',
  )
  console.log(
    `stage 5 -- the new id ${correctionId} is in the manifest: ${String(afterCorrection.memorySource.memoryIds.includes(correctionId))}; ` +
      `the old id ${fact.id} is: ${String(afterCorrection.memorySource.memoryIds.includes(fact.id))}`,
  )
  if (!afterCorrection.memorySource.memoryIds.includes(correctionId)) {
    await fail('stage 5: the next run was not given the correction')
  }
  if (afterCorrection.memorySource.memoryIds.includes(fact.id)) {
    await fail('stage 5: the next run was given the wording a person replaced')
  }
  if (!afterCorrection.prompt.includes(CORRECTION_BODY)) {
    await fail("stage 5: the corrected words are not in the prompt the worker was really given")
  }
  if (afterCorrection.prompt.includes(SHAPE_EXPECTED_OUTPUT)) {
    await fail('stage 5: the replaced words are still in the prompt the worker was really given')
  }

  console.log(
    'stage 5 PASSED: one correction typed at the CLI left a chain of two with the old wording still readable at both ends, ' +
      'and the very next run was given the new words and not the old',
  )

  // ============================================================================================
  // Stage 6: twenty facts become one summary, and the next run gets the summary.
  // ============================================================================================

  // Counted against a still board: a run still in flight would write its fact between the count
  // below and the condensation, and "every verified fact is linked" would then be a race.
  await waitForQuiet('stage 6')
  const seededIds = []
  for (let index = 1; index <= SEEDED_FACTS; index += 1) {
    // A real CLI subprocess each, so nothing writes rows behind the product's back.
    const line = runCli([
      'memories', 'add',
      '--workspace', workspaceId,
      '--type', 'fact',
      '--title', `M49 gate fact ${String(index)}`,
      '--body', `The gate typed this fact number ${String(index)} in, and a person stands behind it.`,
    ]).trim()
    seededIds.push(line.split(' added: ')[0])
  }
  console.log(`stage 6 -- ${String(seededIds.length)} facts typed in through the real CLI; the first is ${seededIds[0]}`)

  const verifiedFactsBefore = await prisma.memory.findMany({
    where: { workspaceId, type: 'fact', status: 'verified' },
    orderBy: { createdAt: 'asc' },
  })
  console.log(`stage 6 -- verified facts this project holds before condensing: ${String(verifiedFactsBefore.length)}`)
  if (verifiedFactsBefore.length < SEEDED_FACTS) {
    await fail(`stage 6: only ${String(verifiedFactsBefore.length)} verified facts, and the rule refuses below ${String(SEEDED_FACTS)}`)
  }

  const condensed = runCli(['memories', 'condense', '--workspace', workspaceId, '--type', 'fact']).trim()
  console.log(`stage 6 -- \`memories condense\` printed: ${JSON.stringify(condensed)}`)
  const condensedLines = condensed.split('\n').filter((line) => line !== '')
  await assertEqual(condensedLines.length, 1, 'stage 6: summaries written')
  const summaryId = condensedLines[0].split(':')[0]
  // The WRITTEN type (M49 t5 fix round 1): the line has to name what `memories show` on the same
  // id will say.
  await assertEqual(
    condensedLines[0],
    `${summaryId}: Fact summary of ${String(verifiedFactsBefore.length)} sources`,
    'stage 6: the line names the type that was WRITTEN and how many sources it keeps',
  )
  const summary = await prisma.memory.findUniqueOrThrow({ where: { id: summaryId } })
  console.log(`stage 6 -- the summary: ${describeMemory(summary)}`)
  console.log(`stage 6 -- its body:\n${summary.body}`)
  await assertEqual(
    { type: summary.type, status: summary.status, sourceKind: summary.sourceKind, createdBy: summary.createdBy },
    { type: 'fact', status: 'verified', sourceKind: 'condensation', createdBy: 'system' },
    'stage 6: the summary is a condensation nothing typed and no model wrote',
  )
  const sources = await prisma.memorySource.findMany({ where: { memoryId: summaryId } })
  const sourceIds = sources.map((row) => row.sourceMemoryId)
  console.log(`stage 6 -- MemorySource rows linked to it: ${String(sources.length)}`)
  await assertEqual(
    sources.length,
    verifiedFactsBefore.length,
    'stage 6: every verified fact this project held is linked to the one summary',
  )
  const missing = seededIds.filter((id) => !sourceIds.includes(id))
  console.log(`stage 6 -- of the ${String(SEEDED_FACTS)} typed in, this many are NOT linked: ${String(missing.length)}`)
  if (missing.length > 0) await fail(`stage 6: ${String(missing.length)} of the facts a person typed are in no summary: ${JSON.stringify(missing.slice(0, 5))}`)
  const stillVerified = await prisma.memory.count({ where: { id: { in: sourceIds }, status: 'verified' } })
  console.log(`stage 6 -- sources still verified after being summarised: ${String(stillVerified)} of ${String(sourceIds.length)}`)
  if (stillVerified !== sourceIds.length) {
    await fail('stage 6: summarising a memory changed its status -- a summary is an index, not a replacement')
  }
  // A second run finds nothing: the coverage read is what makes this deterministic.
  const again = runCli(['memories', 'condense', '--workspace', workspaceId, '--type', 'fact']).trim()
  console.log(`stage 6 -- a second \`memories condense\` printed: ${JSON.stringify(again)}`)
  if (!again.startsWith('nothing to summarise:')) {
    await fail(`stage 6: a second condense wrote something: ${JSON.stringify(again)}`)
  }

  const afterCondensation = await nextRunContext(
    'stage 6',
    'M49 Gate Probe Three: what the summarised run knows',
    'A task dispatched after twenty facts became one summary, so which of the two reached it is on the record.',
  )
  console.log(`stage 6 -- the run's memory ids: ${JSON.stringify(afterCondensation.memorySource.memoryIds)}`)
  if (!afterCondensation.memorySource.memoryIds.includes(summaryId)) {
    await fail('stage 6: the next run was not given the summary')
  }
  const leaked = afterCondensation.memorySource.memoryIds.filter((id) => sourceIds.includes(id))
  console.log(`stage 6 -- sources of the summary that ALSO reached the run: ${String(leaked.length)}`)
  if (leaked.length > 0) await fail(`stage 6: the run was given the summary AND ${String(leaked.length)} of its sources`)
  await assertEqual(
    afterCondensation.memorySource.memoryIds,
    [goalMemory.id, approvalMemory.id, summaryId],
    'stage 6: two decisions and one summary is the whole of what the next run is given',
  )

  console.log(
    `stage 6 PASSED: ${String(sources.length)} verified facts became ONE summary that keeps every one of them linked and ` +
      'verified, a second run of the same verb wrote nothing, and the next run was given the summary instead of them',
  )

  // ============================================================================================
  // A candidate for stage 7 to act on: a run that succeeds and a verification that does not.
  // ============================================================================================

  // The candidate this project's first task left behind was retired by the verification that
  // passed, which is stage 1's whole point -- so there is none for a person to act on. This makes
  // one the way the product does: the observation is promoted BEFORE the verify runs (plan erratum
  // E1), so a verify that says no leaves the worker's claim standing and unverified. That is also
  // the shape the Supervisor's `memory_candidates_piling` situation exists for.
  await prisma.workspace.update({ where: { id: workspaceId }, data: { verifyCommands: ['false'] } })
  console.log("a candidate to act on: the project's verify command is now `false`")
  const unverified = await nextRunContext(
    'stage 7 setup',
    'M49 Gate Probe Four: a claim nothing checked',
    'A task whose work succeeds and whose verification does not, so a person has an unverified claim to answer.',
  )
  const candidate = await waitUntil('an unverified claim to act on', BOARD_TIMEOUT_MS, async (note) => {
    const row = await prisma.memory.findFirst({ where: { taskId: unverified.task.id, type: 'observation', status: 'candidate' } })
    note(row === null ? 'no candidate yet' : 'written')
    return row
  })
  await waitUntil('the verification to refuse it', BOARD_TIMEOUT_MS, async (note) => {
    const row = await prisma.executionEvent.findFirst({
      where: { workspaceId, taskId: unverified.task.id, type: 'task_verify_failed' },
    })
    note(row === null ? 'no task.verify_failed yet' : 'written')
    return row
  })
  const candidateStill = await prisma.memory.findUniqueOrThrow({ where: { id: candidate.id } })
  console.log(`stage 7 setup -- the claim nothing checked: ${describeMemory(candidateStill)}`)
  if (candidateStill.status !== 'candidate') {
    await fail(`stage 7 setup: the claim is ${candidateStill.status}, and a person needs a candidate to answer`)
  }

  await stopDaemon(daemon)
  const strayAfter = findRealDaemonPids()
  console.log(`orchestrator daemons still running after the stops: ${JSON.stringify(strayAfter)}`)
  if (strayAfter.length > 0) await fail(`a gate daemon is still running (pid ${strayAfter.join(', ')})`)

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

  /** Click, then wait for what the click was FOR -- retried once. (`gate-m45`'s `clickUntil`.) */
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

  /**
   * Every string a person can actually READ on the page right now, with the testid path of the
   * element that renders it. `gate-m44-ux-foundation.mjs`'s `readVisibleText`, verbatim -- text
   * NODES rather than `outerHTML`, because the whole contract is that the raw value stays
   * reachable in a `title` and on a `data-` attribute, and neither of those is a text node.
   */
  async function readVisibleText() {
    return page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      const shown = []
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const parent = node.parentElement
        if (parent === null) continue
        if (parent.closest('nextjs-portal, script, style, [aria-hidden="true"], .sr-only') !== null) continue
        const value = (node.nodeValue ?? '').trim()
        if (value === '') continue
        const owner = parent.closest('[data-testid]')
        const where = owner === null ? parent.tagName.toLowerCase() : `[data-testid="${owner.getAttribute('data-testid') ?? ''}"]`
        const rendered =
          parent.getClientRects().length > 0 && (typeof parent.checkVisibility !== 'function' || parent.checkVisibility())
        if (rendered) shown.push({ text: value, where })
      }
      return shown
    })
  }

  /** Every `knowledge-row` on screen, as its own `data-` attributes describe it. */
  const knowledgeRows = () =>
    page.getByTestId('knowledge-row').evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute('data-memory-id'),
        type: node.getAttribute('data-memory-type'),
        status: node.getAttribute('data-memory-status'),
        scope: node.getAttribute('data-memory-scope'),
      })),
    )

  // ============================================================================================
  // Stage 7: in a real browser -- what this project knows, where it came from, and what a person
  //          can do about it.
  // ============================================================================================

  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await waitVisible(page.getByTestId('strip'), "the project's Overview")
  // `Tabs` renders a `project-tab-badge-<id>` beside a tab that carries a count, and its text is
  // part of the tab's own `textContent` ("Tasks2"). The badges are dropped by name here: they are
  // the same prefix and a different thing.
  const tabs = await page
    .locator('[data-testid^="project-tab-"]')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => (node.getAttribute('data-testid') ?? '').replace('project-tab-', ''))
        .filter((id) => !id.startsWith('badge-')),
    )
  console.log(`stage 7 -- the project strip: ${JSON.stringify(tabs)}`)
  await assertEqual(
    tabs,
    ['overview', 'tasks', 'organization', 'knowledge', 'activity', 'settings'],
    'stage 7: six tabs, with Knowledge the fourth of them',
  )
  const knowledgeTab = (await page.getByTestId('project-tab-knowledge').first().textContent())?.trim() ?? ''
  const knowledgeHref = await page.getByTestId('project-tab-knowledge').first().getAttribute('href')
  console.log(`stage 7 -- the fourth tab reads ${JSON.stringify(knowledgeTab)} and goes to ${JSON.stringify(knowledgeHref)}`)
  if (knowledgeTab !== 'Knowledge') await fail(`stage 7: the fourth tab reads ${JSON.stringify(knowledgeTab)}, expected "Knowledge"`)
  if (knowledgeHref !== `/w/${workspaceId}/knowledge`) {
    await fail(`stage 7: the fourth tab goes to ${JSON.stringify(knowledgeHref)}`)
  }

  const briefLink = page.getByTestId('brief-knowledge')
  await waitVisible(briefLink, "the Overview's knowledge line")
  const briefText = (await briefLink.first().textContent())?.trim() ?? ''
  const briefHref = await briefLink.first().getAttribute('href')
  const counts = {
    verified: await prisma.memory.count({ where: { workspaceId, status: 'verified' } }),
    candidates: await prisma.memory.count({ where: { workspaceId, status: 'candidate' } }),
  }
  console.log(`stage 7 -- brief-knowledge reads ${JSON.stringify(briefText)}, href ${JSON.stringify(briefHref)}; the table says ${JSON.stringify(counts)}`)
  await assertEqual(briefText, `Knowledge: ${String(counts.verified)} verified · ${String(counts.candidates)} candidates`, 'stage 7: the Overview names both counts')
  await assertEqual(briefHref, `/w/${workspaceId}/knowledge`, 'stage 7: and links to the tab')

  // ---- the tab itself ---------------------------------------------------------------------------
  await gotoReliably(`${baseUrl}/w/${workspaceId}/knowledge`)
  await waitVisible(page.getByTestId('knowledge-rows'), 'the Knowledge list')
  const defaultRows = await knowledgeRows()
  console.log(`stage 7 -- rows under the default filter: ${String(defaultRows.length)}`)
  // `listMemories`' own three scopes: this project's rows, its company's, and those of the workers
  // on its teams. The last is not hypothetical here -- the verification that refused the fourth
  // probe taught the worker that wrote it, and that lesson is this project's to read.
  const liveCount = await prisma.memory.count({
    where: {
      status: { in: ['verified', 'candidate'] },
      OR: [{ workspaceId }, { slave: { team: { workspaceId } } }],
    },
  })
  await assertEqual(defaultRows.length, liveCount, "stage 7: one row per piece of this project's live knowledge")
  if (!defaultRows.some((row) => row.status === 'candidate')) {
    await fail('stage 7: no candidate row is on screen, so there is nothing for a person to verify')
  }

  // The raw-value scan, made HERE and while every `Where this came from` group is still folded --
  // `gate:m44`'s own assertion, on the one page it cannot reach with rows on it. The chain's raw
  // values live INSIDE a `DetailsGroup`, which renders no children at all until somebody asks, and
  // the positive counterpart below reads them back out of it once one is opened.
  {
    const shown = await readVisibleText()
    const offenders = shown.filter((entry) => FORBIDDEN_WORDS.some((word) => entry.text.includes(word)))
    console.log(`stage 7 -- ${String(shown.length)} rendered string(s) on the Knowledge tab, ${String(offenders.length)} carrying a raw value`)
    if (offenders.length > 0) {
      await fail(
        'stage 7: a database value is visible text on the Knowledge tab -- ' +
          offenders.slice(0, 10).map((o) => `inside ${o.where}: ${JSON.stringify(o.text.slice(0, 160))}`).join('; '),
      )
    }
  }

  // Labels, never keys (`docs/ia.md` rule 3), measured where a bare English word cannot hide it:
  // every chip and pill on every row carries the raw value in its own `title`, and its TEXT has to
  // be something else. Read over EVERY status, because `superseded` and `removed` are one link
  // away and are exactly the two words a list of live knowledge would never show.
  await gotoReliably(`${baseUrl}/w/${workspaceId}/knowledge?status=verified&status=candidate&status=superseded&status=removed`)
  await waitVisible(page.getByTestId('knowledge-rows'), 'every memory this project owns, at every status')
  {
    const chips = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="knowledge-row"]')].flatMap((row) =>
        [
          ...row.querySelectorAll(
            '[data-testid="knowledge-type"],[data-testid="knowledge-scope"],[data-testid="knowledge-confidence"],[data-testid="status-pill"]',
          ),
        ].map((node) => ({
          testid: node.getAttribute('data-testid'),
          text: (node.textContent ?? '').trim(),
          title: node.getAttribute('title'),
        })),
      ),
    )
    console.log(`stage 7 -- ${String(chips.length)} chip(s) across every row; the first six: ${JSON.stringify(chips.slice(0, 6))}`)
    const keyless = chips.filter((chip) => chip.title === null || chip.title === '')
    if (chips.length === 0) await fail('stage 7: no chips at all, so this assertion measures nothing')
    if (keyless.length > 0) await fail(`stage 7: ${String(keyless.length)} chip(s) keep no raw value at all: ${JSON.stringify(keyless.slice(0, 5))}`)
    const shouting = chips.filter((chip) => chip.text === chip.title)
    if (shouting.length > 0) {
      await fail(`stage 7: ${String(shouting.length)} chip(s) print their own raw value: ${JSON.stringify(shouting.slice(0, 5))}`)
    }
    const pillTitles = [...new Set(chips.filter((chip) => chip.testid === 'status-pill').map((chip) => chip.title))].sort()
    console.log(`stage 7 -- the statuses on screen, by their raw values: ${JSON.stringify(pillTitles)}`)
    for (const status of ['candidate', 'superseded', 'verified']) {
      if (!pillTitles.includes(status)) {
        await fail(`stage 7: no row on screen is ${status}, so "the label is not the key" is not measured for it`)
      }
    }
  }

  // The positive counterpart to the scan above, so its silence means something: the raw source kind
  // IS reachable -- folded inside the row it belongs to, which is `DetailsGroup`'s own contract
  // (ids, hashes and statuses live in the group so the row above stays a sentence).
  {
    const retired = page.locator(`[data-testid="knowledge-row"][data-memory-id="${observation.id}"]`)
    await waitVisible(retired, "the retired claim's row")
    await clickUntil(
      retired.locator('[data-testid="details-group"][data-group="provenance"] button').first(),
      async () => retired.getByTestId('knowledge-chain').first().isVisible(),
      "the retired claim's `Where this came from` group",
    )
    const opened = ((await retired.getByTestId('knowledge-chain').first().textContent()) ?? '').replace(/\s+/g, ' ').trim()
    console.log(`stage 7 POSITIVE -- the retired claim's chain, once a person asks: ${JSON.stringify(opened)}`)
    if (!opened.includes('run_output')) {
      await fail(`stage 7: the raw source kind is not reachable even inside the group: ${JSON.stringify(opened)}`)
    }
  }

  // ---- the filters, carried in the URL ----------------------------------------------------------
  await page.getByTestId('knowledge-filter-type').selectOption('fact')
  await waitUntil('the list to narrow to facts', ACTION_TIMEOUT_MS, async (note) => {
    const rows = await knowledgeRows()
    note(`${String(rows.length)} row(s), types ${JSON.stringify([...new Set(rows.map((r) => r.type))])}`)
    return rows.length > 0 && rows.every((row) => row.type === 'fact')
  })
  const factRows = await knowledgeRows()
  console.log(`stage 7 -- rows under type=fact: ${String(factRows.length)}, all of them facts`)
  if (factRows.some((row) => row.type !== 'fact')) await fail('stage 7: a non-fact row survived the kind filter')
  if (factRows.some((row) => row.id === candidate.id)) await fail('stage 7: the observation candidate is on screen under type=fact')
  const filteredUrl = page.url()
  console.log(`stage 7 -- the address bar now reads ${filteredUrl}`)
  if (!filteredUrl.includes('type=fact')) await fail(`stage 7: the filter is not in the link: ${filteredUrl}`)

  // ---- the provenance sentence, and the chain inside the row ------------------------------------
  await gotoReliably(`${baseUrl}/w/${workspaceId}/knowledge?type=fact&status=verified`)
  await waitVisible(page.getByTestId('knowledge-rows'), 'the verified facts')
  const correctionRow = page.locator(`[data-testid="knowledge-row"][data-memory-id="${correctionId}"]`)
  await waitVisible(correctionRow, "the corrected fact's row")
  const provenanceText = (await correctionRow.getByTestId('knowledge-provenance').first().textContent())?.trim() ?? ''
  console.log(`stage 7 -- knowledge-provenance on the corrected fact reads ${JSON.stringify(provenanceText)}`)
  for (const needle of ['from a person', SHAPE_TASK_TITLE, 'goal v', 'verified by a person']) {
    if (!provenanceText.includes(needle)) {
      await fail(`stage 7: the provenance sentence ${JSON.stringify(provenanceText)} does not say ${JSON.stringify(needle)}`)
    }
  }
  await clickUntil(
    correctionRow.locator('[data-testid="details-group"][data-group="provenance"] button').first(),
    async () => correctionRow.getByTestId('knowledge-chain').first().isVisible(),
    "the corrected fact's `Where this came from` group",
  )
  const chain = await correctionRow
    .locator('[data-testid="knowledge-chain-link"]')
    .evaluateAll((nodes) => nodes.map((node) => ({ id: node.getAttribute('data-memory-id'), text: (node.textContent ?? '').trim() })))
  console.log(`stage 7 -- the chain inside the row: ${JSON.stringify(chain)}`)
  if (!chain.some((link) => link.id === fact.id)) {
    await fail(`stage 7: the expanded row does not name the memory it replaced (${fact.id}): ${JSON.stringify(chain)}`)
  }

  // ---- Verify, on a claim nothing checked -------------------------------------------------------
  await gotoReliably(`${baseUrl}/w/${workspaceId}/knowledge?status=candidate`)
  await waitVisible(page.getByTestId('knowledge-rows'), 'the unverified claims')
  const candidateRow = page.locator(`[data-testid="knowledge-row"][data-memory-id="${candidate.id}"]`)
  await waitVisible(candidateRow, "the unverified claim's row")
  await clickUntil(
    candidateRow.getByTestId('knowledge-verify').first(),
    async () => (await prisma.memory.findUniqueOrThrow({ where: { id: candidate.id } })).status === 'verified',
    'Verify on the unverified claim',
  )
  const verifiedNow = await prisma.memory.findUniqueOrThrow({ where: { id: candidate.id } })
  console.log(`stage 7 -- the claim after a person verified it: ${describeMemory(verifiedNow)}`)
  await assertEqual({ status: verifiedNow.status, verifiedBy: verifiedNow.verifiedBy }, { status: 'verified', verifiedBy: 'human' }, 'stage 7: a person verified it')
  await gotoReliably(`${baseUrl}/w/${workspaceId}/knowledge?status=verified`)
  await waitVisible(page.locator(`[data-testid="knowledge-row"][data-memory-id="${candidate.id}"]`), 'the claim, now under Verified')
  const verifiedPill = (await page
    .locator(`[data-testid="knowledge-row"][data-memory-id="${candidate.id}"] [data-testid="status-pill"]`)
    .first()
    .textContent())?.trim()
  console.log(`stage 7 -- after a reload its pill reads ${JSON.stringify(verifiedPill)}`)
  if (verifiedPill !== 'Verified') await fail(`stage 7: the pill reads ${JSON.stringify(verifiedPill)}, expected "Verified"`)

  // ---- Correct, through the drawer --------------------------------------------------------------
  const toCorrect = seededIds[0]
  await gotoReliably(`${baseUrl}/w/${workspaceId}/knowledge?q=M49%20gate%20fact%201`)
  await waitVisible(page.locator(`[data-testid="knowledge-row"][data-memory-id="${toCorrect}"]`), 'the fact a person is about to correct')
  await clickUntil(
    page.locator(`[data-testid="knowledge-row"][data-memory-id="${toCorrect}"] [data-testid="knowledge-correct"]`).first(),
    async () => page.getByTestId('knowledge-correct-drawer').first().isVisible(),
    'Correct',
  )
  const CORRECTED_TITLE = 'M49 gate fact 1, corrected by a person'
  await page.getByTestId('knowledge-correct-title').fill(CORRECTED_TITLE)
  await page.getByTestId('knowledge-correct-body').fill('A person read this one again and wrote it down properly.')
  await clickUntil(
    page.getByTestId('knowledge-correct-save').first(),
    async () => (await prisma.memory.findUniqueOrThrow({ where: { id: toCorrect } })).status === 'superseded',
    'Save the correction',
  )
  const correctedOld = await prisma.memory.findUniqueOrThrow({ where: { id: toCorrect } })
  const correctedNew = await prisma.memory.findUniqueOrThrow({ where: { id: correctedOld.supersededById ?? '' } })
  console.log(`stage 7 -- the corrected pair:\n  ${describeMemory(correctedOld)}\n  ${describeMemory(correctedNew)}`)
  await assertEqual(correctedNew.title, CORRECTED_TITLE, "stage 7: the correction carries the person's own title")
  await waitUntil('the list to show the corrected title', ACTION_TIMEOUT_MS, async (note) => {
    const rows = await page.getByTestId('knowledge-row').evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').trim()))
    note(`${String(rows.length)} row(s)`)
    return rows.some((text) => text.includes(CORRECTED_TITLE))
  })
  console.log('stage 7 -- the list shows the corrected title without a reload')

  // ---- Remove, with a reason, and the row still THERE --------------------------------------------
  const toRemove = seededIds[1]
  const REMOVAL_REASON = 'this one turned out to be about a different project'
  await gotoReliably(`${baseUrl}/w/${workspaceId}/knowledge?q=M49%20gate%20fact%202`)
  const removeRow = page.locator(`[data-testid="knowledge-row"][data-memory-id="${toRemove}"]`)
  await waitVisible(removeRow, 'the fact a person is about to withdraw')
  await removeRow.getByTestId('knowledge-remove-reason').first().fill(REMOVAL_REASON)
  await clickUntil(
    removeRow.getByTestId('knowledge-remove').first(),
    async () => removeRow.getByTestId('knowledge-remove-confirm').first().isVisible(),
    'Remove',
  )
  await clickUntil(
    removeRow.getByTestId('knowledge-remove-confirm').first(),
    async () => (await prisma.memory.findUniqueOrThrow({ where: { id: toRemove } })).status === 'removed',
    'the removal confirmation',
  )
  const removed = await prisma.memory.findUniqueOrThrow({ where: { id: toRemove } })
  console.log(`stage 7 -- the withdrawn memory: ${describeMemory(removed)}, reason ${JSON.stringify(removed.removedReason)}`)
  await assertEqual({ status: removed.status, removedReason: removed.removedReason }, { status: 'removed', removedReason: REMOVAL_REASON }, 'stage 7: withdrawn, with the reason a person typed')
  // Nothing is deleted: it is one filter away, with the reason on screen.
  await gotoReliably(`${baseUrl}/w/${workspaceId}/knowledge?status=removed`)
  const removedRow = page.locator(`[data-testid="knowledge-row"][data-memory-id="${toRemove}"]`)
  await waitVisible(removedRow, 'the withdrawn row under the removed filter')
  const removedReasonText = (await removedRow.getByTestId('knowledge-removed-reason').first().textContent())?.trim() ?? ''
  console.log(`stage 7 -- under the removed filter it reads ${JSON.stringify(removedReasonText)}`)
  if (!removedReasonText.includes(REMOVAL_REASON)) {
    await fail(`stage 7: the withdrawn row does not carry the reason: ${JSON.stringify(removedReasonText)}`)
  }
  const actionsOnFrozenRow = await removedRow.getByTestId('knowledge-correct').count()
  console.log(`stage 7 -- Correct buttons offered on a withdrawn row: ${String(actionsOnFrozenRow)}`)
  if (actionsOnFrozenRow !== 0) await fail('stage 7: a withdrawn row offers a button that can only fail')

  // ---- the task drawer's memories group ----------------------------------------------------------
  await gotoReliably(`${baseUrl}/w/${workspaceId}/tasks`)
  await waitVisible(page.getByTestId('column'), 'the task board')
  const shapeCard = page.getByTestId('task-card').filter({ hasText: SHAPE_TASK_TITLE })
  await waitVisible(shapeCard, "the first task's card")
  await clickUntil(
    shapeCard.first(),
    async () => page.locator('aside [data-testid="details-group"][data-group="memories"]').first().isVisible(),
    "the first task's card",
  )
  const memoriesGroup = page.locator('aside [data-testid="details-group"][data-group="memories"]')
  await clickUntil(
    memoriesGroup.locator('button').first(),
    async () => page.getByTestId('task-memories-open').first().isVisible(),
    "the task drawer's Knowledge group",
  )
  await clickUntil(
    page.getByTestId('task-memories-open').first(),
    async () => page.getByTestId('task-memory-produced').first().isVisible(),
    'What this task knew, and what it taught',
  )
  const produced = await page
    .locator('[data-testid="task-memory-produced"] [data-testid="task-memory-row"]')
    .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim()))
  const received = await page
    .locator('[data-testid="task-memory-received"] [data-testid="task-memory-row"]')
    .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim()))
  console.log(`stage 7 -- the task produced: ${JSON.stringify(produced)}`)
  console.log(`stage 7 -- the task was given: ${JSON.stringify(received)}`)
  if (produced.length < 2) await fail(`stage 7: the drawer lists ${String(produced.length)} things this task taught, expected the candidate and the fact`)
  if (!produced.some((text) => text.startsWith('Observation') && text.includes('Superseded'))) {
    await fail(`stage 7: the drawer does not show the retired claim this task left behind: ${JSON.stringify(produced)}`)
  }
  if (!produced.some((text) => text.startsWith('Fact'))) {
    await fail(`stage 7: the drawer does not show the fact this task proved: ${JSON.stringify(produced)}`)
  }

  console.log(
    'stage 7 PASSED: six tabs with Knowledge fourth, one row per piece of live knowledge with the filters in the link, the ' +
      'sentence that says where a fact came from and the chain inside its own row, a claim verified, a memory corrected and ' +
      'one withdrawn with a reason and still findable -- and not one database value on screen',
  )

  // ============================================================================================
  // Stage 8: this gate wrote nothing into this repository.
  // ============================================================================================
  const gitStatusAfter = gitStatus()
  if (gitStatusAfter !== gitStatusBefore) {
    await fail(
      `stage 8: this gate changed the working tree.\n--- before ---\n${gitStatusBefore}\n--- after ---\n${gitStatusAfter}`,
    )
  }
  console.log('stage 8 PASSED: `git status --porcelain` says exactly what it said before this gate started')

  console.log(`gotoReliably retries this run: ${String(gotoRetries.length)}${gotoRetries.length === 0 ? '' : ` (${JSON.stringify(gotoRetries)})`}`)
  console.log(
    'PASS: what this organisation learns is kept as knowledge rather than as a transcript -- a worker’s own closing report ' +
      'became a candidate nobody was given, the verification that passed turned it into a fact whose words are the contract ' +
      'it proved and retired the candidate in the same breath, a rejected review taught the worker who wrote the diff and ' +
      'not the one who caught it, a person’s approval and a changed goal were both recorded as decisions with the rationale ' +
      'behind them, the very next run’s recorded prompt carried exactly that knowledge and none of the candidate, one ' +
      'correction typed at the CLI left a chain of two with the old wording still readable, twenty facts became one summary ' +
      'the next run was given instead of them, and the Knowledge tab did all four of its verbs in a browser with nothing but ' +
      'labels on screen',
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
  for (const id of [workspaceId, workspaceId2]) {
    if (id === null) continue
    // Vendor children BEFORE the rows they are named on, `gate-m13-runtime`'s rule.
    const runs = await prisma.slaveRun.findMany({ where: { slave: { team: { workspaceId: id } } }, select: { pid: true } }).catch(() => [])
    for (const run of runs) {
      if (run.pid === null || !isAlive(run.pid)) continue
      try {
        process.kill(run.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    await deleteWorkspaceDeeply(id)
  }
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  if (repoPath2 !== null) rmSync(repoPath2, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
