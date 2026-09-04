// M14's own gate (Task 17 brief, spec §6): "nine pages, one design".
//
// `gate-m11-shell.mjs`'s shape -- a real `next dev`, a real Chromium through `playwright-core`,
// every assertion re-read from prisma or from the DOM -- with `gate-m13-runtime.mjs`'s newer
// `waitUntil` protocol, its browser helpers (`waitVisible`/`clickUntil`, verbatim; `fillReliably`
// and `selectReliably` are left behind -- this gate types into no form and selects no option, and a
// copied helper nothing calls is dead code, not fidelity) and its `finally` ordering. Dist imports only, one
// top-level `try` with no `catch`, `let exitCode = 1` set to `0` only by falling off the end of
// the try, and `process.exit(exitCode)` as the literal last line.
//
// UNLIKE m12/m13 THIS GATE SPENDS NOTHING and is not allowed to: its behaviour stage runs the fake
// CLI from `scripts/gate-fakes/`, and the preflight below REFUSES to start unless
// `AITEAMOS_CLAUDE_BIN` points at an executable under that directory. A fidelity gate that could
// reach a real account is a fidelity gate nobody will run (Decision 10).
//
//   AITEAMOS_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m14-fidelity
//
// The five stages of spec §6:
//   1. nine pages render at 1440x900 with their structural testids, each screenshotted into
//      `docs/superpowers/fidelity/m14/<page>.png` and committed;
//   2. every README number read back from `getComputedStyle`, failing by page + property;
//   3. motion: a `working` card sweeps and an in-flight pill pulses; under emulated
//      `prefers-reduced-motion: reduce` NOTHING reports an `animation-name`;
//   4. behaviour: two-step STOP -> halt banner on every workspace-scoped page -> clear halt; a
//      fake-CLI run reaches `working`, a pause shows `pause_requested` then `paused`; a roster
//      click filters the stream and dims the rest;
//   5. data: after `syncSkillCatalog` the Skills page lists a `plugin:superpowers` provider, and
//      Analytics' seven-day counts equal an INDEPENDENT SQL count.
//
// ---- STAGE ORDER, and why it is not 1..5 ---------------------------------------------------
//
// Executed as: 1, 2a, 4a, 4b(dispatch), 3b, 2b, 3a, 4b(pause), 4c, 5. Three of the spec's own
// facts are only observable while a run is LIVE, and the seeded development database has no runs:
//
//   - 3b (the sweep and the pulse) needs a card whose state is `working`. `AgentCard` renders
//     `card-sweep` ONLY in that state, and `CARD_STATE_TONE.working.pulse` is what puts the
//     keyframe on the pill's dot. Neither element exists on an idle board at all.
//   - 2b (the cable's `stroke-dasharray`) needs an ACTIVE edge. `CableEdge` draws
//     `path[data-cable="flow"]` only when `data.active` is true, and `buildOrgGraph` sets that
//     from `agent.status !== 'idle'`. An idle org graph has no dashed cable to measure.
//   - 3a (reduced motion) is worth far more AFTER 3b than before it: run first, it proves that a
//     page with nothing animating has nothing animating. Run second, against the very card and
//     pill 3b just measured, it proves the media block actually kills live motion.
//
// So the run comes before them, and the STOP/halt half of stage 4 comes before the run (a halted
// workspace starts nothing, so halting first and clearing the halt costs nothing and keeps the
// banner out of every screenshot).
//
// ---- WHAT THIS GATE PUTS IN THE DATABASE, AND TAKES BACK OUT -------------------------------
//
// One workspace (`M14 Gate Project <iso>`), one team, one worker, one task, and THREE historical
// terminal runs. The historical rows exist for stage 5: a brand-new workspace has an empty
// seven-day series, and `0 === 0` is not a test of an aggregation. They are ordinary `AgentRun`
// rows on real days with real terminal statuses -- the same rows a week of work would leave -- and
// the SQL in stage 5 counts them independently of the page that draws them. Everything is deleted
// in `finally`, in FK order.
//
// The `SkillProvider`/`Skill` rows `syncSkillCatalog` writes are deliberately NOT deleted: the
// catalog is a fact about the daemon host's disk, not about this gate's workspace, and Decision 6
// says the catalog never deletes.

import { execFileSync, spawn } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
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
import { isAlive, syncSkillCatalog } from '../packages/control/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'

const POLL_INTERVAL_MS = 25
const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const DISPATCH_TIMEOUT_MS = 180_000
const WORKING_TIMEOUT_MS = 120_000
const PAUSE_SETTLE_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

// How long the fake CLI waits between its tool calls. The default (700ms) gives an eight-step run
// a five-second working window -- shorter than a single `next dev` first compile, so every
// assertion that needs a LIVE run would be racing the run's own end. 40s a step holds the run
// `working` for the better part of five minutes; the fake polls the pause flag every 50ms
// regardless, so nothing about the pause path is slowed down by it, and the workspace's own
// `runTimeoutMs` (30 minutes) is never approached.
const FAKE_STEP_GAP_MS = '40000'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const SHOTS_DIR = join(repoRoot, 'docs/superpowers/fidelity/m14')
const runTimestamp = new Date().toISOString()

// Suffixed per run (the `gate-m10-org.mjs` idiom): `Workspace.name` has no unique constraint, and a
// distinct name per run keeps two overlapping executions from reading each other's rows.
// `preflightCleanup` still removes leftovers by PREFIX. The suffix is the run's WALL CLOCK, not its
// full ISO timestamp, because this name is rendered into six of the nine committed screenshots (the
// top bar, the graph's workspace node, the Projects card, the permission matrix's section label) and
// a 24-character suffix pushes those elements around for no reader's benefit.
const WORKSPACE_PREFIX = 'M14 Gate Project'
const WORKSPACE_NAME = `${WORKSPACE_PREFIX} ${runTimestamp.slice(11, 19)}`
const WORKER_NAME = 'Gate Worker'
const PASS_LINE = 'nine pages, one design'

// The pair a dispatch resolves on. `resolveRuntime` only consults a level that NAMES a model, so
// the worker carries both halves explicitly rather than falling through to a workspace default
// this gate never sets.
const WORKER_MODEL = 'sonnet'
const WORKER_PROVIDER = 'claude_code'

const TASK_TITLE = 'Create two small files'
const TASK_DESCRIPTION = [
  'Create a file named hello.txt whose entire contents are the word: hi',
  'Then create a second file named world.txt whose entire contents are the word: there',
].join('\n')

let exitCode = 1
let repoPath = null
let workspaceId = null
let teamId = null
let agentId = null
let taskId = null
let daemon = null
let daemonOutput = ''
/** The browser console, newest last, for `fail()`'s dump (which reads only the tail, `.slice(-40)`
 *  -- see `fail()` below) and for `gotoReliably`'s `raced()` window (see there). Includes
 *  `pageerror` text too (pushed alongside `console`/`requestfailed` via `pushBrowserConsole`
 *  below) -- a page that crashes client-side says so ONLY as a `pageerror`, and a dump that cannot
 *  show that is not a dump of what the browser actually saw.
 *
 *  APPEND-ONLY for the life of one gate run -- it used to cap-and-shift at 200 entries, but
 *  `raced()` records a starting INDEX into this array and reads forward from it; once the array
 *  had ever reached the old cap, its length stopped growing and every `slice(consoleStart)` taken
 *  afterward returned `[]` forever, silently killing the client-side half of the signature check
 *  for the rest of the run -- invisible in a passing run, and a real client-side manifest race
 *  late in a 9-page run would have hard-FAILED the gate instead of retrying (review finding, fix
 *  round 3). `fail()`'s own dump already bounds itself at read time, so nothing needs this array
 *  bounded; `pushBrowserConsole` only WARNS past an unreasonable size, it never truncates. */
