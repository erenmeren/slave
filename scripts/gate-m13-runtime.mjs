// M13's own gate (Task 14 brief, spec §7.2): "a pause is a stop and a stop is resumable".
//
// M12's gate proved the provider SEAM -- two runtimes, one promise. This one proves the two things
// M12's gate could not, because M12's own freeze forbade fixing them: that a run reported `paused`
// has a DEAD process (Decision 1), and that the window in which it does not yet is refused rather
// than lost (Decision 3). Both are asserted against the operating system and the database, never
// against anything a process printed.
//
// Shape borrowed verbatim from `gate-m12-providers.mjs`: dist imports, everything created inside
// one `try`, bounded `waitUntil(description, timeoutMs, probe)` whose probe reports what it last
// SAW, preflight cleanup of prior `M13 Gate`-named rows, `dumpGateRows()` + `fail()` for the
// diagnostic throw, `resolveOnPath` honouring `AITEAMOS_CLAUDE_BIN`/`AITEAMOS_CURSOR_BIN`,
// FK-ordered cleanup in `finally`, `exitCode` starting at 1 and set to 0 only by falling off the
// end of the try, `process.exit(exitCode)` as the last line. The browser half is
// `gate-m11-shell.mjs`'s verbatim: a real `next dev` on a free port and a real Chromium from
// `CHROMIUM_PATH`.
//
// WHAT THIS ADDS TO THAT SKELETON, and must not omit:
//
//   - VENDOR CHILDREN DIE TOO (Decision 12). M12's `finally` killed only the daemon. This one also
//     kills every `claude` and `cursor-agent` this gate caused, by pid off the `AgentRun` rows,
//     BEFORE those rows are deleted. A gate that exits leaving a paid vendor process running is a
//     gate that keeps spending after it has reported.
//   - A BROWSER. Stages 1 and 4 drive the real Runtime card, not the control verbs behind it.
//   - FAIL FAST, NEVER SKIP. A missing `cursor-agent`, `claude`, `.env`, `DATABASE_URL` or
//     Chromium is an immediate failure naming the override variable. There is no fixture mode.
//
// STAGE ORDER: 4, 1, 2, 3, 5 -- not 1..5, and not the brief's literal "4, 1, 3, 2, 5" either.
// Both departures from 1..5 are for M12's reasons, and the second one is the brief's own reason
// applied to M13's numbering rather than to M12's:
//
//   - Stage 4's first half (a budgeted workspace refuses the cost-blind provider) spawns NOTHING:
//     the refusal happens inside the tick's `startRun`, after the adapter resolves and before any
//     child exists. Running it first finds a broken admission guard in seconds rather than after
//     two paid runs.
//   - Stage 3 READS what stage 2 WRITES -- the Cursor run's checkpoint, and what its gate did
//     during the pause window stage 2 opens -- so stage 2 must run before it. The brief's ordering
//     line says "4, 1, 3, 2, 5" while its own justification in the very next sentence says stage 2
//     must run before stage 3; the numbers are M12's (where stage 3 drove and stage 2 read) and
//     the sentence is M13's. The sentence is the part that can be executed, so it is what this
//     script does. Recorded here rather than silently, because the discrepancy is in the plan.
//
// WHAT THIS GATE COSTS. One execution spawns four vendor children, every one of them tiny:
//   1. stage 4b -- one `cursor-agent`, stopped the instant its pid and provider are on the row;
//   2. stage 2  -- one `claude`, paused once and resumed once;
//   3. stage 2  -- one `cursor-agent`, paused once and resumed once;
//   4. stage 5  -- one `claude`, paused once; its resume is made to fail before a child exists.
// Every task is created with `maxAttempts: 1` unless a stage needs a second dispatch of its own
// (stage 4's does, and says so), so a failed run can never be reworked into a second paid attempt
// while this script is waiting on something else.
//
// A FAIL from any stage dumps every `M13 Gate`-named workspace, run, checkpoint and event still in
// the DB, plus the daemon's output tail and a full-page screenshot -- the `gate-m8a-estop.mjs`
// idiom of a thrown error carrying the state that made the call, not just "it timed out".
//
// REHEARSING THIS GATE WITHOUT SPENDING ANYTHING. Decision 12 makes "rehearses against fake CLIs
// before the first paid execution" a standing property of this gate rather than a one-time act by
// whoever first wrote it, so the harness ships beside it:
//
//   AITEAMOS_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   AITEAMOS_CURSOR_BIN="$PWD/scripts/gate-fakes/fake-cursor-agent.sh" \
//   npm run gate:m13-runtime
//
// Every stage runs, every assertion is made and the PASS line is the same one; the only difference
// is that no vendor account is touched. Debug this script's own plumbing there, never against the
// real binaries. Note what this does NOT buy: a rehearsal proves the gate's machinery, not the
// runtimes' behaviour -- see stage 3's own comment, which is explicit about which of its facts a
// fake CLI can and cannot establish.
//
// This file knows nothing about those fakes. They are reached only through the `AITEAMOS_*_BIN`
// overrides `apps/orchestrator/src/cli.ts` already honours for its own reasons, so there is no
// fixture mode here, no skip, and no flag that only a rehearsal passes.

import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import {
  capabilitiesOf,
  isAlive,
  refusalText,
  requestPause,
  requestResume,
  requestStop,
} from '../packages/control/dist/index.js'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '../packages/db/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'

const POLL_INTERVAL_MS = 25
// Generous by design, and every one of them bounds a REAL vendor round trip -- a timeout tuned to
// a fake CLI's replay speed would fail this gate for being slow rather than for being wrong.
const DISPATCH_TIMEOUT_MS = 180_000
const WORKING_TIMEOUT_MS = 300_000
const PAUSE_SETTLE_TIMEOUT_MS = 180_000
const RESUME_TERMINAL_TIMEOUT_MS = 600_000
const TICK_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const NEXT_READY_TIMEOUT_MS = 180_000
const ACTION_TIMEOUT_MS = 30_000
// How long stage 5 watches a daemon that should be doing nothing. Six daemon periods at the
// `--period 500` this script starts it with: long enough that "no run was started" is a fact about
// the scheduler rather than about how fast this loop asked.
const QUIET_WINDOW_MS = 10_000
// The window in which a conclusion that has already written its ROW finishes writing its HISTORY.
// Short, because everything it waits on has already happened -- see stage 5's own comment.
const LOG_SETTLE_TIMEOUT_MS = 60_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const runTimestamp = new Date().toISOString()

// Suffixed with `runTimestamp` (the `gate-m10-org.mjs` idiom): nothing here is typed into a form,
// `Workspace.name` has no unique constraint, and a unique name per run keeps two overlapping
// executions from reading each other's rows. `preflightCleanup` still removes leftovers by PREFIX,
// so a run killed before its own `finally` cannot leave rows a later run would report as its own.
const WORKSPACE_PREFIX = 'M13 Gate Project'
const UNBUDGETED_WORKSPACE = `${WORKSPACE_PREFIX} (unbudgeted) ${runTimestamp}`
const BUDGETED_WORKSPACE = `${WORKSPACE_PREFIX} (budgeted) ${runTimestamp}`
const CLAUDE_WORKER = 'Claude Worker'
const CURSOR_WORKER = 'Cursor Worker'
const ATTEMPT_WORKER = 'Attempt Worker'
const PAUSE_REQUESTER = 'the M13 gate'
const PASS_LINE = 'a pause is a stop and a stop is resumable'

// The model half of each worker's `(model, provider)` pair. Both workers MUST name a model:
// `resolveRuntime` only consults a level that names one, so a worker with a null model falls
// through to the workspace default and both workers would resolve to the same provider. Chosen for
// cost, not capability, exactly as M12's gate chose them.
const CLAUDE_MODEL = 'sonnet'
const CURSOR_MODEL = 'composer-2.5'

// Two steps, so a pause can land BETWEEN them, and tiny, because both halves cost the operator's
// own account. The sequencing sentence is load-bearing: a runtime that batches both writes into
// one turn leaves no gap for a pause to land in.
const TASK_TITLE = 'Create two small files'
const TASK_DESCRIPTION = [
  'Create a file named hello.txt whose entire contents are the word: hi',
  'Then create a second file named world.txt whose entire contents are the word: there',
  '',
  'Do them one at a time, in that order: create hello.txt first, and only once it exists create',
  'world.txt. Use one file-writing tool call per file. Do not run any other commands, and do not',
  'commit anything.',
].join('\n')

/** The exact refusal spec §6 promises for a budgeted workspace and a cost-blind runtime. */
const BUDGET_REFUSAL = 'a budget needs a provider that reports cost'
/** The exact text Decision 3's second lock promises (`packages/control/src/refusal.ts`). */
const STILL_STOPPING_REFUSAL = 'the run is still stopping; retry in a moment'
/** The exact `Checkpoint.pauseReason` a Cursor pause records (`apps/orchestrator/src/pump.ts`'s
 *  `CURSOR_PAUSE_REASON`) -- ending the process IS the pause for a runtime with no mid-run gate. */
const CURSOR_PAUSE_REASON = 'paused by cancelling the process (cursor has no mid-run gate; canPauseMidRun: false)'

/** A run row that has stopped moving on its own. */
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'stopped'])

/** Same as `gate-m12-providers.mjs`'s `makeRepo` -- a real repository, because the tick provisions
 *  a real `git worktree` in it, and a real worktree root is what `cursor-agent` needs for the
 *  `.cursor/hooks.json` the Cursor adapter writes to be found at all (hooks resolve against the
 *  GIT ROOT, so a plain subdirectory of some other repository silently disarms the gate). */
function makeRepo(suffix) {
  const dir = mkdtempSync(join(tmpdir(), `aiteamos-gate-m13-${suffix}-`))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/**
 * The absolute path of `name` on `PATH`, or `null`.
 *
 * Resolved through `PATH` rather than hardcoded, and checked here rather than left for the
 * adapter's spawn to discover: a missing binary surfaces at spawn time as a run that failed to
 * start, several minutes and one paid run into an execution that could never have passed.
 */
function resolveOnPath(name) {
  // An override that already names a path is checked where it points, not searched for on PATH --
  // `spawn` treats it that way too, so this check has to agree with the thing it is checking for.
  if (name.includes('/')) {
    try {
      accessSync(name, constants.X_OK)
      return name
    } catch {
      return null
    }
  }
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here, or not executable. Keep looking.
    }
  }
  return null
}

