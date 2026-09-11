// M48's own gate (spec R8): work is handed over with a CONTRACT rather than a paragraph, and a
// project follows a process somebody chose. One story, proved end to end against a real daemon, the
// real CLI and a real browser.
//
// Eight stages, each measuring one rule the milestone claims:
//   1. Runbooks are DATA. `runbooks sync` through the real CLI fills the table, a second run
//      changes nothing, `runbooks show` prints a runbook's stages in order with the verify stage's
//      own retry cap and escalation sentence, and `runbooks add --file` writes an operator's own
//      runbook that the next sync leaves exactly as it is.
//   2. A persona's own process becomes a runbook nobody typed. The fixture catalog is imported
//      through the real CLI out of a real git checkout: the persona with a three-step Workflow
//      Process becomes `persona-gate-flow-reviewer`, three stages, pointing back at the template it
//      was translated from -- and the persona with no workflow section becomes NOTHING, which is
//      what makes the first a property of the file rather than of the import.
//   3. The Supervisor recommends and a HUMAN adopts. A one-worker project with a goal raises
//      `runbook_recommended`, whose first offer is `adopt_runbook` on `feature-delivery`, proposed
//      and pending, with nothing adopted while it waits. A real `approve-decision` subprocess -- a
//      person -- sets `Workspace.runbookId` and appends exactly one `workspace.runbook_adopted`.
//   4. The plan is written AGAINST it. One hand `tick`'s manager is answered from
//      `plan-graph-runbook`: three tasks land carrying a stage, a parsed handoff and the verify
//      stage's own retry cap instead of the workspace's, and `workspace.plan_created.runbook`
//      names the two stages the plan skipped.
//   5. The contract reaches the WORKER and the REVIEWER. `show-context` for the work run prints a
//      manifest with a `handoff` entry whose sha is over the contract (and differs from the task
//      section's, which is over the title and description), and `--prompt` shows the HANDOFF
//      heading with the objective and both acceptance criteria. The review run's context carries
//      one too.
//   6. A stage GATE is real. The `implement` stage carries `gates: ["true"]` on the first project
//      -- the verify log names `stage "implement" gate` and the task passes, twice over, because a
//      clean merge re-verifies the rebased tree -- and `gates: ["false"]` on a SECOND project,
//      where `task.verify_failed` carries `stage: "implement"` and the log file names the stage.
//      `runbook-status` prints where the work is and what each stage's state is.
//   7. In a real BROWSER: the Overview's runbook panel names the runbook, the stage the work is on
//      and every stage's state in words -- including the one the plan never covered -- with each
//      stage's capabilities marked covered or not by the people actually here; the Workforce page's
//      Runbooks tab lists the seed runbooks, the persona one and the operator's own, and the
//      persona row's drawer names the specialist it was translated from; and the task drawer shows
//      the stage and the contract the task was created with.
//   8. Teardown, in FK order, on every exit path.
//
// NEVER A MODEL CALL. The daemons and the CLI are spawned with SLAVEOFAI_CLAUDE_BIN=node,
// SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m8-flow --plan-fixture plan-graph-runbook" and
// SLAVEOFAI_REQUIRE_FAKE_CLI=1; the browser half needs SLAVEOFAI_CLAUDE_BIN to name an executable
// under scripts/gate-fakes/ or the preflight refuses to start at all.
//
// THE FIXTURE CATALOG IS COPIED TO A TEMP DIRECTORY AND `git init`ed THERE, like m46's and m47's:
// this gate must never modify a file in this repository, and `git status` after a green run has to
// be empty.
//
// WHY THE DAEMONS RUN FIRST AND THE BROWSER LAST (m47's own order): stage 7 photographs a board
// three tasks have already been carried across, so the rows have to exist before the page is
// opened. Every daemon is stopped -- and its absence re-checked with `findRealDaemonPids()` --
// before `next dev` is spawned, so the two never race the machine.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: it boots its own `next dev`
// against `apps/web/.next` on a free port, and two of those corrupt the build cache for both.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m48-runbooks
//
// Shape borrowed from `gate-m47-team-formation.mjs` in full: the temp-repo copy of the fixture
// catalog, `preflightCleanup`, `dumpGateRows`, `fail`, `waitUntil`, `waitVisible`, `gotoReliably`,
// the free port plus a real `next dev` under `loopbackChildEnv()`, the ready-wait on next's own
// bound-port line, the browser preflight refusal, `exitCode` starting at 1 and teardown in FK order
// in a `finally`; `clickUntil` from `gate-m45-project-experience.mjs`.

import { execFileSync, spawn } from 'node:child_process'
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids } from './lib/daemon-process.mjs'
import { prisma } from '../packages/db/dist/client.js'
import { RUNBOOK_SEED } from '../packages/db/dist/runbooks.js'
import { isAlive } from '../packages/control/dist/index.js'

const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 100
const DAEMON_PERIOD_MS = 500
const SUPERVISOR_TIMEOUT_MS = 180_000
/** Three tasks, each of them worked, verified, reviewed and merged by a real daemon. Generous
 *  because the machine is also running a Postgres every other gate shares. */
const BOARD_TIMEOUT_MS = 600_000
const VERIFY_TIMEOUT_MS = 240_000
/** `gate-m14-fidelity.mjs`'s own signature for next dev's torn `loadManifest` read. */
const MANIFEST_RACE_SIGNATURE = 'Unexpected end of JSON input'
const VIEWPORT = { width: 1440, height: 900 }

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

// Exact literals, never suffixed -- `preflightCleanup` removes whatever a prior crashed run left on
// these exact names, in the same FK order the `finally` block uses.
const CATALOG_NAME = 'catalog-m48'
const FIXTURE_CATALOG = join(repoRoot, 'scripts/fixtures', CATALOG_NAME)
const BUILDER = 'Gate Flow Builder'
const REVIEWER = 'Gate Flow Reviewer'
const GATE_TEMPLATE_NAMES = [BUILDER, REVIEWER]
const PERSONA_RUNBOOK_KEY = 'persona-gate-flow-reviewer'
const BUILDER_RUNBOOK_KEY = 'persona-gate-flow-builder'
const WORKSPACE_NAME = 'M48 Gate Project'
const GATE_WORKSPACE_2 = 'M48 Gate Gate Failure'
const WORKER_NAME = 'Dev'
const REVIEWER_NAME = 'Reader'
const GOAL = 'Ship the endpoint feature, with an authentication path somebody who does security has read.'
/** The runbook this project is recommended and adopts. Its five stages are the ones the plan
 *  fixture's three tasks are stamped with -- and the two it never covers. */
const ADOPTED_KEY = 'feature-delivery'
const ADOPTED_NAME = 'Feature delivery'
/** The stage whose gate this gate arms, on both projects. */
const GATED_STAGE = 'implement'
/**
 * The seed runbook stage 1 DELETES before it runs `runbooks sync`.
 *
 * Without it stage 1 could not measure anything: this gate runs against a seeded database where all
 * three seed runbooks are already present, so a first `sync` would report `0 added` exactly as the
 * second one does and "a second run changes nothing" would be vacuous. `bug-fix` is the one seed
 * runbook nothing else in this file mentions and whose keywords the goal does not contain, and
 * `sync` itself is what puts it back -- so a crash between the delete and the sync is repaired by
 * the very next run of this stage. (`gate-m47-team-formation.mjs`'s `SYNC_PROBE_KEY`.)
 */
const SYNC_PROBE_KEY = 'bug-fix'
/** The operator's own runbook: written through `runbooks add --file`, adopted by the SECOND
 *  project, and the row whose `implement` gate fails there. NO keywords, deliberately -- a
 *  hand-written runbook that matched the goal would compete with the recommendation stage 3
 *  measures. */
const HUMAN_RUNBOOK = {
  key: 'gate-stage-check',
  name: 'Gate stage check',
  description: "The gate's own runbook: three stages, one of which really runs a command.",
  keywords: [],
  requiredCapabilities: [],
  optionalCapabilities: [],
  stages: [
    {
      key: 'design',
      title: 'Design',
      objective: 'Decide the shape before anybody writes it.',
      capabilities: [],
      dependsOn: [],
      expectedOutputs: [],
      gates: [],
      retry: null,
      escalation: null,
    },
    {
      key: GATED_STAGE,
      title: 'Implement',
      objective: 'Build what the design decided, and nothing else.',
      capabilities: [],
      dependsOn: ['design'],
      expectedOutputs: [],
      // The whole point of the second project: a gate that says no.
      gates: ['false'],
      retry: null,
      escalation: null,
    },
    {
      key: 'verify',
      title: 'Verify',
      objective: 'Prove it does what it claims.',
      capabilities: [],
      dependsOn: [GATED_STAGE],
      expectedOutputs: [],
      gates: [],
      retry: null,
      escalation: null,
    },
  ],
}
/** The workspace's OWN verify command, deliberately spelt differently from either stage gate: a
 *  command that matched a gate by value would be attributed to the stage (M48 t3 deviation D6), and
 *  this gate's negative -- "a workspace command's log names no stage" -- would be vacuous. */