const browserConsole = []

/** The only way anything appends to `browserConsole` -- keeps every listener below consistent
 *  (one used to cap-and-shift, one didn't, which was itself part of the bug this replaces). */
function pushBrowserConsole(text) {
  browserConsole.push(text.slice(0, 300))
  if (browserConsole.length % 10_000 === 0) {
    console.warn(
      `browserConsole has grown to ${String(browserConsole.length)} entries this run -- unusually chatty ` +
        `for one gate run, but left append-only on purpose (see its declaration) rather than truncated`,
    )
  }
}
/** `next dev`'s own raw stdout, module-level (not scoped to the try block that spawns it) so
 *  `gotoReliably` below can read its tail without a parameter -- the exact same reason
 *  `browserConsole` is module-level. */
let nextOutput = ''
let daemonExited = false
let nextServer = null
let browser = null
let page = null
let diagDir = null
/** The exact text `next dev`'s manifest race throws, both server- and client-side (M17 Task 7,
 *  Flake 6 investigation) -- the only signature `gotoReliably` treats as license to retry a
 *  5xx/thrown navigation. An application 500 that does NOT carry this text fails the gate
 *  immediately instead, by design (review finding, fix round 2: retrying every 5xx silently heals
 *  real regressions too). */
const MANIFEST_RACE_SIGNATURE = 'Unexpected end of JSON input'
/** Every URL `gotoReliably` has retried, in call order (duplicates kept) -- printed beside the
 *  gate's PASS line so a rising rate is visible in GREEN runs too, not only in a `fail()` dump
 *  (review finding, fix round 2: a retry with no accounting is the M16 lesson's exact shape). */
const gotoRetries = []

/** `gate-m13-runtime.mjs`'s `makeRepo`: a real repository, because the tick provisions a real
 *  `git worktree` in it. */
function makeRepo(suffix) {
  const dir = mkdtempSync(join(tmpdir(), `aiteamos-gate-m14-${suffix}-`))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/** Asks the OS for a free TCP port. `next dev -p <port>` still auto-increments if something grabs
 *  it between this call and the spawn, so the ready-wait parses the ACTUAL bound port back out of
 *  `next dev`'s own "http://localhost:<port>" line rather than trusting this one blindly. */
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

/** `gate-m13-runtime.mjs`'s location-based stray sweep, verbatim but for this gate's one repo root.
 *  `fake-claude.sh` leaves a detached `fake-worker-server.sh` behind on purpose, and no row records
 *  it -- so the record-based kill cannot reach it and this can. */
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

/** Removes any `M14 Gate`-named rows a prior interrupted run left behind, in the same FK order the
 *  `finally` block below uses: the append-only events first (no FK to `Workspace`), then the
 *  workspace, which cascades Team/Agent/Task/AgentRun/Checkpoint/ProviderConfiguration. */
async function preflightCleanup() {
  const stale = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true },
  })
  for (const workspace of stale) {
    console.log(`preflight: removing leftover workspace ${workspace.id} (${workspace.name})`)
    // A leftover workspace can still own a LIVE child if a prior execution was killed before its
    // own `finally` ran. Deleting the row would lose the only record of that pid, so the kill comes
    // first here for the same reason it comes first in `finally`.
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

/** Every `M14 Gate`-named workspace, run and event still in the DB, for a FAIL's diagnostic dump --
 *  scoped by workspace NAME rather than by this run's own tracked ids, since a failure can happen
 *  before some of those ids are even set. */
async function dumpGateRows() {
  const workspaces = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true, budgetUsd: true, haltedReason: true },
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
        costUsd: run.costUsd,
        startedAt: run.startedAt,
        terminalAt: run.terminalAt,
      })),
      events: events.map((event) => ({ seq: event.seq, runId: event.runId, type: event.type, payload: event.payload })),
    })
  }
  // `ExecutionEvent.seq` is a BigInt; `JSON.stringify` refuses it outright, and a diagnostic dump
  // that throws is a diagnostic dump that is not there when it is needed.
  return JSON.stringify(dump, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
}

/** The m8a-estop-style diagnostic throw: the state that made the call, not just "it timed out". */
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

/**
 * Polls `probe` until it reports `{ done: true }`, then returns its `value`.
 *
 * `probe` returns its own `detail` string on every unsatisfied tick, and that string is what the
 * timeout message reports -- so a wait that runs out says what it last SAW rather than only what
 * it wanted. Every wait in this file goes through here for that reason.
 */
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

// ---- Browser helpers, `gate-m13-runtime.mjs`'s verbatim --------------------------------------

/** Bounded-waits for `locator` to become visible; a timeout routes through `fail` for the full
 *  diagnostic dump instead of a bare Playwright TimeoutError. */
async function waitVisible(locator, description) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
  } catch {
    await fail(`timed out waiting for ${description} to become visible`)
  }
}

/**
 * `page.goto`, retried once -- but ONLY when the failure carries `next dev`'s own manifest-race
 * signature (`MANIFEST_RACE_SIGNATURE`, module-level). Everything else -- an application 500, a
 * genuine navigation failure with no such text anywhere in the browser console or `next dev`'s
 * own stdout since this call started -- fails the gate immediately, through `fail()`, with the
 * usual dump. A retry that heals ANY 5xx would just as happily heal a real regression and let the
 * run go green over it (review finding, fix round 2).
 *
 * M17 Task 7's Flake 6 investigation reproduced `SyntaxError: Unexpected end of JSON input` live,
 * server- and client-side, on three different pages across three different gate runs --
 * `next/dist/server/load-manifest.external.js`'s `loadManifest` is a bare `readFileSync` +
 * `JSON.parse`, no lock, no atomic rename, and its cache is invalidated on every compile; a
 * request landing while a DIFFERENT route's compile is mid-rewrite of a shared manifest reads a
 * torn file and 500s. Widening `next.config.ts`'s on-demand-entries buffer and warming every
 * route before the browser arrives (both above, unchanged) cut how OFTEN this fires -- neither
 * closes it: `next dev` still recompiles its client-HMR runtime chunk on ordinary navigation
 * regardless of either. The write that tears a read finishes in milliseconds, so the fix that
 * actually closes this is the one the symptom itself proves works -- the SAME failing run's very
 * next request always succeeded (both live reproductions self-healed on retry, seconds later,
 * with no code change). One retry, after a beat for the in-flight write to finish, standing in
 * for that -- and the retry itself is guarded: if IT also 5xxs or throws, that goes through
 * `fail()` too, never escaping as a raw Playwright error (review finding, fix round 2).
 */
