// M31a's own gate (Task 6 brief): a real Chromium (`playwright-core`, no test runner) driving a
// real `next dev` server AND a real orchestrator daemon (`apps/orchestrator/dist/cli.js daemon`)
// -- the same two processes an operator actually runs together -- with the daemon's model calls
// answered by the FAKE `claude` CLI (`packages/providers/test/fake-claude.mjs`, the exact env
// shape `apps/orchestrator/test/integration/cli.test.ts`'s daemon test uses:
// `SLAVEOFAI_CLAUDE_BIN=node`, `SLAVEOFAI_CLAUDE_ARGS="<abs fake-claude.mjs> --fixture <name>"`).
// No real `claude` call, no paid model call, anywhere. Shape borrowed verbatim from
// `gate-m30-simulation-compare.mjs`: dist imports, `findFreePort`, the `next dev` spawn + ready
// wait, Chromium from `CHROMIUM_PATH`, everything created inside `try`, `finally` kills every
// process this script spawned and cleans up in FK order, `exitCode` starts at 1 and is only set to
// 0 at the very end of a fully-asserted run, a FAIL dumps the page's URL, every "M31a Gate"-named
// row still in the DB, and a full-page screenshot into a scratch directory this script creates and
// prints the path to.
//
// Stage 1 (the company): a template and a four-department/four-slave roster created directly with
// `prisma`, the m10/m11 stage-1 idiom.
//
// Stage 2 (the llm run, through the browser): `/sim`'s drawer, provider `llm`, the model typed
// into the free-text field the `ModelSelect`'s "other…" option reveals, cap `2`, consent checked --
// a `prisma` read confirms `decisionProvider 'llm'`, `modelProvider 'claude_code'`, `model`,
// `maxModelCostUsd 2`, `definition.llmRoles ['purchasing']`, fresh `simTime 0`.
//
// Stage 3 (the daemon on the `decision` fixture, auto-run to day 5): the daemon is spawned with
// `SLAVEOFAI_CLAUDE_ARGS` pointing the fake CLI at `--fixture decision`; auto-run is armed through
// the UI (`sim-auto-run-every`/`sim-auto-run-until`/`sim-auto-run-start`) every 250 ms until day 5;
// `prisma` is polled for `simTime >= 5`.
//
// Stage 4 (what five days of an answered llm decision leaves behind): five `SimulationModelUsage`
// rows (`role 'purchasing'`, `provider 'claude_code'`, `costUsd 0.0038` each, summing to what the
// fixture reports); five `decision` journal rows for `purchasing` with `payload.provider 'llm'`,
// the typed model, and a `usageSeq` matching one of those rows one-to-one; every one of purchasing's
// `action_applied` rows (asserted `action_applied` rather than `action_rejected` only after reading
// `packages/simulation/src/trade/model.ts`'s `validate()` and confirming, from the demo definition's
// own numbers, that `place_purchase fast 50` clears every check for all five days) carries
// `place_purchase { supplierId: 'fast', qty: 50 }`; the other three roles' decision rows all carry
// `payload.provider 'rules'`; the run page's `sim-model-usage` panel text equals the formatted sum
// the same way `SimulationClient.tsx` formats it.
//
// Stage 5 (a breach halts the run): the daemon is killed, auto-run is re-armed through the UI
// FIRST (`prepareModelDecision`'s `until_day` skip already cleared the day-5 intent -- re-arming
// before the daemon comes back is what makes it decide again at all, not a stylistic choice), then
// a fresh daemon is spawned on `--fixture decision-breach`. Within 15 s the run is `halted` with
// `haltedReason 'isolation breach: Bash'`; the control journal carries `{ op: 'isolation_breach',
// tools: ['Bash'] }`, then `{ op: 'halted', reason: 'isolation breach: Bash' }` (ruling R12: an
// automatic halt journals the halt itself, like every other halt path), then `{ op:
// 'auto_run_stopped', reason: 'halted' }` -- read from
// `packages/control/src/simulation/llm.ts`'s `applyModelDecision`, `op: 'model_calls_blocked'` is
// NEVER journaled here: that entry belongs only to the manual `haltSimulation` verb
// (`packages/control/src/simulation/write.ts`'s `setStatus`), which this automatic halt never
// calls. Usage rows are now six (one more, at the breach fixture's own `total_cost_usd 0.0121` --
// `decideWithModel` reports a breach's cost from the same terminal `result` line an answer would);
// `simTime` does not move past 5.
//
// Stage 6: the pre-existing software flow is untouched -- the seeded workspace's Overview still
// renders its own slave cards, unaffected by the daemon this gate ran against that same workspace.
//
// Teardown (in `finally`): kill the daemon and `next dev`, then delete the run, then the company,
// then the template.

