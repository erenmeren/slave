// M11's own gate (Task 13 brief): "the shell went global -- a company was staffed, assigned, and
// steered entirely from the browser". `gate-m10-org.mjs` proves the org model's verbs the way an
// operator running the CLI would; this script proves the SAME materialization/model-resolution
// machinery the way an operator using the web shell actually would -- a real Chromium
// (`playwright-core`, no test runner) driving a real `next dev` server through `/settings`, `/`
// and `/agents`, with every assertion a direct `prisma` read, never anything the browser merely
// claims.
//
// Shape borrowed verbatim from `gate-m10-org.mjs`: dist imports, everything created inside `try`,
// `finally` kills every process this script spawned and cleans up in FK order, `exitCode` starts
// at 1 and is only set to 0 at the very end of a fully-asserted run, `process.exit(exitCode)` is
// the last line. Stage 1 (two fresh workspaces via `prisma.workspace.create`, NOT the CLI) is
// m10's own stage-1 idiom, copied as-is -- everything after that is new: booting `next dev` on a
// free port, launching Chromium from `CHROMIUM_PATH` (falling back to `/usr/bin/chromium`,
// failing fast with a clear message if neither exists), and driving the five scenario stages the
// brief lists through real form fills/clicks rather than CLI calls or fetches.
//
// A FAIL from any stage dumps the page's current URL, every "M11 Gate"-named row still in the DB,
// and a full-page screenshot into a scratch directory this script creates and prints the path to
// -- the `gate-m8a-estop.mjs` idiom of a thrown error carrying the state that made the call, not
// just "it timed out".

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { chromium } from 'playwright-core'
import { prisma } from '../packages/db/dist/client.js'

const ACTION_TIMEOUT_MS = 20_000
const NEXT_READY_TIMEOUT_MS = 60_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const runTimestamp = new Date().toISOString()

// The brief's exact literal names -- never suffixed with `runTimestamp` the way m10's
// CLI-driven names are, because these are typed into real form fields the way an operator would
// type them. Left as exact literals means a prior run that crashed before its own `finally`
// cleanup (killed mid-run, etc.) can collide on `AgentTemplate.name`/`Company.name`/
// `CompanyTeam(companyId,name)`/`CompanyAgent(companyTeamId,name)`'s unique constraints --
// `preflightCleanup` below removes any such leftovers before this run creates its own.
const TEMPLATE_NAME = 'M11 Gate Template'
const COMPANY_NAME = 'M11 Gate Co'
const TEAM_NAME = 'Crew'
const MEMBER_NAME = 'Gate Worker'
const MODEL_OVERRIDE = 'gate-model-x'
// `claude_code`, not `cursor`: stage 1's workspaces carry no explicit `budgetUsd`, so they get the
// schema's `@default(20)` (budgeted), and only `claude_code` reports cost (M12 Task 9's admission
// guard). This is exercising the Roster editor's pair control, not budget admission -- `cursor`
// would refuse here for a reason this stage isn't testing.
const PROVIDER_OVERRIDE = 'claude_code'

/** Same as `gate-m10-org.mjs`'s `makeRepo` -- a real repository, because `Workspace.repoPath`
 *  names a real directory even though this gate never runs the orchestrator against it. */
function makeRepo(suffix) {
  const dir = mkdtempSync(join(tmpdir(), `aiteamos-gate-m11-shell-${suffix}-`))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/** Asks the OS for a free TCP port. `next dev -p <port>` still auto-increments if something
 *  grabs it between this call and the spawn below -- the ready-wait parses the ACTUAL bound port
 *  back out of `next dev`'s own "- Local: http://localhost:<port>" line rather than trusting this
 *  one blindly. */
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

/** Removes any "M11 Gate"-named rows a prior interrupted run left behind, in the same FK order
 *  the `finally` block below uses: workspaces first (cascades Team/Agent), then the company
 *  (cascades CompanyTeam/CompanyAgent), then the template. Safe to run against an empty slate --
 *  every step is a no-op when nothing matches. */
async function preflightCleanup() {
  const staleWorkspaces = await prisma.workspace.findMany({
    where: { name: { startsWith: 'M11 Gate Project ' } },
    select: { id: true },
  })
  for (const workspace of staleWorkspaces) {
    await prisma.executionEvent.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {})
  }
  const staleCompany = await prisma.company.findUnique({ where: { name: COMPANY_NAME } })
  if (staleCompany !== null) await prisma.company.delete({ where: { id: staleCompany.id } }).catch(() => {})
  const staleTemplate = await prisma.agentTemplate.findUnique({ where: { name: TEMPLATE_NAME } })
  if (staleTemplate !== null) await prisma.agentTemplate.delete({ where: { id: staleTemplate.id } }).catch(() => {})
}

