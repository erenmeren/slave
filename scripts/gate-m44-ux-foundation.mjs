// M44's own gate (spec R8): "four ways in, and nothing on screen a person cannot read".
//
// `gate-m16-chrome.mjs`'s shape -- a free port, a real `next dev`, a real Chromium through
// `playwright-core` at CHROMIUM_PATH, no daemon -- with `gate-m14-fidelity.mjs`'s preflight and
// its browser helpers.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m44-ux-foundation
//
// THIS GATE SPENDS NOTHING AND CANNOT. It dispatches no run, so no CLI is ever invoked -- and the
// preflight still REFUSES to start unless SLAVEOFAI_CLAUDE_BIN points at an executable under
// `scripts/gate-fakes/` and SLAVEOFAI_REQUIRE_FAKE_CLI=1, so a later stage that grows a run cannot
// quietly reach a real account (Decision 10, M32 item 7).
//
// UNLIKE m16 IT WRITES FIXTURE ROWS, and that is the point. Most of the stages below are NEGATIVE
// ("no raw enum token is visible text"), and a negative assertion against the seeded database
// proves nothing: the seed has thirteen tasks and ZERO SlaveRun, SupervisorDecision, SimulationRun
// and missing-skill rows, so every slave is idle, the Supervisor panel is empty and the simulation
// list is empty. This gate creates exactly the rows that make those surfaces say something -- a
// pause_requested run (a `pausing` slave), a pending Supervisor decision, a Skill with
// `missingSince` set, a paused SimulationRun, and two ExecutionEvents so the Activity rail has a
// volume to label -- and deletes them in `finally`, in FK order. `git status` after a green run
// has to be empty.
//
// The eight stages of R8:
//   1. Four sidebar entries, in order, pointing where they say; /slaves and /skills land on
//      /workforce with the right tab; /analytics still answers.
//   2. The project strip is Overview/Tasks/Activity/Settings, and Advanced opens onto Graph and
//      Office, whose routes still render.
//   3. Every page renders inside PageShell or its page-level equivalent, with the one main
//      landmark and the sidebar present.
//   4. NO RAW ENUM TOKEN is visible text on the eleven pages -- the blocklist is DERIVED from the
//      domain's own unions, not typed here.
//   5. A drawer traps Tab and gives focus back on Escape.
//   6. The skip link is the first focusable element and reaches `main`.
//   7. The sidebar is 212px at 1440 and collapsed at 800.
//   8. Simulated money and model cost never share a tile.
//
// THE GATE ASSERTS, IT NEVER FIXES. Every stage prints every measured value before asserting it.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: like `gate-m14-fidelity.mjs`
// and `gate-m16-chrome.mjs`, it boots `next dev` against the repo's own `apps/web/.next` on a
// freshly-chosen free port, and a second `next dev` sharing that directory corrupts the on-disk
// build cache for both. Stop any running dev server first (`pgrep -af "next dev"`).

import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { chromium } from 'playwright-core'
import { createSimulation } from '../packages/control/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'
import { EVENT_TYPE_BY_DOMAIN_TYPE, RUN_STATUSES, TASK_STATUSES } from '../packages/db/dist/enums.js'
import { DECISION_STATUSES, SITUATION_KINDS, TIERS } from '../packages/domain/dist/index.js'

const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const PASS_LINE = 'four ways in, and nothing on screen a person cannot read'

// Suffixed per run (the `gate-m10-org.mjs` idiom): `Workspace.name` IS unique, and a distinct name
// per run keeps two overlapping executions from colliding on it. `preflightCleanup` removes
// leftovers by PREFIX.
const runTimestamp = new Date().toISOString()
const STAMP = runTimestamp.slice(11, 19)
const WORKSPACE_PREFIX = 'M44 Gate Project'
const WORKSPACE_NAME = `${WORKSPACE_PREFIX} ${STAMP}`
const COMPANY_PREFIX = 'M44 Gate Trading'
const COMPANY_NAME = `${COMPANY_PREFIX} ${STAMP}`
const TEMPLATE_PREFIX = 'M44 Gate Clerk'
const TEMPLATE_NAME = `${TEMPLATE_PREFIX} ${STAMP}`
const PROVIDER_PREFIX = 'm44-gate'
const PROVIDER_NAME = `${PROVIDER_PREFIX}:${STAMP}`
const SKILL_NAME = 'gate-missing-skill'
const SLAVE_NAME = 'M44 Gate Worker'
const TEAM_NAME = 'M44 Gate Department'
const SIMULATION_NAME = `m44 gate ${STAMP}`
/** The trade sector's own roster shape (`gate-m29-simulation.mjs`'s ROSTER, verbatim): four
 *  departments, one catalog slave each, which is what `plugin.rosterFits` asks for. */
const SIM_ROSTER = [
  ['Sales', 'M44 Gate Sonia'],
  ['Purchasing', 'M44 Gate Pete'],
  ['Operations', 'M44 Gate Olga'],
  ['Finance', 'M44 Gate Fin'],
]

/**
 * The Activity rail's own words. The SOURCE OF TRUTH is `apps/web/src/lib/eventLabels.ts`
 * (`EVENT_PREFIX_LABEL`), which lives inside the Next app -- `apps/web` compiles with `noEmit`, so
 * a plain `node` script cannot import it. The gate reads the WORDS off the page and compares them
 * against this small literal list; a rename in that file that is not made here fails stage 4's
 * positive counterpart, which is the point.
 */
const EVENT_PREFIX_WORDS = ['Tasks', 'Runs', 'Messages', 'Guardrails', 'Project', 'Organisation', 'Supervisor']

/**
 * The forbidden tokens, DERIVED from the domain's own unions rather than typed here (plan decision
 * D7): every member that carries an underscore or a dot, which is every member a person could not
 * have written by accident.
 *
 * A bare English word that happens to be an enum member (`working`, `paused`, `ready`, `done`,
 * `failed`, `blocked`, `merging`, `idle`, `model`, `rules`) is the product's own vocabulary and is
 * NOT forbidden -- forbidding it would forbid the very labels R4 projects.
 */
