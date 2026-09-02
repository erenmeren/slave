// M19's own gate (Task 14 brief): "a typed build that bites, a real capture, cables that measure,
// and a ledger that adds up". Shape cribbed from `gate-m18-skill-and-teeth.mjs` verbatim where it
// applies -- dist imports only, one top-level `try` with no `catch`, `let exitCode = 1` set to `0`
// only by falling off the end of the try, `process.exit(exitCode)` the literal last line, `fail()`'s
// diagnostic dump, `gotoReliably`'s signature-gated retry, the route warm-up loop, the hardened
// "is a real daemon running" refusal, and the FK-ordered `finally` cleanup.
//
// WHAT DIFFERS FROM m18, and it is the whole point of this gate's zero-spend story: **this gate
// spawns no vendor CLI at all, and no orchestrator daemon either.** M19's two paid measurements
// (A1's real `claude` matrix-deny capture, A2's `cursor-agent` version probe) happened ONCE, during
// execution, and their evidence is RECORDED -- in the fixture, in that directory's README, and in
// the spec's spend ledger. A gate that re-ran them would spend money every time someone checked the
// milestone, which is the opposite of what a milestone that is about measurement should teach. So
// m14's outer `AITEAMOS_CLAUDE_BIN` precondition is deliberately NOT enforced here: there is no
// dispatch for it to guard. What this gate does instead is READ the recorded evidence and refuse if
// it has gone missing, been softened, or stopped adding up.
//
// The six checks (the spec's five, with the typecheck step's own bite proof counted separately):
//   1. TYPECHECK (C2): `npm run --silent typecheck` exits 0, AND the command form is proven to bite
//      -- a scratch tsconfig extending `apps/web/tsconfig.test.json` over one deliberately broken
//      file must exit nonzero with a TS error, and over one good file must exit 0. The planted red
//      NEVER touches the working tree; it lives in this gate's own temp dir and dies with it.
//   2. FIXTURE PROVENANCE (A1): `permission-matrix-deny.ndjson` parses line by line, carries exactly
//      one `result` line with a non-empty `permission_denials`, and its README section names a CLI
//      version, a capture date, a `total_cost_usd`-derived cost and a runnable capture command --
//      and the replay-mode table row for it no longer calls it hand-authored. The README's standing
//      redaction rules must still number five (A1's finding 5 added the fifth; a future capture
//      inherits it).
//   3. CABLE THICKNESS (C3): in a real browser against a real `next dev`, two aggregate skill cables
//      seeded at succession counts 3 and 1 must render at DIFFERENT computed `stroke-width`, thicker
//      for the busier one. Read off the live DOM, not off the builder.
//   4. EQUIVALENCE TESTS (C5): `vitest run apps/web/test/integration/org-workers-groups.test.ts` as a
//      child process, exit 0 required. Runs BEFORE this gate starts `next dev` and against the
//      separate TEST database (`test-setup/require-database.ts` rewrites `DATABASE_URL`), so it
//      never overlaps anything this gate holds open -- and this gate never starts a daemon, so the
//      standing "no daemon while the integration suite runs" rule is satisfied by construction.
//   5. INDEX (C1): one `pg_indexes` SELECT for `ExecutionEvent_skill_calls_idx`, refusing with the
//      named migrate command if the dev database never got the M19 migration (m18's refusal
//      pattern -- a gate that silently migrates a database out from under an operator is a gate
//      nobody trusts).
//   6. LEDGER: the spec's spend table parses, every `Actual` cell holds a real figure rather than
//      the planning placeholder, and the actuals sum to no more than the milestone's $2.00 cap.
//
// Cheap, file-and-database checks run first and the browser stage runs last, so a missing migration
// or a softened README costs seconds rather than a full dev-server boot.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { chromium } from 'playwright-core'
import { appendEvent } from '../packages/events/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'

const POLL_INTERVAL_MS = 25
const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const TYPECHECK_TIMEOUT_MS = 600_000
const VITEST_TIMEOUT_MS = 600_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const SPEC_PATH = join(repoRoot, 'docs/superpowers/specs/2026-09-01-m19-measure-and-harden-design.md')
const FIXTURE_PATH = join(repoRoot, 'packages/providers/test/fixtures/permission-matrix-deny.ndjson')
const FIXTURE_README_PATH = join(repoRoot, 'packages/providers/test/fixtures/README.md')
const CAPTURE_SCRIPT = join(repoRoot, 'scripts/capture-matrix-deny.mjs')
const WEB_TEST_TSCONFIG = join(repoRoot, 'apps/web/tsconfig.test.json')
const TSC_BIN = join(repoRoot, 'node_modules/typescript/bin/tsc')
const VITEST_BIN = join(repoRoot, 'node_modules/vitest/vitest.mjs')
const EQUIVALENCE_TEST = 'apps/web/test/integration/org-workers-groups.test.ts'
const SKILL_INDEX_NAME = 'ExecutionEvent_skill_calls_idx'
const SPEND_CAP_USD = 2

