// M31b's own gate (Task 5 brief): a real Chromium (`playwright-core`, no test runner) driving a
// real `next dev` server AND a real orchestrator daemon (`apps/orchestrator/dist/cli.js daemon`)
// -- the same two processes an operator actually runs together -- with the daemon's model calls
// answered by the FAKE `claude` CLI (`packages/providers/test/fake-claude.mjs`, the exact env
// shape `gate-m31a-llm-decisions.mjs` and `apps/orchestrator/test/integration/cli.test.ts`'s
// daemon test use: `SLAVEOFAI_CLAUDE_BIN=node`, `SLAVEOFAI_CLAUDE_ARGS="<abs fake-claude.mjs>
// --fixture decision-software"`). No real `claude` call, no paid model call, anywhere. Shape
// borrowed verbatim from `gate-m31a-llm-decisions.mjs` and `gate-m30-simulation-compare.mjs`:
// dist imports, `findFreePort`, the `next dev` spawn + ready wait, Chromium from `CHROMIUM_PATH`,
// everything created inside `try`, `finally` kills every process this script spawned and cleans
// up in FK order, `exitCode` starts at 1 and is only set to 0 at the very end of a fully-asserted
// run, a FAIL dumps the page's URL, every "M31b Gate"-named row still in the DB, and a full-page
// screenshot into a scratch directory this script creates and prints the path to.
//
// Stage 1 (the company): a gate-owned catalog company, "M31b Gate Software", staffed directly
// with `prisma` (the m10/m11/m29/m30/m31a stage-1 idiom) with the Checkout Platform teams and
// slave roles `packages/db/src/seed.ts:41-50` seeds into the legacy workspace (Management/
// manager, Engineering/Backend, Frontend, DevOps, QA, reviewer, Product/Business Analyst) --
// exactly the roster `packages/simulation/test/software/roster.ts`'s `CHECKOUT_ROSTER` names,
// literally, so the fake CLI's `assign_task { engineerId: "Alex" }` answer (stage 4) targets a
// real engineer. `rosterOf` (every real `createSimulation` call's own roster read) orders both
// teams and slaves by name ascending, not by insertion order; the engineer pool is then ordered
// by id inside the plugin (erratum R17), so neither order can change what this gate measures.
//
// Stage 2 (software A, software B): `/sim`'s drawer, sector `software`, this company, seed 1 for
// both (spec §9's own seed) -- policy A, then policy B, created independently (not cloned; their
// definitions match anyway since `COMPARED_KEYS` never carries policy or its knobs). Both are
// `rules`-provider runs, so they step synchronously through `sim-run-to-day`/`sim-run-to` -- no
// daemon needed for this stage.
//
// Stage 3 (both to day 30, the pinned invariants): `sim-run-to` to day 30 on each, polled against
// `prisma` for `status finished` and `simTime 30`. B's `defectIncidents` must be exactly 0, A's at
// least 4 (spec §3.5's own invariants); `deliveredTasks` is asserted exactly (24 for A, 12 for B,
// spec §9's table), printed before asserting either.
//
// Stage 4 (compare, the software labels): `/sim/compare?a=<A>&b=<B>`, `compareSimulations` (control
// dist) read directly and formatted the identical way `CompareClient.tsx` does, for every key the
// software plugin's own `metricLabels` name -- there is no second list to keep in step with.
//
// Stage 5 (an incident injected, and when it actually lands): a fresh third software run;
// `sim-inject-kind incident`, default day (`simTime + 1` = 1), `sim-inject-area backend`,
// `sim-inject-submit` -- the `external_event` journal row `injectExternalEvent` writes
// immediately (`payload.op 'injected'`, `payload.event.type 'incident'`) is asserted with no step
// at all. The event is scheduled at engine day 1, but `step()`'s own `day` argument is the run's
// simTime BEFORE that step (erratum R16) -- so it takes two `sim-step` clicks, not one, before the
// queue actually pops it and the headline's `open incidents` item reads >= 1; both are asserted
// against what the journal actually shows, printed first.
//
// Stage 6 (an llm `lead`, on the fake fixture): a fourth software run, `decisionProvider llm`,
// model typed into the free-text field, cap $2, consent checked -- `definition.llmRoles` must be
// exactly `["lead"]`. The real daemon (spawned at the top of this script, fixture
// `decision-software`) auto-runs it 5 days; the fixture always answers
// `assign_task { taskId: "t-1", engineerId: "Alex" }`. `roleOrder` is `product, lead, reviewer`
// (`definition.ts`) and `t-1` does not exist until the demo's day-1 request event fires --
// which happens on the step that carries simTime 1 -> 2, not 0 -> 1 (same R16 offset) -- so the
// five `lead` decisions actually read (day 0: `unknown_task`; day 1: `action_applied`; days 2-4:
// `wrong_status`, since a task in progress or done is never `queued` again, per
// `packages/simulation/src/software/model.ts`'s `validate()`), printed before asserting exactly
// that. Five `SimulationModelUsage` rows (`role 'lead'`, `provider 'claude_code'`, the fixture's
// own `total_cost_usd 0.0038` each) and five `decision` journal rows for `lead`
// (`payload.provider 'llm'`) either way.
//
// Stage 7: the pre-existing software flow (the trade sector, M29/M30/M31a's own gates) is
// untouched -- the seeded workspace's Overview still renders its own slave cards.
//
// Teardown (in `finally`): kill the daemon and `next dev`, then delete the four runs, then the
// company (cascades its teams/slaves), then the seven templates.

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
import { compareSimulations } from '../packages/control/dist/simulation.js'

