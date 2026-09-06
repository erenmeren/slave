// M29's own gate (Task 11 brief): a real Chromium (`playwright-core`, no test runner) driving a
// real `next dev` server drives the SAME control-layer machinery an operator using the web shell
// would -- create a simulation from a catalog company on `/sim`, run it to its horizon on
// `/sim/<id>`, and check every number the page shows against a direct `prisma` read or a
// control-layer computation, never against what the browser merely claims. Shape borrowed
// verbatim from `gate-m11-shell.mjs`: dist imports, `findFreePort`, the `next dev` spawn + ready
// wait, Chromium from `CHROMIUM_PATH` (falling back to `/usr/bin/chromium`), everything created
// inside `try`, `finally` kills every process this script spawned and cleans up in FK order,
// `exitCode` starts at 1 and is only set to 0 at the very end of a fully-asserted run, a FAIL
// dumps the page's URL, every "M29 Gate"-named row still in the DB, and a full-page screenshot
// into a scratch directory this script creates and prints the path to.
//
// Stage 1 (the company): a template and a four-department/four-slave roster (sales, purchasing,
// operations, finance -- the trade sector's own role names) created directly with `prisma`, the
// m10/m11 stage-1 idiom -- everything from here on happens entirely through the browser.
//
// Stages 2-3 (`gate A`, policy A): the `/sim` drawer creates a run; a `prisma` read confirms the
// frozen definition and the fresh state before a single day has run; `/sim/<id>` runs it to day
// 30, and the page's metrics are checked two ways -- `replaySimulation` (control dist) says the
// stored state still matches a fresh re-run of the same journal, and `tradeMetrics` (simulation
// dist), computed from the SAME journal `loadSimulation` reads, is compared to the page's own
// rendered numbers, money formatted through the identical `Intl.NumberFormat` call the page uses.
//
// Stage 4: the rules provider spends no model call, ever -- `SimulationModelUsage` stays at zero
// rows and the page's own "Model usage (real)" panel says so.
//
// Stage 5 (`gate B`, policy B): the same three stages again, but this run hedges with the fast
// supplier when the normal one is delayed (spec §5.4, Task 4's ruling) -- its late days come out
// at zero where A's does not, and its purchase cost comes out higher than A's, both read from the
// DB and cross-checked against the page.
//
// Stage 6: the finished run's `sim-step` stays disabled (nothing more to step), and the pre-
// existing software flow is untouched -- the seeded workspace's Overview still renders its own
// slave cards, one per `prisma.slave` row, completely unrelated to anything this gate created.
//
// Stage 7 (cleanup, in `finally`): delete the two runs (a `SimulationRun` blocks its `Company`
// from deleting while it exists -- `onDelete: Restrict`), then the company (cascades
// `CompanyTeam`/`CompanySlave`), then the template.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { chromium } from 'playwright-core'
import { prisma } from '../packages/db/dist/client.js'
import { SEED_WORKSPACE_ID } from '../packages/db/dist/seed-workspace-id.js'
import { loadSimulation, replaySimulation } from '../packages/control/dist/simulation.js'
import { tradeMetrics } from '../packages/simulation/dist/index.js'

const ACTION_TIMEOUT_MS = 20_000
const NEXT_READY_TIMEOUT_MS = 60_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// Exact literals, never suffixed -- these are typed into real form fields the way an operator
// would type them, and the two rows created directly with prisma (the company and its template)
// follow the same m11 convention. `preflightCleanup` removes any leftovers a prior crashed run
// left on these exact names before this run creates its own.
const TEMPLATE_NAME = 'M29 Gate Clerk'
const COMPANY_NAME = 'M29 Gate Trading'
const ROSTER = [
  ['Sales', 'Gate Sonia'],
  ['Purchasing', 'Gate Pete'],
  ['Operations', 'Gate Olga'],
  ['Finance', 'Gate Fin'],
]
const SIM_NAME_A = 'gate A'
const SIM_NAME_B = 'gate B'
const SEED = 5

/** Same currency formatting the run page uses (`apps/web/src/lib/money.ts`'s `formatMinor`) --
 *  reproduced here rather than imported, since `apps/web` is a Next app, not a package with a
 *  `dist` this script can import from; the two are kept identical by inspection, not by sharing
 *  code. */
function formatMinor(minor, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100)
}

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