const runTimestamp = new Date().toISOString()
const WORKSPACE_PREFIX = 'M19 Gate'
const WORKSPACE_NAME = `${WORKSPACE_PREFIX} Project ${runTimestamp.slice(11, 19)}`
const WORKER_NAME = 'Gate Worker'
const PASS_LINE = 'a typed build that bites, a real capture, cables that measure, and a ledger that adds up'

const WORKER_MODEL = 'sonnet'
const WORKER_PROVIDER = 'claude_code'

// The two seeded successions the thickness check reads. Three runs each calling HEAVY_FROM then
// HEAVY_TO give that pair a succession count of 3; one run calling LIGHT_FROM then LIGHT_TO gives
// that pair a count of 1. Three separate runs rather than one alternating run on purpose: an
// A,B,A,B,A,B chain would also mint the reverse edge B->A, i.e. a cycle, and a cycle is one more
// thing ELK's `layered` pass has to decide about for no gain to what this check measures.
const HEAVY_FROM = 'm19-heavy-from'
const HEAVY_TO = 'm19-heavy-to'
const LIGHT_FROM = 'm19-light-from'
const LIGHT_TO = 'm19-light-to'
const HEAVY_EDGE_ID = `skill:${HEAVY_FROM}->skill:${HEAVY_TO}`
const LIGHT_EDGE_ID = `skill:${LIGHT_FROM}->skill:${LIGHT_TO}`
/** `CableEdge.tsx`'s `widthFor(undefined, false)` -- the flat literal a weightless inactive cable
 *  has always drawn at, and what a weight-1 cable must still resolve to. */
const INACTIVE_BASE_WIDTH = 3

let exitCode = 1
let repoPath = null
let workspaceId = null
let nextOutput = ''
let nextServer = null
let browser = null
let page = null
let diagDir = null
/** Append-only for the life of one gate run -- see `gate-m14-fidelity.mjs`'s identical field for the
 *  full rationale (a cap-and-shift on this array once silently killed `gotoReliably`'s retry
 *  signature check for the rest of a run). */
const browserConsole = []
const MANIFEST_RACE_SIGNATURE = 'Unexpected end of JSON input'
const gotoRetries = []

function pushBrowserConsole(text) {
  browserConsole.push(text.slice(0, 300))
  if (browserConsole.length % 10_000 === 0) {
    console.warn(`browserConsole has grown to ${String(browserConsole.length)} entries this run -- unusually chatty, kept append-only on purpose`)
  }
}

/** `gate-m18-skill-and-teeth.mjs`'s `makeRepo`, verbatim: `Workspace.repoPath` points at a real
 *  repository everywhere else in this product, and a gate's fixture workspace should not be the one
 *  place it does not. */
function makeRepo(suffix) {
  const dir = mkdtempSync(join(tmpdir(), `aiteamos-gate-m19-${suffix}-`))
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

/** `gate-m17-stability.mjs`'s hardened daemon check, cribbed verbatim: `pgrep -f 'cli.js daemon'`
 *  false-matches this gate's OWN wrapper-shell ancestry, so a candidate PID is only trusted once its
 *  real argv (`/proc/<pid>/cmdline`, null-byte separated) shows `cli.js` immediately followed by the
 *  literal argv `daemon`. */
function isRealDaemonProcess(pid) {
  let cmdline
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'latin1')
  } catch {
    return false
  }
  const argv = cmdline.split('\0').filter((part) => part !== '')
  for (let i = 0; i < argv.length - 1; i += 1) {
    if ((argv[i] === 'cli.js' || argv[i].endsWith('/cli.js')) && argv[i + 1] === 'daemon') return true
  }
  return false
}

async function preflightCleanup() {
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

async function dumpGateRows() {
  const workspaces = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true },
  })
  const dump = []
  for (const workspace of workspaces) {
    const runs = await prisma.agentRun.findMany({
      where: { agent: { team: { workspaceId: workspace.id } } },
      include: { agent: { select: { name: true } } },
      orderBy: { startedAt: 'asc' },
    })
    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { seq: 'asc' },
      select: { seq: true, runId: true, type: true, payload: true },
    })
    dump.push({
      workspace,
      runs: runs.map((run) => ({ id: run.id, agent: run.agent.name, status: run.status })),
      events: events.map((event) => ({ seq: event.seq, runId: event.runId, type: event.type, payload: event.payload })),
    })
  }
  return JSON.stringify(dump, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
}

