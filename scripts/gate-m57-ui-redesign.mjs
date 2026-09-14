// M57's own gate (spec §5): "the frame is a tree, a header and a slot -- and nothing was removed".
//
// `gate-m44-ux-foundation.mjs`'s shape, which is `gate-m16-chrome.mjs`'s: a free port, a real
// `next dev`, a real Chromium through `playwright-core` at CHROMIUM_PATH, no daemon.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m57-ui-redesign
//
// THIS GATE SPENDS NOTHING AND CANNOT. It dispatches no run, so no CLI is ever invoked -- and the
// preflight still REFUSES to start unless SLAVEOFAI_CLAUDE_BIN points at an executable under
// `scripts/gate-fakes/` and SLAVEOFAI_REQUIRE_FAKE_CLI=1, so a later stage that grows a run cannot
// quietly reach a real account (Decision 10, M32 item 7).
//
// IT WRITES FIXTURE ROWS AND DELETES THEM IN `finally`, in FK order (the m44 idiom): two
// workspaces, so the tree has rows to ORDER and a project that is not open to leave un-nested; one
// task in each of the five columns' statuses, so the board is measured against tasks rather than
// against an empty page; a pending `SupervisorDecision`, so the sidebar count, the dock badge and
// the Needs-you card all have the same real number to agree about; and two `workspace.goal_set`
// events carrying the operator's own typed words, one of them backdated a day, so the Supervisor's
// "a thread is a local calendar day" is proved by two days rather than asserted. `git status` after
// a green run has to be empty.
//
// The ten stages:
//   1. THEME. A first visit stamps no `data-theme` and writes no `localStorage.theme` -- absent IS
//      system (R2). The pill cycles, the two palettes paint different bodies, and the choice
//      survives a reload.
//   2. THE TREE, read back against a Prisma query rather than against itself (R5): the same
//      projects in the same order, a real needs-you count, and six section rows under the OPEN
//      project only.
//   3. THE BREADCRUMB, on all twelve routes the tree can reach (R7). Polled on its TEXT, never on
//      the element: the element resolves on the server frame, before the project's name has
//      arrived (spec erratum E12).
//   4. THE RIGHT PANEL and its three modes (R8): Supervisor by default inside a project, a task in
//      the same slot when one is selected, a dock badge equal to the pending decisions in the
//      database, and NOTHING AT ALL on a global route.
//   5. AN ANSWER, end to end: Approve on the Needs-you row empties the row and the row's decision
//      out of the database together, through the route that already existed.
//   6. FIVE COLUMNS (R10), card by card against the status->column table, then against a grouped
//      read of the same tasks, then against the List view's own row count.
//   7. THE SUPERVISOR'S THREADS (R9): two goal requests on two days are two conversations, and the
//      older one's operator message reads back the words that were typed.
//   8. ELEVEN NUMBERS out of the M57 handoff README, read off a real browser's `getComputedStyle`.
//   9. NO RAW ENUM TOKEN is visible text on any of those twelve routes -- `gate-m44`'s stage 4,
//      with its blocklist DERIVED from the shipped enums rather than typed here.
//  10. NOTHING WAS REMOVED, ONLY MOVED (`docs/ia.md` rule 2, and R11's whole argument):
//      twenty-one destinations, every one of them answering 200 with the sidebar on it.
//
// THE GATE ASSERTS, IT NEVER FIXES. Every stage prints every measured value before asserting it.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: like `gate-m14-fidelity.mjs`,
// `gate-m16-chrome.mjs` and `gate-m44-ux-foundation.mjs`, it boots `next dev` against the repo's
// own `apps/web/.next` on a freshly-chosen free port, and a second `next dev` sharing that
// directory corrupts the on-disk build cache for both. Stop any running dev server first
// (`pgrep -af "next dev"`).

import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { chromium } from 'playwright-core'
import { prisma } from '../packages/db/dist/client.js'
import { CAPABILITY_SEED } from '../packages/db/dist/capabilities.js'
import { EVENT_TYPE_BY_DOMAIN_TYPE, RUN_STATUSES, TASK_STATUSES } from '../packages/db/dist/enums.js'
import {
  BREAKER_LEVELS,
  BREAKER_TRIP_KINDS,
  DECISION_STATUSES,
  GUARDRAIL_KINDS,
  MEMORY_SCOPES,
  MEMORY_SOURCE_KINDS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  SITUATION_KINDS,
  SLAVE_LIFECYCLES,
  TIERS,
} from '../packages/domain/dist/index.js'
import { PROVIDER_KINDS } from '../packages/providers/dist/index.js'

const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 250

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const PASS_LINE = 'the frame is a tree, a header and a slot -- and nothing was removed'

// Suffixed per run (the `gate-m10-org.mjs` idiom `gate-m44` also uses): `Workspace.name` IS unique,
// and a distinct name per run keeps two overlapping executions from colliding on it.
// `preflightCleanup` removes leftovers by PREFIX.
const STAMP = new Date().toISOString().slice(11, 19)
const WORKSPACE_PREFIX = 'M57 Gate Project'
// `A` before `B`: the tree orders by name, and stage 2 compares that order against Prisma's own
// `orderBy: { name: 'asc' }`. Two rows are the minimum that can disagree.
const WORKSPACE_NAME = `${WORKSPACE_PREFIX} A ${STAMP}`
const OTHER_WORKSPACE_NAME = `${WORKSPACE_PREFIX} B ${STAMP}`
const TEAM_NAME = 'M57 Gate Department'
const SLAVE_NAME = 'M57 Gate Worker'

/** The operator's own words, on the `request` member M45 R3 put on `workspace.goal_set`'s payload.
 *  Stage 7 reads the older one back off the older thread's operator bubble -- which is the whole
 *  claim R9 makes: the conversation is those rows, not a table this milestone refused to add. */
