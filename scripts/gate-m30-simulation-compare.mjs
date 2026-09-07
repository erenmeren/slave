// M30's own gate (Task 6 brief): a real Chromium (`playwright-core`, no test runner) driving a
// real `next dev` server AND a real orchestrator daemon (`apps/orchestrator/dist/cli.js daemon`)
// -- the same two processes an operator actually runs together. Shape borrowed verbatim from
// `gate-m29-simulation.mjs`: dist imports, `findFreePort`, the `next dev` spawn + ready wait,
// Chromium from `CHROMIUM_PATH` (falling back to `/usr/bin/chromium`), everything created inside
// `try`, `finally` kills every process this script spawned and cleans up in FK order, `exitCode`
// starts at 1 and is only set to 0 at the very end of a fully-asserted run, a FAIL dumps the
// page's URL, every "M30 Gate"-named row still in the DB, and a full-page screenshot into a
// scratch directory this script creates and prints the path to.
//
// Stage 1 (the company): a template and a four-department/four-slave roster created directly
// with `prisma`, the m10/m11 stage-1 idiom.
//
// Stage 2 (gate A, gate B): `/sim` creates "gate A" (policy A, seed 5) through the drawer; on its
// page, `sim-clone-open` clones it into "gate B" (policy B) -- a `prisma` read confirms
// `clonedFromId` and a fresh `simTime` of 0.
//
// Stage 3 (auto-run, through the browser): both runs are armed with the auto-run intent (every
// 250 ms, until day 30) via `sim-auto-run-every`/`sim-auto-run-until`/`sim-auto-run-start` --
// `prisma` confirms both rows carry the intent before the daemon is trusted to consume it.
//
// Stage 4 (the live stream, and the daemon actually stepping): while staying on "gate A"'s page
// with no click at all, `sim-company-day`'s text is polled until it moves on its own (the SSE
// push -> `router.refresh()` path) -- proof the daemon is really driving the run, not this
// script. The wait then continues (bounded, `prisma`-polled) until both runs reach `finished`,
// and `sim-auto-run-chip` is confirmed gone once they do.
//
// Stage 5 (compare, no verdict): `/sim/compare?a=<A>&b=<B>` is read against `compareSimulations`
// (control dist) directly, formatted through the identical `Intl.NumberFormat` + sign rules
// `CompareClient.tsx` uses -- no warning (the clone shares A's world and neither run was
// injected), and the footer says "no verdict".
//
// Stage 6 (restart safety): "gate A" is cloned again into "gate C", auto-run armed the same way;
// once `prisma` shows it mid-run, the daemon is SIGTERM'd, its exit is awaited, and `simTime` is
// confirmed frozen for a full second -- proof the kill actually stopped the stepping, not just
// the process's stdout. A fresh daemon is then started, "gate C" is waited out to `finished`, and
// the run's own `stepped` control journal rows are read back and asserted `day` 1..30, strictly
// increasing, no gap, no repeat -- the restart neither skipped a day nor re-ran one.
//
// Stage 7: the pre-existing software flow is untouched -- the seeded workspace's Overview still
// renders its own slave cards, one per `prisma.slave` row, completely unrelated to anything a
// simulation touches (and unaffected by the daemon this gate ran against that same workspace).
//
// Teardown (in `finally`): kill the daemon and `next dev`, then delete the three runs (a
// `SimulationRun` blocks its `Company` from deleting while it exists -- `onDelete: Restrict`),
// then the company, then the template.

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
import { compareSimulations } from '../packages/control/dist/simulation.js'

const ACTION_TIMEOUT_MS = 20_000
const NEXT_READY_TIMEOUT_MS = 60_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const FINISH_WAIT_TIMEOUT_MS = 90_000
const LIVE_STREAM_TIMEOUT_MS = 30_000
const FREEZE_CHECK_MS = 1_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// Exact literals, never suffixed -- these are typed into real form fields the way an operator
// would type them, and the two rows created directly with prisma (the company and its template)
// follow the same m11 convention. `preflightCleanup` removes any leftovers a prior crashed run
// left on these exact names before this run creates its own.
const TEMPLATE_NAME = 'M30 Gate Clerk'
const COMPANY_NAME = 'M30 Gate Trading'
const ROSTER = [
  ['Sales', 'M30 Sonia'],
  ['Purchasing', 'M30 Pete'],
  ['Operations', 'M30 Olga'],
  ['Finance', 'M30 Fin'],
]
const SIM_NAME_A = 'gate A'
const SIM_NAME_B = 'gate B'
const SIM_NAME_C = 'gate C'
const SEED = 5

