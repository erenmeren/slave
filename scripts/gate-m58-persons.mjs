// M58's own gate (spec §7 R33): "a slave is a person, and a project seat is where they sit".
//
// `gate-m57-ui-redesign.mjs`'s shape, which is `gate-m44-ux-foundation.mjs`'s: a free port, a real
// `next dev`, a real Chromium through `playwright-core` at CHROMIUM_PATH, plus ONE real daemon tick
// for stage 3 -- and a FAKE CLI, so it spends nothing and cannot.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m58-persons
//
// THIS GATE SPENDS NOTHING AND CANNOT. Stage 3 dispatches a real run, through the fake binary, and
// the preflight REFUSES to start unless SLAVEOFAI_CLAUDE_BIN points at an executable under
// `scripts/gate-fakes/` and SLAVEOFAI_REQUIRE_FAKE_CLI=1 (Decision 10, M32 item 7).
//
// IT WRITES FIXTURE ROWS AND DELETES THEM IN `finally`, in FK order: two workspaces with one
// department each, one persona, one skill provider with two skills, and the people the stages make.
// Deleting a `Person` cascades its seats, its runs, its permissions, its memberships, its skills and
// its memories, so the teardown is SHORTER than m57's, not longer. `git status` after a green run
// has to be empty.
//
// The seven stages, which are R33's seven clauses in order:
//   1. A SLAVE WITH NO PROJECT. Made from the Catalog's + New slave drawer with a persona and a name
//      and nothing else; Workforce -> People says "in the pool", and `prisma.slave` has no row for
//      them.
//   2. TWO SEATS, ONE SLAVE. Seated on A and on B from the person panel; the People row shows two
//      chips, both project Team pages show the SAME name, and `prisma.person` still has one row.
//   3. WHAT THEY LEARNT ON A, THEY KNOW ON B. A task on A runs through the fake CLI and writes a
//      verified worker-scoped memory; a run on B is built and its recorded `RunContext` prompt
//      contains that memory's title.
//   4. THE PERSONA GIVES, THE SLAVE TAKES BACK. The persona gets a default skill -> the person panel
//      shows it "from persona"; revoking it on the person removes it from the effective set, and the
//      OTHER person hired from the same persona still has it.
//   5. REMOVED FROM ONE, STILL ON THE OTHER. "remove from project" on A's seat leaves B's seat open
//      and A's seat row CLOSED with its run still attached.
//   6. DELETE DELETES. The confirmation says "2 projects" -- read off the DOM before the click --
//      and after it the person, both seats, the runs and the memory are gone.
//   7. THE OLD VERBS STILL WORK. `add-slave`, `assign-company` and `hire --temporary` through the
//      real CLI: the first makes a pooled person in a department, the second SEATS that same person
//      on a second project (one `Person` row, two `Slave` rows), the third makes an ephemeral person
//      with an engagement.
//
// THE GATE ASSERTS, IT NEVER FIXES. Every stage prints every measured value before asserting it.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web` (`pgrep -af "next dev"`).

import { execFileSync, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids } from './lib/daemon-process.mjs'
import { chromium } from 'playwright-core'
import { prisma } from '../packages/db/dist/client.js'

const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 250
const CLI_TIMEOUT_MS = 180_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const PASS_LINE = 'a slave is a person, and a project seat is where they sit'

const STAMP = new Date().toISOString().slice(11, 19)
const WORKSPACE_PREFIX = 'M58 Gate Project'
const WORKSPACE_A_NAME = `${WORKSPACE_PREFIX} A ${STAMP}`
const WORKSPACE_B_NAME = `${WORKSPACE_PREFIX} B ${STAMP}`
const TEAM_NAME = 'M58 Gate Department'
const TEMPLATE_PREFIX = 'M58 Gate Clerk'
const TEMPLATE_NAME = `${TEMPLATE_PREFIX} ${STAMP}`
const COMPANY_PREFIX = 'M58 Gate Trading'
const COMPANY_NAME = `${COMPANY_PREFIX} ${STAMP}`
const SKILL_PROVIDER_PREFIX = 'M58 Gate Skills'
const SKILL_PROVIDER_NAME = `${SKILL_PROVIDER_PREFIX} ${STAMP}`
const PERSON_PREFIX = 'M58 Gate'
const PERSON_A = `M58 Gate Ada ${STAMP}`
const PERSON_B = `M58 Gate Bea ${STAMP}`
const PERSON_C = `M58 Gate Cia ${STAMP}`
const MEMORY_TITLE = `M58 lesson ${STAMP}`
const ROLE = 'engineer'