const WORKSPACE_VERIFY = 'echo m48-workspace-verify'
const SHAPE_TASK_TITLE = 'Decide the endpoint shape'
const BUILD_TASK_TITLE = 'Add authentication to the endpoint'
const PROVE_TASK_TITLE = 'Prove the endpoint refuses anonymous callers'
const FAILING_TASK_TITLE = 'M48 Gate Stage Gate Refusal'

/** Asks the OS for a free TCP port. (`gate-m47-team-formation.mjs`, verbatim.) */
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

/** A real repository, because the tick provisions a real worktree in it and the fake CLI commits
 *  into that worktree. (`gate-m47-team-formation.mjs`'s `makeRepo`.) */
function makeRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `slaveofai-gate-m48-${label}-`))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/** Every file under `dir`, with its byte count. (`gate-m47-team-formation.mjs`'s `listTree`.) */
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

/** A decision row as this gate prints it. (`gate-m38-supervisor.mjs`'s helper.) */
const describeDecision = (row) =>
  JSON.stringify({
    id: row.id,
    situationKind: row.situationKind,
    subjectId: row.subjectId,
    tier: row.tier,
    status: row.status,
    decidedBy: row.decidedBy,
    modelCalled: row.modelCalled,
    action: row.action,
  })

/** A task row as this gate prints it -- the three columns M48 writes, plus the state machine's. */
const describeTask = (row) =>
  `${row.title} [${row.status}] stage=${JSON.stringify(row.stage)} maxAttempts=${String(row.maxAttempts)} ` +
  `handoff=${row.handoff === null ? 'null' : 'set'} caps=${JSON.stringify(row.requiredCapabilities)}`

/** A runbook row as this gate prints it. */
const describeRunbook = (row) =>
  `${row.key} "${row.name}" source=${row.source} stages=${String(Array.isArray(row.stages) ? row.stages.length : -1)} ` +
  `fromTemplate=${String(row.sourceTemplateId)}`

/** The templates this catalog owns, by `sourceId` -- never by name. */
const catalogTemplates = () =>
  prisma.slaveTemplate.findMany({ where: { sourceId: { startsWith: `${CATALOG_NAME}/` } }, orderBy: { sourceId: 'asc' } })

/** Every template this gate can have created. A `CompanySlave` holds a non-cascading reference, so
 *  the roster links go first; a `RunbookTemplate` translated from one holds a `SetNull` reference,
 *  and those rows are deleted by name beside this rather than left dangling. */
async function deleteGateTemplates(label) {
  const rows = await prisma.slaveTemplate.findMany({
    where: { OR: [{ sourceId: { startsWith: `${CATALOG_NAME}/` } }, { name: { in: GATE_TEMPLATE_NAMES } }] },
    select: { id: true, name: true },
  })
  if (rows.length === 0) return
  console.log(`${label}: removing ${String(rows.length)} gate template(s): ${JSON.stringify(rows.map((r) => r.name))}`)
  const ids = rows.map((r) => r.id)
  await prisma.companySlave.deleteMany({ where: { templateId: { in: ids } } }).catch(() => {})
  await prisma.slaveTemplate.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
}

/** The runbook rows this gate can have written: the operator's own, the two a persona import of
 *  THIS catalog can produce. Deleted BEFORE the templates they point at, because
 *  `RunbookTemplate.sourceTemplateId` is `SetNull` and this gate owns both ends. */
async function deleteGateRunbooks(label) {
  const keys = [HUMAN_RUNBOOK.key, PERSONA_RUNBOOK_KEY, BUILDER_RUNBOOK_KEY]
  const removed = await prisma.runbookTemplate.deleteMany({ where: { key: { in: keys } } }).catch(() => ({ count: 0 }))
  if (removed.count > 0) console.log(`${label}: removing ${String(removed.count)} runbook(s) of this gate's own`)
}

/** Puts every seed runbook back exactly as the checked-in list has it.
 *
 *  Stage 6 arms a real gate on the adopted runbook's `implement` stage, which means WRITING to a
 *  `seed` row -- the only way to give the project that adopted `Feature delivery` a gate to run,
 *  and safe precisely because `syncRunbooks` owns those rows and rewrites them from this same list.
 *  Run in the preflight AND in the teardown, so a crashed run repairs itself on the next one. */
async function restoreSeedRunbooks(label) {
  let repaired = 0
  for (const seed of RUNBOOK_SEED) {
    const row = await prisma.runbookTemplate.findUnique({ where: { key: seed.key } }).catch(() => null)
    if (row === null) continue
    if (canonicalStages(row.stages) === canonicalStages(seed.stages)) continue
    await prisma.runbookTemplate.update({ where: { key: seed.key }, data: { stages: seed.stages } }).catch(() => {})
    repaired += 1
  }
  if (repaired > 0) console.log(`${label}: put ${String(repaired)} seed runbook(s) back to the checked-in list`)
}

/** A stage list as ONE string, field order fixed here -- `packages/control/src/runbook.ts`'s own
 *  `canonicalStages`, and for its own reason: Postgres stores a `jsonb` object with its OWN key
 *  order (shortest key first, then alphabetical), so `JSON.stringify` over a row that came back
 *  from the database never equals `JSON.stringify` over the checked-in literal, and a comparison
 *  written that way says "this row changed" about every row, forever. */
const canonicalStages = (stages) =>
  JSON.stringify(
    (Array.isArray(stages) ? stages : []).map((stage) => ({
      key: stage.key,
      title: stage.title,
      objective: stage.objective,
      capabilities: [...stage.capabilities],
      dependsOn: [...stage.dependsOn],
      expectedOutputs: [...stage.expectedOutputs],
      gates: [...stage.gates],
      retry: stage.retry === null ? null : { maxAttempts: stage.retry.maxAttempts },
      escalation: stage.escalation,
    })),
  )

/** Removes what a prior interrupted run left behind, in the same order the `finally` block uses. */
async function preflightCleanup() {
  for (const name of [WORKSPACE_NAME, GATE_WORKSPACE_2]) {
    const stale = await prisma.workspace.findUnique({ where: { name } })
    if (stale === null) continue
    console.log(`preflight: removing a leftover ${name} (${stale.id}) from an earlier interrupted run`)
    await prisma.executionEvent.deleteMany({ where: { workspaceId: stale.id } }).catch(() => {})
    await prisma.slaveMessage.deleteMany({ where: { workspaceId: stale.id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: stale.id } }).catch(() => {})
  }
  await deleteGateRunbooks('preflight')
  await deleteGateTemplates('preflight')
  const staleImports = await prisma.catalogImport.deleteMany({ where: { catalog: CATALOG_NAME } })
  if (staleImports.count > 0) console.log(`preflight: removing ${String(staleImports.count)} leftover CatalogImport row(s)`)
  // A persona runbook whose template is gone is a DANGLING row: `sourceTemplateId` is `SetNull`, so
  // every gate that imports a fixture catalog and then deletes its templates leaves one behind, and
  // nothing in the product can ever recreate or address it again. Stage 7 counts the rows a person
  // sees on the Workforce tab, so they are swept here -- rows whose template still exists (a real
  // import an operator made) are deliberately left exactly as they are.
  const orphans = await prisma.runbookTemplate.findMany({
    where: { source: 'persona', sourceTemplateId: null },
    select: { key: true },
  })
  if (orphans.length > 0) {
    console.log(`preflight: removing ${String(orphans.length)} orphaned persona runbook(s) ${JSON.stringify(orphans.map((r) => r.key))} -- their templates are gone`)
    await prisma.runbookTemplate.deleteMany({ where: { key: { in: orphans.map((r) => r.key) } } }).catch(() => {})
  }
  await restoreSeedRunbooks('preflight')
}

let exitCode = 1
let nextServer = null
let nextOutput = ''
let browser = null
let page = null
let diagDir = null
let repoPath = null
let repoPath2 = null
let catalogRoot = null
let catalogDir = null
let runbookFile = null
let workspaceId = null
let workspaceId2 = null
const daemons = []
const browserConsole = []
const gotoRetries = []

