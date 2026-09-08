// M33's own gate (spec §5): a real Chromium (`playwright-core`, no test runner) driving a real
// `next dev` server -- and NOTHING else. No daemon is spawned, no model call is made, no fake CLI
// is wired: adoption starts nothing (§1 principle 3), and this gate proves it by having nothing
// around that could have started anything. Shape borrowed from `gate-m31b-software-sector.mjs`
// minus every daemon/fake-CLI line: dist imports, `findFreePort`, the `next dev` spawn + ready
// wait, Chromium from `CHROMIUM_PATH`, everything created inside `try`, `finally` kills the one
// process this script spawned and cleans up in FK order, `exitCode` starts at 1 and is only set to
// 0 at the very end of a fully-asserted run, a FAIL dumps the page's URL, every "M33 Gate"-named
// row still in the DB, and a full-page screenshot into a scratch directory this script creates and
// prints the path to.
//
// Stage 1 (the company): a gate-owned catalog company, "M33 Gate Software", staffed directly with
// `prisma` (the m10/m11/m29/m30/m31a/m31b stage-1 idiom) with the Checkout Platform teams and
// slave roles `packages/db/src/seed.ts` seeds into the legacy workspace (Management/manager,
// Engineering/Backend, Frontend, DevOps, QA, reviewer, Product/Business Analyst) -- the roster
// `packages/simulation/test/software/roster.ts`'s `CHECKOUT_ROSTER` names, so the software
// definition makes Atlas its `lead`, Riley its `reviewer`, John its `product`, and the four
// engineers carry their expertise.
//
// Stage 2 (the run): `/sim`'s drawer, sector `software`, this company, seed 1, policy A, named
// "M33 Gate Run" -- exactly `gate-m31b`'s `createSoftwareSimOnPage`. It is never stepped: adoption
// reads the frozen definition and the CURRENT roster, not the run's progress.
//
// Stage 3 (the workspace): the real CLI, `create-workspace --name "M33 Gate Project" --repo <temp
// git repo> --verify true`, on a repository `makeRepo` (gate-m11's) makes for the purpose -- the
// same verb an operator uses, so the workspace has exactly the columns `createWorkspace` writes
// and no company. Its `budgetUsd` is read here and re-checked after adoption (§1 principle 2).
//
// Stage 4 (adopt from the UI): `/sim/<runId>`, `sim-adopt-open`, the drawer's roles table read row
// by row (Atlas: run role `lead`, becomes `manager`; Riley `reviewer`/`reviewer`; Alex
// `backend`/`Backend`; John `product`/`Business Analyst` -- controller ruling R2), the proposal
// (`4` / `3`, autoMerge `off (locked)`), no model box on a `rules` run, the gate's workspace
// selected, submit, and the URL becoming `/w/<workspaceId>`.
//
// Stage 5 (the workspace page and rows): `ws-adopted-from` names the run and links to its page;
// seven `slave-card`s; seven `Slave` rows with the translated roles, `requiredRole` null on every
// one; the workspace's `companyId`, `adoptedFromSimulationId`, `maxConcurrentRuns 4`, `maxAttempts
// 3`, `autoMerge false`, `budgetUsd` untouched.
//
// Stage 6 (nothing started): zero `SlaveRun`s reachable from the workspace, zero `Task`s, zero
// `run.started` events, `haltedReason` null -- and the only process this script ever spawned is
// `next dev`.
//
// Stage 7 (the journal): exactly one `control` row with `payload.op 'adopted'` on the run, naming
// the workspace by id and name. Every measured value is printed before it is asserted.
//
// Teardown (in `finally`): kill `next dev`, then the workspace's events, the workspace (cascades
// its Team/Slave rows), the run, the company (cascades its teams/slaves), the templates, and the
// temp repository directory.

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