/** Removes any "M29 Gate"-named rows a prior interrupted run left behind, in the same FK order
 *  the `finally` block below uses: a company's simulation runs first (`onDelete: Restrict` on
 *  `SimulationRun.company` blocks the company delete while any exist), then the company
 *  (cascades `CompanyTeam`/`CompanySlave`), then the template. Safe to run against an empty
 *  slate -- every step is a no-op when nothing matches. */
async function preflightCleanup() {
  const staleCompany = await prisma.company.findUnique({ where: { name: COMPANY_NAME } })
  if (staleCompany !== null) {
    await prisma.simulationRun.deleteMany({ where: { companyId: staleCompany.id } }).catch(() => {})
    await prisma.company.delete({ where: { id: staleCompany.id } }).catch(() => {})
  }
  const staleTemplate = await prisma.slaveTemplate.findUnique({ where: { name: TEMPLATE_NAME } })
  if (staleTemplate !== null) await prisma.slaveTemplate.delete({ where: { id: staleTemplate.id } }).catch(() => {})
}

let exitCode = 1
let templateId = null
let companyId = null
let simulationIdA = null
let simulationIdB = null
let nextProc = null
let browser = null
let page = null
let diagDir = null

/** Every "M29 Gate"-named row still in the DB, for a FAIL's diagnostic dump -- not scoped to this
 *  run's own tracked ids, since a failure can happen before some of those ids are even set. */
async function dumpSimRows() {
  const templates = await prisma.slaveTemplate.findMany({ where: { name: { contains: 'M29 Gate' } } })
  const companies = await prisma.company.findMany({
    where: { name: { contains: 'M29 Gate' } },
    include: { teams: { include: { slaves: true } }, simulations: { select: { id: true, name: true, status: true, simTime: true, version: true } } },
  })
  return JSON.stringify({ templates, companies })
}

/** The m8a-estop-style diagnostic dump: FAIL dumps the page URL, every M29-Gate row still in the
 *  DB, and a screenshot to the scratch dir, then throws so this process exits non-zero. */