/** Every row this gate could have written, for a FAIL's diagnostic dump. BigInt `seq` stringified. */
async function dumpGateRows() {
  const workspaces = []
  for (const id of [workspaceId, workspaceId2]) {
    if (id === null) continue
    const row = await prisma.workspace
      .findUnique({
        where: { id },
        include: { tasks: true, teams: { include: { slaves: { include: { runs: true } } } }, supervisorDecisions: true },
      })
      .catch(() => null)
    workspaces.push(row)
  }
  const runbooks = await prisma.runbookTemplate.findMany({ orderBy: { key: 'asc' } }).catch(() => [])
  const templates = await prisma.slaveTemplate
    .findMany({ where: { OR: [{ sourceId: { startsWith: `${CATALOG_NAME}/` } }, { name: { in: GATE_TEMPLATE_NAMES } }] } })
    .catch(() => [])
  const daemonTails = daemons.map((d) => ({
    label: d.label,
    pid: d.proc.pid ?? null,
    exited: d.exited,
    output: d.output.length > 6_000 ? `…${d.output.slice(-6_000)}` : d.output,
  }))
  return JSON.stringify({ workspaces, runbooks, templates, daemonTails }, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m48-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ============================================================================================
  // Stage 0: the preflight. Refusals, never fallbacks.
  // ============================================================================================

  const fakeClaude = process.env['SLAVEOFAI_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'SLAVEOFAI_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m48-runbooks',
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
      `no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m48-runbooks passes ` +
        '--env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m48-runbooks`')
  }
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI} -- run \`npx tsc --build\` first`)
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)
  if (!existsSync(FIXTURE_CATALOG)) throw new Error(`the fixture catalog is missing at ${FIXTURE_CATALOG}`)
  if (!existsSync(join(repoRoot, 'packages/providers/test/fixtures/plan-graph-runbook.ndjson'))) {
    throw new Error('the plan fixture packages/providers/test/fixtures/plan-graph-runbook.ndjson is missing')
  }
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- stage 7 reads a real rendered page, so set CHROMIUM_PATH to a ` +
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
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m48-runbooks REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate spawns its own and measures the decisions it makes',
    )
  }
  console.log(`fake claude: ${fakeClaude}`)
  console.log(`chromium:    ${chromiumPath}`)

  await preflightCleanup()

  const childEnv = () =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      // The planning arm's answer is chosen on ARGV (M47 D7): `SLAVEOFAI_CLAUDE_ARGS` rides through
      // as `extraArgs` on every spawn, which is already how `--fixture` itself arrives.
      SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8-flow --plan-fixture plan-graph-runbook`,
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

  /** Deep equality over the plain JSON shapes this gate reads back, with BOTH values printed --
   *  a measured value in the log of a GREEN run is the point, not only of a red one. */
  async function assertEqual(actual, expected, what) {
    console.log(`${what}: ${JSON.stringify(actual)}`)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      await fail(`${what} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
    }
  }

  let activeDaemon = null

  /** Polls `probe` until it returns something truthy. (`gate-m47-team-formation.mjs`'s `waitUntil`.) */
  async function waitUntil(description, timeoutMs, probe) {
    const deadline = Date.now() + timeoutMs
    let lastSeen = '<nothing yet>'
    for (;;) {
      const result = await probe((seen) => {
        lastSeen = seen
      })
      if (result !== null && result !== undefined && result !== false) return result
      if (activeDaemon !== null && activeDaemon.exited) {
        await fail(`the ${activeDaemon.label} exited while waiting for ${description} -- last seen: ${lastSeen}`)
      }
      if (Date.now() >= deadline) {
        await fail(`timed out after ${String(timeoutMs)}ms waiting for ${description} -- last seen: ${lastSeen}`)
      }
      await delay(POLL_INTERVAL_MS)
    }
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
    console.log(`${label} spawned as pid ${String(proc.pid)}`)
    return state
  }

  /** Stops a daemon and waits for the process to really be gone. */
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

  /** Every task on the board, oldest first -- the order the plan created them in. */
  const board = () => prisma.task.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })

  // ============================================================================================
  // Stage 1: runbooks are DATA, and the CLI is how an operator touches them.
  // ============================================================================================

  const seedProbe = RUNBOOK_SEED.find((record) => record.key === SYNC_PROBE_KEY)
  if (seedProbe === undefined) await fail(`stage 1: ${SYNC_PROBE_KEY} is not in RUNBOOK_SEED any more -- pick another probe key`)
  const removed = await prisma.runbookTemplate.deleteMany({ where: { key: SYNC_PROBE_KEY } })
  console.log(`stage 1 -- removed ${String(removed.count)} row(s) for ${SYNC_PROBE_KEY} so \`sync\` has something to do`)

  const firstSync = runCli(['runbooks', 'sync'])
  console.log(`stage 1 -- \`runbooks sync\` printed: ${JSON.stringify(firstSync.trim())}`)
  if (!firstSync.includes('1 added')) {
    await fail(`stage 1: the first sync reported ${JSON.stringify(firstSync.trim())}, expected 1 added`)
  }
  const restored = await prisma.runbookTemplate.findUnique({ where: { key: SYNC_PROBE_KEY } })
  console.log(`stage 1 -- ${SYNC_PROBE_KEY} after the sync: ${restored === null ? 'null' : describeRunbook(restored)}`)
  if (restored === null) await fail(`stage 1: \`runbooks sync\` did not put ${SYNC_PROBE_KEY} back`)
  if (restored.name !== seedProbe.name || restored.source !== 'seed') {
    await fail(`stage 1: ${SYNC_PROBE_KEY} came back as ${describeRunbook(restored)}, expected the checked-in list's`)
  }
  await assertEqual(restored.stages.length, seedProbe.stages.length, `stage 1: ${SYNC_PROBE_KEY} came back with every stage`)

  // The non-vacuous negative: the SAME command, against a table that is now complete.
  const secondSync = runCli(['runbooks', 'sync'])
  console.log(`stage 1 -- the second \`runbooks sync\` printed: ${JSON.stringify(secondSync.trim())}`)
  if (!secondSync.includes('0 added') || !secondSync.includes('0 brought back')) {
    await fail(`stage 1: a second sync reported ${JSON.stringify(secondSync.trim())}, expected nothing to change`)
  }

  const shown = runCli(['runbooks', 'show', ADOPTED_KEY])
  console.log(`stage 1 -- \`runbooks show ${ADOPTED_KEY}\` printed:\n${shown}`)
  const shownLines = shown.split('\n')
  if (shownLines[0] !== `${ADOPTED_NAME} (${ADOPTED_KEY}, seed)`) {
    await fail(`stage 1: \`runbooks show\`'s first line is ${JSON.stringify(shownLines[0])}`)
  }
  const shownStageKeys = shownLines.filter((line) => /^ {2}[a-z]/.test(line)).map((line) => line.trim().split(':')[0])
  await assertEqual(shownStageKeys, ['design', 'implement', 'verify', 'review', 'release'], 'stage 1: the stages print in order')
  if (!shown.includes('    retry: 2 attempts')) {
    await fail("stage 1: `runbooks show` does not print the verify stage's own retry cap")
  }
  const seedVerify = RUNBOOK_SEED.find((r) => r.key === ADOPTED_KEY)?.stages.find((s) => s.key === 'verify')
  if (seedVerify?.escalation === undefined || seedVerify.escalation === null) {
    await fail('stage 1: the checked-in verify stage has no escalation sentence to look for')
  }
  if (!shown.includes(`    escalation: ${seedVerify.escalation}`)) {
    await fail("stage 1: `runbooks show` does not print the verify stage's escalation sentence")
  }

  runbookFile = join(diagDir, 'human-runbook.json')
  writeFileSync(runbookFile, `${JSON.stringify(HUMAN_RUNBOOK, null, 2)}\n`)
  const added = runCli(['runbooks', 'add', '--file', runbookFile, '--by', 'gate'])
  console.log(`stage 1 -- \`runbooks add --file\` printed: ${JSON.stringify(added.trim())}`)
  if (added.trim() !== `${HUMAN_RUNBOOK.key} added: ${String(HUMAN_RUNBOOK.stages.length)} stages, source human`) {
    await fail(`stage 1: \`runbooks add\` printed ${JSON.stringify(added.trim())}`)
  }
  const humanRow = await prisma.runbookTemplate.findUniqueOrThrow({ where: { key: HUMAN_RUNBOOK.key } })
  console.log(`stage 1 -- the operator's own runbook: ${describeRunbook(humanRow)}`)
  if (humanRow.source !== 'human') await fail(`stage 1: the operator's runbook is source ${humanRow.source}, expected human`)
  const humanStagesBefore = JSON.stringify(humanRow.stages)

  // A third sync, AFTER the operator's own row: a reconciliation must never rewrite it.
  const thirdSync = runCli(['runbooks', 'sync'])
  console.log(`stage 1 -- the sync after the operator's own runbook printed: ${JSON.stringify(thirdSync.trim())}`)
  const humanAfter = await prisma.runbookTemplate.findUnique({ where: { key: HUMAN_RUNBOOK.key } })
  if (humanAfter === null) await fail("stage 1: a sync deleted the operator's own runbook")
  if (humanAfter.source !== 'human' || JSON.stringify(humanAfter.stages) !== humanStagesBefore) {
    await fail(`stage 1: a sync rewrote the operator's own runbook: ${describeRunbook(humanAfter)}`)
  }

  const listed = runCli(['runbooks', 'list']).trim().split('\n')
  console.log(`stage 1 -- \`runbooks list\` printed ${String(listed.length)} line(s):\n  ${listed.join('\n  ')}`)
  const humanLine = listed.find((line) => line.startsWith(`${HUMAN_RUNBOOK.key}\t`))
  if (humanLine === undefined) await fail("stage 1: `runbooks list` does not carry the operator's own runbook")
  if (!humanLine.includes('\thuman\t') || !humanLine.includes('0 project(s)')) {
    await fail(`stage 1: the operator's row reads ${JSON.stringify(humanLine)}`)
  }
  console.log('stage 1 PASSED: runbooks are a table an operator fills, repairs, reads and extends through the CLI')

  // ============================================================================================
  // Stage 2: a persona's own process becomes a runbook nobody typed.
  // ============================================================================================

  // The copy keeps the fixture's OWN directory name, because that name IS the catalog's name (M42
  // erratum E5), and that first segment is what every `sourceId` asserted below is built from.
  catalogRoot = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m48-catalog-'))
  catalogDir = join(catalogRoot, CATALOG_NAME)
  cpSync(FIXTURE_CATALOG, catalogDir, { recursive: true })
  console.log(`catalog copied from ${FIXTURE_CATALOG} to ${catalogDir}:`)
  for (const line of listTree(catalogDir)) console.log(`  ${line}`)

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

  console.log(`stage 2 -- import-catalog printed:\n${runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate'])}`)

  const imported = await catalogTemplates()
  console.log(`stage 2 -- imported ${String(imported.length)} template(s): ${JSON.stringify(imported.map((row) => row.name))}`)
  if (imported.length !== 2) await fail(`stage 2: expected two templates, got ${String(imported.length)}`)
  const reviewerTemplate = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: REVIEWER } })
  const builderTemplate = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: BUILDER } })
  for (const row of [reviewerTemplate, builderTemplate]) {
    console.log(
      `stage 2 -- ${row.name}: role ${JSON.stringify(row.role)}, revision ${String(row.sourceRevision)}, ` +
        `licence ${String(row.sourceLicense)}, keys ${JSON.stringify(row.capabilityKeys)}`,
    )
    if (row.sourceRevision !== head) {
      await fail(`stage 2: ${row.name} recorded revision ${String(row.sourceRevision)}, expected the temp repo's HEAD ${head}`)
    }
    if (row.sourceLicense !== 'MIT') await fail(`stage 2: ${row.name} recorded licence ${String(row.sourceLicense)}, expected MIT`)
  }

  const personaRunbook = await prisma.runbookTemplate.findUnique({ where: { key: PERSONA_RUNBOOK_KEY } })
  console.log(`stage 2 -- the persona's runbook: ${personaRunbook === null ? 'none' : describeRunbook(personaRunbook)}`)
  if (personaRunbook === null) await fail(`stage 2: the import wrote no ${PERSONA_RUNBOOK_KEY}`)
  if (personaRunbook.source !== 'persona') await fail(`stage 2: it is source ${personaRunbook.source}, expected persona`)
  if (personaRunbook.sourceTemplateId !== reviewerTemplate.id) {
    await fail(`stage 2: it points at ${String(personaRunbook.sourceTemplateId)}, expected ${REVIEWER}'s template ${reviewerTemplate.id}`)
  }
  await assertEqual(
    personaRunbook.stages.map((stage) => stage.key),
    ['step-1', 'step-2', 'step-3'],
    "stage 2: the persona's three-step process is three stages",
  )
  await assertEqual(
    personaRunbook.stages.map((stage) => stage.title),
    [
      'Step 1: Follow the request from the edge to the check that actually decides',
      'Step 2: Write down who would attack this path, and how',
      'Step 3: Report each finding beside the line it is about',
    ],
    "stage 2: each stage is the persona's own sentence",
  )
  // The negative that makes the positive a property of the FILE: the other persona in the same
  // catalog, imported in the same breath, has no workflow section and becomes no runbook.
  const builderRunbooks = await prisma.runbookTemplate.findMany({ where: { sourceTemplateId: builderTemplate.id } })
  console.log(`stage 2 -- runbooks translated from ${BUILDER}: ${JSON.stringify(builderRunbooks.map((r) => r.key))}`)
  if (builderRunbooks.length !== 0) await fail(`stage 2: ${BUILDER} has no process, and a runbook was written for it anyway`)
  if ((await prisma.runbookTemplate.count({ where: { key: BUILDER_RUNBOOK_KEY } })) !== 0) {
    await fail(`stage 2: ${BUILDER_RUNBOOK_KEY} exists`)
  }

  console.log(`stage 2 -- the second import printed:\n${runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate'])}`)
  const afterSecond = await prisma.runbookTemplate.findMany({ where: { source: 'persona' } })
  console.log(`stage 2 -- persona runbooks after a second import: ${JSON.stringify(afterSecond.map((r) => r.key))}`)
  if (afterSecond.length !== 1 || afterSecond[0].key !== PERSONA_RUNBOOK_KEY) {
    await fail(`stage 2: a second import did not update in place: ${JSON.stringify(afterSecond.map((r) => r.key))}`)
  }
  if ((await catalogTemplates()).length !== 2) await fail('stage 2: a second import doubled the templates')
  console.log(
    "stage 2 PASSED: the specialist's own three-step process is a runbook nobody typed, pointing back at the persona it came " +
      'from -- and the persona with no process produced none',
  )

  // ============================================================================================
  // Stage 3: the Supervisor RECOMMENDS, and a person ADOPTS.
  // ============================================================================================

  repoPath = makeRepo('repo')
  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath,
      baseBranch: 'main',
      // OFF, and the gate carries each finished branch across by hand with `confirm-integration`
      // -- which is exactly what an autoMerge-off project means (spec Decision 5) and what makes
      // the three-task chain move. It is also what keeps the fake CLI honest: its work body writes
      // one file whose contents are the first 80 characters of the prompt, so a task whose worktree
      // branched from a base a PREVIOUS task had already merged into would produce no diff to
      // commit at all. A gate must not depend on that coincidence.
      autoMerge: false,
      verifyCommands: [WORKSPACE_VERIFY],
      setupCommands: [],
      maxAttempts: 3,
    },
  })
  workspaceId = workspace.id
  console.log(`workspace ${workspaceId} (${WORKSPACE_NAME}), repo ${repoPath}, maxAttempts ${String(workspace.maxAttempts)}`)
  if (workspace.runbookId !== null) await fail('a new workspace starts already following a runbook')
  await prisma.providerConfiguration.create({ data: { workspaceId, kind: 'claude_code', settings: {} } })

  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  // The ONLY worker at this point: it PROVIDES `backend.api-design` and is dispatchable as backend
  // and manager. One worker is what makes stage 7's covered/uncovered capability chips a fact about
  // this project rather than a fixture.
  const dev = await prisma.slave.create({
    data: {
      teamId: team.id,
      name: WORKER_NAME,
      role: 'Senior Engineer',
      runtimeRoles: ['backend', 'manager'],
      capabilities: ['backend.api-design'],
    },
  })
  const devId = dev.id
  console.log(`slave ${devId} (${WORKER_NAME}): runtimeRoles ${JSON.stringify(dev.runtimeRoles)}, capabilities ${JSON.stringify(dev.capabilities)}`)

  console.log(`stage 3 -- set-goal printed: ${JSON.stringify(runCli(['set-goal', '--workspace', workspaceId, '--goal', GOAL]).trim())}`)

  // A supervised pass by hand, BEFORE any tick: `runbook_recommended` fires only while the board is
  // still empty and no runbook is adopted, which is the one moment at which choosing a way of
  // working changes what the next run is asked for.
  console.log(`stage 3 -- supervise printed:\n${runCli(['supervise', '--workspace', workspaceId])}`)
  const decision = await prisma.supervisorDecision.findFirst({
    where: { workspaceId, situationKind: 'runbook_recommended' },
    orderBy: { createdAt: 'asc' },
  })
  if (decision === null) await fail('stage 3: the Supervisor raised no runbook_recommended situation')
  console.log(`stage 3 -- the decision: ${describeDecision(decision)}`)
  console.log(`stage 3 -- the situation it was made about: ${JSON.stringify(decision.situation)}`)
  if (decision.subjectId !== workspaceId) await fail(`stage 3: the situation is about ${decision.subjectId}, expected the project`)
  if (decision.status !== 'pending' || decision.tier !== 'proposed') {
    await fail(`stage 3: a way of working is a person's decision and must WAIT: ${describeDecision(decision)}`)
  }
  const firstOffer = decision.candidates[0]
  console.log(`stage 3 -- the first offer: ${JSON.stringify(firstOffer)}`)
  if (firstOffer?.action?.kind !== 'adopt_runbook') await fail(`stage 3: the first offer is ${String(firstOffer?.action?.kind)}`)
  if (firstOffer.action.key !== ADOPTED_KEY) await fail(`stage 3: the first offer is ${String(firstOffer.action.key)}, expected ${ADOPTED_KEY}`)
  if (decision.action.kind !== 'adopt_runbook' || decision.action.key !== ADOPTED_KEY) {
    await fail(`stage 3: the chosen action is ${JSON.stringify(decision.action)}`)
  }
  if (!decision.action.rationale.includes('"feature"')) {
    await fail(`stage 3: the rationale does not name a word it matched in the goal: ${JSON.stringify(decision.action.rationale)}`)
  }
  // Nothing is adopted while it waits.
  const waiting = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { runbookId: true } })
  console.log(`stage 3 -- the project's runbookId while the proposal waits: ${String(waiting.runbookId)}`)
  if (waiting.runbookId !== null) await fail('stage 3: a runbook was adopted while the proposal was still pending')
  if ((await prisma.executionEvent.count({ where: { workspaceId, type: 'workspace_runbook_adopted' } })) !== 0) {
    await fail('stage 3: an adoption was logged before anybody answered the proposal')
  }

  // A person answers, with the operator's own verb, as a real subprocess.
  console.log(`stage 3 -- approve-decision printed: ${JSON.stringify(runCli(['approve-decision', '--id', decision.id]).trim())}`)
  const approved = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: decision.id } })
  console.log(`stage 3 -- the decision after approval: ${describeDecision(approved)}`)
  if (approved.status !== 'approved') await fail(`stage 3: the decision is ${approved.status}, expected approved`)

  const adoptedRunbook = await prisma.runbookTemplate.findUniqueOrThrow({ where: { key: ADOPTED_KEY } })
  const adoptedWorkspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { runbookId: true } })
  console.log(`stage 3 -- the project now follows ${String(adoptedWorkspace.runbookId)} (${ADOPTED_KEY} is ${adoptedRunbook.id})`)
  if (adoptedWorkspace.runbookId !== adoptedRunbook.id) {
    await fail(`stage 3: Workspace.runbookId is ${String(adoptedWorkspace.runbookId)}, expected ${adoptedRunbook.id}`)
  }
  const adoptedEvents = await prisma.executionEvent.findMany({
    where: { workspaceId, type: 'workspace_runbook_adopted' },
    orderBy: { seq: 'asc' },
  })
  console.log(`stage 3 -- workspace.runbook_adopted events: ${JSON.stringify(adoptedEvents.map((e) => e.payload))}`)
  if (adoptedEvents.length !== 1) await fail(`stage 3: ${String(adoptedEvents.length)} adoption events, expected exactly one`)
  if (adoptedEvents[0].payload.key !== ADOPTED_KEY || adoptedEvents[0].payload.name !== ADOPTED_NAME) {
    await fail(`stage 3: the event says ${JSON.stringify(adoptedEvents[0].payload)}`)
  }
  console.log('stage 3 PASSED: the Supervisor offered a way of working and waited, and a person is what adopted it')

  // ============================================================================================
  // Stage 4: the plan is written AGAINST the runbook.
  // ============================================================================================

  console.log(`stage 4 -- tick printed:\n${runCli(['tick', '--workspace', workspaceId])}`)
  const planned = await board()
  console.log(`stage 4 -- board (${String(planned.length)}):\n  ${planned.map(describeTask).join('\n  ')}`)
  if (planned.length !== 3) await fail(`stage 4: the plan produced ${String(planned.length)} tasks, expected 3`)

  const shapeTask = await prisma.task.findFirstOrThrow({ where: { workspaceId, title: SHAPE_TASK_TITLE } })
  const buildTask = await prisma.task.findFirstOrThrow({ where: { workspaceId, title: BUILD_TASK_TITLE } })
  const proveTask = await prisma.task.findFirstOrThrow({ where: { workspaceId, title: PROVE_TASK_TITLE } })
  await assertEqual(
    [shapeTask.stage, buildTask.stage, proveTask.stage],
    ['design', GATED_STAGE, 'verify'],
    'stage 4: every task carries the stage the plan gave it',
  )
  console.log(`stage 4 -- the build task's handoff: ${JSON.stringify(buildTask.handoff)}`)
  if (buildTask.handoff === null) await fail('stage 4: the build task carries no contract at all')
  await assertEqual(
    buildTask.handoff.objective,
    'Add an authentication path to the orders endpoint.',
    "stage 4: the contract's objective is stored as the planner wrote it",
  )
  await assertEqual(
    buildTask.handoff.acceptanceCriteria,
    ['Anonymous requests get 401', 'A signed session reaches the handler'],
    'stage 4: both acceptance criteria are stored',
  )
  // The stage's OWN retry cap, beside the workspace's, on the same board.
  console.log(
    `stage 4 -- maxAttempts: shape ${String(shapeTask.maxAttempts)}, build ${String(buildTask.maxAttempts)}, ` +
      `prove ${String(proveTask.maxAttempts)} (the workspace's is ${String(workspace.maxAttempts)})`,
  )
  if (proveTask.maxAttempts !== 2) {
    await fail(`stage 4: the verify-stage task may be attempted ${String(proveTask.maxAttempts)} times, expected the stage's 2`)
  }
  if (shapeTask.maxAttempts !== 3 || buildTask.maxAttempts !== 3) {
    await fail("stage 4: a task in a stage with no retry cap did not get the workspace's own 3")
  }

  const planEvent = await prisma.executionEvent.findFirstOrThrow({
    where: { workspaceId, type: 'workspace_plan_created' },
    orderBy: { seq: 'asc' },
  })
  console.log(`stage 4 -- workspace.plan_created.runbook: ${JSON.stringify(planEvent.payload.runbook)}`)
  if (planEvent.payload.runbook === undefined) await fail('stage 4: the plan event says nothing about the runbook it was written against')
  await assertEqual(planEvent.payload.runbook.key, ADOPTED_KEY, 'stage 4: the plan event names the runbook')
  await assertEqual(
    planEvent.payload.runbook.stagesCovered,
    ['design', GATED_STAGE, 'verify'],
    'stage 4: the stages the plan covered',
  )
  await assertEqual(
    planEvent.payload.runbook.stagesMissing,
    ['review', 'release'],
    'stage 4: the stages the plan skipped are NAMED, and skipping them refused nothing',
  )
  console.log(
    'stage 4 PASSED: every task carries a stage and a typed contract, the verify stage spent its own retry cap on the task it ' +
      'created, and the two stages the plan never covered are on the record',
  )

  // ============================================================================================
  // Arming stage 6's gate, and staffing the board, before the daemon starts.
  // ============================================================================================

  // The adopted runbook's `implement` stage gets a real gate. Written onto the SEED row because
  // that is the runbook this project follows, and safe because `syncRunbooks` owns seed rows and
  // rewrites them from the checked-in list -- `restoreSeedRunbooks` puts it back in the teardown,
  // and the preflight repairs it again if this process never gets there.
  {
    const stages = adoptedRunbook.stages.map((stage) => (stage.key === GATED_STAGE ? { ...stage, gates: ['true'] } : stage))
    await prisma.runbookTemplate.update({ where: { key: ADOPTED_KEY }, data: { stages } })
    console.log(`stage 6 armed: ${ADOPTED_KEY}'s "${GATED_STAGE}" stage now carries gates ["true"]`)
  }

  // The board asks for a security capability and a QA one, and this project has one worker. The
  // ROLES are what the scheduler matches (M47), so they are granted here through the operator's own
  // verb -- the capabilities are deliberately NOT widened, because stage 7 measures which of a
  // stage's capabilities the people actually here cover.
  console.log(
    `stage 4 -- set-runtime-roles printed: ` +
      JSON.stringify(runCli(['set-runtime-roles', '--slave', devId, '--roles', 'backend,manager,security,qa']).trim()),
  )
  // Somebody who did not write the code has to read it. No capabilities: a reviewer that provided
  // one would change what stage 7 measures.
  const reader = await prisma.slave.create({
    data: { teamId: team.id, name: REVIEWER_NAME, role: 'Reviewer', runtimeRoles: ['reviewer'], capabilities: [] },
  })
  console.log(`slave ${reader.id} (${REVIEWER_NAME}): runtimeRoles ${JSON.stringify(reader.runtimeRoles)}`)

  // ============================================================================================
  // Stage 5: the contract reaches the WORKER and the REVIEWER.
  // ============================================================================================

  const daemon = spawnDaemon('daemon', workspaceId)

  /** Waits for one task to be worked, verified, reviewed and marked done -- then plays the person
   *  who merges the branch by hand, which is the only thing that lets this task's dependents start
   *  on an autoMerge-off project. */
  async function carryAcross(task) {
    await waitUntil(`"${task.title}" to be worked, verified and reviewed`, BOARD_TIMEOUT_MS, async (note) => {
      const rows = await board()
      note(rows.map((row) => `${row.title}=${row.status}`).join(', '))
      return rows.find((row) => row.id === task.id)?.status === 'done'
    })
    console.log(
      `confirm-integration for "${task.title}" printed: ` +
        JSON.stringify(runCli(['confirm-integration', '--task', task.id]).trim()),
    )
  }

  await carryAcross(shapeTask)
  await carryAcross(buildTask)

  const workRun = await prisma.slaveRun.findFirstOrThrow({
    where: { taskId: buildTask.id, kind: 'implementation' },
    orderBy: { startedAt: 'asc' },
  })
  const reviewRun = await prisma.slaveRun.findFirstOrThrow({
    where: { taskId: buildTask.id, kind: 'review' },
    orderBy: { startedAt: 'asc' },
  })
  console.log(`stage 5 -- the build task's work run ${workRun.id}, its review run ${reviewRun.id}`)

  const contextText = runCli(['show-context', '--run', workRun.id, '--prompt'])
  const [manifestText, promptText] = contextText.split(`${'-'.repeat(40)}\n`)
  const manifest = JSON.parse(manifestText)
  console.log(`stage 5 -- the work run's manifest: ${JSON.stringify(manifest.sections.map((s) => s.kind))}`)
  const handoffSource = manifest.sections.find((section) => section.kind === 'handoff')
  const taskSource = manifest.sections.find((section) => section.kind === 'task')
  console.log(`stage 5 -- handoff source: ${JSON.stringify(handoffSource)}`)
  console.log(`stage 5 -- task source:    ${JSON.stringify(taskSource)}`)
  if (handoffSource === undefined) await fail("stage 5: the work run's manifest has no handoff section")
  if (handoffSource.taskId !== buildTask.id) await fail(`stage 5: the handoff section is about ${handoffSource.taskId}`)
  if (!/^[0-9a-f]{64}$/.test(handoffSource.sha256)) {
    await fail(`stage 5: the handoff sha is ${JSON.stringify(handoffSource.sha256)}, expected 64 hex characters`)
  }
  if (taskSource === undefined || taskSource.sha256 === undefined) await fail('stage 5: the task section carries no sha to compare')
  // The two hashes are over DIFFERENT things -- the contract's canonical JSON and the task's title
  // and description -- and folding one into the other is exactly what M48 decided not to do.
  if (taskSource.sha256 === handoffSource.sha256) {
    await fail('stage 5: the handoff sha equals the task sha, so one of them is not over what it claims')
  }
  console.log(`stage 5 -- the prompt's HANDOFF section:\n${(promptText ?? '').split('HANDOFF')[1]?.slice(0, 600) ?? '<none>'}`)
  for (const needle of [
    'HANDOFF',
    'Objective: Add an authentication path to the orders endpoint.',
    'Expected output: Every orders route requires a signed session.',
    'Anonymous requests get 401',
    'A signed session reaches the handler',
  ]) {
    if (promptText === undefined || !promptText.includes(needle)) {
      await fail(`stage 5: the prompt the worker was really given does not contain ${JSON.stringify(needle)}`)
    }
  }

  const reviewContext = JSON.parse(runCli(['show-context', '--run', reviewRun.id]))
  console.log(`stage 5 -- the review run's manifest: ${JSON.stringify(reviewContext.sections.map((s) => s.kind))}`)
  const reviewHandoff = reviewContext.sections.find((section) => section.kind === 'handoff')
  console.log(`stage 5 -- the reviewer's handoff source: ${JSON.stringify(reviewHandoff)}`)
  if (reviewHandoff === undefined) await fail("stage 5: the reviewer's recorded context carries no handoff section")
  if (reviewHandoff.sha256 !== handoffSource.sha256) {
    await fail('stage 5: the reviewer was shown a different contract from the one the worker was given')
  }
  console.log(
    'stage 5 PASSED: the contract the task was created with is in the prompt the worker was really given AND in the one its ' +
      'reviewer was given, hashed over the contract rather than over the words around it',
  )

  // ============================================================================================
  // Stage 6: a stage GATE is real -- on a board that passes, and on one that does not.
  // ============================================================================================

  await waitUntil('the last task to finish', BOARD_TIMEOUT_MS, async (note) => {
    const rows = await board()
    note(rows.map((row) => `${row.title}=${row.status}`).join(', '))
    return rows.length === 3 && rows.every((row) => ['done', 'failed', 'cancelled'].includes(row.status))
  })
  const finished = await board()
  console.log(`stage 6 -- board after the daemon:\n  ${finished.map(describeTask).join('\n  ')}`)
  for (const row of finished) {
    if (row.status !== 'done') await fail(`stage 6: ${row.title} ended ${row.status}, expected done`)
  }

  const buildArtifacts = await prisma.artifact.findMany({ where: { taskId: buildTask.id, kind: 'verify' }, orderBy: { id: 'asc' } })
  const logs = buildArtifacts.map((artifact) => ({
    path: artifact.path.slice(repoPath.length + 1),
    text: existsSync(artifact.path) ? readFileSync(artifact.path, 'utf8').trim() : '<missing>',
  }))
  for (const log of logs) console.log(`stage 6 -- verify log ${log.path}: ${JSON.stringify(log.text)}`)
  const gateLogs = logs.filter((log) => log.text.includes(`stage "${GATED_STAGE}" gate: true`))
  const workspaceLogs = logs.filter((log) => log.text.includes(WORKSPACE_VERIFY.replace('echo ', '')))
  console.log(`stage 6 -- logs naming the stage: ${String(gateLogs.length)}; logs of the workspace's own command: ${String(workspaceLogs.length)}`)
  // ONE, on this project: nothing auto-merges here, so the post-rebase re-verify -- which runs the
  // same gates a second time on the rebased tree (M48 t3 fix round, and `merge.test.ts` pins it) --
  // never happens. What this measures is the verify pass itself.
  if (gateLogs.length < 1) {
    await fail(`stage 6: the stage gate left no log naming the stage; the logs were ${JSON.stringify(logs.map((l) => l.path))}`)
  }
  // The negative beside the positive: a WORKSPACE command's log is attributed to no stage at all.
  const mislabelled = workspaceLogs.filter((log) => log.text.includes('stage "'))
  if (workspaceLogs.length === 0) await fail("stage 6: the workspace's own verify command left no log to compare against")
  if (mislabelled.length > 0) {
    await fail(`stage 6: a workspace command's log claims a stage: ${JSON.stringify(mislabelled.map((l) => l.path))}`)
  }

  await stopDaemon(daemon)

  // ---- the same gate, saying no, on a second project -------------------------------------------
  repoPath2 = makeRepo('repo2')
  const workspace2 = await prisma.workspace.create({
    data: {
      name: GATE_WORKSPACE_2,
      repoPath: repoPath2,
      baseBranch: 'main',
      autoMerge: false,
      verifyCommands: [WORKSPACE_VERIFY],
      setupCommands: [],
      maxAttempts: 1,
      // Off, deliberately: this project exists to measure ONE failing command, and a Supervisor
      // proposing staffing for it would be noise in the log of a gate about verify.
      supervisorEnabled: false,
    },
  })
  workspaceId2 = workspace2.id
  console.log(`workspace ${workspaceId2} (${GATE_WORKSPACE_2}), repo ${repoPath2}`)
  await prisma.providerConfiguration.create({ data: { workspaceId: workspaceId2, kind: 'claude_code', settings: {} } })
  const team2 = await prisma.team.create({ data: { workspaceId: workspaceId2, name: 'Engineering' } })
  await prisma.slave.create({
    data: { teamId: team2.id, name: 'Hand', role: 'Engineer', runtimeRoles: ['backend'], capabilities: [] },
  })
  console.log(
    `stage 6 -- adopt-runbook printed: ` +
      JSON.stringify(runCli(['adopt-runbook', '--workspace', workspaceId2, '--runbook', HUMAN_RUNBOOK.key]).trim()),
  )
  const failingTask = await prisma.task.create({
    data: {
      workspaceId: workspaceId2,
      title: FAILING_TASK_TITLE,
      description: 'Work that passes the project’s own checks and fails the stage’s.',
      status: 'ready',
      maxAttempts: 1,
      requiredRole: 'backend',
      stage: GATED_STAGE,
    },
  })
  console.log(`stage 6 -- the failing task ${failingTask.id} carries stage ${JSON.stringify(failingTask.stage)}`)

  const daemon2 = spawnDaemon('daemon-2', workspaceId2)
  const failedEvent = await waitUntil('the stage gate to refuse the work', VERIFY_TIMEOUT_MS, async (note) => {
    const row = await prisma.executionEvent.findFirst({
      where: { workspaceId: workspaceId2, type: 'task_verify_failed' },
      orderBy: { seq: 'asc' },
    })
    note(row === null ? 'no task.verify_failed yet' : 'written')
    return row
  })
  console.log(`stage 6 -- task.verify_failed payload: ${JSON.stringify(failedEvent.payload)}`)
  await assertEqual(failedEvent.payload.stage, GATED_STAGE, "stage 6: the failure is attributed to the stage whose gate said no")
  await assertEqual(failedEvent.payload.command, 'false', 'stage 6: the failure names the command that ran')
  await stopDaemon(daemon2)

  const failingArtifacts = await prisma.artifact.findMany({ where: { taskId: failingTask.id, kind: 'verify' } })
  const failingLogs = failingArtifacts.map((artifact) =>
    existsSync(artifact.path) ? readFileSync(artifact.path, 'utf8').trim() : '<missing>',
  )
  for (const text of failingLogs) console.log(`stage 6 -- second project's verify log: ${JSON.stringify(text)}`)
  if (!failingLogs.some((text) => text.includes(`stage "${GATED_STAGE}" gate: false`))) {
    await fail('stage 6: no log file on the second project names the stage whose gate failed')
  }
  const failedTask = await prisma.task.findUniqueOrThrow({ where: { id: failingTask.id } })
  console.log(`stage 6 -- the refused task: ${describeTask(failedTask)}, reason ${JSON.stringify(failedTask.lastRejectionReason)}`)
  if (!String(failedTask.lastRejectionReason).includes(`stage "${GATED_STAGE}" gate`)) {
    await fail(`stage 6: the reason the next run would be given is ${JSON.stringify(failedTask.lastRejectionReason)}`)
  }

  // Where the work is, in the operator's own words.
  const statusOut = runCli(['runbook-status', '--workspace', workspaceId])
  console.log(`stage 6 -- \`runbook-status\` printed:\n${statusOut}`)
  const statusLines = statusOut.trim().split('\n')
  if (!statusLines[0].startsWith(`${ADOPTED_NAME} (${ADOPTED_KEY}), current stage: `)) {
    await fail(`stage 6: runbook-status' first line is ${JSON.stringify(statusLines[0])}`)
  }
  const currentStage = statusLines[0].split('current stage: ')[1]
  const stageStates = new Map(
    statusLines.slice(1).map((line) => {
      const [key, state] = line.trim().replace(/^> /, '').split('\t')
      return [key, state]
    }),
  )
  console.log(`stage 6 -- current stage ${JSON.stringify(currentStage)}; states ${JSON.stringify([...stageStates])}`)
  if (stageStates.size !== 5) await fail(`stage 6: runbook-status printed ${String(stageStates.size)} stages, expected 5`)
  for (const [key, expected] of [['design', 'done'], [GATED_STAGE, 'done'], ['verify', 'done'], ['review', 'missing'], ['release', 'active']]) {
    if (stageStates.get(key) !== expected) {
      await fail(`stage 6: stage ${key} reads ${JSON.stringify(stageStates.get(key))}, expected ${expected}`)
    }
  }
  if (currentStage !== 'release') await fail(`stage 6: the current stage is ${JSON.stringify(currentStage)}, expected release`)
  console.log(
    'stage 6 PASSED: a stage’s own gate ran after the project’s own verify commands, refused the work on the project whose ' +
      'gate says no, and said which stage it was in the log, in the rejection reason and on the event -- and runbook-status ' +
      'says which stage the work is on and which one the plan never covered',
  )

  const strayAfter = findRealDaemonPids()
  console.log(`orchestrator daemons still running after the stops: ${JSON.stringify(strayAfter)}`)
  if (strayAfter.length > 0) await fail(`stage 6: a gate daemon is still running (pid ${strayAfter.join(', ')})`)

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

  /** Click, then wait for what the click was FOR -- retried once. (`gate-m45`'s `clickUntil`.) */
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

  // ============================================================================================
  // Stage 7: in a real browser -- how this project works, what it skipped, and what one task
  //          was handed.
  // ============================================================================================

  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await waitVisible(page.getByTestId('runbook-panel'), "the Overview's runbook panel")
  // SCOPED to the panel: `runbook-name` is also the Activity river's adopted-runbook card's testid
  // (M48 t4 report §2), and an unscoped read could be measuring the other one.
  const panel = page.getByTestId('runbook-panel')
  const panelName = (await panel.getByTestId('runbook-name').first().textContent())?.trim() ?? ''
  console.log(`stage 7 -- runbook-name on the Overview = ${JSON.stringify(panelName)}`)
  if (panelName !== ADOPTED_NAME) await fail(`stage 7: the panel names ${JSON.stringify(panelName)}, expected ${ADOPTED_NAME}`)

  const stageRows = await panel.getByTestId('runbook-stage-row').evaluateAll((nodes) =>
    nodes.map((node) => ({ stage: node.getAttribute('data-stage'), state: node.getAttribute('data-state') })),
  )
  console.log(`stage 7 -- the stage ladder on screen: ${JSON.stringify(stageRows)}`)
  if (stageRows.length !== 5) await fail(`stage 7: the panel shows ${String(stageRows.length)} stages, expected 5`)
  await assertEqual(
    stageRows.map((row) => row.stage),
    ['design', GATED_STAGE, 'verify', 'review', 'release'],
    'stage 7: the stages are on screen in the runbook’s own order',
  )
  // The measurement this milestone exists to make, on a page: a stage the work went PAST with no
  // task of its own. Read off the same derivation `runbook-status` printed above, never re-derived.
  const missing = stageRows.filter((row) => row.state === 'missing')
  console.log(`stage 7 -- stages the plan never covered: ${JSON.stringify(missing.map((row) => row.stage))}`)
  if (missing.length === 0) await fail('stage 7: no stage is marked as one the plan skipped')
  for (const row of stageRows) {
    const expected = stageStates.get(String(row.stage))
    if (row.state !== expected) {
      await fail(`stage 7: the page says ${String(row.stage)} is ${String(row.state)} and the CLI said ${String(expected)}`)
    }
  }
  const currentText = (await panel.getByTestId('runbook-current-stage').first().textContent())?.trim() ?? ''
  const currentTitle = adoptedRunbook.stages.find((stage) => stage.key === currentStage)?.title ?? ''
  console.log(`stage 7 -- runbook-current-stage = ${JSON.stringify(currentText)} (the CLI said ${JSON.stringify(currentStage)})`)
  if (currentTitle === '' || !currentText.includes(currentTitle)) {
    await fail(`stage 7: the panel's current stage is ${JSON.stringify(currentText)}, expected the title of ${currentStage}`)
  }
  // `docs/ia.md` rule 3: a person reads the stage's NAME, never its key.
  if (currentText.includes(currentStage)) {
    await fail(`stage 7: the panel prints the raw stage key at a person: ${JSON.stringify(currentText)}`)
  }

  const chips = await panel.getByTestId('runbook-capability-chip').evaluateAll((nodes) =>
    nodes.map((node) => ({ capability: node.getAttribute('data-capability'), covered: node.getAttribute('data-covered'), text: (node.textContent ?? '').trim() })),
  )
  console.log(`stage 7 -- capability chips: ${JSON.stringify(chips)}`)
  if (!chips.some((chip) => chip.covered === 'true')) await fail('stage 7: no stage capability is marked covered by the people here')
  if (!chips.some((chip) => chip.covered === 'false')) await fail('stage 7: no stage capability is marked uncovered')
  const covered = chips.find((chip) => chip.covered === 'true')
  if (covered?.capability !== 'backend.api-design') {
    await fail(`stage 7: the covered capability is ${String(covered?.capability)}, expected the one the roster provides`)
  }
  // Exactly one of them is covered, and it is the one the single worker provides: a panel that
  // marked everything covered would say nothing about this team.
  if (chips.filter((chip) => chip.covered === 'true').length !== 1) {
    await fail(`stage 7: ${String(chips.filter((c) => c.covered === 'true').length)} capabilities are marked covered, expected exactly the one the roster provides`)
  }

  // ---- the Workforce page's Runbooks tab -------------------------------------------------------
  await gotoReliably(`${baseUrl}/workforce`)
  await waitVisible(page.getByTestId('workforce-tab-runbooks'), 'the Workforce Runbooks tab')
  await clickUntil(
    page.getByTestId('workforce-tab-runbooks').first(),
    async () => page.getByTestId('workforce-runbooks').first().isVisible(),
    'the Workforce Runbooks tab',
  )
  const runbookRows = await page.getByTestId('runbook-row').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-key')))
  console.log(`stage 7 -- the runbooks on the Workforce tab: ${JSON.stringify(runbookRows)}`)
  for (const key of [...RUNBOOK_SEED.map((seed) => seed.key), PERSONA_RUNBOOK_KEY, HUMAN_RUNBOOK.key]) {
    if (!runbookRows.includes(key)) await fail(`stage 7: the Runbooks tab does not list ${key}: ${JSON.stringify(runbookRows)}`)
  }
  if (runbookRows.includes(BUILDER_RUNBOOK_KEY)) {
    await fail(`stage 7: the Runbooks tab lists a runbook for the persona that has no process`)
  }
  await assertEqual(
    runbookRows.length,
    RUNBOOK_SEED.length + 2,
    'stage 7: three that ship, one translated from a persona, one an operator wrote',
  )
  await clickUntil(
    page.getByTestId(`runbook-open-${PERSONA_RUNBOOK_KEY}`).first(),
    async () => page.getByTestId('runbook-drawer').first().isVisible(),
    "the persona runbook's row",
  )
  const fromTemplate = (await page.getByTestId('runbook-drawer-source-template').first().textContent())?.trim() ?? ''
  console.log(`stage 7 -- the persona runbook's drawer says: ${JSON.stringify(fromTemplate)}`)
  if (!fromTemplate.includes(REVIEWER)) {
    await fail(`stage 7: the drawer does not name the specialist it was translated from: ${JSON.stringify(fromTemplate)}`)
  }
  const drawerStages = await page.getByTestId('runbook-drawer-stage').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-stage')))
  await assertEqual(drawerStages, ['step-1', 'step-2', 'step-3'], "stage 7: the drawer lists the persona's three steps")

  // ---- the task drawer's stage and contract -----------------------------------------------------
  await gotoReliably(`${baseUrl}/w/${workspaceId}/tasks`)
  await waitVisible(page.getByTestId('column'), 'the task board')
  const buildCard = page.getByTestId('task-card').filter({ hasText: BUILD_TASK_TITLE })
  await waitVisible(buildCard, "the build task's card")
  await clickUntil(
    buildCard.first(),
    async () => page.locator('aside [data-testid="task-stage-chip"]').first().isVisible(),
    "the build task's card",
  )
  const stageChip = await page.locator('aside [data-testid="task-stage-chip"]').first().evaluate((node) => ({
    text: (node.textContent ?? '').trim(),
    title: node.getAttribute('title'),
  }))
  console.log(`stage 7 -- task-stage-chip = ${JSON.stringify(stageChip)}`)
  const gatedTitle = adoptedRunbook.stages.find((stage) => stage.key === GATED_STAGE)?.title ?? ''
  if (stageChip.text !== gatedTitle) await fail(`stage 7: the drawer's stage chip reads ${JSON.stringify(stageChip.text)}, expected ${JSON.stringify(gatedTitle)}`)
  if (stageChip.title !== GATED_STAGE) await fail(`stage 7: the key is not reachable on the chip: ${JSON.stringify(stageChip.title)}`)

  const handoffGroup = await page.evaluate(() => {
    const group = document.querySelector('aside [data-testid="details-group"][data-group="handoff"]')
    if (group === null) return null
    return {
      open: group.getAttribute('data-open'),
      fields: [...group.querySelectorAll('[data-testid="handoff-field"]')].map((field) => [
        field.getAttribute('data-field') ?? '',
        (field.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ]),
    }
  })
  console.log(`stage 7 -- the handoff group: ${JSON.stringify(handoffGroup)}`)
  if (handoffGroup === null) await fail("stage 7: the task drawer has no handoff group at all")
  if (handoffGroup.open !== 'true') await fail(`stage 7: the handoff group arrives ${String(handoffGroup.open)}, expected open`)
  const objectiveField = handoffGroup.fields.find(([name]) => name === 'Objective')
  if (objectiveField === undefined) await fail('stage 7: the handoff group renders no Objective')
  if (!objectiveField[1].includes('Add an authentication path to the orders endpoint.')) {
    await fail(`stage 7: the Objective on screen is ${JSON.stringify(objectiveField[1])}`)
  }
  const criteria = handoffGroup.fields.find(([name]) => name === 'Acceptance criteria')
  if (criteria === undefined || !criteria[1].includes('Anonymous requests get 401')) {
    await fail(`stage 7: the acceptance criteria the task was created with are not on screen: ${JSON.stringify(criteria)}`)
  }
  console.log(
    'stage 7 PASSED: the Overview says how this project works, which stage the work is on, which stage the plan never covered ' +
      'and which of a stage’s capabilities the people here actually provide; the Workforce tab lists every runbook including ' +
      'the one a persona wrote; and the task drawer shows the contract the task was created with',
  )

  console.log(`gotoReliably retries this run: ${String(gotoRetries.length)}${gotoRetries.length === 0 ? '' : ` (${JSON.stringify(gotoRetries)})`}`)
  console.log(
    'PASS: work is handed over with a contract rather than a paragraph -- a persona’s own process became a runbook nobody ' +
      'typed, the Supervisor recommended one and waited for a person, the plan carried a stage and a typed handoff onto every ' +
      'task and named the stages it skipped, the contract turned up in the prompts the worker and its reviewer were really ' +
      'given, a stage’s own gate ran for real and refused work on the project whose gate says no, and the Overview says where ' +
      'the work is',
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
  for (const id of [workspaceId, workspaceId2]) {
    if (id === null) continue
    // Vendor children BEFORE the rows they are named on, `gate-m13-runtime`'s rule.
    const runs = await prisma.slaveRun.findMany({ where: { slave: { team: { workspaceId: id } } }, select: { pid: true } }).catch(() => [])
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
    // SlaveRun/RunContext/SupervisorDecision/Artifact.
    await prisma.executionEvent.deleteMany({ where: { workspaceId: id } }).catch(() => {})
    await prisma.slaveMessage.deleteMany({ where: { workspaceId: id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id } }).catch(() => {})
  }
  // The runbooks go BEFORE the templates: `RunbookTemplate.sourceTemplateId` is `SetNull`, so a
  // persona runbook survives its template's deletion as a row nothing can address again. They go
  // after the workspaces because `Workspace.runbookId` points at one.
  await deleteGateRunbooks('teardown').catch(() => {})
  await deleteGateTemplates('teardown').catch(() => {})
  await prisma.catalogImport.deleteMany({ where: { catalog: CATALOG_NAME } }).catch(() => {})
  // The gate this run armed on a SEED row, taken off again -- `syncRunbooks` owns those rows and
  // this puts them back to exactly what the checked-in list says.
  await restoreSeedRunbooks('teardown').catch(() => {})
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  if (repoPath2 !== null) rmSync(repoPath2, { recursive: true, force: true })
  if (catalogRoot !== null) rmSync(catalogRoot, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