/**
 * The binary's own `--version`, recorded in this run's log.
 *
 * `cursor-agent` SELF-UPDATES, so the version that produced a given execution's evidence is not
 * recoverable afterwards from the binary on disk: it has to be captured here, before the run, or
 * it is gone. Never fatal -- a CLI that answers `--version` differently is not a reason to refuse
 * to measure it.
 */
function versionOf(bin) {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 60_000 }).trim().split('\n')[0] ?? '<empty>'
  } catch (cause) {
    return `<could not read --version: ${cause instanceof Error ? cause.message : String(cause)}>`
  }
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

/**
 * SIGKILLs every process still running out of one of this gate's own temporary repositories.
 *
 * The record-based kill -- every `AgentRun.pid` -- is the primary one and reaches every vendor child
 * the orchestrator itself spawned. It cannot reach what those children spawn: `cursor-agent` leaves
 * a detached per-repository `worker-server` (and a `tsserver` family) behind, documented at
 * `packages/providers/src/cursor/adapter.ts:355-360`, and none of them is on any row. Nor can it
 * reach a child whose row was written after the sweep read the rows.
 *
 * So the second sweep is by LOCATION, not by record: `/proc/<pid>/cwd` and `/proc/<pid>/cmdline`,
 * matched against the two `mkdtemp` roots this gate created. Scoped to those two paths on purpose
 * -- an operator's own editor, daemon or agent working in some other checkout is none of this
 * gate's business, and a `pkill -f cursor-agent` would take it out.
 *
 * `pgrep -f` is the fallback for a platform with no readable `/proc`; it matches the command line
 * only, so it is strictly weaker and is not the primary path.
 */
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
      haystack += `\u0000${readFileSync(`/proc/${entry}/cmdline`, 'utf8')}`
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

/** Removes any `M13 Gate`-named rows a prior interrupted run left behind, in the same FK order the
 *  `finally` block below uses: the append-only events first (no FK to `Workspace`), then the
 *  workspace, which cascades Team/Agent/Task/AgentRun/Checkpoint/ProviderConfiguration. */
async function preflightCleanup() {
  const stale = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true },
  })
  for (const workspace of stale) {
    console.log(`preflight: removing leftover workspace ${workspace.id} (${workspace.name})`)
    // A leftover workspace can still own a LIVE vendor child if a prior execution was killed
    // before its own `finally` ran. Deleting the row would lose the only record of that pid, so
    // the kill comes first here for the same reason it comes first in `finally` (Decision 12).
    const runs = await prisma.agentRun
      .findMany({ where: { agent: { team: { workspaceId: workspace.id } } }, select: { id: true, pid: true } })
      .catch(() => [])
    for (const run of runs) {
      if (run.pid === null || !isAlive(run.pid)) continue
      console.log(`preflight: killing leftover vendor child ${String(run.pid)} for run ${run.id}`)
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

let exitCode = 1
let unbudgetedRepo = null
let budgetedRepo = null
let unbudgetedWorkspaceId = null
let budgetedWorkspaceId = null
let daemon = null
let daemonOutput = ''
let daemonExited = false
let nextServer = null
let browser = null
let page = null
let diagDir = null
let budgetedTick = null
/** Pids of the `/bin/sleep` processes the second-lock probe borrows. A SET, not one variable:
 *  the two runtimes are probed concurrently, and one probe finishing must not erase the other's
 *  backstop entry before its own `finally` has run. */
const liveSleeperPids = new Set()
/** How many times a resume issued inside a real stopping window was refused by one of Decision 3's
 *  two locks. At least one is required: see stage 2's own comment. */
let stoppingWindowRefusals = 0
/** How many runs had Decision 3's SECOND lock proven against them directly. At least one is
 *  required: `proveLockTwo` needs a run still sitting in `paused`, and a runtime whose pause
 *  completed before the probe resume was issued has already been resumed by that probe. */
let lockTwoProofs = 0

/** Every `M13 Gate`-named workspace, run, checkpoint and event still in the DB, for a FAIL's
 *  diagnostic dump -- scoped by workspace NAME rather than by this run's own tracked ids, since a
 *  failure can happen before some of those ids are even set. */
async function dumpGateRows() {
  const workspaces = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true, budgetUsd: true, haltedReason: true },
  })
  const dump = []
  for (const workspace of workspaces) {
    const providers = await prisma.providerConfiguration.findMany({
      where: { workspaceId: workspace.id },
      select: { kind: true },
    })
    const tasks = await prisma.task.findMany({
      where: { workspaceId: workspace.id },
      select: { id: true, title: true, status: true, attempt: true, maxAttempts: true, activeRunId: true },
    })
    const runs = await prisma.agentRun.findMany({
      where: { agent: { team: { workspaceId: workspace.id } } },
      include: { agent: { select: { name: true } }, checkpoint: true },
      orderBy: { startedAt: 'asc' },
    })
    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { seq: 'asc' },
      select: { seq: true, runId: true, type: true, payload: true },
    })
    dump.push({
      workspace,
      providers: providers.map((row) => row.kind),
      tasks,
      runs: runs.map((run) => ({
        id: run.id,
        agent: run.agent.name,
        provider: run.provider,
        status: run.status,
        pid: run.pid,
        pidAlive: isAlive(run.pid),
        sessionId: run.sessionId,
        toolCalls: run.toolCalls,
        costUsd: run.costUsd,
        pauseReason: run.pauseReason,
        pausedAtStep: run.pausedAtStep,
        resumeRequestedAt: run.resumeRequestedAt,
        terminalAt: run.terminalAt,
        checkpoint:
          run.checkpoint === null
            ? null
            : {
                sessionId: run.checkpoint.sessionId,
                provider: run.checkpoint.provider,
                model: run.checkpoint.model,
                worktreePath: run.checkpoint.worktreePath,
                lastToolUseId: run.checkpoint.lastToolUseId,
                lastToolName: run.checkpoint.lastToolName,
                numTurns: run.checkpoint.numTurns,
                pauseReason: run.checkpoint.pauseReason,
                requestedBy: run.checkpoint.requestedBy,
                deniedToolUseIds: run.checkpoint.deniedToolUseIds,
              },
      })),
      events: events.map((event) => ({
        seq: event.seq,
        runId: event.runId,
        type: DOMAIN_EVENT_TYPE_BY_DB_VALUE[event.type] ?? event.type,
        payload: event.payload,
      })),
    })
  }
  // `ExecutionEvent.seq` is a BigInt; `JSON.stringify` refuses it outright, and a diagnostic dump
  // that throws is a diagnostic dump that is not there when it is needed.
  return JSON.stringify(dump, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
}

/** The m8a-estop-style diagnostic throw: the state that made the call, not just "it timed out".
 *  No separate `catch` -- the same all-in-`try` shape the other gates use, where the only path to
 *  `exitCode = 0` is falling off the end of the try block. */
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
      `--- daemon output (tail) ---\n${daemonTail}\n--- gate rows ---\n${rows}`,
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

// ---- Browser helpers, `gate-m11-shell.mjs`'s verbatim ---------------------------------------

/** Bounded-waits for `locator` to become visible; a timeout routes through `fail` for the full
 *  diagnostic dump instead of a bare Playwright TimeoutError. */
async function waitVisible(locator, description) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
  } catch {
    await fail(`timed out waiting for ${description} to become visible`)
  }
}

/** Fills a (possibly not-yet-hydrated) controlled input, verifying the value actually landed -- a
 *  `.fill()` that races React's hydration attaching its `onChange` handler leaves the DOM showing
 *  the typed text while the component's own state (and so the eventual PUT body) stays empty. */
async function fillReliably(locator, value, description) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS
  while (Date.now() < deadline) {
    await locator.fill(value)
    if ((await locator.inputValue()) === value) return
    await delay(100)
  }
  await fail(`could not get ${description} to hold the value ${JSON.stringify(value)}`)
}

/** Same hydration-race protection as `fillReliably`, for a `<select>`. */
async function selectReliably(locator, expectedValue, description) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS
  while (Date.now() < deadline) {
    await locator.selectOption(expectedValue)
    if ((await locator.inputValue()) === expectedValue) return
    await delay(100)
  }
  await fail(`could not get ${description} to hold the selected value ${JSON.stringify(expectedValue)}`)
}

/** Same hydration-race protection, for a checkbox: a click that lands before React's own handler
 *  is attached is a silent no-op at the DOM level, not an error Playwright can see. */
async function setCheckboxReliably(locator, checked, description) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await locator.isChecked()) === checked) return
    await locator.setChecked(checked).catch(() => {})
    await delay(100)
  }
  await fail(`could not get ${description} to become ${checked ? 'checked' : 'unchecked'}`)
}

/** Clicks `locator`, then bounded-waits for `predicate`. Deliberately does NOT re-click on every
 *  poll tick -- ordinary request latency is not a hydration race, and re-clicking would send a
 *  second real PUT while the first is still in flight. A single retry click fires only once the
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

/** The Runtime card's `role="alert"` slot must be empty. Asked by COUNT rather than by reading the
 *  text, because the element is absent entirely on the happy path and a `textContent()` on an
 *  absent locator costs the full action timeout to learn nothing. */
async function assertCardShowsNoError(stage) {
  if ((await page.getByTestId('runtime-error').count()) === 0) return
  const text = await page.getByTestId('runtime-error').first().textContent().catch(() => '<unreadable>')
  await fail(`${stage}: the Runtime card reported an error: ${JSON.stringify(text)}`)
}