let exitCode = 1
let repoPathA = null
let repoPathB = null
let workspaceIdA = null
let workspaceIdB = null
let templateId = null
let companyId = null
let nextProc = null
let browser = null
let page = null
let diagDir = null

/** Every "M11 Gate"-named row still in the DB, for a FAIL's diagnostic dump -- not scoped to this
 *  run's own tracked ids, since a failure can happen before some of those ids are even set. */
async function dumpOrgRows() {
  const templates = await prisma.agentTemplate.findMany({ where: { name: { contains: 'M11 Gate' } } })
  const companies = await prisma.company.findMany({
    where: { name: { contains: 'M11 Gate' } },
    include: { teams: { include: { agents: { include: { workers: true } } } } },
  })
  const workspaces = await prisma.workspace.findMany({
    where: { name: { contains: 'M11 Gate' } },
    select: {
      id: true,
      name: true,
      companyId: true,
      teams: { select: { id: true, name: true, agents: { select: { id: true, name: true, model: true, companyAgentId: true } } } },
    },
  })
  return JSON.stringify({ templates, companies, workspaces })
}

/** The m8a-estop-style diagnostic dump (brief: "FAIL dumps the page URL, the org rows, and a
 *  screenshot to the scratch dir"), thrown as a plain `Error` so it surfaces as this process's
 *  own uncaught-exception exit (no separate `catch` -- same "all-in-try" shape `gate-m10-org.mjs`
 *  uses, where the only path to `exitCode = 0` is falling off the end of the try block). */