const PROFILE_SPEC = {
  identity: 'M58 Gate Clerk',
  summary: 'A fixture persona for the persons gate.',
  mission: 'Sit on two projects and remember.',
  runtimeRole: ROLE,
  capabilities: [],
  expertise: [],
  operatingPrinciples: [],
  constraints: [],
  workflow: [],
  deliverables: [],
  successCriteria: [],
  collaborationHints: [],
  recommendedSkills: [],
  body: 'Fixture.',
  source: null,
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m58-repo-'))
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

async function preflightCleanup() {
  const stalePeople = await prisma.person.findMany({
    where: { name: { startsWith: PERSON_PREFIX } },
    select: { id: true, name: true },
  })
  for (const person of stalePeople) {
    console.log(`preflight: removing leftover person ${person.id} (${person.name})`)
    await prisma.person.delete({ where: { id: person.id } }).catch(() => {})
  }
  const staleCompanies = await prisma.company.findMany({
    where: { name: { startsWith: COMPANY_PREFIX } },
    select: { id: true, name: true },
  })
  for (const company of staleCompanies) {
    console.log(`preflight: removing leftover company ${company.id} (${company.name})`)
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
  const staleProviders = await prisma.skillProvider.findMany({
    where: { name: { startsWith: SKILL_PROVIDER_PREFIX } },
    select: { id: true, name: true },
  })
  for (const provider of staleProviders) {
    console.log(`preflight: removing leftover skill provider ${provider.id} (${provider.name})`)
    await prisma.skillProvider.delete({ where: { id: provider.id } }).catch(() => {})
  }
  const stale = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true },
  })
  for (const workspace of stale) {
    console.log(`preflight: removing leftover workspace ${workspace.id} (${workspace.name})`)
    await prisma.executionEvent.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {})
  }
}

