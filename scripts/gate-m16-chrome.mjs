// M16's own gate (Task 9 brief, spec §6): the chrome numbers read back from the page.
//
// Boot skeleton from `scripts/gate-m15-boundary.mjs` -- a free port, `next dev apps/web -p <port>
// -H 127.0.0.1`, a ready-wait that parses the ACTUAL bound port back out of next dev's own ready
// line, the child killed in `finally`, and the same discipline every gate in this repo uses: dist
// imports only, one top-level `try` with no `catch`, `let exitCode = 1` set to `0` only by falling
// off the end of the try, and `process.exit(exitCode)` as the literal last line.
//
// UNLIKE m15 this gate READS COMPUTED STYLES -- `getComputedStyle` needs a real box model, which a
// plain `fetch` against the HTML cannot give it -- so it needs a real browser, exactly the way
// `scripts/gate-m14-fidelity.mjs` does: `playwright-core` driving a real Chromium at
// `CHROMIUM_PATH` (default `/usr/bin/chromium`; on a machine without that binary, point it at a
// playwright-installed one, e.g.
// `CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`).
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome npm run gate:m16-chrome
//
// UNLIKE m14 this gate writes NOTHING to the database: every check reads the SEEDED DEVELOPMENT
// DATABASE (`--env-file=.env`, same as every other gate) as it already stands after `npm run
// db:seed`, and the one place this file touches Prisma at all is a read used as an independent
// oracle for the Projects check (spec §6 stage 3) -- the same "read it back from somewhere the
// page itself did not derive it" discipline `gate-m14-fidelity.mjs`'s stage 5 uses for Analytics.
//
// The five checks (spec §6):
//   1. Overview `/w/<seed>`: the goal form's radii -- `goal-input` at 7px, `goal-submit` at 5px.
//   2. Settings `/settings`: the permission matrix's cell glyphs -- at least two distinct glyphs,
//      and `–` (unset) distinct from `✕` (denied), whenever both exist. The seeded database has NO
//      `AgentPermission` rows, so every cell is unset and this check is vacuous-but-stated: it
//      prints the one glyph found and passes rather than silently skipping.
//   3. Projects `/`: a workspace card's `team-overflow` pill iff its TRUE team size (read straight
//      from Prisma, an independent oracle) is over six -- and the seed's own 9-agent workspace
//      proves the tile genuinely reachable (fix round 1: `server/org.ts` no longer caps
//      `ProjectRow.team` server-side).
//   4. Repo hygiene (no browser): Task 7's own clean-check grep, expected empty.
//   5. Analytics `/analytics`: a per-agent row whose success cell reads `—` has a progress bar with
//      no `aria-valuenow`; if no such row exists in the seed, the fallback proves the wiring exists
//      the other way -- at least one progress bar DOES carry `aria-valuenow`.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: like `gate-m14-fidelity.mjs` and
// `gate-m15-boundary.mjs`, this gate boots `next dev` against the repo's own `apps/web/.next` (no
// temp dir, no throwaway build) on a freshly-chosen free port, and a second `next dev` sharing that
// same `.next` directory with one already running corrupts the on-disk build cache for both. Stop
// any running dev server first (`pgrep -af "next dev"`).
//
//   npm run gate:m16-chrome

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { prisma } from '../packages/db/dist/client.js'

const NEXT_READY_TIMEOUT_MS = 180_000
const ACTION_TIMEOUT_MS = 30_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const PASS_LINE = "one tone table, the handoff's forms"

const SEED_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'

// Task 7's own clean-check (spec §5 Step 4), run verbatim: `--` guards `--status-` from being
// parsed as a grep flag.
const HYGIENE_PATTERN =
  '--status-\\|status-working\\|status-starting\\|status-paused\\|status-stopping\\|status-idle\\|status-danger\\|status-warn'
const HYGIENE_ROOTS = ['apps/web/src', 'apps/web/test']

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Asks the OS for a free TCP port. `next dev -p <port>` still auto-increments if something grabs
 *  it between this call and the spawn, so the ready-wait parses the ACTUAL bound port back out of
 *  next dev's own ready line rather than trusting this one blindly.
 *  (`scripts/gate-m15-boundary.mjs`, verbatim.) */
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

let exitCode = 1
let nextServer = null
let browser = null
let page = null
let diagDir = null