// Exact literals, never suffixed -- typed into real form fields the way an operator would.
// `preflightCleanup` removes any leftovers a prior crashed run left on these exact names.
const COMPANY_NAME = 'M33 Gate Software'
const TEMPLATE_PREFIX = 'M33 Gate '
// [department, catalog role, slave name] -- the Checkout Platform crew, literally
// (`packages/simulation/test/software/roster.ts`'s `CHECKOUT_ROSTER`).
const ROSTER = [
  ['Management', 'manager', 'Atlas'],
  ['Engineering', 'Backend', 'Alex'],
  ['Engineering', 'Frontend', 'Emma'],
  ['Engineering', 'DevOps', 'Daniel'],
  ['Engineering', 'QA', 'Maya'],
  ['Engineering', 'reviewer', 'Riley'],
  ['Product', 'Business Analyst', 'John'],
]
const SIM_NAME = 'M33 Gate Run'
const WORKSPACE_NAME = 'M33 Gate Project'
const DEMO_SEED = 1
const POLICY = 'A'
// Spec §3's proposal for a policy-A run with four engineers: `engineers.length` / 3.
const EXPECTED_MAX_CONCURRENT = 4
const EXPECTED_MAX_ATTEMPTS = 3
// Controller ruling R2 (spec §3, T1-E5): what the drawer shows as the run's role and what
// adoption actually writes to `Slave.role`. Every other member keeps the catalog role.
const EXPECTED_DRAWER_ROWS = {
  Atlas: { role: 'lead', runtimeRole: 'manager' },
  Riley: { role: 'reviewer', runtimeRole: 'reviewer' },
  Alex: { role: 'backend', runtimeRole: 'Backend' },
  John: { role: 'product', runtimeRole: 'Business Analyst' },
}
const EXPECTED_SLAVE_ROLES = { Atlas: 'manager', Riley: 'reviewer', Alex: 'Backend', John: 'Business Analyst' }

/** Same as `gate-m11-shell.mjs`'s `makeRepo` -- a real repository, because `createWorkspace`
 *  probes the path for a git work tree and a `main` branch before it writes a row. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m33-adopt-repo-'))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
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

/** Deletes one workspace the way the `finally` block does: its events first (no FK, but the log
 *  must not outlive the project it names), then the row, which cascades Team/Slave. */
async function deleteWorkspace(id) {
  await prisma.executionEvent.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.workspace.delete({ where: { id } }).catch(() => {})
}

/** Removes any "M33 Gate"-named rows a prior interrupted run left behind, in the same FK order
 *  the `finally` block below uses. Safe to run against an empty slate. */
async function preflightCleanup() {
  const staleWorkspace = await prisma.workspace.findUnique({ where: { name: WORKSPACE_NAME } })
  if (staleWorkspace !== null) await deleteWorkspace(staleWorkspace.id)
  const staleCompany = await prisma.company.findUnique({ where: { name: COMPANY_NAME } })
  if (staleCompany !== null) {
    await prisma.simulationRun.deleteMany({ where: { companyId: staleCompany.id } }).catch(() => {})
    await prisma.company.delete({ where: { id: staleCompany.id } }).catch(() => {})
  }
  const staleTemplates = await prisma.slaveTemplate.findMany({ where: { name: { startsWith: TEMPLATE_PREFIX } } })
  for (const template of staleTemplates) await prisma.slaveTemplate.delete({ where: { id: template.id } }).catch(() => {})
}

let exitCode = 1
let templateIds = []
let companyId = null
let simulationId = null
let workspaceId = null
let repoPath = null
let nextProc = null
let browser = null
let page = null
let diagDir = null

/** Every "M33 Gate"-named row still in the DB, for a FAIL's diagnostic dump. */
async function dumpGateRows() {
  const templates = await prisma.slaveTemplate.findMany({ where: { name: { startsWith: TEMPLATE_PREFIX } } })
  const companies = await prisma.company.findMany({
    where: { name: COMPANY_NAME },
    include: {
      teams: { include: { slaves: true } },
      simulations: { select: { id: true, name: true, status: true, simTime: true, version: true, haltedReason: true } },
    },
  })
  const workspaces = await prisma.workspace.findMany({
    where: { name: WORKSPACE_NAME },
    select: { id: true, companyId: true, adoptedFromSimulationId: true, maxConcurrentRuns: true, maxAttempts: true, autoMerge: true, budgetUsd: true, haltedReason: true, teams: { select: { name: true, slaves: { select: { name: true, role: true, requiredRole: true } } } } },
  })
  return JSON.stringify({ templates, companies, workspaces })
}