let exitCode = 1
let nextServer = null
let browser = null
let page = null
let diagDir = null
let workspaceAId = null
let workspaceBId = null
let teamAId = null
let teamBId = null
let templateId = null
let companyId = null
let companyTeamId = null
let skillId = null
let skillProviderId = null
let repoA = null
let repoB = null
const browserConsole = []

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m58-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  const fakeClaude = process.env['SLAVEOFAI_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'SLAVEOFAI_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m58-persons',
    )
  }
  try {
    accessSync(fakeClaude, constants.X_OK)
  } catch {
    throw new Error(`SLAVEOFAI_CLAUDE_BIN=${fakeClaude} is not an executable file`)
  }
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
      `no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m58-persons passes ` +
        '--env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m58-persons`')
  }
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI} -- run \`npx tsc --build\` first`)
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)
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
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m58-persons REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate ticks itself and measures what the fake CLI recorded',
    )
  }
  console.log(`fake claude: ${fakeClaude}`)
  console.log(`chromium:    ${chromiumPath}`)

  await preflightCleanup()

  repoA = makeRepo()
  repoB = makeRepo()
  const workspaceA = await prisma.workspace.create({
    data: {
      name: WORKSPACE_A_NAME,
      repoPath: repoA,
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  workspaceAId = workspaceA.id
  const workspaceB = await prisma.workspace.create({
    data: {
      name: WORKSPACE_B_NAME,
      repoPath: repoB,
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  workspaceBId = workspaceB.id
  const teamA = await prisma.team.create({ data: { workspaceId: workspaceAId, name: TEAM_NAME } })
  teamAId = teamA.id
  const teamB = await prisma.team.create({ data: { workspaceId: workspaceBId, name: TEAM_NAME } })
  teamBId = teamB.id

  const template = await prisma.slaveTemplate.create({
    data: {
      name: TEMPLATE_NAME,
      role: ROLE,
      description: 'Fixture persona for gate:m58-persons',
      defaultModel: 'sonnet',
      provider: 'claude_code',
      active: true,
      profileSpec: PROFILE_SPEC,
      searchText: TEMPLATE_NAME.toLowerCase(),
    },
  })
  templateId = template.id

  const skillProvider = await prisma.skillProvider.create({ data: { name: SKILL_PROVIDER_NAME } })
  skillProviderId = skillProvider.id
  const skill = await prisma.skill.create({
    data: { providerId: skillProvider.id, name: 'pdf', description: 'makes pdfs' },
  })
  skillId = skill.id
  await prisma.skill.create({
    data: { providerId: skillProvider.id, name: 'sql', description: 'writes sql' },
  })

  const company = await prisma.company.create({ data: { name: COMPANY_NAME } })
  companyId = company.id
  const companyTeam = await prisma.companyTeam.create({ data: { companyId, name: TEAM_NAME } })
  companyTeamId = companyTeam.id

  for (const workspaceId of [workspaceAId, workspaceBId]) {
    await prisma.task.create({
      data: {
        workspaceId,
        title: `M58 gate task ${workspaceId === workspaceAId ? 'A' : 'B'} ${STAMP}`,
        description: 'One ready task so a tick has something to dispatch.',
        status: 'ready',
        requiredRole: ROLE,
        maxAttempts: 3,
      },
    })
  }

  console.log('stage 0 PASSED: the fixture rows the seven stages need')
  console.log(`  workspace A ${workspaceAId} (${WORKSPACE_A_NAME}) · workspace B ${workspaceBId} (${WORKSPACE_B_NAME})`)
  console.log(`  team A ${teamAId} · team B ${teamBId}`)
  console.log(`  template ${templateId} (${TEMPLATE_NAME}) · company ${companyId} (${COMPANY_NAME}) · department ${companyTeamId}`)
  console.log(`  skill ${skillId} on provider ${skillProviderId} (${SKILL_PROVIDER_NAME})`)

  const childEnv = () =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8-flow`,
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
    })

  const runCli = (args) => {
    try {
      return execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
        cwd: repoRoot,
        env: childEnv(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: CLI_TIMEOUT_MS,
      })
    } catch (error) {
      throw new Error(
        `the CLI refused \`${args.join(' ')}\` with status ${String(error.status)}\n` +
          `  stdout: ${String(error.stdout)}\n  stderr: ${String(error.stderr)}`,
      )
    }
  }

  const preferredPort = await findFreePort()
  nextServer = spawn(
    'node',
    ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort), '-H', '127.0.0.1'],
    { cwd: repoRoot, env: loopbackChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let nextOutput = ''
  let nextExited = false
  let resolvedPort = null
  nextServer.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    nextOutput += text
    process.stdout.write(`[next] ${text}`)
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

  async function waitVisible(locator, description) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
    } catch {
      await fail(`timed out waiting for ${description} to become visible`)
    }
  }

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

  async function settleTo(read, expected) {
    const deadline = Date.now() + ACTION_TIMEOUT_MS
    let last = await read()
    while (last !== expected && Date.now() < deadline) {
      await delay(100)
      last = await read()
    }
    if (last !== expected) {
      await fail(`did not settle to ${JSON.stringify(expected)} -- last seen ${JSON.stringify(last)}`)
    }
    return last
  }

  // ---- stage 1 -------------------------------------------------------------------------------
  await gotoReliably(`${baseUrl}/workforce?tab=slaves`)
  await page.getByTestId('new-slave').click()
  await waitVisible(page.getByTestId('new-slave-drawer'), 'the New slave drawer')
  await page.getByTestId('new-slave-persona').selectOption(templateId)
  await page.getByTestId('new-slave-name').fill(PERSON_A)
  const poolNote = (await page.getByTestId('new-slave-pool-note').textContent()) ?? ''
  console.log(`stage 1 -- the drawer's note with nothing chosen: ${JSON.stringify(poolNote)}`)
  if (!/pool/i.test(poolNote)) await fail(`stage 1: the drawer does not say the slave lands in the pool: ${poolNote}`)
  await page.getByTestId('new-slave-submit').click()

  await settleTo(async () => page.locator('[data-testid^="person-row-"]').filter({ hasText: PERSON_A }).count(), 1)
  const personId = await page.locator('[data-testid^="person-row-"]').filter({ hasText: PERSON_A }).first().getAttribute('data-person-id')
  if (personId === null) await fail('stage 1: the new People row has no data-person-id')
  const row = page.getByTestId(`person-row-${personId}`)
  const stateWord = ((await row.getByTestId('person-pool-chip').textContent()) ?? '').trim()
  const stateAttr = await row.getAttribute('data-person-state')
  console.log(`stage 1 -- People says ${JSON.stringify(stateWord)} (raw ${JSON.stringify(stateAttr)})`)
  if (!/in the pool/i.test(stateWord)) await fail(`stage 1: People does not say "in the pool": ${stateWord}`)
  if (stateAttr !== 'pool') await fail(`stage 1: the raw state is ${String(stateAttr)}, expected "pool"`)
  const seatCount = await prisma.slave.count({ where: { personId } })
  if (seatCount !== 0) await fail(`stage 1: the pooled slave already has ${String(seatCount)} seat(s)`)
  console.log(`stage 1 PASSED: ${PERSON_A} (${personId}) is in the pool with no seat`)

  // ---- stage 2 -------------------------------------------------------------------------------
  for (const teamId of [teamAId, teamBId]) {
    await page.getByTestId(`person-row-${personId}`).getByTestId('person-open').click()
    await waitVisible(page.getByTestId('panel-projects-group'), "the person panel's Projects group")
    await page.getByTestId('panel-assign-project').selectOption(teamId === teamAId ? workspaceAId : workspaceBId)
    await page.getByTestId('panel-assign-team').selectOption(teamId)
    await page.getByTestId('panel-assign-submit').click()
    await settleTo(async () => prisma.slave.count({ where: { personId, closedAt: null } }), teamId === teamAId ? 1 : 2)
  }
  await gotoReliably(`${baseUrl}/workforce?tab=slaves`)
  const chips = await page.getByTestId(`person-row-${personId}`).getByTestId('person-seat-chip').allTextContents()
  console.log(`stage 2 -- the seat chips: ${JSON.stringify(chips)}`)
  if (chips.length !== 2) await fail(`stage 2: expected two seat chips, got ${JSON.stringify(chips)}`)
  if (await prisma.person.count({ where: { name: PERSON_A } }) !== 1) {
    await fail('stage 2: seating on a second project made a second slave')
  }
  for (const workspaceId of [workspaceAId, workspaceBId]) {
    await gotoReliably(`${baseUrl}/w/${workspaceId}/organization`)
    await waitVisible(page.getByTestId('organization-rows'), 'the Team table')
    const text = (await page.getByTestId('organization-rows').textContent()) ?? ''
    if (!text.includes(PERSON_A)) await fail(`stage 2: ${PERSON_A} is not on ${workspaceId}'s Team page`)
  }
  console.log('stage 2 PASSED: one person, two seats, the same name on both Team pages')

  // ---- stage 3 -------------------------------------------------------------------------------
  console.log(`stage 3 -- tick A printed:\n${runCli(['tick', '--workspace', workspaceAId])}`)
  await prisma.memory.create({
    data: {
      type: 'lesson', scope: 'worker', personId, workspaceId: workspaceAId,
      title: MEMORY_TITLE, body: 'learnt on A', status: 'verified',
      sourceKind: 'run_output', createdBy: 'slave',
    },
  })
  console.log(`stage 3 -- tick B printed:\n${runCli(['tick', '--workspace', workspaceBId])}`)
  const contextOnB = await prisma.runContext.findFirst({
    where: { run: { slave: { personId, team: { workspaceId: workspaceBId } } } },
    orderBy: { id: 'desc' },
  })
  console.log(`stage 3 -- B's run context is ${contextOnB === null ? 'missing' : `${String(contextOnB.prompt.length)} chars`}`)
  if (contextOnB === null) await fail('stage 3: no run context was recorded on project B')
  if (!contextOnB.prompt.includes(MEMORY_TITLE)) {
    await fail(`stage 3: what the slave learnt on A is not in B's prompt: ${contextOnB.prompt.slice(0, 400)}`)
  }
  console.log('stage 3 PASSED: what they learnt on A is in B\'s prompt')

  // ---- stage 4 -------------------------------------------------------------------------------
  await gotoReliably(`${baseUrl}/workforce?tab=catalog&q=${encodeURIComponent(TEMPLATE_NAME)}`)
  await waitVisible(page.getByTestId(`catalog-row-${templateId}`), "the persona's catalog row")
  await page.getByTestId(`catalog-open-${templateId}`).click()
  await waitVisible(page.getByTestId('profile-drawer'), "the persona's profile drawer")
  await waitVisible(page.getByTestId('template-skill-add'), "the persona's Default skills editor")
  await page.getByTestId('template-skill-add').selectOption(skillId)
  await page.getByTestId('template-skill-add-submit').click()
  await settleTo(async () => prisma.templateSkill.count({ where: { templateId } }), 1)

  const otherHired = await prisma.person.create({
    data: { name: PERSON_B, templateId, lifecycle: 'permanent' },
  })
  const hiredPersonId = personId
  const otherHiredPersonId = otherHired.id

  await gotoReliably(`${baseUrl}/workforce?tab=slaves`)
  await page.getByTestId(`person-row-${hiredPersonId}`).getByTestId('person-open').click()
  await waitVisible(page.getByTestId(`panel-person-skill-${skillId}`), "the person's skill row")
  const origin = await page.getByTestId(`panel-person-skill-${skillId}`).getAttribute('data-skill-state')
  console.log(`stage 4 -- the skill's origin on the slave: ${JSON.stringify(origin)}`)
  if (origin !== 'persona') await fail(`stage 4: the skill is ${String(origin)}, expected "persona"`)

  await page.getByTestId(`panel-skill-remove-${skillId}`).click()
  await settleTo(async () => prisma.personSkill.count({ where: { personId: hiredPersonId, mode: 'revoked' } }), 1)
  await settleTo(async () => page.getByTestId(`panel-person-skill-${skillId}`).getAttribute('data-skill-state'), 'revoked')
  const afterRevoke = await page.getByTestId(`panel-person-skill-${skillId}`).getAttribute('data-skill-state')
  if (afterRevoke !== 'revoked') await fail(`stage 4: after revoking, the row reads ${String(afterRevoke)}`)
  const otherStill = await prisma.personSkill.count({ where: { personId: otherHiredPersonId } })
  if (otherStill !== 0) await fail('stage 4: the revoke leaked onto another slave hired from the same persona')
  console.log('stage 4 PASSED: the persona gave the skill; the revoke stayed on this slave')

  // ---- stage 5 -------------------------------------------------------------------------------
  const seatOnA = await prisma.slave.findFirstOrThrow({ where: { personId, team: { workspaceId: workspaceAId } } })
  await page.getByTestId(`panel-seat-remove-${seatOnA.id}`).click()
  await settleTo(async () => prisma.slave.count({ where: { personId, closedAt: null } }), 1)
  const closed = await prisma.slave.findUniqueOrThrow({ where: { id: seatOnA.id }, include: { runs: true } })
  console.log(`stage 5 -- A's seat closed at ${String(closed.closedAt)} with ${String(closed.runs.length)} run(s) still on it`)
  if (closed.closedAt === null) await fail('stage 5: the seat was not closed')
  if (closed.runs.length === 0) await fail('stage 5: closing the seat took its runs with it')
  const openSeats = await prisma.slave.findMany({ where: { personId, closedAt: null }, include: { team: true } })
  if (openSeats.length !== 1 || openSeats[0].team.workspaceId !== workspaceBId) {
    await fail('stage 5: removing them from A did not leave them on B')
  }
  console.log('stage 5 PASSED: removed from A, still on B, runs stayed on the closed seat')

  // ---- stage 6 -------------------------------------------------------------------------------
  await waitVisible(page.getByTestId('panel-projects-group'), "the person panel's Projects group")
  await page.getByTestId('panel-assign-project').selectOption(workspaceAId)
  await page.getByTestId('panel-assign-team').selectOption(teamAId)
  await page.getByTestId('panel-assign-submit').click()
  await settleTo(async () => prisma.slave.count({ where: { personId, closedAt: null } }), 2)
  await settleTo(
    async () => page.getByTestId('panel-projects-group').locator('[data-testid^="panel-seat-remove-"]').count(),
    2,
  )

  await page.getByTestId('person-delete').click()
  const confirmation = ((await page.getByTestId('person-delete-count').textContent()) ?? '').trim()
  console.log(`stage 6 -- the confirmation said: ${JSON.stringify(confirmation)}`)
  if (!/2 (other )?projects/.test(confirmation)) {
    await fail(`stage 6: the confirmation does not state the project count: ${confirmation}`)
  }
  await page.getByTestId('person-delete-confirm').click()
  await settleTo(async () => prisma.person.count({ where: { id: personId } }), 0)
  for (const [what, count] of [
    ['seats', await prisma.slave.count({ where: { personId } })],
    ['runs', await prisma.slaveRun.count({ where: { slave: { personId } } })],
    ['memories', await prisma.memory.count({ where: { personId } })],
  ]) {
    console.log(`stage 6 -- ${what} left behind: ${String(count)}`)
    if (count !== 0) await fail(`stage 6: ${String(count)} ${what} survived the delete`)
  }
  if (await prisma.slaveTemplate.count({ where: { id: templateId } }) !== 1) {
    await fail('stage 6: deleting the slave took their persona with them')
  }
  console.log('stage 6 PASSED: delete deleted the person, both seats, the runs and the memory')

  // ---- stage 7 -------------------------------------------------------------------------------
  console.log(`stage 7 -- add-slave printed:\n${runCli(['add-slave', '--team', companyTeamId, '--template', templateId, '--name', PERSON_C])}`)
  const added = await prisma.person.findUniqueOrThrow({
    where: { name: PERSON_C },
    include: { departments: true, seats: true },
  })
  console.log(`stage 7 -- add-slave made ${PERSON_C}: ${String(added.departments.length)} department(s), ${String(added.seats.length)} seat(s)`)
  if (added.departments.length !== 1 || added.seats.length !== 0) {
    await fail('stage 7: add-slave did not make a pooled slave in a department')
  }

  for (const workspaceId of [workspaceAId, workspaceBId]) {
    console.log(`stage 7 -- assign-company ${workspaceId} printed:\n${runCli(['assign-company', '--workspace', workspaceId, '--company', companyId])}`)
  }
  const seatsOfC = await prisma.slave.findMany({ where: { personId: added.id }, include: { team: true } })
  console.log(`stage 7 -- assign-company seated ${PERSON_C} on ${String(seatsOfC.length)} project(s)`)
  if (seatsOfC.length !== 2) await fail(`stage 7: assign-company made ${String(seatsOfC.length)} seat(s), expected 2`)
  if (await prisma.person.count({ where: { name: PERSON_C } }) !== 1) {
    await fail('stage 7: assign-company COPIED the slave instead of seating them')
  }

  // hireFromTemplate reuses an OPEN seat hired from the same persona on that workspace. PERSON_C
  // is that seat after assign-company. Closing A's seat first is what lets `--temporary` create
  // an ephemeral person instead of merging onto Cia -- the clause measures the create, not the reuse.
  const seatCOnA = seatsOfC.find((seat) => seat.team.workspaceId === workspaceAId)
  if (seatCOnA === undefined) await fail('stage 7: PERSON_C has no seat on A to make room')
  console.log(`stage 7 -- unassign ${PERSON_C} from A so hire --temporary can create:\n${runCli(['person', 'unassign', '--person', added.id, '--team', seatCOnA.teamId, '--reason', 'make room for a temporary hire'])}`)

  const task = await prisma.task.findFirstOrThrow({ where: { workspaceId: workspaceAId } })
  console.log(`stage 7 -- hire --temporary printed:\n${runCli(['hire', '--workspace', workspaceAId, '--template', templateId, '--why', 'one job', '--temporary', '--for-task', task.id])}`)
  const temporary = await prisma.person.findFirstOrThrow({
    where: { lifecycle: 'ephemeral', name: { startsWith: PERSON_PREFIX } },
    include: { seats: true },
  })
  console.log(`stage 7 -- hire --temporary made ${temporary.name}, engagement ${String(temporary.seats[0]?.engagementTaskId)}`)
  if (temporary.seats[0]?.engagementTaskId !== task.id) {
    await fail('stage 7: the temporary hire has no engagement')
  }
  console.log('stage 7 PASSED: add-slave, assign-company and hire --temporary still work')

  assert(typeof PASS_LINE === 'string' && PASS_LINE.length > 0, 'the pass line is missing')
  console.log(`PASS: ${PASS_LINE}`)
  exitCode = 0
} finally {
  if (browser !== null) await browser.close().catch(() => {})
  if (nextServer !== null && nextServer.exitCode === null) {
    nextServer.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextServer.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextServer.exitCode === null) nextServer.kill('SIGKILL')
  }
  await prisma.person.deleteMany({ where: { name: { startsWith: PERSON_PREFIX } } }).catch(() => {})
  for (const id of [workspaceAId, workspaceBId]) {
    if (id === null) continue
    await prisma.executionEvent.deleteMany({ where: { workspaceId: id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id } }).catch(() => {})
  }
  if (companyId !== null) await prisma.company.delete({ where: { id: companyId } }).catch(() => {})
  if (templateId !== null) await prisma.slaveTemplate.delete({ where: { id: templateId } }).catch(() => {})
  if (skillProviderId !== null) await prisma.skillProvider.delete({ where: { id: skillProviderId } }).catch(() => {})
  for (const dir of [repoA, repoB]) {
    if (dir !== null) rmSync(dir, { recursive: true, force: true })
  }
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
