// M55's own gate (spec section 3): "three hundred files in one command, inert until somebody says
// otherwise, with every pair it noticed named beside the row it is about".
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m55-catalog
//
// NEVER A MODEL CALL, AND ZERO SPEND. Every run is the fake CLI. Nothing in this milestone asks a
// model anything: the three duplicate classes are three thresholds over set arithmetic, and the
// catalog it imports is written by `scripts/gate-fakes/gen-catalog.mjs` from a fixed word list and a
// fixed seed.
//
// THE GATE ASSERTS, IT NEVER FIXES, and every stage prints every measured value before asserting it.
//
// THE CATALOG IS GENERATED, NOT CHECKED IN (spec section 3). 120 personas is deliberately more than
// any fixture in this tree and deliberately far less than a real catalog: enough for two full pages
// at `CATALOG_PAGE_SIZE = 100` and for the import's batching to report twice, small enough that a
// failing stage prints a diagnosable dump. The directory is a `mkdtemp` this gate chose, so no
// checked-in string names a real catalog (M42 erratum E5).
//
// THREE CATALOGS, THREE SEEDS, AND THE ORDER THEY ARE IMPORTED IN IS AN ASSERTION (Task 6 ruling
// R4). The licensed one is the subject of every stage; a second is written with its LICENSE removed
// for stage 11's refusal; a third is imported with `--activate` for stage 4. The second and third
// are imported LAST, after stage 10, because two catalogs built from the same construction hold a
// hundred and twenty pairs of personas with identical capability sets -- a real `overlapping` signal
// every time, correctly detected, and three hundred rows of noise across the stages that count
// pairs. Stages 5 to 10 therefore measure a database holding exactly one generated catalog, which is
// what lets stage 5 say "exactly nine" about the whole table rather than about a subset of it.
//
// IT NEVER EDITS A FILE IN THIS REPOSITORY. The generated catalogs, the temporary repositories and
// the state directory are all under `/tmp` and are removed in the `finally`; `git status
// --porcelain` after a green run is what it was before, and the rows it created are removed by
// `sourceId` prefix and by name prefix.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: it boots `next dev` against the
// repo's own `apps/web/.next` on a freshly chosen free port, and a second `next dev` sharing that
// directory corrupts the on-disk build cache for both. Stop any running dev server first
// (`pgrep -af "next dev"`).
//
// Scaffolding borrowed function for function from `gate-m53-evidence.mjs` (`findFreePort`,
// `makeRepo`, `preflightCleanup` by name prefix, `assert`/`assertEqual`, `waitUntil`, `fail` with a
// `dumpGateRows`, the real `next dev` on a free port under `loopbackChildEnv`, the real Chromium
// through `playwright-core` at `CHROMIUM_PATH`, `gotoReliably`/`waitVisible`, `exitCode` starting at
// 1, teardown in FK order in a `finally`) and from `gate-m42-catalog-import.mjs` (the catalog
// directory whose BASENAME is the catalog's name, and the `sourceId`-prefixed teardown).

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids } from './lib/daemon-process.mjs'
import { gateStateDir } from './lib/state-dir.mjs'
import { prisma } from '../packages/db/dist/client.js'
import { loadSupervisorWorld, refusalText } from '../packages/control/dist/index.js'
import {
  ACTION_KINDS,
  CAPABILITY_OVERLAP_JACCARD,
  DUPLICATE_BASIS_LABEL,
  DUPLICATE_CLASSES,
  DUPLICATE_CLASS_LABEL,
  DUPLICATE_FACETS,
  DUPLICATE_FACET_LABEL,
  LANE_BY_TYPE,
  NEAR_DUPLICATE_JACCARD,
  SITUATION_KINDS,
  canonicalPersonaText,
  jaccard,
  normalisePersona,
  profileKeyOf,
  shinglesOf,
} from '../packages/domain/dist/index.js'

const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 100
const DAEMON_PERIOD_MS = 500
const SUPERVISOR_TIMEOUT_MS = 120_000
/** `gate-m14-fidelity.mjs`'s own signature for next dev's torn `loadManifest` read. */
const MANIFEST_RACE_SIGNATURE = 'Unexpected end of JSON input'
/** The search box pushes up after `CATALOG_SEARCH_DEBOUNCE_MS` (250 ms, Task 5). Every browser
 *  assertion that follows a `fill()` polls; none asserts on the very next frame. */
const SEARCH_DEBOUNCE_MS = 250
/** `gate-m45-project-experience.mjs`'s first viewport. */
const VIEWPORT = { width: 1440, height: 900 }

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const GEN_CATALOG = join(repoRoot, 'scripts/gate-fakes/gen-catalog.mjs')
const NEXT_STATIC = join(repoRoot, 'apps/web/.next/static')
const PASS_LINE =
  'a hundred and twenty strangers arrived in one command, not one of them hirable, and every pair named beside its row'

// Exact literals, never suffixed: the catalog's NAME is the generated directory's own basename
// (`--catalog` defaults to `basename(dir)`, M42 erratum E5), and every `sourceId` this gate asserts
// on is built from it. `preflightCleanup` removes whatever a prior crashed run left on these exact
// names, in the same FK order the `finally` block uses.
const CATALOG_NAME = 'catalog-m55'
const ACTIVE_CATALOG_NAME = 'catalog-m55-active'
const UNLICENSED_CATALOG_NAME = 'catalog-m55-unlicensed'
const CATALOG_NAMES = [CATALOG_NAME, ACTIVE_CATALOG_NAME, UNLICENSED_CATALOG_NAME]
/** One seed per catalog, so three sets of persona NAMES that cannot collide on
 *  `SlaveTemplate.name @unique` -- the generator writes the seed into every name it composes. */
const SEED = '20260914'
const UNLICENSED_SEED = '20260915'
const ACTIVE_SEED = '20260916'
/** `gen-catalog.mjs`'s own prefix. Every generated persona's name starts with it, which is the
 *  second address the teardown removes rows by -- and it is this milestone's own, so no cleanup
 *  here can ever reach `gate:m42`'s `Gate Core Builder` or `gate:m46`'s four. */
const NAME_PREFIX = 'M55 Gate'

const STAMP = new Date().toISOString().slice(11, 19)
const WORKSPACE_PREFIX = 'M55 Gate Project'
const TASK_TITLE = 'M55 Gate Staffing Task'

/** Asks the OS for a free TCP port (`gate-m53-evidence.mjs`, verbatim). */
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

/** A throwaway git repository for one project to hold its worktrees in (`gate-m53-evidence.mjs`). */
function makeRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `slaveofai-gate-m55-${label}-`))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  git(['config', 'core.hooksPath', ''])
  writeFileSync(join(dir, 'README.md'), `# ${label} fixture\n`)
  git(['add', '-A'])
  git(['commit', '-q', '--no-verify', '-m', 'initial'])
  return dir
}

/** Every file under `dir`, hashed with its own relative path, in one sorted walk. The determinism
 *  proof in stage 0 is this number twice. */
