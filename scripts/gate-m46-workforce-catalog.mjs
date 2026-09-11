// M46's own gate (spec R7): a persona file becomes a SPECIALIST PROFILE, an operator's
// customisation outlives the next import, and the catalog is a surface you can actually work in.
//
// Seven stages, each measuring one rule the milestone claims:
//   1. The checked-in fixture catalog is copied into a temp GIT REPOSITORY and imported through
//      the real CLI. Every persona's profileSpec is asserted field by field, its mappingQuality is
//      full / partial / none as its shape deserves, its source record carries the repository, the
//      path, the temp repo's own HEAD and MIT off the LICENSE file -- and the stored Markdown is
//      byte-equal to renderProfileSpec(effectiveProfileSpec(spec, overrides)) and inside the cap.
//   2. In a real browser: the catalog searches, the capability filter and the source filter narrow
//      it, and the URL carries what was chosen.
//   3. A row's drawer shows the fourteen groups with their fields, and the raw Markdown is
//      reachable ONLY under Advanced.
//   4. One field is customised THROUGH THE UI: the override is stored, the Markdown is re-rendered
//      from it, and the row says so.
//   5. The upstream file is rewritten and re-imported: the customised field is still the
//      operator's, every other field moved with the file, and the report says `overrides kept 1`.
//   6. A raw Markdown override is set, the file is rewritten again, and THAT row is skipped
//      `locally_edited` while its neighbour updates -- the one thing that skip now means.
//   7. A company is built from two imported templates, assigned to a workspace, and a real daemon
//      dispatches one task with the fake CLI: the run's recorded RunContext carries the rendered
//      profile -- the prefix line, a mapped section heading, the operator's own sentence and a
//      sentence of the persona's own body -- with a `profile` source whose origin is `template`.
//   8. Teardown, in FK order, on every exit path.
//
// WHAT THE COUNTS ARE MEASURED AGAINST. This gate runs against a SEEDED database: `npm run db:seed`
// writes fifteen hand-made templates, and every one of them is a row in the same catalog. So no
// stage asserts an absolute "four templates on screen"; every browser assertion names the exact
// row ids this run created, and the negatives are made non-vacuous by their own positive
// counterpart in the same stage (the same search under `imported` shows four rows, under `local`
// shows none) rather than by an empty table.
//
// NEVER A MODEL CALL. The daemon is spawned with SLAVEOFAI_CLAUDE_BIN=node,
// SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m8a-flow" and SLAVEOFAI_REQUIRE_FAKE_CLI=1,
// and the browser half needs SLAVEOFAI_CLAUDE_BIN to name an executable under scripts/gate-fakes/
// or the preflight refuses to start at all.
//
// THE FIXTURE CATALOG IS COPIED TO A TEMP DIRECTORY AND `git init`ed THERE. The gate must never
// modify a file in this repository, and it must never run `git` against this repository either:
// `git status` after a green run has to be empty. The temp repo IS the point of stage 1:
// `revision` is null for a directory nobody has committed, so a gate that copied into a plain
// temp dir could not tell "no work tree" from "the walk never looked".
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: it boots its own `next dev`
// against `apps/web/.next` on a free port, and two of those corrupt the build cache for both.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m46-workforce-catalog
//
// Shape borrowed from `gate-m42-catalog-import.mjs` (the temp-repo copy, `preflightCleanup`,
// `dumpGateRows`, `fail`, teardown in FK order in a `finally`, `exitCode` starting at 1, the
// `m8a-flow` daemon wiring) and from `gate-m45-project-experience.mjs` (the free port, the real
// `next dev` under `loopbackChildEnv()`, the ready-wait that parses next's own bound-port line,
// `waitVisible`/`clickUntil`/`gotoReliably`, and the preflight refusal).

import { execFileSync, spawn } from 'node:child_process'
import { accessSync, appendFileSync, constants, cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids } from './lib/daemon-process.mjs'
import { prisma } from '../packages/db/dist/client.js'
import {
  MAPPING_QUALITY_LABEL,
  PROFILE_MAX_CHARS,
  effectiveProfileSpec,
  goalSha256,
  importedProfilePrefix,
  profileSpecSchema,
  renderProfileSpec,
  runContextManifestSchema,
} from '../packages/domain/dist/index.js'
import { isAlive } from '../packages/control/dist/index.js'

const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 100
const DAEMON_PERIOD_MS = 500
const DISPATCH_TIMEOUT_MS = 90_000
const RUN_TIMEOUT_MS = 180_000
/** `gate-m14-fidelity.mjs`'s own signature for next dev's torn `loadManifest` read. */
const MANIFEST_RACE_SIGNATURE = 'Unexpected end of JSON input'
const VIEWPORT = { width: 1440, height: 900 }

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

// Exact literals, never suffixed -- `preflightCleanup` removes whatever a prior crashed run left on
// these exact names, in the same FK order the `finally` block uses.
const CATALOG_NAME = 'catalog-m46'
const FIXTURE_CATALOG = join(repoRoot, 'scripts/fixtures', CATALOG_NAME)
const CORE_BUILDER = 'Gate Core Builder'
const STEWARD = 'Gate Release Steward'
const VERIFIER = 'Gate Verifier'
const NOTE_TAKER = 'Gate Note Taker'
const COMPANY_NAME = 'M46 Gate Company'
const WORKSPACE_NAME = 'M46 Gate Project'
const TASK_TITLE = 'M46 Workforce Catalog Gate Task'
/** Every template name this file writes. Addressed by name as well as by `sourceId` so a run
 *  interrupted before its own teardown leaves no row behind in a shared dev database. */
const GATE_TEMPLATE_NAMES = [CORE_BUILDER, STEWARD, VERIFIER, NOTE_TAKER]

// The operator's own words for stage 4, and the sentences stages 5 and 6 append upstream.
const CUSTOM_CONSTRAINT = 'You MUST ship a rollout behind a flag the gate can turn off'
const CORE_BUILDER_APPENDED = '- Read the brief back before you touch the keyboard'
const VERIFIER_APPENDED = '- Nothing is called done twice'
const STEWARD_APPENDED = '* Watch the first hour, not the first minute'
const RAW_OVERRIDE = 'This is what I want this worker to be, in my own words.'
/** A sentence only the persona FILE contains, on ONE line of it -- `body` keeps the persona's own
 *  line breaks, so a needle that spanned the wrap would never be found however right it read. */