const SEEDED_REQUEST_YESTERDAY = 'Please add a printable invoice to the billing page'
const SEEDED_REQUEST_TODAY = 'Also let the invoice be emailed from the same screen'

/**
 * The forbidden tokens, DERIVED from the shipped packages' own unions rather than typed here --
 * `gate-m44-ux-foundation.mjs`'s stage-4 blocklist, copied with its reasoning because stage 9 makes
 * exactly the same claim about the twelve routes M57 re-homed.
 *
 * Every member that carries an underscore or a dot, which is every member a person could not have
 * written by accident. A bare English word that happens to be an enum member (`working`, `paused`,
 * `ready`, `done`, `failed`, `blocked`, `merging`, `idle`, `model`, `rules`) is the product's own
 * vocabulary and is NOT forbidden -- forbidding it would forbid the very labels R4 projects.
 *
 * The unions whose members are all bare words today are enumerated anyway, for the reason M49's
 * erratum E10 states: the FILTER decides, not the list, so the first member a later milestone
 * spells with an underscore joins the blocklist here with no edit at all.
 */
const MEMORY_UNIONS = [...MEMORY_TYPES, ...MEMORY_SCOPES, ...MEMORY_STATUSES, ...MEMORY_SOURCE_KINDS]

const RAW_TOKENS = [
  ...TASK_STATUSES,
  ...RUN_STATUSES,
  ...SITUATION_KINDS,
  ...DECISION_STATUSES,
  ...TIERS,
  ...PROVIDER_KINDS,
  ...CAPABILITY_SEED.map((record) => record.key),
  ...Object.values(EVENT_TYPE_BY_DOMAIN_TYPE),
  ...Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE),
  ...MEMORY_UNIONS,
  ...SLAVE_LIFECYCLES,
  ...GUARDRAIL_KINDS,
  ...BREAKER_LEVELS,
  ...BREAKER_TRIP_KINDS,
].filter((token) => token.includes('_') || token.includes('.'))

/**
 * THERE IS NO TOKEN EXEMPTION LIST, for the reason `gate-m44` gives: an exemption list on a gate
 * like this one only ever grows. The one thing stage 9 does not read is text a person cannot read
 * either -- a node inside a CLOSED `<details>`, or one with no rendered box at all. Both are
 * COUNTED and printed per route, never silently dropped.
 */

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Asks the OS for a free TCP port. `next dev -p <port>` still auto-increments if something grabs
 *  it between this call and the spawn, so the ready-wait parses the ACTUAL bound port back out of
 *  next dev's own ready line rather than trusting this one blindly.
 *  (`scripts/gate-m16-chrome.mjs`, verbatim.) */
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

/** Removes anything a prior interrupted run left behind, by NAME PREFIX, in the same FK order the
 *  `finally` block below uses. Safe against an empty database. */
async function preflightCleanup() {
  const stale = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true },
  })
  for (const workspace of stale) {
    console.log(`preflight: removing leftover workspace ${workspace.id} (${workspace.name})`)
    // `ExecutionEvent` has no FK to `Workspace` (M2's append-only log outlives entity lifecycles by
    // design), so it goes explicitly first; the workspace delete cascades the rest.
    await prisma.executionEvent.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {})
  }
}

/** `YYYY-MM-DD` in the process's own zone -- the same `localDay` `server/supervisorThreads.ts`
 *  groups by, so the day the fixture is backdated to is the thread id the panel will draw. */