function treeHash(dir) {
  const hash = createHash('sha256')
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`)
      else {
        hash.update(`${prefix}${entry.name}\n`)
        hash.update(readFileSync(full))
      }
    }
  }
  walk(dir, '')
  return hash.digest('hex')
}

/** Teardown for one project, in FK order (`gate-m53-evidence.mjs`). */
async function removeWorkspace(id) {
  await prisma.executionEvent.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.supervisorDecision.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.slaveMessage.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.evidenceRecord.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.staffingPreference.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.memory.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.brokerBinding.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.credential.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.providerConfiguration.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.taskDependency.deleteMany({ where: { task: { workspaceId: id } } }).catch(() => {})
  await prisma.goalVersion.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.task.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.slave.deleteMany({ where: { team: { workspaceId: id } } }).catch(() => {})
  await prisma.team.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.workspace.delete({ where: { id } }).catch(() => {})
}

/**
 * Every template this gate can have created, addressed TWO ways.
 *
 * By `sourceId` prefix, which only these three catalogs write, and by NAME prefix, which is what
 * reaches a row whose catalog name came out different from what this file expected -- including the
 * one persona whose name is deliberately lower-cased and double-spaced, which is why the name match
 * is case-insensitive. A `CompanySlave` holds a non-cascading reference, so the roster links go
 * first; `TemplateDuplicate` needs no statement at all, because it cascades (plan erratum E4).
 */
async function deleteGateTemplates(label) {
  const rows = await prisma.slaveTemplate.findMany({
    where: {
      OR: [
        ...CATALOG_NAMES.map((name) => ({ sourceId: { startsWith: `${name}/` } })),
        { name: { startsWith: NAME_PREFIX, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  })
  if (rows.length === 0) return
  console.log(`${label}: removing ${String(rows.length)} gate template(s)`)
  const ids = rows.map((row) => row.id)
  await prisma.companySlave.deleteMany({ where: { templateId: { in: ids } } }).catch(() => {})
  await prisma.slaveTemplate.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
}

/** Removes anything a prior interrupted run left behind, by NAME PREFIX and by `sourceId` prefix. */
async function preflightCleanup() {
  const stale = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true },
  })
  for (const workspace of stale) {
    console.log(`preflight: removing leftover workspace ${workspace.id} (${workspace.name})`)
    await removeWorkspace(workspace.id)
  }
  await deleteGateTemplates('preflight')
  const staleImports = await prisma.catalogImport.deleteMany({ where: { catalog: { in: CATALOG_NAMES } } })
  if (staleImports.count > 0) console.log(`preflight: removing ${String(staleImports.count)} leftover CatalogImport row(s)`)
}

// M54's own stage-14 literals, re-asserted here: this milestone claims to have moved none of them.
const TASK_COLUMNS = [
  'activeRunId', 'assigneeId', 'attempt', 'branch', 'createdAt', 'createdBy', 'createdByUserId',
  'description', 'enqueuedAt', 'goalVersion', 'handoff', 'id', 'integratedAt', 'lastRejectionReason',
  'maxAttempts', 'mergeClaimedAt', 'priority', 'requiredCapabilities', 'requiredRole', 'stage',
  'status', 'title', 'workspaceId',
]
const WORKSPACE_COLUMNS = [
  'adoptedFromSimulationId', 'archivedAt', 'autoMerge', 'baseBranch', 'budgetUsd', 'companyId',
  'consecutiveFailureLimit', 'createdAt', 'goal', 'goalSetByUserId', 'goalVersion', 'haltedAt',
  'haltedReason', 'id', 'maxAttempts', 'maxConcurrentRuns', 'maxToolCallsPerRun', 'name', 'repoPath',
  'runTimeoutMs', 'runbookId', 'setupCommands', 'supervisorEnabled', 'supervisorProfile',
  'verifyCommands',
]
const ACTOR_MEMBERS = ['human', 'slave', 'system']
const SUPERVISOR_WORLD_KEYS = [
  'budgetExhausted', 'catalog', 'company', 'decisions', 'denials', 'evidence', 'goal', 'goalVersion',
  'halted', 'now', 'questions', 'runbook', 'runbooks', 'runs', 'slaves', 'staffingPreferences',
  'staleMemoryCandidates', 'tasks', 'taxonomy', 'workspaceId',
]
/**
 * The nine strings no surface this milestone drew may print AS ITS WHOLE VISIBLE TEXT (stage 10).
 *
 * Whole text, not substring, and that is the domain's own rule: `DUPLICATE_FACET_LABEL.near` IS
 * `near duplicates` and `DUPLICATE_FACET_LABEL.overlapping` IS `overlapping capabilities`, both
 * shipped and both containing a member. What `packages/domain/src/catalog/duplicate.ts` forbids is
 * "a label identical to its member", which is exactly what the imports panel's tenth header was
 * before Task 5's fix round -- `Overlapping`, the member with one capital letter.
 */
const RAW_TOKENS = ['exact', 'near', 'overlapping', 'content_hash', 'name', 'body_shingles', 'capability_keys', 'true', 'false']

let exitCode = 1
let nextServer = null
let nextOutput = ''
let browser = null
let page = null
let diagDir = null
let catalogRoot = null
const repoPaths = []
const workspaceIds = []
const daemons = []
const browserConsole = []
const gotoRetries = []

/** The templates one generated catalog owns, by `sourceId` -- never by name, which is exactly the
 *  thing a planted pair changes on purpose. */
const catalogTemplates = (catalog) =>
  prisma.slaveTemplate.findMany({ where: { sourceId: { startsWith: `${catalog}/` } }, orderBy: { sourceId: 'asc' } })

/** Every pair BOTH of whose ends are under one catalog, newest first, with both rows' identity. */
const catalogPairs = (catalog) =>
  prisma.templateDuplicate.findMany({
    where: { a: { sourceId: { startsWith: `${catalog}/` } }, b: { sourceId: { startsWith: `${catalog}/` } } },
    include: {
      a: { select: { id: true, name: true, sourceId: true, profileSpec: true, capabilityKeys: true } },
      b: { select: { id: true, name: true, sourceId: true, profileSpec: true, capabilityKeys: true } },
    },
    orderBy: [{ class: 'asc' }, { id: 'asc' }],
  })

/** The whole pair table as one comparable string -- what stage 6's two recomputes are measured by. */
const pairTableSnapshot = async () =>
  JSON.stringify(
    (await prisma.templateDuplicate.findMany({ orderBy: { id: 'asc' } })).map((row) => ({
      id: row.id,
      aId: row.aId,
      bId: row.bId,
      class: row.class,
      basis: row.basis,
      score: row.score,
      detectedAt: row.detectedAt.toISOString(),
      dismissedAt: row.dismissedAt === null ? null : row.dismissedAt.toISOString(),
      dismissedBy: row.dismissedBy,
    })),
  )

/** Every column an import is allowed to move on a template, as one comparable string (stage 2). */
const rowSnapshot = (row) =>
  JSON.stringify({
    sourceId: row.sourceId,
    sourceSha256: row.sourceSha256,
    profileSha256: row.profileSha256,
    importedAt: row.importedAt === null ? null : row.importedAt.toISOString(),
    contentSha256: row.contentSha256,
    bodyBands: row.bodyBands,
    searchText: row.searchText,
  })

/** Every row this gate could have written, for a FAIL's diagnostic dump. */
async function dumpGateRows() {
  const templates = await prisma.slaveTemplate
    .findMany({
      where: { OR: CATALOG_NAMES.map((name) => ({ sourceId: { startsWith: `${name}/` } })) },
      select: { id: true, name: true, sourceId: true, active: true, contentSha256: true, capabilityKeys: true },
      orderBy: { sourceId: 'asc' },
    })
    .catch(() => [])
  const duplicates = await prisma.templateDuplicate
    .findMany({ include: { a: { select: { sourceId: true } }, b: { select: { sourceId: true } } } })
    .catch(() => [])
  const imports = await prisma.catalogImport.findMany({ where: { catalog: { in: CATALOG_NAMES } } }).catch(() => [])
  const decisions = []
  for (const id of workspaceIds) {
    decisions.push(...(await prisma.supervisorDecision.findMany({ where: { workspaceId: id } }).catch(() => [])))
  }
  const daemonTails = daemons.map((d) => ({
    label: d.label,
    pid: d.proc.pid ?? null,
    exited: d.exited,
    output: d.output.length > 6_000 ? `…${d.output.slice(-6_000)}` : d.output,
  }))
  return JSON.stringify(
    { templateCount: templates.length, templates: templates.slice(0, 40), duplicates, imports, decisions, daemonTails },
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
  )
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m55-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ============================================================================================
  // Stage 0: the preflight. Refusals, never fallbacks -- then the generated catalogs.
  // ============================================================================================

  // Zero spend, ENFORCED (M32 item 7).
  const fakeClaude = process.env['SLAVEOFAI_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'SLAVEOFAI_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m55-catalog',
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
  if (!existsSync(join(repoRoot, '.env'))) {
    throw new Error('no .env at the repository root -- run this gate through `npm run gate:m55-catalog`')
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m55-catalog`')
  }
  if (!existsSync(ORCHESTRATOR_CLI)) {
    throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI} -- run \`npx tsc --build\` first`)
  }
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)
  if (!existsSync(GEN_CATALOG)) throw new Error(`the seventh fake is missing at ${GEN_CATALOG}`)
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- stages 7, 9, 10 and 11 read a real rendered page, so set ` +
        'CHROMIUM_PATH to a real executable (e.g. a playwright-installed chromium under ~/.cache/ms-playwright/...).',
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
      `gate:m55-catalog REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate drives its own and would be measuring somebody else\'s ticks.',
    )
  }

  /** `git status --porcelain`, as stage 12 compares it. Read BEFORE anything is created. */
  const gitStatus = () => execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
  const gitStatusBefore = gitStatus()
  console.log(`stage 0: git status --porcelain before this gate = ${JSON.stringify(gitStatusBefore)}`)

  // THE OPERATOR'S OWN RUN ROOT, read BEFORE `gateStateDir()` chooses this process's own (M52 C1).
  const operatorRunsDir = join(
    (process.env['XDG_STATE_HOME'] ?? '') !== ''
      ? join(process.env['XDG_STATE_HOME'], 'slaveofai')
      : join(homedir(), '.local', 'state', 'slaveofai'),
    'runs',
  )
  const operatorRunDirs = () => (existsSync(operatorRunsDir) ? readdirSync(operatorRunsDir) : [])
  const operatorRunDirsBefore = operatorRunDirs()
  console.log(`operator state root: ${operatorRunsDir} holds ${String(operatorRunDirsBefore.length)} run director(ies) before this gate`)

  const stateDir = gateStateDir()
  console.log(`fake claude:  ${fakeClaude}`)
  console.log(`chromium:     ${chromiumPath}`)
  console.log(`state dir:    ${stateDir} (SLAVEOFAI_STATE_DIR, from scripts/lib/state-dir.mjs)`)
  console.log(
    `domain numbers: NEAR_DUPLICATE_JACCARD=${String(NEAR_DUPLICATE_JACCARD)} ` +
      `CAPABILITY_OVERLAP_JACCARD=${String(CAPABILITY_OVERLAP_JACCARD)} ` +
      `DUPLICATE_CLASSES=${JSON.stringify(DUPLICATE_CLASSES)}`,
  )

  await preflightCleanup()

  /** The diagnostic throw: the state that made the call, not just "it timed out". */
  async function fail(message) {
    let screenshotPath = null
    if (page !== null && diagDir !== null) {
      screenshotPath = join(diagDir, `failure-${String(Date.now())}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
    }
    const pageUrl = page === null ? '<no page>' : page.url()
    const rows = await dumpGateRows().catch(
      (cause) => `<could not dump rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
    )
    const dumpPath = diagDir === null ? null : join(diagDir, `rows-${String(Date.now())}.json`)
    if (dumpPath !== null) {
      try {
        writeFileSync(dumpPath, rows)
      } catch {
        /* the message below still carries the head */
      }
    }
    throw new Error(
      `${message}\n--- browser url ---\n${pageUrl}\n--- screenshot ---\n${screenshotPath ?? '<none>'}\n` +
        `--- rows ---\n${dumpPath ?? '<not written>'}\n${rows.length > 4_000 ? `${rows.slice(0, 4_000)}…` : rows}\n` +
        `--- browser console (tail) ---\n${browserConsole.slice(-40).join('\n')}`,
    )
  }

  /** Prints a measured value before asserting it, so a GREEN run's log carries the evidence too. */
  async function assertEqual(actual, expected, what) {
    console.log(`${what}: ${JSON.stringify(actual)}`)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      await fail(`${what} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
    }
  }

  /** The daemon this gate currently expects to be alive, or `null` between two of them. */
  let activeDaemon = null

  async function waitUntil(description, timeoutMs, probe) {
    const deadline = Date.now() + timeoutMs
    let lastDetail = '<never probed>'
    for (;;) {
      const result = await probe()
      if (result.done) return result.value
      lastDetail = result.detail
      if (activeDaemon !== null && activeDaemon.exited) {
        await fail(`the ${activeDaemon.label} exited while waiting for ${description} -- last seen: ${lastDetail}`)
      }
      if (Date.now() > deadline) {
        await fail(`timed out after ${String(timeoutMs)}ms waiting for ${description} -- last seen: ${lastDetail}`)
      }
      await delay(POLL_INTERVAL_MS)
    }
  }

  const childEnv = () =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8a-flow`,
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
    })

  /** Runs the real orchestrator CLI as a subprocess, exactly as an operator's shell would. */
  const runCli = (args) => {
    const result = spawnSync('node', [ORCHESTRATOR_CLI, ...args], {
      cwd: repoRoot,
      env: childEnv(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error !== undefined && result.error !== null) throw result.error
    return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) }
  }

  /** The same, refusing anything but a clean exit -- what every stage but 11 wants. */
  const runCliOk = (args) => {
    const result = runCli(args)
    if (result.status !== 0) {
      throw new Error(
        `the CLI refused \`${args.join(' ')}\` with status ${String(result.status)}\n` +
          `  stdout: ${result.stdout}\n  stderr: ${result.stderr}`,
      )
    }
    return result.stdout
  }

  /** The real daemon, in the background -- the same thing an operator leaves running. */
  function spawnDaemon(label, forWorkspaceId) {
    const proc = spawn(
      'node',
      [ORCHESTRATOR_CLI, 'daemon', '--workspace', forWorkspaceId, '--period', String(DAEMON_PERIOD_MS)],
      { cwd: repoRoot, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const state = { label, proc, output: '', exited: false }
    proc.stdout.on('data', (chunk) => {
      state.output += chunk.toString()
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
    console.log(`${label} spawned as pid ${String(proc.pid)} for workspace ${forWorkspaceId}`)
    return state
  }

  async function stopDaemon(state) {
    activeDaemon = null
    if (state.exited) return
    state.proc.kill('SIGTERM')
    const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (!state.exited && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
    if (!state.exited) {
      state.proc.kill('SIGKILL')
      while (!state.exited && Date.now() < deadline + PROCESS_EXIT_TIMEOUT_MS) await delay(POLL_INTERVAL_MS)
    }
    console.log(`${state.label} stopped (pid ${String(state.proc.pid)})`)
  }

  // ---- The three generated catalogs -------------------------------------------------------------
  // The directory's BASENAME is the catalog's name (M42 erratum E5), so each one is generated
  // straight into a named directory under this gate's own `mkdtemp` rather than into the `mkdtemp`
  // itself, which would name the catalog after a random suffix that changes on every run.
  catalogRoot = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m55-catalogs-'))
  const generate = (name, seed, extra = []) => {
    const dir = join(catalogRoot, name)
    const result = spawnSync('node', [GEN_CATALOG, dir, seed, ...extra], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    if (result.status !== 0) {
      throw new Error(`gen-catalog.mjs exited ${String(result.status)} for ${name}: ${String(result.stderr)}`)
    }
    return { dir, manifest: JSON.parse(String(result.stdout)) }
  }

  const main = generate(CATALOG_NAME, SEED)
  const manifest = main.manifest
  const catalogDir = main.dir
  console.log(
    `stage 0: ${String(manifest.count)} personas generated into ${catalogDir} from seed ${manifest.seed}; ` +
      `divisions ${JSON.stringify(manifest.divisions)}; licensed ${String(manifest.licensed)}`,
  )
  console.log(
    `stage 0: the manifest plants ${JSON.stringify(manifest.exact)} exact, ${JSON.stringify(manifest.near)} near, ` +
      `${JSON.stringify(manifest.overlapping)} overlapping and ${JSON.stringify(manifest.misses)} near-misses`,
  )
  await assertEqual(manifest.count, 120, 'stage 0: how many personas the generator wrote')
  if (!existsSync(join(catalogDir, 'LICENSE'))) await fail('stage 0: the licensed catalog has no LICENSE at its root')

  // THE DETERMINISM PROOF (spec section 3: "the same seed always writes the same bytes"). The same
  // seed twice, hashed over every file and its own relative path; and a DIFFERENT seed, so the hash
  // is proved to be a function of the input rather than a constant.
  const twin = generate(`${CATALOG_NAME}-twin`, SEED)
  const mainHash = treeHash(catalogDir)
  const twinHash = treeHash(twin.dir)
  const unlicensed = generate(UNLICENSED_CATALOG_NAME, UNLICENSED_SEED, ['--no-license'])
  const activeCatalog = generate(ACTIVE_CATALOG_NAME, ACTIVE_SEED)
  const otherHash = treeHash(activeCatalog.dir)
  console.log(`stage 0: tree sha256 seed ${SEED} = ${mainHash}; the same seed again = ${twinHash}; seed ${ACTIVE_SEED} = ${otherHash}`)
  if (mainHash !== twinHash) await fail(`stage 0: the same seed wrote different bytes (${mainHash} vs ${twinHash})`)
  if (mainHash === otherHash) await fail('stage 0: two different seeds wrote the same bytes -- the seed is not reaching the output')
  rmSync(twin.dir, { recursive: true, force: true })
  if (existsSync(join(unlicensed.dir, 'LICENSE'))) await fail('stage 0: --no-license still wrote a LICENSE')
  const names = new Set(Object.values(manifest.bySlug).map((entry) => entry.name))
  const collisions = Object.values(activeCatalog.manifest.bySlug)
    .map((entry) => entry.name)
    .filter((name) => names.has(name))
  await assertEqual(collisions.length, 0, 'stage 0: persona names shared by two catalogs (every one would be a name_taken skip)')

  // `bySlug` is how every stage turns a planted pair's slug into the row it is about.
  const sourceIdOf = (catalog, slug, bySlug) => `${catalog}/${bySlug[slug].division}/${slug}`
  const mainSourceId = (slug) => sourceIdOf(CATALOG_NAME, slug, manifest.bySlug)
  const slugOf = (sourceId) => sourceId.split('/').at(-1)

  // The baseline: every template that was here before this gate ran, and the columns stage 8 says
  // no import of ours moved.
  const baselineRows = await prisma.slaveTemplate.findMany({
    select: { id: true, name: true, sourceId: true, profile: true, profileSha256: true, active: true },
    orderBy: { id: 'asc' },
  })
  const baselineSnapshot = JSON.stringify(baselineRows)
  const baselineTemplates = baselineRows.length
  const baselineImports = await prisma.catalogImport.count()
  const baselinePairs = await prisma.templateDuplicate.count()
  console.log(
    `stage 0: the database holds ${String(baselineTemplates)} template(s), ${String(baselineImports)} import(s) and ` +
      `${String(baselinePairs)} pair(s) before this gate writes anything`,
  )
  console.log('stage 0 PASSED: three generated catalogs, one seed to one set of bytes, and a baseline to measure against')

  // ============================================================================================
  // Stage 1: the whole catalog arrives in one command, and the summary IS the report.
  // ============================================================================================

  const firstImport = runCliOk(['import-catalog', '--dir', catalogDir, '--by', 'gate'])
  console.log(`stage 1 -- import-catalog printed:\n${firstImport}`)

  const progressLines = firstImport.match(/^ {2}… \d+\/\d+ rows — /gm) ?? []
  const perRowLines = firstImport.match(/^ {2}created {2}/gm) ?? []
  console.log(`stage 1: ${String(progressLines.length)} progress line(s), ${String(perRowLines.length)} per-row created line(s)`)
  if (!firstImport.includes(`${CATALOG_NAME} (${catalogDir}): created 120, updated 0, unchanged 0, skipped 0`)) {
    await fail('stage 1: the summary line does not read `created 120, updated 0, unchanged 0, skipped 0`')
  }
  if (!firstImport.includes('  duplicates: 3 exact, 3 near, 3 overlapping')) {
    await fail('stage 1: the duplicates line does not read `3 exact, 3 near, 3 overlapping`')
  }
  if (firstImport.includes('the scan was truncated')) await fail('stage 1: the duplicate scan was truncated on 120 rows')
  // TWO progress lines and no third: `IMPORT_BATCH_SIZE` is 100 and the callback fires once per
  // batch AND once at the end however short the last one is (R7). One line would mean the batching
  // never ran; three would mean the end fired twice.
  await assertEqual(progressLines.length, 2, 'stage 1: how many progress lines a 120-row import printed')
  if (!firstImport.includes('  … 100/120 rows — ')) await fail('stage 1: no `100/120` progress line')
  if (!firstImport.includes('  … 120/120 rows — ')) await fail('stage 1: no `120/120` progress line')
  // ZERO per-row lines, counted rather than eyeballed: this is the whole of "the summary IS the
  // report" for a catalog nobody wants three hundred lines about.
  await assertEqual(perRowLines.length, 0, 'stage 1: per-row `created` lines in a default import')

  const afterFirst = await catalogTemplates(CATALOG_NAME)
  await assertEqual(afterFirst.length, 120, `stage 1: templates under ${CATALOG_NAME}/`)
  const bySourceId = new Map(afterFirst.map((row) => [row.sourceId, row]))
  for (const slug of Object.keys(manifest.bySlug)) {
    if (!bySourceId.has(mainSourceId(slug))) await fail(`stage 1: no template was created for ${mainSourceId(slug)}`)
  }
  const importRows = await prisma.catalogImport.findMany({ where: { catalog: CATALOG_NAME }, orderBy: { startedAt: 'asc' } })
  await assertEqual(importRows.length, 1, 'stage 1: CatalogImport rows for this catalog')
  const firstRow = importRows[0]
  await assertEqual(
    { created: firstRow.created, updated: firstRow.updated, unchanged: firstRow.unchanged, skipped: firstRow.skipped },
    { created: 120, updated: 0, unchanged: 0, skipped: 0 },
    "stage 1: the CatalogImport row's four counters",
  )
  // Field by field rather than object against object: the column is a `Json` and Postgres hands its
  // keys back in whatever order it stored them, which is not the order this literal is written in.
  await assertEqual(
    {
      exact: firstRow.report.duplicates.exact,
      near: firstRow.report.duplicates.near,
      overlapping: firstRow.report.duplicates.overlapping,
    },
    { exact: 3, near: 3, overlapping: 3 },
    "stage 1: the report's three duplicate counts",
  )

  // The same directory again, under `--verbose`. It prints `unchanged 120` and STILL no per-row
  // line, and that is not a contradiction: `--verbose` adds a line per CREATED and per UPDATED row
  // (`describeImport`, `apps/orchestrator/src/cli.ts`), and an unchanged row has no line at any
  // verbosity. The positive half -- 120 lines under `--verbose` on a run that creates -- is stage
  // 4d's, against the third catalog.
  const verboseRerun = runCliOk(['import-catalog', '--dir', catalogDir, '--by', 'gate', '--verbose'])
  console.log(`stage 1 -- the --verbose re-import printed:\n${verboseRerun.split('\n').slice(0, 8).join('\n')}`)
  if (!verboseRerun.includes('created 0, updated 0, unchanged 120, skipped 0')) {
    await fail('stage 1: the --verbose re-import does not read `unchanged 120`')
  }
  await assertEqual(
    (verboseRerun.match(/^ {2}(?:created|updated) {2}/gm) ?? []).length,
    0,
    'stage 1: per-row lines under --verbose for a run in which nothing was created or updated',
  )

  const listImports = runCliOk(['list-imports', '--limit', '2'])
  console.log(`stage 1 -- list-imports printed:\n${listImports}`)
  if (!listImports.includes('when  catalog  by  outcomes  duplicates exact/near/overlapping  directory')) {
    await fail('stage 1: list-imports prints no header naming its columns')
  }
  const newestLine = listImports.split('\n').find((line) => line.includes(CATALOG_NAME))
  console.log(`stage 1 -- the newest import row reads: ${JSON.stringify(newestLine)}`)
  if (newestLine === undefined || !newestLine.includes('created 0, updated 0, unchanged 120, skipped 0') || !newestLine.includes('duplicates 3/3/3')) {
    await fail('stage 1: list-imports does not print all seven numbers for the newest row')
  }
  console.log(
    'stage 1 PASSED: one command, 120 rows, two progress lines, three duplicate counts, and not one per-row line ' +
      'anybody did not ask for',
  )

  // ============================================================================================
  // Stage 2: the same import again changes nothing.
  // ============================================================================================

  const beforeThird = await catalogTemplates(CATALOG_NAME)
  const snapshotBefore = Object.fromEntries(beforeThird.map((row) => [row.sourceId, rowSnapshot(row)]))
  const pairsBefore = await pairTableSnapshot()

  const thirdImport = runCliOk(['import-catalog', '--dir', catalogDir, '--by', 'gate'])
  console.log(`stage 2 -- the third import printed:\n${thirdImport.split('\n').slice(0, 6).join('\n')}`)
  if (!thirdImport.includes('created 0, updated 0, unchanged 120, skipped 0')) {
    await fail('stage 2: the third import did not leave every row unchanged')
  }
  const afterThird = await catalogTemplates(CATALOG_NAME)
  await assertEqual(afterThird.length, 120, 'stage 2: templates under this catalog after a third import')
  const moved = afterThird.filter((row) => snapshotBefore[row.sourceId] !== rowSnapshot(row)).map((row) => row.sourceId)
  await assertEqual(moved, [], 'stage 2: rows whose sourceSha256/profileSha256/importedAt/contentSha256/bodyBands/searchText moved')
  const pairsAfter = await pairTableSnapshot()
  if (pairsAfter !== pairsBefore) {
    await fail(`stage 2: the pair table moved under a re-import\n  before: ${pairsBefore}\n  after:  ${pairsAfter}`)
  }
  console.log(
    'stage 2 PASSED: a re-import of an unchanged catalog wrote nothing -- not a hash, not an importedAt, and not one ' +
      'new pair or one moved detectedAt',
  )

  // ============================================================================================
  // Stage 3: nothing that arrived is hirable.
  // ============================================================================================

  const soloSourceId = mainSourceId(manifest.soloSlug)
  const solo = await prisma.slaveTemplate.findFirstOrThrow({ where: { sourceId: soloSourceId } })
  const generatedIds = new Set(afterThird.map((row) => row.id))
  const activeRows = afterThird.filter((row) => row.active)
  await assertEqual(activeRows.map((row) => row.sourceId), [], 'stage 3: imported rows that are already hirable')
  console.log(`stage 3: the solo specialist is ${solo.id} (${solo.name}), capabilityKeys ${JSON.stringify(solo.capabilityKeys)}`)
  if (!solo.capabilityKeys.includes(manifest.soloCapabilityKey)) {
    await fail(`stage 3: the solo persona does not provide ${manifest.soloCapabilityKey}`)
  }
  const otherProviders = afterThird.filter((row) => row.id !== solo.id && row.capabilityKeys.includes(manifest.soloCapabilityKey))
  await assertEqual(otherProviders.map((row) => row.sourceId), [], `stage 3: other generated rows providing ${manifest.soloCapabilityKey}`)
  // A row somebody else's gate left behind that ALSO provides this capability would make stage 4's
  // "and no other" a statement about the wrong catalog. Refused here rather than discovered there.
  const strayProviders = await prisma.slaveTemplate.findMany({
    where: { active: true, capabilityKeys: { has: manifest.soloCapabilityKey } },
    select: { id: true, name: true },
  })
  await assertEqual(
    strayProviders.map((row) => row.name),
    [],
    `stage 3: ACTIVE templates outside this catalog that already provide ${manifest.soloCapabilityKey}`,
  )

  const capabilityRow = await prisma.capability.findUnique({ where: { key: manifest.soloCapabilityKey } })
  if (capabilityRow === null) await fail(`stage 3: the taxonomy has no ${manifest.soloCapabilityKey} -- the import should have synced it`)
  const staffingRole = capabilityRow.role
  console.log(`stage 3: ${manifest.soloCapabilityKey} is ${JSON.stringify(capabilityRow.label)} and projects to the role ${JSON.stringify(staffingRole)}`)

  /** One project with one startable task and nobody at all on it: the Supervisor's `capability_unstaffed`
   *  predicate is "nobody holds the role this capability projects to", and a team with no members is
   *  the cleanest way to be sure of that. Each phase gets its OWN project because `filterFresh` blocks
   *  a situation key that already has a pending decision -- so a second tick in the same workspace
   *  would answer nothing at all, whatever the catalog had done in between. */
  const makeStaffingProject = async (label) => {
    const repoPath = makeRepo(label)
    repoPaths.push(repoPath)
    const workspace = await prisma.workspace.create({
      data: {
        name: `${WORKSPACE_PREFIX} ${label} ${STAMP}`,
        repoPath,
        baseBranch: 'main',
        autoMerge: false,
        verifyCommands: ['true'],
        setupCommands: [],
        budgetUsd: 10,
      },
    })
    workspaceIds.push(workspace.id)
    await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
    await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: `${TASK_TITLE} ${label}`,
        description: `Seeded by gate:m55-catalog -- it needs ${capabilityRow.label} and nobody here has it.`,
        status: 'ready',
        maxAttempts: 3,
        // The role the capability PROJECTS to, written out rather than left null: a task with no
        // `requiredRole` is dropped by `loadSupervisorWorld`'s own task loop ("a task with NO
        // required role is dropped, exactly as the scheduler drops it"), so a Supervisor handed one
        // sees an empty board and raises nothing at all.
        requiredRole: staffingRole,
        requiredCapabilities: [manifest.soloCapabilityKey],
      },
    })
    if (!workspace.supervisorEnabled) await fail(`stage 3: ${label}'s Supervisor is switched off`)
    console.log(`stage 3: project ${label} is ${workspace.id}, one ready task needing ${manifest.soloCapabilityKey}, no slaves at all`)
    return workspace.id
  }

  /** Every decision this project has made, with its action payload as text -- what stages 3 and 4
   *  scan for a template id. */
  const decisionsOf = (workspaceId) =>
    prisma.supervisorDecision.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })

  const namedTemplateIds = (decisions) => {
    const found = new Set()
    for (const decision of decisions) {
      const text = JSON.stringify({ action: decision.action, situation: decision.situation })
      for (const id of generatedIds) if (text.includes(id)) found.add(id)
    }
    return [...found]
  }

  const waitForGap = async (workspaceId, phase) =>
    await waitUntil(`${phase}: the Supervisor to notice ${manifest.soloCapabilityKey} is unstaffed`, SUPERVISOR_TIMEOUT_MS, async () => {
      const row = await prisma.supervisorDecision.findFirst({
        where: { workspaceId, situationKind: 'capability_unstaffed', subjectId: manifest.soloCapabilityKey },
        orderBy: { createdAt: 'asc' },
      })
      return row === null ? { done: false, detail: 'no capability_unstaffed decision yet' } : { done: true, value: row }
    })

  const inertWorkspaceId = await makeStaffingProject('inert')
  const worldBefore = await loadSupervisorWorld(inertWorkspaceId, new Date())
  const catalogIdsBefore = worldBefore.world.catalog.map((entry) => entry.id)
  console.log(`stage 3: the loaded SupervisorWorld's catalog holds ${String(catalogIdsBefore.length)} entr(ies): ${JSON.stringify(catalogIdsBefore)}`)
  await assertEqual(
    catalogIdsBefore.filter((id) => generatedIds.has(id)),
    [],
    "stage 3: generated templates in the Supervisor's own catalog",
  )

  const inertDaemon = spawnDaemon('inert-daemon', inertWorkspaceId)
  const inertDecision = await waitForGap(inertWorkspaceId, 'stage 3')
  console.log(
    `stage 3: the Supervisor raised ${inertDecision.situationKind}(${inertDecision.subjectId}) and answered with ` +
      `${JSON.stringify(inertDecision.action.kind)} (${inertDecision.status}/${inertDecision.tier})`,
  )
  // One more beat, so "no decision names one of them" is measured over a Supervisor that has had
  // every chance to make a second decision rather than over its first tick alone.
  await delay(DAEMON_PERIOD_MS * 4)
  await stopDaemon(inertDaemon)
  const inertDecisions = await decisionsOf(inertWorkspaceId)
  console.log(
    `stage 3: ${String(inertDecisions.length)} decision(s) on the inert project: ` +
      JSON.stringify(inertDecisions.map((row) => `${row.situationKind}->${row.action.kind}`)),
  )
  await assertEqual(namedTemplateIds(inertDecisions), [], 'stage 3: generated template ids named by any decision or proposal')
  const stillInactive = await prisma.slaveTemplate.count({ where: { sourceId: { startsWith: `${CATALOG_NAME}/` }, active: false } })
  await assertEqual(stillInactive, 120, 'stage 3: generated rows still inactive after a real daemon has ticked')
  console.log(
    'stage 3 PASSED: 120 rows arrived, a real daemon raised the staffing gap they were written for, and not one ' +
      'decision, proposal or catalog entry named any of them',
  )

  // ============================================================================================
  // Stage 4a: one `template activate`, and exactly one row becomes the answer.
  // ============================================================================================

  const activateOut = runCliOk(['template', 'activate', '--template', solo.id, '--by', 'gate'])
  console.log(`stage 4a -- template activate printed: ${JSON.stringify(activateOut.trim())}`)
  if (activateOut.trim() !== `${solo.name} is now active`) {
    await fail(`stage 4a: template activate printed ${JSON.stringify(activateOut.trim())}`)
  }
  const activated = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: solo.id } })
  console.log(
    `stage 4a: the row reads active=${String(activated.active)}, activationChangedAt=${String(activated.activationChangedAt?.toISOString())}, ` +
      `activationChangedBy=${JSON.stringify(activated.activationChangedBy)}`,
  )
  if (!activated.active) await fail('stage 4a: the row is not active')
  if (activated.activationChangedAt === null) await fail('stage 4a: nothing recorded WHEN it was activated')
  await assertEqual(activated.activationChangedBy, 'gate', 'stage 4a: who the row says activated it')
  await assertEqual(
    await prisma.slaveTemplate.count({ where: { sourceId: { startsWith: `${CATALOG_NAME}/` }, active: true } }),
    1,
    'stage 4a: how many of the 120 one `template activate` made hirable',
  )

  const hiringWorkspaceId = await makeStaffingProject('hiring')
  const hiringDaemon = spawnDaemon('hiring-daemon', hiringWorkspaceId)
  const hireDecision = await waitUntil('stage 4a: the Supervisor to offer a hire from the catalog', SUPERVISOR_TIMEOUT_MS, async () => {
    const row = await prisma.supervisorDecision.findFirst({
      where: { workspaceId: hiringWorkspaceId, situationKind: 'capability_unstaffed', subjectId: manifest.soloCapabilityKey },
      orderBy: { createdAt: 'asc' },
    })
    if (row === null) return { done: false, detail: 'no capability_unstaffed decision yet' }
    return { done: true, value: row }
  })
  console.log(`stage 4a: the decision is ${JSON.stringify({ kind: hireDecision.action.kind, templateId: hireDecision.action.templateId ?? null })}`)
  await assertEqual(hireDecision.action.kind, 'hire_from_catalog', 'stage 4a: what the Supervisor offered once one row was active')
  await assertEqual(hireDecision.action.templateId, solo.id, 'stage 4a: which template the offer names')
  await delay(DAEMON_PERIOD_MS * 4)
  await stopDaemon(hiringDaemon)
  const hiringDecisions = await decisionsOf(hiringWorkspaceId)
  await assertEqual(namedTemplateIds(hiringDecisions), [solo.id], 'stage 4a: every generated template id any decision names')
  console.log('stage 4a PASSED: one `template activate` turned exactly one of the 120 into the answer, and no other')

  // ============================================================================================
  // Stage 4b: `template deactivate` puts it back, and the next tick proposes it no more.
  // ============================================================================================

  const deactivateOut = runCliOk(['template', 'deactivate', '--template', solo.id])
  console.log(`stage 4b -- template deactivate printed: ${JSON.stringify(deactivateOut.trim())}`)
  if (deactivateOut.trim() !== `${solo.name} is now inactive`) {
    await fail(`stage 4b: template deactivate printed ${JSON.stringify(deactivateOut.trim())}`)
  }
  await assertEqual(
    await prisma.slaveTemplate.count({ where: { sourceId: { startsWith: `${CATALOG_NAME}/` }, active: true } }),
    0,
    'stage 4b: hirable rows under this catalog after the deactivation',
  )
  const afterWorkspaceId = await makeStaffingProject('after')
  const afterDaemon = spawnDaemon('after-daemon', afterWorkspaceId)
  await waitForGap(afterWorkspaceId, 'stage 4b')
  await delay(DAEMON_PERIOD_MS * 4)
  await stopDaemon(afterDaemon)
  const afterDecisions = await decisionsOf(afterWorkspaceId)
  console.log(
    `stage 4b: ${String(afterDecisions.length)} decision(s) after the deactivation: ` +
      JSON.stringify(afterDecisions.map((row) => `${row.situationKind}->${row.action.kind}`)),
  )
  await assertEqual(namedTemplateIds(afterDecisions), [], 'stage 4b: generated template ids named after the deactivation')
  console.log('stage 4b PASSED: the same gap, the same daemon, and the deactivated row is nobody\'s answer again')

  // ============================================================================================
  // Stage 5: the three classes, the planted pairs, and the right basis.
  // ============================================================================================

  const pairs = await catalogPairs(CATALOG_NAME)
  const live = pairs.filter((row) => row.dismissedAt === null)
  console.log(`stage 5: ${String(pairs.length)} pair(s) under ${CATALOG_NAME}/, ${String(live.length)} undismissed`)
  for (const row of live) {
    console.log(
      `  ${row.class}/${row.basis} ${row.score.toFixed(3)}  ${slugOf(row.a.sourceId)} + ${slugOf(row.b.sourceId)}  ` +
        `(aId<bId: ${String(row.aId < row.bId)})`,
    )
  }
  await assertEqual(live.length, 9, 'stage 5: undismissed pairs both of whose ends are in this catalog')
  const outOfOrder = live.filter((row) => !(row.aId < row.bId)).map((row) => row.id)
  await assertEqual(outOfOrder, [], 'stage 5: pairs whose aId is not the LOW half of the ordered pair')
  const pairKeys = live.map((row) => `${row.aId}:${row.bId}`)
  await assertEqual(pairKeys.length, new Set(pairKeys).size, 'stage 5: distinct (aId, bId) keys among the nine')
  const unorderedKeys = live.map((row) => [slugOf(row.a.sourceId), slugOf(row.b.sourceId)].sort().join(' + '))
  await assertEqual(unorderedKeys.length, new Set(unorderedKeys).size, 'stage 5: distinct slug pairs -- no pair under two classes')

  /** The shingles of a stored row, recomputed IN THE GATE from its own `profileSpec`, so the body
   *  Jaccard stage 5 asserts is not the one the detector wrote down. */
  const shinglesOfRow = (row) => shinglesOf(canonicalPersonaText(row.profileSpec))
  const bodyJaccard = (row) => jaccard(shinglesOfRow(row.a), shinglesOfRow(row.b))
  const capabilityJaccard = (row) => jaccard(new Set(row.a.capabilityKeys), new Set(row.b.capabilityKeys))

  const byClass = { exact: [], near: [], overlapping: [] }
  for (const row of live) byClass[row.class].push(row)
  await assertEqual(
    { exact: byClass.exact.length, near: byClass.near.length, overlapping: byClass.overlapping.length },
    { exact: 3, near: 3, overlapping: 3 },
    'stage 5: how many pairs of each class',
  )

  /** The slug pair a `TemplateDuplicate` row is about, sorted, so it can be matched against the
   *  generator's manifest without caring which half `orderedPair` put first. */
  const slugPair = (row) => [slugOf(row.a.sourceId), slugOf(row.b.sourceId)].sort().join(' + ')
  const plantedKeyOf = (pair) => [...pair].sort().join(' + ')
  for (const [className, planted] of [['exact', manifest.exact], ['near', manifest.near], ['overlapping', manifest.overlapping]]) {
    const found = byClass[className].map(slugPair).sort()
    const wanted = planted.map(plantedKeyOf).sort()
    await assertEqual(found, wanted, `stage 5: the ${className} pairs, by the slugs the generator planted`)
  }
  await assertEqual(
    byClass.exact.map((row) => row.basis).sort(),
    ['content_hash', 'content_hash', 'name'],
    'stage 5: the three exact pairs\' bases',
  )
  for (const row of byClass.near) {
    const measured = bodyJaccard(row)
    console.log(`stage 5: near ${slugPair(row)} basis ${row.basis} score ${row.score.toFixed(3)}, body jaccard recomputed ${measured.toFixed(4)}`)
    if (row.basis !== 'body_shingles') await fail(`stage 5: a near pair's basis is ${row.basis}`)
    if (row.score < NEAR_DUPLICATE_JACCARD) await fail(`stage 5: a near pair scores ${String(row.score)}, under ${String(NEAR_DUPLICATE_JACCARD)}`)
    if (Math.abs(measured - row.score) > 0.001) {
      await fail(`stage 5: the stored score ${String(row.score)} is not the body jaccard ${measured.toFixed(4)}`)
    }
  }
  for (const row of byClass.overlapping) {
    const body = bodyJaccard(row)
    const caps = capabilityJaccard(row)
    console.log(
      `stage 5: overlapping ${slugPair(row)} basis ${row.basis} score ${row.score.toFixed(3)}; recomputed capability ` +
        `jaccard ${caps.toFixed(4)}, BODY jaccard ${body.toFixed(4)} (must be under ${String(NEAR_DUPLICATE_JACCARD)})`,
    )
    if (row.basis !== 'capability_keys') await fail(`stage 5: an overlapping pair's basis is ${row.basis}`)
    if (row.score < CAPABILITY_OVERLAP_JACCARD) await fail(`stage 5: an overlapping pair scores ${String(row.score)}`)
    if (normalisePersona(row.a.name) === normalisePersona(row.b.name)) {
      await fail("stage 5: an overlapping pair's two names fold equal -- that pair would be exact by NAME, not overlapping")
    }
    // WHY the class is `overlapping` and not `near`: the arms are tried strongest first, and this
    // pair's text is nowhere near the near threshold.
    if (body >= NEAR_DUPLICATE_JACCARD) {
      await fail(`stage 5: an overlapping pair's body jaccard is ${body.toFixed(4)} -- it should have been classified near`)
    }
  }
  console.log(
    'stage 5 PASSED: exactly nine pairs, the nine that were planted, each with the basis its construction earns and ' +
      'each overlapping one proved to be overlapping rather than near',
  )

  // ============================================================================================
  // Stage 6: the near-misses are not signals, and a recompute agrees.
  // ============================================================================================

  const rowFor = async (slug) =>
    await prisma.slaveTemplate.findFirstOrThrow({
      where: { sourceId: mainSourceId(slug) },
      select: { id: true, name: true, capabilityKeys: true, profileSpec: true },
    })
  for (const [left, right] of manifest.misses) {
    const a = await rowFor(left)
    const b = await rowFor(right)
    const rows = await prisma.templateDuplicate.findMany({
      where: { OR: [{ aId: a.id, bId: b.id }, { aId: b.id, bId: a.id }] },
    })
    const body = jaccard(shinglesOf(canonicalPersonaText(a.profileSpec)), shinglesOf(canonicalPersonaText(b.profileSpec)))
    const caps = jaccard(new Set(a.capabilityKeys), new Set(b.capabilityKeys))
    console.log(
      `stage 6: near-miss ${left} + ${right} -- body jaccard ${body.toFixed(4)}, capability jaccard ${caps.toFixed(4)}, ` +
        `names fold equal ${String(normalisePersona(a.name) === normalisePersona(b.name))}, rows ${String(rows.length)}`,
    )
    // The fixture is asserted to BE a near-miss before its absence is read as one: a pair that was
    // never close would make "no row" true for the wrong reason.
    if (body >= NEAR_DUPLICATE_JACCARD) await fail(`stage 6: ${left} + ${right} is at or over the near threshold`)
    if (caps >= CAPABILITY_OVERLAP_JACCARD) await fail(`stage 6: ${left} + ${right} is at or over the capability threshold`)
    if (normalisePersona(a.name) === normalisePersona(b.name)) await fail(`stage 6: ${left} + ${right} fold to the same name`)
    await assertEqual(rows.length, 0, `stage 6: rows for the near-miss ${left} + ${right}, in either order`)
  }

  const beforeRecompute = await pairTableSnapshot()
  const recomputeOne = runCliOk(['template', 'duplicates', '--recompute'])
  const recomputeLine = recomputeOne.split('\n')[0]
  console.log(`stage 6 -- template duplicates --recompute printed: ${JSON.stringify(recomputeLine)}`)
  if (!recomputeLine.startsWith('recomputed: 9 pair(s) -- 3 exact, 3 near, 3 overlapping;')) {
    await fail(`stage 6: the recompute line does not report the nine pairs: ${JSON.stringify(recomputeLine)}`)
  }
  if (!/; 0 new, 0 re-classified, 0 retired,/.test(recomputeLine)) {
    await fail(`stage 6: the recompute created, re-classified or retired something: ${JSON.stringify(recomputeLine)}`)
  }
  const afterRecomputeOne = await pairTableSnapshot()
  if (afterRecomputeOne !== beforeRecompute) {
    await fail(`stage 6: the first recompute moved the pair table\n  before: ${beforeRecompute}\n  after:  ${afterRecomputeOne}`)
  }
  const recomputeTwo = runCliOk(['template', 'duplicates', '--recompute'])
  console.log(`stage 6 -- the second recompute printed: ${JSON.stringify(recomputeTwo.split('\n')[0])}`)
  const afterRecomputeTwo = await pairTableSnapshot()
  if (afterRecomputeTwo !== beforeRecompute) {
    await fail('stage 6: running the recompute twice is not a no-op')
  }
  // The listing that follows the recompute line in the SAME command (D50) names the pairs -- with
  // the COUNT line between them (final wave, Important 2): the verb says `N of M pair(s)` the way
  // `template list` does, because the read stops at two hundred and a bare list looked complete.
  const recomputeLines = recomputeTwo.split('\n').filter((line) => line.trim() !== '')
  await assertEqual(recomputeLines[1], '9 of 9 pair(s)', 'stage 6: the count line above the recompute listing')
  const listedPairIds = recomputeLines.slice(2).map((line) => line.split('\t')[0])
  console.log(`stage 6: the recompute's own listing names ${String(listedPairIds.length)} pair(s)`)
  await assertEqual(listedPairIds.length, 9, 'stage 6: pairs the recompute listed beside its own summary line')
  console.log(
    'stage 6 PASSED: three near-misses measured under their own thresholds and absent from the table, and two ' +
      'recomputes that changed not one byte of it',
  )

  // ============================================================================================
  // Stage 7a: a dismissal is a person's, and it survives an import and a recompute.
  // ============================================================================================

  const exactOnePairSlugs = manifest.exact[0]
  const exactOneA = await rowFor(exactOnePairSlugs[0])
  const exactOneB = await rowFor(exactOnePairSlugs[1])
  const dismissTarget = live.find((row) => slugPair(row) === plantedKeyOf(exactOnePairSlugs))
  if (dismissTarget === undefined) await fail('stage 7a: the first exact pair is not in the table')
  const dismissOut = runCliOk(['template', 'duplicates', '--dismiss', dismissTarget.id, '--by', 'gate'])
  console.log(`stage 7a -- template duplicates --dismiss printed: ${JSON.stringify(dismissOut.trim())}`)
  if (dismissOut.trim() !== `${dismissTarget.id} is now dismissed`) {
    await fail(`stage 7a: the dismissal printed ${JSON.stringify(dismissOut.trim())}`)
  }
  const dismissed = await prisma.templateDuplicate.findUniqueOrThrow({ where: { id: dismissTarget.id } })
  console.log(
    `stage 7a: the pair reads dismissedAt=${String(dismissed.dismissedAt?.toISOString())}, dismissedBy=${JSON.stringify(dismissed.dismissedBy)}`,
  )
  if (dismissed.dismissedAt === null) await fail('stage 7a: nothing recorded WHEN it was dismissed')
  await assertEqual(dismissed.dismissedBy, 'gate', 'stage 7a: who the pair says dismissed it')
  await assertEqual((await catalogPairs(CATALOG_NAME)).length, 9, 'stage 7a: pairs in the table after a dismissal (a dismissal deletes nothing)')
  await assertEqual(
    (await catalogPairs(CATALOG_NAME)).filter((row) => row.dismissedAt === null).length,
    8,
    'stage 7a: undismissed pairs after one dismissal',
  )
  const dismissalStamp = JSON.stringify({ at: dismissed.dismissedAt.toISOString(), by: dismissed.dismissedBy })
  runCliOk(['import-catalog', '--dir', catalogDir, '--by', 'gate'])
  runCliOk(['template', 'duplicates', '--recompute'])
  const afterBoth = await prisma.templateDuplicate.findUniqueOrThrow({ where: { id: dismissTarget.id } })
  await assertEqual(
    JSON.stringify({ at: afterBoth.dismissedAt?.toISOString() ?? null, by: afterBoth.dismissedBy }),
    dismissalStamp,
    'stage 7a: the dismissal stamp after a further import and a further recompute',
  )
  console.log('stage 7a PASSED: a dismissal is a stamp, it deletes nothing, and neither an import nor a recompute touches it')

  // ============================================================================================
  // Stage 8: nothing was deleted.
  // ============================================================================================

  const templateTotal = await prisma.slaveTemplate.count()
  await assertEqual(templateTotal, baselineTemplates + 120, 'stage 8: templates in the database after four imports, two recomputes and a dismissal')
  const baselineAfter = await prisma.slaveTemplate.findMany({
    where: { id: { in: baselineRows.map((row) => row.id) } },
    select: { id: true, name: true, sourceId: true, profile: true, profileSha256: true, active: true },
    orderBy: { id: 'asc' },
  })
  if (JSON.stringify(baselineAfter) !== baselineSnapshot) {
    await fail(
      `stage 8: a template that was here before this gate ran has moved\n  before: ${baselineSnapshot.slice(0, 1_500)}\n` +
        `  after:  ${JSON.stringify(baselineAfter).slice(0, 1_500)}`,
    )
  }
  const seeded = baselineAfter.filter((row) => row.sourceId === null)
  console.log(`stage 8: ${String(seeded.length)} hand-made template(s) were here before this gate; ${String(seeded.filter((r) => r.active).length)} are active`)
  await assertEqual(seeded.filter((row) => !row.active).map((row) => row.name), [], 'stage 8: hand-made templates this gate left inactive')
  console.log('stage 8 PASSED: the baseline plus 120, not one row deleted, and every row that was here is byte-for-byte what it was')

  // ============================================================================================
  // The real web shell, on a free port, loopback-bound.
  // ============================================================================================
  const strayBeforeNext = findRealDaemonPids()
  console.log(`orchestrator daemons running before next dev: ${JSON.stringify(strayBeforeNext)}`)
  if (strayBeforeNext.length > 0) await fail(`an orchestrator daemon is running (pid ${strayBeforeNext.join(', ')})`)

  const preferredPort = await findFreePort()
  nextServer = spawn(
    'node',
    ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort), '-H', '127.0.0.1'],
    { cwd: repoRoot, env: loopbackChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let nextExited = false
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

  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: VIEWPORT })
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  page.on('pageerror', (error) => {
    console.error(`[browser:pageerror] ${error}`)
    browserConsole.push(`[pageerror] ${String(error).slice(0, 300)}`)
  })
  page.on('console', (message) => browserConsole.push(`[${message.type()}] ${message.text().slice(0, 300)}`))
  page.on('requestfailed', (request) => browserConsole.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`))

  async function waitVisible(locator, description) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
    } catch {
      await fail(`timed out waiting for ${description} to become visible`)
    }
  }

  /** `page.goto`, retried ONCE and only on next dev's own manifest-race signature. */
  async function gotoReliably(url) {
    const consoleStart = browserConsole.length
    const nextOutputStart = nextOutput.length
    const raced = () =>
      browserConsole.slice(consoleStart).some((line) => line.includes(MANIFEST_RACE_SIGNATURE)) ||
      nextOutput.slice(nextOutputStart).includes(MANIFEST_RACE_SIGNATURE)
    const describe = (response, error) => {
      if (error !== null) return `failed (${error instanceof Error ? error.message : String(error)})`
      if (response === null) return 'resolved with no response (an anchor/same-document navigation, per Playwright)'
      return `returned ${String(response.status())}`
    }

    let first = null
    let firstError = null
    try {
      first = await page.goto(url, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
    } catch (cause) {
      firstError = cause
    }
    if (first === null && firstError === null) return null
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
    if (secondError !== null || (second !== null && second.status() >= 500)) {
      await fail(`gotoReliably: ${url} ${describe(second, secondError)} on the retry too`)
    }
    return second
  }

  /** Every catalog row on screen right now, as template ids (`gate-m46-workforce-catalog.mjs`). */
  const rowIds = async () =>
    (
      await page.locator('[data-testid^="catalog-row-"]').evaluateAll((nodes) =>
        nodes.map((node) => (node.getAttribute('data-testid') ?? '').replace('catalog-row-', '')),
      )
    ).sort()
  const countText = async () => (await page.getByTestId('catalog-count').textContent())?.trim() ?? ''

  /**
   * Waits until REACT OWNS the filter bar, not merely until it is painted.
   *
   * The first page of this tab is server-rendered (`app/workforce/page.tsx` reads the URL's filters
   * itself), so every control is on screen and clickable a long time before hydration attaches a
   * single handler -- and a `fill()` or a `click()` in that window does exactly nothing, silently.
   * That is a real race and not a theoretical one: it cost this gate one red run on the search box
   * and nothing else changed between the two.
   *
   * React attaches a `__reactFiber$…` / `__reactProps$…` key to every host node it hydrates, which
   * is the one signal available from outside the bundle that says "this node's handlers are live".
   * Polling it is better than re-clicking on a timeout, because half the controls on this tab are
   * TOGGLES: a second click on the activation control would undo the first.
   */
  const waitHydrated = async () => {
    try {
      await page.waitForFunction(
        () => {
          const node = document.querySelector('[data-testid="catalog-search"]')
          return node !== null && Object.keys(node).some((key) => key.startsWith('__react'))
        },
        undefined,
        { timeout: ACTION_TIMEOUT_MS },
      )
    } catch {
      await fail('the Catalog tab never hydrated -- React never took ownership of the filter bar')
    }
  }

  /** Opens the Catalog tab at one URL and waits for the list (or the empty state) to settle. */
  const openCatalog = async (query) => {
    const url = `${baseUrl}/workforce?tab=catalog${query === '' ? '' : `&${query}`}`
    await gotoReliably(url)
    await waitVisible(page.getByTestId('catalog-count'), `the catalog count for ${url}`)
    await waitHydrated()
    return url
  }

  /** Clicks `Show more` until every row of the current filter is on screen. `nextCursor` is
   *  non-null for a page that came back exactly full even when nothing follows (D22), so the loop
   *  stops on the ROW COUNT rather than on the control's absence. */
  const loadEveryPage = async (expected, what) => {
    for (let clicks = 0; clicks < 10; clicks += 1) {
      const ids = await rowIds()
      if (ids.length >= expected) return ids
      if ((await page.getByTestId('catalog-more').count()) === 0) {
        await fail(`${what}: ${String(ids.length)} of ${String(expected)} rows are on screen and there is no Show more`)
      }
      await page.getByTestId('catalog-more').click()
      await waitUntil(`${what}: page ${String(clicks + 2)} to arrive`, ACTION_TIMEOUT_MS, async () => {
        const now = await rowIds()
        return now.length > ids.length ? { done: true, value: now } : { done: false, detail: `${String(now.length)} rows` }
      })
    }
    await fail(`${what}: Show more did not finish the list in ten clicks`)
    return []
  }

  const plural = (count, noun) => `${String(count)} ${noun}${count === 1 ? '' : 's'}`

  // ============================================================================================
  // Stage 7b: the dismissed pair's chip is gone in the browser, and `--restore` puts it back.
  // ============================================================================================

  // A query that reaches exactly the two halves of the first exact pair: it is their shared
  // description, which `catalogSearchText` folds into `searchText` -- and no other persona has it.
  const exactOneQuery = 'keeps the record of what changed'
  await openCatalog(`q=${encodeURIComponent(exactOneQuery)}`)
  const exactOneIds = await rowIds()
  await assertEqual(exactOneIds.sort(), [exactOneA.id, exactOneB.id].sort(), 'stage 7b: the rows the exact pair\'s own summary reaches')
  await assertEqual(
    await page.locator(`[data-testid="catalog-duplicate-${exactOneA.id}"]`).count(),
    0,
    "stage 7b: the dismissed pair's chip on the row it is about",
  )
  await openCatalog(`q=${encodeURIComponent(exactOneQuery)}&duplicates=none`)
  await assertEqual((await rowIds()).sort(), [exactOneA.id, exactOneB.id].sort(), 'stage 7b: the `no signal` facet after the dismissal')

  const restoreOut = runCliOk(['template', 'duplicates', '--restore', dismissTarget.id])
  console.log(`stage 7b -- template duplicates --restore printed: ${JSON.stringify(restoreOut.trim())}`)
  if (restoreOut.trim() !== `${dismissTarget.id} is now showing again`) {
    await fail(`stage 7b: the restore printed ${JSON.stringify(restoreOut.trim())}`)
  }
  await openCatalog(`q=${encodeURIComponent(exactOneQuery)}`)
  await waitVisible(page.locator(`[data-testid="catalog-duplicate-${exactOneA.id}"]`), 'the restored duplicate chip')
  const chip = page.locator(`[data-testid="catalog-duplicate-${exactOneA.id}"]`)
  const chipText = ((await chip.textContent()) ?? '').trim()
  const chipAttributes = await chip.evaluate((node) => ({
    class: node.getAttribute('data-class'),
    basis: node.getAttribute('data-basis'),
    score: node.getAttribute('data-score'),
    title: node.getAttribute('title'),
  }))
  console.log(`stage 7b: the chip reads ${JSON.stringify(chipText)} with ${JSON.stringify(chipAttributes)}`)
  await assertEqual(chipText, `${DUPLICATE_CLASS_LABEL.exact} ${exactOneB.name}`, 'stage 7b: what the restored chip says')
  await assertEqual(
    { class: chipAttributes.class, basis: chipAttributes.basis },
    { class: 'exact', basis: 'content_hash' },
    'stage 7b: the raw class and basis, one attribute away',
  )
  await assertEqual(
    await prisma.templateDuplicate.count({ where: { id: dismissTarget.id, dismissedAt: null } }),
    1,
    'stage 7b: the restored pair in the database',
  )
  console.log('stage 7b PASSED: a dismissed pair shows no chip and reads as `no signal`; a restored one says what it is again')

  // ============================================================================================
  // Stage 9: the Catalog tab pages, counts and filters -- in the browser.
  // ============================================================================================

  const total = await prisma.slaveTemplate.count()
  await openCatalog('')
  const firstPage = await rowIds()
  const firstCount = await countText()
  console.log(`stage 9: the unfiltered first page holds ${String(firstPage.length)} row(s) and reads ${JSON.stringify(firstCount)}`)
  await assertEqual(firstPage.length, 100, 'stage 9: rows on the first page of a catalog bigger than one page')
  await assertEqual(firstCount, `showing 100 of ${plural(total, 'template')}`, 'stage 9: the count sentence while the page is not the whole answer')
  const everyRow = await loadEveryPage(total, 'stage 9')
  console.log(`stage 9: after Show more, ${String(everyRow.length)} row(s) are on screen and the count reads ${JSON.stringify(await countText())}`)
  await assertEqual(everyRow.length, total, 'stage 9: rows on screen after Show more')
  await assertEqual(await countText(), plural(total, 'template'), 'stage 9: the count sentence once the page IS the whole answer')

  // The capability facet: a taxonomy KEY as the value and a LABEL as the text, two different
  // strings, and it narrows to the one row that provides it (erratum E1; this stage is the coverage
  // `gate:m46-workforce-catalog`'s own comment cites for the facet it had to give up).
  await openCatalog('')
  const capabilityOption = await page
    .locator(`[data-testid="catalog-capability-select"] option[value="${manifest.soloCapabilityKey}"]`)
    .evaluate((node) => ({ value: node.getAttribute('value'), text: (node.textContent ?? '').trim() }))
  console.log(`stage 9: the capability option is ${JSON.stringify(capabilityOption)}`)
  await assertEqual(capabilityOption.value, manifest.soloCapabilityKey, "stage 9: the capability option's VALUE")
  await assertEqual(capabilityOption.text, manifest.soloCapabilityLabel, "stage 9: the capability option's TEXT")
  if (capabilityOption.value === capabilityOption.text) {
    await fail('stage 9: the capability option prints its own key -- the value and the text are the same string')
  }
  await page.getByTestId('catalog-capability-select').selectOption(manifest.soloCapabilityKey)
  await waitUntil('stage 9: the capability filter to leave the solo specialist alone', ACTION_TIMEOUT_MS, async () => {
    const ids = await rowIds()
    return ids.length === 1 && ids[0] === solo.id ? { done: true, value: ids } : { done: false, detail: `rows ${JSON.stringify(ids)}` }
  })
  console.log(`stage 9: the capability ${manifest.soloCapabilityKey} leaves ${await countText()} and the URL is ${page.url()}`)
  if (!page.url().includes(`capability=${encodeURIComponent(manifest.soloCapabilityKey)}`)) {
    await fail(`stage 9: the URL does not carry the capability: ${page.url()}`)
  }

  // The skill facet, the division facet, the source chips, the activation chips and the duplicates
  // select, each asserted against the answer the DATABASE gives for the same filter -- and each
  // with a NAMED row in it, so none of them can pass by leaving the list empty.
  const skillRow = await rowFor(manifest.skillSlug)
  await openCatalog('')
  await page.getByTestId('catalog-skill-select').selectOption(manifest.skill)
  await waitUntil('stage 9: the skill filter to leave one row', ACTION_TIMEOUT_MS, async () => {
    const ids = await rowIds()
    return ids.length === 1 && ids[0] === skillRow.id ? { done: true, value: ids } : { done: false, detail: `rows ${JSON.stringify(ids)}` }
  })
  if (!page.url().includes(`skill=${encodeURIComponent(manifest.skill)}`)) await fail(`stage 9: the URL does not carry the skill: ${page.url()}`)
  console.log(`stage 9: the skill ${JSON.stringify(manifest.skill)} leaves ${await countText()}`)

  const securityIds = (
    await prisma.slaveTemplate.findMany({ where: { sourceDivision: 'security' }, select: { id: true }, orderBy: { name: 'asc' } })
  ).map((row) => row.id)
  await openCatalog('division=security')
  const divisionRows = await loadEveryPage(securityIds.length, 'stage 9 (division)')
  await assertEqual(divisionRows.sort(), [...securityIds].sort(), 'stage 9: the rows the security division leaves')
  const nameOneB = await rowFor(manifest.exact[2][1])
  if (!divisionRows.includes(nameOneB.id)) await fail('stage 9: the division filter lost a row this catalog filed under security')

  await openCatalog(`q=${SEED}&source=local`)
  await assertEqual(await rowIds(), [], 'stage 9: generated rows under the `local` source chip')
  await waitVisible(page.getByTestId('catalog-empty'), 'the empty state under the local chip')
  await openCatalog(`q=${SEED}&source=imported`)
  await assertEqual(await countText(), `showing 100 of ${plural(120, 'template')}`, 'stage 9: the count under the `imported` source chip')
  // A CLICK, not only a URL: the chip has to write its own param.
  await page.getByTestId('catalog-source-chip-imported').click()
  await waitUntil('stage 9: the source chip to clear its own param', ACTION_TIMEOUT_MS, async () =>
    page.url().includes('source=') ? { done: false, detail: page.url() } : { done: true, value: page.url() },
  )
  await page.getByTestId('catalog-source-chip-local').click()
  await waitUntil('stage 9: the source chip to write `source=local`', ACTION_TIMEOUT_MS, async () =>
    page.url().includes('source=local') ? { done: true, value: page.url() } : { done: false, detail: page.url() },
  )
  console.log(`stage 9: the source chips write and clear their own param (${page.url()})`)

  await openCatalog(`q=${SEED}&active=active`)
  await assertEqual(await rowIds(), [], 'stage 9: generated rows under the `active` activation chip')
  await openCatalog(`q=${SEED}&active=inactive`)
  await assertEqual(await countText(), `showing 100 of ${plural(120, 'template')}`, 'stage 9: the count under the `inactive` activation chip')
  await page.getByTestId('catalog-active-chip-active').click()
  await waitUntil('stage 9: the activation chip to write `active=active`', ACTION_TIMEOUT_MS, async () =>
    page.url().includes('active=active') ? { done: true, value: page.url() } : { done: false, detail: page.url() },
  )

  /** The template ids of one planted class, from the manifest. */
  const idsOfPlanted = async (pairsOfClass) => {
    const ids = []
    for (const pair of pairsOfClass) for (const slug of pair) ids.push((await rowFor(slug)).id)
    return ids.sort()
  }
  const exactIds = await idsOfPlanted(manifest.exact)
  const nearIds = await idsOfPlanted(manifest.near)
  const overlappingIds = await idsOfPlanted(manifest.overlapping)
  const plantedIds = [...exactIds, ...nearIds, ...overlappingIds]
  for (const [facet, wanted] of [['exact', exactIds], ['near', nearIds], ['overlapping', overlappingIds]]) {
    const url = await openCatalog(`q=${SEED}&duplicates=${facet}`)
    const ids = (await rowIds()).sort()
    console.log(`stage 9: duplicates=${facet} leaves ${String(ids.length)} row(s); ${await countText()}`)
    await assertEqual(ids, wanted, `stage 9: the templates the \`${facet}\` facet leaves`)
    // A shared link is a real link: the same URL, loaded again, renders the same rows.
    await gotoReliably(url)
    await waitVisible(page.getByTestId('catalog-count'), 'the reloaded count')
    await waitHydrated()
    await assertEqual((await rowIds()).sort(), wanted, `stage 9: the same URL reloaded under \`${facet}\``)
  }
  await openCatalog(`q=${SEED}&duplicates=none`)
  const noneTotal = 120 - plantedIds.length
  await assertEqual(await countText(), `showing 100 of ${plural(noneTotal, 'template')}`, 'stage 9: the count under the `no signal` facet')
  const noneIds = await loadEveryPage(noneTotal, 'stage 9 (no signal)')
  const leaked = noneIds.filter((id) => plantedIds.includes(id))
  await assertEqual(leaked, [], 'stage 9: planted pair members that the `no signal` facet still shows')
  console.log(`stage 9: the nine pairs cover ${String(plantedIds.length)} rows and the other ${String(noneIds.length)} read as no signal`)

  // A word that is in a SUMMARY and nowhere else, and one that is in an IDENTITY and nowhere else
  // -- neither is in a name, so neither could be found by the migration's own name-and-description
  // floor. The first is typed into the box, so the 250 ms debounce is exercised rather than skipped.
  const summaryRow = await rowFor(manifest.summarySlug)
  const identityRow = await rowFor(manifest.identitySlug)
  await openCatalog('')
  await page.getByTestId('catalog-search').fill(manifest.summaryMarker)
  await delay(SEARCH_DEBOUNCE_MS)
  await waitUntil(`stage 9: the search for ${JSON.stringify(manifest.summaryMarker)} to narrow to one row`, ACTION_TIMEOUT_MS, async () => {
    const ids = await rowIds()
    return ids.length === 1 && ids[0] === summaryRow.id ? { done: true, value: ids } : { done: false, detail: `rows ${JSON.stringify(ids)}` }
  })
  if (!page.url().includes(`q=${manifest.summaryMarker}`)) await fail(`stage 9: the URL does not carry the search: ${page.url()}`)
  console.log(`stage 9: typing ${JSON.stringify(manifest.summaryMarker)} finds ${summaryRow.name} by its SUMMARY alone`)
  await openCatalog(`q=${manifest.identityMarker}`)
  await assertEqual(await rowIds(), [identityRow.id], `stage 9: the row the identity word ${JSON.stringify(manifest.identityMarker)} finds`)
  console.log(
    'stage 9 PASSED: two full pages and a Show more that completes the count sentence, six facets that each narrow the ' +
      'list and each write their own param, a reload that renders the same rows, and a search that reaches the spec',
  )

  // ============================================================================================
  // Stage 10: words, never keys.
  // ============================================================================================

  await openCatalog(`q=${SEED}&duplicates=exact`)
  await waitVisible(page.locator(`[data-testid="catalog-duplicate-${exactOneA.id}"]`), 'a duplicate chip to read')

  /** Every string this milestone's own controls put on screen, scoped by testid rather than by
   *  reading the whole page: `Name` is a column header M46 wrote and half the persona summaries in
   *  this fixture contain the word `record`. E16's rule -- assert on what this milestone drew. */
  const visibleStrings = async () =>
    await page.evaluate(() => {
      const out = []
      const push = (node) => {
        if (node !== null) out.push((node.textContent ?? '').trim())
      }
      for (const selector of [
        '[data-testid^="catalog-duplicate-"]',
        '[data-testid^="catalog-activate-"]',
        '[data-testid^="catalog-active-chip-"]',
        '[data-testid^="catalog-source-chip-"]',
        '[data-testid="catalog-duplicates-select"] option',
        '[data-testid="catalog-imports"] [data-testid="data-table-header-cell"]',
        '[data-testid="catalog-imports"] [data-testid="catalog-import-count"]',
        '[data-testid="details-group"][data-group="duplicates"] *',
      ]) {
        for (const node of document.querySelectorAll(selector)) push(node)
      }
      return out
    })

  const beforeDrawer = await visibleStrings()
  const offenders = (strings) => strings.filter((text) => RAW_TOKENS.includes(text.toLowerCase()))
  console.log(`stage 10: ${String(beforeDrawer.length)} string(s) read with the drawer closed; offenders ${JSON.stringify(offenders(beforeDrawer))}`)
  await assertEqual(offenders(beforeDrawer), [], 'stage 10: raw members printed as a control\'s whole visible text, drawer closed')

  // The raw values ARE there, one attribute away -- asserted present, so "no raw text" cannot be
  // passing because there is nothing to print.
  const chipAgain = await page.locator(`[data-testid="catalog-duplicate-${exactOneA.id}"]`).evaluate((node) => ({
    class: node.getAttribute('data-class'),
    basis: node.getAttribute('data-basis'),
    score: node.getAttribute('data-score'),
    title: node.getAttribute('title'),
  }))
  console.log(`stage 10: the chip's attributes are ${JSON.stringify(chipAgain)}`)
  await assertEqual(
    { class: chipAgain.class, basis: chipAgain.basis, score: chipAgain.score },
    { class: 'exact', basis: 'content_hash', score: '1' },
    'stage 10: the raw class, basis and score on the chip',
  )
  if (!(chipAgain.title ?? '').includes('evidence is recorded per profile, so two rows split their own record.')) {
    await fail(`stage 10: the chip's title does not carry R9's sentence: ${JSON.stringify(chipAgain.title)}`)
  }
  if (!(chipAgain.title ?? '').includes(DUPLICATE_BASIS_LABEL.content_hash)) {
    await fail(`stage 10: the chip's title does not carry the basis LABEL: ${JSON.stringify(chipAgain.title)}`)
  }
  const activateAttributes = await page.locator(`[data-testid="catalog-activate-${exactOneA.id}"]`).evaluate((node) => ({
    active: node.getAttribute('data-active'),
    text: (node.textContent ?? '').trim(),
  }))
  console.log(`stage 10: the activation control reads ${JSON.stringify(activateAttributes)}`)
  await assertEqual(activateAttributes, { active: 'false', text: 'inactive' }, 'stage 10: the activation control, word on screen and boolean on the attribute')
  const facetOptions = await page
    .locator('[data-testid="catalog-duplicates-select"] option')
    .evaluateAll((nodes) => nodes.map((node) => [node.getAttribute('value'), (node.textContent ?? '').trim()]))
  console.log(`stage 10: the duplicates select offers ${JSON.stringify(facetOptions)}`)
  await assertEqual(
    facetOptions,
    [['', 'any'], ...DUPLICATE_FACETS.map((facet) => [facet, DUPLICATE_FACET_LABEL[facet]])],
    'stage 10: the duplicates select\'s five options, value and text',
  )

  // The drawer, open: the fourteenth group and its rows.
  await page.getByTestId(`catalog-open-${exactOneA.id}`).click()
  await waitVisible(page.locator('[data-testid="details-group"][data-group="duplicates"]'), "the drawer's Duplicates group")
  await waitVisible(page.locator(`[data-testid="profile-duplicate-${dismissTarget.id}"]`), 'the pair inside the drawer')
  const withDrawer = await visibleStrings()
  console.log(`stage 10: ${String(withDrawer.length)} string(s) read with the drawer open; offenders ${JSON.stringify(offenders(withDrawer))}`)
  await assertEqual(offenders(withDrawer), [], 'stage 10: raw members printed as visible text, drawer open')
  const drawerRow = await page.locator(`[data-testid="profile-duplicate-${dismissTarget.id}"]`).evaluate((node) => ({
    class: node.getAttribute('data-class'),
    basis: node.getAttribute('data-basis'),
    score: node.getAttribute('data-score'),
    text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }))
  console.log(`stage 10: the drawer's pair row reads ${JSON.stringify(drawerRow)}`)
  await assertEqual(
    { class: drawerRow.class, basis: drawerRow.basis },
    { class: 'exact', basis: 'content_hash' },
    'stage 10: the raw class and basis on the drawer row',
  )
  if (!drawerRow.text.includes(DUPLICATE_CLASS_LABEL.exact) || !drawerRow.text.includes(DUPLICATE_BASIS_LABEL.content_hash)) {
    await fail(`stage 10: the drawer row does not print the class and basis LABELS: ${JSON.stringify(drawerRow.text)}`)
  }
  await page.keyboard.press('Escape')

  // And the one function §4 says this milestone may not touch, asserted FROM the module.
  await assertEqual(profileKeyOf({ slaveId: 's1', hiredFromTemplateId: 't1' }), 'template:t1', 'stage 10: profileKeyOf for a hired worker')
  await assertEqual(profileKeyOf({ slaveId: 's1', hiredFromTemplateId: null }), 'slave:s1', 'stage 10: profileKeyOf for a bespoke worker')
  console.log(
    'stage 10 PASSED: nothing this milestone drew prints a raw member as its own words, every raw value is one ' +
      'attribute away, and evidence still keys on the profile it always did',
  )

  // ============================================================================================
  // Stage 4c: the toggle in the browser makes exactly one more row rankable.
  // ============================================================================================

  await openCatalog(`skill=${encodeURIComponent(manifest.skill)}`)
  await assertEqual(await rowIds(), [skillRow.id], 'stage 4c: the row the toggle is about')
  const toggle = page.getByTestId(`catalog-activate-${skillRow.id}`)
  await assertEqual(await toggle.getAttribute('data-active'), 'false', 'stage 4c: the row before the click')
  await assertEqual(((await toggle.textContent()) ?? '').trim(), 'inactive', 'stage 4c: the WORD on the control before the click')
  await toggle.click()
  await waitUntil('stage 4c: the toggle to reach the database', ACTION_TIMEOUT_MS, async () => {
    const row = await prisma.slaveTemplate.findUnique({ where: { id: skillRow.id }, select: { active: true } })
    return row?.active === true ? { done: true, value: row } : { done: false, detail: `active ${String(row?.active)}` }
  })
  await waitUntil('stage 4c: the row to say so', ACTION_TIMEOUT_MS, async () => {
    const attribute = await toggle.getAttribute('data-active')
    return attribute === 'true' ? { done: true, value: attribute } : { done: false, detail: `data-active ${String(attribute)}` }
  })
  await assertEqual(((await toggle.textContent()) ?? '').trim(), 'active', 'stage 4c: the WORD on the control after the click')
  await assertEqual(await page.getByTestId('catalog-error').count(), 0, 'stage 4c: the refusal band after a write that was not refused')
  const toggled = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: skillRow.id } })
  console.log(
    `stage 4c: ${toggled.name} reads active=${String(toggled.active)}, activationChangedAt=${String(toggled.activationChangedAt?.toISOString())}, ` +
      `activationChangedBy=${JSON.stringify(toggled.activationChangedBy)}`,
  )
  if (toggled.activationChangedAt === null) await fail('stage 4c: the click recorded no activationChangedAt')
  await assertEqual(
    await prisma.slaveTemplate.count({ where: { sourceId: { startsWith: `${CATALOG_NAME}/` }, active: true } }),
    1,
    'stage 4c: hirable rows under this catalog after one click',
  )
  console.log('stage 4c PASSED: a click in a real browser reaches the same column the CLI writes, and exactly one row moved')

  // ============================================================================================
  // Stage 4d: `--activate` on a THIRD catalog creates its rows active -- and prints its rows.
  // ============================================================================================

  const activeImport = runCliOk(['import-catalog', '--dir', activeCatalog.dir, '--by', 'gate', '--activate', '--verbose'])
  console.log(`stage 4d -- the --activate --verbose import printed:\n${activeImport.split('\n').slice(0, 6).join('\n')}`)
  const activeCreatedLines = activeImport.match(/^ {2}created {2}/gm) ?? []
  await assertEqual(activeCreatedLines.length, 120, 'stage 4d: per-row `created` lines under --verbose (stage 1 counted zero without it)')
  if (!activeImport.includes(`${ACTIVE_CATALOG_NAME} (${activeCatalog.dir}): created 120, updated 0, unchanged 0, skipped 0`)) {
    await fail('stage 4d: the third catalog did not create 120 rows')
  }
  const activeRowsAfter = await catalogTemplates(ACTIVE_CATALOG_NAME)
  await assertEqual(activeRowsAfter.length, 120, 'stage 4d: rows under the third catalog')
  await assertEqual(activeRowsAfter.filter((row) => !row.active).map((row) => row.sourceId), [], 'stage 4d: rows `--activate` failed to activate')
  await assertEqual(
    activeRowsAfter.filter((row) => row.activationChangedAt !== null).map((row) => row.sourceId),
    [],
    'stage 4d: rows a creation stamped as a toggle (a creation is not somebody changing their mind)',
  )
  console.log('stage 4d PASSED: `--activate` creates a hirable row, `--verbose` prints one line per row, and the default prints none')

  // ============================================================================================
  // Stage 11: a checkout with no licence is refused, and the Source group says what a licensed one is.
  // ============================================================================================

  const before11 = {
    templates: await prisma.slaveTemplate.count(),
    imports: await prisma.catalogImport.count(),
    pairs: await prisma.templateDuplicate.count(),
  }
  const refused = runCli(['import-catalog', '--dir', unlicensed.dir, '--by', 'gate'])
  console.log(`stage 11 -- the unlicensed import exited ${String(refused.status)} saying: ${JSON.stringify(refused.stderr.trim())}`)
  if (refused.status === 0) await fail('stage 11: an unlicensed checkout was imported')
  const expectedRefusal = refusalText({ kind: 'license_unknown', directory: unlicensed.dir })
  if (!refused.stderr.includes(expectedRefusal)) {
    await fail(`stage 11: the refusal is not ${JSON.stringify(expectedRefusal)}`)
  }
  const after11 = {
    templates: await prisma.slaveTemplate.count(),
    imports: await prisma.catalogImport.count(),
    pairs: await prisma.templateDuplicate.count(),
  }
  await assertEqual(after11, before11, 'stage 11: the three tables either side of a refused import')

  const allowed = runCliOk(['import-catalog', '--dir', unlicensed.dir, '--by', 'gate', '--allow-unknown-license'])
  console.log(`stage 11 -- --allow-unknown-license printed:\n${allowed.split('\n').slice(0, 4).join('\n')}`)
  const unlicensedRows = await catalogTemplates(UNLICENSED_CATALOG_NAME)
  await assertEqual(unlicensedRows.length, 120, 'stage 11: rows imported once the operator said so')
  await assertEqual(
    [...new Set(unlicensedRows.map((row) => row.sourceLicense))],
    [null],
    'stage 11: the licence recorded on a checkout nothing could name one for',
  )
  const licensedRow = await prisma.slaveTemplate.findFirstOrThrow({ where: { sourceId: mainSourceId(manifest.summarySlug) } })
  await assertEqual(licensedRow.sourceLicense, 'MIT', 'stage 11: the licence recorded on the licensed catalog')

  // By NAME, not by the summary marker: the other two catalogs are imported by now and each holds
  // its own copy of that persona, so the marker reaches three rows and a name reaches one (the
  // generator writes the seed into every name it composes).
  await openCatalog(`q=${encodeURIComponent(summaryRow.name)}`)
  await assertEqual(await rowIds(), [summaryRow.id], 'stage 11: the licensed row the drawer opens on')
  await page.getByTestId(`catalog-open-${summaryRow.id}`).click()
  await waitVisible(page.locator('[data-testid="details-group"][data-group="source"]'), "the drawer's Source group")
  const sourceText = ((await page.locator('[data-testid="details-group"][data-group="source"]').textContent()) ?? '').replace(/\s+/g, ' ').trim()
  console.log(`stage 11: the Source group reads ${JSON.stringify(sourceText)}`)
  for (const needle of ['MIT', CATALOG_NAME, `${manifest.summarySlug}.md`]) {
    if (!sourceText.includes(needle)) await fail(`stage 11: the Source group does not carry ${JSON.stringify(needle)}`)
  }
  await page.keyboard.press('Escape')

  // The persona's own sentence is in the SERVED HTML and in no bundle: it came out of the database
  // at request time, which is R8's whole reason there is nothing to attribute in this repository.
  const sentence = `Holds the ${manifest.summaryMarker} of the release and says what it cost.`
  const served = await fetch(`${baseUrl}/workforce?tab=catalog&q=${manifest.summaryMarker}`).then((response) => response.text())
  console.log(`stage 11: the served HTML is ${String(served.length)} bytes and ${served.includes(sentence) ? 'carries' : 'does NOT carry'} the persona's sentence`)
  if (!served.includes(sentence)) await fail(`stage 11: the served page does not contain ${JSON.stringify(sentence)}`)
  if (!existsSync(NEXT_STATIC)) await fail(`stage 11: there is no ${NEXT_STATIC} to grep -- the dev server built nothing`)
  const grep = spawnSync('grep', ['-rl', '--', manifest.summaryMarker, NEXT_STATIC], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  console.log(`stage 11: grep over ${NEXT_STATIC} exited ${String(grep.status)} with ${JSON.stringify(grep.stdout.trim())}`)
  if (grep.status === 0) {
    await fail(`stage 11: a persona's own word is in the client bundle: ${grep.stdout.trim()}`)
  }
  console.log(
    'stage 11 PASSED: an unlicensed checkout is refused before a row is read, all three tables counted either side; the ' +
      'same command with --allow-unknown-license imports it with no licence recorded; and not one persona byte is in a bundle',
  )

  // ============================================================================================
  // Stage 12: nothing else moved.
  // ============================================================================================

  await assertEqual(SITUATION_KINDS.length, 17, 'stage 12: how many situation kinds the Supervisor knows')
  await assertEqual(ACTION_KINDS.length, 17, 'stage 12: how many action kinds the Supervisor knows')
  await assertEqual(Object.keys(LANE_BY_TYPE).length, 61, 'stage 12: how many event types the timeline lanes cover (this milestone added none)')
  const { world } = await loadSupervisorWorld(inertWorkspaceId, new Date())
  await assertEqual(Object.keys(world).sort(), SUPERVISOR_WORLD_KEYS, 'stage 12: the fields a loaded SupervisorWorld carries')
  const columnsOf = async (table) =>
    (
      await prisma.$queryRaw`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = ${table}
        order by column_name`
    ).map((row) => row.column_name)
  await assertEqual(await columnsOf('Task'), TASK_COLUMNS, "stage 12: Task's columns")
  await assertEqual(await columnsOf('Workspace'), WORKSPACE_COLUMNS, "stage 12: Workspace's columns")
  const actor = (await prisma.$queryRaw`select unnest(enum_range(NULL::"Actor"))::text as member`).map((row) => row.member)
  await assertEqual(actor, ACTOR_MEMBERS, 'stage 12: the Actor enum')
  await assertEqual(gitStatus(), gitStatusBefore, 'stage 12: git status --porcelain after this gate, against before it')
  console.log(
    'stage 12 PASSED: seventeen situations, seventeen actions, sixty-one lanes, a world with the same twenty fields, no ' +
      'new column on Task or Workspace, three actors, and a working tree exactly as this gate found it',
  )

  // ============================================================================================
  // The last thing measured: this gate left NOTHING in the operator's own state root (M52 C1).
  // ============================================================================================
  const operatorRunDirsAfter = operatorRunDirs()
  const leakedRunDirs = operatorRunDirsAfter.filter((name) => !operatorRunDirsBefore.includes(name))
  console.log(
    `operator state root: ${operatorRunsDir} holds ${String(operatorRunDirsAfter.length)} run director(ies) after this ` +
      `gate (${String(operatorRunDirsBefore.length)} before)`,
  )
  if (leakedRunDirs.length > 0) {
    await fail(
      `this gate left ${String(leakedRunDirs.length)} run director(ies) in the operator's own state root ${operatorRunsDir}: ` +
        `${JSON.stringify(leakedRunDirs.slice(0, 10))}`,
    )
  }
  console.log(`gotoReliably retries this run: ${String(gotoRetries.length)}${gotoRetries.length === 0 ? '' : ` (${JSON.stringify(gotoRetries)})`}`)
  console.log(`PASS: ${PASS_LINE}`)
  exitCode = 0
} finally {
  // ============================================================================================
  // Teardown, in FK order, and every process this gate started.
  // ============================================================================================
  for (const state of daemons) {
    if (state.exited) continue
    state.proc.kill('SIGTERM')
    const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (!state.exited && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
    if (!state.exited) state.proc.kill('SIGKILL')
  }
  if (browser !== null) await browser.close().catch(() => {})
  if (nextServer !== null && nextServer.exitCode === null) {
    nextServer.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextServer.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextServer.exitCode === null) nextServer.kill('SIGKILL')
  }
  for (const id of workspaceIds) await removeWorkspace(id)
  await deleteGateTemplates('teardown')
  await prisma.catalogImport.deleteMany({ where: { catalog: { in: CATALOG_NAMES } } }).catch(() => {})
  for (const path of repoPaths) rmSync(path, { recursive: true, force: true })
  if (catalogRoot !== null) rmSync(catalogRoot, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