const CORE_BUILDER_BODY_SENTENCE = 'the slave that writes the module everything else stands on'
/** The capability the facet menu offers that exactly one persona has. */
const CORE_BUILDER_CAPABILITY = 'Design the module boundary'

/** Asks the OS for a free TCP port. `next dev -p <port>` still auto-increments if something grabs
 *  it between this call and the spawn, so the ready-wait parses the ACTUAL bound port back out of
 *  next dev's own ready line. (`gate-m45-project-experience.mjs`, verbatim.) */
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

/** Same as `gate-m42-catalog-import.mjs`'s `makeRepo` -- a real repository, because the tick
 *  provisions a real worktree in it and the fake CLI commits into that worktree. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m46-repo-'))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/** Every file under `dir`, with its byte count -- printed so a failure can be read against what was
 *  actually on disk rather than against what the fixture is supposed to hold. */
function listTree(dir, prefix = '') {
  const out = []
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTree(full, `${prefix}${entry.name}/`))
    else out.push(`${prefix}${entry.name}  ${String(statSync(full).size)} bytes`)
  }
  return out
}

/** The templates this catalog owns, by `sourceId` -- never by name, which is exactly the thing an
 *  operator is free to change. */
const catalogTemplates = () =>
  prisma.slaveTemplate.findMany({ where: { sourceId: { startsWith: `${CATALOG_NAME}/` } }, orderBy: { sourceId: 'asc' } })

/** Every template this gate can have created: the imported ones, addressed by the `sourceId` prefix
 *  only this catalog writes, plus anything left on the four exact names. A `CompanySlave` holds a
 *  non-cascading reference, so the roster links go first. */
async function deleteGateTemplates(label) {
  const rows = await prisma.slaveTemplate.findMany({
    where: { OR: [{ sourceId: { startsWith: `${CATALOG_NAME}/` } }, { name: { in: GATE_TEMPLATE_NAMES } }] },
    select: { id: true, name: true },
  })
  if (rows.length === 0) return
  console.log(`${label}: removing ${String(rows.length)} gate template(s): ${JSON.stringify(rows.map((r) => r.name))}`)
  const ids = rows.map((r) => r.id)
  await prisma.companySlave.deleteMany({ where: { templateId: { in: ids } } }).catch(() => {})
  // M48: an import also writes a `RunbookTemplate` per persona workflow, and `sourceTemplateId` is
  // SetNull -- so a runbook whose template goes first can never be found again, and every run of
  // this gate left one more behind. Removed BEFORE the templates, in both the preflight and the
  // teardown (this function is what both call). A project that had adopted one keeps working: its
  // `Workspace.runbookId` is SetNull too.
  await prisma.runbookTemplate.deleteMany({ where: { sourceTemplateId: { in: ids } } }).catch(() => {})
  await prisma.slaveTemplate.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
}

/** Removes what a prior interrupted run left behind, in the same order the `finally` block uses:
 *  the workspace's events (no FK) then the workspace (cascades Team/Slave/Task/SlaveRun/RunContext),
 *  then the company (cascades CompanyTeam/CompanySlave), then the templates a CompanySlave used to
 *  point at, then this catalog's own import records. */
async function preflightCleanup() {
  const stale = await prisma.workspace.findUnique({ where: { name: WORKSPACE_NAME } })
  if (stale !== null) {
    console.log(`preflight: removing a leftover ${WORKSPACE_NAME} (${stale.id}) from an earlier interrupted run`)
    await prisma.executionEvent.deleteMany({ where: { workspaceId: stale.id } }).catch(() => {})
    await prisma.slaveMessage.deleteMany({ where: { workspaceId: stale.id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: stale.id } }).catch(() => {})
  }
  const staleCompany = await prisma.company.findUnique({ where: { name: COMPANY_NAME } })
  if (staleCompany !== null) {
    console.log(`preflight: removing a leftover ${COMPANY_NAME} (${staleCompany.id})`)
    await prisma.company.delete({ where: { id: staleCompany.id } }).catch(() => {})
  }
  await deleteGateTemplates('preflight')
  const staleImports = await prisma.catalogImport.deleteMany({ where: { catalog: CATALOG_NAME } })
  if (staleImports.count > 0) console.log(`preflight: removing ${String(staleImports.count)} leftover CatalogImport row(s)`)
}

let exitCode = 1
let nextServer = null
let nextOutput = ''
let browser = null
let page = null
let diagDir = null
let repoPath = null
let catalogRoot = null
let catalogDir = null
let scratchDir = null
let workspaceId = null
let companyId = null
/** Every daemon this gate has ever spawned, in order -- the `finally` block kills whichever of them
 *  is somehow still alive, not just the last one. */
const daemons = []
/** The browser console, newest last, for `fail()`'s dump. */
const browserConsole = []
/** Every URL `gotoReliably` retried, printed beside the PASS line so a rising rate is visible in
 *  GREEN runs too (`gate-m14-fidelity.mjs`'s accounting). */
const gotoRetries = []