/** The run row for one of this gate's workers in the unbudgeted workspace, or `null`. */
async function runForWorker(workerName) {
  return prisma.agentRun.findFirst({
    where: { agent: { name: workerName, team: { workspaceId: unbudgetedWorkspaceId } } },
    orderBy: { startedAt: 'asc' },
  })
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'aiteamos-gate-m13-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ---- Preflight. Every one of these fails FAST and by name: this gate never skips a stage, so an
  // unrunnable precondition has to be an error here rather than a stage quietly doing nothing.
  const envPath = join(repoRoot, '.env')
  if (!existsSync(envPath)) {
    throw new Error(
      `no .env at ${envPath} -- this gate runs against the DEVELOPMENT database and reads DATABASE_URL from it ` +
        '(npm run gate:m13-runtime passes --env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error(
      'DATABASE_URL is not set -- run this gate through `npm run gate:m13-runtime`, which passes --env-file=.env',
    )
  }

  const claudeBinName = process.env['AITEAMOS_CLAUDE_BIN'] ?? 'claude'
  const cursorBinName = process.env['AITEAMOS_CURSOR_BIN'] ?? 'cursor-agent'
  const claudeBin = resolveOnPath(claudeBinName)
  const cursorBin = resolveOnPath(cursorBinName)
  if (claudeBin === null) {
    throw new Error(
      `no executable ${JSON.stringify(claudeBinName)} on PATH. This gate drives the REAL Claude Code CLI; ` +
        'there is no fixture mode and no skip. Install it, or point AITEAMOS_CLAUDE_BIN at it.',
    )
  }
  if (cursorBin === null) {
    throw new Error(
      `no executable ${JSON.stringify(cursorBinName)} on PATH. This gate drives the REAL Cursor CLI; ` +
        'there is no fixture mode and no skip. Install it (it lives under ~/.local/bin on a default ' +
        'install), or point AITEAMOS_CURSOR_BIN at it.',
    )
  }
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- stages 1 and 4 drive the real Runtime card in a real browser, ` +
        'so set CHROMIUM_PATH to a real executable (e.g. a playwright-installed chromium under ' +
        '~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome) before running this gate.',
    )
  }

  // Recorded, not merely resolved. `cursor-agent` self-updates, so the version behind an
  // execution's evidence cannot be recovered from the binary afterwards.
  console.log(`claude:       ${claudeBin} (${versionOf(claudeBin)})`)
  console.log(`cursor-agent: ${cursorBin} (${versionOf(cursorBin)})`)
  console.log(`chromium:     ${chromiumPath}`)

  try {
    await prisma.$queryRaw`select 1`
  } catch (cause) {
    throw new Error(
      `the database at DATABASE_URL is not reachable (${cause instanceof Error ? cause.message : String(cause)}) -- ` +
        'start Postgres and apply migrations before running this gate.',
    )
  }

  await preflightCleanup()

  // ---- The real web shell, on a free port, and a real browser. Both are needed by stage 4, which
  // runs first, so both are booted before any stage.
  const preferredPort = await findFreePort()
  nextServer = spawn('node', ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort)], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let nextOutput = ''
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

  browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  page.on('pageerror', (error) => console.error(`[browser:pageerror] ${error}`))

  // ============================================================================================
  // Stage 4, run FIRST: the budget rule, and the card clearing it.
  //
  // Half one spawns NOTHING -- `admitProvider` refuses inside the tick's `startRun`, after the
  // adapter resolves and before any child exists -- which is exactly why it goes first: if this
  // guard is broken, it is broken in seconds rather than after two paid runs.
  // ============================================================================================
  budgetedRepo = makeRepo('budgeted')
  const budgeted = await prisma.workspace.create({
    data: {
      name: BUDGETED_WORKSPACE,
      repoPath: budgetedRepo,
      // `budgetUsd` deliberately UNSET, so the schema's `@default(20)` applies: this workspace is
      // budgeted the way every ordinary workspace in this system is, not by a special value the
      // gate invented for itself.
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  budgetedWorkspaceId = budgeted.id
  if (budgeted.budgetUsd === null) {
    await fail(`${BUDGETED_WORKSPACE} was created with a null budget: stage 4 cannot test a budgeted workspace with no budget`)
  }
  const budgetedTeam = await prisma.team.create({ data: { workspaceId: budgeted.id, name: 'Gate Team' } })
  await prisma.agent.create({
    data: { teamId: budgetedTeam.id, name: CURSOR_WORKER, role: 'backend', model: CURSOR_MODEL, provider: 'cursor' },
  })
  const budgetedTask = await prisma.task.create({
    data: {
      workspaceId: budgeted.id,
      title: TASK_TITLE,
      description: TASK_DESCRIPTION,
      status: 'ready',
      requiredRole: 'backend',
      // TWO attempts, and this is the one task in this gate that gets more than one. Stage 4 is the
      // only stage that dispatches the SAME task twice by design: once to be refused while the
      // workspace is budgeted, and once to be admitted after the card clears the budget. With
      // `maxAttempts: 1` the refusal would park the task `failed`, which is not startable, and the
      // second half of this stage could not run at all. The cost is bounded by the workspace having
      // exactly one task and no daemon -- every dispatch here is one this script asked for by name.
      maxAttempts: 2,
    },
  })
  console.log(`budgeted workspace: ${budgeted.id} (budgetUsd=${String(budgeted.budgetUsd)})`)

  // The real CLI's single tick, not a hand-built call: `startRun`'s admission re-check is what is
  // being measured, and it only runs on the dispatch path an operator actually uses.
  execFileSync('node', [ORCHESTRATOR_CLI, 'tick', '--workspace', budgeted.id], {
    cwd: repoRoot,
    timeout: TICK_TIMEOUT_MS,
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  const refusedRuns = await prisma.agentRun.findMany({ where: { agent: { team: { workspaceId: budgeted.id } } } })
  if (refusedRuns.length !== 1) {
    await fail(`stage 4: expected exactly 1 attempted run in the budgeted workspace, found ${String(refusedRuns.length)}`)
  }
  const refusedRun = refusedRuns[0]
  if (refusedRun.status !== 'failed') {
    await fail(`stage 4: the budgeted workspace's run is ${refusedRun.status}, expected failed`)
  }
  if (refusedRun.pid !== null) {
    await fail(
      `stage 4: the refused run recorded pid ${String(refusedRun.pid)} -- a refusal that spawned a process is not a ` +
        'refusal, and the cost-blind runtime was admitted after all',
    )
  }
  const refusalEvents = await prisma.executionEvent.findMany({ where: { runId: refusedRun.id }, orderBy: { seq: 'asc' } })
  const refusalReasons = refusalEvents
    .filter((event) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[event.type] === 'run.failed')
    .map((event) => (event.payload === null ? null : event.payload.reason))
  if (!refusalReasons.some((reason) => typeof reason === 'string' && reason.includes(BUDGET_REFUSAL))) {
    await fail(
      `stage 4: no run.failed event carried the exact refusal ${JSON.stringify(BUDGET_REFUSAL)} -- ` +
        `reasons seen: ${JSON.stringify(refusalReasons)}`,
    )
  }
  console.log(
    `stage 4a PASSED: a budgeted workspace (budgetUsd=${String(budgeted.budgetUsd)}) refused the cost-blind cursor ` +
      `provider with the exact text ${JSON.stringify(BUDGET_REFUSAL)}, and spawned nothing`,
  )

  // ---- Stage 4b: the operator clears the budget THROUGH THE CARD, and the same task dispatches.
  await page.goto(`${baseUrl}/w/${budgeted.id}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('runtime-budget-input'), "the budgeted workspace's Runtime card")
  await setCheckboxReliably(page.getByLabel('not budgeted'), true, 'the "not budgeted" checkbox')
  await clickUntil(
    page.getByTestId('runtime-budget-submit'),
    async () => (await prisma.workspace.findUniqueOrThrow({ where: { id: budgeted.id } })).budgetUsd === null,
    'the budget submit button on the budgeted workspace',
  )
  await assertCardShowsNoError('stage 4')
  const clearedWorkspace = await prisma.workspace.findUniqueOrThrow({ where: { id: budgeted.id } })
  if (clearedWorkspace.budgetUsd !== null) {
    await fail(`stage 4: after the card's "not budgeted" submit, budgetUsd is ${String(clearedWorkspace.budgetUsd)}, expected null`)
  }
  const reworkTask = await prisma.task.findUniqueOrThrow({ where: { id: budgetedTask.id } })
  if (!['ready', 'rework'].includes(reworkTask.status)) {
    await fail(
      `stage 4: the refused task is ${reworkTask.status}, which is not startable -- the second half of this stage ` +
        'needs the SAME task to dispatch once the budget is gone',
    )
  }

  // The second tick runs in the BACKGROUND: a one-shot `tick` owns the pump it starts and does not
  // return until the run concludes, and this stage only needs to see the run ADMITTED -- a pid and
  // a provider on the row. Waiting for the whole vendor turn would spend money on an assertion
  // already made. The run is stopped the instant that assertion holds.
  budgetedTick = spawn('node', [ORCHESTRATOR_CLI, 'tick', '--workspace', budgeted.id], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  budgetedTick.stdout.on('data', (chunk) => process.stdout.write(`[tick] ${chunk}`))
  budgetedTick.stderr.on('data', (chunk) => process.stderr.write(`[tick] ${chunk}`))

  const admittedRun = await waitUntil(
    'the unbudgeted-by-the-card workspace to dispatch its cursor run with a pid and a provider',
    DISPATCH_TIMEOUT_MS,
    async () => {
      const rows = await prisma.agentRun.findMany({
        where: { agent: { team: { workspaceId: budgeted.id } }, id: { not: refusedRun.id } },
        orderBy: { startedAt: 'asc' },
      })
      const admitted = rows.find((row) => row.pid !== null && row.provider !== null)
      if (admitted !== undefined) return { done: true, value: admitted }
      return {
        done: false,
        detail: rows.length === 0 ? 'no second run row yet' : rows.map((row) => `${row.status} pid=${String(row.pid)}`).join('; '),
      }
    },
  )
  if (admittedRun.provider !== 'cursor') {
    await fail(`stage 4: the admitted run resolved to provider ${JSON.stringify(admittedRun.provider)}, expected "cursor"`)
  }
  console.log(
    `stage 4 PASSED: the same task the budget refused dispatched on cursor (run ${admittedRun.id}, pid ` +
      `${String(admittedRun.pid)}) once the card set the workspace to "not budgeted" -- one rule, one place, ` +
      'and the card is where an operator changes it',
  )
  // Stopped immediately: the assertion is made, and every further second is the operator's money.
  const stopped = await requestStop(admittedRun.id, PAUSE_REQUESTER)
  if (!stopped.ok) console.warn(`stage 4: requestStop refused the admitted run: ${refusalText(stopped.error)}`)
  {
    const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (budgetedTick.exitCode === null && Date.now() < deadline) await delay(100)
    if (budgetedTick.exitCode === null) budgetedTick.kill('SIGKILL')
  }

  // ============================================================================================
  // Stage 1: the card writes the configuration.
  //
  // The workspace is created BUDGETED (the schema's `@default(20)`) and with no
  // `ProviderConfiguration` row at all -- the state a freshly created workspace is really in. Both
  // facts are then changed from the browser, and both are asserted against the DB rather than
  // against anything the page claims.
  // ============================================================================================
  unbudgetedRepo = makeRepo('unbudgeted')
  const workspace = await prisma.workspace.create({
    data: { name: UNBUDGETED_WORKSPACE, repoPath: unbudgetedRepo, verifyCommands: ['true'], setupCommands: [] },
  })
  unbudgetedWorkspaceId = workspace.id
  console.log(`unbudgeted workspace: ${workspace.id} (budgetUsd=${String(workspace.budgetUsd)} at creation)`)

  await page.goto(`${baseUrl}/w/${workspace.id}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('runtime-provider'), 'the Runtime card')

  await selectReliably(page.getByLabel('workspace provider'), 'cursor', 'the workspace provider select')
  await clickUntil(
    page.getByTestId('runtime-provider-submit'),
    async () => (await prisma.providerConfiguration.count({ where: { workspaceId: workspace.id, kind: 'cursor' } })) === 1,
    'the provider submit button',
  )

  // Decision 9: ONE row, or none. A second row would make `workspaceDefaultProvider` return null
  // and silently stop every dispatch in the workspace, which is the failure `setWorkspaceProvider`
  // replaces-in-one-transaction to avoid -- so the COUNT is the assertion, not just the kind.
  const providerRows = await prisma.providerConfiguration.findMany({ where: { workspaceId: workspace.id } })
  if (providerRows.length !== 1) {
    await fail(
      `stage 1: the workspace holds ${String(providerRows.length)} ProviderConfiguration rows after the card set its ` +
        `provider (${JSON.stringify(providerRows.map((row) => row.kind))}); Decision 9 says exactly one`,
    )
  }
  if (providerRows[0].kind !== 'cursor') {
    await fail(`stage 1: the ProviderConfiguration row reads ${JSON.stringify(providerRows[0].kind)}, expected "cursor"`)
  }

  // The derived warning, and the SSE wake-up that delivers it. The card holds no optimistic state:
  // `costBlindBudgeted` is computed on the SERVER from the saved pair, reaches this page through
  // `/api/w/[id]/overview`, and is refetched because `setWorkspaceProvider` appended
  // `workspace.settings_changed` and `useWorkspaceStream` treats every event as a wake-up. A
  // warning appearing here with nothing but a select changed is that whole path, end to end.
  await waitVisible(
    page.getByTestId('runtime-cost-blind-warning'),
    'the cost-blind warning after a cost-blind provider was set on a still-budgeted workspace',
  )
  console.log('stage 1: the cost-blind warning appeared on the still-budgeted workspace, delivered by the SSE wake-up')

  await setCheckboxReliably(page.getByLabel('not budgeted'), true, 'the "not budgeted" checkbox')
  await clickUntil(
    page.getByTestId('runtime-budget-submit'),
    async () => (await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).budgetUsd === null,
    'the budget submit button',
  )
  const configured = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  if (configured.budgetUsd !== null) {
    await fail(`stage 1: Workspace.budgetUsd is ${String(configured.budgetUsd)} after the card cleared it, expected null`)
  }
  // And the warning goes away, because the pair is no longer the one dispatch refuses. Same path,
  // same wake-up, the other direction -- which is what proves the first direction was not a
  // first-render coincidence.
  await waitUntil('the cost-blind warning to disappear once the workspace is no longer budgeted', ACTION_TIMEOUT_MS, async () => {
    const visible = await page.getByTestId('runtime-cost-blind-warning').first().isVisible().catch(() => false)
    return visible ? { done: false, detail: 'still showing' } : { done: true, value: true }
  })
  await assertCardShowsNoError('stage 1')
  console.log(
    `stage 1 PASSED: through the real Runtime card, in a real browser, the workspace's provider became "cursor" ` +
      '(exactly one ProviderConfiguration row) and its budget became null -- both read back off the DB',
  )

  // ============================================================================================
  // Stage 2: a pause is a stop, on both runtimes. The milestone's whole claim.
  // ============================================================================================
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Gate Team' } })
  // Both workers carry an explicit `(model, provider)` pair: `resolveRuntime` only consults a level
  // that NAMES a model, so a worker with a null model would fall through to the workspace default
  // (now `cursor`, thanks to stage 1) and both runs would land on the same runtime -- which is the
  // one thing this stage cannot afford.
  const claudeAgent = await prisma.agent.create({
    data: { teamId: team.id, name: CLAUDE_WORKER, role: 'backend', model: CLAUDE_MODEL, provider: 'claude_code' },
  })
  const cursorAgent = await prisma.agent.create({
    data: { teamId: team.id, name: CURSOR_WORKER, role: 'backend', model: CURSOR_MODEL, provider: 'cursor' },
  })
  for (const suffix of ['A', 'B']) {
    await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: `${TASK_TITLE} (${suffix})`,
        description: TASK_DESCRIPTION,
        status: 'ready',
        requiredRole: 'backend',
        maxAttempts: 1,
      },
    })
  }
  console.log(
    `workers: ${CLAUDE_WORKER}=${claudeAgent.id} (claude_code/${CLAUDE_MODEL}), ` +
      `${CURSOR_WORKER}=${cursorAgent.id} (cursor/${CURSOR_MODEL})`,
  )

  // The real daemon, in the background -- the same thing an operator leaves running.
  daemon = spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspace.id, '--period', '500'], {
    cwd: repoRoot,
    env: process.env,
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

  const dispatched = await waitUntil('both workers to be dispatched with a pid and a provider', DISPATCH_TIMEOUT_MS, async () => {
    const claudeRun = await runForWorker(CLAUDE_WORKER)
    const cursorRun = await runForWorker(CURSOR_WORKER)
    const ready = (run) => run !== null && run.pid !== null && run.provider !== null
    if (ready(claudeRun) && ready(cursorRun)) return { done: true, value: { claudeRun, cursorRun } }
    const describe = (run) => (run === null ? 'no run' : `${run.status} pid=${String(run.pid)} provider=${String(run.provider)}`)
    return { done: false, detail: `${CLAUDE_WORKER}: ${describe(claudeRun)}; ${CURSOR_WORKER}: ${describe(cursorRun)}` }
  })
  if (dispatched.claudeRun.provider !== 'claude_code') {
    await fail(`stage 2: ${CLAUDE_WORKER}'s run resolved to ${JSON.stringify(dispatched.claudeRun.provider)}, expected "claude_code"`)
  }
  if (dispatched.cursorRun.provider !== 'cursor') {
    await fail(`stage 2: ${CURSOR_WORKER}'s run resolved to ${JSON.stringify(dispatched.cursorRun.provider)}, expected "cursor"`)
  }
  const claudeRunId = dispatched.claudeRun.id
  const cursorRunId = dispatched.cursorRun.id
  const claudeTaskId = dispatched.claudeRun.taskId
  const cursorTaskId = dispatched.cursorRun.taskId
  if (claudeTaskId === null || cursorTaskId === null) {
    await fail('stage 2: a dispatched worker run carries no taskId, so no attempt count can be compared against it')
  }

  /**
   * Proves Decision 3's SECOND lock directly, in the only way it is observable.
   *
   * `run_still_stopping` fires when a run's row reads `paused` and its pid is still ALIVE. Decision
   * 1 plus the pump's ordering (checkpoint -> kill -> `paused`) is what makes that state
   * unreachable in a correct system: `killWithEscalation` SIGKILLs at the grace deadline and waits
   * for the process to be gone before `paused` is ever written. So the second lock cannot be
   * observed by watching a healthy pause -- it exists precisely to catch a FUTURE regression in
   * that ordering, and this is what such a regression would look like.
   *
   * So the state is constructed, deliberately and narrowly: a real process this gate spawns
   * (`/bin/sleep`), its pid written onto the already-`paused` row, the REAL `requestResume` called,
   * and the row put back exactly as it was. Nothing about the pump is faked and nothing about the
   * refusal is simulated -- the run really is `paused`, the pid really is alive, and the answer
   * really is the one an operator would get.
   */
  async function proveLockTwo(label, runId) {
    const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    if (before.status !== 'paused') {
      await fail(`stage 2: ${label} is ${before.status}, not paused, when the second lock was probed`)
    }
    const sleeper = spawn('/bin/sleep', ['120'], { stdio: 'ignore' })
    const sleeperPid = sleeper.pid ?? null
    if (sleeperPid === null) await fail('stage 2: could not spawn the live process the second lock is probed with')
    liveSleeperPids.add(sleeperPid)
    try {
      await prisma.agentRun.update({ where: { id: runId }, data: { pid: sleeperPid } })
      const refused = await requestResume(runId, null, PAUSE_REQUESTER)
      if (refused.ok) {
        await fail(
          `stage 2: ${label} accepted a resume while its recorded pid (${String(sleeperPid)}) was ALIVE. ` +
            'Decision 3\'s second lock is not holding: this is the state that puts two agents on one branch.',
        )
      }
      if (refused.error.kind !== 'run_still_stopping') {
        await fail(
          `stage 2: ${label} with a live pid was refused as ${refused.error.kind} (${refusalText(refused.error)}), ` +
            'expected run_still_stopping',
        )
      }
      if (refusalText(refused.error) !== STILL_STOPPING_REFUSAL) {
        await fail(`stage 2: the run_still_stopping text drifted: ${JSON.stringify(refusalText(refused.error))}`)
      }
      // The refusal must have recorded NOTHING: a lock that refuses and still arms the intent has
      // only postponed the failure it was there to prevent.
      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
      if (after.resumeRequestedAt !== null) {
        await fail(`stage 2: ${label}'s refused resume still wrote resumeRequestedAt=${String(after.resumeRequestedAt)}`)
      }
    } finally {
      // The row goes back exactly as it was found, before anything else can read the borrowed pid
      // -- including this script's own `finally`, which kills vendor children BY pid.
      await prisma.agentRun.update({ where: { id: runId }, data: { pid: before.pid } }).catch(() => {})
      try {
        sleeper.kill('SIGKILL')
      } catch {
        // Already gone; the outcome we wanted anyway.
      }
      liveSleeperPids.delete(sleeperPid)
    }
    lockTwoProofs += 1
    console.log(`stage 2: ${label} -- the second lock refused a resume against a LIVE pid with the verbatim text`)
  }

  /**
   * Pauses one run and proves the locks in the order they actually fire.
   *
   * THE IMMEDIATE RESUME IS ISSUED THE INSTANT `run.pause_requested` IS IN THE LOG -- not after a
   * sleep, and not after `run.paused`. `requestPause` appends that event and then returns, so "the
   * instant it is in the log" is the instant `requestPause` resolves, and that is the only window
   * in which the run is still stopping with a child that is still alive.
   *
   * WHICH LOCK ANSWERS IN THAT WINDOW IS DECIDED BY DECISION 2, NOT BY THIS GATE. The pause path is
   * checkpoint -> kill -> `paused`, so for the whole of the kill's grace window the row reads
   * `pause_requested` (Decision 2 states this in as many words) and `requestResume`'s STATUS check
   * -- the first lock -- is what refuses, with `wrong_status`. The second lock, `run_still_stopping`,
   * needs a row that reads `paused` with a live pid, which that same ordering makes unreachable:
   * `resume.ts`'s own comment says so ("Task 1's pump ordering is what makes this unreachable in a
   * correct system"). The brief and spec §7.2 name `run_still_stopping` for this window; spec §3.2
   * and Decision 2 are what actually decide the answer, and the spec wins. So this accepts EITHER
   * lock, names which one fired, and refuses to accept the one thing neither lock may ever do:
   * hand out the resume while the child is alive. `proveLockTwo` above proves the second lock
   * separately and directly, which is the only honest way it can be proved at all.
   *
   * There is a THIRD answer, and only Cursor gives it: its pause path claims `paused` before it
   * writes the checkpoint, so a probe landing between the two is refused `no_checkpoint`. Also a
   * refusal inside the window, also counted, and named as itself rather than as a lock.
   *
   * And there is a fourth outcome, which is not a refusal at all: on Cursor the whole pause can
   * COMPLETE before this probe is issued (`requestPause` does not return until the child is dead,
   * and the pump can finish first), in which case the resume is correctly granted and this run
   * simply continues on it. That is Decision 1 holding rather than a lock failing, so it is not
   * counted -- and the gate requires at least one real window and one second-lock proof across the
   * two runtimes, so an execution that observed neither fails rather than passing on nothing.
   */
  async function pauseThenResume(label, runId, taskId) {
    const before = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })

    await waitUntil(`${label} to be working with at least one tool call recorded`, WORKING_TIMEOUT_MS, async () => {
      const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
      if (row.status === 'working' && row.toolCalls >= 1) return { done: true, value: row }
      if (TERMINAL_STATUSES.has(row.status)) {
        await fail(
          `stage 2: ${label} reached ${row.status} before the gate could pause it (toolCalls=${String(row.toolCalls)}). ` +
            'There is nothing left to interrupt, so the pause could not be measured on this run.',
        )
      }
      return { done: false, detail: `${row.status} toolCalls=${String(row.toolCalls)}` }
    })

    // The run's tool-call count at the last instant before the flag exists. Stage 3 needs it: on a
    // Cursor run the ENTIRE pause window lies before `run.pause_requested` is appended (that append
    // is the last thing `requestPause` does, after `killWithEscalation` has already returned), so
    // the event log cannot bound the window and this counter is what does.
    const beforePauseRow = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    const toolCallsBeforePause = beforePauseRow.toolCalls

    const requested = await requestPause(runId, PAUSE_REQUESTER, 'human')
    if (!requested.ok) await fail(`stage 2: ${label}: requestPause refused: ${refusalText(requested.error)}`)

    await waitUntil(`${label} to announce run.pause_requested`, PAUSE_SETTLE_TIMEOUT_MS, async () => {
      const seen = await prisma.executionEvent.count({ where: { runId, type: 'run_pause_requested' } })
      return seen > 0 ? { done: true, value: true } : { done: false, detail: 'not announced yet' }
    })

    // The locks, in their only observable window.
    //
    // The row is sampled on BOTH sides of the verb, and the liveness sample is taken BEFORE it
    // (review round 1, Minor 3 -- which then bit for real). Reading only afterwards is a race the
    // gate loses on its own: a granted resume is claimed by the daemon's resume pass within
    // milliseconds, so the post-verb read can already say `resuming`, and an assertion written
    // against it fails a run that did nothing wrong. The pre-verb sample cannot drift the dangerous
    // way either -- a pid that was dead before the call cannot be alive during it.
    const beforeProbe = await prisma.agentRun.findUnique({ where: { id: runId }, include: { checkpoint: true } })
    if (beforeProbe === null) await fail(`stage 2: ${label}'s run row disappeared before its stopping window was probed`)
    const beforeProbeAlive = isAlive(beforeProbe.pid)
    const early = await requestResume(runId, null, PAUSE_REQUESTER)
    const afterProbe = await prisma.agentRun.findUnique({ where: { id: runId }, include: { checkpoint: true } })
    if (afterProbe === null) await fail(`stage 2: ${label}'s run row disappeared while its stopping window was probed`)
    if (early.ok) {
      // The one unrecoverable answer, and it is about the CHILD, not about the status column: a
      // resume handed out while the paused run's process is still alive puts two agents on one
      // branch. Asserted against the pre-verb liveness sample, which is the operating system's
      // answer and not the product's own bookkeeping.
      if (beforeProbeAlive) {
        await fail(
          `stage 2: ${label}: a resume issued inside the stopping window was ACCEPTED while pid ` +
            `${String(beforeProbe.pid)} was still ALIVE (row read ${beforeProbe.status}); it must be refused`,
        )
      }
      if (beforeProbe.checkpoint === null && afterProbe.checkpoint === null) {
        await fail(
          `stage 2: ${label}: a resume was ACCEPTED for a run with no checkpoint -- there is nothing to continue it ` +
            'from, and the daemon will claim it and then fail to spawn',
        )
      }
      // ...and it is now the resume this run gets. Asking again would be refused as `wrong_status`
      // the moment the daemon's resume pass claims it -- which is what execution 1 did, and what
      // this branch exists to not do twice. Nothing else about the pause is weakened: the child was
      // dead before the verb was called, which is Decision 1 holding, measured against the OS. Only
      // the stopping WINDOW went unobserved on this runtime.
      console.warn(
        `stage 2: ${label}: the pause had already COMPLETED by the time the probe resume was issued (row ` +
          `${beforeProbe.status} before the call and ${afterProbe.status} after it, pid ${String(beforeProbe.pid)} ` +
          'already dead), so no stopping window was observable on this runtime this execution. That is Decision 1 ' +
          'holding, not a lock failing -- but it proves nothing about the locks, so it is not counted, and the ' +
          "probe's own resume is the one this run continues on.",
      )
    } else if (early.error.kind === 'run_still_stopping') {
      if (refusalText(early.error) !== STILL_STOPPING_REFUSAL) {
        await fail(`stage 2: ${label}: the run_still_stopping text drifted: ${JSON.stringify(refusalText(early.error))}`)
      }
      stoppingWindowRefusals += 1
      console.log(`stage 2: ${label}: the stopping window was refused by the SECOND lock (run_still_stopping)`)
    } else if (early.error.kind === 'wrong_status' && early.error.status === 'pause_requested') {
      stoppingWindowRefusals += 1
      console.log(
        `stage 2: ${label}: the stopping window was refused by the FIRST lock -- the row read "pause_requested", ` +
          'exactly as Decision 2 says it does for the whole of the kill\'s grace window',
      )
    } else if (early.error.kind === 'no_checkpoint') {
      // The third answer this window can give, and it is Cursor's alone. Cursor's pause path claims
      // `paused` FIRST and writes the checkpoint after (`recordCursorPauseIfRequested` -- the child
      // is already dead by then, so the claim IS the moment the run became paused), and the
      // checkpoint write shells out to git twice on the way. A probe that lands between the two
      // reads a `paused` row with nothing to resume from, and `requestResume` refuses it for that
      // reason rather than for a liveness one. Counted: the resume was refused inside the stopping
      // window, which is what this probe is measuring, and NOT confused with the two locks, whose
      // names are what the two branches above report.
      stoppingWindowRefusals += 1
      console.log(
        `stage 2: ${label}: the stopping window was refused because the pause's own checkpoint had not landed yet ` +
          '(no_checkpoint) -- the row was paused, the child was dead, and there was still nothing to resume from',
      )
    } else {
      await fail(
        `stage 2: ${label}: a resume issued inside the stopping window was refused as ${early.error.kind} ` +
          `(${refusalText(early.error)}), which is neither of Decision 3's two locks. The row read ` +
          `${beforeProbe.status} (pid ${String(beforeProbe.pid)}, alive=${String(beforeProbeAlive)}) before the call ` +
          `and ${afterProbe.status} after it.`,
      )
    }
    // Whichever lock answered, nothing may have been recorded: a refusal that still arms the intent
    // would be executed by the very next tick.
    if (!early.ok && afterProbe.resumeRequestedAt !== null) {
      await fail(`stage 2: ${label}: a refused resume still wrote resumeRequestedAt=${String(afterProbe.resumeRequestedAt)}`)
    }

    // `run.paused` is what the pump announces AFTER the kill, so waiting for it -- not for the row
    // -- is waiting for the pause protocol to be complete. Required on both paths: the probe branch
    // above proved the ROW was paused with a dead pid, and this proves the announcement went out.
    await waitUntil(`${label} to announce run.paused`, PAUSE_SETTLE_TIMEOUT_MS, async () => {
      const announced = await prisma.executionEvent.count({ where: { runId, type: 'run_paused' } })
      return announced > 0 ? { done: true, value: true } : { done: false, detail: 'run.paused not announced yet' }
    })

    // The checkpoint is what stage 3 reads, and it outlives the resume -- so on the granted path it
    // is fetched directly rather than taken from a row snapshot the daemon may already have moved
    // on. `pid` and `pausedAtStep` are carried from the pre-verb sample, which is the last read
    // taken while the run was still paused.
    let paused = beforeProbe
    if (early.ok) {
      const checkpoint = await waitUntil(`${label}'s pause checkpoint to be readable`, PAUSE_SETTLE_TIMEOUT_MS, async () => {
        const row = await prisma.checkpoint.findUnique({ where: { runId } })
        return row === null ? { done: false, detail: 'no checkpoint written yet' } : { done: true, value: row }
      })
      paused = { ...beforeProbe, checkpoint }
    }
    if (!early.ok) {
      paused = await waitUntil(`${label} to settle on paused with a dead process`, PAUSE_SETTLE_TIMEOUT_MS, async () => {
        const row = await prisma.agentRun.findUnique({ where: { id: runId }, include: { checkpoint: true } })
        if (row === null) return { done: false, detail: 'the run row disappeared' }
        if (TERMINAL_STATUSES.has(row.status)) {
          await fail(
            `stage 2: ${label} went ${row.status} instead of paused after requestPause -- the pause signal did not stop ` +
              'the run, it ended it',
          )
        }
        if (row.status !== 'paused') return { done: false, detail: `status ${row.status}` }
        // Decision 1, asserted against the operating system rather than against a status column.
        if (isAlive(row.pid)) return { done: false, detail: `paused and announced, but pid ${String(row.pid)} is alive` }
        if (row.checkpoint === null) return { done: false, detail: 'paused with no checkpoint' }
        return { done: true, value: row }
      })
      // The assertion Decision 1 actually makes, restated once the wait has ended: by the time
      // `run.paused` is in the log, the pid is gone. The wait above would have timed out otherwise;
      // this says it as a fact rather than as an absence.
      if (isAlive(paused.pid)) {
        await fail(`stage 2: ${label} is paused and announced, but pid ${String(paused.pid)} is still alive (Decision 1)`)
      }
    }
    if (paused.checkpoint === null || paused.checkpoint.sessionId === null || paused.checkpoint.sessionId === '') {
      await fail(`stage 2: ${label}'s checkpoint carries no sessionId -- nothing could resume it`)
    }
    console.log(
      `stage 2: ${label} paused at step ${String(paused.pausedAtStep)} with a DEAD pid ${String(paused.pid)}, ` +
        `checkpoint session ${paused.checkpoint.sessionId} on ${String(paused.checkpoint.provider)}`,
    )

    if (early.ok) {
      // The probe's own resume is this run's resume; there is nothing left to ask for, and the run
      // is not `paused` any more for `proveLockTwo` to borrow.
      console.log(`stage 2: ${label}: continuing on the resume the stopping-window probe was granted`)
    } else {
      await proveLockTwo(label, runId)
      const accepted = await requestResume(runId, null, PAUSE_REQUESTER)
      if (!accepted.ok) await fail(`stage 2: ${label}: the resume after run.paused was refused: ${refusalText(accepted.error)}`)
    }

    await waitUntil(`${label} to succeed after its resume`, RESUME_TERMINAL_TIMEOUT_MS, async () => {
      const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
      if (row.status === 'succeeded') return { done: true, value: row }
      if (row.terminalAt !== null) {
        await fail(
          `stage 2: ${label} reached ${row.status} after its resume, not succeeded -- a stop that cannot be resumed ` +
            'back to a finished run is not a pause',
        )
      }
      return { done: false, detail: row.status }
    })

    const after = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    if (after.attempt !== before.attempt) {
      await fail(
        `stage 2: ${label}: a pause-and-resume cost an attempt (${String(before.attempt)} -> ${String(after.attempt)}); ` +
          'only FAILURES count (Decision 4)',
      )
    }
    return { ...paused, toolCallsBeforePause }
  }

  // Driven CONCURRENTLY, and that is not a speed optimisation: the two runtimes' first turns are
  // seconds apart, and pausing them in sequence would leave whichever one finished first with
  // nothing left to interrupt.
  const [claudePaused, cursorPaused] = await Promise.all([
    pauseThenResume(`${CLAUDE_WORKER}'s run`, claudeRunId, claudeTaskId),
    pauseThenResume(`${CURSOR_WORKER}'s run`, cursorRunId, cursorTaskId),
  ])
  if (stoppingWindowRefusals === 0) {
    await fail(
      'stage 2: neither runtime showed a stopping window at all -- both pauses had already completed by the time the ' +
        'probe resume was issued, so nothing was measured about the refusal Decision 3 exists to make. Re-run; if it ' +
        'happens repeatedly the pause has become instantaneous and this probe needs rethinking.',
    )
  }
  if (lockTwoProofs === 0) {
    await fail(
      "stage 2: Decision 3's second lock was never put to a live pid on either runtime, so `run_still_stopping` and its " +
        'verbatim text went unmeasured this execution. `proveLockTwo` needs a run still sitting in `paused`, and both ' +
        'runs were resumed by their own stopping-window probe -- re-run.',
    )
  }
  console.log(
    `stage 2 PASSED: on BOTH runtimes a pause requested while working stopped the child before "paused" was published, ` +
      `a resume issued inside the stopping window was refused (${String(stoppingWindowRefusals)}/2 windows observed), ` +
      `Decision 3's second lock refused a live pid with its verbatim text (${String(lockTwoProofs)}/2 runs probed), a ` +
      'resume was accepted after run.paused, both runs reached succeeded, and neither task lost an attempt',
  )

  // ============================================================================================
  // Stage 3: Cursor's gate, proven -- against the gate this run was actually armed with.
  //
  // WHAT THIS STAGE CAN AND CANNOT ESTABLISH, stated first because the distinction is the whole
  // design (review round 1, Important 3). The LIVE refusal -- a real `cursor-agent` attempting a
  // shell command and a file write with the flag present and having both rejected -- is Series C's,
  // recorded and COMMITTED at `packages/providers/test/fixtures/cursor/gate/`, and Decision 8 makes
  // committed evidence, not a gate re-measurement, what raises a capability. This stage does not
  // re-measure the runtime and must not pretend to: Cursor declares `canPauseMidRun: false`, so its
  // pause is a cancellation and the flag exists only between `signalPause` writing it and
  // `killWithEscalation` landing -- a sub-second window no prompt can reliably steer a model into.
  //
  // What this stage measures instead is the ARMING, which is live, is about the run that just
  // happened, and can fail:
  //
  //   1. the capability table still reads `all-tools`;
  //   2. the fixture that raised it still contains the refusal it rests on -- so deleting or
  //      rewriting the evidence fails this gate rather than silently orphaning the capability;
  //   3. the `.cursor/hooks.json` THIS run was armed with registers a gate at BOTH
  //      `beforeShellExecution` and `preToolUse`, each `failClosed: true`, and each naming a
  //      `command` that unquotes to an existing, executable script which really is this
  //      deployment's `cursor-shell-gate.sh`. A run armed with a stale, moved or wrong path used to
  //      pass this stage, because the stage ran the repository's own copy regardless of what the
  //      file said;
  //   4. THAT path -- the armed one, not the repository's -- answers `deny` to both hook payloads
  //      while this run's own pause flag exists;
  //   5. and if the run did attempt tool calls inside its pause window, they were refused.
  // ============================================================================================
  const cursorCapabilities = capabilitiesOf('cursor')
  if (cursorCapabilities.gate !== 'all-tools') {
    await fail(
      `stage 3: capabilitiesOf('cursor').gate is ${JSON.stringify(cursorCapabilities.gate)}, expected "all-tools" -- ` +
        'Series C raised it on committed evidence, and a table that no longer says so is a capability that lost its proof',
    )
  }
  // The evidence itself, still on disk and still saying what the capability claims. Cheap, and it
  // closes the one way `all-tools` could quietly become an unsupported assertion: the fixture being
  // deleted or rewritten while the table keeps its value.
  const gateFixture = join(repoRoot, 'packages/providers/test/fixtures/cursor/gate/run-2-flag-present.ndjson')
  if (!existsSync(gateFixture)) {
    await fail(
      `stage 3: the recording the 'all-tools' capability rests on is gone (${gateFixture}). Decision 8 raises a ` +
        'capability on committed evidence; evidence that is not there any more raises nothing.',
    )
  }
  {
    const recorded = readFileSync(gateFixture, 'utf8')
    if (!recorded.includes('"rejected"')) {
      await fail(
        `stage 3: ${gateFixture} no longer contains a rejected tool call. That refusal is the entire basis for ` +
          "capabilitiesOf('cursor').gate === 'all-tools'.",
      )
    }
  }

  /**
   * Undoes `buildCursorHooks`'s `shellQuote` (`packages/providers/src/cursor/hooks.ts`), which
   * writes `'<path>'` with any embedded quote as `'\''`. `command` is a shell COMMAND LINE, not an
   * argv array, so this is the only correct way to read the path back out of it.
   */
  function unquoteHookCommand(command) {
    if (typeof command !== 'string') return null
    const trimmed = command.trim()
    if (trimmed.length < 2 || !trimmed.startsWith("'") || !trimmed.endsWith("'")) return trimmed === '' ? null : trimmed
    return trimmed.slice(1, -1).replaceAll("'\\''", "'")
  }

  // The gate script THIS deployment arms runs with, resolved exactly as `apps/orchestrator/src/cli.ts`
  // resolves it (`cursorGatePath()`): the env override first, the repository's own copy otherwise.
  // Mirroring that resolution rather than hardcoding the repository path is what keeps an installed
  // daemon -- whose layout is deliberately not this one -- from failing a stage it is passing.
  const configuredGatePath = (() => {
    const fromEnv = process.env['AITEAMOS_CURSOR_GATE_PATH']
    return fromEnv !== undefined && fromEnv !== '' ? resolve(fromEnv) : join(repoRoot, 'scripts/cursor-shell-gate.sh')
  })()
  if (!existsSync(configuredGatePath)) await fail(`stage 3: no cursor gate script at ${configuredGatePath}`)
  const expectedGateReal = realpathSync(configuredGatePath)

  const cursorWorktree = cursorPaused.checkpoint.worktreePath
  const cursorHooksFile = join(cursorWorktree, '.cursor', 'hooks.json')
  if (!existsSync(cursorHooksFile)) {
    await fail(
      `stage 3: the Cursor run's worktree has no ${cursorHooksFile} -- \`cursor-agent\` resolves hooks against the GIT ` +
        'ROOT of the workspace, so a run with no file there ran with no gate at all',
    )
  }
  let cursorHooks = null
  try {
    cursorHooks = JSON.parse(readFileSync(cursorHooksFile, 'utf8'))
  } catch (cause) {
    await fail(`stage 3: ${cursorHooksFile} is not readable JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  /** The gate path each registration actually armed, proven to be the real one. */
  const armedGatePaths = []
  for (const registration of ['beforeShellExecution', 'preToolUse']) {
    const entries = cursorHooks?.hooks?.[registration]
    if (!Array.isArray(entries) || entries.length === 0) {
      await fail(
        `stage 3: the hooks file this run was armed with registers nothing at ${registration} ` +
          `(${JSON.stringify(cursorHooks)}). Without ${registration} the gate is not \`all-tools\` -- ` +
          '`beforeShellExecution` alone is `shell-only`, which is the value the capability used to hold.',
      )
    }
    for (const entry of entries) {
      if (entry?.failClosed !== true) {
        await fail(
          `stage 3: the ${registration} registration is ${JSON.stringify(entry)} -- without \`failClosed: true\` a gate ` +
            'that crashes, times out or writes nothing lets the tool call run as if no gate existed',
        )
      }
      const armed = unquoteHookCommand(entry.command)
      if (armed === null || !isAbsolute(armed)) {
        await fail(
          `stage 3: the ${registration} registration's command is ${JSON.stringify(entry.command)}, which does not ` +
            'unquote to an absolute path. Cursor evaluates it with an unreliable cwd, so a relative gate is a gate ' +
            'that may or may not resolve depending on the run.',
        )
      }
      try {
        accessSync(armed, constants.X_OK)
      } catch {
        await fail(
          `stage 3: the ${registration} registration arms ${JSON.stringify(armed)}, which does not exist or is not ` +
            'executable. Under `failClosed: true` that is not a disarmed gate -- it is a gate that blocks every tool ' +
            'call of every run in this worktree, and nothing in the run says so.',
        )
      }
      const armedReal = realpathSync(armed)
      if (armedReal !== expectedGateReal) {
        await fail(
          `stage 3: the ${registration} registration arms ${JSON.stringify(armedReal)}, but this deployment's cursor ` +
            `gate is ${JSON.stringify(expectedGateReal)}. The run was armed with something else -- a stale path from ` +
            'an earlier layout, or another script entirely -- and whatever it answers is not what this gate measures.',
        )
      }
      armedGatePaths.push(armedReal)
    }
  }

  /** Runs the gate script the RUN WAS ARMED WITH -- not the repository's copy -- with the hook
   *  payload `cursor-agent` sends at one of its two registrations, against a pause flag at this
   *  run's own path. Asking the repository's copy would answer a question about the checkout rather
   *  than about the run. */
  function askArmedCursorGate(gatePath, payload, pauseFlagPath) {
    return execFileSync('bash', [gatePath], {
      cwd: repoRoot,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, AITEAMOS_PAUSE_FLAG: pauseFlagPath },
    })
  }
  const cursorFlagPath = cursorPaused.checkpoint.pauseFlagPath
  // The flag was written by `signalPause` and cleared by `resume()`, so by now it is gone; the
  // question this stage asks is what the gate does WHILE it exists, so the same one-line file is
  // written back at the same path, with the same requester text, and removed again afterwards.
  writeFileSync(cursorFlagPath, `${PAUSE_REQUESTER}\n`, 'utf8')
  let shellVerdict = null
  let writeVerdict = null
  try {
    shellVerdict = askArmedCursorGate(
      armedGatePaths[0],
      { hook_event_name: 'beforeShellExecution', command: 'echo there > world.txt' },
      cursorFlagPath,
    )
    writeVerdict = askArmedCursorGate(
      armedGatePaths[1],
      { hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: 'world.txt', content: 'there\n' } },
      cursorFlagPath,
    )
  } finally {
    rmSync(cursorFlagPath, { force: true })
  }
  for (const [what, verdict] of [
    ['a shell command (beforeShellExecution)', shellVerdict],
    ['a file write (preToolUse)', writeVerdict],
  ]) {
    if (!verdict.includes('"permission":"deny"')) {
      await fail(
        `stage 3: with the pause flag present, the gate this run was armed with answered ${JSON.stringify(verdict)} ` +
          `for ${what} -- a gate declared \`all-tools\` that lets one of them through is a capability the table is ` +
          'lying about',
      )
    }
  }

  // ---- What the run itself did inside its pause window, and what the record can honestly say.
  //
  // THE EVENT LOG CANNOT BOUND THIS WINDOW, and the first version of this check was wrong for
  // exactly that reason. On a Cursor run `requestPause` writes the flag, calls `killWithEscalation`,
  // waits for the child to be dead, and only THEN appends `run.pause_requested` -- so every call the
  // agent attempted with the flag in place has a LOWER `seq` than the pause's own announcement, and
  // a window measured between `run.pause_requested` and `run.paused` is empty by construction. It
  // reported "nothing landed" on every rehearsal, including ones where a call demonstrably had.
  //
  // So the window is bounded by the pump's own COUNTER: `toolCallsBeforePause` is the run's
  // `toolCalls` read at the last instant before the flag existed, `Checkpoint.numTurns` is the same
  // counter at the moment the pause was recorded, and their difference is what the agent attempted
  // in between.
  //
  // WHAT `Checkpoint.deniedToolUseIds` IS, AND IS NOT, ON A CURSOR RUN. It is written from the
  // PUMP's `denied` array, which is fed only by `permission_denied` and `hook_denied` events
  // (`pump.ts`'s `case 'permission_denied'` and the gate-outcome branch). Cursor's parser emits
  // neither: a refusal reaches this system as `result.rejected` on a `tool_call`/`completed` line,
  // which the ADAPTER collects into `RunOutcome.deniedToolUseIds` -- the TERMINAL outcome, which a
  // run killed mid-stream never produces. So an empty list on a paused Cursor run is not evidence
  // that nothing was refused; it is the shape of the column. Spec §7.2's "the run's
  // `Checkpoint.deniedToolUseIds` is non-empty" is not reachable for a paused Cursor run, and this
  // gate says that rather than asserting it and passing on a tautology or failing on a healthy run.
  //
  // What IS asserted here is the one thing the record can be wrong about: a refusal list longer than
  // the calls that were attempted in the window would mean the list came from somewhere else, and
  // `pump.ts` reads exactly that list to decide a Cursor run was paused rather than finished.
  const cursorNumTurns = cursorPaused.checkpoint.numTurns
  const callsInPauseWindow = Math.max(0, cursorNumTurns - cursorPaused.toolCallsBeforePause)
  const denied = cursorPaused.checkpoint.deniedToolUseIds
  for (const id of denied) {
    if (typeof id !== 'string' || id === '') {
      await fail(`stage 3: the checkpoint records an empty denied call id (${JSON.stringify(denied)})`)
    }
  }
  if (denied.length > callsInPauseWindow) {
    await fail(
      `stage 3: the checkpoint records ${String(denied.length)} refused call(s) but only ` +
        `${String(callsInPauseWindow)} tool call(s) were attempted inside the pause window (tool calls ` +
        `${String(cursorPaused.toolCallsBeforePause)} -> ${String(cursorNumTurns)}). A refusal with no call behind it ` +
        'means the list was carried over from somewhere else, and it is what `pump.ts` reads to decide a Cursor run ' +
        'was paused rather than finished.',
    )
  }
  // And the pause really went down the cancel path this capability describes, rather than some
  // gate-deny path that would mean `canPauseMidRun` had quietly changed under it. A live fact about
  // the run that just happened, and one that can fail.
  if (cursorPaused.checkpoint.pauseReason !== CURSOR_PAUSE_REASON) {
    await fail(
      `stage 3: the Cursor run's checkpoint records pauseReason ${JSON.stringify(cursorPaused.checkpoint.pauseReason)}, ` +
        `expected ${JSON.stringify(CURSOR_PAUSE_REASON)} -- Cursor declares canPauseMidRun: false, so ending the ` +
        'process IS its pause, and a different reason means it stopped some other way than the one this gate measured',
    )
  }
  const liveObservation =
    callsInPauseWindow === 0
      ? "no tool call landed in this run's pause window, so the refusal itself is proven by Series C's committed " +
        "fixture and by the armed gate's own answer above, not observed live here"
      : `${String(callsInPauseWindow)} tool call(s) were attempted inside this run's pause window (tool calls ` +
        `${String(cursorPaused.toolCallsBeforePause)} -> ${String(cursorNumTurns)}); the checkpoint's own refusal list ` +
        `is ${JSON.stringify(denied)}, which on a Cursor pause is gate-protocol-shaped and cannot carry a ` +
        '`result.rejected` -- see this stage\'s comment'

  console.log(
    `stage 3 PASSED: capabilitiesOf('cursor').gate is "all-tools" and the recording it rests on still carries its ` +
      `refusal; the hooks file this run was armed with registers ${String(armedGatePaths.length)} fail-closed ` +
      `entries across beforeShellExecution and preToolUse, every one of them naming ${expectedGateReal}; that armed ` +
      `script answered deny to a shell command and to a file write with this run's own pause flag present; and ` +
      `${liveObservation}`,
  )

  // ============================================================================================
  // Stage 5: a failed resume costs an attempt (Decision 4).
  //
  // Its own worker and its own task, created only now: both stage-2 workers are `backend`, and a
  // third `backend` worker would make it a coin toss which one took this task. A distinct role is
  // the only way to say WHICH run this stage is about.
  //
  // The resume is made to fail the way a resume really fails: the checkpoint is pointed at a
  // session that no longer exists AND at a worktree that no longer exists. The second is what
  // makes it deterministic -- `spawnChild` rejects on a `cwd` that is not there, which is the
  // "stale worktree" case its own comment names -- and the first is the same fact in the vendor's
  // vocabulary. Nothing else is touched: `requestResume` is the real verb, the daemon's own resume
  // pass is what claims it, and `concludeFailedResume` is what has to count the attempt.
  // ============================================================================================
  const attemptAgent = await prisma.agent.create({
    data: { teamId: team.id, name: ATTEMPT_WORKER, role: 'stage5', model: CLAUDE_MODEL, provider: 'claude_code' },
  })
  const attemptTask = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: `${TASK_TITLE} (attempt accounting)`,
      description: TASK_DESCRIPTION,
      status: 'ready',
      requiredRole: 'stage5',
      // ONE attempt, which is the whole point: the failed resume must exhaust it and park the task
      // `failed` -- Decision 4's rule, `failToStart`'s rule, and NOT `blocked`.
      maxAttempts: 1,
    },
  })
  const attemptRunRow = await waitUntil(
    `${ATTEMPT_WORKER} to be dispatched and working with at least one tool call recorded`,
    WORKING_TIMEOUT_MS,
    async () => {
      const row = await prisma.agentRun.findFirst({
        where: { agentId: attemptAgent.id },
        orderBy: { startedAt: 'asc' },
      })
      if (row === null) return { done: false, detail: 'no run row yet' }
      if (row.status === 'working' && row.toolCalls >= 1) return { done: true, value: row }
      if (TERMINAL_STATUSES.has(row.status)) {
        await fail(`stage 5: ${ATTEMPT_WORKER}'s run reached ${row.status} before it could be paused`)
      }
      return { done: false, detail: `${row.status} toolCalls=${String(row.toolCalls)}` }
    },
  )
  const attemptRunId = attemptRunRow.id
  const attemptPause = await requestPause(attemptRunId, PAUSE_REQUESTER, 'human')
  if (!attemptPause.ok) await fail(`stage 5: requestPause refused: ${refusalText(attemptPause.error)}`)
  const attemptPaused = await waitUntil(
    `${ATTEMPT_WORKER}'s run to settle on paused with a dead process and a checkpoint`,
    PAUSE_SETTLE_TIMEOUT_MS,
    async () => {
      const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: attemptRunId }, include: { checkpoint: true } })
      if (TERMINAL_STATUSES.has(row.status)) await fail(`stage 5: the run went ${row.status} instead of paused`)
      if (row.status !== 'paused') return { done: false, detail: `status ${row.status}` }
      if (row.checkpoint === null) return { done: false, detail: 'paused with no checkpoint' }
      if (isAlive(row.pid)) return { done: false, detail: `paused, but pid ${String(row.pid)} is alive` }
      return { done: true, value: row }
    },
  )
  const beforeFailedResume = await prisma.task.findUniqueOrThrow({ where: { id: attemptTask.id } })
  if (beforeFailedResume.attempt !== 0) {
    await fail(`stage 5: the task already carries attempt=${String(beforeFailedResume.attempt)} before the failing resume`)
  }
  if (beforeFailedResume.activeRunId !== attemptRunId) {
    await fail(
      `stage 5: the task's activeRunId is ${String(beforeFailedResume.activeRunId)}, not the paused run ${attemptRunId} -- ` +
        'the increment is conditioned on still owning the task, so this stage would measure nothing',
    )
  }
  const deadSessionId = randomUUID()
  const deadWorktree = join(tmpdir(), `aiteamos-gate-m13-dead-worktree-${deadSessionId}`)
  await prisma.checkpoint.update({
    where: { runId: attemptRunId },
    data: { sessionId: deadSessionId, worktreePath: deadWorktree },
  })
  console.log(`stage 5: pointed run ${attemptRunId}'s checkpoint at dead session ${deadSessionId} in ${deadWorktree}`)

  const attemptResume = await requestResume(attemptRunId, null, PAUSE_REQUESTER)
  if (!attemptResume.ok) {
    await fail(`stage 5: requestResume refused the paused run: ${refusalText(attemptResume.error)}`)
  }
  // The wait is for the RELEASE to be complete, not merely begun, and execution 2 is why:
  // `releaseTaskAfterFailure` increments the attempt in one write and parks the status in a second,
  // so a wait satisfied by the increment alone returns while the task still reads `running`. Both
  // writes plus the run's own terminal row are what "counted against the task" means.
  const failedResumeTask = await waitUntil(
    'the failed resume to be concluded and counted against the task',
    RESUME_TERMINAL_TIMEOUT_MS,
    async () => {
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: attemptRunId } })
      const task = await prisma.task.findUniqueOrThrow({ where: { id: attemptTask.id } })
      if (run.status !== 'failed') return { done: false, detail: `run ${run.status}, task ${task.status}` }
      if (task.attempt === beforeFailedResume.attempt) {
        return { done: false, detail: `run failed, task attempt still ${String(task.attempt)}` }
      }
      if (task.activeRunId !== null) {
        return { done: false, detail: `run failed and attempt is ${String(task.attempt)}, but the task still holds activeRunId` }
      }
      if (task.status === 'running') {
        return { done: false, detail: `attempt is ${String(task.attempt)} and activeRunId is clear, but the task still reads running` }
      }
      return { done: true, value: task }
    },
  )
  if (failedResumeTask.attempt !== 1) {
    await fail(
      `stage 5: the task's attempt is ${String(failedResumeTask.attempt)} after one failed resume, expected 1 -- ` +
        'Decision 4 says every failed run start OR resume costs exactly one attempt',
    )
  }
  if (failedResumeTask.status !== 'failed') {
    await fail(
      `stage 5: the task is ${failedResumeTask.status} at maxAttempts=1, expected "failed". Decision 4 is explicit that ` +
        "the exhausted park is `failToStart`'s -- `failed`, not `blocked` and not `rework`",
    )
  }
  if (failedResumeTask.activeRunId !== null) {
    await fail(`stage 5: the exhausted task still holds activeRunId ${String(failedResumeTask.activeRunId)}`)
  }
  // A BOUNDED WAIT, not a snapshot, and rehearsal 1 is why. `concludeFailedResume` writes the run
  // row and releases the task FIRST and appends its two events afterwards, so the wait above --
  // which is satisfied by the row and the attempt count -- returns while the log is still being
  // written. The row is a state; the log is a history, and the history is finished last (the same
  // lesson `gate-m12-providers.mjs` records at its own stage 2).
  await waitUntil('the failed resume to finish announcing itself', LOG_SETTLE_TIMEOUT_MS, async () => {
    const runFailed = await prisma.executionEvent.findMany({
      where: { runId: attemptRunId, type: 'run_failed' },
      orderBy: { seq: 'asc' },
    })
    const reasons = runFailed.map((event) => (event.payload === null ? null : event.payload.reason))
    if (!reasons.some((reason) => typeof reason === 'string' && reason.startsWith('resume failed to spawn:'))) {
      return { done: false, detail: `run.failed reasons so far: ${JSON.stringify(reasons)}` }
    }
    const taskFailed = await prisma.executionEvent.count({ where: { taskId: attemptTask.id, type: 'task_failed' } })
    if (taskFailed === 0) {
      return {
        done: false,
        detail: 'run.failed named the failed resume, but the task has not announced task.failed yet',
      }
    }
    return { done: true, value: true }
  })

  // ...and the next tick starts no run. Watched for six daemon periods, because "nothing happened"
  // is only a fact if something had time to happen.
  const runsAfterFailure = await prisma.agentRun.count({ where: { agent: { team: { workspaceId: workspace.id } } } })
  const quietDeadline = Date.now() + QUIET_WINDOW_MS
  while (Date.now() < quietDeadline) {
    if (daemonExited) await fail('stage 5: the daemon exited while the gate was watching it do nothing')
    const now = await prisma.agentRun.count({ where: { agent: { team: { workspaceId: workspace.id } } } })
    if (now !== runsAfterFailure) {
      await fail(
        `stage 5: the daemon started a new run after the task was exhausted (${String(runsAfterFailure)} -> ${String(now)} ` +
          'rows). A task parked `failed` at its cap must never be dispatched again -- that is the loop Decision 4 closes.',
      )
    }
    await delay(250)
  }
  const stillFailed = await prisma.task.findUniqueOrThrow({ where: { id: attemptTask.id } })
  if (stillFailed.status !== 'failed' || stillFailed.attempt !== 1) {
    await fail(
      `stage 5: after ${String(QUIET_WINDOW_MS)}ms the task reads ${stillFailed.status} attempt=${String(stillFailed.attempt)}, ` +
        'expected failed attempt=1',
    )
  }
  console.log(
    `stage 5 PASSED: a resume pointed at a dead session cost exactly one attempt, parked the task "failed" at ` +
      `maxAttempts=1, announced run.failed and task.failed, and no tick started another run in ${String(QUIET_WINDOW_MS)}ms`,
  )

  console.log(`PASS: ${PASS_LINE}`)
  exitCode = 0
} finally {
  // WHATEVER CAN STILL SPAWN A PAID CHILD DIES FIRST, and the order is the whole point (review
  // round 1, Important 1). The daemon dispatches on a 500ms period and the one-shot tick owns a
  // pump; either can start a `claude` or a `cursor-agent` at any moment. Sweeping vendor pids while
  // they are still running -- which is what the brief's `finally` snippet did, and what this script
  // inherited -- leaves a window in which a child spawned after the sweep survives the gate and has
  // its row (the only record of its pid) deleted underneath it. So: stop the spawners, THEN sweep,
  // THEN delete the rows.
  if (daemon !== null && daemon.exitCode === null) {
    daemon.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (daemon.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (daemon.exitCode === null) daemon.kill('SIGKILL')
  }
  if (budgetedTick !== null && budgetedTick.exitCode === null) {
    budgetedTick.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (budgetedTick.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (budgetedTick.exitCode === null) budgetedTick.kill('SIGKILL')
  }

  // Then the vendor children, by pid off the rows, BEFORE the rows are deleted (Decision 12). A
  // gate that exits leaving a `claude` or `cursor-agent` alive is a gate that keeps spending after
  // it has reported.
  for (const workspaceId of [unbudgetedWorkspaceId, budgetedWorkspaceId]) {
    if (workspaceId === null) continue
    const runs = await prisma.agentRun
      .findMany({ where: { agent: { team: { workspaceId } } }, select: { id: true, pid: true } })
      .catch(() => [])
    for (const run of runs) {
      if (run.pid === null || !isAlive(run.pid)) continue
      console.log(`cleanup: killing vendor child ${String(run.pid)} for run ${run.id}`)
      try {
        process.kill(run.pid, 'SIGKILL')
      } catch {
        // Already gone between the check and the signal -- the outcome we wanted anyway.
      }
    }
  }
  // ...and then whatever those children spawned, which no row records. See `sweepStrayChildren`.
  sweepStrayChildren([unbudgetedRepo, budgetedRepo])
  // The `/bin/sleep` processes the second-lock probe borrows pids from, if a failure unwound a
  // probe before its own `finally` could reach it.
  for (const pid of liveSleeperPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }

  // Only now the things that cannot spawn a vendor child: the browser and the web shell.
  if (browser !== null) await browser.close().catch(() => {})
  if (nextServer !== null && nextServer.exitCode === null) {
    nextServer.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextServer.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextServer.exitCode === null) nextServer.kill('SIGKILL')
  }
  // FK-ordered cleanup, the same order `gate-m12-providers.mjs` uses: `ExecutionEvent` has no FK to
  // `Workspace` (M2's append-only log outlives entity lifecycles by design) so it is deleted
  // explicitly first, then the workspace delete cascades Team/Agent/Task/AgentRun/Checkpoint/
  // ProviderConfiguration.
  for (const workspaceId of [unbudgetedWorkspaceId, budgetedWorkspaceId]) {
    if (workspaceId !== null) {
      await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    }
  }
  for (const workspaceId of [unbudgetedWorkspaceId, budgetedWorkspaceId]) {
    if (workspaceId !== null) {
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
    }
  }
  // The repositories carry the run worktrees, the `.aiteamos` run directories and the git exclude
  // file the Cursor adapter appended to -- all of it inside these two trees, so nothing this gate
  // wrote outlives them.
  if (unbudgetedRepo !== null) rmSync(unbudgetedRepo, { recursive: true, force: true })
  if (budgetedRepo !== null) rmSync(budgetedRepo, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