async function fail(message) {
  let screenshotPath = null
  if (page !== null) {
    screenshotPath = join(diagDir, `failure-${Date.now()}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
  }
  const simDump = await dumpSimRows().catch((cause) => `<could not dump sim rows: ${cause instanceof Error ? cause.message : String(cause)}>`)
  const url = page !== null ? page.url() : '<no page>'
  throw new Error(`${message} -- url=${url} screenshot=${screenshotPath ?? '<none>'} simRows=${simDump}`)
}

async function waitVisible(locator, description) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
  } catch {
    await fail(`timed out waiting for ${description} to become visible`)
  }
}

/** Fills a (possibly not-yet-hydrated) controlled input, verifying the value actually landed --
 *  see `gate-m11-shell.mjs`'s identical helper for the hydration-race it guards against. */
async function fillReliably(locator, value, description) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS
  while (Date.now() < deadline) {
    await locator.fill(value)
    if ((await locator.inputValue()) === value) return
    await delay(100)
  }
  await fail(`could not get ${description} to hold the value ${JSON.stringify(value)}`)
}

async function selectReliably(locator, expectedValue, selectOptions, description) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS
  while (Date.now() < deadline) {
    await locator.selectOption(selectOptions)
    if ((await locator.inputValue()) === expectedValue) return
    await delay(100)
  }
  await fail(`could not get ${description} to hold the selected value ${JSON.stringify(expectedValue)}`)
}

/** Clicks `locator`, then bounded-waits for `predicate` -- see `gate-m11-shell.mjs`'s identical
 *  helper for why a plain click + wait can silently no-op on a hydration race. */
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

/** Reads the run's own journal + sector state the same way the control layer does
 *  (`loadSimulation`, a `prisma`-backed read), then computes `tradeMetrics` from them -- the
 *  control-layer computation this gate compares the page against, never the page's own claim
 *  alone. */
async function computeMetrics(simulationId) {
  const loaded = await loadSimulation(simulationId)
  if (!loaded.ok) throw new Error(`loadSimulation(${simulationId}) refused: ${JSON.stringify(loaded.error)}`)
  const rows = await prisma.simulationJournalEntry.findMany({ where: { simulationId }, orderBy: { seq: 'asc' } })
  const entries = rows.map((r) => ({ seq: r.seq, simTime: r.simTime, kind: r.kind, actorRole: r.actorRole, payload: r.payload }))
  const metrics = tradeMetrics(entries, loaded.value.state.sector)
  return { metrics, currency: loaded.value.definition.currency }
}

/** Runs one simulation end to end through the browser (stages 2-5 of the brief, parameterized by
 *  policy): create it from `/sim`, assert the frozen definition + fresh state, run it to day 30,
 *  and cross-check the page's rolled-up metrics against `replaySimulation` and `tradeMetrics`.
 *  Returns the DB-computed metrics so the caller can compare policy A against policy B. */
async function runSimulation(baseUrl, { name, policy }) {
  // ---- create it from /sim ----
  await page.goto(`${baseUrl}/sim`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  const drawer = page.getByTestId('new-simulation-drawer')
  await clickUntil(page.getByTestId('new-simulation'), async () => drawer.first().isVisible(), 'the "+ New simulation" button')
  await waitVisible(drawer, 'the new-simulation drawer')

  await selectReliably(page.getByTestId('new-simulation-company'), companyId, { value: companyId }, 'the new-simulation company select')
  await fillReliably(page.getByTestId('new-simulation-name'), name, 'the new-simulation name field')
  await selectReliably(page.getByTestId('new-simulation-policy'), policy, { value: policy }, 'the new-simulation policy select')
  await fillReliably(page.getByTestId('new-simulation-seed'), String(SEED), 'the new-simulation seed field')

  const beforeCount = await prisma.simulationRun.count({ where: { companyId, name } })
  await clickUntil(
    page.getByTestId('new-simulation-submit'),
    async () => /\/sim\/[^/]+$/.test(new URL(page.url()).pathname) && (await prisma.simulationRun.count({ where: { companyId, name } })) > beforeCount,
    `submitting the "${name}" new-simulation form`,
  )
  const match = /\/sim\/([^/]+)$/.exec(new URL(page.url()).pathname)
  if (match === null) await fail(`the URL after submitting "${name}" is ${JSON.stringify(page.url())}, expected /sim/<id>`)
  const simulationId = match[1]
  console.log(`"${name}" created and navigated to: ${simulationId}`)

  // ---- a fresh run's frozen definition and starting state, direct from prisma ----
  const freshRow = await prisma.simulationRun.findUnique({ where: { id: simulationId } })
  if (freshRow === null) await fail(`"${name}" (${simulationId}) is missing from the DB right after creation`)
  const freshDefinition = freshRow.definition
  const freshState = freshRow.state
  if (freshDefinition.policy !== policy) await fail(`"${name}"'s stored definition.policy is ${JSON.stringify(freshDefinition.policy)}, expected ${JSON.stringify(policy)}`)
  if (freshState.day !== 0) await fail(`"${name}"'s stored state.day is ${JSON.stringify(freshState.day)}, expected 0 right after creation`)
  const runCount = await prisma.simulationRun.count({ where: { id: simulationId } })
  if (runCount !== 1) await fail(`found ${runCount} SimulationRun row(s) for "${name}" (${simulationId}), expected exactly 1`)
  console.log(`"${name}" (${simulationId}) verified against prisma: policy ${policy}, day 0, exactly one row`)

  // ---- run it to day 30 ----
  await waitVisible(page.getByTestId('sim-strip'), `the "${name}" run page's strip`)
  const dayCell = page.getByTestId('sim-company-day')
  await fillReliably(page.getByTestId('sim-run-to-day'), '30', `the "${name}" run's "run to day" field`)
  await clickUntil(page.getByTestId('sim-run-to'), async () => (await dayCell.textContent()) === '30 / 30', `"Run to day" on "${name}"`)
  const ranRow = await prisma.simulationRun.findUnique({ where: { id: simulationId } })
  if (ranRow === null) await fail(`"${name}" (${simulationId}) is missing from the DB after running to day 30`)
  if (ranRow.simTime !== 30) await fail(`"${name}"'s stored simTime is ${JSON.stringify(ranRow.simTime)}, expected 30 -- the page's "30 / 30" is not backed by the DB`)
  if (ranRow.status !== 'finished') await fail(`"${name}"'s stored status is ${JSON.stringify(ranRow.status)}, expected "finished" at horizonDays`)
  console.log(`"${name}" ran to day 30/30 -- verified against prisma: simTime 30, status finished`)

  // ---- replay says the stored state still matches a fresh re-run of the same journal ----
  const replayed = await replaySimulation(simulationId)
  if (!replayed.ok) await fail(`replaySimulation(${simulationId}) refused: ${JSON.stringify(replayed.error)}`)
  if (replayed.value.matches !== true) await fail(`replaySimulation(${simulationId}) reports matches=${replayed.value.matches}, expected true`)
  console.log(`"${name}" (${simulationId}) replay matches the stored state`)

  // ---- the page's metrics vs tradeMetrics computed straight from the DB journal ----
  const { metrics, currency } = await computeMetrics(simulationId)
  const metricValueText = async (key) => (await page.getByTestId(`sim-metric-${key}`).locator('div').nth(1).textContent())?.trim()

  const deliveredText = await metricValueText('deliveredQty')
  if (deliveredText !== String(metrics.deliveredQty)) await fail(`"${name}"'s sim-metric-deliveredQty reads ${JSON.stringify(deliveredText)}, expected ${JSON.stringify(String(metrics.deliveredQty))} (from tradeMetrics)`)

  const lateDaysText = await metricValueText('lateDays')
  if (lateDaysText !== String(metrics.lateDays)) await fail(`"${name}"'s sim-metric-lateDays reads ${JSON.stringify(lateDaysText)}, expected ${JSON.stringify(String(metrics.lateDays))} (from tradeMetrics)`)

  const purchaseCostExpected = formatMinor(metrics.purchaseCostMinor, currency)
  const purchaseCostText = await metricValueText('purchaseCostMinor')
  if (purchaseCostText !== purchaseCostExpected) await fail(`"${name}"'s sim-metric-purchaseCostMinor reads ${JSON.stringify(purchaseCostText)}, expected ${JSON.stringify(purchaseCostExpected)} (tradeMetrics.purchaseCostMinor through Intl.NumberFormat)`)
  console.log(`"${name}" (${simulationId}): page delivered=${deliveredText} lateDays=${lateDaysText} purchaseCost=${purchaseCostText} all match tradeMetrics computed from the DB journal`)

  // ---- the rules provider spends no model call ----
  const modelUsageCount = await prisma.simulationModelUsage.count({ where: { simulationId } })
  if (modelUsageCount !== 0) await fail(`"${name}" (${simulationId}) has ${modelUsageCount} SimulationModelUsage row(s), expected 0 (the rules provider makes no model call)`)
  const modelUsageText = await page.getByTestId('sim-model-usage').textContent()
  if (!modelUsageText?.includes('no model calls')) await fail(`"${name}"'s sim-model-usage reads ${JSON.stringify(modelUsageText)}, expected it to contain "no model calls"`)
  console.log(`"${name}" (${simulationId}): SimulationModelUsage is empty in the DB and the page says "no model calls"`)

  return { simulationId, metrics, lateDaysText }
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m29-simulation-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  const chromiumPath = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- set CHROMIUM_PATH to a real executable (e.g. a playwright-installed ` +
        `chromium under ~/.cache/ms-playwright) before running this gate`,
    )
  }

  await preflightCleanup()

  // 1. A four-department/four-slave company, created directly with prisma (the m10/m11 stage-1
  // idiom) -- everything from here on happens entirely through the browser. Department names are
  // the trade sector's own role names (`assignRoles` matches by department name, case-insensitively).
  const template = await prisma.slaveTemplate.create({ data: { name: TEMPLATE_NAME, role: 'clerk' } })
  templateId = template.id
  const company = await prisma.company.create({ data: { name: COMPANY_NAME } })
  companyId = company.id
  for (const [department, slaveName] of ROSTER) {
    const team = await prisma.companyTeam.create({ data: { companyId, name: department } })
    await prisma.companySlave.create({ data: { companyTeamId: team.id, templateId, name: slaveName } })
  }
  console.log(`company created and staffed directly: ${companyId} (${COMPANY_NAME}), template ${templateId}`)

  // 2. Boot the real web shell on a free port.
  const preferredPort = await findFreePort()
  nextProc = spawn('node', ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort)], {
    cwd: repoRoot,
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

  // ---- Scenario stages 2-3: gate A, policy A ----
  const runA = await runSimulation(baseUrl, { name: SIM_NAME_A, policy: 'A' })
  simulationIdA = runA.simulationId
  console.log('stage 2-3 (gate A) complete')

  // ---- Scenario stage 5: gate B, policy B -- repeats stages 2-3, then compares against A ----
  const runB = await runSimulation(baseUrl, { name: SIM_NAME_B, policy: 'B' })
  simulationIdB = runB.simulationId
  console.log('stage 2-3 repeated for gate B complete')

  if (runB.metrics.lateDays !== 0) await fail(`"${SIM_NAME_B}" (policy B, hedges when a delivery is at risk) has lateDays=${runB.metrics.lateDays} in tradeMetrics, expected 0`)
  if (runB.lateDaysText !== '0') await fail(`"${SIM_NAME_B}"'s sim-metric-lateDays page text is ${JSON.stringify(runB.lateDaysText)}, expected "0"`)
  if (runA.metrics.lateDays === 0) await fail(`"${SIM_NAME_A}" (policy A, waits for the normal supplier through its delay) has lateDays=0 in tradeMetrics, expected a nonzero figure`)
  if (runA.lateDaysText === '0') await fail(`"${SIM_NAME_A}"'s sim-metric-lateDays page text is "0", expected a nonzero figure`)
  if (!(runB.metrics.purchaseCostMinor > runA.metrics.purchaseCostMinor)) {
    await fail(`"${SIM_NAME_B}"'s purchaseCostMinor (${runB.metrics.purchaseCostMinor}) is not greater than "${SIM_NAME_A}"'s (${runA.metrics.purchaseCostMinor}) -- the fast-supplier hedge should cost more`)
  }
  console.log(
    `stage 5 complete: B's late days (page "${runB.lateDaysText}", tradeMetrics ${runB.metrics.lateDays}) is 0 where A's (page "${runA.lateDaysText}", ` +
      `tradeMetrics ${runA.metrics.lateDays}) is not, and B's purchase cost (${runB.metrics.purchaseCostMinor}) exceeds A's (${runA.metrics.purchaseCostMinor}) -- ` +
      'both read from the DB and cross-checked against the page',
  )

  // ---- Scenario stage 6a: the finished run's sim-step stays disabled ----
  const finishedRow = await prisma.simulationRun.findUnique({ where: { id: simulationIdB } })
  if (finishedRow === null) await fail(`"${SIM_NAME_B}" (${simulationIdB}) is missing from the DB before the sim-step check`)
  if (finishedRow.status !== 'finished') await fail(`"${SIM_NAME_B}"'s stored status is ${JSON.stringify(finishedRow.status)}, expected "finished" before asserting sim-step is disabled`)
  const stepButton = page.getByTestId('sim-step')
  await waitVisible(stepButton, `"${SIM_NAME_B}"'s sim-step button`)
  if (!(await stepButton.isDisabled())) await fail(`"${SIM_NAME_B}" is finished (prisma status "finished") but its sim-step button is not disabled`)
  console.log(`"${SIM_NAME_B}"'s sim-step stays disabled on a finished run -- verified against prisma status`)

  // ---- Scenario stage 6b: the pre-existing software flow is untouched ----
  const seedSlaveCount = await prisma.slave.count({ where: { team: { workspaceId: SEED_WORKSPACE_ID } } })
  await page.goto(`${baseUrl}/w/${SEED_WORKSPACE_ID}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('slave-card').first(), 'the seeded workspace Overview page a slave card')
  const seedCardCount = await page.getByTestId('slave-card').count()
  if (seedCardCount !== seedSlaveCount) {
    await fail(`the seeded workspace Overview shows ${seedCardCount} slave-card(s), expected ${seedSlaveCount} (matching prisma.slave for that workspace)`)
  }
  console.log(`the seeded workspace's Overview still renders ${seedCardCount} slave card(s), matching prisma -- the software flow is untouched`)

  console.log(
    `PASS: two policies (A and B) ran to day 30 through the browser, replay and journal-derived metrics matched, no model call was recorded, ` +
      'and the pre-existing software flow was left alone',
  )
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
  // FK-ordered cleanup: the two runs first (`onDelete: Restrict` on SimulationRun.company blocks
  // the company delete while either exists), then the company (cascades CompanyTeam/CompanySlave),
  // then the template.
  for (const simulationId of [simulationIdA, simulationIdB]) {
    if (simulationId !== null) {
      await prisma.simulationRun.deleteMany({ where: { id: simulationId } }).catch(() => {})
    }
  }
  if (companyId !== null) {
    await prisma.simulationRun.deleteMany({ where: { companyId } }).catch(() => {})
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {})
  }
  if (templateId !== null) {
    await prisma.slaveTemplate.delete({ where: { id: templateId } }).catch(() => {})
  }
  await prisma.$disconnect()
}

process.exit(exitCode)