async function fail(message) {
  let screenshotPath = null
  if (page !== null) {
    screenshotPath = join(diagDir, `failure-${Date.now()}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
  }
  const dump = await dumpGateRows().catch((cause) => `<could not dump gate rows: ${cause instanceof Error ? cause.message : String(cause)}>`)
  const url = page !== null ? page.url() : '<no page>'
  throw new Error(`${message} -- url=${url} screenshot=${screenshotPath ?? '<none>'} gateRows=${dump}`)
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

/** Polls until `read()` returns `expected` or the action budget runs out; returns the last value
 *  read either way so the caller can print it before asserting. */
async function settleTo(read, expected) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS
  let last = await read()
  while (last !== expected && Date.now() < deadline) {
    await delay(100)
    last = await read()
  }
  return last
}

/** Creates a software simulation from the drawer (rules provider), navigates to its page, and
 *  confirms sector/policy/seed/simTime directly against `prisma` -- `gate-m31b`'s own helper. */
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
  const id = match[1]
  const row = await prisma.simulationRun.findUnique({ where: { id } })
  if (row === null) await fail(`"${name}" (${id}) is missing from the DB right after creation`)
  if (row.sector !== 'software') await fail(`"${name}"'s stored sector is ${JSON.stringify(row.sector)}, expected 'software'`)
  if (row.decisionProvider !== 'rules') await fail(`"${name}"'s stored decisionProvider is ${JSON.stringify(row.decisionProvider)}, expected 'rules'`)
  if (row.definition.policy !== policy) await fail(`"${name}"'s stored definition.policy is ${JSON.stringify(row.definition.policy)}, expected ${JSON.stringify(policy)}`)
  if (row.definition.seed !== seed) await fail(`"${name}"'s stored definition.seed is ${JSON.stringify(row.definition.seed)}, expected ${seed}`)
  if (row.simTime !== 0) await fail(`"${name}"'s stored simTime is ${JSON.stringify(row.simTime)}, expected 0 right after creation`)
  console.log(`"${name}" created and navigated to: ${id} -- verified against prisma: software/rules, policy ${policy}, seed ${seed}, day 0`)
  return id
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m33-adopt-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  const chromiumPath = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- set CHROMIUM_PATH to a real executable (e.g. a playwright-installed ` +
        `chromium under ~/.cache/ms-playwright) before running this gate`,
    )
  }
  const cliPath = join(repoRoot, 'apps/orchestrator/dist/cli.js')
  if (!existsSync(cliPath)) throw new Error(`orchestrator CLI not built at ${cliPath} -- run tsc --build first`)

  await preflightCleanup()

  // ---- Stage 1: the gate-owned software company, staffed directly with prisma ----
  const templateByRole = {}
  for (const [, role] of ROSTER) {
    if (templateByRole[role] !== undefined) continue
    const template = await prisma.slaveTemplate.create({ data: { name: `${TEMPLATE_PREFIX}${role}`, role } })
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
  console.log(`stage 1: company created and staffed directly: ${companyId} (${COMPANY_NAME}), ${templateIds.length} templates, ${ROSTER.length} slaves`)

  // ---- Boot the real web shell on a free port -- the ONLY process this gate spawns ----
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

  // ---- Launch the real browser ----
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  page.on('pageerror', (error) => console.error(`[browser:pageerror] ${error}`))

  // ---- Stage 2: the software run, from the drawer, never stepped ----
  simulationId = await createSoftwareSimOnPage(baseUrl, { name: SIM_NAME, policy: POLICY, seed: DEMO_SEED })
  console.log(`stage 2: "${SIM_NAME}" is ${simulationId}, left at day 0`)

  // ---- Stage 3: the workspace, through the real CLI on a temp git repository ----
  repoPath = makeRepo()
  const cliOutput = execFileSync('node', [cliPath, 'create-workspace', '--name', WORKSPACE_NAME, '--repo', repoPath, '--verify', 'true'], {
    cwd: repoRoot,
    env: loopbackChildEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  console.log(`create-workspace printed: ${JSON.stringify(cliOutput.trim())}`)
  const created = /workspace (\S+) created/.exec(cliOutput)
  if (created === null) await fail(`create-workspace did not print "workspace <id> created" -- output ${JSON.stringify(cliOutput)}`)
  workspaceId = created[1]
  const workspaceBefore = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspaceBefore === null) await fail(`workspace ${workspaceId} printed by create-workspace is missing from the DB`)
  if (workspaceBefore.name !== WORKSPACE_NAME) await fail(`workspace ${workspaceId} is named ${JSON.stringify(workspaceBefore.name)}, expected ${JSON.stringify(WORKSPACE_NAME)}`)
  console.log(`workspace before adoption: companyId ${JSON.stringify(workspaceBefore.companyId)}, adoptedFromSimulationId ${JSON.stringify(workspaceBefore.adoptedFromSimulationId)}, maxConcurrentRuns ${workspaceBefore.maxConcurrentRuns}, maxAttempts ${workspaceBefore.maxAttempts}, autoMerge ${workspaceBefore.autoMerge}, budgetUsd ${JSON.stringify(workspaceBefore.budgetUsd)}`)
  if (workspaceBefore.companyId !== null) await fail(`the freshly created workspace already has companyId ${JSON.stringify(workspaceBefore.companyId)}, expected null`)
  if (workspaceBefore.adoptedFromSimulationId !== null) await fail(`the freshly created workspace already has adoptedFromSimulationId ${JSON.stringify(workspaceBefore.adoptedFromSimulationId)}, expected null`)
  const budgetBefore = workspaceBefore.budgetUsd
  console.log(`stage 3: workspace ${workspaceId} (${WORKSPACE_NAME}) created by the CLI on ${repoPath}, no company`)

  // ---- Stage 4: adopt from the run page ----
  await page.goto(`${baseUrl}/sim/${simulationId}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('sim-strip'), `"${SIM_NAME}"'s run page strip`)
  const drawer = page.getByTestId('sim-adopt-drawer')
  await clickUntil(page.getByTestId('sim-adopt-open'), async () => drawer.first().isVisible(), 'the "Adopt this organisation…" button')
  await waitVisible(drawer, 'the adopt drawer')
  await waitVisible(page.getByTestId('sim-adopt-roles'), "the adopt drawer's roles table (the preview fetch)")

  {
    const rows = page.getByTestId('sim-adopt-role-row')
    const rowCount = await settleTo(() => rows.count(), ROSTER.length)
    const drawerRows = []
    for (let i = 0; i < rowCount; i++) {
      const cells = (await rows.nth(i).locator('td').allTextContents()).map((text) => text.trim())
      drawerRows.push({ slaveName: cells[0], role: cells[1], runtimeRole: cells[2] })
    }
    console.log(`drawer roles table: ${JSON.stringify(drawerRows)}`)
    if (rowCount !== ROSTER.length) await fail(`the adopt drawer shows ${rowCount} role row(s), expected ${ROSTER.length}`)
    for (const [slaveName, expected] of Object.entries(EXPECTED_DRAWER_ROWS)) {
      const row = drawerRows.find((r) => r.slaveName === slaveName)
      if (row === undefined) await fail(`the adopt drawer has no role row for ${slaveName}`)
      if (row.role !== expected.role) await fail(`${slaveName}'s run role in the drawer reads ${JSON.stringify(row.role)}, expected ${JSON.stringify(expected.role)}`)
      if (row.runtimeRole !== expected.runtimeRole) await fail(`${slaveName}'s "becomes" cell in the drawer reads ${JSON.stringify(row.runtimeRole)}, expected ${JSON.stringify(expected.runtimeRole)}`)
    }

    const maxConcurrentText = await settleTo(() => page.getByTestId('sim-adopt-max-concurrent').inputValue(), String(EXPECTED_MAX_CONCURRENT))
    const maxAttemptsText = await settleTo(() => page.getByTestId('sim-adopt-max-attempts').inputValue(), String(EXPECTED_MAX_ATTEMPTS))
    const autoMergeText = (await page.getByTestId('sim-adopt-automerge').textContent())?.trim()
    const applyModelCount = await page.getByTestId('sim-adopt-apply-model').count()
    console.log(`drawer proposal: max concurrent ${JSON.stringify(maxConcurrentText)}, max attempts ${JSON.stringify(maxAttemptsText)}, autoMerge ${JSON.stringify(autoMergeText)}, apply-model boxes ${applyModelCount}`)
    if (maxConcurrentText !== String(EXPECTED_MAX_CONCURRENT)) await fail(`sim-adopt-max-concurrent reads ${JSON.stringify(maxConcurrentText)}, expected ${JSON.stringify(String(EXPECTED_MAX_CONCURRENT))} (four engineers)`)
    if (maxAttemptsText !== String(EXPECTED_MAX_ATTEMPTS)) await fail(`sim-adopt-max-attempts reads ${JSON.stringify(maxAttemptsText)}, expected ${JSON.stringify(String(EXPECTED_MAX_ATTEMPTS))} (policy A)`)
    if (autoMergeText !== 'off (locked)') await fail(`sim-adopt-automerge reads ${JSON.stringify(autoMergeText)}, expected 'off (locked)'`)
    if (applyModelCount !== 0) await fail(`a rules run's adopt drawer shows ${applyModelCount} apply-model box(es), expected none`)

    await selectReliably(page.getByTestId('sim-adopt-workspace'), workspaceId, { value: workspaceId }, 'the adopt drawer workspace select')
    await clickUntil(
      page.getByTestId('sim-adopt-submit'),
      async () => new URL(page.url()).pathname === `/w/${workspaceId}`,
      'the "Adopt this organisation" submit button',
    )
    console.log(`stage 4: adopted from the UI; the browser is now at ${page.url()}`)
  }

  // ---- Stage 5: the workspace page and its rows ----
  {
    const note = page.getByTestId('ws-adopted-from')
    await waitVisible(note, 'the "organisation adopted from simulation" note on the workspace page')
    const noteText = (await note.textContent())?.trim()
    const noteHref = await note.locator('a').first().getAttribute('href')
    console.log(`ws-adopted-from reads ${JSON.stringify(noteText)}, links to ${JSON.stringify(noteHref)}`)
    if (noteText === undefined || !noteText.includes(SIM_NAME)) await fail(`ws-adopted-from reads ${JSON.stringify(noteText)}, expected it to name ${JSON.stringify(SIM_NAME)}`)
    if (noteHref !== `/sim/${simulationId}`) await fail(`ws-adopted-from links to ${JSON.stringify(noteHref)}, expected /sim/${simulationId}`)

    await waitVisible(page.getByTestId('slave-card').first(), 'a slave card on the adopted workspace page')
    const cardCount = await settleTo(() => page.getByTestId('slave-card').count(), ROSTER.length)
    console.log(`workspace page shows ${cardCount} slave-card(s)`)
    if (cardCount !== ROSTER.length) await fail(`the workspace page shows ${cardCount} slave-card(s), expected ${ROSTER.length}`)

    const slaves = await prisma.slave.findMany({ where: { team: { workspaceId } }, select: { name: true, role: true, requiredRole: true, team: { select: { name: true } } }, orderBy: { name: 'asc' } })
    console.log(`Slave rows for the workspace: ${JSON.stringify(slaves.map((s) => ({ name: s.name, team: s.team.name, role: s.role, requiredRole: s.requiredRole })))}`)
    if (slaves.length !== ROSTER.length) await fail(`the workspace has ${slaves.length} Slave row(s), expected ${ROSTER.length}`)
    for (const [slaveName, expectedRole] of Object.entries(EXPECTED_SLAVE_ROLES)) {
      const slave = slaves.find((s) => s.name === slaveName)
      if (slave === undefined) await fail(`no Slave row named ${slaveName} on the workspace`)
      if (slave.role !== expectedRole) await fail(`${slaveName}'s Slave.role is ${JSON.stringify(slave.role)}, expected ${JSON.stringify(expectedRole)}`)
    }
    const withRequiredRole = slaves.filter((s) => s.requiredRole !== null).map((s) => s.name)
    if (withRequiredRole.length > 0) await fail(`adoption wrote requiredRole on ${JSON.stringify(withRequiredRole)}, expected null on every Slave row (R2: that column names the role a task needs)`)

    const workspaceAfter = await prisma.workspace.findUnique({ where: { id: workspaceId } })
    console.log(`workspace after adoption: companyId ${JSON.stringify(workspaceAfter.companyId)}, adoptedFromSimulationId ${JSON.stringify(workspaceAfter.adoptedFromSimulationId)}, maxConcurrentRuns ${workspaceAfter.maxConcurrentRuns}, maxAttempts ${workspaceAfter.maxAttempts}, autoMerge ${workspaceAfter.autoMerge}, budgetUsd ${JSON.stringify(workspaceAfter.budgetUsd)}, haltedReason ${JSON.stringify(workspaceAfter.haltedReason)}`)
    if (workspaceAfter.companyId !== companyId) await fail(`the workspace's companyId is ${JSON.stringify(workspaceAfter.companyId)}, expected ${companyId}`)
    if (workspaceAfter.adoptedFromSimulationId !== simulationId) await fail(`the workspace's adoptedFromSimulationId is ${JSON.stringify(workspaceAfter.adoptedFromSimulationId)}, expected ${simulationId}`)
    if (workspaceAfter.maxConcurrentRuns !== EXPECTED_MAX_CONCURRENT) await fail(`the workspace's maxConcurrentRuns is ${workspaceAfter.maxConcurrentRuns}, expected ${EXPECTED_MAX_CONCURRENT}`)
    if (workspaceAfter.maxAttempts !== EXPECTED_MAX_ATTEMPTS) await fail(`the workspace's maxAttempts is ${workspaceAfter.maxAttempts}, expected ${EXPECTED_MAX_ATTEMPTS}`)
    if (workspaceAfter.autoMerge !== false) await fail(`the workspace's autoMerge is ${JSON.stringify(workspaceAfter.autoMerge)}, expected false`)
    if (workspaceAfter.budgetUsd !== budgetBefore) await fail(`the workspace's budgetUsd is ${JSON.stringify(workspaceAfter.budgetUsd)} after adoption, expected the ${JSON.stringify(budgetBefore)} create-workspace wrote (simulated money never becomes a real budget)`)
    console.log('stage 5: the workspace page names the run, the seven slaves carry the translated roles, the columns match')

    // ---- Stage 6: nothing started ----
    const runCount = await prisma.slaveRun.count({ where: { slave: { team: { workspaceId } } } })
    const taskCount = await prisma.task.count({ where: { workspaceId } })
    const events = await prisma.executionEvent.findMany({ where: { workspaceId }, select: { type: true }, orderBy: { seq: 'asc' } })
    const eventTypes = events.map((e) => e.type)
    const runStartedCount = eventTypes.filter((t) => t === 'run_started').length
    console.log(`after adoption: ${runCount} SlaveRun row(s), ${taskCount} Task row(s), events ${JSON.stringify(eventTypes)}, ${runStartedCount} run.started, haltedReason ${JSON.stringify(workspaceAfter.haltedReason)}`)
    if (runCount !== 0) await fail(`${runCount} SlaveRun row(s) reachable from the adopted workspace, expected 0 -- adoption must start nothing`)
    if (taskCount !== 0) await fail(`${taskCount} Task row(s) on the adopted workspace, expected 0`)
    if (runStartedCount !== 0) await fail(`${runStartedCount} run.started event(s) on the adopted workspace, expected 0`)
    if (workspaceAfter.haltedReason !== null) await fail(`the workspace's haltedReason is ${JSON.stringify(workspaceAfter.haltedReason)}, expected null`)
    console.log('stage 6: nothing started -- and the only process this gate spawned is next dev (no daemon, no fake CLI, no model call exist in this script)')
  }

  // ---- Stage 7: the journal ----
  {
    const controlRows = await prisma.simulationJournalEntry.findMany({ where: { simulationId, kind: 'control' }, orderBy: { seq: 'asc' } })
    const adoptedRows = controlRows.filter((r) => r.payload?.op === 'adopted')
    console.log(`control journal rows on "${SIM_NAME}": ${JSON.stringify(controlRows.map((r) => ({ seq: r.seq, payload: r.payload })))}`)
    if (adoptedRows.length !== 1) await fail(`"${SIM_NAME}" has ${adoptedRows.length} adopted journal row(s), expected exactly 1`)
    const payload = adoptedRows[0].payload
    if (payload.workspaceId !== workspaceId) await fail(`the adopted journal row names workspaceId ${JSON.stringify(payload.workspaceId)}, expected ${workspaceId}`)
    if (payload.workspaceName !== WORKSPACE_NAME) await fail(`the adopted journal row names workspaceName ${JSON.stringify(payload.workspaceName)}, expected ${JSON.stringify(WORKSPACE_NAME)}`)
    if (payload.settings?.maxConcurrentRuns !== EXPECTED_MAX_CONCURRENT || payload.settings?.maxAttempts !== EXPECTED_MAX_ATTEMPTS) {
      await fail(`the adopted journal row's settings are ${JSON.stringify(payload.settings)}, expected { maxConcurrentRuns: ${EXPECTED_MAX_CONCURRENT}, maxAttempts: ${EXPECTED_MAX_ATTEMPTS} }`)
    }
    if (payload.appliedModel !== null) await fail(`the adopted journal row's appliedModel is ${JSON.stringify(payload.appliedModel)}, expected null on a rules run`)
    const run = await prisma.simulationRun.findUnique({ where: { id: simulationId }, select: { state: true, simTime: true, status: true } })
    console.log(`run after adoption: status ${run.status}, simTime ${run.simTime}, journalSeq ${JSON.stringify(run.state?.journalSeq)}`)
    if (run.simTime !== 0) await fail(`"${SIM_NAME}"'s simTime is ${run.simTime} after adoption, expected 0 -- adoption steps nothing`)
    console.log('stage 7: exactly one adopted journal row, naming the workspace')
  }

  console.log(
    'PASS: a software run created from the drawer was adopted from its page into a workspace the CLI created with no company; ' +
      'the drawer showed the run\'s roles and what they become, the proposal and autoMerge locked; the workspace page names the run, ' +
      'its seven slaves carry the translated roles with requiredRole untouched, its settings and provenance are written and its budget ' +
      'is not; no run, task or run.started event exists; the run journals exactly one adoption',
  )
  exitCode = 0
} finally {
  if (browser !== null) await browser.close().catch(() => {})
  if (nextProc !== null && nextProc.exitCode === null) {
    nextProc.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextProc.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextProc.exitCode === null) nextProc.kill('SIGKILL')
  }
  if (workspaceId !== null) await deleteWorkspace(workspaceId)
  if (simulationId !== null) await prisma.simulationRun.delete({ where: { id: simulationId } }).catch(() => {})
  if (companyId !== null) {
    await prisma.simulationRun.deleteMany({ where: { companyId } }).catch(() => {})
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {})
  }
  for (const id of templateIds) {
    await prisma.slaveTemplate.delete({ where: { id } }).catch(() => {})
  }
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