const ACTION_TIMEOUT_MS = 20_000
const NEXT_READY_TIMEOUT_MS = 60_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const DAY_WAIT_TIMEOUT_MS = 60_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

// Exact literals, never suffixed -- typed into real form fields the way an operator would.
// `preflightCleanup` removes any leftovers a prior crashed run left on these exact names.
const COMPANY_NAME = 'M31b Gate Software'
// [department, catalog role, slave name] -- the Checkout Platform crew, literally
// (`packages/simulation/test/software/roster.ts`'s `CHECKOUT_ROSTER`), so "Alex" the backend
// engineer is who the fake CLI's fixed answer actually names.
const ROSTER = [
  ['Management', 'manager', 'Atlas'],
  ['Engineering', 'Backend', 'Alex'],
  ['Engineering', 'Frontend', 'Emma'],
  ['Engineering', 'DevOps', 'Daniel'],
  ['Engineering', 'QA', 'Maya'],
  ['Engineering', 'reviewer', 'Riley'],
  ['Product', 'Business Analyst', 'John'],
]
const SIM_NAME_A = 'M31b Gate A'
const SIM_NAME_B = 'M31b Gate B'
const SIM_NAME_INCIDENT = 'M31b Gate Incident'
const SIM_NAME_LLM = 'M31b Gate LLM'
const DEMO_SEED = 1
const HORIZON = 30
const MODEL_NAME = 'claude-haiku-4-5-20251001'
const CAP_USD = 2
const LEAD_DECISION_COST = 0.0038
// Spec §9's table, seed 1, horizon 30, `rulesProvider`. Erratum R17 orders the engineer pool by id
// inside the plugin, so the roster's own order no longer reaches the run: this gate's DB-ordered
// roster and `policies.test.ts`'s hand-typed one measure the same figures.
const EXPECTED_DELIVERED_A = 24
const EXPECTED_DELIVERED_B = 12

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

/** Removes any "M31b Gate"-named rows a prior interrupted run left behind, in the same FK order
 *  the `finally` block below uses. Safe to run against an empty slate. */
async function preflightCleanup() {
  const staleCompany = await prisma.company.findUnique({ where: { name: COMPANY_NAME } })
  if (staleCompany !== null) {
    await prisma.simulationRun.deleteMany({ where: { companyId: staleCompany.id } }).catch(() => {})
    await prisma.company.delete({ where: { id: staleCompany.id } }).catch(() => {})
  }
  const staleTemplates = await prisma.slaveTemplate.findMany({ where: { name: { startsWith: 'M31b Gate ' } } })
  for (const template of staleTemplates) await prisma.slaveTemplate.delete({ where: { id: template.id } }).catch(() => {})
}

let exitCode = 1
let templateIds = []
let companyId = null
const simulationIds = []
let nextProc = null
let daemonProc = null
let browser = null
let page = null
let diagDir = null

/** Every "M31b Gate"-named row still in the DB, for a FAIL's diagnostic dump. */
async function dumpSimRows() {
  const templates = await prisma.slaveTemplate.findMany({ where: { name: { startsWith: 'M31b Gate ' } } })
  const companies = await prisma.company.findMany({
    where: { name: COMPANY_NAME },
    include: {
      teams: { include: { slaves: true } },
      simulations: { select: { id: true, name: true, status: true, simTime: true, version: true, decisionProvider: true, model: true, maxModelCostUsd: true, autoRunEveryMs: true, autoRunUntilDay: true, haltedReason: true } },
    },
  })
  return JSON.stringify({ templates, companies })
}

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
 *  `<select data-testid="model-select">` to the free-text field the "other…" option reveals. */
async function switchModelToFreeText() {
  const select = page.getByTestId('model-select')
  await waitVisible(select, 'the model-select dropdown (claude_code listing)')
  await select.selectOption({ value: '__other__' })
  await waitVisible(page.getByTestId('new-simulation-model'), 'the free-text model input after choosing "other…"')
}

