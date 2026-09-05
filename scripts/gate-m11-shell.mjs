// M11's own gate (Task 13 brief): "the shell went global -- a company was staffed, assigned, and
// steered entirely from the browser". `gate-m10-org.mjs` proves the org model's verbs the way an
// operator running the CLI would; this script proves the SAME materialization/model-resolution
// machinery the way an operator using the web shell actually would -- a real Chromium
// (`playwright-core`, no test runner) driving a real `next dev` server through `/` (the team
// catalog and the project cards; M24 Task 6 moved the catalog off `/settings` here) and
// `/slaves`, with every assertion a direct `prisma` read, never anything the browser merely
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
//
// Stage 6 (M27 Task 7): the deletes and the archive/restore cycle. `slave-delete`,
// `department-delete`, `archive-project` and `restore-project` are all driven the same way every
// earlier stage drives a control -- a real click through `DangerConfirm` where one applies, then a
// direct `prisma` read, never the browser's own claim.
//
// Stage 7 (M28 Task 5): `/w/<B>/office`, the Office tab. Project B, not A: stage 6's deletes leave
// project A with a department and no slaves at all, so an office opened on it draws an empty floor
// and never renders the focus card. B still holds its materialized worker, and this stage adds one
// more slave row directly with prisma (a fixture, like stage 6a's run fixture) so the floor has two
// slaves -- enough for the focus card's `Next` to actually change who is focused. Same discipline
// as every stage before it: the HUD counts come from a direct `prisma` read taken right before the
// navigation, never a number this script assumes.

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
// cleanup (killed mid-run, etc.) can collide on `SlaveTemplate.name`/`Company.name`/
// `CompanyTeam(companyId,name)`/`CompanySlave(companyTeamId,name)`'s unique constraints --
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
  const dir = mkdtempSync(join(tmpdir(), `slaveofai-gate-m11-shell-${suffix}-`))
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
 *  the `finally` block below uses: workspaces first (cascades Team/Slave), then the company
 *  (cascades CompanyTeam/CompanySlave), then the template. Safe to run against an empty slate --
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
  const staleTemplate = await prisma.slaveTemplate.findUnique({ where: { name: TEMPLATE_NAME } })
  if (staleTemplate !== null) await prisma.slaveTemplate.delete({ where: { id: staleTemplate.id } }).catch(() => {})
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
  const templates = await prisma.slaveTemplate.findMany({ where: { name: { contains: 'M11 Gate' } } })
  const companies = await prisma.company.findMany({
    where: { name: { contains: 'M11 Gate' } },
    include: { teams: { include: { slaves: { include: { workers: true } } } } },
  })
  const workspaces = await prisma.workspace.findMany({
    where: { name: { contains: 'M11 Gate' } },
    select: {
      id: true,
      name: true,
      companyId: true,
      teams: { select: { id: true, name: true, slaves: { select: { id: true, name: true, model: true, companySlaveId: true } } } },
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
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m11-shell-diag-'))
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
    // M21 A1: the operator's SLAVEOFAI_SESSION_SECRET must not reach the child, or every page is /login.
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

  // ---- Scenario stage 1: / -- template, company, team, member, all through the team-catalog
  // forms (M24 Task 6 moved the template catalog and company manager off Settings onto the
  // Projects page, below the project cards -- same testids, new page).
  await page.goto(`${baseUrl}/`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('team-catalog'), 'the Projects page team catalog')

  await fillReliably(page.getByLabel('template name'), TEMPLATE_NAME, 'the template name field')
  await fillReliably(page.getByLabel('template role'), 'backend', 'the template role field')
  const templateRow = page.getByTestId('data-table-row').filter({ hasText: TEMPLATE_NAME })
  await clickUntil(page.getByTestId('template-submit'), async () => templateRow.first().isVisible(), `"${TEMPLATE_NAME}" template submit`)
  await waitVisible(templateRow, `the "${TEMPLATE_NAME}" template row`)
  const template = await prisma.slaveTemplate.findUnique({ where: { name: TEMPLATE_NAME } })
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

  await fillReliably(companyDetail.getByLabel('department name'), TEAM_NAME, 'the department template name field')
  const teamBlock = companyDetail.getByTestId('department-template-block').filter({ hasText: TEAM_NAME })
  await clickUntil(companyDetail.getByTestId('department-template-submit'), async () => teamBlock.first().isVisible(), `"${TEAM_NAME}" department template submit`)
  await waitVisible(teamBlock, `the "${TEAM_NAME}" department template block`)
  const companyTeam = await prisma.companyTeam.findFirst({ where: { companyId, name: TEAM_NAME } })
  if (companyTeam === null) await fail(`the "${TEAM_NAME}" department template block appeared in the browser but is missing from the DB`)
  const companyTeamId = companyTeam.id
  console.log(`team created and asserted: ${companyTeamId}`)

  await selectReliably(teamBlock.getByLabel('member template'), templateId, { label: TEMPLATE_NAME }, 'the member template select')
  await fillReliably(teamBlock.getByLabel('member name'), MEMBER_NAME, 'the member name field')
  const memberRowInSettings = teamBlock.getByTestId('data-table-row').filter({ hasText: MEMBER_NAME })
  await clickUntil(teamBlock.getByTestId('member-submit'), async () => memberRowInSettings.first().isVisible(), `"${MEMBER_NAME}" member submit`)
  await waitVisible(memberRowInSettings, `the "${MEMBER_NAME}" member row`)
  const companySlave = await prisma.companySlave.findFirst({ where: { companyTeamId, name: MEMBER_NAME } })
  if (companySlave === null) await fail(`the "${MEMBER_NAME}" row appeared in the browser but is missing from the DB`)
  const companySlaveId = companySlave.id
  console.log(`member created and asserted: ${companySlaveId}`)
  console.log('stage 1 (/) complete: template, company, team and member all created and asserted through the browser')

  // The member is not yet materialized into any project -- the Slaves page's one table (M24
  // §5.3) shows exactly one catalog-only row for it, `slave-project` reading "—".
  await page.goto(`${baseUrl}/slaves`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  const catalogRow = page.getByTestId('data-table-row').filter({ hasText: MEMBER_NAME })
  await waitVisible(catalogRow, `a catalog-only "${MEMBER_NAME}" row before any project is assigned`)
  const catalogRowCount = await catalogRow.count()
  if (catalogRowCount !== 1) {
    await fail(`the Slaves table shows ${catalogRowCount} "${MEMBER_NAME}" row(s) before assignment, expected exactly 1 (catalog-only)`)
  }
  const catalogProjectCell = catalogRow.getByTestId('slave-project')
  const catalogProjectText = (await catalogProjectCell.first().textContent())?.trim()
  if (catalogProjectText !== '—') {
    await fail(`the unmaterialized "${MEMBER_NAME}" row's project cell reads ${JSON.stringify(catalogProjectText)}, expected "—"`)
  }
  console.log(`"${MEMBER_NAME}" shows as one catalog-only row (project "—") before any project has it`)

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
  await waitVisible(projectWrapper(workspaceNameA).getByTestId('avatar-tile'), `a worker avatar on the "${workspaceNameA}" card`)
  console.log(`"${workspaceNameA}" assigned "${COMPANY_NAME}" and shows a worker avatar`)

  await assignCompanyToProject(workspaceNameB)
  await assertCardBadge(workspaceNameB, COMPANY_NAME)
  await waitVisible(projectWrapper(workspaceNameB).getByTestId('avatar-tile'), `a worker avatar on the "${workspaceNameB}" card`)
  console.log(`"${workspaceNameB}" assigned "${COMPANY_NAME}" and shows a worker avatar`)
  console.log('stage 2 (/) complete: both projects staffed by the same company, asserted through the browser')

  // The project header's `budget` chip (M24 §2.2 -- the guardrail block's old budget figure moved
  // here): reachable on any project page now, asserted on workspace A.
  await page.goto(`${baseUrl}/w/${workspaceIdA}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('project-header'), `the "${workspaceNameA}" project header`)
  await waitVisible(page.getByTestId('budget'), "the header's budget figure")
  console.log(`the "${workspaceNameA}" project header shows a budget figure`)

  // ---- Scenario stage 3: /slaves -- the one table lists Gate Worker materialized in both projects.
  await page.goto(`${baseUrl}/slaves`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })

  // `slaves-tab-slaves` is the default tab, but the click below is kept anyway (idempotent on an
  // already-selected tab) -- requiring its own `aria-selected="true"` is what makes this stage
  // assert the tab rather than assume which one happened to already be selected.
  const slavesTab = page.getByTestId('slaves-tab-slaves')
  const memberRows = page.getByTestId('data-table-row').filter({ hasText: MEMBER_NAME })
  await clickUntil(
    slavesTab,
    async () => (await slavesTab.getAttribute('aria-selected')) === 'true' && (await memberRows.first().isVisible()),
    'the Slaves tab',
  )
  await waitVisible(memberRows, `a "${MEMBER_NAME}" row in the Slaves table`)
  const memberRowCount = await memberRows.count()
  if (memberRowCount !== 2) {
    await fail(
      `the Slaves table shows ${memberRowCount} "${MEMBER_NAME}" row(s), expected 2 (one per project) -- ` +
        `rows=${JSON.stringify(await memberRows.allTextContents())}`,
    )
  }
  console.log(`the Slaves table lists "${MEMBER_NAME}" twice, once per project`)

  for (const workspaceName of [workspaceNameA, workspaceNameB]) {
    const row = memberRows.filter({ hasText: workspaceName })
    await waitVisible(row, `the "${MEMBER_NAME}" row for project "${workspaceName}"`)
    const projectText = (await row.getByTestId('slave-project').first().textContent())?.trim()
    if (projectText !== workspaceName) {
      await fail(
        `the "${MEMBER_NAME}" row's project cell reads ${JSON.stringify(projectText)}, expected ${JSON.stringify(workspaceName)} -- ` +
          'materialization must name the row\'s own project, not the catalog "—"',
      )
    }
  }
  console.log(`each "${MEMBER_NAME}" row's project cell now names its own project`)

  // `ModelSelect` renders a plain (disabled) `<select data-testid="model-select">` -- not the
  // free-text `model-override-input` -- until a provider is chosen (M25 §5.3); reading the input
  // here, before `ModelOverrideEditor`'s own provider select has a value, would read an element
  // that does not exist yet.
  const modelSelectBeforeProvider = memberRows.first().getByTestId('model-select')
  await waitVisible(modelSelectBeforeProvider, `"${MEMBER_NAME}"'s model select before any provider is chosen`)
  if (!(await modelSelectBeforeProvider.isDisabled())) {
    await fail(`"${MEMBER_NAME}"'s model select is not disabled before any provider is chosen`)
  }
  const modelSelectValueBeforeProvider = await modelSelectBeforeProvider.inputValue()
  if (modelSelectValueBeforeProvider !== '') {
    await fail(`"${MEMBER_NAME}"'s model select reads ${JSON.stringify(modelSelectValueBeforeProvider)}, expected "" (no override set yet)`)
  }
  console.log(`"${MEMBER_NAME}" carries no model override yet -- the disabled model-select reads empty (no provider chosen)`)
  console.log('stage 3 (/slaves) complete: the one table shows the member materialized in both projects, with no override set')

  // ---- Scenario stage 4: set gate-model-x on ONE worker via the Slaves table's ModelOverrideEditor.
  const targetWorkerRow = memberRows.filter({ hasText: workspaceNameA })
  await waitVisible(targetWorkerRow, `the "${workspaceNameA}" row for "${MEMBER_NAME}"`)

  // M12 Task 7 made a model and its provider one write; Task 13 threads the provider through this
  // route's body and the editor's own `<select>`, so both go into this worker row together.
  await selectReliably(
    targetWorkerRow.getByLabel('provider'),
    PROVIDER_OVERRIDE,
    { value: PROVIDER_OVERRIDE },
    `the "${workspaceNameA}" worker's provider select`,
  )
  // The model field only becomes the free-text `model-override-input` after picking `other…` in
  // the provider's own `model-select` (M25 §5.3) -- mirrors `model-select.test.tsx`'s helper.
  await waitVisible(targetWorkerRow.getByTestId('model-select'), `the "${workspaceNameA}" worker's model select after choosing a provider`)
  await targetWorkerRow.getByTestId('model-select').selectOption('__other__')
  await waitVisible(targetWorkerRow.getByTestId('model-override-input'), `the "${workspaceNameA}" worker's model override input after choosing "other…"`)
  await fillReliably(targetWorkerRow.getByTestId('model-override-input'), MODEL_OVERRIDE, `the "${workspaceNameA}" worker's model override input`)
  // The table's own row no longer carries a separate display node for the saved model (M24 Task
  // 7, Errata: the chain-source chips left with the table) -- `clickUntil`'s predicate reads
  // straight from Prisma instead, the same "the click actually did something" proof this gate
  // uses everywhere else a click's visible feedback is otherwise ambiguous.
  await clickUntil(
    targetWorkerRow.getByTestId('model-override-set'),
    async () => {
      const slave = await prisma.slave.findFirst({ where: { team: { workspaceId: workspaceIdA }, companySlaveId, name: MEMBER_NAME } })
      return slave?.model === MODEL_OVERRIDE && slave?.provider === PROVIDER_OVERRIDE
    },
    `setting "${MODEL_OVERRIDE}" on the "${workspaceNameA}" worker`,
  )

  const workerSlaveA = await prisma.slave.findFirst({ where: { team: { workspaceId: workspaceIdA }, companySlaveId, name: MEMBER_NAME } })
  const workerSlaveB = await prisma.slave.findFirst({ where: { team: { workspaceId: workspaceIdB }, companySlaveId, name: MEMBER_NAME } })
  if (workerSlaveA === null || workerSlaveB === null) {
    await fail(`could not find both materialized "${MEMBER_NAME}" workers in the DB -- A=${JSON.stringify(workerSlaveA)} B=${JSON.stringify(workerSlaveB)}`)
  }
  if (workerSlaveA.model !== MODEL_OVERRIDE) {
    await fail(`the "${workspaceNameA}" worker's DB model is ${JSON.stringify(workerSlaveA.model)}, expected ${JSON.stringify(MODEL_OVERRIDE)}`)
  }
  if (workerSlaveA.provider !== PROVIDER_OVERRIDE) {
    await fail(`the "${workspaceNameA}" worker's DB provider is ${JSON.stringify(workerSlaveA.provider)}, expected ${JSON.stringify(PROVIDER_OVERRIDE)}`)
  }
  if (workerSlaveB.model !== null || workerSlaveB.provider !== null) {
    await fail(
      `the "${workspaceNameB}" worker's DB model/provider is ${JSON.stringify(workerSlaveB.model)}/${JSON.stringify(workerSlaveB.provider)}, ` +
        `expected null/null -- only the "${workspaceNameA}" worker's override was set through the editor`,
    )
  }
  console.log(
    `the DB confirms model ${JSON.stringify(MODEL_OVERRIDE)} and provider ${JSON.stringify(PROVIDER_OVERRIDE)} landed on exactly the "${workspaceNameA}" worker`,
  )
  console.log('stage 4 complete: a worker model+provider override, set through the Slaves table editor, verified against prisma.slave')

  // ---- Scenario stage 5: move the "workspaceNameA" worker to a second department of the same
  // project through the Slaves table's own `slave-department` select (M25 §4.1). The second
  // department is created directly with `prisma.team.create` (the row `POST /api/w/:id/teams`
  // itself creates) rather than through the browser, then the page is reloaded so the row's
  // options (server-rendered `departmentsByWorkspace`) include it.
  const otherDepartment = await prisma.team.create({ data: { workspaceId: workspaceIdA, name: 'M11 Gate Other Dept' } })
  console.log(`created a second "${workspaceNameA}" department directly: ${otherDepartment.id}`)
  await page.reload({ waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(memberRows, `a "${MEMBER_NAME}" row after reload`)
  const targetDeptRow = memberRows.filter({ hasText: workspaceNameA })
  await waitVisible(targetDeptRow, `the "${workspaceNameA}" row for "${MEMBER_NAME}" after reload`)
  await selectReliably(
    targetDeptRow.getByTestId('slave-department'),
    otherDepartment.id,
    { value: otherDepartment.id },
    `the "${workspaceNameA}" worker's department select`,
  )
  const movedSlave = await prisma.slave.findFirst({ where: { team: { workspaceId: workspaceIdA }, companySlaveId, name: MEMBER_NAME } })
  if (movedSlave === null || movedSlave.teamId !== otherDepartment.id) {
    await fail(
      `"${MEMBER_NAME}"'s teamId is ${JSON.stringify(movedSlave?.teamId)}, expected ${JSON.stringify(otherDepartment.id)} ` +
        `after moving it to "M11 Gate Other Dept" through the Slaves table`,
    )
  }
  console.log(`stage 5 complete: "${MEMBER_NAME}" moved to a second "${workspaceNameA}" department, verified against prisma.slave`)

  // ---- Scenario stage 6a: delete the moved slave through the Slaves table's `slave-delete` ->
  // `slave-delete-confirm` (M27 §4.1). A terminal `SlaveRun` fixture is created directly (this
  // gate never runs the orchestrator, so the worker otherwise carries no run history) so "its
  // runs are gone" below proves the delete's cascade rather than a count that was already zero.
  const movedSlaveRun = await prisma.slaveRun.create({ data: { slaveId: movedSlave.id, status: 'succeeded' } })
  console.log(`created a terminal run fixture directly for "${MEMBER_NAME}" (${workspaceNameA}): ${movedSlaveRun.id}`)

  const deleteSlaveRow = memberRows.filter({ hasText: workspaceNameA })
  await waitVisible(deleteSlaveRow, `the "${workspaceNameA}" row for "${MEMBER_NAME}" before deleting it`)
  await clickUntil(
    deleteSlaveRow.getByTestId('slave-delete'),
    async () => deleteSlaveRow.getByTestId('slave-delete-confirm').isVisible(),
    `opening the delete confirm on the "${workspaceNameA}" "${MEMBER_NAME}" row`,
  )
  await clickUntil(
    deleteSlaveRow.getByTestId('slave-delete-confirm'),
    async () => (await prisma.slave.findUnique({ where: { id: movedSlave.id } })) === null,
    `confirming the delete of the "${workspaceNameA}" "${MEMBER_NAME}" row`,
  )
  const deletedSlave = await prisma.slave.findUnique({ where: { id: movedSlave.id } })
  if (deletedSlave !== null) await fail(`"${MEMBER_NAME}"'s slave row (${movedSlave.id}) still exists after slave-delete-confirm`)
  const deletedSlaveRuns = await prisma.slaveRun.findMany({ where: { slaveId: movedSlave.id } })
  if (deletedSlaveRuns.length !== 0) {
    await fail(`"${MEMBER_NAME}"'s runs were not deleted along with its slave row -- ${JSON.stringify(deletedSlaveRuns)}`)
  }
  // The DB delete is already committed (asserted above) by the time `router.refresh()`'s own RSC
  // round trip lands in the DOM -- a bounded poll, not a bare count, the same hydration-race
  // shape every `clickUntil` predicate in this file already accounts for.
  let remainingMemberRowCount = await memberRows.count()
  {
    const deadline = Date.now() + ACTION_TIMEOUT_MS
    while (remainingMemberRowCount !== 1 && Date.now() < deadline) {
      await delay(100)
      remainingMemberRowCount = await memberRows.count()
    }
  }
  if (remainingMemberRowCount !== 1) {
    await fail(
      `the Slaves table shows ${remainingMemberRowCount} "${MEMBER_NAME}" row(s) after deleting the "${workspaceNameA}" one, expected exactly 1 (the "${workspaceNameB}" row)`,
    )
  }
  console.log(`deleted "${MEMBER_NAME}"'s "${workspaceNameA}" slave row and its run history through slave-delete -- verified against prisma`)

  // ---- Scenario stage 6b: delete the second department through the Departments tab's
  // `department-delete` -> `department-delete-confirm` (M27 §4.2). Its one slave is already gone
  // (deleted above), so this is a plain cascade with no live-run refusal to work around.
  const departmentsTab = page.getByTestId('slaves-tab-departments')
  const otherDeptRow = page.getByTestId('data-table-row').filter({ hasText: 'M11 Gate Other Dept' })
  await clickUntil(
    departmentsTab,
    async () => (await departmentsTab.getAttribute('aria-selected')) === 'true' && (await otherDeptRow.first().isVisible()),
    'the Departments tab',
  )
  await waitVisible(otherDeptRow, 'the "M11 Gate Other Dept" department row')
  await clickUntil(
    otherDeptRow.getByTestId('department-delete'),
    async () => otherDeptRow.getByTestId('department-delete-confirm').isVisible(),
    'opening the delete confirm on "M11 Gate Other Dept"',
  )
  await clickUntil(
    otherDeptRow.getByTestId('department-delete-confirm'),
    async () => (await prisma.team.findUnique({ where: { id: otherDepartment.id } })) === null,
    'confirming the delete of "M11 Gate Other Dept"',
  )
  const deletedDepartment = await prisma.team.findUnique({ where: { id: otherDepartment.id } })
  if (deletedDepartment !== null) await fail(`"M11 Gate Other Dept" (${otherDepartment.id}) still exists after department-delete-confirm`)
  console.log('deleted the "M11 Gate Other Dept" department through department-delete -- verified against prisma')

  // ---- Scenario stage 6c: archive project A through its own Settings danger zone
  // (`archive-project` -> `archive-project-confirm`, landing back on "/"), confirm the card
  // disappears from the default (no `?archived=1`) list, reappears with the `project-archived`
  // chip once `show-archived` is checked, then restore it from that same card (M27 spec §§3.3-3.4).
  await page.goto(`${baseUrl}/w/${workspaceIdA}/settings`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('archive-project'), `the "${workspaceNameA}" project's archive-project button`)
  await clickUntil(
    page.getByTestId('archive-project'),
    async () => page.getByTestId('archive-project-confirm').isVisible(),
    `opening the archive confirm for "${workspaceNameA}"`,
  )
  await clickUntil(
    page.getByTestId('archive-project-confirm'),
    async () => page.url() === `${baseUrl}/`,
    `confirming the archive of "${workspaceNameA}"`,
  )
  const archivedWorkspaceA = await prisma.workspace.findUnique({ where: { id: workspaceIdA }, select: { archivedAt: true } })
  if (archivedWorkspaceA === null || archivedWorkspaceA.archivedAt === null) {
    await fail(`"${workspaceNameA}"'s archivedAt is still null after archive-project-confirm -- ${JSON.stringify(archivedWorkspaceA)}`)
  }
  console.log(`archived "${workspaceNameA}" through archive-project-confirm and landed back on "/" -- verified against prisma`)

  await waitVisible(projectWrapper(workspaceNameB), `the still-active "${workspaceNameB}" card`)
  const hiddenCardCount = await projectWrapper(workspaceNameA).count()
  if (hiddenCardCount !== 0) {
    await fail(`the archived "${workspaceNameA}" card is still visible on "/" with ?archived=1 not set -- count=${hiddenCardCount}`)
  }
  console.log(`the archived "${workspaceNameA}" card is absent from "/" with ?archived=1 not set`)

  await clickUntil(
    page.getByTestId('show-archived'),
    async () => projectWrapper(workspaceNameA).first().isVisible(),
    'the "show archived" checkbox',
  )
  await waitVisible(
    projectWrapper(workspaceNameA).getByTestId('project-archived'),
    `the "${workspaceNameA}" card's "archived" chip after checking "show archived"`,
  )
  console.log(`checking "show archived" reveals the "${workspaceNameA}" card with its "archived" chip`)

  await clickUntil(
    projectWrapper(workspaceNameA).getByTestId('restore-project'),
    async () => {
      const workspace = await prisma.workspace.findUnique({ where: { id: workspaceIdA }, select: { archivedAt: true } })
      return workspace?.archivedAt === null
    },
    `restoring "${workspaceNameA}" from its project card`,
  )
  const restoredWorkspaceA = await prisma.workspace.findUnique({ where: { id: workspaceIdA }, select: { archivedAt: true } })
  if (restoredWorkspaceA === null || restoredWorkspaceA.archivedAt !== null) {
    await fail(`"${workspaceNameA}"'s archivedAt is not null after restore-project -- ${JSON.stringify(restoredWorkspaceA)}`)
  }
  console.log(`restored "${workspaceNameA}" through restore-project on its card -- verified against prisma`)
  console.log(
    'stage 6 complete: slave-delete (+ its run history), department-delete, archive-project and restore-project all verified against prisma',
  )

  // ---- Scenario stage 7: /w/<B>/office -- the Office tab (M28 §9) draws project B's departments
  // and slaves from the same rows the Slaves table showed, the HUD counts match prisma, the canvas
  // has painted, and the focus card cycles through the roster.
  //
  // Project B, not A. Project A's roster at this point is a department with nothing in it: the
  // materialized "Crew" department survives stage 6, but the one slave ever in it ("Gate Worker")
  // was deleted in stage 6a after being moved into "M11 Gate Other Dept", which stage 6b then
  // deleted too. An empty floor draws (that is `office-client.test.tsx`'s empty-roster case) but
  // renders no focus card and nothing to click Next on, so the browser gate would never exercise
  // either. Project B is still active and still holds its materialized "Gate Worker"; one more
  // slave row is created here directly with prisma -- a fixture, exactly like stage 6a's
  // `prisma.slaveRun.create` -- so the floor carries two slaves and the Next click has somewhere
  // to go. Workspace B is deleted (cascading Team/Slave) by this script's own cleanup, so the
  // fixture needs no cleanup of its own.
  const officeDepartmentB = await prisma.team.findFirst({ where: { workspaceId: workspaceIdB } })
  if (officeDepartmentB === null) await fail(`"${workspaceNameB}" has no department to add the office fixture slave to`)
  const officeFixtureSlave = await prisma.slave.create({
    data: { teamId: officeDepartmentB.id, name: 'M11 Gate Second Slave', role: 'qa' },
  })
  console.log(`created a second "${workspaceNameB}" slave directly for the office floor: ${officeFixtureSlave.id}`)

  const officeDepartments = await prisma.team.count({ where: { workspaceId: workspaceIdB } })
  const officeSlaves = await prisma.slave.count({ where: { team: { workspaceId: workspaceIdB } } })
  // The branches below still cover every roster size (this script never assumes a count it did not
  // read), but with the fixture above the run must take the `> 1` one -- anything less means the
  // fixture or the materialization did not land, and the Next-cycle assertion would be skipped
  // silently rather than failing.
  if (officeSlaves < 2) {
    await fail(`"${workspaceNameB}" has ${officeSlaves} slave(s) on the office floor, expected at least 2 (its worker plus the fixture)`)
  }
  await page.goto(`${baseUrl}/w/${workspaceIdB}/office`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('office-canvas'), 'the office canvas')
  const expectedCounts = `${officeDepartments} department${officeDepartments === 1 ? '' : 's'} · ${officeSlaves} slave${officeSlaves === 1 ? '' : 's'} · 0 working`
  {
    const deadline = Date.now() + ACTION_TIMEOUT_MS
    let counts = await page.getByTestId('office-hud-counts').textContent()
    while (counts !== expectedCounts && Date.now() < deadline) {
      await delay(100)
      counts = await page.getByTestId('office-hud-counts').textContent()
    }
    if (counts !== expectedCounts) await fail(`office HUD counts read ${JSON.stringify(counts)}, expected ${JSON.stringify(expectedCounts)}`)
  }
  console.log(`the office HUD counts read "${expectedCounts}" -- verified against prisma`)

  // The office draws the floor only after `document.fonts.load` resolves, so poll `getImageData`
  // for the painted state within `ACTION_TIMEOUT_MS` rather than sampling the canvas once.
  let painted = { width: 0, height: 0, painted: false }
  {
    const deadline = Date.now() + ACTION_TIMEOUT_MS
    while (!painted.painted && Date.now() < deadline) {
      painted = await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="office-canvas"]')
        if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0 || canvas.height === 0) return { width: 0, height: 0, painted: false }
        const ctx = canvas.getContext('2d')
        if (ctx === null) return { width: canvas.width, height: canvas.height, painted: false }
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
        let lit = 0
        for (let i = 0; i < data.length; i += 4 * 97) if (data[i] + data[i + 1] + data[i + 2] > 60) lit++
        return { width: canvas.width, height: canvas.height, painted: lit > 20 }
      })
      if (!painted.painted) await delay(100)
    }
  }
  if (!painted.painted) await fail(`the office canvas (${painted.width}x${painted.height}) has not painted the floor`)
  console.log(`the office canvas (${painted.width}x${painted.height}) painted the floor`)

  if (officeSlaves === 0) {
    const focusCardCount = await page.getByTestId('office-focus').count()
    if (focusCardCount !== 0) await fail(`the office focus card is present with zero slaves in "${workspaceNameB}" -- expected none`)
    console.log(
      `stage 7 complete: /w/${workspaceIdB}/office painted ${officeDepartments} department(s) and 0 slaves, counts matched prisma; no focus ` +
        'card with an empty roster, so the Next-cycle was not asserted',
    )
  } else {
    await waitVisible(page.getByTestId('office-focus'), 'the office focus card')
    const firstFocus = await page.getByTestId('office-focus').textContent()
    if (officeSlaves > 1) {
      await clickUntil(
        page.getByTestId('office-focus-next'),
        async () => (await page.getByTestId('office-focus').textContent()) !== firstFocus,
        'cycling the office focus card with Next',
      )
      console.log(
        `stage 7 complete: /w/${workspaceIdB}/office painted ${officeDepartments} department(s) and ${officeSlaves} slaves (the materialized ` +
          'worker plus the fixture), counts matched prisma, the focus card cycled with Next',
      )
    } else {
      console.log(
        `stage 7 complete: /w/${workspaceIdB}/office painted ${officeDepartments} department(s) and 1 slave, counts matched prisma; only one ` +
          'slave, so Next has nowhere to cycle to and was not asserted to change the focus',
      )
    }
  }

  console.log(`PASS: the shell staffed and steered ${projectNames.length} projects from the browser, then deleted and archived/restored through it`)
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
  // (cascades Team/Slave/Task/SlaveRun/...), then the company (cascades CompanyTeam/CompanySlave
  // -- safe only once no Slave row references a CompanySlave any more, which the workspace
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
    await prisma.slaveTemplate.delete({ where: { id: templateId } }).catch(() => {})
  }
  if (repoPathA !== null) rmSync(repoPathA, { recursive: true, force: true })
  if (repoPathB !== null) rmSync(repoPathB, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