/** Same currency formatting the compare page uses (`apps/web/src/lib/money.ts`'s `formatMinor`)
 *  -- reproduced here rather than imported, since `apps/web` is a Next app, not a package with a
 *  `dist` this script can import from; the two are kept identical by inspection, not by sharing
 *  code. */
function formatMinor(minor, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100)
}

/** `CompareClient.tsx`'s `deltaMoney`: `formatMinor` already carries an ASCII `-` for a negative
 *  amount; a non-negative one gets an explicit `+` so the sign is never ambiguous. */
function deltaMoney(minor, currency) {
  return minor < 0 ? formatMinor(minor, currency) : `+${formatMinor(minor, currency)}`
}

/** `CompareClient.tsx`'s `deltaCount`: `+N`, the typographic minus `−N`, or `0` -- never a bare
 *  positive integer, which would read as an absolute value rather than a change. */
function deltaCount(value) {
  if (value > 0) return `+${value}`
  if (value < 0) return `−${Math.abs(value)}`
  return '0'
}

const MONEY_METRICS = new Set(['purchaseCostMinor', 'closingCashMinor', 'minCashMinor', 'collectedMinor', 'unpaidCommitmentsMinor'])
const METRIC_KEYS = ['deliveredQty', 'onTimeQty', 'lateDays', 'purchaseCostMinor', 'closingInventory', 'closingCashMinor', 'minCashMinor', 'collectedMinor', 'unpaidCommitmentsMinor']

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

/** Removes any "M30 Gate"-named rows a prior interrupted run left behind, in the same FK order
 *  the `finally` block below uses. Safe to run against an empty slate -- every step is a no-op
 *  when nothing matches. */
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
let simulationIdC = null
let nextProc = null
let daemonProc = null
let browser = null
let page = null
let diagDir = null

/** Every "M30 Gate"-named row still in the DB, for a FAIL's diagnostic dump -- not scoped to this
 *  run's own tracked ids, since a failure can happen before some of those ids are even set. */
async function dumpSimRows() {
  const templates = await prisma.slaveTemplate.findMany({ where: { name: { contains: 'M30 Gate' } } })
  const companies = await prisma.company.findMany({
    where: { name: { contains: 'M30 Gate' } },
    include: { teams: { include: { slaves: true } }, simulations: { select: { id: true, name: true, status: true, simTime: true, version: true, autoRunEveryMs: true, autoRunUntilDay: true } } },
  })
  return JSON.stringify({ templates, companies })
}

/** The m8a-estop-style diagnostic dump: FAIL dumps the page URL, every M30-Gate row still in the
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

/** Spawns the real orchestrator daemon against the seed workspace -- the same process an
 *  operator runs alongside `next dev`. `SLAVEOFAI_CLAUDE_BIN: 'node'` is belt and braces: the
 *  seed workspace's tasks carry no `requiredRole`, so this daemon never actually starts a slave,
 *  but a future seed change that gave one a role must not make this gate spawn a real CLI. */