/** Spawns the real orchestrator daemon against the seed workspace, its model calls answered by
 *  the fake CLI on the `decision-software` fixture. */
function spawnDaemon() {
  const proc = spawn('node', ['apps/orchestrator/dist/cli.js', 'daemon', '--workspace', SEED_WORKSPACE_ID, '--period', '250'], {
    cwd: repoRoot,
    // M32 item 7: this daemon MAKES MODEL CALLS; the flag makes it refuse to start rather than
    // fall back to the real `claude` if the fake wiring beside it is ever lost.
    env: { ...loopbackChildEnv(), SLAVEOFAI_CLAUDE_BIN: 'node', SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture decision-software`, SLAVEOFAI_REQUIRE_FAKE_CLI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.on('data', (chunk) => process.stdout.write(`[daemon] ${chunk}`))
  proc.stderr.on('data', (chunk) => process.stderr.write(`[daemon] ${chunk}`))
  return proc
}

/** Creates a software simulation from the drawer (rules provider), navigates to its page, and
 *  confirms sector/policy/seed/simTime directly against `prisma`. */
async function createSoftwareSimOnPage(baseUrl, { name, policy, seed }) {
  await page.goto(`${baseUrl}/sim`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  const drawer = page.getByTestId('new-simulation-drawer')
  await clickUntil(page.getByTestId('new-simulation'), async () => drawer.first().isVisible(), 'the "+ New simulation" button')
  await waitVisible(drawer, 'the new-simulation drawer')

  await selectReliably(page.getByTestId('new-simulation-sector'), 'software', { value: 'software' }, 'the new-simulation sector select')
  await selectReliably(page.getByTestId('new-simulation-company'), companyId, { value: companyId }, 'the new-simulation company select')
  await fillReliably(page.getByTestId('new-simulation-name'), name, 'the new-simulation name field')
  await selectReliably(page.getByTestId('new-simulation-policy'), policy, { value: policy }, 'the new-simulation policy select')
  await fillReliably(page.getByTestId('new-simulation-seed'), String(seed), 'the new-simulation seed field')

  const beforeCount = await prisma.simulationRun.count({ where: { companyId, name } })
  await clickUntil(
    page.getByTestId('new-simulation-submit'),
    async () => /\/sim\/[^/]+$/.test(new URL(page.url()).pathname) && (await prisma.simulationRun.count({ where: { companyId, name } })) > beforeCount,
    `submitting the "${name}" new-simulation form`,
  )
  const match = /\/sim\/([^/]+)$/.exec(new URL(page.url()).pathname)
  if (match === null) await fail(`the URL after submitting "${name}" is ${JSON.stringify(page.url())}, expected /sim/<id>`)
  const simulationId = match[1]
  const row = await prisma.simulationRun.findUnique({ where: { id: simulationId } })
  if (row === null) await fail(`"${name}" (${simulationId}) is missing from the DB right after creation`)
  if (row.sector !== 'software') await fail(`"${name}"'s stored sector is ${JSON.stringify(row.sector)}, expected 'software'`)
  if (row.decisionProvider !== 'rules') await fail(`"${name}"'s stored decisionProvider is ${JSON.stringify(row.decisionProvider)}, expected 'rules'`)
  if (row.definition.policy !== policy) await fail(`"${name}"'s stored definition.policy is ${JSON.stringify(row.definition.policy)}, expected ${JSON.stringify(policy)}`)
  if (row.definition.seed !== seed) await fail(`"${name}"'s stored definition.seed is ${JSON.stringify(row.definition.seed)}, expected ${seed}`)
  if (row.simTime !== 0) await fail(`"${name}"'s stored simTime is ${JSON.stringify(row.simTime)}, expected 0 right after creation`)
  console.log(`"${name}" created and navigated to: ${simulationId} -- verified against prisma: software/rules, policy ${policy}, seed ${seed}, day 0`)
  return simulationId
}

/** Runs the (rules-provider) run currently on screen to `untilDay` via `sim-run-to-day` /
 *  `sim-run-to` (in-request, synchronous stepping -- no daemon needed), polling `prisma` for the
 *  finished state. */
async function runToDayOnPage(simulationId, untilDay, name) {
  await waitVisible(page.getByTestId('sim-run-to-day'), `"${name}"'s "run to day" field`)
  await fillReliably(page.getByTestId('sim-run-to-day'), String(untilDay), `"${name}"'s "run to day" field`)
  await clickUntil(
    page.getByTestId('sim-run-to'),
    async () => {
      const row = await prisma.simulationRun.findUnique({ where: { id: simulationId } })
      return row !== null && (row.simTime >= untilDay || row.status === 'finished' || row.status === 'halted')
    },
    `"Run to day" on "${name}"`,
  )
  const row = await prisma.simulationRun.findUnique({ where: { id: simulationId } })
  if (row === null || row.simTime !== untilDay) await fail(`"${name}" did not reach simTime ${untilDay} -- last row ${JSON.stringify(row)}`)
  if (row.status !== 'finished') await fail(`"${name}" reached simTime ${untilDay} but its status is ${JSON.stringify(row.status)}, expected 'finished'`)
  console.log(`"${name}" ran to day ${untilDay}, status finished -- verified against prisma`)
}

/** `CompareClient.tsx`'s `deltaCount`: `+N`, the typographic minus `−N`, or `0`. Software carries
 *  no `money`-kind metric, so this is the only formatter this gate needs. */
function deltaCount(value) {
  if (value > 0) return `+${value}`
  if (value < 0) return `−${Math.abs(value)}`
  return '0'
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m31b-software-sector-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  const chromiumPath = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- set CHROMIUM_PATH to a real executable (e.g. a playwright-installed ` +
        `chromium under ~/.cache/ms-playwright) before running this gate`,
    )
  }
  // Same reasoning as `gate-m31a-llm-decisions.mjs`'s own note: this gate HARDCODES
  // `SLAVEOFAI_CLAUDE_BIN`/`SLAVEOFAI_CLAUDE_ARGS` on the one daemon it spawns, so no outer
  // environment precondition is needed -- only that the fake CLI it points at actually exists.
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`fake claude CLI not found at ${FAKE_CLAUDE}`)

  await preflightCleanup()

  // 1. The gate-owned software company, staffed directly with prisma.
  const templateByRole = {}
  for (const [, role] of ROSTER) {
    if (templateByRole[role] !== undefined) continue
    const template = await prisma.slaveTemplate.create({ data: { name: `M31b Gate ${role}`, role } })
    templateByRole[role] = template.id
  }
  templateIds = Object.values(templateByRole)
  const company = await prisma.company.create({ data: { name: COMPANY_NAME } })
  companyId = company.id
  const teamByDepartment = {}
  for (const [department, role, slaveName] of ROSTER) {
    if (teamByDepartment[department] === undefined) {
      const team = await prisma.companyTeam.create({ data: { companyId, name: department } })
      teamByDepartment[department] = team.id
    }
    await prisma.companySlave.create({ data: { companyTeamId: teamByDepartment[department], templateId: templateByRole[role], name: slaveName } })
  }
  console.log(`company created and staffed directly: ${companyId} (${COMPANY_NAME}), ${templateIds.length} templates, ${ROSTER.length} slaves`)

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
  nextProc.on('exit', () => { nextExited = true })
  nextProc.on('error', (error) => { nextExited = true; console.error('[next] failed to start:', error) })

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

  // 3. The real daemon, on the `decision-software` fixture -- idle for every rules-provider run
  // below (its tick finds nothing due), live for stage 6's llm run.
  daemonProc = spawnDaemon()
  console.log(`daemon spawned (pid ${daemonProc.pid}), period 250ms, fixture decision-software`)

  // 4. Launch the real browser.
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  page.on('pageerror', (error) => console.error(`[browser:pageerror] ${error}`))

  // ---- Stage 2/3: software A and B, run to day 30, the pinned invariants ----
  const simulationIdA = await createSoftwareSimOnPage(baseUrl, { name: SIM_NAME_A, policy: 'A', seed: DEMO_SEED })
  simulationIds.push(simulationIdA)
  await runToDayOnPage(simulationIdA, HORIZON, SIM_NAME_A)
  const simulationIdB = await createSoftwareSimOnPage(baseUrl, { name: SIM_NAME_B, policy: 'B', seed: DEMO_SEED })
  simulationIds.push(simulationIdB)
  await runToDayOnPage(simulationIdB, HORIZON, SIM_NAME_B)
  console.log('stage 2/3 (software A and B, both run to day 30) complete')

  {
    const statusA = await prisma.simulationRun.findUnique({ where: { id: simulationIdA } })
    const statusB = await prisma.simulationRun.findUnique({ where: { id: simulationIdB } })
    // Both runs' metrics come from `compareSimulations` below (it recomputes them from the
    // journal); read here too so the pinned-invariant checks can print what was actually found
    // before asserting it, per house style.
    const comparison = await compareSimulations(simulationIdA, simulationIdB)
    if (!comparison.ok) await fail(`compareSimulations(${simulationIdA}, ${simulationIdB}) refused: ${JSON.stringify(comparison.error)}`)
    const { a, b } = comparison.value
    console.log(`A metrics: ${JSON.stringify(a.metrics)}`)
    console.log(`B metrics: ${JSON.stringify(b.metrics)}`)
    if (b.metrics.defectIncidents !== 0) await fail(`B's defectIncidents is ${b.metrics.defectIncidents}, expected exactly 0 (spec §3.5's own invariant)`)
    if (!(a.metrics.defectIncidents >= 4)) await fail(`A's defectIncidents is ${a.metrics.defectIncidents}, expected >= 4 (spec §3.5's own invariant)`)
    if (a.metrics.deliveredTasks !== EXPECTED_DELIVERED_A) await fail(`A's deliveredTasks is ${a.metrics.deliveredTasks}, expected exactly ${EXPECTED_DELIVERED_A} (spec §9's table)`)
    if (b.metrics.deliveredTasks !== EXPECTED_DELIVERED_B) await fail(`B's deliveredTasks is ${b.metrics.deliveredTasks}, expected exactly ${EXPECTED_DELIVERED_B}`)
    console.log(`pinned invariants verified: B.defectIncidents 0, A.defectIncidents ${a.metrics.defectIncidents} >= 4, deliveredTasks A ${a.metrics.deliveredTasks} / B ${b.metrics.deliveredTasks} (statuses ${statusA.status}/${statusB.status})`)

    // ---- Stage 4: compare, the software labels ----
    await page.goto(`${baseUrl}/sim/compare?a=${simulationIdA}&b=${simulationIdB}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
    await waitVisible(page.getByTestId('sim-compare-strip'), 'the compare page strip')
    for (const key of Object.keys(comparison.value.metricLabels)) {
      const expected = deltaCount(comparison.value.deltas[key])
      const actual = (await page.getByTestId(`sim-compare-delta-${key}`).textContent())?.trim()
      if (actual !== expected) await fail(`sim-compare-delta-${key} reads ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)} (compareSimulations' own delta, formatted the way CompareClient.tsx does)`)
    }
    console.log(`stage 4 (compare) complete: every sim-compare-delta-* over the software plugin's own ${Object.keys(comparison.value.metricLabels).length} metric labels matches compareSimulations' own deltas`)
  }

  // ---- Stage 5: a fresh software run, an incident injected, and when it actually lands ----
  const simulationIdIncident = await createSoftwareSimOnPage(baseUrl, { name: SIM_NAME_INCIDENT, policy: 'A', seed: DEMO_SEED })
  simulationIds.push(simulationIdIncident)
  await clickUntil(page.getByTestId('sim-inject-open'), async () => page.getByTestId('sim-inject-kind').isVisible(), 'the "Add external event" button')
  await selectReliably(page.getByTestId('sim-inject-kind'), 'incident', { value: 'incident' }, 'the sim-inject-kind select')
  await fillReliably(page.getByTestId('sim-inject-day'), '1', 'the sim-inject-day field')
  await selectReliably(page.getByTestId('sim-inject-area'), 'backend', { value: 'backend' }, 'the sim-inject-area select')
  await clickUntil(
    page.getByTestId('sim-inject-submit'),
    async () => {
      const rows = await prisma.simulationJournalEntry.findMany({ where: { simulationId: simulationIdIncident, kind: 'external_event' } })
      return rows.some((r) => r.payload.op === 'injected' && r.payload.event?.type === 'incident')
    },
    'the "Add" (inject) button',
  )
  {
    const injectedRows = await prisma.simulationJournalEntry.findMany({ where: { simulationId: simulationIdIncident, kind: 'external_event' }, orderBy: { seq: 'asc' } })
    console.log(`external_event rows right after inject: ${JSON.stringify(injectedRows.map((r) => r.payload))}`)
    const injected = injectedRows.find((r) => r.payload.op === 'injected')
    if (injected === undefined) await fail(`no external_event journal row with payload.op "injected" was found for "${SIM_NAME_INCIDENT}" right after submitting the inject form`)
    if (injected.payload.event?.type !== 'incident') await fail(`the injected external_event row's event.type is ${JSON.stringify(injected.payload.event?.type)}, expected 'incident'`)
    if (injected.payload.day !== 1) await fail(`the injected external_event row's day is ${JSON.stringify(injected.payload.day)}, expected 1`)
  }
  // Erratum R16: the event fires when the run's simTime carries 1 -> 2 (`step()`'s own `day`
  // argument is the pre-step simTime), not on the very first step -- so this steps until the
  // queue actually pops it (or a bounded number of steps have been tried), rather than assuming
  // one step suffices.
  {
    let poppedRow = null
    for (let stepsTaken = 0; stepsTaken < 3 && poppedRow === null; stepsTaken++) {
      const row = await prisma.simulationRun.findUnique({ where: { id: simulationIdIncident } })
      const beforeSimTime = row.simTime
      await waitVisible(page.getByTestId('sim-step'), `"${SIM_NAME_INCIDENT}"'s sim-step button`)
      await clickUntil(
        page.getByTestId('sim-step'),
        async () => {
          const after = await prisma.simulationRun.findUnique({ where: { id: simulationIdIncident } })
          return after !== null && after.simTime > beforeSimTime
        },
        `"Step 1 day" on "${SIM_NAME_INCIDENT}" (attempt ${stepsTaken + 1})`,
      )
      const rows = await prisma.simulationJournalEntry.findMany({ where: { simulationId: simulationIdIncident, kind: 'external_event' } })
      poppedRow = rows.find((r) => r.payload.op === undefined && r.payload.event?.type === 'incident') ?? null
      console.log(`after step ${stepsTaken + 1}: queue-popped incident row ${poppedRow === null ? 'not yet found' : JSON.stringify(poppedRow.payload)}`)
    }
    if (poppedRow === null) await fail(`the injected incident never popped the queue (no external_event row with payload.event.type "incident" and no payload.op) after 3 steps on "${SIM_NAME_INCIDENT}"`)
  }
  await page.reload({ waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('sim-company'), `"${SIM_NAME_INCIDENT}"'s "Simulated company" panel`)
  {
    const openIncidentsText = (await page.getByTestId('sim-company-open-incidents').textContent())?.trim()
    const openIncidents = Number.parseInt(openIncidentsText ?? '', 10)
    console.log(`"${SIM_NAME_INCIDENT}"'s headline open-incidents reads ${JSON.stringify(openIncidentsText)}`)
    if (!(Number.isInteger(openIncidents) && openIncidents >= 1)) await fail(`sim-company-open-incidents reads ${JSON.stringify(openIncidentsText)}, expected an integer >= 1`)
  }
  console.log('stage 5 (an incident injected, and confirmed only once the queue actually pops it) complete')

  // ---- Stage 6: an llm `lead` run on the fake fixture, auto-run 5 days ----
  let simulationIdLlm
  {
    await page.goto(`${baseUrl}/sim`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
    const drawer = page.getByTestId('new-simulation-drawer')
    await clickUntil(page.getByTestId('new-simulation'), async () => drawer.first().isVisible(), 'the "+ New simulation" button')
    await waitVisible(drawer, 'the new-simulation drawer')

    await selectReliably(page.getByTestId('new-simulation-sector'), 'software', { value: 'software' }, 'the new-simulation sector select')
    await selectReliably(page.getByTestId('new-simulation-company'), companyId, { value: companyId }, 'the new-simulation company select')
    await fillReliably(page.getByTestId('new-simulation-name'), SIM_NAME_LLM, 'the new-simulation name field')
    await selectReliably(page.getByTestId('new-simulation-policy'), 'A', { value: 'A' }, 'the new-simulation policy select')
    await fillReliably(page.getByTestId('new-simulation-seed'), String(DEMO_SEED), 'the new-simulation seed field')
    await selectReliably(page.getByTestId('new-simulation-provider'), 'llm', { value: 'llm' }, 'the decision-provider select')
    await switchModelToFreeText()
    await fillReliably(page.getByTestId('new-simulation-model'), MODEL_NAME, 'the model free-text field')
    await fillReliably(page.getByTestId('new-simulation-cap'), String(CAP_USD), 'the cost-cap field')
    await checkReliably(page.getByTestId('new-simulation-consent'), 'the paid-model-calls consent checkbox')

    const beforeCount = await prisma.simulationRun.count({ where: { companyId, name: SIM_NAME_LLM } })
    await clickUntil(
      page.getByTestId('new-simulation-submit'),
      async () => /\/sim\/[^/]+$/.test(new URL(page.url()).pathname) && (await prisma.simulationRun.count({ where: { companyId, name: SIM_NAME_LLM } })) > beforeCount,
      `submitting the "${SIM_NAME_LLM}" new-simulation form`,
    )
    const match = /\/sim\/([^/]+)$/.exec(new URL(page.url()).pathname)
    if (match === null) await fail(`the URL after submitting "${SIM_NAME_LLM}" is ${JSON.stringify(page.url())}, expected /sim/<id>`)
    simulationIdLlm = match[1]
    simulationIds.push(simulationIdLlm)
    const row = await prisma.simulationRun.findUnique({ where: { id: simulationIdLlm } })
    if (row === null) await fail(`"${SIM_NAME_LLM}" (${simulationIdLlm}) is missing from the DB right after creation`)
    if (row.decisionProvider !== 'llm') await fail(`"${SIM_NAME_LLM}"'s stored decisionProvider is ${JSON.stringify(row.decisionProvider)}, expected 'llm'`)
    if (row.modelProvider !== 'claude_code') await fail(`"${SIM_NAME_LLM}"'s stored modelProvider is ${JSON.stringify(row.modelProvider)}, expected 'claude_code'`)
    if (row.model !== MODEL_NAME) await fail(`"${SIM_NAME_LLM}"'s stored model is ${JSON.stringify(row.model)}, expected ${JSON.stringify(MODEL_NAME)}`)
    if (row.maxModelCostUsd !== CAP_USD) await fail(`"${SIM_NAME_LLM}"'s stored maxModelCostUsd is ${JSON.stringify(row.maxModelCostUsd)}, expected ${CAP_USD}`)
    if (JSON.stringify(row.definition.llmRoles) !== JSON.stringify(['lead'])) await fail(`"${SIM_NAME_LLM}"'s stored definition.llmRoles is ${JSON.stringify(row.definition.llmRoles)}, expected ["lead"]`)
    if (row.simTime !== 0) await fail(`"${SIM_NAME_LLM}"'s stored simTime is ${JSON.stringify(row.simTime)}, expected 0 right after creation`)
    console.log(`"${SIM_NAME_LLM}" created and navigated to: ${simulationIdLlm} -- verified against prisma: llm/claude_code/${MODEL_NAME}, cap ${CAP_USD}, llmRoles ["lead"], day 0`)
  }
  console.log('stage 6a (the llm run created from the drawer, with consent) complete')

  await waitVisible(page.getByTestId('sim-strip'), `"${SIM_NAME_LLM}"'s run page's strip`)
  await selectReliably(page.getByTestId('sim-auto-run-every'), '250', { value: '250' }, 'the auto-run "every" select')
  await fillReliably(page.getByTestId('sim-auto-run-until'), '5', 'the auto-run "until day" field')
  await clickUntil(
    page.getByTestId('sim-auto-run-start'),
    async () => {
      const row = await prisma.simulationRun.findUnique({ where: { id: simulationIdLlm } })
      return row !== null && row.autoRunEveryMs === 250 && row.autoRunUntilDay === 5
    },
    'the "Auto-run" button',
  )
  console.log(`"${SIM_NAME_LLM}" armed with auto-run every 250ms until day 5 -- verified against prisma`)
  {
    const deadline = Date.now() + DAY_WAIT_TIMEOUT_MS
    let row = null
    while (Date.now() < deadline) {
      row = await prisma.simulationRun.findUnique({ where: { id: simulationIdLlm } })
      if (row !== null && row.simTime >= 5) break
      if (row !== null && (row.status === 'halted' || row.status === 'finished')) break
      await delay(200)
    }
    if (row === null || row.simTime < 5) await fail(`"${SIM_NAME_LLM}" did not reach simTime >= 5 within ${DAY_WAIT_TIMEOUT_MS}ms -- last row ${JSON.stringify(row)}`)
    if (row.status !== 'running') await fail(`"${SIM_NAME_LLM}" reached simTime ${row.simTime} but its status is ${JSON.stringify(row.status)}, expected 'running'`)
    console.log(`"${SIM_NAME_LLM}" reached simTime ${row.simTime} with status running -- the daemon decided against the fake CLI five times`)
  }
  console.log('stage 6b (auto-run through the UI, five llm decisions made by the daemon) complete')

  // ---- Stage 6c: five usage rows, five lead decision rows, and exactly what the journal shows
  // for applied/rejected (erratum R16 -- printed before asserting) ----
  {
    const usageRows = await prisma.simulationModelUsage.findMany({ where: { simulationId: simulationIdLlm }, orderBy: { seq: 'asc' } })
    console.log(`usage rows: ${JSON.stringify(usageRows.map((r) => ({ seq: r.seq, role: r.role, provider: r.provider, costUsd: r.costUsd, simTime: r.simTime })))}`)
    if (usageRows.length !== 5) await fail(`there are ${usageRows.length} SimulationModelUsage row(s) for "${SIM_NAME_LLM}", expected 5`)
    for (const row of usageRows) {
      if (row.role !== 'lead') await fail(`usage row seq ${row.seq} has role ${JSON.stringify(row.role)}, expected 'lead'`)
      if (row.provider !== 'claude_code') await fail(`usage row seq ${row.seq} has provider ${JSON.stringify(row.provider)}, expected 'claude_code'`)
      if (row.costUsd === null || Math.abs(row.costUsd - LEAD_DECISION_COST) > 1e-9) await fail(`usage row seq ${row.seq} has costUsd ${JSON.stringify(row.costUsd)}, expected ${LEAD_DECISION_COST}`)
    }

    const decisionRows = await prisma.simulationJournalEntry.findMany({ where: { simulationId: simulationIdLlm, kind: 'decision', actorRole: 'lead' }, orderBy: { seq: 'asc' } })
    if (decisionRows.length !== 5) await fail(`there are ${decisionRows.length} lead decision row(s), expected 5`)
    for (const row of decisionRows) {
      if (row.payload.provider !== 'llm') await fail(`lead decision row seq ${row.seq} has payload.provider ${JSON.stringify(row.payload.provider)}, expected 'llm'`)
      if (row.payload.model !== MODEL_NAME) await fail(`lead decision row seq ${row.seq} has payload.model ${JSON.stringify(row.payload.model)}, expected ${JSON.stringify(MODEL_NAME)}`)
    }
    console.log(`decision rows verified: 5 lead rows provider 'llm', model ${MODEL_NAME}`)

    // roleOrder is product -> lead -> reviewer (definition.ts); t-1 does not exist until the
    // demo's day-1 request fires, which -- per erratum R16 -- happens on the step carrying
    // simTime 1 -> 2, journalled at simTime 1. validate() (model.ts) rejects assign_task on any
    // taskId that is not currently 'queued'.
    const outcomeRows = await prisma.simulationJournalEntry.findMany({
      where: { simulationId: simulationIdLlm, actorRole: 'lead', kind: { in: ['action_applied', 'action_rejected'] } },
      orderBy: { seq: 'asc' },
    })
    const bySimTime = outcomeRows.map((r) => ({ simTime: r.simTime, kind: r.kind, reason: r.payload.reason?.kind ?? null, action: r.payload.action ?? null }))
    console.log(`lead outcome rows by simTime: ${JSON.stringify(bySimTime)}`)
    const applied = outcomeRows.filter((r) => r.kind === 'action_applied')
    const rejected = outcomeRows.filter((r) => r.kind === 'action_rejected')
    if (applied.length !== 1) await fail(`lead has ${applied.length} action_applied row(s), expected exactly 1`)
    const appliedAction = applied[0].payload.action
    if (appliedAction?.type !== 'assign_task' || appliedAction.params?.taskId !== 't-1' || appliedAction.params?.engineerId !== 'Alex') {
      await fail(`lead's applied action is ${JSON.stringify(appliedAction)}, expected assign_task { taskId: 't-1', engineerId: 'Alex' }`)
    }
    if (rejected.length !== 4) await fail(`lead has ${rejected.length} action_rejected row(s), expected exactly 4`)
    const rejectionKinds = rejected.map((r) => r.payload.reason?.kind)
    for (const kind of rejectionKinds) {
      if (kind !== 'unknown_task' && kind !== 'wrong_status') await fail(`a lead action_rejected row's reason.kind is ${JSON.stringify(kind)}, expected 'unknown_task' or 'wrong_status'`)
    }
    console.log(`stage 6c verified: 1 action_applied (assign_task t-1 -> Alex), 4 action_rejected (${JSON.stringify(rejectionKinds)}) -- matching what model.ts's validate() and definition.ts's roleOrder actually produce`)
  }

  // ---- Stage 7: the pre-existing software flow is untouched ----
  const seedSlaveCount = await prisma.slave.count({ where: { team: { workspaceId: SEED_WORKSPACE_ID } } })
  await page.goto(`${baseUrl}/w/${SEED_WORKSPACE_ID}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('slave-card').first(), 'the seeded workspace Overview page a slave card')
  const seedCardCount = await page.getByTestId('slave-card').count()
  if (seedCardCount !== seedSlaveCount) {
    await fail(`the seeded workspace Overview shows ${seedCardCount} slave-card(s), expected ${seedSlaveCount} (matching prisma.slave for that workspace)`)
  }
  console.log(`the seeded workspace's Overview still renders ${seedCardCount} slave card(s), matching prisma -- the software sector is untouched even with the daemon running against it`)

  console.log(
    'PASS: software A and B ran to day 30 with the pinned invariants (B zero defects, A at least four, exact deliveredTasks), ' +
      'compare showed correct deltas over the software labels, an injected incident showed up in the journal immediately and in the ' +
      'headline once the queue actually popped it, and an llm lead run spent exactly what the fixture reports across five days, applying ' +
      'its one legal assignment and being rejected the other four exactly as model.ts and definition.ts predict',
  )
  exitCode = 0
} finally {
  if (browser !== null) await browser.close().catch(() => {})
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
  if (simulationIds.length > 0) {
    await prisma.simulationRun.deleteMany({ where: { id: { in: simulationIds } } }).catch(() => {})
  }
  if (companyId !== null) {
    await prisma.simulationRun.deleteMany({ where: { companyId } }).catch(() => {})
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {})
  }
  for (const id of templateIds) {
    await prisma.slaveTemplate.delete({ where: { id } }).catch(() => {})
  }
  await prisma.$disconnect()
}

process.exit(exitCode)
