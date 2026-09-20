// M59's own gate (spec §7): a project begins as a conversation, and the daemon follows projects.
//
// Eight stages, proved end to end against a real daemon started with NO --workspace, a real
// browser, and a fake CLI whose intake answer is keyed on prompt content:
//   1. The daemon starts with no project argument, names what it serves, and follows new projects.
//   2. New project opens an empty conversation; one sentence gets one question from the daemon.
//   3. A repository path produces facts with provenance and a draft with a usable team.
//   4. Editing that draft creates exactly the project the person approved.
//   5. The daemon discovers it, staffs it, and completes a planning run.
//   6. An idea with no repository creates one under the configured root, with one first commit.
//   7. The same intake shape works through the CLI with no browser.
//   8. The intake's model spend is recorded and its project remains visible.
//
// NEVER A REAL MODEL CALL. The daemon is spawned with SLAVEOFAI_CLAUDE_BIN=node and
// SLAVEOFAI_CLAUDE_ARGS pointing at packages/providers/test/fake-claude.mjs. The gate refuses
// unless SLAVEOFAI_REQUIRE_FAKE_CLI=1.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING apps/web. It boots its own `next dev`
// against this worktree's apps/web/.next on a free loopback port.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 npm run gate:m59-intake

import { execFileSync, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids } from './lib/daemon-process.mjs'
import { prisma } from '../packages/db/dist/client.js'

const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const DAEMON_START_TIMEOUT_MS = 60_000
const REPLY_TIMEOUT_MS = 60_000
const DISCOVERY_TIMEOUT_MS = 20_000
const PLANNING_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 100
const DAEMON_PERIOD_MS = 2_000
const MANIFEST_RACE_SIGNATURE = 'Unexpected end of JSON input'
const VIEWPORT = { width: 1440, height: 900 }

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const STAMP = `${process.pid}-${Date.now()}`
const WORKSPACE_PREFIX = 'M59 Gate'
const TEMPLATE_PREFIX = 'M59 Gate Intake Template'

/** Asks the OS for a free TCP port. */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : null
      server.close(() => (port === null ? reject(new Error('could not determine a free port')) : resolve(port)))
    })
  })
}