import { existsSync, mkdtempSync } from 'node:fs'
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

const ACTION_TIMEOUT_MS = 20_000
const NEXT_READY_TIMEOUT_MS = 60_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const DAY_WAIT_TIMEOUT_MS = 60_000
const BREACH_WAIT_TIMEOUT_MS = 15_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

// Exact literals, never suffixed -- these are typed into real form fields the way an operator
// would type them, and the two rows created directly with prisma (the company and its template)
// follow the m10/m11/m30 convention. `preflightCleanup` removes any leftovers a prior crashed run
// left on these exact names before this run creates its own.
const TEMPLATE_NAME = 'M31a Gate Clerk'
const COMPANY_NAME = 'M31a Gate Trading'
const ROSTER = [
  ['Sales', 'M31a Sonia'],
  ['Purchasing', 'M31a Pete'],
  ['Operations', 'M31a Olga'],
  ['Finance', 'M31a Fin'],
]
const SIM_NAME = 'llm gate run'
const SEED = 9
const MODEL_NAME = 'claude-haiku-4-5-20251001'
const CAP_USD = 2
const FIRST_DECISION_COST = 0.0038
const BREACH_DECISION_COST = 0.0121

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

/** Removes any "M31a Gate"-named rows a prior interrupted run left behind, in the same FK order
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
let simulationId = null
let nextProc = null
let daemonProc = null
let browser = null
let page = null
let diagDir = null

/** Every "M31a Gate"-named row still in the DB, for a FAIL's diagnostic dump -- not scoped to this
 *  run's own tracked ids, since a failure can happen before some of those ids are even set. */
async function dumpSimRows() {
  const templates = await prisma.slaveTemplate.findMany({ where: { name: { contains: 'M31a Gate' } } })
  const companies = await prisma.company.findMany({
    where: { name: { contains: 'M31a Gate' } },
    include: {
      teams: { include: { slaves: true } },
      simulations: { select: { id: true, name: true, status: true, simTime: true, version: true, decisionProvider: true, model: true, maxModelCostUsd: true, autoRunEveryMs: true, autoRunUntilDay: true, haltedReason: true } },
    },
  })
  return JSON.stringify({ templates, companies })
}

/** The m8a-estop-style diagnostic dump: FAIL dumps the page URL, every M31a-Gate row still in the
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

async function checkReliably(locator, description) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS
  while (Date.now() < deadline) {
    await locator.check()
    if (await locator.isChecked()) return
    await delay(100)
  }
  await fail(`could not get ${description} to become checked`)
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

/** Switches `NewSimulationDrawer`'s `ModelSelect` (provider `claude_code`) from its populated
 *  `<select data-testid="model-select">` to the free-text field the "other…" option reveals
 *  (`OTHER = '__other__'` in `ModelSelect.tsx`) -- the way an operator types a model id the static
 *  Claude Code list does not itself carry (M25's own list omits dated ids like this one). */
async function switchModelToFreeText() {
  const select = page.getByTestId('model-select')
  await waitVisible(select, 'the model-select dropdown (claude_code listing)')
  await select.selectOption({ value: '__other__' })
  await waitVisible(page.getByTestId('new-simulation-model'), 'the free-text model input after choosing "other…"')
}

/** Spawns the real orchestrator daemon against the seed workspace -- the same process an operator
 *  runs alongside `next dev` -- with its model calls answered by the fake CLI on `fixtureName`
 *  (`SLAVEOFAI_CLAUDE_BIN=node`, `SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture <name>"`, the
 *  exact shape `apps/orchestrator/test/integration/cli.test.ts`'s daemon test uses).
 *  `SLAVEOFAI_DENY_ALL_HOOK_PATH` is left at its default (`scripts/deny-all-gate.sh`, resolved by
 *  the CLI itself from its own dist location) -- no override needed. */