/** Every row this gate could have written, for a FAIL's diagnostic dump. BigInt `seq` stringified. */
async function dumpGateRows() {
  const workspace =
    workspaceId === null
      ? null
      : await prisma.workspace
          .findUnique({
            where: { id: workspaceId },
            include: { tasks: true, teams: { include: { slaves: { include: { runs: { include: { context: true } } } } } } },
          })
          .catch(() => null)
  const templates = await prisma.slaveTemplate
    .findMany({ where: { OR: [{ sourceId: { startsWith: `${CATALOG_NAME}/` } }, { name: { in: GATE_TEMPLATE_NAMES } }] } })
    .catch(() => [])
  const imports = await prisma.catalogImport.findMany({ where: { catalog: CATALOG_NAME } }).catch(() => [])
  const daemonTails = daemons.map((d) => ({
    label: d.label,
    pid: d.proc.pid ?? null,
    exited: d.exited,
    output: d.output.length > 6_000 ? `…${d.output.slice(-6_000)}` : d.output,
  }))
  return JSON.stringify({ workspace, templates, imports, daemonTails }, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m46-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ============================================================================================
  // Stage 0: the preflight. Refusals, never fallbacks.
  // ============================================================================================

  // Zero spend, ENFORCED (Decision 10, M32 item 7). Stage 7 dispatches a real run through a real
  // daemon; without this refusal a lost fake binary would reach a vendor account instead.
  const fakeClaude = process.env['SLAVEOFAI_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'SLAVEOFAI_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m46-workforce-catalog',
    )
  }
  try {
    accessSync(fakeClaude, constants.X_OK)
  } catch {
    throw new Error(`SLAVEOFAI_CLAUDE_BIN=${fakeClaude} is not an executable file`)
  }
  // `startsWith(<repo>/scripts/gate-fakes)` rather than a bare `includes('gate-fakes')`: only a
  // fake in THIS repository counts.
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
      `no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m46-workforce-catalog passes ` +
        '--env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m46-workforce-catalog`')
  }
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI} -- run \`npx tsc --build\` first`)
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)
  if (!existsSync(FIXTURE_CATALOG)) throw new Error(`the fixture catalog is missing at ${FIXTURE_CATALOG}`)
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- stages 2 to 4 read a real rendered page, so set CHROMIUM_PATH to a ` +
        'real executable (e.g. a playwright-installed chromium under ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome).',
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
  // Refused rather than tolerated (`gate-m36-messaging.mjs`'s own refusal): another daemon would be
  // ticking this gate's workspace -- and every other one -- while it measures a single dispatch.
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m46-workforce-catalog REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate spawns its own and measures the one run it dispatches',
    )
  }
  console.log(`fake claude: ${fakeClaude}`)
  console.log(`chromium:    ${chromiumPath}`)

  await preflightCleanup()

  const childEnv = () =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8a-flow`,
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
    })

  /** Runs the real orchestrator CLI as a subprocess, exactly as an operator's shell would. */
  const runCli = (args) => {
    try {
      return execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
        cwd: repoRoot,
        env: childEnv(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw new Error(
        `the CLI refused \`${args.join(' ')}\` with status ${String(error.status)}\n` +
          `  stdout: ${String(error.stdout)}\n  stderr: ${String(error.stderr)}`,
      )
    }
  }

  /** The uuid a `create-*` verb prints, so the roster is built out of what the operator would read. */
  const createdId = (output, what) => {
    const match = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/.exec(output)
    if (match === null) throw new Error(`${what} printed no id: ${JSON.stringify(output)}`)
    return match[1]
  }

  /** The diagnostic throw: the state that made the call, not just the sentence that noticed. */
  async function fail(message) {
    let screenshotPath = null
    if (page !== null && diagDir !== null) {
      screenshotPath = join(diagDir, `failure-${String(Date.now())}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
    }
    const pageUrl = page === null ? '<no page>' : page.url()
    const dump = await dumpGateRows().catch(
      (cause) => `<could not dump gate rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
    )
    throw new Error(
      `${message}\n--- browser url ---\n${pageUrl}\n--- screenshot ---\n${screenshotPath ?? '<none>'}\n` +
        `--- browser console (tail) ---\n${browserConsole.slice(-40).join('\n')}\n--- gateRows ---\n${dump}`,
    )
  }

  /** `list.includes(needle)`, with the whole list in the failure message. */
  async function assertIncludes(list, needle, what) {
    console.log(`${what}: ${JSON.stringify(list)}`)
    if (!list.includes(needle)) await fail(`${what} does not carry ${JSON.stringify(needle)} -- it is ${JSON.stringify(list)}`)
  }

  /**
   * Polls `probe` until it returns true, or fails naming what it last saw. `probe` may return a
   * string, which is taken as the detail of an unsatisfied tick.
   * (`gate-m45-project-experience.mjs`'s `waitUntil`, with this gate's daemon-death check folded
   * in the way `gate-m42-catalog-import.mjs` does it.)
   */
  let activeDaemon = null
  async function waitUntil(probe, description, timeoutMs = ACTION_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs
    let lastDetail = '<never probed>'
    for (;;) {
      const seen = await probe().catch((cause) => `probe threw: ${cause instanceof Error ? cause.message : String(cause)}`)
      if (seen === true) return
      lastDetail = typeof seen === 'string' ? seen : '<not yet>'
      if (activeDaemon !== null && activeDaemon.exited) {
        await fail(`the ${activeDaemon.label} exited while waiting for ${description} -- last seen: ${lastDetail}`)
      }
      if (Date.now() > deadline) {
        await fail(`timed out after ${String(timeoutMs)}ms waiting for ${description} -- last seen: ${lastDetail}`)
      }
      await delay(POLL_INTERVAL_MS)
    }
  }

  // ============================================================================================
  // Stage 1: the fixture catalog, in a real git repository, through the real CLI.
  // ============================================================================================

  // The copy keeps the fixture's OWN directory name, because that name IS the catalog's name: with
  // no `--catalog`, the walk takes `basename(dir)` (M42 erratum E5), and that first segment is what
  // every `sourceId` and every `source.repository` asserted below is built from.
  catalogRoot = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m46-catalog-'))
  catalogDir = join(catalogRoot, CATALOG_NAME)
  cpSync(FIXTURE_CATALOG, catalogDir, { recursive: true })
  scratchDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m46-scratch-'))
  console.log(`catalog copied from ${FIXTURE_CATALOG} to ${catalogDir}:`)
  for (const line of listTree(catalogDir)) console.log(`  ${line}`)

  // `-c core.hooksPath= --no-verify` so a global git hook on the host cannot fail the fixture
  // commit; `-b main` so the branch name does not depend on the host's `init.defaultBranch`.
  execFileSync('git', ['init', '-q', '-b', 'main', catalogDir])
  execFileSync('git', ['-C', catalogDir, 'add', '-A'])
  execFileSync('git', [
    '-C', catalogDir,
    '-c', 'user.email=gate@example.invalid',
    '-c', 'user.name=Gate',
    '-c', 'core.hooksPath=',
    'commit', '-q', '--no-verify', '-m', 'fixture',
  ])
  const head = execFileSync('git', ['-C', catalogDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  console.log(`the temp catalog repository's HEAD: ${head}`)

  // What the browser stages measure their own counts against: this database is SEEDED.
  const baselineTotal = await prisma.slaveTemplate.count()
  console.log(`templates in the catalog before this import: ${String(baselineTotal)}`)

  const firstOutput = runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate'])
  console.log(`stage 1 -- import-catalog printed:\n${firstOutput}`)

  const byName = new Map((await catalogTemplates()).map((row) => [row.name, row]))
  if (byName.size !== 4) await fail(`stage 1: expected four templates, got ${String(byName.size)} (${JSON.stringify([...byName.keys()])})`)

  for (const [name, quality] of [
    [CORE_BUILDER, 'full'],
    [STEWARD, 'partial'],
    [VERIFIER, 'partial'],
    [NOTE_TAKER, 'none'],
  ]) {
    const row = byName.get(name)
    if (row === undefined) await fail(`stage 1: no template named ${JSON.stringify(name)} was created`)
    const parsed = profileSpecSchema.safeParse(row.profileSpec)
    if (!parsed.success) await fail(`stage 1: ${name} has no readable profileSpec: ${JSON.stringify(parsed.error?.issues)}`)
    console.log(
      `stage 1 -- ${name}: mappingQuality ${parsed.data.source.mappingQuality}, revision ${String(row.sourceRevision)}, ` +
        `licence ${String(row.sourceLicense)}, repository ${String(parsed.data.source.repository)}, path ${String(parsed.data.source.path)}, ` +
        `profile ${String(row.profile.length)} chars`,
    )
    if (parsed.data.source.mappingQuality !== quality) {
      await fail(`stage 1: ${name} mapped ${parsed.data.source.mappingQuality}, expected ${quality}`)
    }
    if (row.sourceRevision !== head) {
      await fail(`stage 1: ${name} recorded revision ${String(row.sourceRevision)}, expected the temp repo's HEAD ${head}`)
    }
    if (row.sourceLicense !== 'MIT') await fail(`stage 1: ${name} recorded licence ${String(row.sourceLicense)}, expected MIT`)
    if (parsed.data.source.revision !== head) {
      await fail(`stage 1: ${name}'s spec records revision ${String(parsed.data.source.revision)}, expected ${head}`)
    }
    if (parsed.data.source.license !== 'MIT') {
      await fail(`stage 1: ${name}'s spec records licence ${String(parsed.data.source.license)}, expected MIT`)
    }
    if (parsed.data.source.repository !== CATALOG_NAME) {
      await fail(`stage 1: ${name} recorded repository ${String(parsed.data.source.repository)}, expected ${CATALOG_NAME}`)
    }
    // The claim the whole milestone rests on: the Markdown a run gets is the render of the spec.
    const rendered = renderProfileSpec(effectiveProfileSpec(parsed.data, {}))
    if (row.profile !== rendered) {
      await fail(
        `stage 1: ${name}'s stored profile is not byte-equal to renderProfileSpec of its effective spec\n` +
          `  stored:   ${JSON.stringify(row.profile)}\n  rendered: ${JSON.stringify(rendered)}`,
      )
    }
    if (row.profile.length > PROFILE_MAX_CHARS) {
      await fail(`stage 1: ${name}'s profile is ${String(row.profile.length)} characters, over the ${String(PROFILE_MAX_CHARS)} cap`)
    }
  }

  const core = profileSpecSchema.parse(byName.get(CORE_BUILDER).profileSpec)
  await assertIncludes(core.constraints, 'You MUST never leave a red test behind', "stage 1: the core builder's constraints")
  await assertIncludes(core.operatingPrinciples, 'Green before anything', 'stage 1: its operating principles')
  await assertIncludes(core.capabilities, CORE_BUILDER_CAPABILITY, 'stage 1: its capabilities')
  await assertIncludes(core.deliverables, 'Module boundary note', 'stage 1: its deliverables')
  await assertIncludes(core.workflow, 'Step 1: read the brief back in your own words', 'stage 1: its workflow')
  await assertIncludes(core.successCriteria, 'Every commit green', 'stage 1: its success criteria')
  await assertIncludes(core.expertise, 'Ten years of code other people had to keep', 'stage 1: its expertise')
  await assertIncludes(core.recommendedSkills, 'writing-plans', 'stage 1: its recommended skills')
  if (core.runtimeRole !== 'engineering') await fail(`stage 1: its suggested runtime role is ${JSON.stringify(core.runtimeRole)}`)
  // R3's ignored key: `tools:` names base tools, not this catalog's skills.
  if (core.recommendedSkills.includes('Read')) await fail('stage 1: a base tool name reached recommendedSkills')
  // E21: the sections the mapper did NOT recognise are still the persona's, verbatim, in `body`.
  console.log(`stage 1 -- the core builder's unmapped remainder (${String(core.body.length)} chars):\n${core.body}`)
  if (!core.body.includes(CORE_BUILDER_BODY_SENTENCE)) {
    await fail('stage 1: the persona\'s own opening prose is not in the unmapped remainder')
  }
  if (!core.body.includes('## Your Communication Style')) {
    await fail('stage 1: a section the heading map does not know was thrown away rather than preserved (E21)')
  }
  if (core.body.includes('You MUST never leave a red test behind')) {
    await fail('stage 1: a MAPPED section was also left in the remainder, which would double it in every prompt')
  }

  const verifier = profileSpecSchema.parse(byName.get(VERIFIER).profileSpec)
  await assertIncludes(
    verifier.collaborationHints,
    'Gate Core Builder: They write the module and its tests; you run them against the brief.',
    "stage 1: the verifier's collaboration hints",
  )
  await assertIncludes(
    verifier.collaborationHints,
    'You MUST escalate to the Gate Release Steward before a second failing rollout',
    'stage 1: its loose escalation hint',
  )

  const noteTaker = profileSpecSchema.parse(byName.get(NOTE_TAKER).profileSpec)
  // The honest floor: a persona this mapper recognised nothing in is kept WHOLE rather than
  // reaching a model as a two-line worker.
  if (!noteTaker.body.includes('you answer with what the log says and nothing else')) {
    await fail("stage 1: the unmapped persona's own words are not in its profile at all")
  }

  const coreId = byName.get(CORE_BUILDER).id
  const stewardId = byName.get(STEWARD).id
  const verifierId = byName.get(VERIFIER).id
  const noteTakerId = byName.get(NOTE_TAKER).id
  const gateRowIds = [coreId, stewardId, verifierId, noteTakerId].slice().sort()
  console.log(
    'stage 1 complete: four persona files became four specialist profiles -- one mapped in full, two in part, one not at ' +
      'all -- each carrying the temp repository\'s own commit and the licence off its LICENSE file, and each one\'s stored ' +
      'Markdown byte-equal to a re-render of its own effective spec',
  )

  // ============================================================================================
  // The real web shell, on a free port, loopback-bound.
  // ============================================================================================

  const preferredPort = await findFreePort()
  nextServer = spawn(
    'node',
    ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort), '-H', '127.0.0.1'],
    // M21 A1: the operator's SLAVEOFAI_SESSION_SECRET must not reach the child, or every page is /login.
    { cwd: repoRoot, env: loopbackChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let nextExited = false
  let resolvedPort = null
  nextServer.stdout.on('data', (chunk) => {
    const textChunk = chunk.toString()
    nextOutput += textChunk
    process.stdout.write(`[next] ${textChunk}`)
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

  browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ viewport: VIEWPORT })
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  page.on('pageerror', (error) => {
    console.error(`[browser:pageerror] ${error}`)
    browserConsole.push(`[pageerror] ${String(error).slice(0, 300)}`)
  })
  page.on('console', (message) => browserConsole.push(`[${message.type()}] ${message.text().slice(0, 300)}`))
  page.on('requestfailed', (request) => browserConsole.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`))

  /** Bounded-waits for `locator` to become visible; a timeout routes through `fail`. */
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

  /** Clicks `locator`, then bounded-waits for `predicate`. It deliberately does NOT re-click on
   *  every tick -- a second click would send a second real request. */
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
        await delay(100)
      }
      if (clickError !== null) {
        await fail(`clicking ${description} failed: ${clickError instanceof Error ? clickError.message : String(clickError)}`)
      }
    }
    await fail(`clicking ${description} did not produce the expected result even after a retry click`)
  }

  /** Every catalog row on screen right now, as template ids. The seeded database means a count is
   *  never enough on its own: WHICH rows are listed is the assertion. */
  const rowIds = async () =>
    (
      await page.locator('[data-testid^="catalog-row-"]').evaluateAll((nodes) =>
        nodes.map((node) => (node.dataset['testid'] ?? node.getAttribute('data-testid') ?? '').replace('catalog-row-', '')),
      )
    ).sort()

  const countText = async () => (await page.getByTestId('catalog-count').textContent())?.trim() ?? ''

  // ============================================================================================
  // Stage 2: the catalog is a surface you can work in.
  // ============================================================================================

  await gotoReliably(`${baseUrl}/workforce?tab=catalog`)
  await waitVisible(page.getByTestId('workforce-catalog'), 'the workforce catalog')
  const allRows = await rowIds()
  console.log(`stage 2 -- the unfiltered catalog lists ${String(allRows.length)} row(s); ${await countText()}`)
  for (const id of gateRowIds) {
    if (!allRows.includes(id)) await fail(`stage 2: the imported template ${id} is not in the unfiltered catalog`)
  }
  if (allRows.length !== baselineTotal + 4) {
    await fail(`stage 2: the catalog lists ${String(allRows.length)} rows, expected the ${String(baselineTotal)} already there plus four`)
  }

  // 2a. search narrows to one row, and the URL says what was searched for.
  await page.getByTestId('catalog-search').fill('rollout')
  await waitUntil(
    async () => {
      const ids = await rowIds()
      return ids.length === 1 && ids[0] === stewardId ? true : `rows ${JSON.stringify(ids)}`
    },
    'the search for "rollout" to narrow to the release steward alone',
  )
  console.log(`stage 2a -- "rollout" leaves ${await countText()}, and the URL is ${page.url()}`)
  if (!page.url().includes('q=rollout')) await fail(`stage 2: the URL does not carry the search: ${page.url()}`)

  // 2b. the capability filter, off the facets the read model computed.
  await page.getByTestId('catalog-search').fill('')
  await waitUntil(async () => ((await rowIds()).length === baselineTotal + 4 ? true : `${String((await rowIds()).length)} rows`), 'the cleared search to put every row back')
  await page.getByTestId('catalog-capability-select').selectOption(CORE_BUILDER_CAPABILITY)
  await waitUntil(
    async () => {
      const ids = await rowIds()
      const text = await countText()
      return ids.length === 1 && ids[0] === coreId && text === '1 template' ? true : `rows ${JSON.stringify(ids)}, count ${JSON.stringify(text)}`
    },
    'the capability filter to leave the core builder alone',
  )
  console.log(`stage 2b -- the capability ${JSON.stringify(CORE_BUILDER_CAPABILITY)} leaves ${await countText()}`)

  // 2c. the source chips. The POSITIVE half first, so the empty half below cannot pass vacuously:
  // the same search under `imported` finds exactly the four rows this run created.
  await page.getByTestId('catalog-clear-filters').click()
  await waitUntil(async () => ((await rowIds()).length === baselineTotal + 4 ? true : `${String((await rowIds()).length)} rows`), 'Clear filters to put every row back')
  await page.getByTestId('catalog-source-chip-imported').click()
  await page.getByTestId('catalog-search').fill('Gate')
  await waitUntil(
    async () => {
      const ids = await rowIds()
      return JSON.stringify(ids) === JSON.stringify(gateRowIds) ? true : `rows ${JSON.stringify(ids)}`
    },
    'the imported source chip plus a search to leave exactly the four rows this run imported',
  )
  console.log(`stage 2c -- imported + "Gate" leaves ${await countText()}, which is exactly the four this run created`)
  await page.getByTestId('catalog-source-chip-local').click()
  await waitUntil(
    async () => {
      const ids = await rowIds()
      const empty = await page.getByTestId('catalog-empty').count()
      return ids.length === 0 && empty === 1 ? true : `rows ${JSON.stringify(ids)}, catalog-empty ${String(empty)}`
    },
    'the same search under the local chip to find nothing at all',
  )
  console.log(`stage 2c -- the same search under "local" finds nothing: ${JSON.stringify(await countText())}`)
  await page.getByTestId('catalog-clear-filters').click()
  await waitUntil(async () => ((await rowIds()).length === baselineTotal + 4 ? true : `${String((await rowIds()).length)} rows`), 'Clear filters to put every row back a second time')
  // The row says where it came from, and how well it was understood, without saying either raw.
  const coreRowSource = await page.getByTestId(`catalog-source-${coreId}`).textContent()
  const coreRowQuality = await page.getByTestId(`catalog-row-${coreId}`).getAttribute('data-mapping-quality')
  console.log(`stage 2 -- the core builder's row says source ${JSON.stringify(coreRowSource)}, data-mapping-quality ${JSON.stringify(coreRowQuality)}`)
  if ((coreRowSource ?? '') !== `imported · ${CATALOG_NAME}`) {
    await fail(`stage 2: the row's source cell reads ${JSON.stringify(coreRowSource)}, expected the repository it came from`)
  }
  if (coreRowQuality !== 'full') await fail(`stage 2: the row's data-mapping-quality is ${JSON.stringify(coreRowQuality)}, expected full`)
  console.log('stage 2 complete: the catalog searches, filters by capability and by source, and the URL carries what was chosen')

  // ============================================================================================
  // Stage 3: the drawer, and the raw Markdown ONLY under Advanced.
  // ============================================================================================

  await clickUntil(
    page.getByTestId(`catalog-open-${coreId}`),
    async () => page.getByTestId('profile-drawer').isVisible(),
    'the core builder row',
  )
  await waitVisible(page.getByTestId('profile-field-identity'), "the drawer's identity field")
  const groups = await page.getByTestId('details-group').evaluateAll((nodes) => nodes.map((node) => node.dataset['group']))
  console.log(`stage 3 -- the drawer's groups: ${groups.join(', ')}`)
  for (const group of [
    'identity',
    'mission',
    'capabilities',
    'expertise',
    'principles',
    'constraints',
    'workflow',
    'deliverables',
    'success',
    'collaboration',
    'skills',
    'source',
    'body',
    'advanced',
  ]) {
    if (!groups.includes(group)) await fail(`stage 3: the drawer has no ${group} group`)
  }
  // The source group renders the whole provenance record R4 owns.
  const sourceGroupText = (await page.locator('[data-testid="details-group"][data-group="source"]').textContent()) ?? ''
  console.log(`stage 3 -- the Source group reads: ${JSON.stringify(sourceGroupText.replace(/\s+/g, ' ').trim())}`)
  for (const needle of [CATALOG_NAME, 'engineering/gate-core-builder.md', head, 'MIT']) {
    if (!sourceGroupText.includes(needle)) await fail(`stage 3: the Source group does not carry ${JSON.stringify(needle)}`)
  }
  // M44 R5, on this surface: the WORD is the domain's own label, the raw token stays on an attribute.
  const qualityCell = page.locator('[data-testid="details-group"][data-group="source"] [data-mapping-quality]')
  const qualityWord = ((await qualityCell.textContent()) ?? '').trim()
  const qualityToken = await qualityCell.getAttribute('data-mapping-quality')
  console.log(`stage 3 -- the Source group says ${JSON.stringify(qualityWord)} with data-mapping-quality ${JSON.stringify(qualityToken)}`)
  if (qualityWord !== MAPPING_QUALITY_LABEL['full']) {
    await fail(`stage 3: the mapping quality reads ${JSON.stringify(qualityWord)}, expected the domain's own label ${JSON.stringify(MAPPING_QUALITY_LABEL['full'])}`)
  }
  if (qualityToken !== 'full') await fail(`stage 3: data-mapping-quality is ${JSON.stringify(qualityToken)}, expected full`)

  if ((await page.getByTestId('profile-markdown').count()) !== 0) {
    await fail('stage 3: the raw Markdown is on screen before Advanced was opened')
  }
  await clickUntil(
    page.locator('[data-testid="details-group"][data-group="advanced"] button').first(),
    async () => page.getByTestId('profile-markdown').isVisible(),
    "the drawer's Advanced disclosure",
  )
  const shown = (await page.getByTestId('profile-markdown').textContent()) ?? ''
  console.log(`stage 3 -- the Markdown under Advanced opens with: ${JSON.stringify(shown.slice(0, 160))}`)
  if (!shown.includes('## Constraints')) await fail('stage 3: the rendered Markdown under Advanced is not the profile')
  if (!shown.startsWith(importedProfilePrefix(`${CATALOG_NAME}/engineering/gate-core-builder`, byName.get(CORE_BUILDER).importedAt))) {
    await fail('stage 3: the Markdown under Advanced does not open with the line saying where this persona came from (R4)')
  }
  console.log('stage 3 complete: fourteen groups of structure, and the raw text reachable only under Advanced')

  // ============================================================================================
  // Stage 4: customise one field THROUGH THE UI, and read the database back.
  // ============================================================================================

  await page.getByTestId('profile-customise').click()
  await waitVisible(page.getByTestId('profile-field-input-constraints'), "the constraints field's editor")
  await page.getByTestId('profile-field-input-constraints').fill(CUSTOM_CONSTRAINT)
  await page.getByTestId('profile-field-save-constraints').click()
  await waitUntil(async () => {
    const row = await prisma.slaveTemplate.findUnique({ where: { id: coreId } })
    return row?.profileOverrides?.constraints?.[0] === CUSTOM_CONSTRAINT
      ? true
      : `profileOverrides ${JSON.stringify(row?.profileOverrides)}`
  }, 'the override to reach the database')
  const customised = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: coreId } })
  console.log(`stage 4 -- profileOverrides: ${JSON.stringify(customised.profileOverrides)}`)
  if (!customised.profile.includes(CUSTOM_CONSTRAINT)) await fail('stage 4: the Markdown was not re-rendered from the override')
  if (customised.profile.includes('never leave a red test behind')) {
    await fail('stage 4: the upstream constraint is still in the rendered Markdown')
  }
  if (profileSpecSchema.parse(customised.profileSpec).constraints[0] !== 'You MUST never leave a red test behind') {
    await fail('stage 4: the UPSTREAM half was written, which is the one thing it must never be')
  }
  await waitVisible(page.getByTestId(`catalog-overridden-${coreId}`), 'the customised marker on the row')
  console.log("stage 4 complete: one field customised in a real browser -- stored apart, re-rendered into the Markdown, and the upstream half untouched")

  // The browser has done its work. Stopped here rather than in the `finally` so the daemon in
  // stage 7 does not race a dev server for the machine while a dispatch is being timed.
  await browser.close().catch(() => {})
  browser = null
  page = null
  if (nextServer.exitCode === null) {
    nextServer.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextServer.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextServer.exitCode === null) nextServer.kill('SIGKILL')
  }
  console.log('the browser and the dev server are stopped; the rest of this gate is the CLI and a real daemon')

  // ============================================================================================
  // Stage 5: the file behind the customised row changes, and the customisation outlives it.
  // ============================================================================================

  appendFileSync(join(catalogDir, 'engineering', 'gate-core-builder.md'), `${CORE_BUILDER_APPENDED}\n`)
  const secondOutput = runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate'])
  console.log(`stage 5 -- the re-import printed:\n${secondOutput}`)
  if (!secondOutput.includes('overrides kept 1')) await fail('stage 5: the report does not say the override was kept')
  const after = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: coreId } })
  if (after.profileOverrides?.constraints?.[0] !== CUSTOM_CONSTRAINT) {
    await fail(`stage 5: the override did not survive the import: ${JSON.stringify(after.profileOverrides)}`)
  }
  if (!after.profile.includes(CUSTOM_CONSTRAINT)) await fail('stage 5: the re-rendered Markdown lost the override')
  const afterSpec = profileSpecSchema.parse(after.profileSpec)
  // The appended line sits under `## Your Advanced Capabilities`, which is where the heading map
  // sends it: the point is that a field NOBODY customised moved with the file in the same import
  // that left the customised one alone.
  await assertIncludes(afterSpec.capabilities, 'Read the brief back before you touch the keyboard', 'stage 5: the upstream capabilities')
  if (afterSpec.constraints[0] !== 'You MUST never leave a red test behind') {
    await fail('stage 5: the import wrote the operator\'s sentence into the UPSTREAM half')
  }
  if (after.profileSha256 !== goalSha256(after.profile)) {
    await fail('stage 5: the re-rendered profile was not re-stamped, so the next import would call this row locally edited')
  }
  console.log(
    'stage 5 complete: the file behind a customised row changed, every field nobody had touched moved with it, the operator\'s ' +
      'sentence is still theirs, and the report said so',
  )

  // ============================================================================================
  // Stage 6: a raw Markdown override, and the one thing `locally_edited` now means.
  // ============================================================================================

  const rawFile = join(scratchDir, 'raw-override.md')
  writeFileSync(rawFile, RAW_OVERRIDE)
  const setOutput = runCli(['set-profile', '--template', verifierId, '--file', rawFile, '--by', 'gate'])
  console.log(`stage 6 -- set-profile printed: ${JSON.stringify(setOutput.trim())}`)
  appendFileSync(join(catalogDir, 'testing', 'gate-verifier.md'), `${VERIFIER_APPENDED}\n`)
  appendFileSync(join(catalogDir, 'engineering', 'gate-release-steward.md'), `${STEWARD_APPENDED}\n`)
  const thirdOutput = runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate'])
  console.log(`stage 6 -- the third import printed:\n${thirdOutput}`)
  if (!thirdOutput.includes('locally_edited')) await fail('stage 6: the raw override was not skipped')
  const verifierRow = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: verifierId } })
  console.log(`stage 6 -- the verifier's profile is now ${JSON.stringify(verifierRow.profile)}`)
  if (verifierRow.profile !== RAW_OVERRIDE) await fail("stage 6: the operator's own words were overwritten")
  const stewardRow = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: stewardId } })
  if (!stewardRow.profile.includes('Watch the first hour')) {
    await fail('stage 6: the row beside it did not update in the same run')
  }
  if (!profileSpecSchema.parse(stewardRow.profileSpec).successCriteria.includes('Watch the first hour, not the first minute')) {
    await fail("stage 6: the neighbour's structure did not move with its file")
  }
  console.log(
    'stage 6 complete: a raw Markdown override stopped an import dead on its own row, and the row beside it updated in the ' +
      'same run',
  )

  // ============================================================================================
  // Stage 7: the specialist profile in front of the model.
  // ============================================================================================

  repoPath = makeRepo()
  companyId = createdId(runCli(['create-company', '--name', COMPANY_NAME]), 'create-company')
  const engineeringTeamId = createdId(runCli(['add-team', '--company', companyId, '--name', 'Engineering']), 'add-team')
  const coreSlaveId = createdId(
    runCli(['add-slave', '--team', engineeringTeamId, '--template', coreId, '--name', 'Core']),
    'add-slave',
  )
  // The SECOND worker is the testing persona, not the other engineering one: two workers holding
  // the same runtime role would make "the run landed on the core builder" a coin toss rather than
  // an assertion.
  const testingTeamId = createdId(runCli(['add-team', '--company', companyId, '--name', 'Testing']), 'add-team')
  const noteSlaveId = createdId(
    runCli(['add-slave', '--team', testingTeamId, '--template', noteTakerId, '--name', 'Notes']),
    'add-slave',
  )
  console.log(`company ${companyId}: roster members ${coreSlaveId} (Core) and ${noteSlaveId} (Notes)`)

  workspaceId = createdId(
    runCli(['create-workspace', '--name', WORKSPACE_NAME, '--repo', repoPath, '--verify', 'true', '--provider', 'claude_code']),
    'create-workspace',
  )
  console.log(`workspace ${workspaceId} (${WORKSPACE_NAME}), repo ${repoPath}`)
  console.log(`assign-company printed: ${JSON.stringify(runCli(['assign-company', '--workspace', workspaceId, '--company', companyId]).trim())}`)

  const workers = await prisma.slave.findMany({ where: { team: { workspaceId } }, orderBy: { name: 'asc' } })
  for (const worker of workers) {
    console.log(`  worker ${worker.id} ${JSON.stringify(worker.name)}: role ${JSON.stringify(worker.role)}, runtimeRoles ${JSON.stringify(worker.runtimeRoles)}`)
  }
  if (workers.length !== 2) await fail(`stage 7: the assignment materialised ${String(workers.length)} worker(s), expected 2`)
  const coreWorker = workers.find((worker) => worker.name === 'Core')
  if (coreWorker === undefined) await fail(`stage 7: the materialised workers are ${JSON.stringify(workers.map((w) => w.name))}`)

  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: TASK_TITLE,
      description: 'Synthetic task driven by scripts/gate-m46-workforce-catalog.mjs.',
      status: 'ready',
      requiredRole: 'engineering',
      maxAttempts: 5,
    },
  })
  console.log(`task ${task.id} (ready, engineering)`)

  const daemon = (() => {
    const proc = spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspaceId, '--period', String(DAEMON_PERIOD_MS)], {
      cwd: repoRoot,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const state = { label: 'daemon', proc, output: '', exited: false }
    proc.stdout.on('data', (chunk) => {
      state.output += chunk.toString()
      process.stdout.write(`[daemon] ${chunk}`)
    })
    proc.stderr.on('data', (chunk) => {
      state.output += chunk.toString()
      process.stderr.write(`[daemon] ${chunk}`)
    })
    proc.on('exit', (code, signal) => {
      state.exited = true
      state.output += `\n<daemon exited: code=${String(code)} signal=${String(signal)}>\n`
    })
    proc.on('error', (error) => {
      state.exited = true
      state.output += `\n<daemon failed to start: ${String(error)}>\n`
    })
    daemons.push(state)
    activeDaemon = state
    console.log(`daemon spawned as pid ${String(proc.pid)}`)
    return state
  })()

  let startedRun = null
  await waitUntil(
    async () => {
      startedRun = await prisma.slaveRun.findFirst({ where: { taskId: task.id } })
      return startedRun === null ? 'no SlaveRun row yet' : true
    },
    'the daemon to start a run for the task',
    DISPATCH_TIMEOUT_MS,
  )
  console.log(`run ${startedRun.id} started (${startedRun.status}, kind ${startedRun.kind}) on slave ${startedRun.slaveId}`)
  if (startedRun.slaveId !== coreWorker.id) {
    await fail(`stage 7: the run was staffed onto ${startedRun.slaveId}, expected the worker made from the core builder template (${coreWorker.id})`)
  }

  let runContext = null
  await waitUntil(
    async () => {
      runContext = await prisma.runContext.findUnique({ where: { runId: startedRun.id } })
      return runContext === null ? 'no RunContext row yet' : true
    },
    'the run to record what it was told',
    DISPATCH_TIMEOUT_MS,
  )
  const manifest = runContextManifestSchema.parse(runContext.sections)
  console.log(`manifest: ${JSON.stringify(manifest)}`)
  console.log(`prompt (${String(runContext.prompt.length)} chars):\n${runContext.prompt}`)

  const profileSource = manifest.sections.find((section) => section.kind === 'profile')
  console.log(`manifest profile source: ${JSON.stringify(profileSource)}`)
  if (profileSource === undefined) await fail('stage 7: the manifest records no profile section')
  if (profileSource.origin !== 'template') {
    await fail(`stage 7: the profile section's origin is ${String(profileSource.origin)}, expected template`)
  }
  // The prefix line R4 owns, a heading only the RENDERER produces, the sentence only the OPERATOR
  // wrote and a sentence only the persona FILE has -- the four together are what "the specialist
  // profile is in front of the model" means.
  for (const needle of [
    `Imported from ${CATALOG_NAME}/engineering/gate-core-builder on `,
    '## Constraints',
    CUSTOM_CONSTRAINT,
    CORE_BUILDER_BODY_SENTENCE,
  ]) {
    console.log(`stage 7 -- the prompt must carry ${JSON.stringify(needle)}`)
    if (!runContext.prompt.includes(needle)) await fail(`stage 7: the prompt does not carry ${JSON.stringify(needle)}`)
  }
  if (runContext.prompt.includes('You MUST never leave a red test behind')) {
    await fail("stage 7: the prompt carries the UPSTREAM constraint the operator replaced")
  }

  // Teardown hygiene, not a claim of this milestone: tearing down mid-replay kills a live vendor
  // child and leaves the next tick a run that looks failed.
  await waitUntil(
    async () => {
      const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: startedRun.id } })
      return run.endedAt === null ? `run is ${run.status}` : true
    },
    'the run to conclude',
    RUN_TIMEOUT_MS,
  )

  if (daemon.proc.exitCode === null && !daemon.exited) {
    daemon.proc.kill('SIGTERM')
    const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (!daemon.exited && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
    if (!daemon.exited) daemon.proc.kill('SIGKILL')
  }
  activeDaemon = null
  const strayAfter = findRealDaemonPids()
  console.log(`orchestrator daemons still running after the stop: ${JSON.stringify(strayAfter)}`)
  if (strayAfter.length > 0) await fail(`stage 7: the gate's daemon is still running (pid ${strayAfter.join(', ')})`)

  console.log(
    'stage 7 complete: a company built from two imported templates staffed a project, and the run a real daemon dispatched ' +
      "was given the rendered specialist profile -- the line saying where it came from, a heading the renderer wrote, the " +
      "operator's own sentence and the persona's own words",
  )

  console.log(`gotoReliably retries this run: ${String(gotoRetries.length)}${gotoRetries.length === 0 ? '' : ` (${JSON.stringify(gotoRetries)})`}`)
  console.log(
    'PASS: a persona file is structure rather than prose -- mapped in full, in part or not at all and honest about which, ' +
      'customisable a field at a time in a real browser, and still the operator\'s after the file behind it changes',
  )
  exitCode = 0
} finally {
  // The vendor children and the processes first, then the rows they are named on.
  for (const state of daemons) {
    if (state.proc.exitCode === null && !state.exited) {
      state.proc.kill('SIGTERM')
      const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
      while (!state.exited && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
      if (!state.exited) state.proc.kill('SIGKILL')
    }
  }
  if (browser !== null) await browser.close().catch(() => {})
  if (nextServer !== null && nextServer.exitCode === null) {
    nextServer.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextServer.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextServer.exitCode === null) nextServer.kill('SIGKILL')
  }
  if (workspaceId !== null) {
    // Vendor children BEFORE the rows they are named on, `gate-m13-runtime`'s rule.
    const runs = await prisma.slaveRun.findMany({ where: { slave: { team: { workspaceId } } }, select: { pid: true } }).catch(() => [])
    for (const run of runs) {
      if (run.pid === null || !isAlive(run.pid)) continue
      try {
        process.kill(run.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    // `ExecutionEvent` has no FK to `Workspace` (M2's append-only log outlives entity lifecycles by
    // design), so it goes explicitly first; the workspace delete then cascades Team/Slave/Task/
    // SlaveRun/RunContext.
    await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.slaveMessage.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  // The org rows belong to no workspace, so nothing above cascaded them: the company takes its
  // teams and roster members with it, and the catalog templates go last because a CompanySlave
  // holds a non-cascading reference to them.
  if (companyId !== null) await prisma.company.delete({ where: { id: companyId } }).catch(() => {})
  await deleteGateTemplates('teardown').catch(() => {})
  await prisma.catalogImport.deleteMany({ where: { catalog: CATALOG_NAME } }).catch(() => {})
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  if (catalogRoot !== null) rmSync(catalogRoot, { recursive: true, force: true })
  if (scratchDir !== null) rmSync(scratchDir, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