function localDay(at) {
  const year = at.getFullYear()
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${String(year)}-${month}-${day}`
}

let exitCode = 1
let nextServer = null
let browser = null
let page = null
let diagDir = null
let workspaceId = null
let otherWorkspaceId = null
let teamId = null
let slaveId = null
let decisionId = null
/** The browser console, newest last, for `fail()`'s dump. */
const browserConsole = []

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m57-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ============================================================================================
  // Stage 0: preflight, and the fixture rows the ten stages need.
  // ============================================================================================

  // Zero spend, ENFORCED (Decision 10, M32 item 7). This gate dispatches nothing today; the
  // refusal is here so that a later stage which grows a run cannot quietly reach a real account.
  const fakeClaude = process.env['SLAVEOFAI_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'SLAVEOFAI_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m57-ui-redesign',
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
      `no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m57-ui-redesign passes ` +
        '--env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m57-ui-redesign`')
  }
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- every stage of this gate reads a real rendered page, so set ` +
        'CHROMIUM_PATH to a real executable (e.g. a playwright-installed chromium under ' +
        '~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome).',
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
  console.log(`fake claude: ${fakeClaude}`)
  console.log(`chromium:    ${chromiumPath}`)
  console.log(
    `raw-token blocklist: ${String(RAW_TOKENS.length)} member(s) DERIVED from the dist enums ` +
      `(every union member containing "_" or "."), e.g. ${JSON.stringify(RAW_TOKENS.slice(0, 6))}`,
  )
  assert(
    !RAW_TOKENS.includes('working') && !RAW_TOKENS.includes('paused') && !RAW_TOKENS.includes('model'),
    'the derived blocklist swallowed a bare English word -- the product vocabulary is not forbidden',
  )
  assert(RAW_TOKENS.includes('pause_requested'), 'the derived blocklist lost the RunStatus members')
  assert(RAW_TOKENS.includes('no_reviewer'), 'the derived blocklist lost the SituationKind members')
  assert(RAW_TOKENS.includes('backend.api-design'), 'the derived blocklist lost the capability keys')
  assert(RAW_TOKENS.includes('run.tool_call') && RAW_TOKENS.includes('run_tool_call'), 'the derived blocklist lost the event types')
  assert(RAW_TOKENS.includes('behavioural_loop'), 'the derived blocklist lost the GuardrailKind members')
  assert(RAW_TOKENS.includes('repeated_call'), 'the derived blocklist lost the BreakerTripKind members')
  assert(MEMORY_UNIONS.includes('run_output'), 'the memory unions lost MEMORY_SOURCE_KINDS')
  assert(
    RAW_TOKENS.filter((token) => token === 'run_output').length >= 2,
    'the derived blocklist lost the memory unions -- `run_output` must reach it twice, once from the event types and once from MEMORY_SOURCE_KINDS',
  )

  await preflightCleanup()

  // ---- The fixture. Each row exists to make one stage mean something. --------------------------
  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath: repoRoot,
      verifyCommands: [],
      setupCommands: [],
      goal: 'Prove the frame reads.',
      goalVersion: 2,
    },
  })
  workspaceId = workspace.id
  // The SECOND project exists for one assertion each in stage 2: that the tree lists both in the
  // database's own order, and that a project which is not open does not nest its six sections.
  const other = await prisma.workspace.create({
    data: { name: OTHER_WORKSPACE_NAME, repoPath: repoRoot, verifyCommands: [], setupCommands: [] },
  })
  otherWorkspaceId = other.id
  const team = await prisma.team.create({ data: { workspaceId, name: TEAM_NAME } })
  teamId = team.id
  const slave = await prisma.slave.create({
    data: { teamId, name: SLAVE_NAME, role: 'engineer', runtimeRoles: ['engineer'], model: 'sonnet', provider: 'claude_code' },
  })
  slaveId = slave.id

  // ONE TASK PER COLUMN, named by the column it belongs in so a failure in stage 6 reads itself.
  // `done` is INTEGRATED: an unintegrated `done` on a project that does not merge by itself is a
  // needs-you item of its own, and stage 5 wants a queue whose only answerable row is the decision.
  const COLUMN_FIXTURE = [
    ['ready', 'Queued'],
    ['running', 'In progress'],
    ['reviewing', 'Review'],
    ['blocked', 'Blocked'],
    ['done', 'Done'],
  ]
  for (const [status, column] of COLUMN_FIXTURE) {
    await prisma.task.create({
      data: {
        workspaceId,
        title: `M57 gate task for ${column}`,
        description: 'One task per column, so the board is measured against tasks.',
        status,
        maxAttempts: 3,
        goalVersion: 2,
        ...(status === 'blocked' ? { lastRejectionReason: 'the gate parked it here' } : {}),
        ...(status === 'done' ? { integratedAt: new Date() } : {}),
      },
    })
  }

  // The one pending proposal. Same situation and same action `gate-m44` seeds -- `set_runtime_roles`
  // over a worker that really exists, so stage 5's Approve applies a verb the world accepts rather
  // than one that fails and leaves the row `failed` instead of gone from the pending list.
  const decision = await prisma.supervisorDecision.create({
    data: {
      workspaceId,
      situationKind: 'no_reviewer',
      subjectId: 'reviewer',
      situation: {
        kind: 'no_reviewer',
        subjectId: 'reviewer',
        summary: 'Nobody on this project may review, so finished work has nobody to check it.',
        facts: { role: 'reviewer', reviewers: 0 },
      },
      candidates: [
        { action: { kind: 'set_runtime_roles', slaveId, roles: ['reviewer'] }, tier: 'proposed', why: 'one worker already here can take the role' },
      ],
      chosenIndex: 0,
      action: { kind: 'set_runtime_roles', slaveId, roles: ['reviewer'] },
      rationale: 'The project has ready work and no reviewer; the smallest fix is to widen one worker.',
      tier: 'proposed',
      status: 'pending',
      decidedBy: 'model',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  })
  decisionId = decision.id

  // TWO DAYS OF CONVERSATION, from two rows that already have somewhere to live. Yesterday's is
  // stamped at local NOON rather than `now - 24h`: a clock that crossed a DST boundary makes the
  // subtraction land back on today, and the one thing this fixture has to guarantee is two
  // DIFFERENT local days. Written oldest first, so `seq` ascends with `ts`.
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  yesterday.setHours(12, 0, 0, 0)
  const YESTERDAY_DAY = localDay(yesterday)
  const GOAL_SET = EVENT_TYPE_BY_DOMAIN_TYPE['workspace.goal_set']
  await prisma.executionEvent.create({
    data: { type: GOAL_SET, ts: yesterday, workspaceId, actor: 'human', payload: { version: 1, request: SEEDED_REQUEST_YESTERDAY } },
  })
  await prisma.executionEvent.create({
    data: { type: GOAL_SET, workspaceId, actor: 'human', payload: { version: 2, request: SEEDED_REQUEST_TODAY } },
  })

  console.log('stage 0 PASSED: the fixture rows the ten stages need')
  console.log(`  workspace ${workspaceId} (${WORKSPACE_NAME}) · second workspace ${otherWorkspaceId} (${OTHER_WORKSPACE_NAME})`)
  console.log(`  team ${teamId} · slave ${slaveId} (${SLAVE_NAME})`)
  console.log(`  tasks: ${JSON.stringify(COLUMN_FIXTURE)}`)
  console.log(`  SupervisorDecision ${decisionId} no_reviewer/proposed/pending/model`)
  console.log(`  two workspace.goal_set events, one dated ${YESTERDAY_DAY} and one today`)

  // ---- The real web shell, on a free port, loopback-bound. -------------------------------------
  const preferredPort = await findFreePort()
  nextServer = spawn(
    'node',
    ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort), '-H', '127.0.0.1'],
    // M21 A1: the operator's SLAVEOFAI_SESSION_SECRET must not reach the child, or every page is /login.
    { cwd: repoRoot, env: loopbackChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let nextOutput = ''
  let nextExited = false
  let resolvedPort = null
  nextServer.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    nextOutput += text
    process.stdout.write(`[next] ${text}`)
    // `-H 127.0.0.1` changes next's own ready line from `http://localhost:<port>` to
    // `http://127.0.0.1:<port>` -- matching both keeps this resilient to either spelling.
    const match = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(nextOutput)
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
  const baseUrl = `http://127.0.0.1:${String(resolvedPort)}`
  console.log(`next dev ready at ${baseUrl}, loopback-bound`)

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
    browserConsole.push(`[pageerror] ${String(error).slice(0, 300)}`)
  })
  page.on('console', (message) => browserConsole.push(`[${message.type()}] ${message.text().slice(0, 300)}`))
  page.on('requestfailed', (request) => browserConsole.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`))

  /** The m8a-estop-style diagnostic throw (`gate-m44-ux-foundation.mjs`'s `fail`): the state that
   *  made the call, not just "it timed out". */
  async function fail(message) {
    let screenshotPath = null
    if (page !== null && diagDir !== null) {
      screenshotPath = join(diagDir, `failure-${String(Date.now())}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
    }
    const pageUrl = page === null ? '<no page>' : page.url()
    throw new Error(
      `${message}\n--- browser url ---\n${pageUrl}\n--- screenshot ---\n${screenshotPath ?? '<none>'}\n` +
        `--- browser console (tail) ---\n${browserConsole.slice(-40).join('\n')}`,
    )
  }

  /** Bounded-waits for `locator` to become visible; a timeout routes through `fail` for the full
   *  diagnostic dump instead of a bare Playwright TimeoutError. */
  async function waitVisible(locator, description) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
    } catch {
      await fail(`timed out waiting for ${description} to become visible`)
    }
  }

  /** Polls `probe` until it reports `{done:true}`, then answers its `value`; a timeout routes
   *  through `fail` naming the LAST thing the probe saw (`gate-m14-fidelity.mjs`'s helper, minus
   *  the daemon it watches and this gate does not start). */
  async function waitUntil(description, timeoutMs, probe) {
    const deadline = Date.now() + timeoutMs
    let lastDetail = '<never probed>'
    for (;;) {
      const result = await probe()
      if (result.done) return result.value
      lastDetail = result.detail
      if (Date.now() > deadline) {
        await fail(`timed out after ${String(timeoutMs)}ms waiting for ${description} -- last seen: ${lastDetail}`)
      }
      await delay(POLL_INTERVAL_MS)
    }
  }

  /** `page.goto`, with a 5xx routed through `fail()`'s dump rather than a bare Playwright error. */
  async function gotoReliably(url) {
    let response = null
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
    } catch (cause) {
      await fail(`goto ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (response !== null && response.status() >= 500) {
      await fail(`goto ${url} returned ${String(response.status())}`)
    }
    return response
  }

  /** Clicks `locator`, then bounded-waits for `predicate`. */
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

  // ============================================================================================
  // The status -> column table, RE-DECLARED (scan finding 7).
  //
  // This gate cannot import `lib/taskColumns.ts`: `apps/web` compiles with `noEmit: true` under a
  // bundler resolver, so there is no built output for a plain `node` script to load. That is the
  // constraint `apps/web/test/integration/gate-surface-parity.test.ts:18-21` was written to
  // document, and this is the same answer M41 gave -- the gate states the fact it asserts, in its
  // own words, and a vitest case PINS the two together so the copy cannot drift (Step 2b).
  // ============================================================================================
  const GATE_COLUMN_FOR_STATUS = {
    backlog: 'Queued',
    ready: 'Queued',
    rework: 'Queued',
    assigned: 'Queued',
    running: 'In progress',
    verifying: 'In progress',
    waiting: 'In progress',
    reviewing: 'Review',
    merging: 'Review',
    blocked: 'Blocked',
    done: 'Done',
    failed: 'Done',
    cancelled: 'Done',
  }

  // ============================================================================================
  // Stage 1: the theme, which is the one thing a person notices on every single page load.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/`)
  await waitVisible(page.getByTestId('theme-toggle'), 'the sidebar footer theme pill')
  const first = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    stored: (() => { try { return localStorage.getItem('theme') } catch { return 'THREW' } })(),
    background: window.getComputedStyle(document.body).backgroundColor,
  }))
  console.log(`stage 1: first visit = ${JSON.stringify(first)}`)
  if (first.attr !== null) await fail(`stage 1: a first visit stamped data-theme=${JSON.stringify(first.attr)}; absent IS system (R2)`)
  if (first.stored !== null) await fail(`stage 1: a first visit wrote localStorage.theme=${JSON.stringify(first.stored)}; it must write nothing until somebody chooses`)

  await clickUntil(page.getByTestId('theme-toggle'), async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light', 'the theme pill (to Light)')
  const light = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor)
  await clickUntil(page.getByTestId('theme-toggle'), async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark', 'the theme pill (to Dark)')
  const dark = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor)
  console.log(`stage 1: light body background = ${light}, dark = ${dark}`)
  if (light === dark) await fail(`stage 1: light and dark paint the same body background (${light}) -- the palette is not switching`)

  await gotoReliably(`${baseUrl}/`)
  const afterReload = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    stored: (() => { try { return localStorage.getItem('theme') } catch { return 'THREW' } })(),
  }))
  console.log(`stage 1: after a reload = ${JSON.stringify(afterReload)}`)
  if (afterReload.attr !== 'dark' || afterReload.stored !== 'dark') {
    await fail(`stage 1: the choice did not survive a reload (${JSON.stringify(afterReload)})`)
  }
  // Back to system, so the remaining stages measure the default the screenshots are taken in.
  await clickUntil(page.getByTestId('theme-toggle'), async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === null, 'the theme pill (back to System)')
  console.log('stage 1 PASSED: absent is system, the pill cycles, the palette moves, and the choice survives a reload')

  // ============================================================================================
  // Stage 2: the sidebar tree, against the database rather than against itself.
  // ============================================================================================
  const dbProjects = await prisma.workspace.findMany({ where: { archivedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  const treeRows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="sidebar-project"]')].map((row) => ({
      id: row.getAttribute('data-project-id'),
      status: row.getAttribute('data-status'),
      needs: row.querySelector('[data-testid="sidebar-needs-you"]')?.textContent?.trim() ?? null,
    })),
  )
  console.log(`stage 2: tree rows = ${JSON.stringify(treeRows)}`)
  if (JSON.stringify(treeRows.map((row) => row.id)) !== JSON.stringify(dbProjects.map((row) => row.id))) {
    await fail(`stage 2: the tree lists ${JSON.stringify(treeRows.map((r) => r.id))}, the database has ${JSON.stringify(dbProjects.map((r) => r.id))}`)
  }
  const seeded = treeRows.find((row) => row.id === workspaceId)
  if (seeded === undefined || seeded.needs === null || !/^\d+$/.test(seeded.needs) || Number(seeded.needs) < 1) {
    await fail(`stage 2: the seeded project has a pending decision and a blocked task, and its needs-you count reads ${JSON.stringify(seeded?.needs)}`)
  }
  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await waitVisible(page.getByTestId('sidebar-section'), "the open project's section rows")
  const sections = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="sidebar-section"]')].map((row) => ({
      id: row.getAttribute('data-section'),
      href: row.getAttribute('href'),
    })),
  )
  console.log(`stage 2: section rows = ${JSON.stringify(sections)}`)
  if (JSON.stringify(sections.map((row) => row.id)) !== JSON.stringify(['overview', 'tasks', 'organization', 'knowledge', 'activity', 'settings'])) {
    await fail(`stage 2: the open project's sections are ${JSON.stringify(sections.map((row) => row.id))}`)
  }
  // ONLY THE OPEN PROJECT NESTS. Asserted by the section rows' own hrefs and by their COUNT, not by
  // a descendant selector under `[data-project-id]`: the section rows are SIBLINGS of the project
  // row (the anchor cannot contain them), so a `[data-project-id="x"] [data-testid="sidebar-section"]`
  // query answers null for the open project too and could never fail.
  const foreign = sections.filter((row) => !(row.href ?? '').startsWith(`/w/${workspaceId}`))
  if (foreign.length > 0 || sections.length !== 6) {
    await fail(
      `stage 2: the tree drew ${String(sections.length)} section row(s), ${String(foreign.length)} of them pointing outside ` +
        `the open project (${JSON.stringify(foreign)}) -- only the current project nests`,
    )
  }
  console.log('stage 2 PASSED: the tree is the database, the count is real, and only the open project nests')

  // ============================================================================================
  // Stage 3: the breadcrumb, on every route the tree can reach.
  //
  // POLLED ON ITS TEXT (spec erratum E12): the element resolves on the server's own frame, where
  // the project's name has not arrived yet and the crumb reads the workspace id. Waiting for the
  // element and reading it once would be a race this gate loses on a cold `next dev` compile.
  // ============================================================================================
  const workspaceName = WORKSPACE_NAME // the crumb the header prints, read from the tree by id
  const CRUMBS = [
    ['/', 'Projects'],
    ['/workforce', 'Workforce'],
    ['/settings', 'Settings'],
    ['/sim', 'Simulations'],
    [`/w/${workspaceId}`, `Projects/${workspaceName}`],
    [`/w/${workspaceId}/tasks`, `Projects/${workspaceName}/Tasks`],
    [`/w/${workspaceId}/organization`, `Projects/${workspaceName}/Team`],
    [`/w/${workspaceId}/knowledge`, `Projects/${workspaceName}/Knowledge`],
    [`/w/${workspaceId}/activity`, `Projects/${workspaceName}/Activity`],
    [`/w/${workspaceId}/settings`, `Projects/${workspaceName}/Settings`],
    [`/w/${workspaceId}/graph`, `Projects/${workspaceName}/Graph`],
    [`/w/${workspaceId}/office`, `Projects/${workspaceName}/Office`],
  ]
  for (const [path, expected] of CRUMBS) {
    await gotoReliably(`${baseUrl}${path}`)
    await waitVisible(page.getByTestId('breadcrumb'), `the breadcrumb on ${path}`)
    const actual = await waitUntil(`the breadcrumb on ${path} to read ${JSON.stringify(expected)}`, ACTION_TIMEOUT_MS, async () => {
      const seen = await page.evaluate(() => document.querySelector('[data-testid="breadcrumb"]')?.getAttribute('data-crumbs') ?? null)
      return seen === expected ? { done: true, value: seen } : { done: false, detail: JSON.stringify(seen) }
    })
    console.log(`stage 3: ${path} -> ${JSON.stringify(actual)}`)
  }
  console.log('stage 3 PASSED: twelve routes, twelve breadcrumbs')

  // ============================================================================================
  // Stage 4: the right panel, its three modes, and the dock.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await waitVisible(page.getByTestId('right-panel'), 'the right panel on the Overview')
  const defaultMode = await page.getByTestId('right-panel').getAttribute('data-mode')
  console.log(`stage 4: the Overview's slot opens in mode ${JSON.stringify(defaultMode)}`)
  if (defaultMode !== 'supervisor') {
    await fail('stage 4: the default content on a project route is not the Supervisor')
  }
  await gotoReliably(`${baseUrl}/w/${workspaceId}/tasks`)
  await waitVisible(page.getByTestId('task-card'), 'a task card on the board')
  await clickUntil(page.getByTestId('task-card').first(), async () => (await page.getByTestId('right-panel').getAttribute('data-mode')) === 'task', 'a task card')
  // POLLED, not read once: `hooks/useSelectedId.ts` sets local state and then calls
  // `router.replace` as a side effect, so the slot's mode flips a beat before the URL does.
  const taskUrl = await waitUntil('?task= to reach the URL', ACTION_TIMEOUT_MS, async () =>
    page.url().includes('task=') ? { done: true, value: page.url() } : { done: false, detail: page.url() },
  )
  console.log(`stage 4: opening a task put the URL at ${taskUrl} -- ?task= is still the source of truth`)
  await clickUntil(page.getByTestId('panel-collapse'), async () => page.getByTestId('right-dock').isVisible(), 'the panel collapse »')
  const badge = await page.evaluate(() => document.querySelector('[data-testid="dock-badge"]')?.textContent?.trim() ?? null)
  const pendingCount = await prisma.supervisorDecision.count({ where: { workspaceId, status: 'pending' } })
  console.log(`stage 4: dock badge = ${JSON.stringify(badge)}, pending decisions in the database = ${pendingCount}`)
  if (Number(badge) !== pendingCount) await fail(`stage 4: the dock badge reads ${JSON.stringify(badge)} and the database has ${pendingCount} pending`)
  await gotoReliably(`${baseUrl}/workforce`)
  await waitVisible(page.getByRole('navigation', { name: 'Primary' }), 'the sidebar on /workforce')
  const globalRight = await page.evaluate(() => ({
    panel: document.querySelector('[data-testid="right-panel"]') !== null,
    dock: document.querySelector('[data-testid="right-dock"]') !== null,
    shell: document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-right') ?? null,
  }))
  console.log(`stage 4: on /workforce = ${JSON.stringify(globalRight)}`)
  if (globalRight.panel || globalRight.dock || globalRight.shell !== 'none') {
    await fail(`stage 4: a global route grew a third column (${JSON.stringify(globalRight)})`)
  }
  console.log('stage 4 PASSED: supervisor by default, task in the slot, a real badge on the dock, and nothing at all outside a project')

  // ============================================================================================
  // Stage 5: answering a decision, end to end.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await waitVisible(page.getByTestId('needs-you-card'), 'the Needs you card')
  const before = await page.evaluate(() => ({
    rows: document.querySelectorAll('[data-testid="needs-you-row"]').length,
    count: document.querySelector('[data-testid="sidebar-needs-you"]')?.textContent?.trim() ?? null,
  }))
  console.log(`stage 5: before = ${JSON.stringify(before)}`)
  await clickUntil(page.getByTestId('needs-you-approve').first(), async () => (await page.getByTestId('needs-you-row').count()) < before.rows, 'Approve on the needs-you row')
  const resolved = await prisma.supervisorDecision.count({ where: { workspaceId, status: 'pending' } })
  console.log(`stage 5: rows ${before.rows} -> ${await page.getByTestId('needs-you-row').count()}, pending in the database -> ${resolved}`)
  if (resolved !== 0) await fail(`stage 5: Approve left ${resolved} pending decisions in the database`)
  console.log('stage 5 PASSED: approved in place, through the route that already existed')

  // ============================================================================================
  // Stage 6: five columns, against a grouped read of the same tasks.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${workspaceId}/tasks`)
  await waitVisible(page.getByTestId('column'), 'the task board')
  const columns = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="column"]')].map((column) => ({
      name: column.getAttribute('data-column'),
      statuses: [...column.querySelectorAll('[data-testid="task-card"]')].map((card) => card.getAttribute('data-status')),
    })),
  )
  console.log(`stage 6: columns = ${JSON.stringify(columns.map((c) => [c.name, c.statuses.length]))}`)
  const EXPECTED_COLUMNS = ['Queued', 'In progress', 'Review', 'Blocked', 'Done']
  if (JSON.stringify(columns.map((c) => c.name)) !== JSON.stringify(EXPECTED_COLUMNS)) {
    await fail(`stage 6: the board is ${JSON.stringify(columns.map((c) => c.name))}, expected ${JSON.stringify(EXPECTED_COLUMNS)}`)
  }
  for (const column of columns) {
    for (const status of column.statuses) {
      if (GATE_COLUMN_FOR_STATUS[status] !== column.name) {
        await fail(`stage 6: a ${status} task is in ${column.name}, and the table says ${GATE_COLUMN_FOR_STATUS[status]}`)
      }
    }
  }
  const dbCounts = await prisma.task.groupBy({ by: ['status'], where: { workspaceId }, _count: { _all: true } })
  const onScreen = columns.reduce((n, column) => n + column.statuses.length, 0)
  const inDatabase = dbCounts.reduce((n, group) => n + group._count._all, 0)
  if (onScreen !== inDatabase) await fail(`stage 6: the board shows ${onScreen} cards and the database has ${inDatabase} tasks`)
  await clickUntil(page.getByTestId('task-view-list'), async () => page.getByTestId('task-list').isVisible(), 'the List toggle')
  const listRows = await page.getByTestId('task-list-row').count()
  console.log(`stage 6: the List view drew ${listRows} row(s) for ${inDatabase} task(s)`)
  if (listRows !== inDatabase) await fail(`stage 6: the list shows ${listRows} rows and the database has ${inDatabase} tasks`)
  console.log('stage 6 PASSED: five columns, every card where the table says, and a list with the same rows')

  // ============================================================================================
  // Stage 7: the Supervisor's threads, which are days.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await waitVisible(page.getByTestId('supervisor-thread'), 'the Supervisor thread')
  await clickUntil(page.getByTestId('supervisor-history'), async () => (await page.getByTestId('supervisor-thread-row').count()) > 0, 'the ≡ conversations button')
  const threadRows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="supervisor-thread-row"]')].map((row) => row.textContent?.trim() ?? ''))
  console.log(`stage 7: conversations = ${JSON.stringify(threadRows)}`)
  if (threadRows.length !== 2) await fail(`stage 7: two goal requests on two days produced ${threadRows.length} conversations, expected 2`)
  // Waited on the THREAD ID, not on "a message exists": today's thread already has messages, so a
  // predicate that only counted them would be satisfied before React had drawn the older one.
  await clickUntil(
    page.getByTestId('supervisor-thread-row').nth(1),
    async () => (await page.evaluate(() => document.querySelector('[data-testid="supervisor-thread"]')?.getAttribute('data-thread-id') ?? null)) === YESTERDAY_DAY,
    `the older conversation (${YESTERDAY_DAY})`,
  )
  const operatorText = await page.evaluate(() => document.querySelector('[data-testid="supervisor-message"][data-who="operator"]')?.textContent ?? '')
  console.log(`stage 7: the older thread's operator message reads ${JSON.stringify(operatorText)}`)
  if (!operatorText.includes(SEEDED_REQUEST_YESTERDAY)) {
    await fail(`stage 7: the older thread's operator message reads ${JSON.stringify(operatorText)}, expected the words that were typed`)
  }
  console.log("stage 7 PASSED: one thread per day, and an operator message in the operator's own words")

  // ============================================================================================
  // Stage 8: eleven numbers out of the handoff README, read back off the browser.
  // ============================================================================================
  const NUMBERS = [
    [`/w/${workspaceId}`, 'nav[aria-label="Primary"]', 'width', '236px'],
    [`/w/${workspaceId}`, '[data-testid="app-header"]', 'height', '54px'],
    [`/w/${workspaceId}`, '[data-testid="right-panel"]', 'width', '372px'],
    [`/w/${workspaceId}`, '[data-testid="app-shell"]', 'min-width', '1280px'],
    [`/w/${workspaceId}`, 'body', 'font-size', '14px'],
    [`/w/${workspaceId}`, '[data-testid="needs-you-card"]', 'border-radius', '12px'],
    [`/w/${workspaceId}`, '[data-testid="brief-tile"]', 'border-radius', '12px'],
    ['/', '[data-testid="project-card"]', 'border-radius', '14px'],
    [`/w/${workspaceId}/tasks`, '[data-testid="task-card"]', 'border-radius', '10px'],
    [`/w/${workspaceId}/tasks`, '[data-testid="status-pill"]', 'border-radius', '999px'],
  ]
  /** One structural marker per path above: nothing is measured until the page that owns the number
   *  has rendered, because `getComputedStyle` against the server's first paint reads a page React
   *  has not finished with. */
  const NUMBER_MARKER = {
    '/': 'project-card',
    [`/w/${workspaceId}`]: 'needs-you-card',
    [`/w/${workspaceId}/tasks`]: 'column',
  }
  let currentPath = null
  for (const [path, selector, property, expected] of NUMBERS) {
    if (path !== currentPath) {
      await gotoReliably(`${baseUrl}${path}`)
      currentPath = path
      await waitVisible(page.getByTestId(NUMBER_MARKER[path]), `${path} before its numbers are read`)
    }
    const actual = await page.evaluate(([sel, prop]) => {
      const node = document.querySelector(sel)
      return node === null ? null : window.getComputedStyle(node).getPropertyValue(prop)
    }, [selector, property])
    console.log(`stage 8: ${path} ${selector} ${property} = ${JSON.stringify(actual)}`)
    if (actual === null) await fail(`stage 8: nothing matched ${selector} on ${path}`)
    if (actual.trim() !== expected) await fail(`stage 8: ${selector} ${property} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)} (the handoff README's number)`)
  }
  // The dock is measured separately: it only exists once somebody collapses the panel.
  await clickUntil(page.getByTestId('panel-collapse'), async () => page.getByTestId('right-dock').isVisible(), 'the panel collapse »')
  const dockWidth = await page.evaluate(() => window.getComputedStyle(document.querySelector('[data-testid="right-dock"]')).width)
  console.log(`stage 8: dock width = ${JSON.stringify(dockWidth)}`)
  if (dockWidth !== '52px') await fail(`stage 8: the dock is ${JSON.stringify(dockWidth)}, expected "52px"`)
  console.log('stage 8 PASSED: eleven README numbers, read back off a real browser')

  // ============================================================================================
  // Stage 9: no raw enum token is visible text on any of the twelve routes.
  //
  // `gate-m44-ux-foundation.mjs`'s stage 4, pointed at the routes THIS milestone re-homed. Text
  // NODES, never `outerHTML`: `docs/ia.md` rule 3's whole contract is that the raw value stays
  // reachable in a `title` and on a `data-` attribute, and neither of those is a text node.
  //
  // RENDERED text, not merely attached: a node inside a closed `<details>` -- the Activity page's
  // own `Advanced` event-type filter, and every `PayloadDetails` disclosure -- is in the DOM and on
  // nobody's screen. It takes all three tests: a closed `<details>` BY NAME (Chromium hides its
  // contents with `content-visibility`, so those nodes still report client rects), then
  // `getClientRects()`, then `checkVisibility()`. What they exclude is counted per route and
  // printed, never silently dropped.
  // ============================================================================================
  async function readVisibleText() {
    return page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      const shown = []
      const hidden = []
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const parent = node.parentElement
        if (parent === null) continue
        if (parent.closest('nextjs-portal, script, style, [aria-hidden="true"], .sr-only') !== null) continue
        const value = (node.nodeValue ?? '').trim()
        if (value === '') continue
        const owner = parent.closest('[data-testid]')
        const where = owner === null ? parent.tagName.toLowerCase() : `[data-testid="${owner.getAttribute('data-testid') ?? ''}"]`
        const entry = { text: value, where }
        const closed = parent.closest('details:not([open])')
        const summary = closed === null ? null : closed.querySelector(':scope > summary')
        const inSummary = summary !== null && summary.contains(parent)
        const rendered =
          parent.getClientRects().length > 0 && (typeof parent.checkVisibility !== 'function' || parent.checkVisibility())
        if ((closed !== null && !inSummary) || !rendered) hidden.push(entry)
        else shown.push(entry)
      }
      return { shown, hidden }
    })
  }

  /** One structural marker per route, so the scan reads a page that has finished rather than a
   *  shell that has not. Same twelve routes stage 3 walks, in the same order. */
  const SWEEP = [
    { name: 'projects', path: '/', testId: 'project-card' },
    { name: 'workforce', path: '/workforce', testId: 'workforce' },
    { name: 'settings', path: '/settings', testId: 'security-posture' },
    { name: 'simulations', path: '/sim', testId: 'new-simulation' },
    { name: 'overview', path: `/w/${workspaceId}`, testId: 'strip' },
    { name: 'tasks', path: `/w/${workspaceId}/tasks`, testId: 'column' },
    { name: 'organization', path: `/w/${workspaceId}/organization`, testId: 'organization-rows' },
    { name: 'knowledge', path: `/w/${workspaceId}/knowledge`, testId: 'knowledge-counts' },
    { name: 'activity', path: `/w/${workspaceId}/activity`, testId: 'timeline-viewport' },
    { name: 'project-settings', path: `/w/${workspaceId}/settings`, testId: 'perm-caption' },
    { name: 'graph', path: `/w/${workspaceId}/graph`, testId: 'graph-canvas' },
    { name: 'office', path: `/w/${workspaceId}/office`, testId: 'office-canvas' },
  ]
  let hiddenTokenPages = 0
  for (const target of SWEEP) {
    await gotoReliably(`${baseUrl}${target.path}`)
    await waitVisible(page.getByTestId(target.testId), `${target.name}'s structural marker [data-testid=${target.testId}]`)
    await waitVisible(page.getByRole('navigation', { name: 'Primary' }), `${target.name}'s sidebar`)
    if (target.name === 'overview') {
      // Waited BEFORE the scan, so the re-homed river's own strings are covered rather than raced.
      await waitVisible(page.getByTestId('live-events'), 'the live-events river on the Overview')
    }
    const { shown, hidden } = await readVisibleText()
    const offenders = []
    for (const entry of shown) {
      for (const token of RAW_TOKENS) {
        if (entry.text.includes(token)) offenders.push({ token, ...entry })
      }
    }
    if (offenders.length > 0) {
      await fail(
        `stage 9 (${target.name}): a raw enum token is visible text -- ` +
          offenders
            .slice(0, 10)
            .map((o) => `${JSON.stringify(o.token)} inside ${o.where}: ${JSON.stringify(o.text.slice(0, 160))}`)
            .join('; '),
      )
    }
    const hiddenTokens = hidden.filter((entry) => RAW_TOKENS.some((token) => entry.text.includes(token)))
    if (hiddenTokens.length > 0) hiddenTokenPages += 1
    console.log(
      `stage 9 (${target.name}): ${String(shown.length)} rendered string(s), none containing any of the ` +
        `${String(RAW_TOKENS.length)} derived tokens; ${String(hiddenTokens.length)} token(s) present only in ` +
        'un-rendered text (a closed <details>)',
    )
  }
  console.log(
    `stage 9 PASSED: none of the ${String(RAW_TOKENS.length)} derived raw tokens is rendered text on any of ` +
      `${String(SWEEP.length)} re-homed routes, with NO exemption list; ${String(hiddenTokenPages)} route(s) carry a ` +
      'token only inside un-rendered text',
  )

  // ============================================================================================
  // Stage 10: nothing was removed, only moved (docs/ia.md rule 2, and M57 R11's whole argument).
  // ============================================================================================
  const EVERY_ROUTE = [
    '/', '/workforce', '/workforce?tab=slaves', '/workforce?tab=departments', '/workforce?tab=catalog',
    '/workforce?tab=skills', '/workforce?tab=runbooks', '/workforce?tab=evidence',
    '/slaves', '/skills', '/settings', '/sim', `/analytics?workspace=${workspaceId}`,
    `/w/${workspaceId}`, `/w/${workspaceId}/tasks`, `/w/${workspaceId}/organization`,
    `/w/${workspaceId}/knowledge`, `/w/${workspaceId}/activity`, `/w/${workspaceId}/settings`,
    `/w/${workspaceId}/graph`, `/w/${workspaceId}/office`,
  ]
  for (const route of EVERY_ROUTE) {
    const response = await page.goto(`${baseUrl}${route}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
    const status = response === null ? null : response.status()
    console.log(`stage 10: ${route} -> ${String(status)}`)
    // 200 or a 307 that landed on a 200 (the two redirects `next.config.ts` owns).
    if (status !== 200) await fail(`stage 10: ${route} answered ${String(status)} -- ia.md rule 2 says every destination still answers`)
    await waitVisible(page.getByRole('navigation', { name: 'Primary' }), `the sidebar on ${route}`)
  }
  console.log(`stage 10 PASSED: ${EVERY_ROUTE.length} destinations, all of them still there`)

  console.log(`PASS: ${PASS_LINE}`)
  exitCode = 0
} finally {
  // The browser and the web shell first -- neither can spawn anything, and this gate starts no
  // daemon and dispatches no run, so there is nothing else to stop.
  if (browser !== null) await browser.close().catch(() => {})
  if (nextServer !== null && nextServer.exitCode === null) {
    nextServer.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextServer.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextServer.exitCode === null) nextServer.kill('SIGKILL')
  }
  // FK-ordered. `ExecutionEvent` has no FK to `Workspace` (M2's append-only log outlives entity
  // lifecycles by design) so it goes explicitly first; the workspace delete then cascades
  // Team/Slave/Task/SlaveRun/SupervisorDecision/GoalVersion. Nothing else was created.
  for (const id of [workspaceId, otherWorkspaceId]) {
    if (id === null) continue
    await prisma.executionEvent.deleteMany({ where: { workspaceId: id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id } }).catch(() => {})
  }
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