async function gotoReliably(url) {
  const consoleStart = browserConsole.length
  const nextOutputStart = nextOutput.length
  /** True once the manifest-race text has shown up in EITHER channel since this call started. A
   *  short beat is given before the FIRST check (below) because the client-side `pageerror` for a
   *  torn read can land a tick after `page.goto`'s own promise settles. */
  const raced = () =>
    browserConsole.slice(consoleStart).some((line) => line.includes(MANIFEST_RACE_SIGNATURE)) ||
    nextOutput.slice(nextOutputStart).includes(MANIFEST_RACE_SIGNATURE)

  /** One description for every outcome of a `page.goto` attempt -- thrown, resolved `null`
   *  (Playwright's own contract for a same-document/anchor navigation; unexpected here, but never
   *  trusted not to happen), or a real `Response`. Used both for `fail()`'s message and the retry
   *  log line, so there is exactly one place that ever calls `.status()` -- always behind the
   *  `response !== null` guard right beside it (review finding, fix round 3: the ORIGINAL version
   *  guarded `.status()` on the fast-path return but not in the message it built when the first
   *  attempt resolved `null` with no thrown error, and never guarded it at all on the second
   *  attempt -- a null response there escaped as a raw, undump'd `TypeError`, not through `fail()`). */
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

  await delay(50) // the beat `raced()`'s docstring names
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

/** Clicks `locator`, then bounded-waits for `predicate`. Deliberately does NOT re-click on every
 *  poll tick -- ordinary request latency is not a hydration race, and re-clicking would send a
 *  second real POST while the first is still in flight. A single retry click fires only once the
 *  full first wait is exhausted, by which time a genuine no-op click is the only explanation. */
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
  diagDir = mkdtempSync(join(tmpdir(), 'aiteamos-gate-m14-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ---- Preflight. Every one of these fails FAST and by name: this gate never skips a stage, so an
  // unrunnable precondition has to be an error here rather than a stage quietly doing nothing.

  // Zero spend, ENFORCED (Decision 10). This is the ONE gate in the repo that refuses to run
  // against a real binary, rather than merely offering a rehearsal mode.
  const fakeClaude = process.env['AITEAMOS_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'AITEAMOS_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  AITEAMOS_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m14-fidelity',
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
    throw new Error(
      `no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m14-fidelity passes ` +
        '--env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m14-fidelity`')
  }
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- every stage of this gate reads a real rendered page, so set ` +
        'CHROMIUM_PATH to a real executable (e.g. a playwright-installed chromium under ' +
        '~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome).',
    )
  }
  if (!existsSync(ORCHESTRATOR_CLI)) {
    throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI} -- run \`npm run build\` (or the gate's own tsc --build)`)
  }
  try {
    await prisma.$queryRaw`select 1`
  } catch (cause) {
    throw new Error(
      `the database at DATABASE_URL is not reachable (${cause instanceof Error ? cause.message : String(cause)}) -- ` +
        'start Postgres and apply migrations before running this gate.',
    )
  }
  console.log(`fake claude: ${fakeClaude}`)
  console.log(`chromium:    ${chromiumPath}`)
  mkdirSync(SHOTS_DIR, { recursive: true })

  await preflightCleanup()

  // ---- One workspace, one team, one worker, one task -- enough for every page to have real rows.
  repoPath = makeRepo('repo')
  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath,
      autoMerge: true,
      verifyCommands: ['true'],
      setupCommands: [],
      goal: 'prove the nine pages render on real data',
    },
  })
  workspaceId = workspace.id
  teamId = (await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })).id
  agentId = (
    await prisma.agent.create({
      data: { teamId, name: WORKER_NAME, role: 'backend', provider: WORKER_PROVIDER, model: WORKER_MODEL },
    })
  ).id
  taskId = (
    await prisma.task.create({
      data: {
        workspaceId,
        title: TASK_TITLE,
        description: TASK_DESCRIPTION,
        status: 'ready',
        requiredRole: 'backend',
        // Two, because stage 4 pauses this task's run and a `maxAttempts: 1` task whose run never
        // concludes would park `failed` the moment anything reworked it. Bounded by there being
        // exactly one task in the workspace and the daemon running for one stage.
        maxAttempts: 2,
      },
    })
  ).id
  console.log(`workspace ${workspaceId}; team ${teamId}; worker ${agentId}; task ${taskId}`)

  // Three historical terminal runs, on three different days inside the seven-day window, so stage
  // 5 has a real series to compare against SQL and the Analytics screenshot shows a real chart.
  // Ordinary rows, written the way a week of finished work would have written them.
  const HISTORICAL_RUNS = [
    { daysAgo: 4, status: 'succeeded', costUsd: 0.11, tokensIn: 1200, tokensOut: 900, toolCalls: 6 },
    { daysAgo: 2, status: 'succeeded', costUsd: 0.07, tokensIn: 800, tokensOut: 400, toolCalls: 3 },
    { daysAgo: 1, status: 'failed', costUsd: 0.02, tokensIn: 300, tokensOut: 120, toolCalls: 1 },
  ]
  for (const historical of HISTORICAL_RUNS) {
    // Noon UTC on the day, so a run can never straddle a bucket boundary the way an
    // end-of-day timestamp could when this gate runs near midnight.
    const day = new Date()
    day.setUTCHours(12, 0, 0, 0)
    day.setUTCDate(day.getUTCDate() - historical.daysAgo)
    const ended = new Date(day.getTime() + 4 * 60_000)
    await prisma.agentRun.create({
      data: {
        agentId,
        status: historical.status,
        provider: WORKER_PROVIDER,
        costUsd: historical.costUsd,
        tokensIn: historical.tokensIn,
        tokensOut: historical.tokensOut,
        toolCalls: historical.toolCalls,
        startedAt: day,
        endedAt: ended,
        terminalAt: ended,
      },
    })
  }
  console.log(`seeded ${String(HISTORICAL_RUNS.length)} historical terminal runs inside the 7-day window`)

  // The catalog, read from THIS host's disk. Done before stage 1 so the Skills screenshot is of a
  // real catalog rather than of an empty page; stage 5 syncs again and asserts what came back.
  const firstSync = await syncSkillCatalog()
  console.log(
    `syncSkillCatalog: ${String(firstSync.upserted)} skill(s), ${String(firstSync.markedMissing)} marked missing, ` +
      `skipped roots ${JSON.stringify(firstSync.skippedRoots)}`,
  )

  // ---- The real web shell, on a free port, and a real browser.
  const preferredPort = await findFreePort()
  nextServer = spawn('node', ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort)], {
    cwd: repoRoot,
    // `AITEAMOS_GATE_WARM=1` widens `next.config.ts`'s on-demand-entries buffer for THIS `next
    // dev` only (M17 Task 7, Flake 6 investigation) -- see that file for the mechanism. An
    // ordinary developer's `next dev` never sets this and keeps Next's defaults.
    // M21 A1: the operator's AITEAMOS_SESSION_SECRET must not reach the child, or every page is /login.
    env: loopbackChildEnv({ AITEAMOS_GATE_WARM: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // `nextOutput` itself is module-level now (see its declaration near `browserConsole`) so
  // `gotoReliably` can read its tail; this block still owns writing to it.
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

  // ---- Warm every route once, synchronously, before the browser (or any concurrent client
  // polling) exists. M17 Task 7's Flake 6 investigation reproduced `SyntaxError: Unexpected end
  // of JSON input` twice live -- once server-side on `/analytics` (a page already compiled
  // minutes earlier), once on `/w/[workspaceId]/tasks` -- both mid-burst, once a live run started
  // firing several routes' FIRST compiles at once. `next/dist/server/load-manifest.external.js`'s
  // `loadManifest` is the reason: `readFileSync` then `JSON.parse`, no atomic rename, no lock, and
  // its cache is invalidated on every compile -- so a request landing while a DIFFERENT route's
  // compile is mid-rewrite of a shared manifest reads a torn file and throws exactly that error,
  // server-side, and the client sees the identical text when the broken flight payload it was
  // streaming reaches the browser. Warming every route here, one at a time, means nothing compiles
  // for the first time once the interactive stages begin -- no later request can race a write that
  // never happens again. Covers page.tsx AND route.ts: the SSE route is compiled the same lazy way
  // and is exactly what Flake 6's original evidence named missing (no `/activity/stream` request
  // at all) -- `fetch` on it is cancelled the instant headers land, since its body never closes on
  // its own.
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
  // 1440x900 (spec §6 stage 1), wider than m11/m13's 1280 -- the Agents grid's `1fr` column needs
  // the room, and a screenshot taken at a narrower width is not the design being reviewed.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  // The browser's own console, kept for the failure dump: a page that renders on the server and
  // then never hydrates says why only here (a chunk that 404'd, a hydration mismatch, a thrown
  // effect), and a gate that times out on "no row became visible" without it is a gate that
  // cannot say what it saw. `pageerror` is pushed into the SAME array (not just printed) -- a
  // client-side crash says so ONLY as a `pageerror`, never as a `console` message, and
  // `gotoReliably`'s signature check reads this array (review finding, fix round 2: it read only
  // `browserConsole`, which never actually held the client-side text it was checking for). All
  // three listeners go through `pushBrowserConsole` (append-only -- see its declaration; review
  // finding, fix round 3, also closes the pre-existing inconsistency where this listener and
  // `console`'s capped-and-shifted while `requestfailed`'s did neither).
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
  // Stage 1: nine pages render, and each is screenshotted.
  // ============================================================================================
  const PAGES = [
    { name: 'overview', path: () => `/w/${workspaceId}`, testId: 'strip' },
    { name: 'agents', path: () => '/agents', testId: 'data-table' },
    { name: 'tasks', path: () => `/w/${workspaceId}/tasks`, testId: 'column' },
    { name: 'graph', path: () => `/w/${workspaceId}/graph`, testId: 'graph-canvas' },
    // `timeline-viewport`, not `timeline-rule`: the rule is absolutely positioned inside the
    // virtualizer's sized spacer, so on a workspace with no events yet it is ATTACHED but zero-high
    // and no visibility wait can pass. The rule is measured in stage 2 (where `getComputedStyle`
    // reads its inline `left` regardless of size) and required VISIBLE in the live re-capture pass
    // below, once the run has put real rows in the river.
    { name: 'activity', path: () => `/w/${workspaceId}/activity`, testId: 'timeline-viewport' },
    { name: 'projects', path: () => '/', testId: 'project-card' },
    { name: 'skills', path: () => '/skills', testId: 'empty-tile' },
    { name: 'analytics', path: () => `/analytics?workspace=${workspaceId}`, testId: 'kpi-tile' },
    // The GLOBAL Settings page (M24 §4): provider adapters, security, danger zone -- the
    // permission matrix moved to the project Settings tab, so `security-posture` is this page's
    // own structural marker now (`perm-caption` is asserted separately, on `/w/<id>/settings`,
    // right after the README numbers below).
    { name: 'settings', path: () => '/settings', testId: 'security-posture' },
  ]
  /** The four pages whose content changes once a run is live; re-captured after stage 4b so the
   *  committed evidence shows the design doing its job, not an empty board. */
  const LIVE_PAGES = new Set(['overview', 'tasks', 'graph', 'activity'])

  /**
   * Waits for ELK to finish positioning the org graph.
   *
   * `useLayoutedGraph` lays out asynchronously (`elkjs` is dynamically imported and the layout is
   * awaited), so for the first frames after mount every node sits at the origin. `GraphCanvas` now
   * re-fits from an effect once the layouted positions land, at `maxZoom: 1` (M14 fix wave, review
   * I7) -- before that fix the bare `fitView` prop ran once at init against exactly those stacked
   * nodes and never re-fitted, and a screenshot taken on arrival was a pile of overlapping boxes.
   * The wait below is still for the layout, and the `fitView` control click after it is the
   * ordinary operator affordance React Flow puts on the canvas, kept as a belt-and-braces settle.
   */
  async function settleGraph() {
    await waitUntil('the graph layout to place every node somewhere of its own', 30_000, async () => {
      const positions = await page
        .locator('.react-flow__node')
        .evaluateAll((nodes) => nodes.map((node) => node.style.transform))
      if (positions.length < 2) return { done: false, detail: `${String(positions.length)} node(s) rendered` }
      const distinct = new Set(positions)
      return distinct.size === positions.length
        ? { done: true, value: positions.length }
        : { done: false, detail: `${String(positions.length)} node(s) share ${String(distinct.size)} position(s)` }
    })
    // The automatic fit must have landed BEFORE anyone clicks the control: the first M14 fix
    // keyed the re-fit on the `nodes` prop and read the store a commit too early, and the real app
    // opened on the pile at the origin while this gate, clicking the control by hand, saw a
    // fitted graph and passed. Read the viewport as the page settled on its own; then click the
    // control -- the ordinary operator affordance, and the same fit options -- and require that
    // the click changed nothing. A control click that moves the graph is the bug reappearing.
    const viewport = () =>
      page.locator('.react-flow__viewport').evaluate((node) => node.style.transform).catch(() => null)
    await delay(400)
    const automatic = await viewport()
    await page.locator('.react-flow__controls-fitview').click().catch(() => {})
    await delay(400)
    const clicked = await viewport()
    if (automatic === null || automatic !== clicked) {
      await fail(
        `stage 2 (graph): the graph did not fit itself on layout -- viewport ${JSON.stringify(automatic)} on arrival, ${JSON.stringify(clicked)} after the fit control`,
      )
    }
    console.log(`stage 2 (graph): fitted itself on layout -- viewport ${automatic}`)
  }

  async function capture(target) {
    // The `next dev` overlay button is a fact about the dev server, not about the design under
    // review, and it sits over the sidebar's lower rows. Hidden in the SCREENSHOT only -- no
    // assertion in this file ever reads it, and nothing about the page's own layout changes.
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' }).catch(() => {})
    if (target.name === 'graph') await settleGraph()
    // A full-page capture stitches from the top; a page left scrolled crops its own header off.
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: join(SHOTS_DIR, `${target.name}.png`), fullPage: true })
  }

  for (const target of PAGES) {
    await gotoReliably(`${baseUrl}${target.path()}`)
    await waitVisible(page.getByTestId(target.testId), `${target.name}'s structural marker [data-testid=${target.testId}]`)
    // The sidebar is on every one of the nine, and its own width is stage 2's first assertion --
    // asserting it is PRESENT here means a page that renders without the shell fails by name.
    await waitVisible(page.getByRole('navigation', { name: 'Primary' }), `${target.name}'s sidebar`)
    // Committed evidence (Decision 9): reviewed against the mockups page by page.
    await capture(target)
    console.log(`stage 1: ${target.name} rendered and captured`)
  }
  console.log('stage 1 PASSED: nine pages rendered at 1440x900, nine screenshots written')

  // ============================================================================================
  // Stage 2: the README's numbers, read back off the real page.
  // ============================================================================================

  /** Reads one computed property off the first match of `selector`, on the page currently open. */
  async function computed(selector, property) {
    return page.evaluate(
      ([sel, prop]) => {
        const element = document.querySelector(sel)
        if (element === null) return null
        return window.getComputedStyle(element).getPropertyValue(prop)
      },
      [selector, property],
    )
  }

  /** Browsers report `5px 11px` for an SVG `5 11` dasharray and collapse whitespace runs. */
  const normalize = (value) => value.trim().replace(/\s+/g, ' ')

  /** Asserts one number, failing by PAGE + SELECTOR + PROPERTY + both values (spec §6 stage 2:
   *  "any deviation fails with page+property"). */
  async function assertComputed(pageName, selector, property, expected) {
    const actual = await computed(selector, property)
    if (actual === null) await fail(`stage 2 (${pageName}): no element matched ${selector}`)
    if (normalize(actual) !== normalize(expected)) {
      await fail(
        `stage 2 (${pageName}): ${selector} ${property} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      )
    }
    console.log(`stage 2 (${pageName}): ${selector} ${property} = ${actual}`)
  }

  // page, path, selector, property, expected -- every row is one README number. The cable's own
  // dasharray is NOT here: `CableEdge` draws that path only on an ACTIVE edge, which needs a live
  // run, so it is asserted as stage 2b after stage 4b dispatches one.
  const NUMBERS = [
    ['overview', `/w/${workspaceId}`, 'nav[aria-label="Primary"]', 'width', '212px'],
    // M24 §2.2: the workspace-scoped `TopBar` is gone -- `ProjectHeader` is the project layout's
    // one header now, on every `/w/<id>/*` page, still 52px.
    ['overview', `/w/${workspaceId}`, '[data-testid="project-header"]', 'height', '52px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="agent-card"]', 'border-radius', '8px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="agent-card"]', 'padding', '12px 13px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="avatar-tile"]', 'width', '28px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="avatar-tile"]', 'height', '28px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="agent-card"] [data-testid="status-pill"]', 'border-radius', '20px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="live-events"]', 'width', '340px'],
    ['activity', `/w/${workspaceId}/activity`, '[data-testid="timeline-rule"]', 'left', '88px'],
    ['graph', `/w/${workspaceId}/graph`, '[data-testid="graph-drawer"]', 'width', '352px'],
  ]

  let currentPath = null
  for (const [pageName, path, selector, property, expected] of NUMBERS) {
    if (path !== currentPath) {
      await gotoReliably(`${baseUrl}${path}`)
      currentPath = path
      // Hydrated before anything is measured: a `getComputedStyle` taken against the server's
      // first paint would be reading a page React has not finished with.
      const marker = PAGES.find((target) => target.name === pageName)
      if (marker !== undefined) await waitVisible(page.getByTestId(marker.testId), `${pageName} before its numbers are read`)
      // The drawer needs a selected agent: only an agent node opens it (`GraphClient.onNodeClick`).
      if (pageName === 'graph') {
        await waitVisible(page.getByTestId('agent-node'), "the graph's agent node")
        await clickUntil(
          page.getByTestId('agent-node').first(),
          async () => page.getByTestId('graph-drawer').first().isVisible(),
          'the agent node',
        )
      }
    }
    await assertComputed(pageName, selector, property, expected)
  }

  // The project Settings tab (M24 §4): `perm-caption` moved here from the global `/settings`, and
  // the read-only `runtime-timeout` figure the sidebar's old guardrail block used to carry (M24
  // Task 2 removed that block; Task 4 re-homed the number here).
  await gotoReliably(`${baseUrl}/w/${workspaceId}/settings`)
  await waitVisible(page.getByTestId('perm-caption'), "the project Settings tab's permission matrix caption")
  await assertComputed('project-settings', '[data-testid="runtime-timeout"]', 'font-size', '10.5px')
  console.log('stage 2a: the project Settings tab carries perm-caption and a 10.5px mono runtime-timeout figure')

  // The Agents table's nine columns (M24 §5.3: one table, agent/role/team/project/status/current
  // task/provider/cost/actions). Asserted TWICE and deliberately: `getComputedStyle` resolves
  // `grid-template-columns` to USED track sizes, so the `1fr` comes back as a pixel width and a
  // literal string comparison against the README's template could never pass. The computed read is
  // what proves the eight fixed tracks really are 200/110/130/120/110/90/90/160 in the browser's
  // own reckoning and that the flexible track actually took the remaining space; the authored
  // inline value is what proves the template is the README's string and not eight coincidences.
  const AGENTS_COLUMNS = '200px 110px 130px 120px 110px 1fr 90px 90px 160px'
  await gotoReliably(`${baseUrl}/agents`)
  // The Agents page opens on the one table now (M24 Task 7): Roster and Workers were two names for
  // the same list of agents and are gone, folded into `agents-tab-agents` (default) beside
  // `agents-tab-teams`. The `clickUntil` below is kept anyway -- it is idempotent on an
  // already-selected tab, and it is what makes this stage assert the template rather than assume
  // which tab happened to be default.
  // Keyed on the TABLE, not on its rows. `listAllAgents()` renders every project agent AND every
  // catalog member no project has materialized yet, so a seeded development database does render
  // rows here -- but a database with no agents at all still renders the header alone, which is the
  // same nine-column grid this stage measures, and waiting for a row would hang on a page that is
  // rendering correctly.
  await clickUntil(
    page.getByTestId('agents-tab-agents'),
    async () =>
      (await page.evaluate(
        () => document.querySelector('[data-testid="data-table-header"]')?.style.gridTemplateColumns ?? null,
      )) === AGENTS_COLUMNS,
    'the Agents tab',
  )
  const workerHeaderCells = await page.getByTestId('data-table-header-cell').count()
  if (workerHeaderCells !== 9) {
    await fail(`stage 2 (agents): the Agents table has ${String(workerHeaderCells)} header cell(s), expected 9`)
  }
  const agentsComputed = normalize((await computed('[data-testid="data-table-header"]', 'grid-template-columns')) ?? '')
  const agentsUsed = /^200px 110px 130px 120px 110px (\d+(?:\.\d+)?)px 90px 90px 160px$/.exec(agentsComputed)
  if (agentsUsed === null) {
    await fail(
      `stage 2 (agents): [data-testid="data-table-header"] grid-template-columns is ${JSON.stringify(agentsComputed)}, ` +
        `expected the used form of ${JSON.stringify(AGENTS_COLUMNS)} -- ` +
        '`200px 110px 130px 120px 110px <the 1fr track>px 90px 90px 160px`',
    )
  }
  if (Number(agentsUsed[1]) <= 0) {
    await fail(`stage 2 (agents): the \`1fr\` column resolved to ${agentsUsed[1]}px at 1440x900 -- it has no room at all`)
  }
  const agentsAuthored = await page.evaluate(
    () => document.querySelector('[data-testid="data-table-header"]')?.style.gridTemplateColumns ?? null,
  )
  if (normalize(agentsAuthored ?? '') !== AGENTS_COLUMNS) {
    await fail(
      `stage 2 (agents): the Agents table is laid out on ${JSON.stringify(agentsAuthored)}, ` +
        `expected ${JSON.stringify(AGENTS_COLUMNS)}`,
    )
  }
  console.log(
    `stage 2 (agents): [data-testid="data-table-header"] grid-template-columns = ${JSON.stringify(AGENTS_COLUMNS)} ` +
      `(used: ${agentsComputed})`,
  )
  console.log(`stage 2a PASSED: ${String(NUMBERS.length + 2)} README values read back from getComputedStyle`)

  // ============================================================================================
  // Stage 4a: the two-step STOP, the halt banner, and clear-halt.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await clickUntil(
    page.getByTestId('emergency-stop'),
    async () => page.getByTestId('emergency-stop-confirm').first().isVisible(),
    'the STOP button',
  )
  await clickUntil(
    page.getByTestId('emergency-stop-confirm'),
    async () => {
      const row = await prisma.workspace.findUnique({ where: { id: workspaceId } })
      return row !== null && row.haltedReason !== null
    },
    'the STOP confirmation',
  )
  const haltedReason = await waitUntil('the workspace to read halted in the database', 30_000, async () => {
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    return row.haltedReason === null ? { done: false, detail: 'haltedReason is still null' } : { done: true, value: row.haltedReason }
  })
  console.log(`stage 4a: the workspace reads halted -- ${JSON.stringify(haltedReason)}`)

  // Only the four workspace-scoped page clients in `PAGES` render their own `HaltBanner`
  // (`OverviewClient`, `TasksClient`, `GraphClient`, `ActivityClient` -- the project Settings tab
  // does too since M24's final review, but `/w/<id>/settings` is not one of the pages this gate
  // visits); the five global ones (including THIS `settings` entry, the org-wide `/settings`
  // page) are not workspace-scoped and correctly show none. Both halves are asserted: a banner
  // appearing on a global page would mean a page had guessed at a workspace it does not belong to.
  const SCOPED = new Set(['overview', 'tasks', 'graph', 'activity'])
  for (const target of PAGES) {
    await gotoReliably(`${baseUrl}${target.path()}`)
    await waitVisible(page.getByTestId(target.testId), `${target.name} while the workspace is halted`)
    if (SCOPED.has(target.name)) {
      await waitVisible(
        page.getByRole('alert').filter({ hasText: 'workspace halted' }),
        `${target.name}'s halt banner`,
      )
      console.log(`stage 4a: ${target.name} shows the halt banner`)
    } else {
      const strays = await page.getByRole('alert').filter({ hasText: 'workspace halted' }).count()
      if (strays > 0) {
        await fail(`stage 4a: the global page ${target.name} shows a workspace halt banner (${String(strays)}), and owns no workspace`)
      }
      console.log(`stage 4a: ${target.name} is global and correctly shows no halt banner`)
    }
  }

  execFileSync('node', [ORCHESTRATOR_CLI, 'clear-halt', '--workspace', workspaceId], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const cleared = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
  if (cleared.haltedReason !== null) {
    await fail(`stage 4a: clear-halt left haltedReason=${JSON.stringify(cleared.haltedReason)}`)
  }
  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await waitVisible(page.getByTestId('strip'), 'the Overview strip after the halt was cleared')
  await waitUntil('the halt banner to disappear once the halt is cleared', 30_000, async () => {
    const remaining = await page.getByRole('alert').filter({ hasText: 'workspace halted' }).count()
    return remaining === 0 ? { done: true, value: 0 } : { done: false, detail: `${String(remaining)} banner(s) still on the page` }
  })
  console.log('stage 4a PASSED: two-step STOP halted the workspace, every scoped page said so, and clear-halt released it')

  // ============================================================================================
  // Stage 4b (first half): a fake-CLI run reaches `working`.
  // ============================================================================================
  daemon = spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspaceId, '--period', '500'], {
    cwd: repoRoot,
    // `buildChildEnv` spreads `process.env` into the vendor child, so this reaches `fake-claude.sh`
    // and widens the window in which the run is `working` (see FAKE_STEP_GAP_MS).
    env: { ...process.env, FAKE_CLAUDE_STEP_GAP_MS: FAKE_STEP_GAP_MS },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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
    const row = await prisma.agentRun.findFirst({ where: { agentId, taskId }, orderBy: { startedAt: 'desc' } })
    if (row === null) return { done: false, detail: 'no run row yet' }
    if (row.pid === null || row.provider === null) {
      return { done: false, detail: `${row.status} pid=${String(row.pid)} provider=${String(row.provider)}` }
    }
    return { done: true, value: row }
  })
  if (dispatched.provider !== WORKER_PROVIDER) {
    await fail(`stage 4b: the run resolved to provider ${JSON.stringify(dispatched.provider)}, expected ${JSON.stringify(WORKER_PROVIDER)}`)
  }
  const run = await waitUntil('the run to reach working', WORKING_TIMEOUT_MS, async () => {
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: dispatched.id } })
    return row.status === 'working' ? { done: true, value: row } : { done: false, detail: `run is ${row.status}` }
  })
  console.log(`stage 4b: run ${run.id} is working (pid ${String(run.pid)}, provider ${String(run.provider)})`)

  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  // Truth from snapshot, never optimistic (design README "State Management"): the card is read for
  // the label the SERVER derived, not for anything a click set locally.
  await waitUntil('the card to show WORKING', 30_000, async () => {
    const text = await page
      .locator('[data-testid="agent-card"] [data-testid="status-pill"]')
      .first()
      .textContent()
      .catch(() => null)
    return text === 'WORKING' ? { done: true, value: text } : { done: false, detail: `pill reads ${JSON.stringify(text)}` }
  })
  console.log('stage 4b: the Overview card followed the snapshot to WORKING')

  // The four live pages, re-captured now that there is work to show. Decision 9's evidence is
  // reviewed against mockups that show a board mid-run; a screenshot of an idle board is a
  // screenshot of a different thing.
  for (const target of PAGES) {
    if (!LIVE_PAGES.has(target.name)) continue
    await gotoReliably(`${baseUrl}${target.path()}`)
    await waitVisible(page.getByTestId(target.testId), `${target.name} with a live run`)
    // A beat for the first SSE snapshot to land: these four pages all render from the server's
    // initial payload and then immediately refetch, and a capture taken between the two shows the
    // board a frame before the run appeared on it.
    await delay(1_000)
    if (target.name === 'activity') {
      // Now that the run has appended events, the river has height -- so the design's own rule is
      // required to be VISIBLE here, which is the assertion an empty workspace could not carry.
      await waitVisible(page.getByTestId('activity-card'), 'at least one activity row once the run is live')
      await waitVisible(page.getByTestId('timeline-rule'), "the timeline's rule at x=88 over a populated river")
    }
    await capture(target)
    console.log(`stage 1 (live): ${target.name} re-captured with a run in flight`)
  }

  // ============================================================================================
  // Stage 3b: the motion that a `working` card is supposed to have.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await waitVisible(page.getByTestId('card-sweep'), "the working card's sweep")
  await assertComputed('overview', '[data-testid="card-sweep"]', 'animation-duration', '2.2s')
  await assertComputed('overview', '[data-testid="card-sweep"]', 'animation-timing-function', 'cubic-bezier(0.4, 0, 0.2, 1)')
  await assertComputed('overview', '[data-testid="card-sweep"]', 'animation-name', 'card-sweep')
  await assertComputed('overview', '[data-testid="agent-card"] [data-testid="status-pill"] span', 'animation-duration', '1.5s')
  await assertComputed('overview', '[data-testid="agent-card"] [data-testid="status-pill"] span', 'animation-name', 'status-pulse')
  console.log('stage 3b PASSED: a working card sweeps at 2.2s cubic-bezier(.4,0,.2,1) and its pill dot pulses at 1.5s')

  // ============================================================================================
  // Stage 2b: the cable, which exists only while something is flowing along it.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${workspaceId}/graph`)
  await waitVisible(page.locator('path[data-cable="flow"]'), "the org graph's lit cable")
  // The README's number is `stroke-dasharray: 5 11`, which is what `CableEdge` writes as the SVG
  // presentation attribute. Chromium's COMPUTED serialization of that list is `5px, 11px` -- pixel
  // units resolved and the items comma-separated. Asserted in the browser's own spelling rather
  // than normalized into the README's, so this line says exactly what was read back.
  await assertComputed('graph', 'path[data-cable="flow"]', 'stroke-dasharray', '5px, 11px')
  await assertComputed('graph', 'path[data-cable="flow"]', 'animation-name', 'dash')
  console.log('stage 2b PASSED: the lit cable is dashed 5 11 and travels the `dash` keyframe')

  // ============================================================================================
  // Stage 3a: under reduced motion, NOTHING animates -- asserted against the very page whose
  // sweep, pulse and cable travel were just measured, so the negative has something to kill.
  // ============================================================================================
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const path of [`/w/${workspaceId}`, `/w/${workspaceId}/graph`]) {
    await gotoReliably(`${baseUrl}${path}`)
    // The elements whose motion stage 3b/2b just proved must still BE here -- otherwise "nothing
    // animates" would be satisfied by a page that rendered nothing.
    await waitVisible(
      path.endsWith('/graph') ? page.locator('path[data-cable="flow"]') : page.getByTestId('card-sweep'),
      `the animated element on ${path} under reduced motion`,
    )
    const animated = await page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .map((element) => ({
          tag: element.tagName,
          testId: element.getAttribute('data-testid'),
          name: window.getComputedStyle(element).animationName,
        }))
        .filter((entry) => entry.name !== '' && entry.name !== 'none'),
    )
    if (animated.length > 0) {
      await fail(
        `stage 3a: ${String(animated.length)} element(s) still animate on ${path} under prefers-reduced-motion: ` +
          JSON.stringify(animated.slice(0, 10)),
      )
    }
    console.log(`stage 3a: ${path} reports no animation-name on any element under prefers-reduced-motion`)
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  console.log('stage 3a PASSED: under prefers-reduced-motion no element reports an animation-name')

  // ============================================================================================
  // Stage 4b (second half): a pause shows `pause_requested`, then `paused`.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await waitVisible(page.getByTestId('card-pause'), "the card's Pause button")
  let sawPauseRequested = false
  await clickUntil(
    page.getByTestId('card-pause'),
    async () => {
      const row = await prisma.agentRun.findUnique({ where: { id: run.id } })
      if (row === null) return false
      if (row.status === 'pause_requested') sawPauseRequested = true
      return row.status === 'pause_requested' || row.status === 'paused'
    },
    "the card's Pause button",
  )
  const settled = await waitUntil('the run to settle on paused', PAUSE_SETTLE_TIMEOUT_MS, async () => {
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    if (row.status === 'pause_requested') sawPauseRequested = true
    return row.status === 'paused' ? { done: true, value: row } : { done: false, detail: `run is ${row.status}` }
  })
  if (!sawPauseRequested) {
    // Not fatal on its own -- a very fast pause can pass through the intermediate status between
    // two polls -- but the LOG is append-only and cannot miss it, so the fact is asserted there.
    const requested = await prisma.executionEvent.count({ where: { runId: run.id, type: 'run_pause_requested' } })
    if (requested === 0) {
      await fail(
        'stage 4b: the run reached `paused` without ever reading `pause_requested`, and the log records no ' +
          '`run.pause_requested` either -- a pause that skips the requested state is a pause the board cannot show',
      )
    }
    console.log(`stage 4b: pause_requested was faster than the poll, and the append-only log carries it (${String(requested)} event(s))`)
  } else {
    console.log('stage 4b: the run read `pause_requested` before it read `paused`')
  }
  // Decision 1: `paused` is published only once the child is dead.
  if (settled.pid !== null && isAlive(settled.pid)) {
    await fail(`stage 4b: the run reads paused while its recorded pid ${String(settled.pid)} is still alive`)
  }
  await waitUntil('the card to show PAUSED', 30_000, async () => {
    const text = await page
      .locator('[data-testid="agent-card"] [data-testid="status-pill"]')
      .first()
      .textContent()
      .catch(() => null)
    return text === 'PAUSED' ? { done: true, value: text } : { done: false, detail: `pill reads ${JSON.stringify(text)}` }
  })
  console.log('stage 4b PASSED: a fake-CLI run reached working, paused on request, and the card followed the snapshot at every step')

  // ============================================================================================
  // Stage 4c: a roster click filters the stream and dims the rest.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${workspaceId}/activity`)
  await waitVisible(page.getByTestId('activity-card'), 'at least one activity card')
  const countDimmed = async () =>
    page
      .locator('[data-testid="activity-card"]')
      .evaluateAll((nodes) => nodes.filter((node) => node.className.includes('opacity-[.35]')).length)
  const beforeDim = await countDimmed()
  if (beforeDim !== 0) {
    await fail(`stage 4c: ${String(beforeDim)} card(s) were already dimmed before any roster row was clicked`)
  }
  // The run has appended events with no `agentId` of their own (task and workspace transitions),
  // so selecting the one worker must dim SOMETHING -- "dim, never hide" (design README
  // "Filtering") is only observable if the river keeps every row.
  const totalCards = await page.locator('[data-testid="activity-card"]').count()
  await clickUntil(
    page.getByTestId(`roster-row-${agentId}`),
    async () => (await page.getByTestId(`roster-row-${agentId}`).getAttribute('aria-pressed')) === 'true',
    'the roster row',
  )
  const afterDim = await waitUntil('the stream to dim the rows this agent did not cause', 30_000, async () => {
    const dimmed = await countDimmed()
    return dimmed > 0 ? { done: true, value: dimmed } : { done: false, detail: `0 of ${String(totalCards)} cards are dimmed` }
  })
  const afterTotal = await page.locator('[data-testid="activity-card"]').count()
  if (afterTotal !== totalCards) {
    await fail(
      `stage 4c: the roster click changed the number of rows from ${String(totalCards)} to ${String(afterTotal)} -- ` +
        'the design README dims, it never hides',
    )
  }
  console.log(
    `stage 4c PASSED: a roster click selected the agent and dimmed ${String(afterDim)} of ${String(totalCards)} rows ` +
      'without removing one',
  )

  // ============================================================================================
  // Stage 5: real Skills and Analytics data.
  // ============================================================================================
  const catalog = await syncSkillCatalog()
  console.log(
    `stage 5: syncSkillCatalog upserted ${String(catalog.upserted)} skill(s), marked ${String(catalog.markedMissing)} missing`,
  )
  if (catalog.skippedRoots.length > 0) {
    await fail(
      `stage 5: syncSkillCatalog skipped ${JSON.stringify(catalog.skippedRoots)} -- a catalog read from two of three ` +
        'roots is not the catalog this stage asserts about',
    )
  }
  // Decision 6: the catalog never deletes. A second sync of an unchanged disk must mark nothing
  // missing -- the re-stamp guard is exactly what a false mass-deletion would break.
  if (catalog.markedMissing !== 0) {
    await fail(
      `stage 5: a second sync of an unchanged disk marked ${String(catalog.markedMissing)} skill(s) missing. ` +
        'Decision 6 says the catalog never deletes, and nothing left the disk between the two syncs.',
    )
  }
  const pluginProviders = await prisma.skillProvider.findMany({ where: { name: { startsWith: 'plugin:' } } })
  const superpowers = pluginProviders.find((provider) => provider.name === 'plugin:superpowers') ?? null
  if (superpowers === null) {
    await fail(
      `stage 5: no plugin:superpowers provider after a sync -- found ${JSON.stringify(pluginProviders.map((p) => p.name))}. ` +
        "This gate reads the DAEMON HOST's ~/.claude/plugins/cache; a machine without the superpowers plugin cannot run it.",
    )
  }
  await gotoReliably(`${baseUrl}/skills`)
  await waitVisible(page.getByTestId(`provider-name-${superpowers.id}`), 'the plugin:superpowers provider on the Skills page')
  const providerLabel = await page.getByTestId(`provider-name-${superpowers.id}`).first().textContent()
  if ((providerLabel ?? '').trim() !== 'plugin:superpowers') {
    await fail(`stage 5: the Skills page names that provider ${JSON.stringify(providerLabel)}, expected "plugin:superpowers"`)
  }
  // Re-captured now that the catalog is on the page -- the committed evidence should show a real
  // catalog, which is what the mockup's Skills page shows.
  await capture(PAGES.find((target) => target.name === 'skills'))
  console.log(`stage 5: the Skills page lists plugin:superpowers (${superpowers.id})`)

  // Analytics' seven-day counts must equal an INDEPENDENT SQL count -- the page's own aggregation
  // is exactly what is under test, so the check cannot go through it. The window is
  // `server/analytics.ts`'s own: UTC midnight of (today - 6), inclusive.
  const succeededRows = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM "AgentRun" r
    JOIN "Agent" a ON a.id = r."agentId"
    JOIN "Team" t ON t.id = a."teamId"
    WHERE t."workspaceId" = ${workspaceId}
      AND r.status = 'succeeded'
      AND r."terminalAt" >= date_trunc('day', now() at time zone 'utc') - interval '6 days'`
  const failedRows = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM "AgentRun" r
    JOIN "Agent" a ON a.id = r."agentId"
    JOIN "Team" t ON t.id = a."teamId"
    WHERE t."workspaceId" = ${workspaceId}
      AND r.status = 'failed'
      AND r."terminalAt" >= date_trunc('day', now() at time zone 'utc') - interval '6 days'`
  const sqlSucceeded = succeededRows[0].n
  const sqlFailed = failedRows[0].n
  if (sqlSucceeded === 0 && sqlFailed === 0) {
    await fail(
      'stage 5: SQL counts no terminal run in the 7-day window, so comparing the chart against it would compare ' +
        'two zeroes. The historical rows this gate seeds are what make this assertion mean something.',
    )
  }

  await gotoReliably(`${baseUrl}/analytics?workspace=${workspaceId}`)
  await waitVisible(page.getByTestId('kpi-tile'), 'the Analytics KPI strip')
  const columns = await page.locator('[data-testid="bar-column"]').count()
  if (columns !== 7) {
    await fail(`stage 5: the chart draws ${String(columns)} day column(s), expected 7`)
  }
  const chartSucceeded = await page
    .locator('[data-testid^="bar-ok-"]')
    .evaluateAll((nodes) => nodes.reduce((total, node) => total + Number(node.getAttribute('data-count') ?? 0), 0))
  const chartFailed = await page
    .locator('[data-testid^="bar-fail-"]')
    .evaluateAll((nodes) => nodes.reduce((total, node) => total + Number(node.getAttribute('data-count') ?? 0), 0))
  if (chartSucceeded !== sqlSucceeded) {
    await fail(`stage 5: the chart shows ${String(chartSucceeded)} succeeded run(s) over 7 days; SQL counts ${String(sqlSucceeded)}`)
  }
  if (chartFailed !== sqlFailed) {
    await fail(`stage 5: the chart shows ${String(chartFailed)} failed run(s) over 7 days; SQL counts ${String(sqlFailed)}`)
  }
  // Re-captured with the real seven-day series drawn.
  await capture(PAGES.find((target) => target.name === 'analytics'))
  console.log(
    `stage 5 PASSED: the catalog holds plugin:superpowers, and the 7-day chart agrees with SQL ` +
      `(${String(sqlSucceeded)} succeeded, ${String(sqlFailed)} failed across 7 columns)`,
  )

  // Beside the PASS line, not just in a `fail()` dump (review finding, fix round 2): a rising
  // retry rate is a signal worth seeing in GREEN runs, not only the run where it finally isn't
  // enough.
  console.log(
    gotoRetries.length === 0
      ? 'gotoReliably: no retries this run'
      : `gotoReliably retried ${String(gotoRetries.length)} time(s): ${JSON.stringify(gotoRetries)}`,
  )
  console.log(`PASS: ${PASS_LINE}`)
  exitCode = 0
} finally {
  // WHATEVER CAN STILL SPAWN A CHILD DIES FIRST. The daemon dispatches on a 500ms period and can
  // start a `claude` at any moment; sweeping pids while it is still running leaves a window in
  // which a child spawned after the sweep survives the gate and has its row -- the only record of
  // its pid -- deleted underneath it. So: stop the spawner, THEN sweep, THEN delete the rows.
  if (daemon !== null && daemon.exitCode === null) {
    daemon.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (daemon.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (daemon.exitCode === null) daemon.kill('SIGKILL')
  }
  // Then the fake children by pid off the rows, before the rows are deleted. `fake-claude.sh`
  // ignores SIGTERM on purpose, so this is SIGKILL.
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
  // ...and then whatever those children spawned, which no row records: `fake-claude.sh` detaches a
  // `fake-worker-server.sh` on every non-resume start, exactly so this sweep is exercised.
  sweepStrayChildren([repoPath])

  // Only now the things that cannot spawn a child: the browser and the web shell.
  if (browser !== null) await browser.close().catch(() => {})
  if (nextServer !== null && nextServer.exitCode === null) {
    nextServer.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextServer.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextServer.exitCode === null) nextServer.kill('SIGKILL')
  }
  // FK-ordered: `ExecutionEvent` has no FK to `Workspace` (M2's append-only log outlives entity
  // lifecycles by design) so it is deleted explicitly first, then the workspace delete cascades
  // Team/Agent/Task/AgentRun/Checkpoint/ProviderConfiguration. The `SkillProvider`/`Skill` rows
  // stay: they describe the host's disk, not this workspace, and Decision 6 never deletes them.
  if (workspaceId !== null) {
    await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  // The repository carries the run worktrees and the `.aiteamos` run directories -- all of it
  // inside this tree, so nothing this gate wrote outlives it.
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