async function fail(message) {
  let screenshotPath = null
  if (page !== null && diagDir !== null) {
    screenshotPath = join(diagDir, `failure-${String(Date.now())}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
  }
  const rows = await dumpGateRows().catch(
    (cause) => `<could not dump gate rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
  )
  const url = page === null ? '<no page>' : page.url()
  throw new Error(
    `${message}\n--- browser url ---\n${url}\n--- screenshot ---\n${screenshotPath ?? '<none>'}\n` +
      `--- browser console (tail) ---\n${browserConsole.slice(-40).join('\n')}\n--- gate rows ---\n${rows}`,
  )
}

async function waitUntil(description, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs
  let lastDetail = '<never probed>'
  for (;;) {
    const result = await probe()
    if (result.done) return result.value
    lastDetail = result.detail
    if (Date.now() > deadline) {
      await fail(`timed out after ${String(timeoutMs)}ms waiting for ${description} -- last seen: ${lastDetail}`)
    }
    await delay(POLL_INTERVAL_MS)
  }
}

async function waitVisible(locator, description) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
  } catch {
    await fail(`timed out waiting for ${description} to become visible`)
  }
}

/** `gate-m14-fidelity.mjs`'s `gotoReliably`, verbatim (see that file for the full rationale: one
 *  retry, ONLY on `next dev`'s own manifest-race signature, everything else fails immediately). */
async function gotoReliably(url) {
  const consoleStart = browserConsole.length
  const nextOutputStart = nextOutput.length
  const raced = () =>
    browserConsole.slice(consoleStart).some((line) => line.includes(MANIFEST_RACE_SIGNATURE)) ||
    nextOutput.slice(nextOutputStart).includes(MANIFEST_RACE_SIGNATURE)

  const describe = (response, error) => {
    if (error !== null) return `failed (${error instanceof Error ? error.message : String(error)})`
    if (response === null) return 'resolved with no response (an anchor/same-document navigation, per Playwright -- unexpected for a full page load)'
    return `returned ${String(response.status())}`
  }

  let first = null
  let firstError = null
  try {
    first = await page.goto(url, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  } catch (cause) {
    firstError = cause
  }
  if (first !== null && first.status() < 500) return first

  await delay(50)
  if (!raced()) {
    await fail(`gotoReliably: ${url} ${describe(first, firstError)} without the dev-server manifest-race signature`)
  }
  console.log(`gotoReliably: ${url} ${describe(first, firstError)}, signature matched -- retrying once`)
  gotoRetries.push(url)
  await delay(300)

  let second = null
  let secondError = null
  try {
    second = await page.goto(url, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  } catch (cause) {
    secondError = cause
  }
  if (secondError !== null || second === null || second.status() >= 500) {
    await fail(`gotoReliably: ${url} ${describe(second, secondError)} on the retry too`)
  }
  return second
}

/** Runs a child to completion with its output streamed AND captured, and returns its exit status.
 *  Foreground and synchronous-by-await on purpose: every check that uses this is a pass/fail on the
 *  child's own exit code, and a gate that backgrounds one of these has to invent a way to wait for
 *  it that the exit code already is. */
async function runChild(label, command, args, options = {}) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      output += `\n<${label} exceeded ${String(options.timeoutMs ?? 0)}ms -- killed>\n`
      child.kill('SIGKILL')
    }, options.timeoutMs ?? TYPECHECK_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
      if (options.quiet !== true) process.stdout.write(`[${label}] ${chunk}`)
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString()
      if (options.quiet !== true) process.stderr.write(`[${label}] ${chunk}`)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, signal: null, output: `${output}\n<${label} failed to start: ${String(error)}>` })
    })
    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, signal, output })
    })
  })
}

/** The spec's spend-ledger table, parsed rather than eyeballed: the block of `|`-delimited rows
 *  immediately under the `## Spend ledger` heading, minus its header and separator rows. Returns
 *  `{ run, actual }` per row. The "Actual" column is located BY HEADER NAME, not by position: the
 *  table's column order is the spec's to change, and a positional read would silently start
 *  measuring the wrong column the day someone inserts one. */