function spawnDaemon(fixtureName) {
  const proc = spawn('node', ['apps/orchestrator/dist/cli.js', 'daemon', '--workspace', SEED_WORKSPACE_ID, '--period', '250'], {
    cwd: repoRoot,
    // M32 item 7: this daemon MAKES MODEL CALLS, so the fake wiring is the whole of what keeps
    // this gate free. The flag makes the daemon refuse to start rather than fall back to the real
    // `claude` if either variable beside it is ever lost.
    env: { ...loopbackChildEnv(), SLAVEOFAI_CLAUDE_BIN: 'node', SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture ${fixtureName}`, SLAVEOFAI_REQUIRE_FAKE_CLI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.on('data', (chunk) => process.stdout.write(`[daemon:${fixtureName}] ${chunk}`))
  proc.stderr.on('data', (chunk) => process.stderr.write(`[daemon:${fixtureName}] ${chunk}`))
  return proc
}

/** SIGTERMs a spawned process and waits for its own exit within the budget, failing loudly if it
 *  does not. */
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

/** Arms the auto-run intent on the run currently on screen through
 *  `sim-auto-run-every`/`sim-auto-run-until`/`sim-auto-run-start`, confirming the intent landed
 *  directly against `prisma` before returning. */
async function armAutoRunOnPage(untilDay) {
  await selectReliably(page.getByTestId('sim-auto-run-every'), '250', { value: '250' }, 'the auto-run "every" select')
  await fillReliably(page.getByTestId('sim-auto-run-until'), String(untilDay), 'the auto-run "until day" field')
  await clickUntil(
    page.getByTestId('sim-auto-run-start'),
    async () => {
      const row = await prisma.simulationRun.findUnique({ where: { id: simulationId } })
      return row !== null && row.autoRunEveryMs === 250 && row.autoRunUntilDay === untilDay
    },
    'the "Auto-run" button',
  )
  console.log(`"${SIM_NAME}" armed with auto-run every 250ms until day ${untilDay} -- verified against prisma`)
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m31a-llm-decisions-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  const chromiumPath = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- set CHROMIUM_PATH to a real executable (e.g. a playwright-installed ` +
        `chromium under ~/.cache/ms-playwright) before running this gate`,
    )
  }
  // No outer `SLAVEOFAI_CLAUDE_BIN` precondition here, and that is deliberate (see
  // `gate-m19-measure-and-harden.mjs`'s own note): this gate HARDCODES the override on every
  // daemon it spawns (`spawnDaemon` passes `SLAVEOFAI_CLAUDE_BIN: 'node'` and
  // `SLAVEOFAI_CLAUDE_ARGS` pointing at the fake CLI below), so the operator's environment cannot
  // make it reach a real `claude` -- requiring them to set a variable this script overrides anyway
  // would be theatre, and theatre in a gate teaches an operator to set variables without knowing
  // why. What IS enforced is that the fake CLI actually exists.
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`fake claude CLI not found at ${FAKE_CLAUDE}`)

  await preflightCleanup()

  // 1. A four-department/four-slave company, created directly with prisma (the m10/m11/m30 stage-1
  // idiom) -- everything from here on happens entirely through the browser and the daemon.
  const template = await prisma.slaveTemplate.create({ data: { name: TEMPLATE_NAME, role: 'clerk' } })
  templateId = template.id
  const company = await prisma.company.create({ data: { name: COMPANY_NAME } })
  companyId = company.id
  for (const [department, slaveName] of ROSTER) {
    const team = await prisma.companyTeam.create({ data: { companyId, name: department } })
    await prisma.companySlave.create({ data: { companyTeamId: team.id, templateId, name: slaveName } })
  }
  console.log(`company created and staffed directly: ${companyId} (${COMPANY_NAME}), template ${templateId}`)

  // 2. Boot the real web shell on a free port. No SLAVEOFAI_CLAUDE_* here: `ModelSelect` reads
  // `claude_code`'s model list from a pure static table (`listClaudeCodeModels`), never a real CLI.
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

  // 3. The real daemon, on the `decision` fixture -- an operator's "npm run orchestrator --
  // daemon", with its model calls answered by the fake CLI instead of a real `claude`.
  daemonProc = spawnDaemon('decision')
  console.log(`daemon spawned (pid ${daemonProc.pid}), period 250ms, fixture decision`)

  // 4. Launch the real browser.
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  page.on('pageerror', (error) => console.error(`[browser:pageerror] ${error}`))

  // ---- Stage 2: create the llm run from the drawer ----
  await page.goto(`${baseUrl}/sim`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  const drawer = page.getByTestId('new-simulation-drawer')
  await clickUntil(page.getByTestId('new-simulation'), async () => drawer.first().isVisible(), 'the "+ New simulation" button')
  await waitVisible(drawer, 'the new-simulation drawer')

  await selectReliably(page.getByTestId('new-simulation-company'), companyId, { value: companyId }, 'the new-simulation company select')
  await fillReliably(page.getByTestId('new-simulation-name'), SIM_NAME, 'the new-simulation name field')
  await selectReliably(page.getByTestId('new-simulation-policy'), 'A', { value: 'A' }, 'the new-simulation policy select')
  await fillReliably(page.getByTestId('new-simulation-seed'), String(SEED), 'the new-simulation seed field')
  await selectReliably(page.getByTestId('new-simulation-provider'), 'llm', { value: 'llm' }, 'the decision-provider select')
  await switchModelToFreeText()
  await fillReliably(page.getByTestId('new-simulation-model'), MODEL_NAME, 'the model free-text field')
  await fillReliably(page.getByTestId('new-simulation-cap'), String(CAP_USD), 'the cost-cap field')
  await checkReliably(page.getByTestId('new-simulation-consent'), 'the paid-model-calls consent checkbox')

  const beforeCount = await prisma.simulationRun.count({ where: { companyId, name: SIM_NAME } })
  await clickUntil(
    page.getByTestId('new-simulation-submit'),
    async () => /\/sim\/[^/]+$/.test(new URL(page.url()).pathname) && (await prisma.simulationRun.count({ where: { companyId, name: SIM_NAME } })) > beforeCount,
    `submitting the "${SIM_NAME}" new-simulation form`,
  )
  {
    const match = /\/sim\/([^/]+)$/.exec(new URL(page.url()).pathname)
    if (match === null) await fail(`the URL after submitting "${SIM_NAME}" is ${JSON.stringify(page.url())}, expected /sim/<id>`)
    simulationId = match[1]
  }
  {
    const row = await prisma.simulationRun.findUnique({ where: { id: simulationId } })
    if (row === null) await fail(`"${SIM_NAME}" (${simulationId}) is missing from the DB right after creation`)
    if (row.decisionProvider !== 'llm') await fail(`"${SIM_NAME}"'s stored decisionProvider is ${JSON.stringify(row.decisionProvider)}, expected 'llm'`)
    if (row.modelProvider !== 'claude_code') await fail(`"${SIM_NAME}"'s stored modelProvider is ${JSON.stringify(row.modelProvider)}, expected 'claude_code'`)
    if (row.model !== MODEL_NAME) await fail(`"${SIM_NAME}"'s stored model is ${JSON.stringify(row.model)}, expected ${JSON.stringify(MODEL_NAME)}`)
    if (row.maxModelCostUsd !== CAP_USD) await fail(`"${SIM_NAME}"'s stored maxModelCostUsd is ${JSON.stringify(row.maxModelCostUsd)}, expected ${CAP_USD}`)
    if (row.simTime !== 0) await fail(`"${SIM_NAME}"'s stored simTime is ${JSON.stringify(row.simTime)}, expected 0 right after creation`)
    if (JSON.stringify(row.definition.llmRoles) !== JSON.stringify(['purchasing'])) {
      await fail(`"${SIM_NAME}"'s stored definition.llmRoles is ${JSON.stringify(row.definition.llmRoles)}, expected ["purchasing"]`)
    }
    console.log(`"${SIM_NAME}" created and navigated to: ${simulationId} -- verified against prisma: llm/claude_code/${MODEL_NAME}, cap ${CAP_USD}, llmRoles ["purchasing"], day 0`)
  }
  console.log('stage 2 (the llm run created from the drawer, with consent) complete')

  // ---- Stage 3: auto-run every 250ms until day 5, through the UI ----
  await waitVisible(page.getByTestId('sim-strip'), `"${SIM_NAME}"'s run page's strip`)
  {
    const stripText = await page.getByTestId('sim-strip').textContent()
    if (!stripText?.includes(`llm provider · claude_code · ${MODEL_NAME}`)) {
      await fail(`sim-strip reads ${JSON.stringify(stripText)}, expected it to contain "llm provider · claude_code · ${MODEL_NAME}"`)
    }
  }
  await armAutoRunOnPage(5)
  {
    const deadline = Date.now() + DAY_WAIT_TIMEOUT_MS
    let row = null
    while (Date.now() < deadline) {
      row = await prisma.simulationRun.findUnique({ where: { id: simulationId } })
      if (row !== null && row.simTime >= 5) break
      if (row !== null && (row.status === 'halted' || row.status === 'finished')) break
      await delay(200)
    }
    if (row === null || row.simTime < 5) await fail(`"${SIM_NAME}" did not reach simTime >= 5 within ${DAY_WAIT_TIMEOUT_MS}ms -- last row ${JSON.stringify(row)}`)
    if (row.status !== 'running') await fail(`"${SIM_NAME}" reached simTime ${row.simTime} but its status is ${JSON.stringify(row.status)}, expected 'running'`)
    console.log(`"${SIM_NAME}" reached simTime ${row.simTime} with status running -- the daemon decided against the fake CLI five times`)
  }
  console.log('stage 3 (auto-run through the UI, five llm decisions made by the daemon) complete')

  // ---- Stage 4: five usage rows, five llm decision rows, purchasing's applied actions, the other
  // roles' rules decisions, and the page's own model-usage panel text ----
  {
    const usageRows = await prisma.simulationModelUsage.findMany({ where: { simulationId }, orderBy: { seq: 'asc' } })
    console.log(`usage rows so far: ${JSON.stringify(usageRows.map((r) => ({ seq: r.seq, role: r.role, provider: r.provider, costUsd: r.costUsd, simTime: r.simTime })))}`)
    if (usageRows.length !== 5) await fail(`there are ${usageRows.length} SimulationModelUsage row(s) for "${SIM_NAME}", expected 5`)
    for (const row of usageRows) {
      if (row.role !== 'purchasing') await fail(`usage row seq ${row.seq} has role ${JSON.stringify(row.role)}, expected 'purchasing'`)
      if (row.provider !== 'claude_code') await fail(`usage row seq ${row.seq} has provider ${JSON.stringify(row.provider)}, expected 'claude_code'`)
      if (row.costUsd === null || Math.abs(row.costUsd - FIRST_DECISION_COST) > 1e-9) await fail(`usage row seq ${row.seq} has costUsd ${JSON.stringify(row.costUsd)}, expected ${FIRST_DECISION_COST}`)
    }
    const spentUsd = usageRows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)
    if (Math.abs(spentUsd - 5 * FIRST_DECISION_COST) > 1e-9) await fail(`the five usage rows sum to ${spentUsd}, expected ${5 * FIRST_DECISION_COST}`)

    const decisionRows = await prisma.simulationJournalEntry.findMany({ where: { simulationId, kind: 'decision' }, orderBy: { seq: 'asc' } })
    const purchasingDecisions = decisionRows.filter((row) => row.actorRole === 'purchasing')
    const otherDecisions = decisionRows.filter((row) => row.actorRole !== 'purchasing')
    if (purchasingDecisions.length !== 5) await fail(`there are ${purchasingDecisions.length} purchasing decision row(s), expected 5`)
    if (otherDecisions.length === 0) await fail('there are no non-purchasing decision rows, expected sales/operations/finance rows for each of the five days')
    const usageSeqsSeen = new Set()
    for (const row of purchasingDecisions) {
      const payload = row.payload
      if (payload.provider !== 'llm') await fail(`purchasing decision row seq ${row.seq} has payload.provider ${JSON.stringify(payload.provider)}, expected 'llm'`)
      if (payload.model !== MODEL_NAME) await fail(`purchasing decision row seq ${row.seq} has payload.model ${JSON.stringify(payload.model)}, expected ${JSON.stringify(MODEL_NAME)}`)
      if (payload.parseError !== null) await fail(`purchasing decision row seq ${row.seq} has payload.parseError ${JSON.stringify(payload.parseError)}, expected null`)
      const usageSeq = payload.usageSeq
      if (typeof usageSeq !== 'number' || !usageRows.some((u) => u.seq === usageSeq)) await fail(`purchasing decision row seq ${row.seq} has payload.usageSeq ${JSON.stringify(usageSeq)}, which does not match any of the five usage rows`)
      if (usageSeqsSeen.has(usageSeq)) await fail(`purchasing decision row seq ${row.seq}'s usageSeq ${usageSeq} was already claimed by another decision row -- usageSeqs must match one-to-one`)
      usageSeqsSeen.add(usageSeq)
    }
    for (const row of otherDecisions) {
      if (row.payload.provider !== 'rules') await fail(`decision row seq ${row.seq} (actorRole ${JSON.stringify(row.actorRole)}) has payload.provider ${JSON.stringify(row.payload.provider)}, expected 'rules'`)
    }
    console.log(`decision rows verified: 5 purchasing rows provider 'llm' with distinct matching usageSeqs, ${otherDecisions.length} other-role rows provider 'rules'`)

    // `place_purchase fast 50` clears every check `validate()` (packages/simulation/src/trade/model.ts)
    // makes for this demo definition on all five days: 'fast' exists in DEMO_SCENARIO.initial.suppliers,
    // 50 <= purchasing's own maxPurchaseQty (500), and the cumulative cost of five such purchases
    // (5 x 50 x 8_500 minor = 2_125_000 minor) never approaches the demo's starting cash
    // (5_000_000 minor) -- so every one of purchasing's proposed actions is expected to be applied,
    // never rejected. Printed before asserting, per the brief's instruction to show what was found
    // rather than assume it.
    const appliedRows = await prisma.simulationJournalEntry.findMany({ where: { simulationId, kind: 'action_applied', actorRole: 'purchasing' }, orderBy: { seq: 'asc' } })
    const rejectedRows = await prisma.simulationJournalEntry.findMany({ where: { simulationId, kind: 'action_rejected', actorRole: 'purchasing' }, orderBy: { seq: 'asc' } })
    console.log(`purchasing action_applied rows: ${appliedRows.length}, action_rejected rows: ${rejectedRows.length} (trade rules read: fast exists, 50 <= maxPurchaseQty 500, cash always covers it across five days)`)
    if (rejectedRows.length !== 0) await fail(`purchasing has ${rejectedRows.length} action_rejected row(s): ${JSON.stringify(rejectedRows.map((r) => r.payload))} -- expected every place_purchase to be applied`)
    if (appliedRows.length !== 5) await fail(`purchasing has ${appliedRows.length} action_applied row(s), expected 5`)
    for (const row of appliedRows) {
      const action = row.payload.action
      if (action?.type !== 'place_purchase' || action.params?.supplierId !== 'fast' || action.params?.qty !== 50) {
        await fail(`purchasing action_applied row seq ${row.seq} carries action ${JSON.stringify(action)}, expected place_purchase { supplierId: 'fast', qty: 50 }`)
      }
    }
    console.log('stage 4 (usage rows, decision rows, purchasing\'s applied actions) verified against prisma')

    // The page's own panel, formatted exactly as `SimulationClient.tsx`'s `modelUsageText` does for
    // an llm run with a cap: `$<spent 4dp> of $<cap 2dp>`.
    await page.reload({ waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
    await waitVisible(page.getByTestId('sim-model-usage'), 'the model-usage panel')
    const panelText = (await page.getByTestId('sim-model-usage').textContent())?.trim()
    const expectedPanelText = `$${spentUsd.toFixed(4)} of $${CAP_USD.toFixed(2)}`
    if (panelText !== expectedPanelText) await fail(`sim-model-usage reads ${JSON.stringify(panelText)}, expected ${JSON.stringify(expectedPanelText)}`)
    console.log(`sim-model-usage panel reads ${JSON.stringify(panelText)}, matching the five usage rows' own sum`)
  }

  // ---- Stage 5: kill the daemon, re-arm auto-run (the day-5 `until_day` skip already cleared the
  // prior intent -- this is what makes the run decide again at all), THEN restart the daemon on the
  // `decision-breach` fixture, and wait for the isolation-breach halt ----
  //
  // The `until_day` clear happens on the daemon's NEXT prepare pass after simTime reaches 5, not
  // synchronously with the 5th decision -- so this polls (the daemon from stage 3 is still running)
  // rather than asserting immediately.
  {
    const deadline = Date.now() + DAY_WAIT_TIMEOUT_MS
    let row = null
    while (Date.now() < deadline) {
      row = await prisma.simulationRun.findUnique({ where: { id: simulationId } })
      if (row !== null && row.autoRunEveryMs === null) break
      await delay(200)
    }
    if (row === null || row.autoRunEveryMs !== null) await fail(`"${SIM_NAME}" still carries an auto-run intent (autoRunEveryMs ${row?.autoRunEveryMs}) within ${DAY_WAIT_TIMEOUT_MS}ms of reaching day 5 -- expected the until_day skip to clear it`)
    if (row.simTime !== 5) await fail(`"${SIM_NAME}"'s simTime is ${row.simTime} once the until_day skip cleared its intent, expected 5`)
    console.log(`"${SIM_NAME}"'s auto-run intent cleared by the until_day skip, simTime still 5 -- verified against prisma`)
  }
  await terminateAndWait(daemonProc, 'the daemon (decision fixture)')
  console.log('daemon (decision fixture) exited after SIGTERM')
  // No reload here (ruling R11): the `until_day` clear bumps `version`, so the page's live stream
  // sees it and refreshes itself. The wait is still bounded -- the SSE round trip takes a moment,
  // and `AutoRunControls` shows "Stop auto-run" until the refreshed snapshot lands.
  await waitVisible(page.getByTestId('sim-auto-run-start'), `"${SIM_NAME}"'s auto-run start controls, restored by the stream after the until_day clear`)
  await armAutoRunOnPage(15)
  daemonProc = spawnDaemon('decision-breach')
  console.log(`a fresh daemon was spawned (pid ${daemonProc.pid}) on fixture decision-breach`)
  {
    const deadline = Date.now() + BREACH_WAIT_TIMEOUT_MS
    let row = null
    while (Date.now() < deadline) {
      row = await prisma.simulationRun.findUnique({ where: { id: simulationId } })
      if (row !== null && row.status === 'halted') break
      await delay(200)
    }
    if (row === null || row.status !== 'halted') await fail(`"${SIM_NAME}" did not reach 'halted' within ${BREACH_WAIT_TIMEOUT_MS}ms of restarting the daemon on decision-breach -- last row ${JSON.stringify(row)}`)
    if (row.haltedReason !== 'isolation breach: Bash') await fail(`"${SIM_NAME}"'s haltedReason is ${JSON.stringify(row.haltedReason)}, expected 'isolation breach: Bash'`)
    if (row.simTime !== 5) await fail(`"${SIM_NAME}"'s simTime is ${row.simTime} after the breach halt, expected it to stay at 5 -- the breach must not step the run`)
    console.log(`"${SIM_NAME}" halted: ${row.haltedReason}, simTime still ${row.simTime}`)
  }
  {
    const controlRows = await prisma.simulationJournalEntry.findMany({ where: { simulationId, kind: 'control' }, orderBy: { seq: 'asc' } })
    console.log(`control journal rows: ${JSON.stringify(controlRows.map((r) => r.payload))}`)
    const breachIndex = controlRows.findIndex((r) => r.payload.op === 'isolation_breach')
    if (breachIndex === -1) await fail('no control journal row with payload.op "isolation_breach" was found')
    const breachRow = controlRows[breachIndex]
    if (JSON.stringify(breachRow.payload.tools) !== JSON.stringify(['Bash'])) await fail(`the isolation_breach row's tools are ${JSON.stringify(breachRow.payload.tools)}, expected ["Bash"]`)
    // Read from `packages/control/src/simulation/llm.ts`'s `applyModelDecision`: the automatic
    // isolation-breach halt journals `isolation_breach`, then the halt itself (ruling R12 -- the
    // breach row names what was FOUND, the `halted` row names what was DONE, exactly as every
    // other halt path writes it), then, through `clearAutoRun`, `auto_run_stopped { reason:
    // 'halted' }`. It never journals `model_calls_blocked`, which
    // `packages/control/src/simulation/write.ts`'s `setStatus` writes only for the manual
    // `haltSimulation` verb this automatic halt never calls.
    const afterBreach = controlRows.slice(breachIndex + 1).map((r) => r.payload.op)
    if (JSON.stringify(afterBreach.slice(0, 2)) !== JSON.stringify(['halted', 'auto_run_stopped'])) {
      await fail(`the control journal rows after isolation_breach are ${JSON.stringify(afterBreach)}, expected it to start with ["halted","auto_run_stopped"]`)
    }
    const haltedRow = controlRows[breachIndex + 1]
    if (haltedRow.payload.reason !== 'isolation breach: Bash') await fail(`the halted row's reason is ${JSON.stringify(haltedRow.payload.reason)}, expected 'isolation breach: Bash'`)
    if (controlRows[breachIndex + 2].payload.reason !== 'halted') await fail(`the auto_run_stopped row's reason is ${JSON.stringify(controlRows[breachIndex + 2].payload.reason)}, expected 'halted'`)
    const blocked = controlRows.find((r) => r.payload.op === 'model_calls_blocked')
    if (blocked !== undefined) await fail(`a control journal row with payload.op "model_calls_blocked" was found (seq ${blocked.seq}) -- the automatic isolation-breach halt must never journal it, only the manual haltSimulation verb does`)
    console.log('control journal verified: isolation_breach, halted { reason: "isolation breach: Bash" }, auto_run_stopped { reason: "halted" }, no model_calls_blocked')
  }
  {
    const usageRows = await prisma.simulationModelUsage.findMany({ where: { simulationId }, orderBy: { seq: 'asc' } })
    if (usageRows.length !== 6) await fail(`there are ${usageRows.length} SimulationModelUsage row(s) after the breach, expected 6`)
    const breachUsage = usageRows[5]
    if (breachUsage.costUsd === null || Math.abs(breachUsage.costUsd - BREACH_DECISION_COST) > 1e-9) {
      await fail(`the sixth usage row's costUsd is ${JSON.stringify(breachUsage.costUsd)}, expected ${BREACH_DECISION_COST} (decision-breach.ndjson's own total_cost_usd)`)
    }
    console.log(`usage rows: 6 total, the sixth costing ${breachUsage.costUsd} (the breach fixture's own reported cost)`)
  }
  {
    const decisionRowsAfter = await prisma.simulationJournalEntry.count({ where: { simulationId, kind: 'decision', actorRole: 'purchasing' } })
    if (decisionRowsAfter !== 5) await fail(`there are ${decisionRowsAfter} purchasing decision row(s) after the breach, expected still 5 -- a breach must not write a decision row`)
  }
  console.log('stage 5 (breach halts the run, one more usage row, no further simTime advance) complete')

  // ---- Stage 6: the pre-existing software flow is untouched ----
  const seedSlaveCount = await prisma.slave.count({ where: { team: { workspaceId: SEED_WORKSPACE_ID } } })
  await page.goto(`${baseUrl}/w/${SEED_WORKSPACE_ID}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('slave-card').first(), 'the seeded workspace Overview page a slave card')
  const seedCardCount = await page.getByTestId('slave-card').count()
  if (seedCardCount !== seedSlaveCount) {
    await fail(`the seeded workspace Overview shows ${seedCardCount} slave-card(s), expected ${seedSlaveCount} (matching prisma.slave for that workspace)`)
  }
  console.log(`the seeded workspace's Overview still renders ${seedCardCount} slave card(s), matching prisma -- the software flow is untouched even with the daemon running against it`)

  console.log(
    'PASS: an llm run created from the drawer with consent auto-ran five days against the fake CLI, spending exactly what the fixture ' +
      'reports and applying purchasing\'s proposed place_purchase every day while the other roles stayed on rules, the page\'s own panel ' +
      'matched that spend, and a tool-using answer from a restarted daemon halted the run as an isolation breach with no further step',
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
  // FK-ordered cleanup: the run first (`onDelete: Restrict` on SimulationRun.company blocks the
  // company delete while it exists), then the company (cascades CompanyTeam/CompanySlave), then the
  // template.
  if (simulationId !== null) {
    await prisma.simulationRun.deleteMany({ where: { id: simulationId } }).catch(() => {})
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