/** A real git repository carrying the two verify commands the fake draft selects. */
function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m59-existing-'))
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git(['init', '-q', '-b', 'main'])
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'm59-gate-fixture', private: true, scripts: { test: 'node --test', typecheck: 'tsc --noEmit' } }, null, 2)}\n`,
  )
  writeFileSync(join(dir, 'README.md'), '# M59 gate fixture\n')
  git(['add', '-A'])
  git(['-c', 'user.name=M59 Gate', '-c', 'user.email=gate@slaveofai.local', 'commit', '-q', '-m', 'initial fixture'])
  return dir
}

async function deleteWorkspaceDeeply(id) {
  await prisma.executionEvent.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.slaveMessage.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.workspace.delete({ where: { id } }).catch(() => {})
}

/** Removes rows left by an interrupted earlier run, in FK order. */
async function preflightCleanup() {
  const staleWorkspaces = await prisma.workspace.findMany({
    where: {
      OR: [
        { name: { startsWith: WORKSPACE_PREFIX } },
        {
          intake: {
            messages: {
              some: {
                OR: [
                  { text: 'Rate limiting for our public API' },
                  { text: 'I have an idea and want a NEW REPOSITORY for it' },
                  { text: { startsWith: 'our repository is at /tmp/slaveofai-gate-m59-existing-' } },
                ],
              },
            },
          },
        },
      ],
    },
    select: { id: true, name: true },
  })
  for (const workspace of staleWorkspaces) {
    console.log(`preflight: removing leftover workspace ${workspace.id} (${workspace.name})`)
    await prisma.intake.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {})
    await deleteWorkspaceDeeply(workspace.id)
  }
  const staleTemplates = await prisma.slaveTemplate.findMany({
    where: { name: { startsWith: TEMPLATE_PREFIX } },
    select: { id: true, name: true },
  })
  for (const template of staleTemplates) {
    console.log(`preflight: removing leftover template ${template.id} (${template.name})`)
    await prisma.slaveTemplate.delete({ where: { id: template.id } }).catch(() => {})
  }
}

let exitCode = 1
let nextServer = null
let nextOutput = ''
let browser = null
let page = null
let diagDir = null
let tempRoot = null
let fixtureRepo = null
let reposRoot = null
let templateId = null
let originalReposRoot = undefined
const workspaceIds = []
const intakeIds = []
const daemons = []
const browserConsole = []
const gotoRetries = []
let activeDaemon = null

async function dumpGateRows() {
  const workspaces = await prisma.workspace
    .findMany({ where: { id: { in: workspaceIds } }, include: { intake: { include: { messages: true } } } })
    .catch(() => [])
  return JSON.stringify(
    {
      workspaces,
      daemons: daemons.map((daemon) => ({
        label: daemon.label,
        pid: daemon.proc.pid ?? null,
        exited: daemon.exited,
        output: daemon.output.slice(-8_000),
      })),
    },
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
  )
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m59-diag-'))
  tempRoot = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m59-'))
  reposRoot = join(tempRoot, 'repositories')
  execFileSync('mkdir', ['-p', reposRoot])
  fixtureRepo = makeFixtureRepo()
  console.log(`diagnostics dir: ${diagDir}`)
  console.log(`fixture repository: ${fixtureRepo}`)
  console.log(`new repositories root: ${reposRoot}`)

  // ============================================================================================
  // Stage 0: preflight and fixtures. Refusals, never fallbacks.
  // ============================================================================================
  if (process.env['SLAVEOFAI_REQUIRE_FAKE_CLI'] !== '1') {
    throw new Error('SLAVEOFAI_REQUIRE_FAKE_CLI is not 1; gate:m59-intake refuses to risk a vendor call')
  }
  try {
    accessSync(FAKE_CLAUDE, constants.R_OK)
  } catch {
    throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)
  }
  if (!FAKE_CLAUDE.startsWith(join(repoRoot, 'packages/providers/test'))) {
    throw new Error(`resolved fake CLI ${FAKE_CLAUDE} is outside this repository's provider tests`)
  }
  if (!existsSync(join(repoRoot, '.env'))) throw new Error(`no .env at ${join(repoRoot, '.env')}`)
  if ((process.env['DATABASE_URL'] ?? '') === '') throw new Error('DATABASE_URL is not set; run through npm run gate:m59-intake')
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI}; run tsc --build`)
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) throw new Error(`no Chromium binary at ${chromiumPath}`)
  await prisma.$queryRaw`select 1`
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(`gate:m59-intake REFUSED: an orchestrator daemon is already running (${strayDaemons.join(', ')})`)
  }
  await preflightCleanup()
  const originalSettings = await prisma.installationSettings.findUnique({ where: { id: 'installation' } })
  originalReposRoot = originalSettings?.reposRoot ?? null
  const template = await prisma.slaveTemplate.create({
    data: {
      name: `${TEMPLATE_PREFIX} ${STAMP}`,
      role: 'Backend engineer',
      description: 'A deterministic active catalogue entry for the M59 intake gate.',
      defaultModel: 'sonnet',
      provider: 'claude_code',
      active: true,
    },
  })
  templateId = template.id

  const childEnv = (claudeArgs = '') =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS: claudeArgs,
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
    })

  const runCli = (args) => {
    try {
      return execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
        cwd: repoRoot,
        env: childEnv(`${FAKE_CLAUDE} --fixture m8-flow --intake-repo ${fixtureRepo} --intake-template ${templateId}`),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw new Error(
        `the CLI refused \`${args.join(' ')}\` with status ${String(error.status)}\n` +
          `stdout: ${String(error.stdout)}\nstderr: ${String(error.stderr)}`,
      )
    }
  }

  async function fail(message) {
    let screenshotPath = null
    if (page !== null && diagDir !== null) {
      screenshotPath = join(diagDir, `failure-${String(Date.now())}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
    }
    throw new Error(
      `${message}\n--- browser url ---\n${page?.url() ?? '<no page>'}\n` +
        `--- screenshot ---\n${screenshotPath ?? '<none>'}\n` +
        `--- browser console ---\n${browserConsole.slice(-40).join('\n')}\n` +
        `--- rows and daemons ---\n${await dumpGateRows().catch((cause) => String(cause))}`,
    )
  }

  async function waitUntil(probe, timeoutMs, description) {
    const deadline = Date.now() + timeoutMs
    let lastError = null
    while (Date.now() < deadline) {
      try {
        const result = await probe()
        if (result) return result
      } catch (cause) {
        lastError = cause
      }
      if (activeDaemon !== null && activeDaemon.exited) {
        await fail(`${activeDaemon.label} exited while waiting for ${description}`)
      }
      await delay(POLL_INTERVAL_MS)
    }
    await fail(`timed out after ${String(timeoutMs)}ms waiting for ${description}${lastError === null ? '' : `: ${String(lastError)}`}`)
  }

  function startDaemon(label, claudeArgs) {
    const proc = spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--period', String(DAEMON_PERIOD_MS)], {
      cwd: repoRoot,
      env: childEnv(claudeArgs),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const state = { label, proc, output: '', exited: false }
    proc.stdout.on('data', (chunk) => {
      state.output += chunk.toString()
      process.stdout.write(`[${label}] ${chunk}`)
    })
    proc.stderr.on('data', (chunk) => {
      state.output += chunk.toString()
      process.stderr.write(`[${label}] ${chunk}`)
    })
    proc.on('exit', (code, signal) => {
      state.exited = true
      state.output += `\n<${label} exited: code=${String(code)} signal=${String(signal)}>\n`
    })
    proc.on('error', (error) => {
      state.exited = true
      state.output += `\n<${label} failed to start: ${String(error)}>\n`
    })
    daemons.push(state)
    activeDaemon = state
    console.log(`${label} spawned as pid ${String(proc.pid)} with NO --workspace`)
    return state
  }

  async function stopDaemon(state) {
    activeDaemon = null
    if (state.exited) return
    state.proc.kill('SIGTERM')
    const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (!state.exited && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
    if (!state.exited) state.proc.kill('SIGKILL')
  }

  async function startNext() {
    const preferredPort = await freePort()
    nextServer = spawn(
      'node',
      ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort), '-H', '127.0.0.1'],
      { cwd: repoRoot, env: loopbackChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let exited = false
    let resolvedPort = null
    nextServer.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      nextOutput += text
      process.stdout.write(`[next] ${text}`)
      const match = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(nextOutput)
      if (match) resolvedPort = Number(match[1])
    })
    nextServer.stderr.on('data', (chunk) => {
      nextOutput += chunk.toString()
      process.stderr.write(`[next] ${chunk}`)
    })
    nextServer.on('exit', () => {
      exited = true
    })
    nextServer.on('error', (error) => {
      exited = true
      nextOutput += String(error)
    })
    await waitUntil(
      () => {
        if (exited) throw new Error(`next dev exited before becoming ready: ${nextOutput}`)
        return resolvedPort !== null && /Ready in \d+/.test(nextOutput)
      },
      NEXT_READY_TIMEOUT_MS,
      'next dev to become ready',
    )
    return `http://127.0.0.1:${String(resolvedPort)}`
  }

  async function waitVisible(locator, description) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
    } catch {
      await fail(`timed out waiting for ${description} to become visible`)
    }
  }

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
        await delay(POLL_INTERVAL_MS)
      }
      if (clickError !== null) {
        await fail(`clicking ${description} failed: ${clickError instanceof Error ? clickError.message : String(clickError)}`)
      }
    }
    await fail(`clicking ${description} did not produce the expected result after a retry`)
  }

  async function gotoReliably(url) {
    const consoleStart = browserConsole.length
    const outputStart = nextOutput.length
    const raced = () =>
      browserConsole.slice(consoleStart).some((line) => line.includes(MANIFEST_RACE_SIGNATURE)) ||
      nextOutput.slice(outputStart).includes(MANIFEST_RACE_SIGNATURE)
    let first = null
    let firstError = null
    try {
      first = await page.goto(url, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
    } catch (cause) {
      firstError = cause
    }
    if (first === null && firstError === null) return null
    if (first !== null && first.status() < 500) return first
    if (!raced()) await fail(`navigation to ${url} failed without the known manifest-race signature: ${String(firstError)}`)
    gotoRetries.push(url)
    await delay(300)
    const second = await page.goto(url, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
    if (second !== null && second.status() >= 500) await fail(`navigation to ${url} returned ${String(second.status())} twice`)
    return second
  }

  const baseUrl = await startNext()
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: VIEWPORT })
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  page.on('pageerror', (error) => browserConsole.push(`[pageerror] ${String(error).slice(0, 300)}`))
  page.on('console', (message) => browserConsole.push(`[${message.type()}] ${message.text().slice(0, 300)}`))
  page.on('requestfailed', (request) => browserConsole.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`))

  // ============================================================================================
  // Stage 1: a daemon with NO --workspace, serving what is there.
  // ============================================================================================
  const daemon = startDaemon(
    'daemon',
    `${FAKE_CLAUDE} --fixture m8-flow --intake-repo ${fixtureRepo} --intake-template ${templateId}`,
  )
  await waitUntil(() => daemon.output.includes('serving '), DAEMON_START_TIMEOUT_MS, 'the daemon to say what it serves')
  const servingAtStart = /serving (\d+) projects?/.exec(daemon.output)
  console.log(`stage 1: the daemon says "${servingAtStart?.[0] ?? '(nothing)'}"`)
  if (servingAtStart === null) await fail('stage 1: the daemon never said what it serves')
  if (!daemon.output.includes('following new ones every')) {
    await fail('stage 1: a daemon started with no --workspace must say it is following new projects')
  }
  const projectsAtStart = Number(servingAtStart[1])
  console.log('stage 1 PASSED: a daemon with no --workspace started, and named what it serves')

  // ============================================================================================
  // Stage 2: the drawer opens a conversation, and the daemon answers it.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/`)
  await clickUntil(
    page.getByTestId('new-project'),
    async () => page.getByTestId('intake-conversation').isVisible(),
    'New project',
  )
  const emptyMessages = await page.getByTestId('intake-message').count()
  console.log(`stage 2: the drawer opened with ${String(emptyMessages)} message(s)`)
  if (emptyMessages !== 0) await fail('stage 2: a new conversation is not empty')
  await page.getByTestId('intake-composer').getByRole('textbox').fill('Rate limiting for our public API')
  await page.getByTestId('intake-send').click()
  await waitUntil(
    async () => (await page.getByTestId('intake-message').filter({ hasText: 'Where is the repository?' }).count()) > 0,
    REPLY_TIMEOUT_MS,
    'the assistant to ask where the repository is',
  )
  console.log('stage 2 PASSED: one sentence in, one question back, from a real daemon and a fake CLI')

  // ============================================================================================
  // Stage 3: the path, what the tree found in it, and the draft that follows.
  // ============================================================================================
  await page.getByTestId('intake-composer').getByRole('textbox').fill(fixtureRepo)
  await page.getByTestId('intake-send').click()
  await waitVisible(page.getByTestId('intake-fact-card'), 'the fact card')
  const chips = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="intake-fact-chip"]')].map((chip) => ({
      text: chip.textContent?.trim() ?? '',
      title: chip.getAttribute('title'),
    })),
  )
  console.log(`stage 3: chips = ${JSON.stringify(chips)}`)
  for (const wanted of ['npm test', 'npm run typecheck']) {
    const chip = chips.find((candidate) => candidate.text === wanted)
    if (chip === undefined) await fail(`stage 3: the fact card does not show ${wanted}`)
    if (!String(chip.title).includes('package.json')) {
      await fail(`stage 3: ${wanted} does not say where it came from (title = ${JSON.stringify(chip.title)})`)
    }
  }
  if (!chips.some((chip) => chip.text.includes('main'))) await fail('stage 3: the fact card does not name the branch')
  await waitVisible(page.getByTestId('intake-draft'), 'the draft card')
  const checked = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="intake-verify"]')].map((box) => ({
      command: box.getAttribute('data-command'),
      source: box.getAttribute('data-source'),
      checked: box.checked,
    })),
  )
  console.log(`stage 3: verify rows = ${JSON.stringify(checked)}`)
  if (!checked.every((row) => row.checked)) await fail('stage 3: a detected command arrived unchecked')
  if (checked.length !== 2) await fail(`stage 3: the draft carries ${String(checked.length)} commands, expected two`)
  const teamRoles = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="intake-team-chip"]')].map(
      (chip) => chip.getAttribute('data-roles')?.split(',').filter((role) => role !== '') ?? [],
    ),
  )
  console.log(`stage 3: team = ${JSON.stringify(teamRoles)}`)
  if (!teamRoles.some((roles) => roles.includes('manager'))) {
    await fail('stage 3: no proposed seat carries `manager`, and dispatchPlanning refuses without one')
  }
  console.log('stage 3 PASSED: the tree read the repository, and the model chose from what it read')

  // ============================================================================================
  // Stage 4: an edit, a button, and a project.
  // ============================================================================================
  await page.locator('[data-testid="intake-verify"][data-command="npm run typecheck"]').uncheck()
  await page.getByTestId('intake-draft-name').fill('Public API')
  await clickUntil(page.getByTestId('intake-create'), async () => page.url().includes('/w/'), 'Create project')
  const workspaceId = page.url().split('/w/')[1]?.split(/[/?#]/)[0] ?? ''
  workspaceIds.push(workspaceId)
  console.log(`stage 4: landed on /w/${workspaceId}`)
  const created = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  console.log(
    `stage 4: the row = ${JSON.stringify({ name: created?.name, verify: created?.verifyCommands, goalVersion: created?.goalVersion })}`,
  )
  if (created === null) await fail('stage 4: the browser landed on a project that is not in the database')
  if (created.name !== 'Public API') await fail(`stage 4: the project is called ${JSON.stringify(created.name)}, and the card was renamed`)
  if (JSON.stringify(created.verifyCommands) !== JSON.stringify(['npm test'])) {
    await fail(`stage 4: the project verifies with ${JSON.stringify(created.verifyCommands)}; one was unchecked`)
  }
  if (created.goalVersion !== 1) await fail(`stage 4: the project is on goal v${String(created.goalVersion)}, expected v1`)
  const firstIntake = await prisma.intake.findUnique({ where: { workspaceId }, select: { id: true } })
  if (firstIntake === null) await fail('stage 4: the created project is not linked to its conversation')
  intakeIds.push(firstIntake.id)
  const goalEvent = await prisma.executionEvent.findFirst({ where: { workspaceId, type: 'workspace_goal_set' } })
  if (!String(goalEvent?.payload?.request ?? '').includes('Rate limiting for our public API')) {
    await fail(`stage 4: the goal event's request is ${JSON.stringify(goalEvent?.payload?.request)}`)
  }
  const createdEvent = await prisma.executionEvent.findFirst({ where: { workspaceId, type: 'workspace_created' } })
  if (createdEvent?.payload?.intakeId !== firstIntake.id) {
    await fail(
      `stage 4: the created event carries intake ${JSON.stringify(createdEvent?.payload?.intakeId)}, expected ${firstIntake.id}`,
    )
  }
  console.log('stage 4 PASSED: one button, and a project whose definition of done is a command that really exists')

  // ============================================================================================
  // Stage 5: the daemon follows, staffs, and plans the project.
  // ============================================================================================
  await waitUntil(
    () => new RegExp(`serving ${String(projectsAtStart + 1)} projects?`).test(daemon.output),
    DISCOVERY_TIMEOUT_MS,
    `the daemon to say it serves ${String(projectsAtStart + 1)} projects`,
  )
  console.log(`stage 5: the daemon now says "${daemon.output.match(/serving \d+ projects?[^\n]*/g)?.at(-1) ?? ''}"`)
  const intakeRow = await prisma.intake.findUnique({ where: { workspaceId } })
  const staffStep = (intakeRow?.stepLog ?? []).find((entry) => entry.step === 'staff')
  console.log(`stage 5: the staff step = ${JSON.stringify(staffStep)}`)
  if (staffStep?.status !== 'done') {
    await fail(`stage 5: the staff step is ${JSON.stringify(staffStep)}, and M58 has landed -- it must hire`)
  }
  const seats = await prisma.slave.findMany({
    where: { team: { workspaceId } },
    select: { person: { select: { name: true } }, runtimeRoles: true },
  })
  console.log(`stage 5: the team = ${JSON.stringify(seats)}`)
  if (!seats.some((seat) => seat.runtimeRoles.includes('manager'))) {
    await fail('stage 5: nobody on the new project holds `manager`, so nothing can ever be planned')
  }
  await waitUntil(
    async () => (await prisma.slaveRun.count({ where: { kind: 'planning', slave: { team: { workspaceId } } } })) > 0,
    PLANNING_TIMEOUT_MS,
    'a planning run on the project the conversation created',
  )
  const planning = await prisma.slaveRun.findFirstOrThrow({
    where: { kind: 'planning', slave: { team: { workspaceId } } },
  })
  const planningTerminal = await waitUntil(
    async () => {
      const run = await prisma.slaveRun.findUnique({ where: { id: planning.id } })
      return run?.status === 'succeeded' || run?.status === 'failed' ? run : false
    },
    PLANNING_TIMEOUT_MS,
    `planning run ${planning.id} to finish`,
  )
  console.log(`stage 5: planning run ${planningTerminal.id} is ${planningTerminal.status}`)
  if (planningTerminal.status !== 'succeeded') {
    const failed = await prisma.executionEvent.findFirst({
      where: { runId: planningTerminal.id, type: 'run_failed' },
      orderBy: { seq: 'desc' },
      select: { payload: true },
    })
    await fail(
      `stage 5: planning run ${planningTerminal.id} is ${planningTerminal.status}: ${JSON.stringify(failed?.payload ?? null)}`,
    )
  }
  if (planningTerminal.costUsd !== 0.20933900000000003) {
    await fail(
      `stage 5: planning run ${planningTerminal.id} cost ${String(planningTerminal.costUsd)}, expected the fake fixture's measured 0.20933900000000003`,
    )
  }
  console.log('stage 5 PASSED: a project created by a conversation, staffed by it, and planned by a daemon nobody told about it')

  // ============================================================================================
  // Stage 6: a project with no repository at all.
  // ============================================================================================
  runCli(['settings', 'repos-root', '--set', reposRoot])
  await gotoReliably(`${baseUrl}/`)
  await clickUntil(
    page.getByTestId('new-project'),
    async () => page.getByTestId('intake-conversation').isVisible(),
    'New project',
  )
  await page.getByTestId('intake-composer').getByRole('textbox').fill('I have an idea and want a NEW REPOSITORY for it')
  await page.getByTestId('intake-send').click()
  await waitVisible(page.getByTestId('intake-draft'), 'the draft card for a project with no repository')
  await clickUntil(page.getByTestId('intake-create'), async () => page.url().includes('/w/'), 'Create project')
  const secondId = page.url().split('/w/')[1]?.split(/[/?#]/)[0] ?? ''
  workspaceIds.push(secondId)
  const second = await prisma.workspace.findUnique({ where: { id: secondId } })
  if (second === null) await fail('stage 6: the browser landed on a project that is not in the database')
  const secondIntake = await prisma.intake.findUnique({ where: { workspaceId: secondId }, select: { id: true } })
  if (secondIntake === null) await fail('stage 6: the created project is not linked to its conversation')
  intakeIds.push(secondIntake.id)
  console.log(`stage 6: created ${JSON.stringify(second?.repoPath)} under ${reposRoot}`)
  if (dirname(second.repoPath) !== reposRoot) {
    await fail(`stage 6: the repository went to ${JSON.stringify(second?.repoPath)}, and Settings said ${reposRoot}`)
  }
  const log = execFileSync('git', ['-C', second.repoPath, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n')
  const readme = readFileSync(join(second.repoPath, 'README.md'), 'utf8')
  console.log(`stage 6: ${String(log.length)} commit(s), README ${String(readme.length)} bytes`)
  if (log.length !== 1) await fail(`stage 6: the new repository has ${String(log.length)} commits, expected exactly one`)
  if (!readme.includes('A brand new service')) await fail('stage 6: the README does not carry the goal')
  console.log('stage 6 PASSED: a person with an idea and no repository has a project, a repository and a first commit')

  // ============================================================================================
  // Stage 7: the same flow with no browser at all.
  // ============================================================================================
  const opened = JSON.parse(runCli(['intake', 'open']))
  intakeIds.push(opened.id)
  runCli(['intake', 'say', '--intake', opened.id, '--text', `our repository is at ${fixtureRepo}`])
  await waitUntil(
    () => JSON.parse(runCli(['intake', 'show', '--intake', opened.id])).status === 'drafted',
    REPLY_TIMEOUT_MS,
    'the daemon to answer the CLI conversation with a draft',
  )
  const shown = JSON.parse(runCli(['intake', 'show', '--intake', opened.id]))
  console.log(`stage 7: the CLI draft = ${JSON.stringify(shown.draft?.verifyCommands)}`)
  shown.draft.name = 'Public API From The CLI'
  const draftFile = join(tempRoot, 'cli-draft.json')
  writeFileSync(draftFile, JSON.stringify(shown.draft))
  const accepted = JSON.parse(runCli(['intake', 'accept', '--intake', opened.id, '--draft', draftFile]))
  workspaceIds.push(accepted.workspaceId)
  const fromCli = await prisma.workspace.findUnique({ where: { id: accepted.workspaceId } })
  console.log(
    `stage 7: the CLI made ${JSON.stringify({ name: fromCli?.name, verify: fromCli?.verifyCommands, goalVersion: fromCli?.goalVersion })}`,
  )
  if (JSON.stringify(fromCli?.verifyCommands) !== JSON.stringify(['npm test', 'npm run typecheck'])) {
    await fail(`stage 7: the CLI project verifies with ${JSON.stringify(fromCli?.verifyCommands)}`)
  }
  if (fromCli?.goalVersion !== 1) await fail('stage 7: the CLI project has no goal v1')
  console.log('stage 7 PASSED: the same shape, without a browser')

  // ============================================================================================
  // Stage 8: the money is not invisible.
  // ============================================================================================
  const spendRow = await prisma.intake.findUnique({ where: { id: firstIntake.id } })
  console.log(
    `stage 8: the conversation cost ${JSON.stringify({
      calls: spendRow?.modelCalls,
      usd: spendRow?.modelCostUsd,
      unmeasured: spendRow?.unmeasuredCalls,
    })}`,
  )
  if (spendRow?.modelCalls !== 2) await fail(`stage 8: the conversation records ${String(spendRow?.modelCalls)} calls, expected two`)
  if (spendRow.modelCostUsd !== 0.02) {
    await fail(`stage 8: the conversation records ${String(spendRow.modelCostUsd)} USD, expected 0.02`)
  }
  await gotoReliably(`${baseUrl}/`)
  // M61 R11/Task 8: Home is a LIST -- `project-card`/`data-workspace-id` became
  // `project-row`/`data-workspace` when `ProjectsClient`'s card grid was replaced. Same
  // assertion: the conversation produced exactly one project, and it is on Home once.
  const exactCard = page.locator(`[data-testid="project-row"][data-workspace="${workspaceId}"]`)
  await waitVisible(exactCard, `the row for workspace ${workspaceId} on Home`)
  if ((await exactCard.count()) !== 1) await fail(`stage 8: expected exactly one row for workspace ${workspaceId}`)
  // $0.02 intake + the plan-graph fixture's measured $0.209339 = $0.23 at card precision.
  const expectedCardSpend = '$0.23'
  const cardSpend = await exactCard.textContent().catch(() => null)
  console.log(`stage 8: the project card reads ${JSON.stringify(cardSpend)}`)
  if ((await exactCard.getByText(expectedCardSpend, { exact: true }).count()) < 1) {
    await fail(`stage 8: workspace ${workspaceId}'s card does not show the formatted spend ${expectedCardSpend}`)
  }
  console.log('stage 8 PASSED: the conversation charged what it spent, and the card shows it')

  await stopDaemon(daemon)
  const remainingDaemons = findRealDaemonPids()
  if (remainingDaemons.length > 0) await fail(`the daemon remained alive after shutdown: ${remainingDaemons.join(', ')}`)
  console.log(`navigation manifest-race retries: ${String(gotoRetries.length)}`)
  console.log('PASS: eight M59 intake stages passed; run gate:m26-vocabulary and gate:m15-boundary beside this gate')
  exitCode = 0
} finally {
  for (const daemon of daemons) {
    if (!daemon.exited && daemon.proc.exitCode === null) {
      daemon.proc.kill('SIGTERM')
      const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
      while (!daemon.exited && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
      if (!daemon.exited) daemon.proc.kill('SIGKILL')
    }
  }
  if (browser !== null) await browser.close().catch(() => {})
  if (nextServer !== null && nextServer.exitCode === null) {
    nextServer.kill('SIGTERM')
    const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextServer.exitCode === null && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
    if (nextServer.exitCode === null) nextServer.kill('SIGKILL')
  }
  // Child rows first: each captured intake is the exact row linked to one created workspace.
  for (const intakeId of [...new Set(intakeIds)]) {
    await prisma.intake.delete({ where: { id: intakeId } }).catch(() => {})
  }
  for (const workspaceId of [...new Set(workspaceIds)]) {
    await deleteWorkspaceDeeply(workspaceId)
  }
  if (templateId !== null) await prisma.slaveTemplate.delete({ where: { id: templateId } }).catch(() => {})
  if (originalReposRoot !== undefined) {
    if (originalReposRoot === null) {
      await prisma.installationSettings
        .upsert({ where: { id: 'installation' }, create: { id: 'installation', reposRoot: null }, update: { reposRoot: null } })
        .catch(() => {})
    } else {
      await prisma.installationSettings
        .upsert({
          where: { id: 'installation' },
          create: { id: 'installation', reposRoot: originalReposRoot },
          update: { reposRoot: originalReposRoot },
        })
        .catch(() => {})
    }
  }
  if (fixtureRepo !== null) rmSync(fixtureRepo, { recursive: true, force: true })
  if (tempRoot !== null) rmSync(tempRoot, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