try {
  diagDir = mkdtempSync(join(tmpdir(), 'aiteamos-gate-m16-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ---- Preflight. -------------------------------------------------------------------------------
  const envPath = join(repoRoot, '.env')
  if (!existsSync(envPath)) {
    throw new Error(`no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m16-chrome passes --env-file=.env)`)
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m16-chrome`')
  }
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- this gate reads computed styles, so set CHROMIUM_PATH to a real ` +
        'executable (e.g. a playwright-installed chromium under ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome).',
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
  const seedWorkspace = await prisma.workspace.findUnique({ where: { id: SEED_WORKSPACE_ID } })
  if (seedWorkspace === null) {
    throw new Error(`no workspace ${SEED_WORKSPACE_ID} in the database -- run \`npm run db:seed\` before this gate`)
  }
  console.log(`chromium: ${chromiumPath}`)
  console.log(`seed workspace: ${seedWorkspace.id} (${seedWorkspace.name})`)

  // ============================================================================================
  // Check 4: repo hygiene (no browser). Runs first -- it needs nothing this gate is about to boot,
  // and a stale token left behind is worth failing on before spending any time on `next dev`.
  // ============================================================================================
  {
    const result = spawnSync('grep', ['-rn', '--', HYGIENE_PATTERN, ...HYGIENE_ROOTS], { cwd: repoRoot, encoding: 'utf8' })
    // grep exits 1 with empty output when nothing matches -- the passing case. Exit 0 means it
    // found the very tokens Task 7's rename was supposed to remove. Anything else (2+) is grep
    // itself failing (a bad path, a missing root) and must not be read as a silent pass.
    if (result.status === 0) {
      throw new Error(`check 4 (repo hygiene): stale status-* tokens found:\n${result.stdout}`)
    }
    if (result.status !== 1) {
      throw new Error(
        `check 4 (repo hygiene): grep exited ${String(result.status)}, expected 1 (no matches) -- ` +
          `stderr: ${result.stderr}`,
      )
    }
    console.log('check 4 PASSED: repo hygiene grep is empty -- no stale status-* token under apps/web/src or apps/web/test')
  }

  // ---- The real web shell, on a free port, loopback-bound. -------------------------------------
  const preferredPort = await findFreePort()
  nextServer = spawn(
    'node',
    ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort), '-H', '127.0.0.1'],
    { cwd: repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
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
  const url = (path) => `${baseUrl}${path}`

  browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  const browserConsole = []
  page.on('pageerror', (error) => console.error(`[browser:pageerror] ${error}`))
  page.on('console', (message) => {
    browserConsole.push(`[${message.type()}] ${message.text().slice(0, 300)}`)
    if (browserConsole.length > 200) browserConsole.shift()
  })

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

  /** Reads one computed property off the first match of `selector`, on the page currently open. */
  async function computed(selector, property) {
    return page.evaluate(
      ([sel, prop]) => {
        const element = document.querySelector(sel)
        if (element === null) return null
        return window.getComputedStyle(element).getPropertyValue(prop)
      },
      [selector, property],
    )
  }

  const normalize = (value) => value.trim().replace(/\s+/g, ' ')

  async function assertComputed(checkName, selector, property, expected) {
    const actual = await computed(selector, property)
    if (actual === null) await fail(`${checkName}: no element matched ${selector}`)
    if (normalize(actual) !== normalize(expected)) {
      await fail(`${checkName}: ${selector} ${property} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
    }
    console.log(`${checkName}: ${selector} ${property} = ${actual}`)
  }

  // ============================================================================================
  // Check 1: Overview /w/<seed> -- the goal form's radii.
  // ============================================================================================
  await page.goto(url(`/w/${SEED_WORKSPACE_ID}`), { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('strip'), "the Overview strip")
  await waitVisible(page.getByTestId('goal-input'), "the goal form's input (the seed workspace's goal must be unset)")
  await assertComputed('check 1 (overview goal form)', '[data-testid="goal-input"]', 'border-radius', '7px')
  await assertComputed('check 1 (overview goal form)', '[data-testid="goal-submit"]', 'border-radius', '5px')
  console.log('check 1 PASSED: the goal input is 7px and the set-goal button is 5px, read back from getComputedStyle')

  // ============================================================================================
  // Check 2: Settings /settings -- the permission matrix's cell glyphs.
  // ============================================================================================
  await page.goto(url('/settings'), { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('perm-caption'), "the permission matrix's caption")
  const glyphs = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="perm-cell-"]')].map((element) => element.textContent?.trim() ?? ''),
  )
  if (glyphs.length === 0) {
    await fail('check 2 (settings matrix): no permission cells rendered at all -- the matrix has no rows to read')
  }
  const distinctGlyphs = new Set(glyphs)
  if (distinctGlyphs.size < 2) {
    console.log(
      `check 2: every one of the ${String(glyphs.length)} matrix cell(s) shares one mode -- glyph ${JSON.stringify(
        [...distinctGlyphs][0],
      )} -- vacuous-but-stated pass (the seeded database has no AgentPermission rows)`,
    )
  } else {
    const hasUnset = distinctGlyphs.has('–')
    const hasDenied = distinctGlyphs.has('✕')
    if (hasUnset && hasDenied) assert('–' !== '✕', 'check 2 (settings matrix): unset and denied glyphs must be distinct')
    console.log(
      `check 2 PASSED: ${String(distinctGlyphs.size)} distinct glyph(s) across ${String(glyphs.length)} cell(s) -- ` +
        `${JSON.stringify([...distinctGlyphs])}`,
    )
  }

  // ============================================================================================
  // Check 3: Projects / -- team-overflow iff the TRUE team size (read from Prisma, independent of
  // whatever the page itself renders) is over six.
  //
  // Fix round 1 (controller ruling): `server/org.ts`'s `listProjects` USED to cap `ProjectRow.team`
  // at 6 agents server-side, on top of the six-avatar cap `ProjectsClient.tsx` already owns --
  // which made `team-overflow` structurally unreachable no matter how large a workspace's real
  // roster was. That server-side `.slice(0, 6)` is gone: `ProjectRow.team` now carries the FULL
  // team, so this check asserts the genuine oracle (the raw roster size) with no accommodation for
  // a cap that no longer exists.
  // ============================================================================================
  const workspacesByName = await prisma.workspace.findMany({
    include: { teams: { include: { agents: true } } },
    orderBy: { name: 'asc' },
  })
  const trueTeamSizes = workspacesByName.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    size: workspace.teams.reduce((n, team) => n + team.agents.length, 0),
  }))

  await page.goto(url('/'), { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('project-card'), 'a project card')
  const cardCount = await page.getByTestId('project-card').count()
  if (cardCount !== trueTeamSizes.length) {
    await fail(
      `check 3 (projects): ${String(cardCount)} project card(s) rendered, but Prisma has ${String(trueTeamSizes.length)} ` +
        'workspace(s) -- the page and the independent oracle disagree on how many projects exist',
    )
  }
  let sawOverflow = false
  for (let index = 0; index < trueTeamSizes.length; index += 1) {
    const oracle = trueTeamSizes[index]
    const card = page.getByTestId('project-card').nth(index)
    const overflow = card.getByTestId('team-overflow')
    const overflowCount = await overflow.count()
    if (oracle.size > 6) {
      const expectedText = `+${String(oracle.size - 6)}`
      if (overflowCount === 0) {
        await fail(
          `check 3 (projects): workspace ${oracle.id} (${oracle.name}) has ${String(oracle.size)} team members ` +
            `(>6) but its card shows no team-overflow pill`,
        )
      }
      const actualText = (await overflow.first().textContent())?.trim() ?? ''
      assert(
        actualText === expectedText,
        `check 3 (projects): workspace ${oracle.id} (${oracle.name}) team-overflow reads ${JSON.stringify(actualText)}, ` +
          `expected ${JSON.stringify(expectedText)} (${String(oracle.size)} members)`,
      )
      sawOverflow = true
      console.log(
        `check 3: workspace ${oracle.name} genuinely has ${String(oracle.size)} team members -- team-overflow reads ` +
          `${actualText}, proving the tile is reachable`,
      )
    } else {
      if (overflowCount !== 0) {
        await fail(
          `check 3 (projects): workspace ${oracle.id} (${oracle.name}) has ${String(oracle.size)} team members ` +
            `(<=6) but its card shows a team-overflow pill anyway`,
        )
      }
      console.log(`check 3: workspace ${oracle.name} has ${String(oracle.size)} team members (<=6) -- team-overflow correctly absent`)
    }
  }
  console.log(
    sawOverflow
      ? `check 3 PASSED: team-overflow matches Prisma's own team-size count on all ${String(cardCount)} project card(s), ` +
          'and a genuine >6-member workspace proved the tile reachable'
      : `check 3 PASSED: team-overflow matches Prisma's own team-size count on all ${String(cardCount)} project card(s) ` +
          '(no workspace in this database has more than 6 team members, so only the absent-branch was exercised)',
  )

  // ============================================================================================
  // Check 5: Analytics /analytics -- a `—` success cell pairs with a progress bar carrying no
  // `aria-valuenow`; the fallback proves the wiring the other way if no such row exists.
  // ============================================================================================
  await page.goto(url('/analytics'), { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('kpi-tile'), "an Analytics KPI tile")
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="data-table-row"]')]
      .map((row) => {
        const successCell = row.querySelector('[data-testid^="perf-success-"]')
        const bar = row.querySelector('[data-testid="progress-bar"]')
        if (successCell === null || bar === null) return null
        return {
          success: successCell.textContent?.trim() ?? '',
          hasValueNow: bar.hasAttribute('aria-valuenow'),
        }
      })
      .filter((row) => row !== null),
  )
  if (rows.length === 0) {
    await fail('check 5 (analytics): no per-agent performance rows rendered at all')
  }
  const unmeasuredRows = rows.filter((row) => row.success === '—')
  if (unmeasuredRows.length === 0) {
    const wired = rows.some((row) => row.hasValueNow)
    assert(
      wired,
      'check 5 (analytics): no row has an unmeasured (—) success cell, and the fallback found no progress bar ' +
        'carrying aria-valuenow either -- the wiring cannot be shown to exist at all',
    )
    console.log(
      `check 5: no row in the seed has an unmeasured success cell -- fallback pass: at least one of ` +
        `${String(rows.length)} progress bar(s) carries aria-valuenow`,
    )
  } else {
    for (const row of unmeasuredRows) {
      assert(
        !row.hasValueNow,
        `check 5 (analytics): a row reads — for success but its progress bar still carries aria-valuenow`,
      )
    }
    console.log(
      `check 5 PASSED: ${String(unmeasuredRows.length)} of ${String(rows.length)} row(s) read — for success, ` +
        'and every one of them has a progress bar with no aria-valuenow',
    )
  }

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
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