async function fail(message) {
  let screenshotPath = null
  if (page !== null) {
    screenshotPath = join(diagDir, `failure-${Date.now()}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
  }
  const orgDump = await dumpOrgRows().catch((cause) => `<could not dump org rows: ${cause instanceof Error ? cause.message : String(cause)}>`)
  const url = page !== null ? page.url() : '<no page>'
  throw new Error(`${message} -- url=${url} screenshot=${screenshotPath ?? '<none>'} orgRows=${orgDump}`)
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

/** Fills a (possibly not-yet-hydrated) controlled input, verifying the value actually landed --
 *  a `.fill()` that races React's hydration attaching its `onChange` handler leaves the DOM
 *  showing the typed text while the component's own state (and so the eventual POST body) stays
 *  empty; this catches that by reading `.inputValue()` back and retrying until it matches, bounded
 *  by `ACTION_TIMEOUT_MS`. */
async function fillReliably(locator, value, description) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS
  while (Date.now() < deadline) {
    await locator.fill(value)
    if ((await locator.inputValue()) === value) return
    await delay(100)
  }
  await fail(`could not get ${description} to hold the value ${JSON.stringify(value)}`)
}

/** Same hydration-race protection as `fillReliably`, for a `<select>` -- verifies the selected
 *  option's value (not label) actually landed before moving on. */
async function selectReliably(locator, expectedValue, selectOptions, description) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS
  while (Date.now() < deadline) {
    await locator.selectOption(selectOptions)
    if ((await locator.inputValue()) === expectedValue) return
    await delay(100)
  }
  await fail(`could not get ${description} to hold the selected value ${JSON.stringify(expectedValue)}`)
}

/** Clicks `locator`, then bounded-waits (`ACTION_TIMEOUT_MS`) for `predicate` to become true --
 *  the same hydration-race protection as `fillReliably`/`selectReliably`, for clicks: a click
 *  that lands before React's own handler is attached is a silent no-op at the DOM level, not an
 *  error Playwright can see, so a plain single `.click()` + wait can hang on nothing having
 *  happened. Deliberately does NOT re-click on every poll tick -- ordinary request latency (a cold
 *  route compile, a slow POST) is not a hydration race, and re-clicking on every tick would send a
 *  second real click (and so a second real POST) to a button like the model-override editor's
 *  "Set" while its own request is still in flight -- its `disabled={pending}` narrows that window
 *  but does not close it, since the click can still land before `pending` has re-rendered the DOM.
 *  A single retry click fires only once the FULL first wait has been exhausted -- by then a
 *  genuine no-op click is the only remaining explanation -- followed by one more, shorter wait. */
async function clickUntil(locator, predicate, description) {
  for (const waitBudgetMs of [ACTION_TIMEOUT_MS, 5_000]) {
    let clickError = null
    try {
      await locator.click({ timeout: 3000 })
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
  diagDir = mkdtempSync(join(tmpdir(), 'aiteamos-gate-m11-shell-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  const chromiumPath = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- set CHROMIUM_PATH to a real executable (e.g. a playwright-installed ` +
        `chromium under ~/.cache/ms-playwright) before running this gate`,
    )
  }

  await preflightCleanup()

  // 1. Two fresh workspaces -- m10's own stage-1 idiom (real repos, plain `prisma.workspace.create`,
  // no CLI): everything from here on happens entirely through the browser.
  repoPathA = makeRepo('a')
  repoPathB = makeRepo('b')
  const workspaceA = await prisma.workspace.create({
    data: {
      name: `M11 Gate Project A ${runTimestamp}`,
      repoPath: repoPathA,
      autoMerge: true,
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  const workspaceB = await prisma.workspace.create({
    data: {
      name: `M11 Gate Project B ${runTimestamp}`,
      repoPath: repoPathB,
      autoMerge: true,
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  workspaceIdA = workspaceA.id
  workspaceIdB = workspaceB.id
  const workspaceNameA = workspaceA.name
  const workspaceNameB = workspaceB.name
  // The PASS line's `${n} projects` below reads this, not a hardcoded count -- adding a third
  // workspace to this stage keeps the message accurate on its own.
  const projectNames = [workspaceNameA, workspaceNameB]
  console.log(`workspace A: ${workspaceIdA} (${workspaceNameA})`)
  console.log(`workspace B: ${workspaceIdB} (${workspaceNameB})`)

  // 2. Boot the real web shell on a free port.
  const preferredPort = await findFreePort()
  nextProc = spawn('node', ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort)], {
    cwd: repoRoot,
    // M21 A1: the operator's AITEAMOS_PASSWORD must not reach the child, or every page is /login.
    env: loopbackChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let nextOutput = ''
  let nextExited = false
  let resolvedPort = null
  nextProc.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    nextOutput += text
    process.stdout.write(`[next] ${text}`)
    const match = /http:\/\/localhost:(\d+)/.exec(nextOutput)
    if (match) resolvedPort = Number(match[1])
  })
  nextProc.stderr.on('data', (chunk) => process.stderr.write(`[next] ${chunk}`))
  nextProc.on('exit', () => {
    nextExited = true
  })
  nextProc.on('error', (error) => {
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
      throw new Error(`next dev did not become ready within ${NEXT_READY_TIMEOUT_MS}ms -- output so far: ${nextOutput}`)
    }
  }
  const baseUrl = `http://localhost:${resolvedPort}`
  console.log(`next dev ready at ${baseUrl}`)

  // 3. Launch the real browser.
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  page.on('pageerror', (error) => console.error(`[browser:pageerror] ${error}`))

  // ---- Scenario stage 1: /settings -- template, company, team, member, all through the forms.
  await page.goto(`${baseUrl}/settings`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })

  await fillReliably(page.getByLabel('template name'), TEMPLATE_NAME, 'the template name field')
  await fillReliably(page.getByLabel('template role'), 'backend', 'the template role field')
  const templateRow = page.getByTestId('data-table-row').filter({ hasText: TEMPLATE_NAME })
  await clickUntil(page.getByTestId('template-submit'), async () => templateRow.first().isVisible(), `"${TEMPLATE_NAME}" template submit`)
  await waitVisible(templateRow, `the "${TEMPLATE_NAME}" template row`)
  const template = await prisma.agentTemplate.findUnique({ where: { name: TEMPLATE_NAME } })
  if (template === null) await fail(`the "${TEMPLATE_NAME}" row appeared in the browser but is missing from the DB`)
  templateId = template.id
  console.log(`template created and asserted: ${templateId}`)

  await fillReliably(page.getByLabel('company name'), COMPANY_NAME, 'the company name field')
  const companyRow = page.getByTestId('company-row').filter({ hasText: COMPANY_NAME })
  await clickUntil(page.getByTestId('company-submit'), async () => companyRow.first().isVisible(), `"${COMPANY_NAME}" company submit`)
  await waitVisible(companyRow, `the "${COMPANY_NAME}" company row`)
  const company = await prisma.company.findUnique({ where: { name: COMPANY_NAME } })
  if (company === null) await fail(`the "${COMPANY_NAME}" row appeared in the browser but is missing from the DB`)
  companyId = company.id
  console.log(`company created and asserted: ${companyId}`)

  const companyDetail = page.getByTestId('company-detail')
  await clickUntil(companyRow.getByTestId('company-toggle'), async () => companyDetail.first().isVisible(), `expanding the "${COMPANY_NAME}" row`)
  await waitVisible(companyDetail, 'the expanded company detail')

  await fillReliably(companyDetail.getByLabel('team name'), TEAM_NAME, 'the team name field')
  const teamBlock = companyDetail.getByTestId('team-block').filter({ hasText: TEAM_NAME })
  await clickUntil(companyDetail.getByTestId('team-submit'), async () => teamBlock.first().isVisible(), `"${TEAM_NAME}" team submit`)
  await waitVisible(teamBlock, `the "${TEAM_NAME}" team block`)
  const companyTeam = await prisma.companyTeam.findFirst({ where: { companyId, name: TEAM_NAME } })
  if (companyTeam === null) await fail(`the "${TEAM_NAME}" team block appeared in the browser but is missing from the DB`)
  const companyTeamId = companyTeam.id
  console.log(`team created and asserted: ${companyTeamId}`)

  await selectReliably(teamBlock.getByLabel('member template'), templateId, { label: TEMPLATE_NAME }, 'the member template select')
  await fillReliably(teamBlock.getByLabel('member name'), MEMBER_NAME, 'the member name field')
  const memberRowInSettings = teamBlock.getByTestId('data-table-row').filter({ hasText: MEMBER_NAME })
  await clickUntil(teamBlock.getByTestId('member-submit'), async () => memberRowInSettings.first().isVisible(), `"${MEMBER_NAME}" member submit`)
  await waitVisible(memberRowInSettings, `the "${MEMBER_NAME}" member row`)
  const companyAgent = await prisma.companyAgent.findFirst({ where: { companyTeamId, name: MEMBER_NAME } })
  if (companyAgent === null) await fail(`the "${MEMBER_NAME}" row appeared in the browser but is missing from the DB`)
  const companyAgentId = companyAgent.id
  console.log(`member created and asserted: ${companyAgentId}`)
  console.log('stage 1 (/settings) complete: template, company, team and member all created and asserted through the browser')

  // ---- Scenario stage 2: / -- both project cards start "no company"; assign M11 Gate Co to both.
  await page.goto(`${baseUrl}/`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })

  function projectWrapper(name) {
    return page.getByTestId('project-card').filter({ hasText: name })
  }
  async function assertCardBadge(name, expectedBadgeText) {
    const chip = projectWrapper(name).getByTestId('chip').filter({ hasText: expectedBadgeText })
    await waitVisible(chip, `the "${name}" card's "${expectedBadgeText}" badge`)
  }

  await assertCardBadge(workspaceNameA, 'no company')
  await assertCardBadge(workspaceNameB, 'no company')
  console.log('both project cards start with the "no company" badge')

  async function assignCompanyToProject(name) {
    const wrapper = projectWrapper(name)
    const dialog = page.getByTestId('assign-company-dialog')
    await clickUntil(wrapper.getByTestId('assign-company-button'), async () => dialog.first().isVisible(), `"Assign company" on the "${name}" card`)
    await waitVisible(dialog, `the assign-company dialog for "${name}"`)
    const option = dialog.getByTestId('company-option').filter({ hasText: COMPANY_NAME })
    await waitVisible(option, `the "${COMPANY_NAME}" option in the assign dialog`)
    await clickUntil(option, async () => (await option.getAttribute('aria-pressed')) === 'true', `selecting "${COMPANY_NAME}" in the assign dialog`)
    await clickUntil(
      dialog.getByTestId('assign-confirm'),
      async () => !(await dialog.first().isVisible().catch(() => false)),
      `confirming the assign of "${COMPANY_NAME}" to "${name}"`,
    )
  }

  await assignCompanyToProject(workspaceNameA)
  await assertCardBadge(workspaceNameA, COMPANY_NAME)
  await waitVisible(projectWrapper(workspaceNameA).getByTestId('worker-avatar'), `a worker avatar on the "${workspaceNameA}" card`)
  console.log(`"${workspaceNameA}" assigned "${COMPANY_NAME}" and shows a worker avatar`)

  await assignCompanyToProject(workspaceNameB)
  await assertCardBadge(workspaceNameB, COMPANY_NAME)
  await waitVisible(projectWrapper(workspaceNameB).getByTestId('worker-avatar'), `a worker avatar on the "${workspaceNameB}" card`)
  console.log(`"${workspaceNameB}" assigned "${COMPANY_NAME}" and shows a worker avatar`)
  console.log('stage 2 (/) complete: both projects staffed by the same company, asserted through the browser')

  // ---- Scenario stage 3: /agents -- Workers tab lists Gate Worker twice; Roster shows "none".
  await page.goto(`${baseUrl}/agents`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })

  // The Roster tab (the default on load) also renders a `data-table-row` for this member --
  // `AgentsClient` mounts exactly one of `RosterTable`/`WorkersTable` at a time, so a bare
  // `hasText: MEMBER_NAME` row locator is already satisfied before the click below ever fires,
  // and `clickUntil`'s predicate could pass on a no-op click. Requiring the Workers tab's own
  // `aria-selected="true"` closes that gap: that attribute only flips once the click's React
  // handler has actually run.
  const workersTab = page.getByTestId('agents-tab-workers')
  const workerRows = page.getByTestId('data-table-row').filter({ hasText: MEMBER_NAME })
  await clickUntil(
    workersTab,
    async () => (await workersTab.getAttribute('aria-selected')) === 'true' && (await workerRows.first().isVisible()),
    'the Workers tab',
  )
  await waitVisible(workerRows, `a "${MEMBER_NAME}" row in the Workers tab`)
  const workerRowCount = await workerRows.count()
  if (workerRowCount !== 2) {
    await fail(
      `the Workers tab shows ${workerRowCount} "${MEMBER_NAME}" row(s), expected 2 (one per project) -- ` +
        `rows=${JSON.stringify(await workerRows.allTextContents())}`,
    )
  }
  console.log(`Workers tab lists "${MEMBER_NAME}" twice, once per project`)

  const rosterCompanyBlock = page.getByTestId('roster-company').filter({ hasText: COMPANY_NAME })
  await clickUntil(page.getByTestId('agents-tab-roster'), async () => rosterCompanyBlock.first().isVisible(), 'the Roster tab')
  await waitVisible(rosterCompanyBlock, `the "${COMPANY_NAME}" roster block`)
  const rosterTeamBlock = rosterCompanyBlock.getByTestId('roster-team').filter({ hasText: TEAM_NAME })
  await waitVisible(rosterTeamBlock, `the "${TEAM_NAME}" roster team block`)
  const rosterMemberRow = rosterTeamBlock.getByTestId('roster-member').filter({ hasText: MEMBER_NAME })
  await waitVisible(rosterMemberRow, `the "${MEMBER_NAME}" roster member row`)
  const modelSourceChip = rosterMemberRow.getByTestId('chip').filter({ hasText: 'none' })
  await waitVisible(modelSourceChip, `the "${MEMBER_NAME}" member's "none" modelSource chip`)
  console.log(`Roster shows "${MEMBER_NAME}" with modelSource "none"`)
  console.log('stage 3 (/agents) complete: Workers duplicated across both projects, Roster modelSource asserted "none"')

  // ---- Scenario stage 4: set gate-model-x on ONE worker via the Roster's ModelOverrideEditor.
  const memberWorkers = rosterMemberRow.getByTestId('member-workers')
  await clickUntil(rosterMemberRow.getByTestId('roster-member-toggle'), async () => memberWorkers.first().isVisible(), `expanding "${MEMBER_NAME}"`)
  await waitVisible(memberWorkers, `the expanded "${MEMBER_NAME}" workers block`)
  const expandedWorkerRows = memberWorkers.getByTestId('roster-worker-row')
  const expandedWorkerCount = await expandedWorkerRows.count()
  if (expandedWorkerCount !== 2) {
    await fail(
      `"${MEMBER_NAME}"'s expanded workers block shows ${expandedWorkerCount} row(s), expected 2 -- ` +
        `rows=${JSON.stringify(await expandedWorkerRows.allTextContents())}`,
    )
  }
  const targetWorkerRow = expandedWorkerRows.filter({ hasText: workspaceNameA })
  await waitVisible(targetWorkerRow, `the "${workspaceNameA}" worker row under "${MEMBER_NAME}"`)

  // M12 Task 7 made a model and its provider one write; Task 13 threads the provider through this
  // route's body and the Roster editor's own `<select>`, so both go into this worker row together.
  await selectReliably(
    targetWorkerRow.getByLabel('provider'),
    PROVIDER_OVERRIDE,
    { value: PROVIDER_OVERRIDE },
    `the "${workspaceNameA}" worker's provider select`,
  )
  await fillReliably(targetWorkerRow.getByTestId('model-override-input'), MODEL_OVERRIDE, `the "${workspaceNameA}" worker's model override input`)
  const updatedModelText = targetWorkerRow.locator('span.font-mono.text-text-3').filter({ hasText: MODEL_OVERRIDE })
  await clickUntil(
    targetWorkerRow.getByTestId('model-override-set'),
    async () => updatedModelText.first().isVisible(),
    `setting "${MODEL_OVERRIDE}" on the "${workspaceNameA}" worker`,
  )
  await waitVisible(updatedModelText, `the "${workspaceNameA}" worker row reflecting model "${MODEL_OVERRIDE}"`)

  const workerAgentA = await prisma.agent.findFirst({ where: { team: { workspaceId: workspaceIdA }, companyAgentId, name: MEMBER_NAME } })
  const workerAgentB = await prisma.agent.findFirst({ where: { team: { workspaceId: workspaceIdB }, companyAgentId, name: MEMBER_NAME } })
  if (workerAgentA === null || workerAgentB === null) {
    await fail(`could not find both materialized "${MEMBER_NAME}" workers in the DB -- A=${JSON.stringify(workerAgentA)} B=${JSON.stringify(workerAgentB)}`)
  }
  if (workerAgentA.model !== MODEL_OVERRIDE) {
    await fail(`the "${workspaceNameA}" worker's DB model is ${JSON.stringify(workerAgentA.model)}, expected ${JSON.stringify(MODEL_OVERRIDE)}`)
  }
  if (workerAgentA.provider !== PROVIDER_OVERRIDE) {
    await fail(`the "${workspaceNameA}" worker's DB provider is ${JSON.stringify(workerAgentA.provider)}, expected ${JSON.stringify(PROVIDER_OVERRIDE)}`)
  }
  if (workerAgentB.model !== null || workerAgentB.provider !== null) {
    await fail(
      `the "${workspaceNameB}" worker's DB model/provider is ${JSON.stringify(workerAgentB.model)}/${JSON.stringify(workerAgentB.provider)}, ` +
        `expected null/null -- only the "${workspaceNameA}" worker's override was set through the editor`,
    )
  }
  console.log(
    `the DB confirms model ${JSON.stringify(MODEL_OVERRIDE)} and provider ${JSON.stringify(PROVIDER_OVERRIDE)} landed on exactly the "${workspaceNameA}" worker`,
  )
  console.log('stage 4 complete: a worker model+provider override, set through the Roster editor, verified against prisma.agent')

  console.log(`PASS: the shell staffed and steered ${projectNames.length} projects from the browser`)
  exitCode = 0
} finally {
  if (browser !== null) {
    await browser.close().catch(() => {})
  }
  if (nextProc !== null && nextProc.exitCode === null) {
    nextProc.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextProc.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextProc.exitCode === null) nextProc.kill('SIGKILL')
  }
  // FK-ordered cleanup, identical order to `gate-m10-org.mjs`: events, then the workspaces
  // (cascades Team/Agent/Task/AgentRun/...), then the company (cascades CompanyTeam/CompanyAgent
  // -- safe only once no Agent row references a CompanyAgent any more, which the workspace
  // deletes above already guarantee), then the template.
  for (const workspaceId of [workspaceIdA, workspaceIdB]) {
    if (workspaceId !== null) {
      await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    }
  }
  for (const workspaceId of [workspaceIdA, workspaceIdB]) {
    if (workspaceId !== null) {
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
    }
  }
  if (companyId !== null) {
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {})
  }
  if (templateId !== null) {
    await prisma.agentTemplate.delete({ where: { id: templateId } }).catch(() => {})
  }
  if (repoPathA !== null) rmSync(repoPathA, { recursive: true, force: true })
  if (repoPathB !== null) rmSync(repoPathB, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