const RAW_TOKENS = [
  ...TASK_STATUSES,
  ...RUN_STATUSES,
  ...SITUATION_KINDS,
  ...DECISION_STATUSES,
  ...TIERS,
  ...Object.values(EVENT_TYPE_BY_DOMAIN_TYPE),
  ...Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE),
].filter((token) => token.includes('_') || token.includes('.'))

/**
 * THERE IS NO TOKEN EXEMPTION LIST, and that is deliberate.
 *
 * The first run of this gate found two surfaces R5 had missed -- the Overview page's `live events`
 * panel (through `feedSummary`'s fallback) and the Activity river's own `e.kind` chip -- each
 * printing a bare dotted event type. Both were FIXED (`readableEventType` in
 * `apps/web/src/lib/eventLabels.ts`, a projection over the seven-family table rather than the
 * per-type label table erratum E5 declined) rather than exempted here, because an exemption list
 * on a gate like this one only ever grows.
 *
 * The one thing stage 4 does not read is text a person cannot read either: a node inside a CLOSED
 * `<details>`, or one with no rendered box at all. Two surfaces live there -- the Activity page's
 * `Advanced` per-type filter, whose whole purpose is to name exact event types (a power-user
 * escape hatch behind a disclosure, untouched by R5), and every `PayloadDetails` block. Neither is
 * silently dropped: both are counted and printed per page, so a token that moved into a
 * disclosure to escape this scan would still show up in the run's own output.
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
  const staleCompanies = await prisma.company.findMany({
    where: { name: { startsWith: COMPANY_PREFIX } },
    select: { id: true, name: true },
  })
  for (const company of staleCompanies) {
    console.log(`preflight: removing leftover company ${company.id} (${company.name}) and its simulation runs`)
    // `SimulationRun.company` is `onDelete: Restrict` -- the runs go first or the company will not.
    await prisma.simulationRun.deleteMany({ where: { companyId: company.id } }).catch(() => {})
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {})
  }
  const staleTemplates = await prisma.slaveTemplate.findMany({
    where: { name: { startsWith: TEMPLATE_PREFIX } },
    select: { id: true, name: true },
  })
  for (const template of staleTemplates) {
    console.log(`preflight: removing leftover template ${template.id} (${template.name})`)
    await prisma.slaveTemplate.delete({ where: { id: template.id } }).catch(() => {})
  }
  const staleWorkspaces = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true },
  })
  for (const workspace of staleWorkspaces) {
    console.log(`preflight: removing leftover workspace ${workspace.id} (${workspace.name})`)
    await prisma.executionEvent.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {})
  }
  const staleProviders = await prisma.skillProvider.findMany({
    where: { name: { startsWith: `${PROVIDER_PREFIX}:` } },
    select: { id: true, name: true },
  })
  for (const provider of staleProviders) {
    console.log(`preflight: removing leftover skill provider ${provider.id} (${provider.name})`)
    await prisma.skillProvider.delete({ where: { id: provider.id } }).catch(() => {})
  }
}

let exitCode = 1
let nextServer = null
let browser = null
let page = null
let diagDir = null
let workspaceId = null
let teamId = null
let slaveId = null
let taskId = null
let runId = null
let decisionId = null
let companyId = null
let templateId = null
let simulationId = null
let skillProviderId = null
let skillId = null
/** The browser console, newest last, for `fail()`'s dump. */
const browserConsole = []

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m44-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ============================================================================================
  // Stage 0: preflight, and the fixture rows the negatives need.
  // ============================================================================================

  // Zero spend, ENFORCED (Decision 10, M32 item 7). This gate dispatches nothing today; the
  // refusal is here so that a later stage which grows a run cannot quietly reach a real account.
  const fakeClaude = process.env['SLAVEOFAI_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'SLAVEOFAI_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m44-ux-foundation',
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
      `no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m44-ux-foundation passes ` +
        '--env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m44-ux-foundation`')
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
    'the derived blocklist swallowed a bare English word -- D7 says the product vocabulary is not forbidden',
  )
  assert(RAW_TOKENS.includes('pause_requested'), 'the derived blocklist lost `pause_requested`, the token leak 1 used to print')
  assert(RAW_TOKENS.includes('no_reviewer'), 'the derived blocklist lost the SituationKind members')
  assert(RAW_TOKENS.includes('run.tool_call') && RAW_TOKENS.includes('run_tool_call'), 'the derived blocklist lost the event types')

  await preflightCleanup()

  // ---- The fixture. Each row exists to make one NEGATIVE assertion mean something. -------------
  const workspace = await prisma.workspace.create({
    data: { name: WORKSPACE_NAME, repoPath: repoRoot, verifyCommands: [], setupCommands: [], goal: 'Prove the navigation reads.' },
  })
  workspaceId = workspace.id
  const team = await prisma.team.create({ data: { workspaceId, name: TEAM_NAME } })
  teamId = team.id
  const slave = await prisma.slave.create({
    data: { teamId, name: SLAVE_NAME, role: 'engineer', runtimeRoles: ['engineer'], model: 'sonnet', provider: 'claude_code' },
  })
  slaveId = slave.id
  const task = await prisma.task.create({
    data: { workspaceId, title: 'M44 gate task', description: 'The task the paused run belongs to.', status: 'running', maxAttempts: 3, assigneeId: slaveId },
  })
  taskId = task.id
  // `pause_requested` is what makes `deriveSlaveStatus` say `pausing` -- the exact value leak 1
  // used to print on the Slaves table.
  const run = await prisma.slaveRun.create({
    data: { taskId, slaveId, status: 'pause_requested', provider: 'claude_code', toolCalls: 3 },
  })
  runId = run.id
  await prisma.task.update({ where: { id: taskId }, data: { activeRunId: runId } })
  // Two events, so the Activity page has a river AND a 24h volume rail with something to label.
  for (const type of ['task_created', 'run_started']) {
    await prisma.executionEvent.create({
      data: { type, workspaceId, taskId, slaveId, runId: type === 'run_started' ? runId : null, actor: 'system', payload: {} },
    })
  }
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
  const provider = await prisma.skillProvider.create({ data: { name: PROVIDER_NAME } })
  skillProviderId = provider.id
  const skill = await prisma.skill.create({
    data: { providerId: skillProviderId, name: SKILL_NAME, description: 'A skill whose file left the disk.', missingSince: new Date() },
  })
  skillId = skill.id
  // The paused simulation, created through the real verb so its `definition`/`state` are the
  // sector plugin's own -- a hand-built JSON blob would render a page nobody ships.
  const template = await prisma.slaveTemplate.create({ data: { name: TEMPLATE_NAME, role: 'clerk' } })
  templateId = template.id
  const company = await prisma.company.create({ data: { name: COMPANY_NAME } })
  companyId = company.id
  for (const [department, memberName] of SIM_ROSTER) {
    const companyTeam = await prisma.companyTeam.create({ data: { companyId, name: department } })
    await prisma.companySlave.create({ data: { companyTeamId: companyTeam.id, templateId, name: memberName } })
  }
  // An `llm` run, and NOT because anything calls a model: nothing ever steps this row (no daemon
  // runs, and it is `paused` a line below), so no call is made and nothing is spent. It is `llm`
  // so the "Model usage (real)" panel prints a real cap figure -- `... of $2.00` -- and stage 8's
  // separation of the two kinds of money has a bearer on BOTH sides. A `rules` run's panel reads
  // "no model calls; cost: no record", with no `$` in it at all, and a stage that only ever sees
  // simulated money is a stage that would pass on the day the real figure moved in beside it.
  const created = await createSimulation({
    companyId,
    name: SIMULATION_NAME,
    sector: 'trade',
    policy: 'A',
    seed: 5,
    decisionProvider: 'llm',
    modelProvider: 'claude_code',
    model: 'sonnet',
    maxModelCostUsd: 2,
  })
  if (!created.ok) {
    throw new Error(`could not create the fixture simulation: ${JSON.stringify(created.error)}`)
  }
  simulationId = created.value.id
  await prisma.simulationRun.update({ where: { id: simulationId }, data: { status: 'paused' } })

  console.log('stage 0 PASSED: the fixture rows the negatives need')
  console.log(`  workspace ${workspaceId} (${WORKSPACE_NAME})`)
  console.log(`  team ${teamId} · slave ${slaveId} (${SLAVE_NAME}) · task ${taskId}`)
  console.log(`  SlaveRun ${runId} status=pause_requested -> the slave reads \`pausing\``)
  console.log(`  SupervisorDecision ${decisionId} no_reviewer/proposed/pending/model`)
  console.log(`  SkillProvider ${skillProviderId} (${PROVIDER_NAME}) · Skill ${skillId} missingSince set`)
  console.log(`  Company ${companyId} · SlaveTemplate ${templateId} · SimulationRun ${simulationId} status=paused`)

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

  /** The m8a-estop-style diagnostic throw (`gate-m14-fidelity.mjs`'s `fail`, minus the daemon it
   *  has and this gate does not): the state that made the call, not just "it timed out". */
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
   *  diagnostic dump instead of a bare Playwright TimeoutError. (`gate-m14-fidelity.mjs`'s helper.) */
  async function waitVisible(locator, description) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
    } catch {
      await fail(`timed out waiting for ${description} to become visible`)
    }
  }

  /** `page.goto`, with a 5xx routed through `fail()`'s dump rather than a bare Playwright error.
   *  Deliberately WITHOUT `gate-m14-fidelity.mjs`'s manifest-race retry: that gate walks nine
   *  pages twice under a live run, and its own comment says the retry stands in for a torn
   *  `loadManifest` read. This gate visits each route once; if that ever proves flaky here, the
   *  retry is the thing to copy across, with its accounting. */
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

  /** Clicks `locator`, then bounded-waits for `predicate`. (`gate-m14-fidelity.mjs`'s helper.) */
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
  // Stage 1: the four ways in.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/`)
  await waitVisible(page.getByRole('navigation', { name: 'Primary' }), "the Projects page's sidebar")
  const navRows = await page.evaluate(() =>
    [...document.querySelectorAll('nav[aria-label="Primary"] [data-testid="nav-row"]')].map((row) => [
      row.getAttribute('data-nav') ?? '',
      // `getAttribute`, not `.href`: the DOM property resolves to an absolute URL.
      row.getAttribute('href') ?? '',
      row.getAttribute('aria-label') ?? '',
    ]),
  )
  console.log(`stage 1: sidebar rows in DOM order = ${JSON.stringify(navRows.map(([nav, href]) => [nav, href]))}`)
  const EXPECTED_NAV = [
    ['Projects', '/'],
    ['Workforce', '/workforce'],
    ['Simulations', '/sim'],
    ['Settings', '/settings'],
  ]
  if (JSON.stringify(navRows.map(([nav, href]) => [nav, href])) !== JSON.stringify(EXPECTED_NAV)) {
    await fail(
      `stage 1: the sidebar is ${JSON.stringify(navRows.map(([nav, href]) => [nav, href]))}, expected ${JSON.stringify(EXPECTED_NAV)}`,
    )
  }
  for (const [nav, , ariaLabel] of navRows) {
    if (ariaLabel === '') await fail(`stage 1: the ${nav} row has no aria-label`)
  }
  for (const gone of ['Slaves', 'Skills', 'Analytics']) {
    if (navRows.some(([nav]) => nav === gone)) {
      await fail(`stage 1: the sidebar still carries a "${gone}" row -- R1 leaves four entries, not five or six`)
    }
  }
  console.log('stage 1: no Slaves, Skills or Analytics row remains in the sidebar')

  await gotoReliably(`${baseUrl}/slaves`)
  await waitVisible(page.getByTestId('workforce-tab-slaves'), 'the Workforce Slaves tab after /slaves')
  const slavesUrl = page.url()
  console.log(`stage 1: /slaves landed on ${slavesUrl}`)
  if (!slavesUrl.endsWith('/workforce')) {
    await fail(`stage 1: /slaves landed on ${slavesUrl}, expected a URL ending /workforce`)
  }
  const slavesTabSelected = await page.getByTestId('workforce-tab-slaves').first().getAttribute('aria-selected')
  console.log(`stage 1: workforce-tab-slaves aria-selected = ${JSON.stringify(slavesTabSelected)}`)
  if (slavesTabSelected !== 'true') {
    await fail(`stage 1: /slaves did not select the Slaves tab (aria-selected=${JSON.stringify(slavesTabSelected)})`)
  }

  await gotoReliably(`${baseUrl}/skills`)
  await waitVisible(page.getByTestId('workforce-tab-skills'), 'the Workforce Skills tab after /skills')
  const skillsUrl = page.url()
  console.log(`stage 1: /skills landed on ${skillsUrl}`)
  if (!skillsUrl.includes('tab=skills')) {
    await fail(`stage 1: /skills landed on ${skillsUrl}, expected a URL carrying tab=skills`)
  }
  const skillsTabSelected = await page.getByTestId('workforce-tab-skills').first().getAttribute('aria-selected')
  console.log(`stage 1: workforce-tab-skills aria-selected = ${JSON.stringify(skillsTabSelected)}`)
  if (skillsTabSelected !== 'true') {
    await fail(`stage 1: /skills did not select the Skills tab (aria-selected=${JSON.stringify(skillsTabSelected)})`)
  }

  await gotoReliably(`${baseUrl}/analytics?workspace=${workspaceId}`)
  await waitVisible(page.getByTestId('kpi-tile'), 'an Analytics KPI tile (the route R1 promised to keep)')
  const kpiCount = await page.getByTestId('kpi-tile').count()
  console.log(`stage 1: /analytics?workspace=<fixture> answered with ${String(kpiCount)} kpi-tile(s)`)
  assert(kpiCount > 0, 'stage 1: /analytics rendered no KPI tile at all')
  console.log('stage 1 PASSED: four entries, in order, pointing where they say; /slaves and /skills land on the right tab; /analytics still answers')

  // ============================================================================================
  // Stage 2: the project strip, and the Advanced menu's two routes.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await waitVisible(page.getByTestId('project-tab-overview'), "the project's tab strip")
  // Scoped to the PROJECT tablist: the page carries other `role="tab"` strips of its own, and an
  // unscoped query would be measuring whichever ones happened to render.
  const stripLabels = await page.evaluate(() =>
    [...document.querySelectorAll('[role="tablist"][aria-label="Project"] [role="tab"]')].map((tab) =>
      // The badge digits ride inside the tab's own text (`project-tabs.test.tsx` strips them the
      // same way) -- the label is what is left.
      (tab.textContent ?? '').replace(/\d+$/, '').trim(),
    ),
  )
  console.log(`stage 2: project tabs = ${JSON.stringify(stripLabels)}`)
  if (JSON.stringify(stripLabels) !== JSON.stringify(['Overview', 'Tasks', 'Activity', 'Settings'])) {
    await fail(`stage 2: the project strip is ${JSON.stringify(stripLabels)}, expected ["Overview","Tasks","Activity","Settings"]`)
  }
  const graphItemBefore = await page.getByTestId('advanced-item-graph').count()
  console.log(`stage 2: advanced-item-graph before the menu is opened = ${String(graphItemBefore)} element(s)`)
  if (graphItemBefore !== 0) {
    await fail('stage 2: the Advanced menu is already open on arrival -- its items must be behind the trigger')
  }
  await clickUntil(
    page.getByTestId('project-advanced'),
    async () => page.getByTestId('advanced-item-graph').first().isVisible(),
    'the Advanced trigger',
  )
  const advancedHrefs = await page.evaluate(() => ({
    graph: document.querySelector('[data-testid="advanced-item-graph"]')?.getAttribute('href') ?? null,
    office: document.querySelector('[data-testid="advanced-item-office"]')?.getAttribute('href') ?? null,
  }))
  console.log(`stage 2: Advanced menu hrefs = ${JSON.stringify(advancedHrefs)}`)
  if (advancedHrefs.graph !== `/w/${workspaceId}/graph`) {
    await fail(`stage 2: advanced-item-graph points at ${JSON.stringify(advancedHrefs.graph)}, expected /w/${workspaceId}/graph`)
  }
  if (advancedHrefs.office !== `/w/${workspaceId}/office`) {
    await fail(`stage 2: advanced-item-office points at ${JSON.stringify(advancedHrefs.office)}, expected /w/${workspaceId}/office`)
  }
  // Not decoration: both routes still render.
  await gotoReliably(`${baseUrl}/w/${workspaceId}/graph`)
  await waitVisible(page.getByTestId('graph-canvas'), "the Graph route's canvas, reached from Advanced")
  console.log('stage 2: /w/<id>/graph rendered graph-canvas')
  await gotoReliably(`${baseUrl}/w/${workspaceId}/office`)
  await waitVisible(page.getByTestId('office-canvas'), "the Office route's canvas, reached from Advanced")
  console.log('stage 2: /w/<id>/office rendered office-canvas')

  // Escape closes the menu and hands the keyboard back to the trigger (E22: a menu, not a modal).
  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await waitVisible(page.getByTestId('project-advanced'), 'the Advanced trigger, for the Escape check')
  await clickUntil(
    page.getByTestId('project-advanced'),
    async () => page.getByTestId('advanced-item-graph').first().isVisible(),
    'the Advanced trigger (Escape check)',
  )
  await page.keyboard.press('Escape')
  await delay(150)
  const afterEscape = await page.evaluate(() => ({
    items: document.querySelectorAll('[data-testid="advanced-item-graph"]').length,
    active: document.activeElement?.getAttribute('data-testid') ?? null,
    expanded: document.querySelector('[data-testid="project-advanced"]')?.getAttribute('aria-expanded') ?? null,
  }))
  console.log(`stage 2: after Escape = ${JSON.stringify(afterEscape)}`)
  if (afterEscape.items !== 0 || afterEscape.expanded !== 'false') {
    await fail(`stage 2: Escape did not close the Advanced menu (${JSON.stringify(afterEscape)})`)
  }
  if (afterEscape.active !== 'project-advanced') {
    await fail(`stage 2: Escape left focus on ${JSON.stringify(afterEscape.active)}, expected the project-advanced trigger`)
  }
  console.log('stage 2 PASSED: four tabs, Advanced onto Graph and Office, both routes rendering, Escape giving the keyboard back')

  // ============================================================================================
  // Stages 3 and 4, in ONE pass over the pages: the shell contract and the raw-token scan.
  //
  // One pass, not two, because in `next dev` the expensive part of visiting a route is compiling
  // it -- and both stages want exactly the same set of pages in exactly the same state. Each page
  // prints its own stage-3 line and its own stage-4 line before either is asserted.
  //
  // The ELEVEN pages of R8 are the fidelity gate's nine (with `workforce` for `slaves`) plus
  // `/w/<id>/office` and `/w/<id>/settings`. `/sim` and `/sim/<id>` are scanned too: the fixture's
  // paused simulation lives there, and leak 6's word is on the first of them.
  // ============================================================================================
  const PAGES = [
    { name: 'projects', path: `/`, testId: 'project-card', fidelity: true },
    { name: 'workforce', path: `/workforce`, testId: 'data-table', fidelity: true },
    { name: 'skills', path: `/skills`, testId: 'empty-tile', fidelity: true },
    { name: 'analytics', path: `/analytics?workspace=${workspaceId}`, testId: 'kpi-tile', fidelity: true },
    { name: 'settings', path: `/settings`, testId: 'security-posture', fidelity: true },
    { name: 'overview', path: `/w/${workspaceId}`, testId: 'strip', fidelity: true },
    { name: 'tasks', path: `/w/${workspaceId}/tasks`, testId: 'column', fidelity: true },
    { name: 'activity', path: `/w/${workspaceId}/activity`, testId: 'timeline-viewport', fidelity: true },
    { name: 'graph', path: `/w/${workspaceId}/graph`, testId: 'graph-canvas', fidelity: true },
    { name: 'office', path: `/w/${workspaceId}/office`, testId: 'office-canvas', fidelity: true },
    { name: 'project-settings', path: `/w/${workspaceId}/settings`, testId: 'perm-caption', fidelity: true },
    { name: 'simulations', path: `/sim`, testId: 'sim-card', fidelity: false },
    { name: 'simulation', path: `/sim/${simulationId}`, testId: 'sim-company', fidelity: false },
  ]

  /**
   * Every string a person can actually READ on the page right now, with the testid path of the
   * element that renders it.
   *
   * Text NODES, never `outerHTML`: R5's whole contract is that the raw value stays reachable in a
   * `title` and on a `data-` attribute, and neither of those is a text node.
   *
   * RENDERED text, not merely attached: a node inside a closed `<details>` -- the Activity page's
   * own `Advanced` event-type filter, and every `PayloadDetails` disclosure -- is in the DOM and
   * on nobody's screen. Three tests make that distinction, and it takes all three: a closed
   * `<details>` BY NAME (Chromium hides its contents with `content-visibility`, so those nodes
   * still report client rects), then `getClientRects()`, then `checkVisibility()`. What they
   * exclude is returned as `hidden` and counted per page, never silently dropped.
   */
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
        // A closed `<details>` first, and by name: Chromium hides its contents with
        // `content-visibility` rather than `display:none`, so those nodes still report client
        // rects and the rect test alone let all ~57 filter checkboxes through as "rendered". Its
        // own `<summary>` is on screen and stays in the scan.
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

  let hiddenTokenPages = 0

  for (const target of PAGES) {
    await gotoReliably(`${baseUrl}${target.path}`)
    await waitVisible(page.getByTestId(target.testId), `${target.name}'s structural marker [data-testid=${target.testId}]`)
    await waitVisible(page.getByRole('navigation', { name: 'Primary' }), `${target.name}'s sidebar`)

    // ---- Stage 3: one shell, one landmark. -----------------------------------------------------
    const shell = await page.evaluate(() => ({
      nav: document.querySelectorAll('nav[aria-label="Primary"]').length,
      mains: document.querySelectorAll('main').length,
      mainById: document.querySelector('main#main') !== null,
      mainTabIndex: document.querySelector('main#main')?.getAttribute('tabindex') ?? null,
      pageShell: document.querySelectorAll('[data-testid="page-shell"]').length,
    }))
    console.log(`stage 3 (${target.name}): ${JSON.stringify(shell)}`)
    if (shell.nav !== 1) await fail(`stage 3 (${target.name}): ${String(shell.nav)} Primary navigation landmark(s), expected exactly 1`)
    if (shell.mains !== 1) {
      await fail(
        `stage 3 (${target.name}): ${String(shell.mains)} <main> landmark(s), expected exactly 1 -- a document with ten ` +
          'main landmarks has none (erratum E16)',
      )
    }
    if (!shell.mainById) await fail(`stage 3 (${target.name}): no main#main -- the skip link has nothing to reach`)
    if (shell.mainTabIndex !== '-1') {
      await fail(`stage 3 (${target.name}): main#main tabindex is ${JSON.stringify(shell.mainTabIndex)}, expected "-1" so focus can land on it`)
    }

    // ---- Stage 4: no raw enum token as visible text. -------------------------------------------
    const { shown, hidden } = await readVisibleText()
    const offenders = []
    for (const entry of shown) {
      for (const token of RAW_TOKENS) {
        if (entry.text.includes(token)) offenders.push({ token, ...entry })
      }
    }
    if (offenders.length > 0) {
      await fail(
        `stage 4 (${target.name}): a raw enum token is visible text -- ` +
          offenders
            .slice(0, 10)
            .map((o) => `${JSON.stringify(o.token)} inside ${o.where}: ${JSON.stringify(o.text.slice(0, 160))}`)
            .join('; '),
      )
    }
    const hiddenTokens = hidden.filter((entry) => RAW_TOKENS.some((token) => entry.text.includes(token)))
    if (hiddenTokens.length > 0) hiddenTokenPages += 1
    console.log(
      `stage 4 (${target.name}): ${String(shown.length)} rendered string(s), none containing any of the ` +
        `${String(RAW_TOKENS.length)} derived tokens; ${String(hiddenTokens.length)} token(s) present only in ` +
        'un-rendered text (a closed <details>)',
    )

    // ---- Stage 4's positive counterparts, so the negative is not vacuous. ----------------------
    if (target.name === 'workforce') {
      const row = page.getByTestId('data-table-row').filter({ hasText: SLAVE_NAME })
      await waitVisible(row, `the fixture worker's row on /workforce`)
      const pill = await row.first().getByTestId('status-pill').first()
      const word = (await pill.textContent())?.trim() ?? ''
      const raw = await pill.getAttribute('title')
      console.log(`stage 4 (workforce) POSITIVE: the pausing worker's pill reads ${JSON.stringify(word)}, title=${JSON.stringify(raw)}`)
      if (word !== 'PAUSING') await fail(`stage 4 (workforce): the pill reads ${JSON.stringify(word)}, expected "PAUSING"`)
      if (raw !== 'pausing') await fail(`stage 4 (workforce): the pill's title is ${JSON.stringify(raw)}, expected "pausing"`)
      // The PageShell frame -- `/workforce` is the one page built on it (R3). Its `testId` prop is
      // `workforce`, so `page-shell` is the default nobody uses; the frame is asserted by name.
      const frame = await page.getByTestId('workforce').count()
      console.log(`stage 3 (workforce): the PageShell frame renders (${String(frame)} element)`)
      if (frame !== 1) await fail(`stage 3 (workforce): ${String(frame)} PageShell frame(s), expected exactly 1`)
    }
    if (target.name === 'skills') {
      const state = page.getByTestId(`skill-state-${skillId}`)
      await waitVisible(state, "the fixture skill's state chip")
      const word = (await state.first().textContent())?.trim() ?? ''
      const raw = await state.first().getAttribute('title')
      const dataState = await state.first().getAttribute('data-state')
      console.log(`stage 4 (skills) POSITIVE: the missing skill reads ${JSON.stringify(word)}, title=${JSON.stringify(raw)}, data-state=${JSON.stringify(dataState)}`)
      if (word !== 'MISSING') await fail(`stage 4 (skills): the state chip reads ${JSON.stringify(word)}, expected "MISSING"`)
      if (raw !== 'missing') await fail(`stage 4 (skills): the state chip's title is ${JSON.stringify(raw)}, expected "missing"`)
    }
    if (target.name === 'overview') {
      await waitVisible(page.getByTestId('supervisor-decision-meta'), "the Supervisor panel's decision row")
      const meta = page.getByTestId('supervisor-decision-meta').first()
      const sentence = (await meta.textContent())?.trim() ?? ''
      const rawRecord = await meta.getAttribute('title')
      const kindChip = page.getByTestId('supervisor-proposal-kind').first()
      const kindWord = (await kindChip.textContent())?.trim() ?? ''
      const kindRaw = await kindChip.getAttribute('title')
      console.log(`stage 4 (overview) POSITIVE: decision row reads ${JSON.stringify(sentence)}, title=${JSON.stringify(rawRecord)}`)
      console.log(`stage 4 (overview) POSITIVE: proposal kind reads ${JSON.stringify(kindWord)}, title=${JSON.stringify(kindRaw)}`)
      if (!sentence.includes('No reviewer')) {
        await fail(`stage 4 (overview): the decision row reads ${JSON.stringify(sentence)}, expected it to name the situation "No reviewer"`)
      }
      if (rawRecord === null || !rawRecord.includes('no_reviewer')) {
        await fail(`stage 4 (overview): the decision row's title is ${JSON.stringify(rawRecord)}, expected it to keep the raw record`)
      }
      if (kindWord !== 'No reviewer' || kindRaw !== 'no_reviewer') {
        await fail(`stage 4 (overview): the proposal kind chip is ${JSON.stringify(kindWord)}/${JSON.stringify(kindRaw)}, expected "No reviewer"/"no_reviewer"`)
      }
    }
    if (target.name === 'activity') {
      await waitVisible(page.getByTestId('volume-label'), "the Activity rail's volume label")
      const volumes = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="volume-bar"]')].map((bar) => ({
          prefix: bar.getAttribute('data-prefix'),
          word: bar.querySelector('[data-testid="volume-label"]')?.textContent?.trim() ?? '',
          title: bar.querySelector('[data-testid="volume-label"]')?.getAttribute('title') ?? null,
        })),
      )
      console.log(`stage 4 (activity) POSITIVE: the rail reads ${JSON.stringify(volumes)}`)
      assert(volumes.length > 0, 'stage 4 (activity): the 24h rail is empty -- the fixture events should have filled it')
      for (const volume of volumes) {
        if (!EVENT_PREFIX_WORDS.includes(volume.word)) {
          await fail(
            `stage 4 (activity): a rail row reads ${JSON.stringify(volume.word)}, which is not one of the words ` +
              `${JSON.stringify(EVENT_PREFIX_WORDS)} (source of truth: apps/web/src/lib/eventLabels.ts)`,
          )
        }
        if (volume.title !== volume.prefix) {
          await fail(`stage 4 (activity): a rail row's title is ${JSON.stringify(volume.title)}, expected the raw prefix ${JSON.stringify(volume.prefix)}`)
        }
      }
    }
    if (target.name === 'simulations') {
      const chip = page.locator(`[data-testid="sim-card-${simulationId}"] [data-testid="chip"][title="paused"]`)
      await waitVisible(chip, "the paused simulation's status chip")
      const word = (await chip.first().textContent())?.trim() ?? ''
      console.log(`stage 4 (simulations) POSITIVE: the paused run's chip reads ${JSON.stringify(word)}, title="paused"`)
      if (word !== 'Paused') await fail(`stage 4 (simulations): the status chip reads ${JSON.stringify(word)}, expected "Paused"`)
    }
  }
  console.log(
    `stage 3 PASSED: ${String(PAGES.length)} pages, each with one Primary navigation landmark, exactly one <main>, and that ` +
      'main being #main with tabindex="-1"',
  )
  console.log(
    `stage 4 PASSED: none of the ${String(RAW_TOKENS.length)} derived raw tokens is rendered text on any of ` +
      `${String(PAGES.length)} pages (${String(PAGES.filter((p) => p.fidelity).length)} of them the R8 eleven), with a positive ` +
      `counterpart read back on five surfaces, and NO exemption list; ${String(hiddenTokenPages)} page(s) carry a token ` +
      'only inside un-rendered text (a closed <details>)',
  )

  // ============================================================================================
  // Stage 5: a drawer's keyboard.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/`)
  await waitVisible(page.getByTestId('new-project'), 'the + New project trigger')
  await clickUntil(
    page.getByTestId('new-project'),
    async () => page.getByTestId('new-project-drawer').first().isVisible(),
    'the + New project trigger',
  )
  const openedInside = await page.evaluate(() => {
    const drawer = document.querySelector('[data-testid="new-project-drawer"]')
    const active = document.activeElement
    return {
      inside: drawer !== null && active !== null && drawer.contains(active),
      active: active?.getAttribute('data-testid') ?? active?.tagName.toLowerCase() ?? null,
    }
  })
  console.log(`stage 5: on open, focus is ${JSON.stringify(openedInside)}`)
  if (!openedInside.inside) await fail(`stage 5: the drawer opened without taking focus (${JSON.stringify(openedInside)})`)
  const trail = []
  for (let press = 0; press < 30; press += 1) {
    await page.keyboard.press('Tab')
    const step = await page.evaluate(() => {
      const drawer = document.querySelector('[data-testid="new-project-drawer"]')
      const active = document.activeElement
      return {
        inside: drawer !== null && active !== null && drawer.contains(active),
        active: active?.getAttribute('data-testid') ?? active?.getAttribute('aria-label') ?? active?.tagName.toLowerCase() ?? null,
      }
    })
    trail.push(step.active)
    if (!step.inside) {
      await fail(
        `stage 5: Tab #${String(press + 1)} took focus OUT of the drawer, onto ${JSON.stringify(step.active)} -- ` +
          `trail so far: ${JSON.stringify(trail)}`,
      )
    }
  }
  console.log(`stage 5: focus trail over 30 Tab presses = ${JSON.stringify(trail)}`)
  await page.keyboard.press('Escape')
  await delay(200)
  const afterClose = await page.evaluate(() => ({
    drawers: document.querySelectorAll('[data-testid="new-project-drawer"]').length,
    active: document.activeElement?.getAttribute('data-testid') ?? null,
  }))
  console.log(`stage 5: after Escape = ${JSON.stringify(afterClose)}`)
  if (afterClose.drawers !== 0) await fail(`stage 5: Escape did not close the drawer (${JSON.stringify(afterClose)})`)
  if (afterClose.active !== 'new-project') {
    await fail(`stage 5: Escape left focus on ${JSON.stringify(afterClose.active)}, expected the new-project trigger that opened it`)
  }
  console.log('stage 5 PASSED: the drawer takes focus, holds it through 30 Tab presses, and gives it back on Escape')

  // ============================================================================================
  // Stage 6: the skip link.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/`)
  await waitVisible(page.getByTestId('skip-link'), 'the skip link')
  await page.evaluate(() => {
    document.body.focus()
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur()
  })
  await page.keyboard.press('Tab')
  const firstFocus = await page.evaluate(() => ({
    testId: document.activeElement?.getAttribute('data-testid') ?? null,
    href: document.activeElement?.getAttribute('href') ?? null,
    text: document.activeElement?.textContent?.trim() ?? null,
  }))
  console.log(`stage 6: the first Tab lands on ${JSON.stringify(firstFocus)}`)
  if (firstFocus.testId !== 'skip-link') {
    await fail(`stage 6: the first focusable element is ${JSON.stringify(firstFocus.testId)}, expected the skip-link`)
  }
  if (firstFocus.href !== '#main') {
    await fail(`stage 6: the skip link points at ${JSON.stringify(firstFocus.href)}, expected "#main"`)
  }
  await page.keyboard.press('Enter')
  await delay(200)
  const afterEnter = await page.evaluate(() => ({
    id: document.activeElement?.id ?? null,
    tag: document.activeElement?.tagName.toLowerCase() ?? null,
  }))
  console.log(`stage 6: after Enter, document.activeElement = ${JSON.stringify(afterEnter)}`)
  if (afterEnter.id !== 'main') {
    await fail(
      `stage 6: activating the skip link left focus on ${JSON.stringify(afterEnter)} -- a skip link that only scrolls has ` +
        'moved the viewport and not the keyboard',
    )
  }
  console.log('stage 6 PASSED: the skip link is the first thing the keyboard finds, and it actually moves focus to main')

  // ============================================================================================
  // Stage 7: the collapse.
  // ============================================================================================
  const wideWidth = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Primary"]')
    return nav === null ? null : window.getComputedStyle(nav).width
  })
  console.log(`stage 7: sidebar width at 1440x900 = ${JSON.stringify(wideWidth)}`)
  if (wideWidth !== '212px') await fail(`stage 7: the sidebar is ${JSON.stringify(wideWidth)} at 1440x900, expected "212px" (the README number)`)
  await page.setViewportSize({ width: 800, height: 900 })
  await gotoReliably(`${baseUrl}/`)
  await waitVisible(page.getByRole('navigation', { name: 'Primary' }), 'the sidebar at 800x900')
  const narrow = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Primary"]')
    return {
      width: nav === null ? null : window.getComputedStyle(nav).width,
      labels: [...document.querySelectorAll('[data-testid="nav-row"]')].map((row) => row.getAttribute('aria-label') ?? ''),
    }
  })
  console.log(`stage 7: at 800x900 = ${JSON.stringify(narrow)}`)
  if (narrow.width !== '52px') await fail(`stage 7: the sidebar is ${JSON.stringify(narrow.width)} at 800x900, expected "52px"`)
  if (narrow.labels.length !== 4 || narrow.labels.some((label) => label === '')) {
    await fail(`stage 7: a collapsed row lost its aria-label (${JSON.stringify(narrow.labels)}) -- the rail is icons to the eye, words to a reader`)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  console.log('stage 7 PASSED: 212px at 1440, 52px at 800, and every collapsed row still says its own name')

  // ============================================================================================
  // Stage 8: two kinds of money.
  //
  // `data-simulation="true"` is on the simulated-money block's root (`sim-company`), added by this
  // task: without a marker, a gate has to GUESS which panel is which, and a gate that guesses is a
  // gate that passes on the day the two merge.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/sim/${simulationId}`)
  await waitVisible(page.getByTestId('sim-company'), "the simulated company's headline block")
  await waitVisible(page.getByTestId('sim-model-usage'), 'the real model-usage block')
  const money = await page.evaluate(() => {
    const structural = {
      simulatedIsMarked: document.querySelector('[data-testid="sim-company"][data-simulation]') !== null,
      realInsideSimulated: document.querySelector('[data-testid="sim-model-usage"]')?.closest('[data-simulation]') !== null,
      modelUsageText: document.querySelector('[data-testid="sim-model-usage"]')?.textContent?.trim() ?? null,
    }
    // Only elements that RENDER a `$` themselves -- an ancestor "contains" one only through its
    // descendants, and asking which side <body> falls on is not a question about a tile. The same
    // "text a person can actually read" rule stage 4 uses: `<script>` is the biggest source of a
    // stray `$` on any Next page (the RSC payload is inlined into one), and it is nobody's tile.
    const bearers = []
    for (const element of document.querySelectorAll('*')) {
      if (element.closest('nextjs-portal, script, style, [aria-hidden="true"], .sr-only') !== null) continue
      if (element.getClientRects().length === 0) continue
      const own = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.nodeValue ?? '')
        .join('')
      if (!own.includes('$')) continue
      const owner = element.closest('[data-testid]')
      bearers.push({
        where: owner === null ? element.tagName.toLowerCase() : `[data-testid="${owner.getAttribute('data-testid') ?? ''}"]`,
        text: own.trim().slice(0, 80),
        simulated: element.closest('[data-simulation]') !== null,
        real: element.closest('[data-testid="sim-model-usage"]') !== null,
      })
    }
    return { ...structural, bearers }
  })
  console.log(`stage 8: model usage panel reads ${JSON.stringify(money.modelUsageText)}`)
  for (const bearer of money.bearers) {
    console.log(`stage 8: ${bearer.where} renders ${JSON.stringify(bearer.text)} -- simulated=${String(bearer.simulated)} real=${String(bearer.real)}`)
  }
  if (!money.simulatedIsMarked) {
    await fail('stage 8: the simulated-money block carries no data-simulation marker -- nothing tells the two kinds of money apart')
  }
  if (money.realInsideSimulated) {
    await fail('stage 8: the real model-usage block sits INSIDE a data-simulation subtree -- the two kinds of money share a container')
  }
  const both = money.bearers.filter((bearer) => bearer.simulated && bearer.real)
  if (both.length > 0) {
    await fail(`stage 8: ${JSON.stringify(both)} -- an element renders money that is both simulated and real`)
  }
  const neither = money.bearers.filter((bearer) => !bearer.simulated && !bearer.real)
  if (neither.length > 0) {
    await fail(
      `stage 8: ${JSON.stringify(neither)} -- money on this page that belongs to neither the simulated company nor the ` +
        'real model-usage panel. Every figure has to say which kind it is.',
    )
  }
  // Both sides have to be OCCUPIED, or the separation is a separation of one thing from nothing.
  const simulatedBearers = money.bearers.filter((bearer) => bearer.simulated)
  const realBearers = money.bearers.filter((bearer) => bearer.real)
  if (simulatedBearers.length === 0) {
    await fail('stage 8: no simulated money on the page at all -- the check has nothing to separate and would pass on an empty page')
  }
  if (realBearers.length === 0) {
    await fail(
      `stage 8: no REAL money on the page at all (the model-usage panel reads ${JSON.stringify(money.modelUsageText)}) -- ` +
        'the fixture run is meant to carry a cost cap so this side is occupied too',
    )
  }
  console.log(
    `stage 8 PASSED: ${String(simulatedBearers.length)} simulated figure(s) and ${String(realBearers.length)} real one(s), ` +
      'none of them in the same subtree',
  )

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
  // Team/Slave/Task/SlaveRun/SupervisorDecision. `SimulationRun.company` is `onDelete: Restrict`,
  // so the run goes before its company, and the company before the template its roster points at.
  if (workspaceId !== null) {
    await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  if (simulationId !== null) await prisma.simulationRun.delete({ where: { id: simulationId } }).catch(() => {})
  if (companyId !== null) await prisma.company.delete({ where: { id: companyId } }).catch(() => {})
  if (templateId !== null) await prisma.slaveTemplate.delete({ where: { id: templateId } }).catch(() => {})
  // The provider cascades its Skill rows. UNLIKE `gate-m14-fidelity.mjs`, whose catalog rows
  // describe the daemon host's real disk and are kept under Decision 6, this provider is a fiction
  // this gate invented and has to take back out.
  if (skillProviderId !== null) await prisma.skillProvider.delete({ where: { id: skillProviderId } }).catch(() => {})
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