function spawnDaemon() {
  const proc = spawn('node', ['apps/orchestrator/dist/cli.js', 'daemon', '--workspace', SEED_WORKSPACE_ID, '--period', '250'], {
    cwd: repoRoot,
    // M32 item 7: belt, braces AND a refusal -- with the flag set the daemon will not start at
    // all if `SLAVEOFAI_CLAUDE_BIN` beside it ever goes missing.
    env: { ...loopbackChildEnv(), SLAVEOFAI_CLAUDE_BIN: 'node', SLAVEOFAI_REQUIRE_FAKE_CLI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.on('data', (chunk) => process.stdout.write(`[daemon] ${chunk}`))
  proc.stderr.on('data', (chunk) => process.stderr.write(`[daemon] ${chunk}`))
  return proc
}

/** SIGTERMs a spawned process and waits for its own exit (not a forced kill) within the budget,
 *  failing loudly if it does not -- the restart-safety stage needs to know the daemon actually
 *  stopped stepping, not merely that this script gave up waiting. */
async function terminateAndWait(proc, description) {
  if (proc.exitCode !== null) return
  proc.kill('SIGTERM')
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
  while (proc.exitCode === null && Date.now() < deadline) await delay(50)
  if (proc.exitCode === null) {
    proc.kill('SIGKILL')
    await fail(`${description} did not exit within ${PROCESS_EXIT_TIMEOUT_MS}ms of SIGTERM`)
  }
}

/** Creates one simulation through `/sim`'s drawer, confirming its frozen definition and fresh
 *  state directly against `prisma` before returning its id. */
async function createSimulationOnPage(baseUrl, { name, policy }) {
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

  const freshRow = await prisma.simulationRun.findUnique({ where: { id: simulationId } })
  if (freshRow === null) await fail(`"${name}" (${simulationId}) is missing from the DB right after creation`)
  if (freshRow.definition.policy !== policy) await fail(`"${name}"'s stored definition.policy is ${JSON.stringify(freshRow.definition.policy)}, expected ${JSON.stringify(policy)}`)
  if (freshRow.state.day !== 0) await fail(`"${name}"'s stored state.day is ${JSON.stringify(freshRow.state.day)}, expected 0 right after creation`)
  console.log(`"${name}" created and navigated to: ${simulationId} -- verified against prisma: policy ${policy}, day 0`)
  return simulationId
}

/** Clones `sourceId` from its own run page (`sim-clone-open`) into a fresh run named `name` with
 *  `policy`, confirming `clonedFromId` and a fresh `simTime` of 0 directly against `prisma`. */
async function cloneOnPage(baseUrl, sourceId, { name, policy }) {
  await page.goto(`${baseUrl}/sim/${sourceId}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('sim-strip'), `"${sourceId}"'s run page's strip`)
  const drawer = page.getByTestId('sim-clone-drawer')
  await clickUntil(page.getByTestId('sim-clone-open'), async () => drawer.first().isVisible(), 'the "Clone…" button')
  await waitVisible(drawer, 'the clone drawer')

  await fillReliably(page.getByTestId('sim-clone-name'), name, 'the clone-drawer name field')
  await selectReliably(page.getByTestId('sim-clone-policy'), policy, { value: policy }, 'the clone-drawer policy select')

  // Unlike `createSimulationOnPage`'s submit (starting from the URL-less `/sim`), this page is
  // already sitting on `/sim/<sourceId>` when the clone is submitted -- so a bare
  // `/\/sim\/[^/]+$/` match is satisfied by the CURRENT (source) URL the instant the server has
  // committed the new row, before the client-side `router.push` to the clone's own page has
  // actually landed. Requiring the matched id to differ from `sourceId` closes that race.
  const beforeCount = await prisma.simulationRun.count({ where: { companyId, name } })
  await clickUntil(
    page.getByTestId('sim-clone-submit'),
    async () => {
      const matched = /\/sim\/([^/]+)$/.exec(new URL(page.url()).pathname)
      if (matched === null || matched[1] === sourceId) return false
      return (await prisma.simulationRun.count({ where: { companyId, name } })) > beforeCount
    },
    `submitting the "${name}" clone form`,
  )
  const match = /\/sim\/([^/]+)$/.exec(new URL(page.url()).pathname)
  if (match === null || match[1] === sourceId) await fail(`the URL after cloning "${name}" is ${JSON.stringify(page.url())}, expected /sim/<id> distinct from the source ${sourceId}`)
  const simulationId = match[1]

  const row = await prisma.simulationRun.findUnique({ where: { id: simulationId } })
  if (row === null) await fail(`"${name}" (${simulationId}) is missing from the DB right after cloning`)
  if (row.clonedFromId !== sourceId) await fail(`"${name}"'s stored clonedFromId is ${JSON.stringify(row.clonedFromId)}, expected ${JSON.stringify(sourceId)}`)
  if (row.simTime !== 0) await fail(`"${name}"'s stored simTime is ${JSON.stringify(row.simTime)}, expected 0 right after cloning`)
  console.log(`"${name}" cloned from ${sourceId} and navigated to: ${simulationId} -- verified against prisma: clonedFromId ${sourceId}, simTime 0`)
  return simulationId
}

/** Arms the auto-run intent on the run currently on screen (every 250 ms, until day 30) through
 *  `sim-auto-run-every`/`sim-auto-run-until`/`sim-auto-run-start`, confirming the intent landed
 *  directly against `prisma` before returning. */
async function armAutoRunOnPage(simulationId, name) {
  await selectReliably(page.getByTestId('sim-auto-run-every'), '250', { value: '250' }, `"${name}"'s auto-run "every" select`)
  await fillReliably(page.getByTestId('sim-auto-run-until'), '30', `"${name}"'s auto-run "until day" field`)
  await clickUntil(
    page.getByTestId('sim-auto-run-start'),
    async () => {
      const row = await prisma.simulationRun.findUnique({ where: { id: simulationId } })
      return row !== null && row.autoRunEveryMs === 250 && row.autoRunUntilDay === 30
    },
    `"${name}"'s "Auto-run" button`,
  )
  console.log(`"${name}" armed with auto-run every 250ms until day 30 -- verified against prisma`)
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m30-simulation-compare-diag-'))
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
  // idiom) -- everything from here on happens entirely through the browser.
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

  // 3. The real daemon -- an operator's "npm run orchestrator -- daemon" -- against the seed
  // workspace, so the auto-run intent this gate arms below actually gets consumed.
  daemonProc = spawnDaemon()
  console.log(`daemon spawned (pid ${daemonProc.pid}), period 250ms against workspace ${SEED_WORKSPACE_ID}`)

  // 4. Launch the real browser.
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  page.on('pageerror', (error) => console.error(`[browser:pageerror] ${error}`))

  // ---- Stage 2: gate A, then gate B cloned from it ----
  simulationIdA = await createSimulationOnPage(baseUrl, { name: SIM_NAME_A, policy: 'A' })
  simulationIdB = await cloneOnPage(baseUrl, simulationIdA, { name: SIM_NAME_B, policy: 'B' })
  console.log('stage 2 (gate A, gate B cloned from it) complete')

  // ---- Stage 3: arm the auto-run intent on B (already on screen), then on A ----
  await armAutoRunOnPage(simulationIdB, SIM_NAME_B)
  await page.goto(`${baseUrl}/sim/${simulationIdA}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('sim-strip'), `"${SIM_NAME_A}"'s run page's strip`)
  const dayCell = page.getByTestId('sim-company-day')
  const initialDayText = await dayCell.textContent()
  await armAutoRunOnPage(simulationIdA, SIM_NAME_A)
  console.log('stage 3 (both runs armed with the auto-run intent) complete')

  // ---- Stage 4: the live stream (no click) and the daemon actually finishing both runs ----
  let liveStreamConfirmed = false
  const liveStreamDeadline = Date.now() + LIVE_STREAM_TIMEOUT_MS
  const finishDeadline = Date.now() + FINISH_WAIT_TIMEOUT_MS
  while (Date.now() < finishDeadline) {
    if (!liveStreamConfirmed) {
      const currentDayText = await dayCell.textContent()
      if (currentDayText !== initialDayText) {
        liveStreamConfirmed = true
        console.log(`sim-company-day on "${SIM_NAME_A}"'s page moved from ${JSON.stringify(initialDayText)} to ${JSON.stringify(currentDayText)} with no click -- the live stream is working`)
      } else if (Date.now() > liveStreamDeadline) {
        await fail(`sim-company-day on "${SIM_NAME_A}"'s page never changed from ${JSON.stringify(initialDayText)} without a click within ${LIVE_STREAM_TIMEOUT_MS}ms -- the live stream did not update the page`)
      }
    }
    const [rowA, rowB] = await Promise.all([
      prisma.simulationRun.findUnique({ where: { id: simulationIdA } }),
      prisma.simulationRun.findUnique({ where: { id: simulationIdB } }),
    ])
    if (rowA?.status === 'finished' && rowB?.status === 'finished') break
    await delay(300)
  }
  if (!liveStreamConfirmed) await fail(`sim-company-day on "${SIM_NAME_A}"'s page never changed from ${JSON.stringify(initialDayText)} without a click while waiting for both runs to finish`)
  const [finalA, finalB] = await Promise.all([
    prisma.simulationRun.findUnique({ where: { id: simulationIdA } }),
    prisma.simulationRun.findUnique({ where: { id: simulationIdB } }),
  ])
  if (finalA?.status !== 'finished') await fail(`"${SIM_NAME_A}" did not reach finished within ${FINISH_WAIT_TIMEOUT_MS}ms -- status is ${JSON.stringify(finalA?.status)}`)
  if (finalB?.status !== 'finished') await fail(`"${SIM_NAME_B}" did not reach finished within ${FINISH_WAIT_TIMEOUT_MS}ms -- status is ${JSON.stringify(finalB?.status)}`)
  if (finalA.autoRunEveryMs !== null) await fail(`"${SIM_NAME_A}" finished but its stored autoRunEveryMs is still ${finalA.autoRunEveryMs}, expected null`)
  if (finalB.autoRunEveryMs !== null) await fail(`"${SIM_NAME_B}" finished but its stored autoRunEveryMs is still ${finalB.autoRunEveryMs}, expected null`)
  // The row's own `autoRunEveryMs` is already null (confirmed above); the page still has to catch
  // up through its own SSE push -> `router.refresh()` -> re-render, which is not instantaneous.
  let chipCount = await page.getByTestId('sim-auto-run-chip').count()
  {
    const chipDeadline = Date.now() + 10_000
    while (chipCount !== 0 && Date.now() < chipDeadline) {
      await delay(200)
      chipCount = await page.getByTestId('sim-auto-run-chip').count()
    }
  }
  if (chipCount !== 0) await fail(`"${SIM_NAME_A}"'s page still shows ${chipCount} sim-auto-run-chip element(s) after finishing, expected 0`)
  console.log(`stage 4 complete: both runs finished (verified against prisma), the daemon really drove the live stream, and sim-auto-run-chip disappeared`)

  // ---- Stage 5: compare, no verdict ----
  await page.goto(`${baseUrl}/sim/compare?a=${simulationIdA}&b=${simulationIdB}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('sim-compare-strip'), 'the compare page strip')
  const comparison = await compareSimulations(simulationIdA, simulationIdB)
  if (!comparison.ok) await fail(`compareSimulations(${simulationIdA}, ${simulationIdB}) refused: ${JSON.stringify(comparison.error)}`)
  for (const key of METRIC_KEYS) {
    const expected = MONEY_METRICS.has(key) ? deltaMoney(comparison.value.deltas[key], comparison.value.currency) : deltaCount(comparison.value.deltas[key])
    const actual = (await page.getByTestId(`sim-compare-delta-${key}`).textContent())?.trim()
    if (actual !== expected) await fail(`sim-compare-delta-${key} reads ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)} (compareSimulations' own delta, formatted the way CompareClient.tsx does)`)
  }
  const warningCount = await page.getByTestId('sim-compare-warning').count()
  if (warningCount !== 0) await fail(`the compare page shows ${warningCount} sim-compare-warning element(s), expected 0 -- "${SIM_NAME_B}" is a clone of "${SIM_NAME_A}" and neither run was injected`)
  const footerText = await page.getByTestId('sim-compare-footer').textContent()
  if (!footerText?.includes('no verdict')) await fail(`sim-compare-footer reads ${JSON.stringify(footerText)}, expected it to contain "no verdict"`)
  console.log(`stage 5 complete: every sim-compare-delta-* matches compareSimulations' own deltas, no warning, footer says "no verdict"`)

  // ---- Stage 6: restart safety -- kill the daemon mid-run, confirm it actually stops, restart it ----
  simulationIdC = await cloneOnPage(baseUrl, simulationIdA, { name: SIM_NAME_C, policy: 'A' })
  await armAutoRunOnPage(simulationIdC, SIM_NAME_C)
  {
    const deadline = Date.now() + FINISH_WAIT_TIMEOUT_MS
    let row = null
    while (Date.now() < deadline) {
      row = await prisma.simulationRun.findUnique({ where: { id: simulationIdC } })
      if (row !== null && row.simTime >= 5) break
      await delay(200)
    }
    if (row === null || row.simTime < 5) await fail(`"${SIM_NAME_C}" did not reach simTime >= 5 within ${FINISH_WAIT_TIMEOUT_MS}ms before the restart-safety kill -- last simTime ${row?.simTime}`)
    console.log(`"${SIM_NAME_C}" reached simTime ${row.simTime} -- killing the daemon now`)
  }
  await terminateAndWait(daemonProc, 'the daemon (restart-safety SIGTERM)')
  console.log('daemon exited after SIGTERM')
  {
    const before = await prisma.simulationRun.findUniqueOrThrow({ where: { id: simulationIdC } })
    await delay(FREEZE_CHECK_MS)
    const after = await prisma.simulationRun.findUniqueOrThrow({ where: { id: simulationIdC } })
    if (after.simTime !== before.simTime) await fail(`"${SIM_NAME_C}"'s simTime moved from ${before.simTime} to ${after.simTime} during the ${FREEZE_CHECK_MS}ms freeze check after SIGTERM -- the daemon did not actually stop stepping it`)
    console.log(`"${SIM_NAME_C}"'s simTime stayed at ${after.simTime} for ${FREEZE_CHECK_MS}ms with no daemon running -- confirmed frozen`)
  }
  daemonProc = spawnDaemon()
  console.log(`a fresh daemon was spawned (pid ${daemonProc.pid}) to finish "${SIM_NAME_C}"`)
  {
    const deadline = Date.now() + FINISH_WAIT_TIMEOUT_MS
    let row = null
    while (Date.now() < deadline) {
      row = await prisma.simulationRun.findUnique({ where: { id: simulationIdC } })
      if (row?.status === 'finished') break
      await delay(300)
    }
    if (row?.status !== 'finished') await fail(`"${SIM_NAME_C}" did not reach finished within ${FINISH_WAIT_TIMEOUT_MS}ms of restarting the daemon -- status is ${JSON.stringify(row?.status)}`)
  }
  const controlRows = await prisma.simulationJournalEntry.findMany({ where: { simulationId: simulationIdC, kind: 'control' }, orderBy: { seq: 'asc' } })
  const steppedDays = controlRows.filter((row) => row.payload?.op === 'stepped').map((row) => row.payload.day)
  const expectedDays = Array.from({ length: 30 }, (_, i) => i + 1)
  if (JSON.stringify(steppedDays) !== JSON.stringify(expectedDays)) {
    await fail(`"${SIM_NAME_C}"'s stepped control rows' day values are ${JSON.stringify(steppedDays)}, expected exactly [1..30] strictly increasing with no gap and no repeat -- the daemon restart re-ran or skipped a day`)
  }
  console.log(`stage 6 complete: the kill actually froze "${SIM_NAME_C}", the restarted daemon finished it, and its stepped days are exactly 1..30 with no gap or repeat`)

  // ---- Stage 7: the pre-existing software flow is untouched ----
  const seedSlaveCount = await prisma.slave.count({ where: { team: { workspaceId: SEED_WORKSPACE_ID } } })
  await page.goto(`${baseUrl}/w/${SEED_WORKSPACE_ID}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('slave-card').first(), 'the seeded workspace Overview page a slave card')
  const seedCardCount = await page.getByTestId('slave-card').count()
  if (seedCardCount !== seedSlaveCount) {
    await fail(`the seeded workspace Overview shows ${seedCardCount} slave-card(s), expected ${seedSlaveCount} (matching prisma.slave for that workspace)`)
  }
  console.log(`the seeded workspace's Overview still renders ${seedCardCount} slave card(s), matching prisma -- the software flow is untouched even with the daemon running against it`)

  console.log(
    'PASS: a clone auto-ran side by side with its source through a real daemon, the live stream updated the page with no click, ' +
      'the compare page matched compareSimulations exactly with no verdict, a SIGTERM-and-restart of the daemon lost no day and ' +
      'repeated none, and the pre-existing software flow was left alone',
  )
  exitCode = 0
} finally {
  if (browser !== null) {
    await browser.close().catch(() => {})
  }
  if (daemonProc !== null && daemonProc.exitCode === null) {
    daemonProc.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (daemonProc.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (daemonProc.exitCode === null) daemonProc.kill('SIGKILL')
  }
  if (nextProc !== null && nextProc.exitCode === null) {
    nextProc.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextProc.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextProc.exitCode === null) nextProc.kill('SIGKILL')
  }
  // FK-ordered cleanup: the three runs first (`onDelete: Restrict` on SimulationRun.company blocks
  // the company delete while any exist), then the company (cascades CompanyTeam/CompanySlave),
  // then the template.
  for (const simulationId of [simulationIdA, simulationIdB, simulationIdC]) {
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