function parseSpendLedger(markdown) {
  const lines = markdown.split('\n')
  const headingIndex = lines.findIndex((line) => /^##\s+Spend ledger\s*$/.test(line))
  if (headingIndex === -1) return { error: 'the spec has no `## Spend ledger` heading' }
  const rows = []
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line === '') {
      if (rows.length === 0) continue
      break
    }
    if (!line.startsWith('|')) break
    rows.push(line)
  }
  if (rows.length < 3) {
    return { error: `the spend-ledger table under \`## Spend ledger\` has ${String(rows.length)} row(s); expected a header, a separator and at least one run` }
  }
  const cellsOf = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
  const header = cellsOf(rows[0]).map((cell) => cell.toLowerCase())
  const actualIndex = header.indexOf('actual')
  if (actualIndex === -1) return { error: `the spend-ledger header ${JSON.stringify(header)} has no "Actual" column` }
  if (!/^[\s|:-]+$/.test(rows[1])) return { error: `expected a markdown separator row under the spend-ledger header, found ${JSON.stringify(rows[1])}` }
  const entries = []
  for (const row of rows.slice(2)) {
    const cells = cellsOf(row)
    entries.push({ run: cells[0] ?? '<unnamed>', actual: cells[actualIndex] ?? '' })
  }
  return { entries }
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'aiteamos-gate-m19-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ---- Preflight ------------------------------------------------------------------------------
  //
  // No `AITEAMOS_CLAUDE_BIN` precondition here, and that is deliberate -- see the file header. This
  // gate spawns no vendor CLI and no daemon, so there is nothing for that check to guard; requiring
  // it would be theatre, and theatre in a gate teaches an operator to set variables without knowing
  // why.

  const envPath = join(repoRoot, '.env')
  if (!existsSync(envPath)) {
    throw new Error(
      `no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m19-measure-and-harden passes --env-file=.env). Create it before running this gate.`,
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m19-measure-and-harden`')
  }
  if ((process.env['TEST_DATABASE_URL'] ?? '') === '') {
    throw new Error(
      'TEST_DATABASE_URL is not set -- check 4 runs the C5 equivalence suite, which refuses to run without it (`test-setup/require-database.ts`)',
    )
  }
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(`no Chromium binary at ${chromiumPath} -- set CHROMIUM_PATH to a real executable`)
  }
  for (const [label, path] of [
    ['the M19 spec', SPEC_PATH],
    ['the matrix-deny fixture', FIXTURE_PATH],
    ["the fixture directory's README", FIXTURE_README_PATH],
    ["A1's capture script", CAPTURE_SCRIPT],
    ["apps/web's test tsconfig", WEB_TEST_TSCONFIG],
    ['the TypeScript compiler', TSC_BIN],
    ['the vitest runner', VITEST_BIN],
    ['the C5 equivalence suite', join(repoRoot, EQUIVALENCE_TEST)],
  ]) {
    if (!existsSync(path)) throw new Error(`no ${label} at ${path}`)
  }
  try {
    await prisma.$queryRaw`select 1`
  } catch (cause) {
    throw new Error(
      `the database at DATABASE_URL is not reachable (${cause instanceof Error ? cause.message : String(cause)}) -- ` +
        'start Postgres before running this gate.',
    )
  }

  // Refuses under a genuinely running orchestrator daemon. This gate starts none of its own, but a
  // live one on the host would be a second writer against the dev database while the browser stage
  // reads a seeded skill graph out of it -- and, more sharply, a daemon holding LISTEN connections
  // is the known way to redden the integration suite check 4 runs.
  const daemonCandidates = spawnSync('pgrep', ['-f', 'cli.js daemon'], { encoding: 'utf8' })
  const candidatePids = (daemonCandidates.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => Number(line))
  const realDaemonPids = candidatePids.filter((pid) => isRealDaemonProcess(pid))
  if (realDaemonPids.length > 0) {
    throw new Error(`gate:m19-measure-and-harden REFUSED -- an orchestrator daemon is already running (pid ${realDaemonPids.join(', ')})`)
  }

  console.log(`chromium:    ${chromiumPath}`)
  console.log('vendor CLI:  none -- this gate spends nothing by construction (see the file header)')

  // ============================================================================================
  // Check 5: the C1 partial index reached the dev database.
  // ============================================================================================
  // Named-index probe rather than a shape probe on purpose: the index landed as
  // `(workspaceId, type, runId, seq)` partial on the payload path, and its COLUMNS are free to keep
  // moving as the query does. What must not change silently is that the migration ran at all.
  const indexRows = await prisma.$queryRaw`
    SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${SKILL_INDEX_NAME}`
  if (indexRows.length !== 1) {
    throw new Error(
      `gate:m19-measure-and-harden REFUSED -- the dev database at DATABASE_URL has no "${SKILL_INDEX_NAME}" index, so the ` +
        'M19 C1 migration (`20260901120000_m19_skill_calls_partial_index`) has not reached it. Run `npm run db:migrate` ' +
        "(Prisma reads DATABASE_URL from .env through packages/db/prisma.config.ts's own dotenv/config) and re-run this gate.",
    )
  }
  console.log(`CHECK 5 PASSED: ${SKILL_INDEX_NAME} exists -- ${indexRows[0].indexdef}`)

  // ============================================================================================
  // Check 6: the spend ledger is filled in, and adds up to less than the milestone's cap.
  // ============================================================================================
  const specMarkdown = readFileSync(SPEC_PATH, 'utf8')
  const ledger = parseSpendLedger(specMarkdown)
  if (ledger.error !== undefined) throw new Error(`check 6: ${ledger.error}`)
  let totalSpend = 0
  const ledgerReport = []
  for (const entry of ledger.entries) {
    if (/recorded at run ?time/i.test(entry.actual)) {
      throw new Error(
        `check 6: the spend ledger row "${entry.run}" still holds the planning placeholder in its Actual cell ` +
          `(${JSON.stringify(entry.actual)}) -- a milestone about measurement does not ship with an unmeasured row.`,
      )
    }
    const match = /\$\s*([0-9]+(?:\.[0-9]+)?)/.exec(entry.actual)
    if (match === null) {
      throw new Error(`check 6: the spend ledger row "${entry.run}" has no $-figure in its Actual cell (${JSON.stringify(entry.actual)})`)
    }
    const amount = Number(match[1])
    totalSpend += amount
    ledgerReport.push(`${entry.run} = $${match[1]}`)
  }
  if (totalSpend > SPEND_CAP_USD) {
    throw new Error(
      `check 6: the spend ledger's actuals sum to $${totalSpend.toFixed(7)}, over the milestone's $${SPEND_CAP_USD.toFixed(2)} cap`,
    )
  }
  console.log(
    `CHECK 6 PASSED: ${String(ledger.entries.length)} ledger row(s), all measured -- ${ledgerReport.join('; ')} ` +
      `-- total $${totalSpend.toFixed(7)} <= $${SPEND_CAP_USD.toFixed(2)}`,
  )

  // ============================================================================================
  // Check 2: the A1 capture, and the provenance that makes it a recording rather than a story.
  // ============================================================================================
  const fixtureLines = readFileSync(FIXTURE_PATH, 'utf8').split('\n')
  const parsedLines = []
  for (let i = 0; i < fixtureLines.length; i += 1) {
    const line = fixtureLines[i]
    if (line.trim() === '') continue
    try {
      parsedLines.push(JSON.parse(line))
    } catch (cause) {
      throw new Error(
        `check 2: ${FIXTURE_PATH} line ${String(i + 1)} is not JSON (${cause instanceof Error ? cause.message : String(cause)})`,
      )
    }
  }
  const resultLines = parsedLines.filter((entry) => entry?.type === 'result')
  if (resultLines.length !== 1) {
    throw new Error(`check 2: the fixture carries ${String(resultLines.length)} terminal \`result\` line(s), expected exactly 1`)
  }
  const denials = resultLines[0].permission_denials
  if (!Array.isArray(denials) || denials.length === 0) {
    throw new Error(
      `check 2: the fixture's terminal result line carries permission_denials ${JSON.stringify(denials)} -- a matrix-deny capture whose result forgets the denial is not the capture this milestone made`,
    )
  }
  const firstDenial = denials[0]
  if (firstDenial?.tool_name !== 'Bash' || typeof firstDenial?.tool_use_id !== 'string' || firstDenial.tool_use_id === '') {
    throw new Error(`check 2: the fixture's first permission_denials entry is ${JSON.stringify(firstDenial)}, expected a Bash denial carrying a tool_use_id`)
  }
  console.log(
    `check 2: ${String(parsedLines.length)} fixture lines all parse; the terminal result carries ` +
      `${String(denials.length)} permission_denial(s), the first ${firstDenial.tool_name} ${firstDenial.tool_use_id}`,
  )

  const readme = readFileSync(FIXTURE_README_PATH, 'utf8')
  const readmeLines = readme.split('\n')

  // The replay-mode table's own row for this fixture -- the one line in this README that states what
  // the committed file IS. Historical past-tense prose about the file it REPLACED is not only
  // allowed but wanted (the exception and why it existed is part of the record), so this asserts on
  // the row rather than grepping the whole file for the word.
  const tableRow = readmeLines.find((line) => line.startsWith('| `permission-matrix-deny.ndjson`'))
  if (tableRow === undefined) {
    throw new Error("check 2: the fixture README's replay-mode table has no row for `permission-matrix-deny.ndjson`")
  }
  if (/hand-authored/i.test(tableRow)) {
    throw new Error(`check 2: the replay-mode table still describes the committed fixture as hand-authored:\n  ${tableRow}`)
  }
  if (!/re-recorded from the real CLI/i.test(tableRow)) {
    throw new Error(`check 2: the replay-mode table row does not say the fixture was re-recorded from the real CLI:\n  ${tableRow}`)
  }

  // The fixture's own provenance section: from its `## `-heading to the next `## `-heading.
  const sectionStart = readmeLines.findIndex((line) => line.startsWith('## `permission-matrix-deny.ndjson`'))
  if (sectionStart === -1) {
    throw new Error('check 2: the fixture README has no `## `permission-matrix-deny.ndjson`` provenance section')
  }
  let sectionEnd = readmeLines.length
  for (let i = sectionStart + 1; i < readmeLines.length; i += 1) {
    if (readmeLines[i].startsWith('## ')) {
      sectionEnd = i
      break
    }
  }
  const section = readmeLines.slice(sectionStart, sectionEnd).join('\n')
  for (const [what, pattern] of [
    ['the CLI version it was recorded from', /\b2\.1\.252\b/],
    ['the capture date', /\b2026-09-01\b/],
    ['the cost, as a $-figure', /\$0\.0741884\b/],
    ['the field the cost came from', /total_cost_usd/],
    ['the runnable capture command', /node --env-file=\.env scripts\/capture-matrix-deny\.mjs/],
  ]) {
    if (!pattern.test(section)) {
      throw new Error(`check 2: the fixture's README provenance section does not carry ${what} (${String(pattern)})`)
    }
  }

  // A1's finding 5 added a FIFTH standing redaction rule (the `init` line's environment catalog).
  // It binds every future capture, so it has to survive as a numbered rule, not as prose.
  const rulesStart = readmeLines.findIndex((line) => line.startsWith('## Redaction rules for anything added here'))
  if (rulesStart === -1) {
    throw new Error('check 2: the fixture README has no `## Redaction rules for anything added here` section')
  }
  const ruleNumbers = readmeLines
    .slice(rulesStart)
    .map((line) => /^(\d+)\. /.exec(line))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]))
  if (ruleNumbers.join(',') !== '1,2,3,4,5') {
    throw new Error(
      `check 2: the README's standing redaction rules are numbered ${JSON.stringify(ruleNumbers)}, expected 1..5 -- ` +
        "A1's finding 5 (the `init` line's environment catalog) added the fifth and it binds every future capture",
    )
  }
  console.log(`CHECK 2 PASSED: the capture parses and denies, its provenance section names version/date/cost/command, and five redaction rules stand`)

  // ============================================================================================
  // Check 1: the typecheck step, and a probe proving the step bites.
  // ============================================================================================
  console.log('check 1: running `npm run --silent typecheck` ...')
  const typecheck = await runChild('typecheck', 'npm', ['run', '--silent', 'typecheck'], { timeoutMs: TYPECHECK_TIMEOUT_MS })
  if (typecheck.code !== 0) {
    throw new Error(
      `check 1: \`npm run --silent typecheck\` exited ${String(typecheck.code)} (signal ${String(typecheck.signal)}) -- the tree does not typecheck:\n${typecheck.output.slice(-8_000)}`,
    )
  }
  console.log('check 1: `npm run --silent typecheck` exited 0')

  // The bite proof. The planted red NEVER touches the working tree -- it is two files in this gate's
  // own temp directory, under a tsconfig that EXTENDS `apps/web/tsconfig.test.json` (so the same
  // `strict`/`noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` options the real step runs
  // under apply) and overrides only `include`. Both halves are asserted: the green file proves the
  // scratch harness itself compiles, so the red file's nonzero exit is the planted error and not a
  // broken probe.
  const probeDir = join(diagDir, 'typecheck-probe')
  mkdirSync(probeDir, { recursive: true })
  writeFileSync(join(probeDir, 'green.ts'), 'export const green: string = "the harness itself compiles"\n')
  writeFileSync(join(probeDir, 'broken.ts'), 'export const broken: string = 42\n')
  for (const [name, include] of [['green', 'green.ts'], ['broken', 'broken.ts']]) {
    writeFileSync(
      join(probeDir, `tsconfig.${name}.json`),
      `${JSON.stringify({ extends: WEB_TEST_TSCONFIG, include: [include] }, null, 2)}\n`,
    )
  }
  const probeGreen = await runChild('probe:green', 'node', [TSC_BIN, '-p', join(probeDir, 'tsconfig.green.json'), '--noEmit'], {
    timeoutMs: TYPECHECK_TIMEOUT_MS,
    quiet: true,
  })
  if (probeGreen.code !== 0) {
    throw new Error(
      `check 1: the typecheck bite probe's CONTROL file did not compile (exit ${String(probeGreen.code)}) -- the probe harness is broken, so its red result would prove nothing:\n${probeGreen.output.slice(-4_000)}`,
    )
  }
  const probeBroken = await runChild('probe:broken', 'node', [TSC_BIN, '-p', join(probeDir, 'tsconfig.broken.json'), '--noEmit'], {
    timeoutMs: TYPECHECK_TIMEOUT_MS,
    quiet: true,
  })
  if (probeBroken.code === 0) {
    throw new Error(
      'check 1: the typecheck bite probe compiled a file that assigns 42 to a `string` -- the command form does not catch reds, so the typecheck step is decorative',
    )
  }
  if (!/error TS2322/.test(probeBroken.output)) {
    throw new Error(
      `check 1: the typecheck bite probe exited ${String(probeBroken.code)} but not with the planted TS2322 -- it failed for some other reason:\n${probeBroken.output.slice(-4_000)}`,
    )
  }
  console.log(
    `CHECK 1 PASSED: \`npm run --silent typecheck\` exits 0, and the same command form exits ${String(probeBroken.code)} on a planted TS2322 ` +
      '(control file exits 0) -- the step bites, and the red never touched the working tree',
  )

  // ============================================================================================
  // Check 4: the C5 equivalence suite, as a child process.
  // ============================================================================================
  // Deliberately placed BEFORE anything long-lived starts: this gate holds no daemon (it starts
  // none) and `next dev` is not up yet, so the integration project gets the shared TEST database
  // to itself, which is the one condition its TRUNCATE/seed hooks require.
  console.log(`check 4: running \`vitest run ${EQUIVALENCE_TEST}\` ...`)
  const equivalence = await runChild('vitest', 'node', [VITEST_BIN, 'run', EQUIVALENCE_TEST], { timeoutMs: VITEST_TIMEOUT_MS })
  if (equivalence.code !== 0) {
    throw new Error(
      `check 4: the C5 equivalence suite exited ${String(equivalence.code)} (signal ${String(equivalence.signal)}):\n${equivalence.output.slice(-8_000)}`,
    )
  }
  console.log(`CHECK 4 PASSED: ${EQUIVALENCE_TEST} is present and green`)

  await preflightCleanup()

  // ============================================================================================
  // Check 3: cable thickness responds to succession count, read off the live DOM.
  // ============================================================================================
  repoPath = makeRepo('repo')
  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath,
      autoMerge: false,
      verifyCommands: ['true'],
      setupCommands: [],
      goal: 'prove a cable measures its own traffic',
    },
  })
  workspaceId = workspace.id
  const teamId = (await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })).id
  const agentId = (
    await prisma.agent.create({
      data: { teamId, name: WORKER_NAME, role: 'backend', provider: WORKER_PROVIDER, model: WORKER_MODEL },
    })
  ).id
  console.log(`workspace ${workspaceId}; team ${teamId}; agent ${agentId}`)

  // Seeded through the real production write path (`appendEvent`), so `seq`/`ts` come from the
  // database in the same order a real run would have written them -- the aggregate builder's edge
  // counts are derived from that order and from nothing else.
  async function skillCall(runId, name) {
    await appendEvent({
      type: 'run.tool_call',
      workspaceId,
      agentId,
      runId,
      actor: 'agent',
      payload: { name: 'Skill', summary: `Skill ${name}` },
    })
  }
  for (let i = 0; i < 3; i += 1) {
    const run = await prisma.agentRun.create({ data: { agentId, status: 'succeeded' } })
    await skillCall(run.id, HEAVY_FROM)
    await skillCall(run.id, HEAVY_TO)
  }
  const lightRun = await prisma.agentRun.create({ data: { agentId, status: 'succeeded' } })
  await skillCall(lightRun.id, LIGHT_FROM)
  await skillCall(lightRun.id, LIGHT_TO)
  console.log(`check 3: seeded three runs of ${HEAVY_FROM}->${HEAVY_TO} (succession count 3) and one of ${LIGHT_FROM}->${LIGHT_TO} (count 1)`)

  const preferredPort = await findFreePort()
  nextServer = spawn('node', ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort)], {
    cwd: repoRoot,
    // M21 A1: the operator's AITEAMOS_PASSWORD must not reach the child, or every page is /login.
    env: loopbackChildEnv({ AITEAMOS_GATE_WARM: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let nextExited = false
  let resolvedPort = null
  nextServer.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    nextOutput += text
    process.stdout.write(`[next] ${text}`)
    const match = /http:\/\/localhost:(\d+)/.exec(nextOutput)
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
  const baseUrl = `http://localhost:${String(resolvedPort)}`
  console.log(`next dev ready at ${baseUrl}`)

  // Warm every route once, synchronously, before the browser exists -- `gate-m14-fidelity.mjs`'s
  // fix for `next dev`'s manifest-race 500s (M17 Task 7, Flake 6), cribbed verbatim.
  console.log('warming every route before the browser arrives (closes the dev-server manifest race)...')
  const WARMUP_APP_DIR = join(repoRoot, 'apps/web/src/app')
  const DUMMY_ID = '00000000-0000-4000-8000-000000000000'
  const warmupRouteFiles = []
  ;(function walkAppDir(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walkAppDir(join(dir, entry.name))
      else if (entry.name === 'route.ts' || entry.name === 'page.tsx') warmupRouteFiles.push(join(dir, entry.name))
    }
  })(WARMUP_APP_DIR)
  for (const file of warmupRouteFiles.sort()) {
    const routeDir = file.slice(WARMUP_APP_DIR.length).replace(/\/(route\.ts|page\.tsx)$/, '')
    const urlPath = routeDir === ''
      ? '/'
      : routeDir
          .split('/')
          .map((segment) => (segment === '[workspaceId]' ? workspaceId : segment.startsWith('[') ? DUMMY_ID : segment))
          .join('/')
    const response = await fetch(`${baseUrl}${urlPath}`).catch((cause) => {
      throw new Error(`warm-up request for ${urlPath} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
    await response.body?.cancel().catch(() => {})
    console.log(`warm-up: ${urlPath} -> ${String(response.status)}`)
  }
  console.log(`warm-up done: ${String(warmupRouteFiles.length)} route(s) compiled`)

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
    pushBrowserConsole(`[pageerror] ${String(error)}`)
  })
  page.on('console', (message) => {
    pushBrowserConsole(`[${message.type()}] ${message.text()}`)
  })
  page.on('requestfailed', (request) => {
    pushBrowserConsole(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`)
  })

  await gotoReliably(`${baseUrl}/w/${workspaceId}/graph?mode=skill`)
  await waitVisible(page.getByTestId('graph-canvas'), 'the graph canvas in skill mode')
  await waitUntil('the four seeded aggregate skill nodes to render', ACTION_TIMEOUT_MS, async () => {
    const count = await page.getByTestId('skill-node').count()
    return count === 4 ? { done: true, value: count } : { done: false, detail: `${String(count)} skill-node(s) rendered` }
  })

  // Read the two cables' CORE path off the live DOM. `getComputedStyle` rather than the attribute on
  // purpose: `CableEdge` writes the width as BOTH a presentation attribute and an inline style
  // (React Flow's own stylesheet outranks the attribute), and what a reader actually sees is the
  // computed value -- an assertion on the attribute alone would pass on a cable rendering at React
  // Flow's grey 1px hairline.
  const widths = await waitUntil('both seeded cables to render their core path', ACTION_TIMEOUT_MS, async () => {
    const measured = await page.evaluate(
      ([heavyId, lightId]) => {
        const read = (edgeId) => {
          const group = [...document.querySelectorAll('[data-testid="cable-edge"]')].find(
            (node) => node.getAttribute('data-edge-id') === edgeId,
          )
          if (group === undefined) return { found: false }
          const core = group.querySelector('path.react-flow__edge-path')
          if (core === null) return { found: false }
          return {
            found: true,
            computed: window.getComputedStyle(core).strokeWidth,
            attribute: core.getAttribute('stroke-width'),
          }
        }
        return { heavy: read(heavyId), light: read(lightId) }
      },
      [HEAVY_EDGE_ID, LIGHT_EDGE_ID],
    )
    if (measured.heavy.found !== true || measured.light.found !== true) {
      return { done: false, detail: `heavy=${JSON.stringify(measured.heavy)} light=${JSON.stringify(measured.light)}` }
    }
    return { done: true, value: measured }
  })
  const heavyWidth = Number.parseFloat(widths.heavy.computed)
  const lightWidth = Number.parseFloat(widths.light.computed)
  if (!Number.isFinite(heavyWidth) || !Number.isFinite(lightWidth)) {
    await fail(`check 3: could not read a numeric stroke-width -- heavy ${JSON.stringify(widths.heavy)}, light ${JSON.stringify(widths.light)}`)
  }
  if (!(heavyWidth > lightWidth)) {
    await fail(
      `check 3: the count-3 cable renders at ${String(heavyWidth)}px and the count-1 cable at ${String(lightWidth)}px -- ` +
        'thickness does not respond to traffic (C3 is inert)',
    )
  }
  if (Math.abs(lightWidth - INACTIVE_BASE_WIDTH) > 0.01) {
    await fail(
      `check 3: the count-1 cable renders at ${String(lightWidth)}px, expected the inactive flat literal ${String(INACTIVE_BASE_WIDTH)}px -- ` +
        'a single succession must look exactly like the weightless cable it used to be',
    )
  }
  if (heavyWidth < INACTIVE_BASE_WIDTH + 0.5) {
    await fail(
      `check 3: the count-3 cable renders at ${String(heavyWidth)}px, less than half a pixel above the ${String(INACTIVE_BASE_WIDTH)}px baseline -- ` +
        'the difference is there but too small to be seen',
    )
  }
  console.log(
    `CHECK 3 PASSED: the count-3 cable ${HEAVY_EDGE_ID} computes to ${String(heavyWidth)}px (attribute ${String(widths.heavy.attribute)}) ` +
      `and the count-1 cable ${LIGHT_EDGE_ID} to ${String(lightWidth)}px (attribute ${String(widths.light.attribute)})`,
  )

  console.log(
    gotoRetries.length === 0
      ? 'gotoReliably: no retries this run'
      : `gotoReliably retried ${String(gotoRetries.length)} time(s): ${JSON.stringify(gotoRetries)}`,
  )
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
  // FK-ordered: `ExecutionEvent` has no FK to `Workspace`, so it is deleted explicitly first; the
  // workspace delete then cascades Team/Agent/AgentRun.
  if (workspaceId !== null) {
    await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
