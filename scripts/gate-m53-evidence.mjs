// M53's own gate (spec §3): "two workers, two records, and a ranking that says why".
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m53-evidence
//
// NEVER A MODEL CALL, AND ZERO SPEND. Every run is the fake CLI; every verify is
// `scripts/gate-fakes/fake-verify.sh`, the fifth fake; every cost figure in this gate is a literal
// written onto a `SlaveRun` row or a token count under a priced model.
//
// THE GATE ASSERTS, IT NEVER FIXES, and every stage prints every measured value before asserting it.
//
// TWO DAEMON PHASES, ONE WORKSPACE (plan erratum E16). `--review-fixture` reaches a run through
// `SLAVEOFAI_CLAUDE_ARGS`, which is the DAEMON's environment and not a worker's, so two workers under
// one daemon cannot get different review verdicts. Phase A runs with `review-approve` and a verify
// that passes first time, with only profile A dispatchable; phase B restarts the daemon with
// `review-reject` and a seeded `fake-verify.sh` state file, with only profile B dispatchable. The
// workspace, the tasks, the templates and every `EvidenceRecord` are ONE set throughout --
// `gate:m36-messaging` stops and restarts the orchestrator mid-scenario for the same kind of reason.
//
// THE PIPELINE WRITES THE FACTS AND THE GATE TOPS UP THE SAMPLE. Steps 5 and 6 of `rankCandidates`
// read a rate only once its own denominator reaches `EVIDENCE_MIN_SAMPLE` (5, erratum E20), so two
// profiles with two pipeline runs each TIE on the record and the ranking stage would be measuring
// step 7. Every row this gate adds by hand is written by the SAME writer (`recordRunEvidence`) and
// settled by the SAME settler over a real `SlaveRun` row -- what is seeded is the sample size, never
// the derivation, and the derivation itself is asserted in stages 1 and 2 against runs a real daemon
// concluded.
//
// The twelve stages, each measuring one thing the milestone claims:
//   1.  A fact is written at a TERMINAL transition and nowhere else: nothing while the run is live,
//       exactly one the instant it concludes, still exactly one when the writer is called again by
//       hand -- and NO ROW AT ALL for a run that failed at spawn, because nothing was attempted.
//       Then FOUR more transitions, each named after the site it proves and each asserted on that
//       run's own row (fix round 1): 1c the sweep's orphan arm (`recoveries`), 1b the operator's
//       own stop through `cancel --run` (site 7, erratum E22 -- `stopped`, and the intervention
//       counted), 1d the merge pass's integration settle under `autoMerge: true`, and 1e a run the
//       PUMP concluded as failed. All three outcomes and both non-zero counters are written by a
//       real transition somewhere in this gate rather than by the gate itself.
//   2.  `attempt` and `verifiedFirstPass` are DERIVED: profile A passes first time, profile B fails
//       once and passes on attempt 2 and is still not a first pass. Then, from the SCHEMA: no
//       `attempt` column on `SlaveRun`, and no `attempt` key in a verify event's payload.
//   3.  A run in two domains is ONE row counted under BOTH chips, and the two filtered counts
//       deliberately do not sum to the unfiltered total -- asserted as an inequality, in the
//       browser. A task with no required capability lands in `general`.
//   4.  Money keeps its provenance: reported, estimated and unmeasured in one project, the
//       unmeasured figure NULL and not 0, and the word beside the figure on the page.
//   5.  The backfill records history and is idempotent to the byte -- and never judges it (E23).
//   6.  Nothing crosses from a simulation: a real `SimulationRun.id` handed to the writer is
//       refused and writes nothing; the boundary source scan is re-run from here.
//   7.  The record decides, a person's choice overrules the record, and clearing it gives the
//       record back -- with `staffing.preference_changed` on the timeline twice.
//   8.  A preference never moves the wall and never moves the queue: a refusal beats it, a busy
//       candidate loses anyway, and `SlavePermission` moves only where a person moved it.
//   9.  A thin record says so in words: the markers, the withheld rates, and a REAL judged row
//       beside them drawing one valued bar per rate it claims.
//   10. No raw key is visible text on either table, and no column is a score.
//   11. The sort is what the caption's own words say it is.
//   12. The analytics tiles handed over: five, no `Spend`, no per-slave table, a link to the
//       Evidence tab -- and `?workspace=` still scopes.
//
// IT NEVER EDITS A FILE IN THIS REPOSITORY. The temporary repositories, the state directory and the
// fake's own state file are all under `/tmp` and are removed in the `finally`; `git status
// --porcelain` after a green run is what it was before.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: it boots `next dev` against the
// repo's own `apps/web/.next` on a freshly chosen free port, and a second `next dev` sharing that
// directory corrupts the on-disk build cache for both. Stop any running dev server first
// (`pgrep -af "next dev"`).

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
import { EVENT_TYPE_BY_DOMAIN_TYPE } from '../packages/db/dist/enums.js'
import { createUser, deleteUser, recordRunEvidence } from '../packages/control/dist/index.js'
import { appendEvent } from '../packages/events/dist/index.js'
import {
  BASELINE_GRANTS,
  BESPOKE_PROFILE_LABEL,
  COST_PROVENANCE_WORD,
  EVIDENCE_MIN_SAMPLE,
  EVIDENCE_OUTCOMES,
  EVIDENCE_OUTCOME_LABEL,
  GENERAL_DOMAIN,
  INSUFFICIENT_EVIDENCE,
  MODEL_NOT_RECORDED_LABEL,
  MODEL_PRICES,
  NON_TERMINAL_RUN_STATUSES,
  domainLabel,
  normaliseRepositoryKey,
} from '../packages/domain/dist/index.js'

const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 100
const DAEMON_PERIOD_MS = 500
/** One pipeline step: a dispatch, a conclusion, a verify pass, a review run. Generous because the
 *  machine running this may be building something else at the same time. */
const PIPELINE_TIMEOUT_MS = 180_000
/** `gate-m14-fidelity.mjs`'s own signature for next dev's torn `loadManifest` read. */
const MANIFEST_RACE_SIGNATURE = 'Unexpected end of JSON input'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const FAKE_VERIFY = join(repoRoot, 'scripts/gate-fakes/fake-verify.sh')
const BACKFILL = join(repoRoot, 'scripts/backfill-evidence.mjs')
const PASS_LINE = 'two workers, two records, and a ranking that says why'

// Suffixed per run (`gate-m52-broker.mjs`'s idiom): `Workspace.name` and `SlaveTemplate.name` are
// both unique, so a distinct name per run keeps two overlapping executions from colliding, and
// `preflightCleanup` removes leftovers by PREFIX.
const STAMP = new Date().toISOString().slice(11, 19)
const SAFE_STAMP = STAMP.replaceAll(':', '-')
const WORKSPACE_PREFIX = 'M53 Gate Project'
const WORKSPACE_NAME = `${WORKSPACE_PREFIX} ${STAMP}`
const FOIL_WORKSPACE_NAME = `${WORKSPACE_PREFIX} Foil ${STAMP}`
const TEMPLATE_PREFIX = 'M53 Gate Persona'
const COMPANY_PREFIX = 'M53 Gate Company'
const COMPANY_NAME = `${COMPANY_PREFIX} ${STAMP}`
const TEAM_NAME = 'M53 Gate Department'
const GATE_USERNAME = `m53-gate-${SAFE_STAMP}`
const GATE_PASSWORD = 'm53-gate-password'

/** The role every pipeline task is dispatched as. NOT a role any capability projects to (the
 *  taxonomy's roles are backend, qa, reviewer, …), so a worker holding it never COVERS the staffing
 *  capability stages 7 and 8 are about -- which is what keeps that gap open for the Supervisor. */
const WORK_ROLE = 'dev'
const REVIEW_ROLE = 'reviewer'
/** The capability the ranking stages are about: both workers PROVIDE it, neither holds the role it
 *  projects to (`backend`), so tier 1 of `formTeam` is a two-candidate field and steps 2-7 decide. */
const STAFF_CAPABILITY = 'backend.services'
/** The second capability on the multi-domain task -- a different DOMAIN, which is the point. */
const QA_CAPABILITY = 'qa.test-automation'
const STAFF_DOMAIN = 'backend'
const QA_DOMAIN = 'qa'
/** In `BASELINE_GRANTS.implementation`, so denying it is a wall a run really hits (R10). */
const WALLED_KIND = 'run_commands'

/** The model the seeded cost rows run on. A KEY OF `MODEL_PRICES` (asserted in stage 0): the
 *  estimated row's provenance depends on the model being priced, and an unpriced id would read
 *  `unmeasured` and quietly make stage 4 measure the same thing twice. */
const PRICED_MODEL = 'claude-sonnet-5'
/** What the two pipeline workers run on. An alias `PRICE_ALIASES` resolves, and every pipeline run
 *  reports its own cost anyway. */
const PIPELINE_MODEL = 'sonnet'

/** The delay the fake CLI sleeps between two fixture lines. `complete.ndjson` is eleven lines, so
 *  this is what turns a run into a few seconds of real time -- long enough for stage 1 to observe a
 *  LIVE run with its own eyes rather than reason about one. */
const LINE_DELAY_MS = 400

/** The first viewport, `gate-m45`'s own. */
const VIEWPORT = { width: 1440, height: 900 }

const dbType = (domainType) => {
  const value = EVENT_TYPE_BY_DOMAIN_TYPE[domainType]
  if (value === undefined) throw new Error(`no database enum value for the event type ${domainType}`)
  return value
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Asks the OS for a free TCP port (`gate-m52-broker.mjs`, verbatim). */
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

/** A throwaway git repository for one project to hold its worktrees in (`gate-m52-broker.mjs`). */
function makeRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `slaveofai-gate-m53-${label}-`))
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

/** Teardown for one project, in FK order (`gate-m52-broker.mjs`, plus this milestone's two tables:
 *  both cascade from `Workspace`, and both are deleted explicitly first so the order is stated). */
async function removeWorkspace(id) {
  await prisma.evidenceRecord.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.staffingPreference.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.executionEvent.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.supervisorDecision.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.slaveMessage.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.memory.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.brokerBinding.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.credential.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.runContext.deleteMany({ where: { run: { slave: { team: { workspaceId: id } } } } }).catch(() => {})
  await prisma.checkpoint.deleteMany({ where: { run: { slave: { team: { workspaceId: id } } } } }).catch(() => {})
  await prisma.slaveRun.deleteMany({ where: { slave: { team: { workspaceId: id } } } }).catch(() => {})
  await prisma.slavePermission.deleteMany({ where: { slave: { team: { workspaceId: id } } } }).catch(() => {})
  await prisma.taskDependency.deleteMany({ where: { task: { workspaceId: id } } }).catch(() => {})
  await prisma.goalVersion.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.task.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.slave.deleteMany({ where: { team: { workspaceId: id } } }).catch(() => {})
  await prisma.team.deleteMany({ where: { workspaceId: id } }).catch(() => {})
  await prisma.workspace.delete({ where: { id } }).catch(() => {})
}

/** Removes anything a prior interrupted run left behind, by NAME PREFIX. */
async function preflightCleanup() {
  const stale = await prisma.workspace.findMany({ where: { name: { startsWith: WORKSPACE_PREFIX } }, select: { id: true, name: true } })
  for (const workspace of stale) {
    console.log(`preflight: removing leftover workspace ${workspace.id} (${workspace.name})`)
    await removeWorkspace(workspace.id)
  }
  const staleSims = await prisma.simulationRun.findMany({ where: { company: { name: { startsWith: COMPANY_PREFIX } } }, select: { id: true } })
  for (const sim of staleSims) await prisma.simulationRun.delete({ where: { id: sim.id } }).catch(() => {})
  const staleCompanies = await prisma.company.findMany({ where: { name: { startsWith: COMPANY_PREFIX } }, select: { id: true, name: true } })
  for (const company of staleCompanies) {
    console.log(`preflight: removing leftover company ${company.id} (${company.name})`)
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {})
  }
  const staleTemplates = await prisma.slaveTemplate.findMany({ where: { name: { startsWith: TEMPLATE_PREFIX } }, select: { id: true, name: true } })
  for (const template of staleTemplates) {
    console.log(`preflight: removing leftover template ${template.id} (${template.name})`)
    await prisma.slaveTemplate.delete({ where: { id: template.id } }).catch(() => {})
  }
  const staleUsers = await prisma.user.findMany({ where: { username: { startsWith: 'm53-gate-' } }, select: { id: true, username: true } })
  for (const user of staleUsers) {
    console.log(`preflight: removing leftover user ${user.id} (${user.username})`)
    await prisma.executionEvent.updateMany({ where: { userId: user.id }, data: { userId: null } }).catch(() => {})
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {})
  }
}

let exitCode = 1
let nextServer = null
let nextOutput = ''
let browser = null
let page = null
let diagDir = null
let gateUserId = null
let companyId = null
const workspaceIds = []
const templateIds = []
const repoPaths = []
const daemons = []
const browserConsole = []
const gotoRetries = []

/** One run row as this gate prints it. */
const describeRun = (row) =>
  row === null || row === undefined
    ? '<no run>'
    : JSON.stringify({
        id: row.id,
        kind: row.kind,
        status: row.status,
        taskId: row.taskId,
        costUsd: row.costUsd,
        startedAt: row.startedAt === null || row.startedAt === undefined ? null : row.startedAt.toISOString(),
        endedAt: row.endedAt === null || row.endedAt === undefined ? null : row.endedAt.toISOString(),
      })

/** One evidence row as this gate prints it -- every column a stage asserts on, in one line. */
const describeEvidence = (row) =>
  row === null || row === undefined
    ? '<no evidence row>'
    : JSON.stringify({
        runId: row.runId,
        profileKey: row.profileKey,
        profileName: row.profileName,
        model: row.model,
        repositoryKey: row.repositoryKey,
        domains: row.domains,
        runKind: row.runKind,
        attempt: row.attempt,
        outcome: row.outcome,
        verifiedFirstPass: row.verifiedFirstPass,
        reviewRejected: row.reviewRejected,
        integrated: row.integrated,
        reworkCycles: row.reworkCycles,
        humanInterventions: row.humanInterventions,
        recoveries: row.recoveries,
        durationMs: row.durationMs,
        actualCostUsd: row.actualCostUsd,
        costProvenance: row.costProvenance,
        recordedAt: row.recordedAt?.toISOString?.() ?? null,
        settledAt: row.settledAt === null || row.settledAt === undefined ? null : row.settledAt.toISOString(),
      })

/** Every row this gate could have written, for a FAIL's diagnostic dump. */
async function dumpGateRows() {
  const workspaces = []
  for (const id of workspaceIds) {
    const row = await prisma.workspace
      .findUnique({
        where: { id },
        include: {
          tasks: true,
          teams: { include: { slaves: { include: { runs: true, permissions: true } } } },
          supervisorDecisions: true,
          evidence: true,
          staffingPreferences: true,
        },
      })
      .catch(() => null)
    workspaces.push(row)
  }
  const daemonTails = daemons.map((d) => ({
    label: d.label,
    pid: d.proc.pid ?? null,
    exited: d.exited,
    output: d.output.length > 8_000 ? `…${d.output.slice(-8_000)}` : d.output,
  }))
  return JSON.stringify({ workspaces, daemonTails }, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
}

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m53-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ============================================================================================
  // Stage 0: the preflight. Refusals, never fallbacks -- then the fixture.
  // ============================================================================================

  // Zero spend, ENFORCED (Decision 10, M32 item 7).
  const fakeClaude = process.env['SLAVEOFAI_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'SLAVEOFAI_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m53-evidence',
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
      `no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m53-evidence passes ` +
        '--env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m53-evidence`')
  }
  if (!existsSync(ORCHESTRATOR_CLI)) {
    throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI} -- run \`npx tsc --build\` first`)
  }
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)
  if (!existsSync(BACKFILL)) throw new Error(`the backfill script is missing at ${BACKFILL}`)
  try {
    accessSync(FAKE_VERIFY, constants.X_OK)
  } catch {
    throw new Error(`the fifth fake is missing or not executable at ${FAKE_VERIFY} -- \`chmod +x\` it`)
  }
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(
      `no Chromium binary at ${chromiumPath} -- stages 3 and 9 to 12 read a real rendered page, so set ` +
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
      `gate:m53-evidence REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate drives its own and would be measuring somebody else\'s ticks.',
    )
  }

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

  // ONE state root for this gate process and every child it spawns, through the shared helper --
  // which is also what `loopbackChildEnv` calls, so the gate and its daemons agree on where a run's
  // files are, and the directory is removed on exit.
  const stateDir = gateStateDir()
  const verifyState = join(diagDir, 'verify-state')
  console.log(`fake claude:  ${fakeClaude}`)
  console.log(`fake verify:  ${FAKE_VERIFY} --state ${verifyState}`)
  console.log(`chromium:     ${chromiumPath}`)
  console.log(`state dir:    ${stateDir} (SLAVEOFAI_STATE_DIR, from scripts/lib/state-dir.mjs)`)
  console.log(
    `domain numbers: EVIDENCE_MIN_SAMPLE=${String(EVIDENCE_MIN_SAMPLE)} ` +
      `BASELINE_GRANTS.implementation=${JSON.stringify(BASELINE_GRANTS.implementation)}`,
  )
  assert(
    BASELINE_GRANTS.implementation.includes(WALLED_KIND),
    `${WALLED_KIND} is NOT in the implementation baseline -- stage 8 would be denying something no run needs, ` +
      'and `isWalled` would rank nothing',
  )
  assert(
    Object.hasOwn(MODEL_PRICES, PRICED_MODEL),
    `${PRICED_MODEL} is not a key of MODEL_PRICES -- stage 4's estimated row would read \`unmeasured\` and the ` +
      'stage would measure the same provenance twice',
  )

  await preflightCleanup()

  /**
   * The environment every child gets.
   *
   * `SLAVEOFAI_CLAUDE_ARGS` is the ONE per-daemon channel a gate can count on (M39 erratum E6, M52
   * R3): a RUN's child no longer inherits the daemon's environment at all, so every knob the fake
   * CLI reads rides on argv beside `--fixture`. `--review-fixture` is the one that makes the two
   * phases two phases (erratum E16).
   *
   * `fixture` is a parameter too, for ONE phase only: the fake's `crash` MODE writes half a stream
   * and exits 1, which is how the pump's non-clean conclusion is reached (write site 3). Every
   * fixture in `packages/providers/test/fixtures/` ends with a terminal `result` line -- measured,
   * not assumed -- so `--work-fixture <anything>` can only ever produce a clean conclusion, and a
   * gate that wanted a failed run out of one would be waiting forever.
   */
  const daemonEnv = ({ reviewFixture = 'review-approve', fixture = 'm8-flow', workFixture = 'complete' } = {}) =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS: [
        FAKE_CLAUDE,
        '--fixture',
        fixture,
        ...(fixture === 'm8-flow' ? ['--work-fixture', workFixture, '--review-fixture', reviewFixture] : []),
        '--line-delay-ms',
        String(LINE_DELAY_MS),
      ].join(' '),
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
    })

  /** Runs the real orchestrator CLI as a subprocess, exactly as an operator's shell would. */
  const runCli = (args) => {
    try {
      return execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
        cwd: repoRoot,
        env: loopbackChildEnv({
          SLAVEOFAI_CLAUDE_BIN: 'node',
          SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8-flow --work-fixture complete`,
          SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
        }),
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

  /** The backfill, as its own npm script runs it minus the `tsc --build` half this gate's preflight
   *  has already insisted on.
   *
   *  THE EXIT STATUS IS PART OF WHAT STAGE 5 MEASURES, and it is measured by this function throwing:
   *  the script exits 1 when it SKIPPED a run (every one of them named on stderr) or when a flag is
   *  wrong, and on this database either would be a defect rather than a measurement. The failure
   *  therefore carries both streams rather than a bare status, and stage 5 states the zero it
   *  depends on out loud. */
  const runBackfill = (args) => {
    const result = spawnSync('node', ['--env-file=.env', BACKFILL, ...args], {
      cwd: repoRoot,
      env: loopbackChildEnv({}),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error !== undefined && result.error !== null) throw result.error
    if (result.status !== 0) {
      throw new Error(
        `the backfill exited ${String(result.status)} for \`${args.join(' ')}\`\n` +
          `  stdout: ${String(result.stdout)}\n  stderr: ${String(result.stderr)}`,
      )
    }
    return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) }
  }

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
        /* the message below still carries the tail */
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

  /** The real daemon, in the background -- the same thing an operator leaves running. */
  function spawnDaemon(label, forWorkspaceId, scripting = {}) {
    const proc = spawn(
      'node',
      [ORCHESTRATOR_CLI, 'daemon', '--workspace', forWorkspaceId, '--period', String(DAEMON_PERIOD_MS)],
      { cwd: repoRoot, env: daemonEnv(scripting), stdio: ['ignore', 'pipe', 'pipe'] },
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
    console.log(`${label} spawned as pid ${String(proc.pid)}, scripted ${JSON.stringify(scripting)}`)
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

  const runRow = (id) => prisma.slaveRun.findUnique({ where: { id } })
  const evidenceFor = (runId) => prisma.evidenceRecord.findUnique({ where: { runId } })
  const evidenceCountFor = (runId) => prisma.evidenceRecord.count({ where: { runId } })

  // ---- The person, the catalog, the project. ----------------------------------------------------
  const created = await createUser(GATE_USERNAME, GATE_PASSWORD)
  if (!created.ok) throw new Error(`could not create the gate's user: ${JSON.stringify(created.error)}`)
  gateUserId = created.value.id
  console.log(`stage 0: the person is ${GATE_USERNAME} (${gateUserId})`)

  const capabilityRow = await prisma.capability.findUnique({ where: { key: STAFF_CAPABILITY } })
  if (capabilityRow === null) {
    throw new Error(`the taxonomy has no ${STAFF_CAPABILITY} -- run \`npm run db:seed\` before this gate`)
  }
  const STAFF_LABEL = capabilityRow.label
  console.log(`stage 0: the staffing capability is ${STAFF_CAPABILITY}, whose WORD is ${JSON.stringify(STAFF_LABEL)}`)

  /** One catalog persona. Every worker hired from one keys on `template:<id>` (R1), which is what
   *  makes a PROFILE outlive the worker. */
  const makeTemplate = async (suffix, capabilities) => {
    const row = await prisma.slaveTemplate.create({
      data: {
        name: `${TEMPLATE_PREFIX} ${suffix} ${STAMP}`,
        role: WORK_ROLE,
        description: 'Seeded by gate:m53-evidence.',
        defaultModel: PIPELINE_MODEL,
        capabilityKeys: [...capabilities],
      },
    })
    templateIds.push(row.id)
    console.log(`stage 0: template ${row.id} (${row.name})`)
    return row
  }

  const templateA = await makeTemplate('A', [STAFF_CAPABILITY, QA_CAPABILITY])
  const templateB = await makeTemplate('B', [STAFF_CAPABILITY])
  const templateC = await makeTemplate('C', [])
  const templateD = await makeTemplate('D', [])
  const templateE = await makeTemplate('E', [])

  const repoPath = makeRepo('main')
  repoPaths.push(repoPath)
  const repositoryKey = normaliseRepositoryKey(repoPath)
  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath,
      // THE FIFTH FAKE, as a row a person wrote -- which is exactly where a scripted verification's
      // own configuration belongs. While the state file exists the first verify fails; afterwards
      // every verify passes.
      verifyCommands: [`${FAKE_VERIFY} --state ${verifyState}`],
      setupCommands: [],
      // FALSE: `confirmIntegration` is a person's act, so every pipeline row this gate writes reads
      // `integrated: null` -- "nobody has judged this yet" -- which is the shape stage 9's real row
      // is about, and the shape Task 3's fix round made ordinary.
      autoMerge: false,
      budgetUsd: 100,
      // OFF during both phases: a Supervisor watching this project would raise a staffing situation
      // out of the very tasks the phases are dispatching. Switched on for stages 7 and 8, once no
      // daemon is running at all.
      supervisorEnabled: false,
    },
  })
  workspaceIds.push(workspace.id)
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: TEAM_NAME } })

  const makeWorker = async ({ name, templateId, runtimeRoles, capabilities }) => {
    const row = await prisma.slave.create({
      data: {
        teamId: team.id,
        name,
        role: WORK_ROLE,
        runtimeRoles: [...runtimeRoles],
        capabilities: [...capabilities],
        model: PIPELINE_MODEL,
        provider: 'claude_code',
        ...(templateId === null ? {} : { hiredFromTemplateId: templateId }),
      },
    })
    console.log(
      `stage 0: worker ${row.id} (${name}) roles=${JSON.stringify(row.runtimeRoles)} ` +
        `capabilities=${JSON.stringify(row.capabilities)} template=${String(templateId)}`,
    )
    return row
  }

  // Phase A's worker is dispatchable; phase B's holds no runtime role at all and cannot be reached.
  const workerA = await makeWorker({ name: 'Ada', templateId: templateA.id, runtimeRoles: [WORK_ROLE], capabilities: [STAFF_CAPABILITY, QA_CAPABILITY] })
  const workerB = await makeWorker({ name: 'Bo', templateId: templateB.id, runtimeRoles: [], capabilities: [STAFF_CAPABILITY] })
  // The reviewer is BESPOKE on purpose -- hired from no template, so its record keys on `slave:<id>`
  // (R1's other half) and its row wears the `Bespoke` chip stage 10 reads.
  const reviewer = await makeWorker({ name: 'Rei', templateId: null, runtimeRoles: [REVIEW_ROLE], capabilities: [] })
  // C, D and E hold no runtime role and are dispatched by nothing: their records are the SHAPES
  // stage 9 is about (a thin one, an ample one, one nobody has judged), written through the same
  // writer below. E is also where the sweep's own conclusion lands in stage 1c, which is why all
  // three exist from the start rather than being made up after the phases.
  const workerC = await makeWorker({ name: 'Cal', templateId: templateC.id, runtimeRoles: [], capabilities: [] })
  const workerD = await makeWorker({ name: 'Dex', templateId: templateD.id, runtimeRoles: [], capabilities: [] })
  const workerE = await makeWorker({ name: 'Eli', templateId: templateE.id, runtimeRoles: [], capabilities: [] })
  const PROFILE_A = `template:${templateA.id}`
  const PROFILE_B = `template:${templateB.id}`
  const PROFILE_C = `template:${templateC.id}`
  const PROFILE_D = `template:${templateD.id}`
  const PROFILE_E = `template:${templateE.id}`
  const PROFILE_REVIEWER = `slave:${reviewer.id}`

  // The foil: a second project with one live run, so stage 12's `?workspace=` scope has something to
  // be narrower THAN. No daemon ever watches it.
  const foilRepo = makeRepo('foil')
  repoPaths.push(foilRepo)
  const foil = await prisma.workspace.create({
    data: { name: FOIL_WORKSPACE_NAME, repoPath: foilRepo, verifyCommands: ['true'], setupCommands: [], autoMerge: false, budgetUsd: 10 },
  })
  workspaceIds.push(foil.id)
  const foilTeam = await prisma.team.create({ data: { workspaceId: foil.id, name: TEAM_NAME } })
  const foilWorker = await prisma.slave.create({
    data: { teamId: foilTeam.id, name: 'Fen', role: WORK_ROLE, runtimeRoles: [], model: PIPELINE_MODEL, provider: 'claude_code' },
  })
  const foilRun = await prisma.slaveRun.create({
    data: { slaveId: foilWorker.id, status: 'working', kind: 'implementation', provider: 'claude_code', model: PIPELINE_MODEL, pid: null },
  })
  console.log(`stage 0: the foil project ${foil.id} holds one live run (${foilRun.id}) and no daemon ever ticks it`)
  console.log('stage 0 PASSED: a person, five personas, one project on the fifth fake, two workers and a bespoke reviewer')

  // ============================================================================================
  // PHASE A -- review-approve, and a verify that passes first time.
  // ============================================================================================
  const daemonA = spawnDaemon('phase-a-daemon', workspace.id, { reviewFixture: 'review-approve' })

  const taskA1 = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'M53 Gate Task A1',
      description: 'Seeded by gate:m53-evidence — the run stages 1, 2 and 3 read.',
      status: 'ready',
      requiredRole: WORK_ROLE,
      // TWO capabilities in TWO domains: one run, one row, counted under both chips (R2).
      requiredCapabilities: [STAFF_CAPABILITY, QA_CAPABILITY],
      maxAttempts: 3,
    },
  })
  console.log(`phase A: task ${taskA1.id} (${taskA1.title}) requires ${JSON.stringify(taskA1.requiredCapabilities)}`)

  // ============================================================================================
  // Stage 1: a fact is written at a terminal transition and nowhere else.
  // ============================================================================================
  const runA1Id = await waitUntil('Ada to be dispatched and to have started', PIPELINE_TIMEOUT_MS, async () => {
    const row = await prisma.slaveRun.findFirst({ where: { taskId: taskA1.id, kind: 'implementation' }, orderBy: { startedAt: 'asc' } })
    if (row === null) return { done: false, detail: 'no run row yet' }
    const started = await prisma.executionEvent.count({ where: { runId: row.id, type: dbType('run.started') } })
    if (started === 0) return { done: false, detail: `${row.status}, no run.started event yet` }
    return { done: true, value: row.id }
  })
  console.log(`stage 1: the first run is ${describeRun(await runRow(runA1Id))}`)

  // (a) NOTHING while it is live. Polled between `run.started` and the conclusion, and the number of
  // observations is printed: a stage that never caught the run alive would be measuring nothing, so
  // the count is asserted rather than assumed.
  let liveObservations = 0
  await waitUntil('the first run to conclude, with no evidence row while it is alive', PIPELINE_TIMEOUT_MS, async () => {
    // THE COUNT FIRST, THE RUN SECOND, and that order is the whole of this probe's honesty: the pump
    // writes the terminal row and THEN calls the writer, so a count read before a still-live read
    // cannot be a row that landed in between. The other order would fail this gate on a race rather
    // than on a defect.
    const rows = await evidenceCountFor(runA1Id)
    const row = await runRow(runA1Id)
    if (rows !== 0) {
      if (row.endedAt === null) {
        await fail(`stage 1: a LIVE run (${row.status}) already has ${String(rows)} evidence row(s) -- a fact is written when a run CONCLUDES`)
      }
      return { done: true, value: row }
    }
    if (row.endedAt !== null) return { done: true, value: row }
    liveObservations += 1
    return { done: false, detail: `${row.status}, ${String(liveObservations)} live observation(s) with no row` }
  })
  console.log(`stage 1: the run was observed ALIVE ${String(liveObservations)} time(s), carrying no evidence row on any of them`)
  if (liveObservations < 3) {
    await fail(
      `stage 1: only ${String(liveObservations)} live observation(s) -- the run concluded before this stage could ` +
        'watch it, so "nothing while it is live" was never actually measured',
    )
  }

  // (b) EXACTLY ONE the instant it concludes.
  const rowA1 = await waitUntil('the first run\'s evidence row', PIPELINE_TIMEOUT_MS, async () => {
    const row = await evidenceFor(runA1Id)
    if (row === null) return { done: false, detail: 'the conclusion has not written a row yet' }
    return { done: true, value: row }
  })
  console.log(`stage 1: the row = ${describeEvidence(rowA1)}`)
  await assertEqual(await evidenceCountFor(runA1Id), 1, 'stage 1: evidence rows for the concluded run')
  await assertEqual(rowA1.profileKey, PROFILE_A, 'stage 1: the profile key of a worker hired from a template')
  await assertEqual(rowA1.profileName, templateA.name, "stage 1: the profile's name -- the TEMPLATE's, snapshotted")
  await assertEqual(rowA1.repositoryKey, repositoryKey, 'stage 1: the repository dimension')
  await assertEqual(rowA1.runKind, 'implementation', 'stage 1: the run kind')
  await assertEqual(rowA1.outcome, 'succeeded', 'stage 1: the outcome')
  await assertEqual([...rowA1.domains].sort(), [STAFF_DOMAIN, QA_DOMAIN].sort(), 'stage 1: the domains the task asked for')
  await assertEqual(rowA1.workspaceId, workspace.id, 'stage 1: the project the fact belongs to')

  // (c) A SECOND call for the same run -- a sweep racing a pump, made by hand -- still leaves one.
  const beforeReplay = { recordedAt: rowA1.recordedAt.toISOString(), settledAt: rowA1.settledAt }
  const replay = await recordRunEvidence(runA1Id)
  await assertEqual(replay.ok, true, 'stage 1: the writer called a second time for the same run')
  const afterReplay = await evidenceFor(runA1Id)
  await assertEqual(await evidenceCountFor(runA1Id), 1, 'stage 1: evidence rows after a second call for the same run')
  await assertEqual(afterReplay.recordedAt.toISOString(), beforeReplay.recordedAt, 'stage 1: recordedAt after the replay -- written once, never rewritten')
  console.log('stage 1: the writer is idempotent on `runId @unique` -- one row, the same recordedAt')

  // ============================================================================================
  // Stage 2 (first half): attempt and first-pass, on a run that passed first time.
  // ============================================================================================
  const settledA1 = await waitUntil('the verify verdict to settle on the first run', PIPELINE_TIMEOUT_MS, async () => {
    const row = await evidenceFor(runA1Id)
    if (row.verifiedFirstPass === null) return { done: false, detail: `verifiedFirstPass is still null (settledAt ${String(row.settledAt)})` }
    return { done: true, value: row }
  })
  console.log(`stage 2: profile A's row after the verify pass = ${describeEvidence(settledA1)}`)
  await assertEqual(settledA1.attempt, 1, "stage 2: profile A's attempt")
  await assertEqual(settledA1.verifiedFirstPass, true, "stage 2: profile A's verifiedFirstPass")
  await assertEqual(settledA1.reworkCycles, 0, "stage 2: profile A's rework cycles")

  const approvedA1 = await waitUntil('the review verdict to settle on the first run', PIPELINE_TIMEOUT_MS, async () => {
    const row = await evidenceFor(runA1Id)
    if (row.reviewRejected === null) return { done: false, detail: 'reviewRejected is still null' }
    return { done: true, value: row }
  })
  await assertEqual(approvedA1.reviewRejected, false, "stage 2: profile A's review verdict, under --review-fixture review-approve")
  await assertEqual(approvedA1.integrated, null, 'stage 2: profile A\'s integration column on an autoMerge:false project -- nobody has judged it')

  // A REVIEW run's row keeps every judgement column null forever (D16) -- enforced at the writer,
  // and the reviewer here is a BESPOKE profile, which is R1's other key.
  const reviewRun = await waitUntil("the reviewer's own run and its row", PIPELINE_TIMEOUT_MS, async () => {
    const row = await prisma.slaveRun.findFirst({ where: { taskId: taskA1.id, kind: 'review' }, orderBy: { startedAt: 'desc' } })
    if (row === null) return { done: false, detail: 'no review run yet' }
    if (row.endedAt === null) return { done: false, detail: `the review run is ${row.status}` }
    const evidence = await evidenceFor(row.id)
    if (evidence === null) return { done: false, detail: 'the review run has concluded but has no row yet' }
    return { done: true, value: { run: row, evidence } }
  })
  console.log(`stage 2: the reviewer's row = ${describeEvidence(reviewRun.evidence)}`)
  await assertEqual(reviewRun.evidence.profileKey, PROFILE_REVIEWER, "stage 2: the bespoke reviewer's profile key")
  await assertEqual(reviewRun.evidence.profileName, reviewer.name, "stage 2: a bespoke profile's name is the worker's own")
  await assertEqual(
    [reviewRun.evidence.verifiedFirstPass, reviewRun.evidence.reviewRejected, reviewRun.evidence.integrated],
    [null, null, null],
    "stage 2: the reviewer's three judgement columns -- a reviewer receives no verdict",
  )

  // ---- Stage 1 (d): a run that failed at SPAWN leaves NO ROW AT ALL. ---------------------------
  // Driven, not reasoned about: a setup command that exits non-zero makes provisioning fail, and
  // `failToStart` concludes the row without ever calling the writer (D22). The workspace's own
  // `setupCommands` is the only per-dispatch lever a running daemon has, and it is put back the
  // moment the failed run is in hand.
  await prisma.workspace.update({ where: { id: workspace.id }, data: { setupCommands: ['exit 3'] } })
  const taskSpawn = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'M53 Gate Task Spawn Failure',
      description: 'Seeded by gate:m53-evidence — the dispatch that never starts.',
      status: 'ready',
      requiredRole: WORK_ROLE,
      requiredCapabilities: [STAFF_CAPABILITY],
      maxAttempts: 1,
    },
  })
  const spawnRun = await waitUntil('a run that failed at spawn', PIPELINE_TIMEOUT_MS, async () => {
    const row = await prisma.slaveRun.findFirst({ where: { taskId: taskSpawn.id }, orderBy: { startedAt: 'desc' } })
    if (row === null) return { done: false, detail: 'no run row for the spawn-failure task yet' }
    if (row.status !== 'failed') return { done: false, detail: `the run is ${row.status}` }
    return { done: true, value: row }
  })
  await prisma.workspace.update({ where: { id: workspace.id }, data: { setupCommands: [] } })
  console.log(`stage 1: the spawn failure is ${describeRun(spawnRun)} (setupCommands put back to [])`)
  await assertEqual(spawnRun.status, 'failed', 'stage 1: the status of a run whose provisioning failed')
  await assertEqual(await evidenceCountFor(spawnRun.id), 0, 'stage 1: evidence rows for a run that failed at SPAWN')
  console.log(
    'stage 1a PASSED: nothing while it was alive, exactly one the instant it concluded, still one after a second ' +
      'call by hand, and NOTHING AT ALL for a dispatch that never started -- nothing was attempted. (Erratum E25: ' +
      'the backfill in stage 5 agrees, and leaves that run recordless too -- a run with no `run.started` never ran. ' +
      'Sub-stages 1b to 1e below reach four more of the eight write sites.)',
  )

  await stopDaemon(daemonA)

  // ============================================================================================
  // PHASE B -- review-reject, and a verify scripted to fail once.
  // ============================================================================================
  console.log(runCli(['set-runtime-roles', '--slave', workerA.id, '--roles', '']).trim())
  console.log(runCli(['set-runtime-roles', '--slave', workerB.id, '--roles', WORK_ROLE]).trim())
  writeFileSync(verifyState, 'the next verify fails\n')
  console.log(`phase B: ${verifyState} seeded -- the first verify of this phase fails and removes it`)

  const daemonB = spawnDaemon('phase-b-daemon', workspace.id, { reviewFixture: 'review-reject' })

  const taskB1 = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'M53 Gate Task B1',
      description: 'Seeded by gate:m53-evidence — the task whose first verify says no.',
      status: 'ready',
      requiredRole: WORK_ROLE,
      requiredCapabilities: [STAFF_CAPABILITY],
      // TWO: attempt 1 fails verify, attempt 2 passes it and is rejected in review, and the third
      // rework the rejection would ask for is over the cap -- so this task produces exactly two
      // implementation runs and stops.
      maxAttempts: 2,
    },
  })
  console.log(`phase B: task ${taskB1.id} (${taskB1.title})`)

  const runB1 = await waitUntil("profile B's first run to be judged by the verify", PIPELINE_TIMEOUT_MS, async () => {
    const row = await prisma.slaveRun.findFirst({ where: { taskId: taskB1.id, kind: 'implementation' }, orderBy: { startedAt: 'asc' } })
    if (row === null) return { done: false, detail: 'no run row yet' }
    const evidence = await evidenceFor(row.id)
    if (evidence === null) return { done: false, detail: `the run is ${row.status} with no row yet` }
    if (evidence.verifiedFirstPass === null) return { done: false, detail: 'the verify verdict has not settled yet' }
    return { done: true, value: { run: row, evidence } }
  })
  console.log(`stage 2: profile B's FIRST row = ${describeEvidence(runB1.evidence)}`)
  await assertEqual(runB1.evidence.profileKey, PROFILE_B, "stage 2: profile B's key")
  await assertEqual(runB1.evidence.attempt, 1, "stage 2: profile B's first attempt")
  await assertEqual(runB1.evidence.verifiedFirstPass, false, 'stage 2: a run whose verify said no')

  const runB2 = await waitUntil("profile B's SECOND run to be judged by the verify", PIPELINE_TIMEOUT_MS, async () => {
    const row = await prisma.slaveRun.findFirst({
      where: { taskId: taskB1.id, kind: 'implementation', id: { not: runB1.run.id } },
      orderBy: { startedAt: 'desc' },
    })
    if (row === null) return { done: false, detail: 'no second run row yet' }
    const evidence = await evidenceFor(row.id)
    if (evidence === null) return { done: false, detail: `the second run is ${row.status} with no row yet` }
    if (evidence.verifiedFirstPass === null) return { done: false, detail: 'the second verify verdict has not settled yet' }
    return { done: true, value: { run: row, evidence } }
  })
  console.log(`stage 2: profile B's SECOND row = ${describeEvidence(runB2.evidence)}`)
  await assertEqual(runB2.evidence.attempt, 2, "stage 2: profile B's second attempt")
  await assertEqual(
    runB2.evidence.verifiedFirstPass,
    false,
    'stage 2: a run that PASSED the verify on attempt 2 -- passing late is not a first pass, which is the whole point of the column',
  )

  const rejected = await waitUntil('the review rejection to settle on the second run', PIPELINE_TIMEOUT_MS, async () => {
    const row = await evidenceFor(runB2.run.id)
    if (row.reviewRejected === null) return { done: false, detail: 'reviewRejected is still null' }
    return { done: true, value: row }
  })
  await assertEqual(rejected.reviewRejected, true, 'stage 2: the review verdict under --review-fixture review-reject')

  // The rework the first run's failure caused, re-derived by the backfill in stage 5, is the other
  // half of R4's derivation -- measured here where the events are: one `task.rework` above the first
  // run's own `run.started`.
  const reworkEvents = await prisma.executionEvent.findMany({
    where: { workspaceId: workspace.id, taskId: taskB1.id, type: dbType('task.rework') },
    orderBy: { seq: 'asc' },
  })
  console.log(`stage 2: ${String(reworkEvents.length)} task.rework event(s) on ${taskB1.id}`)
  if (reworkEvents.length < 1) await fail('stage 2: the failed verify did not produce a task.rework event, so attempt 2 was never an attempt')

  // A second task in phase B, with NO required capability: its row lands in `general` (R2), which is
  // the fallback a filter must still be able to show.
  const taskB2 = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'M53 Gate Task B2',
      description: 'Seeded by gate:m53-evidence — the task that asks for no capability at all.',
      status: 'ready',
      requiredRole: WORK_ROLE,
      requiredCapabilities: [],
      maxAttempts: 1,
    },
  })
  const runB3 = await waitUntil('the no-capability task to leave a row', PIPELINE_TIMEOUT_MS, async () => {
    const row = await prisma.slaveRun.findFirst({ where: { taskId: taskB2.id, kind: 'implementation' }, orderBy: { startedAt: 'desc' } })
    if (row === null) return { done: false, detail: 'no run row yet' }
    const evidence = await evidenceFor(row.id)
    if (evidence === null) return { done: false, detail: `the run is ${row.status} with no row yet` }
    return { done: true, value: { run: row, evidence } }
  })
  console.log(`stage 3: the no-capability row = ${describeEvidence(runB3.evidence)}`)
  await assertEqual(runB3.evidence.domains, [GENERAL_DOMAIN], 'stage 3: the domains of a task that asked for no capability')

  // ---- Stage 2, second half: from the SCHEMA, not from the log. ---------------------------------
  const slaveRunColumns = await prisma.$queryRaw`
    SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'SlaveRun'`
  const columnNames = slaveRunColumns.map((row) => row.column_name).sort()
  console.log(`stage 2: SlaveRun's columns = ${JSON.stringify(columnNames)}`)
  if (columnNames.includes('attempt')) {
    await fail('stage 2: `SlaveRun` has an `attempt` column -- R4 derives the attempt from the event log and stores it on the FACT')
  }
  const verifyEvents = await prisma.executionEvent.findMany({
    where: { workspaceId: workspace.id, type: { in: [dbType('task.verify_passed'), dbType('task.verify_failed')] } },
    orderBy: { seq: 'asc' },
  })
  const verifyPayloadKeys = [...new Set(verifyEvents.flatMap((row) => Object.keys(row.payload ?? {})))].sort()
  console.log(`stage 2: ${String(verifyEvents.length)} verify event(s), payload keys = ${JSON.stringify(verifyPayloadKeys)}`)
  if (verifyEvents.length === 0) await fail('stage 2: no verify event at all -- the schema half of this stage would be vacuous')
  if (verifyPayloadKeys.includes('attempt')) {
    await fail('stage 2: a verify event carries an `attempt` key -- R4 adds no new event field')
  }
  console.log(
    'stage 2 PASSED: first pass on attempt 1 for A, false on attempt 1 AND on the attempt-2 pass for B, a rejection ' +
      'on the run that earned it -- and neither the schema nor the event payloads gained a field to hold any of it',
  )

  await stopDaemon(daemonB)

  // ============================================================================================
  // PHASE C -- the three transitions a clean conclusion cannot reach, each named after its site.
  //
  // Stage 1 above proves the property at write site 4 (the pump's clean conclusion) and proves the
  // ABSENCE at a spawn failure. Four of the other six sites are reachable from a gate at a
  // reasonable cost, and these are them (Task 3's hand-off table, task-3-report.md:365-373):
  //
  //   1c -- `sweep.ts`'s `reconcileOrphans` (site 5), driven by a `working` run with no pid that a
  //         daemon's STARTUP pass finds. `recoveries` is the one column that tells a sweep's
  //         conclusion from a pump's.
  //   1b -- `stop.ts`'s `requestStop` (site 7, erratum E22 -- the newest site in the write path),
  //         driven by the operator's own `cancel --run` verb. Whichever of site 7 and the pump's
  //         stop claim (site 2) wins the race writes the fact, and the verb is idempotent on
  //         `runId @unique`, so the gate asserts ONE row rather than which side wrote it.
  //   1d -- `merge.ts`'s real merge (the integration settle), driven by `autoMerge: true` for this
  //         phase only. Every other `integrated` value in this gate is a settle the gate made by
  //         hand; this one is the site that settles it in production.
  //
  // The remaining two pump arms (the gate-failure halt and the stream-ended conclusion) are unit-
  // tested by Task 3; 1e below drives the second of them anyway, because a `failed` outcome written
  // by the PUMP is the one thing none of the stages above would ever produce.
  // ============================================================================================
  console.log(runCli(['set-runtime-roles', '--slave', workerB.id, '--roles', '']).trim())
  console.log(runCli(['set-runtime-roles', '--slave', workerA.id, '--roles', WORK_ROLE]).trim())

  // ---- 1c: the sweep's orphan arm (write site 5). ----------------------------------------------
  // Seeded BEFORE the daemon starts, because `reconcileOrphans` is the startup pass over runs with
  // no pid. No `taskId`: an orphan is a run whose process is gone, and this one is about the WRITE
  // site rather than about a task.
  const orphanRun = await prisma.slaveRun.create({
    data: {
      slaveId: workerE.id,
      status: 'working',
      kind: 'implementation',
      provider: 'claude_code',
      model: PIPELINE_MODEL,
      pid: null,
      startedAt: new Date(Date.now() - 60_000),
    },
  })
  console.log(`stage 1c: orphan run ${orphanRun.id} seeded on ${workerE.name} (working, no pid) -- the sweep's own subject`)

  const daemonC = spawnDaemon('phase-c-daemon', workspace.id, { reviewFixture: 'review-approve' })

  const orphanRow = await waitUntil("the sweep's orphan arm to leave a fact", PIPELINE_TIMEOUT_MS, async () => {
    const row = await evidenceFor(orphanRun.id)
    if (row === null) {
      const live = await runRow(orphanRun.id)
      return { done: false, detail: `the orphan is ${live.status} with no row yet` }
    }
    return { done: true, value: row }
  })
  console.log(`stage 1c: the sweep's row = ${describeEvidence(orphanRow)}`)
  await assertEqual(await evidenceCountFor(orphanRun.id), 1, 'stage 1c: rows for the swept run')
  await assertEqual(orphanRow.outcome, 'failed', "stage 1c: the outcome the sweep's orphan arm maps to")
  if (orphanRow.recoveries < 1) {
    await fail(
      `stage 1c: recoveries is ${String(orphanRow.recoveries)} -- the sweep calls the writer with ` +
        "`recoveredBySweep: true`, and that column is the only thing that tells its conclusion from a pump's",
    )
  }
  console.log(`stage 1c PASSED: a run nobody was driving was concluded by the sweep, and its row says so -- recoveries ${String(orphanRow.recoveries)}`)

  // ---- 1b: the operator's own stop (write site 7, erratum E22). ---------------------------------
  const taskC1 = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'M53 Gate Task C1',
      description: 'Seeded by gate:m53-evidence — the run a person stops.',
      status: 'ready',
      requiredRole: WORK_ROLE,
      requiredCapabilities: [STAFF_CAPABILITY],
      maxAttempts: 1,
    },
  })
  const liveRunId = await waitUntil('a live run for a person to stop', PIPELINE_TIMEOUT_MS, async () => {
    const row = await prisma.slaveRun.findFirst({ where: { taskId: taskC1.id, kind: 'implementation' }, orderBy: { startedAt: 'desc' } })
    if (row === null) return { done: false, detail: 'no run row yet' }
    if (row.status !== 'working') return { done: false, detail: `the run is ${row.status}` }
    const started = await prisma.executionEvent.count({ where: { runId: row.id, type: dbType('run.started') } })
    if (started === 0) return { done: false, detail: 'working, but no run.started event yet' }
    return { done: true, value: row.id }
  })
  // THE VERB A PERSON TYPES. `cancel --run` is control's `requestStop`, which concludes the run
  // itself and then calls the writer inside its own `concluded.count > 0` guard.
  console.log(runCli(['cancel', '--run', liveRunId]).trim())
  const stoppedRow = await waitUntil("the operator stop to leave a fact", PIPELINE_TIMEOUT_MS, async () => {
    const row = await evidenceFor(liveRunId)
    if (row === null) {
      const live = await runRow(liveRunId)
      return { done: false, detail: `the stopped run is ${live.status} with no row yet` }
    }
    return { done: true, value: row }
  })
  console.log(`stage 1b: the stopped run = ${describeRun(await runRow(liveRunId))}`)
  console.log(`stage 1b: its row = ${describeEvidence(stoppedRow)}`)
  await assertEqual(await evidenceCountFor(liveRunId), 1, 'stage 1b: rows for the stopped run -- ONE, whichever side won the race')
  await assertEqual(stoppedRow.outcome, 'stopped', 'stage 1b: the outcome of a run a person stopped')
  if (stoppedRow.humanInterventions < 1) {
    await fail(
      `stage 1b: humanInterventions is ${String(stoppedRow.humanInterventions)} -- a person reached in, and that is the ` +
        'whole subject of the column (R5b)',
    )
  }
  await assertEqual(stoppedRow.verifiedFirstPass, null, 'stage 1b: nobody judged a run that never finished')
  console.log(
    `stage 1b PASSED: ${EVIDENCE_OUTCOME_LABEL.stopped} — one row for the run a person stopped, with the intervention ` +
      `counted (${String(stoppedRow.humanInterventions)})`,
  )

  // ---- 1d: the merge pass's own integration settle. --------------------------------------------
  await prisma.workspace.update({ where: { id: workspace.id }, data: { autoMerge: true } })
  console.log('stage 1d: autoMerge switched ON for one task -- the merge pass is the site that settles `integrated` in production')
  const taskD1 = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'M53 Gate Task D1',
      description: 'Seeded by gate:m53-evidence — the task the merge pass really merges.',
      status: 'ready',
      requiredRole: WORK_ROLE,
      requiredCapabilities: [STAFF_CAPABILITY],
      maxAttempts: 2,
    },
  })
  const merged = await waitUntil('the merge pass to settle the integration column', PIPELINE_TIMEOUT_MS, async () => {
    const row = await prisma.slaveRun.findFirst({ where: { taskId: taskD1.id, kind: 'implementation' }, orderBy: { startedAt: 'desc' } })
    if (row === null) return { done: false, detail: 'no run row yet' }
    const evidence = await evidenceFor(row.id)
    if (evidence === null) return { done: false, detail: `the run is ${row.status} with no row yet` }
    if (evidence.integrated === null) {
      const task = await prisma.task.findUniqueOrThrow({ where: { id: taskD1.id } })
      return { done: false, detail: `the task is ${task.status} and integrated is still null` }
    }
    return { done: true, value: { run: row, evidence } }
  })
  const mergedTask = await prisma.task.findUniqueOrThrow({ where: { id: taskD1.id } })
  console.log(`stage 1d: the merged task is ${mergedTask.status}, integratedAt ${String(mergedTask.integratedAt?.toISOString() ?? null)}`)
  console.log(`stage 1d: its row = ${describeEvidence(merged.evidence)}`)
  await assertEqual(merged.evidence.integrated, true, 'stage 1d: the integration column, settled by the merge pass itself')
  if (mergedTask.integratedAt === null) {
    await fail('stage 1d: the row says the work was integrated and `Task.integratedAt` is null -- the two must agree (M35)')
  }
  await assertEqual(merged.evidence.verifiedFirstPass, true, 'stage 1d: and the verify verdict on the same row')
  console.log('stage 1d PASSED: the work reached the base branch and the column that says so was settled by the site that merged it')

  await stopDaemon(daemonC)
  await prisma.workspace.update({ where: { id: workspace.id }, data: { autoMerge: false } })
  console.log('stage 1d: autoMerge switched back OFF -- every other row in this gate reads `integrated: null`, which is the ordinary shape')

  // ============================================================================================
  // PHASE D (1e) -- a run the PUMP concluded as failed: the fake's `crash` MODE writes half a
  // stream and exits 1, and no `--work-fixture` can do this (every checked-in fixture ends with a
  // terminal `result` line). This is the only `failed` outcome in this gate written by the pump.
  // ============================================================================================
  const daemonD = spawnDaemon('phase-d-daemon', workspace.id, { fixture: 'crash' })
  const taskE1 = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'M53 Gate Task E1',
      description: 'Seeded by gate:m53-evidence — the run whose stream stops halfway.',
      status: 'ready',
      requiredRole: WORK_ROLE,
      requiredCapabilities: [STAFF_CAPABILITY],
      maxAttempts: 1,
    },
  })
  const crashed = await waitUntil('a run the pump concluded as failed', PIPELINE_TIMEOUT_MS, async () => {
    const row = await prisma.slaveRun.findFirst({ where: { taskId: taskE1.id, kind: 'implementation' }, orderBy: { startedAt: 'desc' } })
    if (row === null) return { done: false, detail: 'no run row yet' }
    const evidence = await evidenceFor(row.id)
    if (evidence === null) return { done: false, detail: `the run is ${row.status} with no row yet` }
    return { done: true, value: { run: row, evidence } }
  })
  console.log(`stage 1e: the crashed run = ${describeRun(crashed.run)}`)
  console.log(`stage 1e: its row = ${describeEvidence(crashed.evidence)}`)
  await assertEqual(crashed.run.status, 'failed', 'stage 1e: the status of a run whose stream stopped halfway')
  await assertEqual(crashed.evidence.outcome, 'failed', 'stage 1e: the outcome on its row')
  await assertEqual(await evidenceCountFor(crashed.run.id), 1, 'stage 1e: rows for the failed run')
  await assertEqual(crashed.evidence.recoveries, 0, "stage 1e: recoveries -- a pump's conclusion is not a recovery, which is what 1c's 1 means")
  const failedEvents = await prisma.executionEvent.count({ where: { runId: crashed.run.id, type: dbType('run.failed') } })
  await assertEqual(failedEvents, 1, 'stage 1e: run.failed rows for it')
  console.log(
    `stage 1e PASSED: ${EVIDENCE_OUTCOME_LABEL.failed} — the pump concluded a run nobody could finish, and the fact ` +
      'says so with no recovery claimed',
  )

  await stopDaemon(daemonD)

  // The three outcomes this milestone HAS, all of them now written by a real transition rather than
  // by this gate: a run that finished, one a person stopped, and two that failed (one concluded by
  // the sweep, one by the pump).
  const outcomes = await prisma.evidenceRecord.groupBy({ by: ['outcome'], where: { workspaceId: workspace.id }, _count: { _all: true } })
  console.log(`stage 1: the outcomes the pipeline wrote in this project = ${JSON.stringify(outcomes.map((row) => [row.outcome, row._count._all]))}`)
  await assertEqual(
    outcomes.map((row) => row.outcome).sort(),
    ['failed', 'stopped', 'succeeded'],
    'stage 1: the distinct outcomes a real pipeline left behind in this project',
  )

  const strayAfterPhases = findRealDaemonPids()
  console.log(`orchestrator daemons still running after every phase: ${JSON.stringify(strayAfterPhases)}`)
  if (strayAfterPhases.length > 0) await fail(`a daemon is still running (pid ${strayAfterPhases.join(', ')}) -- the rows below could move under this gate`)

  // ============================================================================================
  // The sample, topped up through the SAME writer -- see the header. Every row below is a real
  // `SlaveRun` handed to `recordRunEvidence` and settled by `recordRunEvidence`.
  // ============================================================================================
  const seedRun = async ({ slaveId, taskId, status = 'succeeded', model = PIPELINE_MODEL, costUsd = null, tokensIn = null, tokensOut = null, durationMs = 60_000 }) => {
    const endedAt = new Date()
    const startedAt = new Date(endedAt.getTime() - durationMs)
    const row = await prisma.slaveRun.create({
      data: {
        slaveId,
        ...(taskId === null ? {} : { taskId }),
        kind: 'implementation',
        status,
        provider: 'claude_code',
        model,
        pid: null,
        costUsd,
        tokensIn,
        tokensOut,
        startedAt,
        terminalAt: endedAt,
        endedAt,
      },
    })
    // THE RUN STARTED, and the event says so (erratum E25). Every row this gate seeds stands for a
    // run that really ran, and `run.started` is what separates one of those from a dispatch that
    // failed at spawn -- the distinction stage 5's backfill now makes. Appended BEFORE the write so
    // the derivation reads the same history a live run's would.
    await appendEvent({
      type: 'run.started',
      workspaceId: workspace.id,
      ...(taskId === null ? {} : { taskId }),
      slaveId,
      runId: row.id,
      actor: 'system',
      payload: { sessionId: `gate-m53-${row.id}` },
    })
    const recorded = await recordRunEvidence(row.id)
    if (!recorded.ok) await fail(`could not record the seeded run ${row.id}: ${JSON.stringify(recorded.error)}`)
    return row
  }
  const settle = async (runId, settleInput) => {
    const result = await recordRunEvidence(runId, { settle: settleInput })
    if (!result.ok) await fail(`could not settle ${runId} with ${JSON.stringify(settleInput)}: ${JSON.stringify(result.error)}`)
  }

  /** A task for seeded runs to hang their DOMAINS on -- the writer reads `Task.requiredCapabilities`
   *  and nothing else, so this is the same derivation the pipeline rows above went through. */
  const backendTask = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'M53 Gate Sample Task',
      description: 'Seeded by gate:m53-evidence — what the topped-up sample was nominally about.',
      status: 'done',
      requiredRole: WORK_ROLE,
      requiredCapabilities: [STAFF_CAPABILITY],
      maxAttempts: 1,
    },
  })

  // Profile A: five more runs, every one of them verified first time and approved in review.
  for (let i = 0; i < 5; i += 1) {
    const row = await seedRun({ slaveId: workerA.id, taskId: backendTask.id, costUsd: 0.05 })
    await settle(row.id, { kind: 'verify', verdict: 'passed' })
    await settle(row.id, { kind: 'review', verdict: 'approved', attempt: 1 })
  }
  // Profile B: three more, every one of them turned down by the verify.
  for (let i = 0; i < 3; i += 1) {
    const row = await seedRun({ slaveId: workerB.id, taskId: backendTask.id, costUsd: 0.05 })
    await settle(row.id, { kind: 'verify', verdict: 'failed' })
  }

  const counters = async (profileKey) => {
    const rows = await prisma.evidenceRecord.findMany({ where: { profileKey } })
    return {
      attempted: rows.length,
      firstPassJudged: rows.filter((row) => row.verifiedFirstPass !== null).length,
      firstPassPassed: rows.filter((row) => row.verifiedFirstPass === true).length,
      reviewJudged: rows.filter((row) => row.reviewRejected !== null).length,
      reviewRejected: rows.filter((row) => row.reviewRejected === true).length,
      integrationJudged: rows.filter((row) => row.integrated !== null).length,
    }
  }
  console.log(`the record: profile A (${templateA.name}) = ${JSON.stringify(await counters(PROFILE_A))}`)
  console.log(`the record: profile B (${templateB.name}) = ${JSON.stringify(await counters(PROFILE_B))}`)

  // ---- Profiles C, D and E: the shapes stage 9 is about. ---------------------------------------

  // C: two terminal runs. A sample that EXISTS and is too thin -- R11's own case.
  for (let i = 0; i < 2; i += 1) {
    const row = await seedRun({ slaveId: workerC.id, taskId: backendTask.id, costUsd: 0.02 })
    await settle(row.id, { kind: 'verify', verdict: 'passed' })
  }

  // D: eight attempts, eight verify verdicts, eight review verdicts and TWO integrations -- so its
  // integration rate is withheld while its neighbours in the same row are percentages. Its first
  // three runs carry the three cost provenances (stage 4).
  const dRuns = []
  dRuns.push(await seedRun({ slaveId: workerD.id, taskId: backendTask.id, model: PRICED_MODEL, costUsd: 0.25 }))
  dRuns.push(await seedRun({ slaveId: workerD.id, taskId: backendTask.id, model: PRICED_MODEL, costUsd: null, tokensIn: 1_000_000, tokensOut: 100_000 }))
  dRuns.push(await seedRun({ slaveId: workerD.id, taskId: backendTask.id, model: PRICED_MODEL, costUsd: null, tokensIn: null, tokensOut: null }))
  for (let i = 0; i < 5; i += 1) {
    dRuns.push(await seedRun({ slaveId: workerD.id, taskId: backendTask.id, model: PRICED_MODEL, costUsd: 0.1 }))
  }
  for (const [index, row] of dRuns.entries()) {
    await settle(row.id, { kind: 'verify', verdict: index === 7 ? 'failed' : 'passed' })
    await settle(row.id, { kind: 'review', verdict: index === 6 ? 'rejected' : 'approved', attempt: 1 })
  }
  await settle(dRuns[0].id, { kind: 'integration', integrated: true })
  await settle(dRuns[1].id, { kind: 'integration', integrated: false })

  // E: six concluded runs and NO record at all -- the backfill in stage 5 is what gives them one,
  // and E23 means it gives them no verdict. This is the row stage 9 reads the unjudged marker off.
  const eRuns = []
  for (let i = 0; i < 6; i += 1) {
    const row = await prisma.slaveRun.create({
      data: {
        slaveId: workerE.id,
        taskId: backendTask.id,
        kind: 'implementation',
        status: 'succeeded',
        provider: 'claude_code',
        model: PIPELINE_MODEL,
        pid: null,
        costUsd: 0.01,
        startedAt: new Date(Date.now() - 30_000),
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })
    // The same `run.started` every other seeded run carries (E25): these six stand for runs that
    // really ran on an installation that predates the record, which is exactly what the backfill
    // in stage 5 exists to fill in. Without it they would be indistinguishable from a dispatch that
    // never started, and the backfill would rightly skip them.
    await appendEvent({
      type: 'run.started',
      workspaceId: workspace.id,
      taskId: backendTask.id,
      slaveId: workerE.id,
      runId: row.id,
      actor: 'system',
      payload: { sessionId: `gate-m53-${row.id}` },
    })
    eRuns.push(row)
  }
  console.log(`stage 5: profile E (${templateE.name}) has ${String(eRuns.length)} concluded runs and no record at all -- the backfill's subject`)

  // ============================================================================================
  // Stage 4: money keeps its provenance.
  // ============================================================================================
  const costRows = []
  for (const row of dRuns.slice(0, 3)) costRows.push(await evidenceFor(row.id))
  for (const row of costRows) console.log(`stage 4: ${describeEvidence(row)}`)
  await assertEqual(
    costRows.map((row) => row.costProvenance),
    ['reported', 'estimated', 'unmeasured'],
    'stage 4: the three provenances, in one project',
  )
  await assertEqual(costRows[0].actualCostUsd, 0.25, 'stage 4: a REPORTED figure, verbatim from the run row')
  if (typeof costRows[1].actualCostUsd !== 'number' || costRows[1].actualCostUsd <= 0) {
    await fail(`stage 4: the ESTIMATED figure is ${JSON.stringify(costRows[1].actualCostUsd)}, expected a positive number from MODEL_PRICES`)
  }
  console.log(`stage 4: the estimated figure is ${String(costRows[1].actualCostUsd)} under ${PRICED_MODEL}`)
  // NULL AND NOT 0. Asserted as both, because `0 === null` is false in JS and true in a careless SQL
  // read, and "we did not measure this" is the whole of R6.
  await assertEqual(costRows[2].actualCostUsd, null, 'stage 4: an UNMEASURED figure -- null, never 0')
  if (costRows[2].actualCostUsd === 0) await fail('stage 4: the unmeasured figure is a zero standing in for a gap')
  console.log(
    `stage 4 PASSED: ${COST_PROVENANCE_WORD.reported}, ${COST_PROVENANCE_WORD.estimated} and ` +
      `${COST_PROVENANCE_WORD.unmeasured} on three rows of one project, and the unmeasured one has no figure at all ` +
      '(the page prints the words in stage 9)',
  )

  // ============================================================================================
  // Stage 6: nothing crosses from a simulation.
  // ============================================================================================
  const company = await prisma.company.create({ data: { name: COMPANY_NAME } })
  companyId = company.id
  const simulation = await prisma.simulationRun.create({
    data: {
      companyId: company.id,
      name: `M53 Gate Simulation ${STAMP}`,
      sector: 'software',
      seed: 53,
      definition: {},
      state: {},
    },
  })
  console.log(`stage 6: a real SimulationRun exists at ${simulation.id}`)
  const evidenceBeforeSimulation = await prisma.evidenceRecord.count()
  const refused = await recordRunEvidence(simulation.id)
  console.log(`stage 6: recordRunEvidence(<a real SimulationRun.id>) answered ${JSON.stringify(refused)}`)
  await assertEqual(refused.ok, false, "stage 6: the writer's answer when handed a simulation's own id")
  await assertEqual(refused.error.kind, 'run_not_found', 'stage 6: the refusal kind (plan erratum E3)')
  await assertEqual(await prisma.evidenceRecord.count(), evidenceBeforeSimulation, 'stage 6: EvidenceRecord rows after the refusal')

  // The source scan, re-run from here: the three nouns by NAME, in control's simulation modules.
  const simulationSources = (() => {
    const files = [join(repoRoot, 'packages/control/src/simulation.ts')]
    const dir = join(repoRoot, 'packages/control/src/simulation')
    const walk = (at) => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const path = join(at, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (path.endsWith('.ts')) files.push(path)
      }
    }
    if (existsSync(dir)) walk(dir)
    return files
  })()
  console.log(`stage 6: scanning ${String(simulationSources.length)} simulation source file(s) for EvidenceRecord / rankCandidates / StaffingPreference`)
  if (simulationSources.length < 2) await fail('stage 6: the simulation source scan found almost nothing to scan -- the paths moved')
  for (const file of simulationSources) {
    const source = readFileSync(file, 'utf8')
    const hit = /EvidenceRecord|rankCandidates|StaffingPreference/u.exec(source)
    if (hit !== null) await fail(`stage 6: ${file} mentions ${hit[0]} -- nothing in the simulation reaches this milestone's tables`)
  }
  // And no fact anywhere came from a simulation row: every `EvidenceRecord.runId` is a `SlaveRun.id`.
  const unmatched = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count FROM "EvidenceRecord" e LEFT JOIN "SlaveRun" r ON r.id = e."runId" WHERE r.id IS NULL`
  await assertEqual(unmatched[0].count, 0, 'stage 6: EvidenceRecord rows whose runId is not a SlaveRun')
  console.log('stage 6 PASSED: a simulation\'s own id is refused before any write, the boundary scan is clean, and every fact names a real run')

  // ============================================================================================
  // Stage 5: the backfill records history, is idempotent to the byte, and never judges it.
  // ============================================================================================
  // "Concluded" is a STATUS everywhere in this milestone, and the array asked is the SAME one
  // `evidenceOutcomeOf` and the backfill's own walk read -- never a `terminalAt` predicate, which is
  // the trap Task 4's fix round removed.
  //
  // AND "IT RAN" IS AN EVENT (erratum E25). A concluded run with no `run.started` never started --
  // a dispatch that failed at spawn -- and the pipeline writes no fact for it, so the backfill must
  // not either. The two lists below are therefore kept apart: the runs a pass SHOULD create, and
  // the runs it must leave alone however often it is run.
  const startedRunIds = async () =>
    new Set(
      (await prisma.executionEvent.findMany({ where: { type: dbType('run.started') }, select: { runId: true } }))
        .map((row) => row.runId)
        .filter((id) => id !== null),
    )
  const concludedRunIds = async () =>
    (
      await prisma.slaveRun.findMany({
        where: { status: { notIn: [...NON_TERMINAL_RUN_STATUSES] } },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((row) => row.id)
  const recordedRunIds = async () =>
    new Set((await prisma.evidenceRecord.findMany({ select: { runId: true } })).map((row) => row.runId))
  const concludedWithoutRow = async () => {
    const [concluded, recorded, started] = [await concludedRunIds(), await recordedRunIds(), await startedRunIds()]
    return concluded.filter((id) => !recorded.has(id) && started.has(id))
  }
  // Every concluded run with no `run.started`, whether or not it already carries a row: that is
  // exactly the set the walk counts as `never started`. One of them here DOES have a row -- 1c's
  // orphan, seeded by hand as a run with no process and concluded by the sweep, which wrote its
  // fact at the moment it swept it. Being skipped by the repair pass is the correct answer for it
  // too: the row is already there and this script would only re-derive it.
  const neverStartedConcluded = async () => {
    const [concluded, started] = [await concludedRunIds(), await startedRunIds()]
    return concluded.filter((id) => !started.has(id))
  }
  const neverStartedWithoutRow = async () => {
    const recorded = await recordedRunIds()
    return (await neverStartedConcluded()).filter((id) => !recorded.has(id))
  }
  const expectedCreated = await concludedWithoutRow()
  const expectedNeverStarted = await neverStartedConcluded()
  const expectedRecordless = await neverStartedWithoutRow()
  console.log(`stage 5: ${String(expectedCreated.length)} concluded run(s) that STARTED carry no record yet: ${JSON.stringify(expectedCreated)}`)
  console.log(`stage 5: ${String(expectedNeverStarted.length)} concluded run(s) NEVER STARTED: ${JSON.stringify(expectedNeverStarted)}`)
  console.log(`stage 5: of those, ${String(expectedRecordless.length)} carry no record and must still carry none afterwards: ${JSON.stringify(expectedRecordless)}`)
  if (!expectedCreated.includes(eRuns[0].id)) {
    await fail("stage 5: profile E's runs are not among the unrecorded concluded runs -- the stage would not be measuring a backfill")
  }
  // The spawn failure stage 1 asserted has no row. It is a run that never started, so it is the
  // subject of the OTHER half of E25 -- and the backfill has to leave it exactly as stage 1 left it.
  if (!expectedRecordless.includes(spawnRun.id)) {
    await fail(`stage 5: the spawn-failure run ${spawnRun.id} is not among the never-started unrecorded runs -- E25's two halves are not both measurable here`)
  }

  // (a) A dry run writes NOTHING and says what it cannot know.
  const rowsBeforeDry = await prisma.evidenceRecord.count()
  const dry = runBackfill(['--dry-run'])
  console.log(`stage 5: --dry-run printed:\n${dry.stdout}`)
  await assertEqual(dry.status, 0, "stage 5: --dry-run's exit status -- it attempts nothing, so it skips nothing")
  await assertEqual(await prisma.evidenceRecord.count(), rowsBeforeDry, 'stage 5: EvidenceRecord rows after --dry-run')
  for (const id of expectedCreated) {
    if (!dry.stdout.includes(`would record run ${id}`)) await fail(`stage 5: --dry-run did not name ${id} among the runs it would create`)
  }
  if (!dry.stdout.includes('--dry-run: nothing was written')) await fail('stage 5: --dry-run did not say that nothing was written')
  if (!dry.stdout.includes('history is recorded, not judged')) await fail('stage 5: --dry-run did not say that history is recorded and never judged (E23)')
  // ...and it does NOT offer to create a run that never started (E25). A dry run counts those --
  // the decision is a read it really makes -- and must never name one among the rows it would write.
  for (const id of expectedRecordless) {
    if (dry.stdout.includes(`would record run ${id}`)) {
      await fail(`stage 5: --dry-run offered to record ${id}, a run with no run.started event -- nothing was ever attempted on it (E25)`)
    }
  }
  if (!new RegExp(`never started ${String(expectedNeverStarted.length)}\\b`, 'u').test(dry.stdout)) {
    await fail(`stage 5: --dry-run did not report \`never started ${String(expectedNeverStarted.length)}\`: ${JSON.stringify(dry.stdout)}`)
  }

  // (b) The real pass creates exactly those rows.
  const first = runBackfill([])
  console.log(`stage 5: the first real pass printed:\n${first.stdout}`)
  const createdMatch = /created (\d+)/u.exec(first.stdout)
  if (createdMatch === null) await fail(`stage 5: the summary line has no \`created N\` in it: ${JSON.stringify(first.stdout)}`)
  await assertEqual(Number(createdMatch[1]), expectedCreated.length, 'stage 5: the rows the backfill created')
  await assertEqual(await concludedWithoutRow(), [], 'stage 5: concluded runs that STARTED and still carry no record')
  // E25, the half a repair script could quietly get wrong: the runs that never started are still
  // there, still concluded, and still carry no fact -- the same answer stage 1 asserted of the live
  // pipeline. A profile's `attempted` count now says the same thing whether or not this ran.
  await assertEqual(await neverStartedWithoutRow(), expectedRecordless, 'stage 5: never-started runs after a real pass -- unchanged, and still unrecorded')
  await assertEqual(await evidenceCountFor(spawnRun.id), 0, 'stage 5: evidence rows for the spawn failure, after the backfill (E25)')
  if (!new RegExp(`never started ${String(expectedNeverStarted.length)}\\b`, 'u').test(first.stdout)) {
    await fail(`stage 5: the real pass did not report \`never started ${String(expectedNeverStarted.length)}\`: ${JSON.stringify(first.stdout)}`)
  }

  // The other half of stage 2's derivation, and the only place it can honestly be measured: a row is
  // written when its run concludes, and the `task.rework` its failed verify causes is appended
  // AFTER that -- so `reworkCycles` on profile B's first row is 0 when the pump writes it and 1 the
  // moment anything re-derives it. The backfill is that anything, and this is what "derived, never
  // stored at the moment of the event" costs and buys.
  const rederivedB1 = await evidenceFor(runB1.run.id)
  console.log(`stage 2/5: profile B's first row, re-derived by the backfill = ${describeEvidence(rederivedB1)}`)
  await assertEqual(rederivedB1.reworkCycles, 1, "stage 2/5: the rework profile B's failed verify caused, on the row it belongs to")
  await assertEqual(rederivedB1.attempt, 1, "stage 2/5: and its attempt, unmoved -- a rework ABOVE this run's start is not an attempt below it")
  await assertEqual(rederivedB1.verifiedFirstPass, false, 'stage 2/5: and its verdict, which the backfill never touched (E23)')

  // ...and it JUDGED none of them (E23).
  // The SIX runs profile E was seeded with, by id -- not "every row of profile E", because sub-stage
  // 1c's swept orphan is a profile-E row too and the SWEEP wrote that one, not the backfill.
  const backfilledE = await prisma.evidenceRecord.findMany({
    where: { runId: { in: eRuns.map((row) => row.id) } },
    orderBy: { runId: 'asc' },
  })
  console.log(`stage 5: profile E's backfilled rows = ${JSON.stringify(backfilledE.map((row) => ({ runId: row.runId, attempt: row.attempt, verifiedFirstPass: row.verifiedFirstPass, reviewRejected: row.reviewRejected, integrated: row.integrated, settledAt: row.settledAt })))}`)
  await assertEqual(backfilledE.length, eRuns.length, "stage 5: profile E's rows after the backfill")
  for (const row of backfilledE) {
    await assertEqual(
      [row.verifiedFirstPass, row.reviewRejected, row.integrated, row.settledAt],
      [null, null, null, null],
      'stage 5: a backfilled run\'s judgement columns -- history is recorded, never judged (E23)',
    )
  }

  // (c) The SECOND pass creates nothing and every row is byte-equal, `recordedAt` included.
  const snapshot = async () => {
    const rows = await prisma.evidenceRecord.findMany({ orderBy: { runId: 'asc' } })
    return JSON.stringify(rows, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  }
  const beforeSecond = await snapshot()
  const second = runBackfill([])
  console.log(`stage 5: the second real pass printed:\n${second.stdout}`)
  // THE EXIT STATUS, ONCE, ON THE PASS THAT MATTERS: `0` is "nothing was skipped", and the script
  // exits 1 the moment a run reaches the writer and is refused. A second pass that created nothing
  // AND skipped nothing is what "safe to run on a live database" means.
  await assertEqual(second.status, 0, "stage 5: the second pass's exit status -- nothing created, and nothing skipped either")
  if (!second.stdout.includes('created 0')) await fail(`stage 5: the second pass did not report \`created 0\`: ${JSON.stringify(second.stdout)}`)
  const afterSecond = await snapshot()
  if (beforeSecond !== afterSecond) {
    await fail('stage 5: the second pass changed at least one row -- the backfill is not idempotent to the byte')
  }
  console.log(`stage 5: the whole table is byte-equal across two passes (${String(beforeSecond.length)} characters of JSON, recordedAt included)`)

  // (d) TWO HALVES OF ONE RULE (erratum E25), on one run, in order.
  //
  // First: a run with NO `run.started` is a run that never started, and the backfill leaves it
  // alone -- the same answer the pipeline's own spawn-failure arms give, which is the whole point
  // of having one rule instead of two. Then, with the event put back: a run that DID start and
  // whose history is otherwise incomplete is recorded honestly, with zeros in the event-derived
  // counters and nulls in the three judgement columns. The REVIEW run is the subject on purpose:
  // its judgement columns are null by the writer's own rule (D16), so what this measures is the
  // backfill's own derivation and not a verdict it inherited.
  const startedEvents = await prisma.executionEvent.findMany({ where: { runId: reviewRun.run.id, type: dbType('run.started') } })
  const removedStarted = await prisma.executionEvent.deleteMany({ where: { runId: reviewRun.run.id, type: dbType('run.started') } })
  const removedRow = await prisma.evidenceRecord.deleteMany({ where: { runId: reviewRun.run.id } })
  console.log(`stage 5: removed ${String(removedStarted.count)} run.started event(s) and ${String(removedRow.count)} row(s) for review run ${reviewRun.run.id}`)
  const skippedPass = runBackfill([])
  console.log(`stage 5: the pass over a run with no run.started printed:\n${skippedPass.stdout}`)
  await assertEqual(await evidenceCountFor(reviewRun.run.id), 0, 'stage 5: rows for a run with no run.started event -- it never started, so it has no fact (E25)')
  if (!new RegExp(`never started ${String(expectedNeverStarted.length + 1)}\\b`, 'u').test(skippedPass.stdout)) {
    await fail(`stage 5: the pass did not count the review run among the never started: ${JSON.stringify(skippedPass.stdout)}`)
  }

  // The event back, exactly as it was -- the run really did run, and the gate is not allowed to
  // leave this database saying otherwise.
  const wasStarted = startedEvents[0]
  if (wasStarted === undefined) await fail('stage 5: the review run had no run.started event to remove -- (d) would measure nothing')
  await appendEvent({
    type: 'run.started',
    workspaceId: workspace.id,
    taskId: wasStarted.taskId,
    slaveId: wasStarted.slaveId,
    runId: reviewRun.run.id,
    actor: 'system',
    payload: wasStarted.payload,
  })
  const third = runBackfill([])
  console.log(`stage 5: the pass over a run whose history is incomplete printed:\n${third.stdout}`)
  const repaired = await evidenceFor(reviewRun.run.id)
  console.log(`stage 5: the repaired row = ${describeEvidence(repaired)}`)
  if (repaired === null) await fail('stage 5: a run that started, whose other events are gone, got no row at all')
  await assertEqual(
    [repaired.attempt, repaired.reworkCycles, repaired.humanInterventions, repaired.recoveries],
    [1, 0, 0, 0],
    'stage 5: the four event-derived counters on a run whose events are incomplete',
  )
  await assertEqual(
    [repaired.verifiedFirstPass, repaired.reviewRejected, repaired.integrated],
    [null, null, null],
    'stage 5: its three judgement columns',
  )
  console.log(
    'stage 5 PASSED: a dry run wrote nothing and said what it could not know, the real pass created exactly the ' +
      'rows history was missing and NOT ONE row for a run that never started (E25 -- the spawn failure stage 1 ' +
      'asserted is still recordless), a second pass was byte-equal to the first, and nothing anywhere was judged by it',
  )

  // ============================================================================================
  // Stage 7: the record decides, a person overrules it, and clearing it gives the record back.
  // ============================================================================================
  await prisma.workspace.update({ where: { id: workspace.id }, data: { supervisorEnabled: true } })
  const staffingTask = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'M53 Gate Staffing Task',
      description: 'Seeded by gate:m53-evidence — the gap the Supervisor is asked to fill.',
      status: 'ready',
      // A role NOBODY holds, so the task is never dispatched and the capability stays a gap.
      requiredRole: STAFF_DOMAIN,
      requiredCapabilities: [STAFF_CAPABILITY],
      maxAttempts: 1,
    },
  })
  console.log(`stage 7: the gap is ${staffingTask.id}, which asks for ${STAFF_CAPABILITY} and is dispatchable by nobody`)

  const permissionRows = async () =>
    (await prisma.slavePermission.findMany({
      where: { slaveId: { in: [workerA.id, workerB.id] } },
      select: { slaveId: true, kind: true, mode: true },
      orderBy: [{ slaveId: 'asc' }, { kind: 'asc' }],
    })).map((row) => `${row.slaveId === workerA.id ? 'A' : 'B'}:${row.kind}=${row.mode}`)

  /**
   * One `supervise` pass, and the staffing proposal it wrote.
   *
   * TWO fixture chores around it, both stated rather than hidden. (1) A routine `assign_capability`
   * is APPLIED by the pass -- it grants the winner the role the capability projects to -- so the gap
   * would be covered and the next pass would have nothing to decide; the roles are put back.
   * (2) `recordDecision` holds one decision per situation key for `COOLDOWN_MS` (15 minutes, M38's
   * own rule and not this milestone's), so the previous pass's rows are removed before the next.
   * Neither is what this stage measures, and the log says so every time.
   */
  const superviseOnce = async (label) => {
    await prisma.slave.update({ where: { id: workerA.id }, data: { runtimeRoles: [] } })
    await prisma.slave.update({ where: { id: workerB.id }, data: { runtimeRoles: [] } })
    const removed = await prisma.supervisorDecision.deleteMany({ where: { workspaceId: workspace.id } })
    console.log(`${label}: reset both workers' runtime roles and removed ${String(removed.count)} earlier decision(s) (M38's cooldown is not what this stage measures)`)
    const permissionsBefore = await permissionRows()
    const report = runCli(['supervise', '--workspace', workspace.id])
    console.log(`${label}: supervise printed:\n${report.trim()}`)
    const decision = await waitUntil(`${label}: a capability_unstaffed decision`, ACTION_TIMEOUT_MS, async () => {
      const row = await prisma.supervisorDecision.findFirst({
        where: { workspaceId: workspace.id, situationKind: 'capability_unstaffed', subjectId: STAFF_CAPABILITY },
        orderBy: { createdAt: 'desc' },
      })
      if (row === null) {
        const all = await prisma.supervisorDecision.count({ where: { workspaceId: workspace.id } })
        return { done: false, detail: `${String(all)} decision(s), none of them capability_unstaffed(${STAFF_CAPABILITY})` }
      }
      return { done: true, value: row }
    })
    // The RANKER's sentence is the chosen candidate's own `why` -- `formTeam`'s rationale with the
    // step that decided appended. The row's `rationale` COLUMN is whatever decided the row (the
    // model seam's sentence when a model was asked), which is a different fact and is printed too.
    const chosen = decision.candidates[decision.chosenIndex]
    console.log(`${label}: action = ${JSON.stringify(decision.action)}`)
    console.log(`${label}: the ranker's sentence = ${JSON.stringify(chosen?.why ?? null)}`)
    console.log(`${label}: the decision's own rationale column = ${JSON.stringify(decision.rationale)}`)
    const permissionsAfter = await permissionRows()
    console.log(`${label}: SlavePermission before = ${JSON.stringify(permissionsBefore)}, after = ${JSON.stringify(permissionsAfter)}`)
    if (JSON.stringify(permissionsBefore) !== JSON.stringify(permissionsAfter)) {
      await fail(`${label}: a staffing pass moved SlavePermission -- the Supervisor may point at a wall, never move one`)
    }
    return { decision, why: chosen?.why ?? '' }
  }

  const whoIs = (slaveId) => (slaveId === workerA.id ? 'A (Ada)' : slaveId === workerB.id ? 'B (Bo)' : slaveId)

  const byRecord = await superviseOnce('stage 7 (no preference)')
  await assertEqual(byRecord.decision.action.kind, 'assign_capability', 'stage 7: the kind of offer a capable worker gets')
  console.log(`stage 7: with no preference the Supervisor proposes ${whoIs(byRecord.decision.action.slaveId)}`)
  await assertEqual(byRecord.decision.action.slaveId, workerA.id, 'stage 7: WHO the record proposes')
  if (!byRecord.why.includes('passes verification first time more often')) {
    await fail(`stage 7: the sentence does not name the RECORD as what decided: ${JSON.stringify(byRecord.why)}`)
  }

  // A person chooses, through the verb a person types.
  console.log(runCli(['staffing', 'prefer', '--workspace', workspace.id, '--capability', STAFF_CAPABILITY, '--template', templateB.id, '--by', GATE_USERNAME]).trim())
  const byPreference = await superviseOnce('stage 7 (preference on B)')
  await assertEqual(byPreference.decision.action.slaveId, workerB.id, "stage 7: WHO a person's choice proposes")
  if (!byPreference.why.includes('somebody chose')) {
    await fail(`stage 7: the sentence does not say a person chose: ${JSON.stringify(byPreference.why)}`)
  }
  if (!byPreference.why.includes(STAFF_LABEL)) {
    await fail(`stage 7: the sentence does not name the capability's WORD (${STAFF_LABEL}): ${JSON.stringify(byPreference.why)}`)
  }
  if (byPreference.why.includes(STAFF_CAPABILITY)) {
    await fail(`stage 7: the sentence prints the raw key ${STAFF_CAPABILITY} at a person: ${JSON.stringify(byPreference.why)}`)
  }
  const staffingList = runCli(['staffing', 'list', '--workspace', workspace.id])
  console.log(`stage 7: staffing list printed:\n${staffingList.trim()}`)
  if (!staffingList.includes(`by ${GATE_USERNAME}`)) await fail('stage 7: `staffing list` does not name the person who asked')
  if (!staffingList.includes(STAFF_LABEL)) await fail("stage 7: `staffing list` does not print the capability's word")

  // ...and taking it back gives the record the decision again.
  console.log(runCli(['staffing', 'clear', '--workspace', workspace.id, '--capability', STAFF_CAPABILITY, '--by', GATE_USERNAME]).trim())
  const backToRecord = await superviseOnce('stage 7 (preference cleared)')
  await assertEqual(backToRecord.decision.action.slaveId, workerA.id, 'stage 7: WHO the record proposes once the choice is taken back')

  const preferenceEvents = await prisma.executionEvent.findMany({
    where: { workspaceId: workspace.id, type: dbType('staffing.preference_changed') },
    orderBy: { seq: 'asc' },
  })
  console.log(`stage 7: staffing.preference_changed payloads = ${JSON.stringify(preferenceEvents.map((row) => row.payload))}`)
  await assertEqual(preferenceEvents.length, 2, 'stage 7: staffing.preference_changed rows on the timeline')
  await assertEqual(preferenceEvents[0].payload.from, null, 'stage 7: the first event\'s `from`')
  await assertEqual(preferenceEvents[0].payload.to.templateId, templateB.id, "stage 7: the first event's `to`")
  await assertEqual(preferenceEvents[0].payload.by, gateUserId, 'stage 7: who the first event says asked')
  await assertEqual(preferenceEvents[1].payload.to, null, 'stage 7: the CLEAR, which is a `to` of null')
  await assertEqual(preferenceEvents[1].payload.from.templateId, templateB.id, "stage 7: the clear's `from`")
  await assertEqual(preferenceEvents[0].payload.capabilityLabel, STAFF_LABEL, 'stage 7: the WORD on the payload')
  console.log('stage 7 PASSED: the record proposed A, a person\'s choice proposed B and said so in words, and clearing it brought A back')

  // ============================================================================================
  // Stage 8: a preference never moves the wall, and never moves the queue.
  // ============================================================================================
  console.log(runCli(['staffing', 'prefer', '--workspace', workspace.id, '--capability', STAFF_CAPABILITY, '--template', templateB.id, '--by', GATE_USERNAME]).trim())
  const permissionsBeforeDeny = await permissionRows()
  console.log(runCli(['permission', 'deny', '--slave', workerB.id, '--kind', WALLED_KIND, '--by', GATE_USERNAME]).trim())
  const permissionsAfterDeny = await permissionRows()
  console.log(`stage 8: SlavePermission before the deny = ${JSON.stringify(permissionsBeforeDeny)}, after = ${JSON.stringify(permissionsAfterDeny)}`)
  await assertEqual(permissionsAfterDeny, [`B:${WALLED_KIND}=deny`], 'stage 8: the rows a person wrote')

  const byWall = await superviseOnce('stage 8 (a refusal over the preference)')
  await assertEqual(byWall.decision.action.slaveId, workerA.id, 'stage 8: WHO is proposed when the preferred worker has been refused what the work needs')
  if (!byWall.why.includes('has been refused an operation this work needs')) {
    await fail(`stage 8: the sentence does not name the refusal as what decided: ${JSON.stringify(byWall.why)}`)
  }

  // Take the wall back down -- through the verb, not the table.
  console.log(runCli(['permission', 'revoke', '--slave', workerB.id, '--kind', WALLED_KIND, '--by', GATE_USERNAME]).trim())
  await assertEqual(await permissionRows(), [], 'stage 8: the rows after the person took the refusal back')

  // ...and a BUSY preferred candidate is not a preference for this dispatch.
  const busyRun = await prisma.slaveRun.create({
    data: { slaveId: workerB.id, status: 'working', kind: 'implementation', provider: 'claude_code', model: PIPELINE_MODEL, pid: null },
  })
  console.log(`stage 8: ${busyRun.id} makes Bo busy (no daemon is running, so nothing will conclude it)`)
  const byAvailability = await superviseOnce('stage 8 (a busy favourite)')
  await assertEqual(byAvailability.decision.action.slaveId, workerA.id, 'stage 8: WHO is proposed when the preferred worker is busy')
  if (!byAvailability.why.includes('is free and')) {
    await fail(`stage 8: the sentence does not name availability as what decided: ${JSON.stringify(byAvailability.why)}`)
  }
  await assertEqual(await permissionRows(), [], 'stage 8: SlavePermission after every staffing pass in this stage')
  console.log(
    'stage 8 PASSED: a refusal beat the preference, a busy favourite lost to somebody free, and the only two ' +
      'movements of SlavePermission in the whole stage were the deny and the revoke a person typed',
  )

  // The CLI's own read of the record, for the "no score anywhere" half of stage 10.
  const evidenceListing = runCli(['evidence', 'list', '--workspace', workspace.id])
  console.log(`stage 10: \`evidence list --workspace\` printed ${String(evidenceListing.split('\n').filter((line) => line.trim() !== '').length)} line(s); the first three:`)
  console.log(evidenceListing.split('\n').slice(0, 3).join('\n'))
  for (const word of ['score', 'rating', 'rank', 'index']) {
    if (new RegExp(`\\b${word}`, 'iu').test(evidenceListing)) {
      await fail(`stage 10: \`evidence list\` prints the word ${word} -- there is no universal score anywhere (R11)`)
    }
  }
  // ALL THREE outcome words, which this project now really has (sub-stages 1b, 1c and 1e), and NONE
  // of the three enum members as a field of its own -- the CLI is the other surface `docs/ia.md`
  // rule 3 applies to, and a run that finished says `Finished` rather than `succeeded`.
  const listingFields = new Set(evidenceListing.split('\n').flatMap((line) => line.split('\t').map((field) => field.trim())))
  for (const outcome of EVIDENCE_OUTCOMES) {
    if (!evidenceListing.includes(EVIDENCE_OUTCOME_LABEL[outcome])) {
      await fail(`stage 10: \`evidence list\` does not print the outcome LABEL ${JSON.stringify(EVIDENCE_OUTCOME_LABEL[outcome])}`)
    }
    if (listingFields.has(outcome)) {
      await fail(`stage 10: \`evidence list\` prints the raw enum member ${JSON.stringify(outcome)} as a field of its own`)
    }
  }
  if (!evidenceListing.includes(domainLabel(QA_DOMAIN))) {
    await fail(`stage 10: \`evidence list\` does not print the domain LABEL ${JSON.stringify(domainLabel(QA_DOMAIN))}`)
  }
  console.log(
    `stage 10: the CLI prints ${JSON.stringify(EVIDENCE_OUTCOMES.map((outcome) => EVIDENCE_OUTCOME_LABEL[outcome]))} and ` +
      `${JSON.stringify(domainLabel(QA_DOMAIN))}, no raw enum member in any field, and no score of any kind`,
  )

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

  /** Every by-profile row on the Evidence tab, as the browser sees it: the cells' own text, the
   *  attributes that carry the raw values, the markers and the bars. */
  const readProfileRows = async () =>
    await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="evidence-profile-row-"]')].map((wrapper) => {
        const row = wrapper.querySelector('[data-testid="data-table-row"]')
        const cells = [...(row?.children ?? [])].map((cell) => ({
          text: (cell.textContent ?? '').trim(),
          title: cell.getAttribute('title'),
          innerTitles: [...cell.querySelectorAll('[title]')].map((node) => node.getAttribute('title')),
        }))
        return {
          profileKey: wrapper.getAttribute('data-profile-key'),
          repositoryKey: wrapper.getAttribute('data-repository-key'),
          // The NAME alone -- the first span inside the name cell. `cells[0].text` carries the
          // `Bespoke` chip's word too, which is a different thing and is read as `nameCellText`.
          name: (row?.firstElementChild?.firstElementChild?.textContent ?? '').trim(),
          nameCellText: (cells[0]?.text ?? '').trim(),
          attempted: Number(cells[2]?.text ?? 'NaN'),
          cells,
          insufficient: wrapper.querySelector('[data-testid^="evidence-insufficient-"]')?.getAttribute('data-testid') ?? null,
          unjudged: wrapper.querySelector('[data-testid^="evidence-unjudged-"]')?.getAttribute('data-testid') ?? null,
          bespoke: wrapper.querySelector('[data-testid="evidence-bespoke"]') !== null,
          bars: wrapper.querySelectorAll('[data-testid="progress-bar"]').length,
          valued: wrapper.querySelectorAll('[data-testid="progress-bar"][aria-valuenow]').length,
        }
      }),
    )

  const rowFor = (rows, profileKey) => rows.find((row) => row.profileKey === profileKey && row.repositoryKey === repositoryKey)

  // ============================================================================================
  // Stage 3: one run, two domains, counted under both chips -- and the counts do not sum.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/workforce?tab=evidence`)
  await waitVisible(page.getByTestId('evidence-table-profile'), 'the by-profile evidence table')
  const unfiltered = await readProfileRows()
  console.log(`stage 3: ${String(unfiltered.length)} by-profile row(s) unfiltered`)
  const aUnfiltered = rowFor(unfiltered, PROFILE_A)
  if (aUnfiltered === undefined) await fail(`stage 3: no row for ${PROFILE_A} at ${repositoryKey}: ${JSON.stringify(unfiltered.map((row) => row.profileKey))}`)
  console.log(`stage 3: profile A unfiltered = ${JSON.stringify({ name: aUnfiltered.name, attempted: aUnfiltered.attempted })}`)

  await gotoReliably(`${baseUrl}/workforce?tab=evidence&domain=${STAFF_DOMAIN}`)
  await waitVisible(page.getByTestId('evidence-table-profile'), `the by-profile table under ${STAFF_DOMAIN}`)
  const backendRows = await readProfileRows()
  const aBackend = rowFor(backendRows, PROFILE_A)
  if (aBackend === undefined) await fail(`stage 3: profile A has no row under ?domain=${STAFF_DOMAIN}`)

  await gotoReliably(`${baseUrl}/workforce?tab=evidence&domain=${QA_DOMAIN}`)
  await waitVisible(page.getByTestId('evidence-table-profile'), `the by-profile table under ${QA_DOMAIN}`)
  const qaRows = await readProfileRows()
  const aQa = rowFor(qaRows, PROFILE_A)
  if (aQa === undefined) await fail(`stage 3: profile A has no row under ?domain=${QA_DOMAIN}`)

  console.log(
    `stage 3: profile A attempted = ${String(aUnfiltered.attempted)} unfiltered, ${String(aBackend.attempted)} under ` +
      `${STAFF_DOMAIN}, ${String(aQa.attempted)} under ${QA_DOMAIN}`,
  )
  await assertEqual(aQa.attempted, 1, `stage 3: the runs of profile A that touched ${QA_DOMAIN} -- the one two-domain task`)
  if (aBackend.attempted + aQa.attempted <= aUnfiltered.attempted) {
    await fail(
      `stage 3: the two filtered counts (${String(aBackend.attempted)} + ${String(aQa.attempted)}) do NOT exceed the ` +
        `unfiltered total (${String(aUnfiltered.attempted)}) -- a domain is a FILTER and a two-domain run must be ` +
        'counted under both chips',
    )
  }
  // The row itself is ONE row, not one per domain: the total is not the sum, and the row's own
  // identity is the same under either chip.
  await assertEqual(aBackend.repositoryKey, aQa.repositoryKey, 'stage 3: the same row under either chip')
  const qaChip = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="evidence-domain-qa"]')
    return node === null ? null : { text: (node.textContent ?? '').trim(), domain: node.getAttribute('data-domain'), title: node.getAttribute('title'), pressed: node.getAttribute('aria-pressed') }
  })
  console.log(`stage 3: the ${QA_DOMAIN} chip = ${JSON.stringify(qaChip)}`)
  await assertEqual(qaChip.text, domainLabel(QA_DOMAIN), 'stage 3: the chip prints the WORD')
  await assertEqual(qaChip.domain, QA_DOMAIN, 'stage 3: the chip carries the key on data-domain')
  await assertEqual(qaChip.pressed, 'true', 'stage 3: the chip says it is the one selected')
  console.log(
    `stage 3 PASSED: one run in two domains is one row under both chips, ${String(aBackend.attempted)} + ` +
      `${String(aQa.attempted)} > ${String(aUnfiltered.attempted)}, and a task that asked for nothing landed in ` +
      `${GENERAL_DOMAIN}`,
  )

  // ============================================================================================
  // Stages 9, 10 and 11: the words, the keys and the sort -- all on the unfiltered tab.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/workforce?tab=evidence`)
  await waitVisible(page.getByTestId('evidence-table-profile'), 'the by-profile evidence table')
  const rows = await readProfileRows()
  for (const row of rows) {
    console.log(
      `stage 9: row ${String(row.profileKey)} (${row.name}) attempted=${String(row.attempted)} ` +
        `marker=${String(row.insufficient ?? row.unjudged ?? 'none')} bars=${String(row.bars)} valued=${String(row.valued)} ` +
        `firstPass=${JSON.stringify(row.cells[3]?.text)} review=${JSON.stringify(row.cells[4]?.text)} ` +
        `integrated=${JSON.stringify(row.cells[6]?.text)} cost=${JSON.stringify(row.cells[10]?.text)}`,
    )
  }

  // (a) The thin row: a sample that exists and is too thin.
  const cRow = rowFor(rows, PROFILE_C)
  if (cRow === undefined) await fail(`stage 9: no row for the two-run profile ${PROFILE_C}`)
  await assertEqual(cRow.attempted, 2, 'stage 9: the thin profile\'s attempts')
  await assertEqual(cRow.insufficient, `evidence-insufficient-${PROFILE_C}`, 'stage 9: the marker a row below the floor carries')
  await assertEqual(cRow.unjudged, null, 'stage 9: and it carries no unjudged marker -- a row wears at most one')
  await assertEqual(cRow.bars, 0, 'stage 9: progress bars on a row that claims no rate')
  await assertEqual(cRow.cells[3].text, INSUFFICIENT_EVIDENCE, 'stage 9: what a thin rate says instead of a percentage')
  await assertEqual(cRow.cells[3].title, '2 judged so far', 'stage 9: and how thin, one hover away')
  await assertEqual(cRow.cells[6].text, 'not judged yet', 'stage 9: what a rate with a ZERO denominator says -- a different fact')

  // (b) The unjudged row: attempts enough, and nobody has reached a verdict on any of them (E23).
  const eRow = rowFor(rows, PROFILE_E)
  if (eRow === undefined) await fail(`stage 9: no row for the backfilled profile ${PROFILE_E}`)
  if (eRow.attempted < EVIDENCE_MIN_SAMPLE) {
    await fail(`stage 9: the backfilled profile has ${String(eRow.attempted)} attempts, which is under the floor -- it would be marked thin instead of unjudged`)
  }
  await assertEqual(eRow.unjudged, `evidence-unjudged-${PROFILE_E}`, 'stage 9: the marker a backfilled row carries')
  await assertEqual(eRow.insufficient, null, 'stage 9: and not the thin marker')
  await assertEqual(eRow.bars, 0, 'stage 9: progress bars on a row nobody has judged')
  await assertEqual(eRow.cells[3].text, 'not judged yet', 'stage 9: what a backfilled run says about its verify column')

  // (c) The REAL judged row: percentages beside a withheld rate, in the same row.
  const dRow = rowFor(rows, PROFILE_D)
  if (dRow === undefined) await fail(`stage 9: no row for the eight-run profile ${PROFILE_D}`)
  await assertEqual(dRow.attempted, 8, "stage 9: the ample profile's attempts")
  await assertEqual([dRow.insufficient, dRow.unjudged], [null, null], 'stage 9: a row that claims a rate carries neither marker')
  if (!/^\d+%of\d+$/u.test(dRow.cells[3].text.replaceAll(/\s+/gu, ''))) {
    await fail(`stage 9: the ample profile's first-pass cell is ${JSON.stringify(dRow.cells[3].text)}, expected a percentage and its denominator`)
  }
  if (!/^\d+%of\d+$/u.test(dRow.cells[4].text.replaceAll(/\s+/gu, ''))) {
    await fail(`stage 9: the ample profile's review cell is ${JSON.stringify(dRow.cells[4].text)}, expected a percentage`)
  }
  await assertEqual(dRow.cells[6].text, INSUFFICIENT_EVIDENCE, 'stage 9: a single thin rate beside two percentages in the SAME row')
  await assertEqual(dRow.cells[6].title, '2 judged so far', 'stage 9: and its own denominator, one hover away')
  if (!(dRow.bars === dRow.valued && dRow.valued > 0)) {
    await fail(`stage 9: the claiming row draws ${String(dRow.bars)} bar(s), ${String(dRow.valued)} of them valued -- every bar must carry a value`)
  }
  // Money, on the page, with the words beside the figures and the unmeasured count on its own line.
  console.log(`stage 4/9: the ample profile's cost cell reads ${JSON.stringify(dRow.cells[10].text)}`)
  for (const word of [COST_PROVENANCE_WORD.reported, COST_PROVENANCE_WORD.estimated, `1 ${COST_PROVENANCE_WORD.unmeasured}`]) {
    if (!dRow.cells[10].text.includes(word)) {
      await fail(`stage 4: the cost cell does not say ${JSON.stringify(word)}: ${JSON.stringify(dRow.cells[10].text)}`)
    }
  }

  // (d) The PAIR, over every row on the page -- `gate:m16-chrome` check 5's own partition, proved
  // here against a table a real pipeline wrote rather than against a seeded database's empty one.
  const marked = rows.filter((row) => row.insufficient !== null || row.unjudged !== null)
  const claiming = rows.filter((row) => row.insufficient === null && row.unjudged === null)
  for (const row of marked) {
    if (row.bars !== 0) await fail(`stage 9: ${String(row.profileKey)} claims no rate and still draws ${String(row.bars)} bar(s)`)
  }
  for (const row of claiming) {
    if (!(row.bars === row.valued && row.valued > 0)) {
      await fail(`stage 9: ${String(row.profileKey)} carries no marker but draws ${String(row.bars)} bar(s), ${String(row.valued)} valued`)
    }
  }
  if (marked.length === 0 || claiming.length === 0) {
    await fail(
      `stage 9: only one branch exists on this page (${String(marked.length)} marked, ${String(claiming.length)} ` +
        'claiming) -- the pair is what makes the check non-vacuous',
    )
  }
  console.log(
    `stage 9 PASSED: ${String(marked.length)} row(s) claim nothing and draw no bar, ${String(claiming.length)} claim ` +
      'at least one rate and draw a valued bar for each, and the two phrases mean two different things',
  )

  // ---- Stage 10: no raw key is visible text on EITHER table, and no column is a score. ----------
  //
  // ONE FOCUSED LIST PER TABLE (fix round 1, review item 2). A guard against a value that cannot
  // reach the column it guards is decoration, and decoration in a gate reads as coverage. The
  // by-profile table's columns are Profile · Repository · Attempted · three rates · three counts ·
  // Median duration · Cost, so an `EvidenceOutcome` member or a domain key could never be a whole
  // cell's text there -- those are asserted where they CAN appear: the outcome and provenance words
  // in `evidence list`'s output (above), and the domain keys on the chip row (stage 3, where the
  // chip's text is the LABEL and the key is on `data-domain` and `title`).
  //
  // What CAN go wrong on a cell of either table, and is therefore what is checked:
  //   - a profile key printed instead of the profile's name (the uuid regex, and the exact keys);
  //   - a JavaScript non-value leaking into a rate, a count or a figure (`null` is a MEANING in
  //     three of these columns and must always be rendered as words, never as the word `null`);
  //   - a bare provenance word with no figure beside it in the Cost cell, which is the raw
  //     `SUM(costUsd)` R6 deleted wearing a word.
  const NON_VALUES = ['null', 'undefined', 'NaN', 'true', 'false', '[object Object]']
  const PROVENANCE_WORDS = Object.values(COST_PROVENANCE_WORD)
  const profileRawValues = new Set([
    PROFILE_A, PROFILE_B, PROFILE_C, PROFILE_D, PROFILE_E, PROFILE_REVIEWER,
    ...NON_VALUES,
    ...PROVENANCE_WORDS,
  ])
  const KEY_PATTERN = /template:[0-9a-f-]{36}|slave:[0-9a-f-]{36}/u
  for (const row of rows) {
    for (const [index, cell] of row.cells.entries()) {
      if (profileRawValues.has(cell.text)) {
        await fail(`stage 10: cell ${String(index)} of ${String(row.profileKey)} is the raw value ${JSON.stringify(cell.text)} as VISIBLE text`)
      }
      if (KEY_PATTERN.test(cell.text)) {
        await fail(`stage 10: cell ${String(index)} of ${String(row.profileKey)} prints a raw profile key: ${JSON.stringify(cell.text)}`)
      }
    }
    // ...and the key IS there, where a raw value belongs.
    if (!row.cells[0].innerTitles.includes(row.profileKey)) {
      await fail(`stage 10: ${String(row.profileKey)} is not on any title in its own name cell: ${JSON.stringify(row.cells[0].innerTitles)}`)
    }
  }
  const reviewerRow = rowFor(rows, PROFILE_REVIEWER)
  if (reviewerRow === undefined) await fail(`stage 10: no row for the bespoke reviewer ${PROFILE_REVIEWER}`)
  await assertEqual(reviewerRow.bespoke, true, 'stage 10: a worker hired from no template wears the Bespoke chip')
  await assertEqual(reviewerRow.name, reviewer.name, "stage 10: a bespoke profile's name is the worker's own, never `slave:<id>`")
  await assertEqual(reviewerRow.nameCellText, `${reviewer.name}${BESPOKE_PROFILE_LABEL}`, 'stage 10: the whole name cell -- a NAME and a word, never a key')

  const headers = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="data-table-header"]')].map((header) =>
      [...header.querySelectorAll('[data-testid="data-table-header-cell"]')].map((cell) => (cell.textContent ?? '').trim()),
    ),
  )
  console.log(`stage 10: the tab's table headers = ${JSON.stringify(headers)}`)
  await assertEqual(headers.length, 2, 'stage 10: how many tables the tab draws')
  for (const header of headers) {
    for (const label of header) {
      if (/\b(score|rating|rank|index)\b/iu.test(label)) {
        await fail(`stage 10: a column is called ${JSON.stringify(label)} -- there is no universal score (R11)`)
      }
    }
  }
  // ---- The by-model table, cell by cell -- the brief says BOTH tables. -------------------------
  //
  // A model id IS the label here (`sonnet`, `claude-sonnet-5`): that column names a thing whose own
  // name is its id, and `docs/ia.md` rule 3 is about keys a person cannot read. The one row on this
  // table whose key is not a word is the NULL-model group, and the rule for it is the opposite:
  // it must say `Model not recorded` and never an empty cell, a `null`, or a blank.
  const modelRows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="evidence-model-row-"]')].map((wrapper) => {
      const row = wrapper.querySelector('[data-testid="data-table-row"]')
      return {
        model: wrapper.getAttribute('data-model'),
        cells: [...(row?.children ?? [])].map((cell) => (cell.textContent ?? '').trim()),
        label: (row?.firstElementChild?.textContent ?? '').trim(),
        title: row?.firstElementChild?.getAttribute('title') ?? null,
      }
    }),
  )
  console.log(`stage 10: the by-model rows = ${JSON.stringify(modelRows)}`)
  if (modelRows.length === 0) await fail('stage 10: the by-model table has no rows at all')
  const modelRawValues = new Set([...NON_VALUES, ...PROVENANCE_WORDS, ''])
  for (const row of modelRows) {
    for (const [index, text] of row.cells.entries()) {
      if (modelRawValues.has(text)) {
        await fail(`stage 10: cell ${String(index)} of the by-model row ${JSON.stringify(row.model)} reads ${JSON.stringify(text)} -- a cell says a word or a figure`)
      }
      if (KEY_PATTERN.test(text)) {
        await fail(`stage 10: the by-model row ${JSON.stringify(row.model)} prints a raw profile key: ${JSON.stringify(text)}`)
      }
    }
  }
  const nullModelRow = modelRows.find((row) => row.model === '')
  if (nullModelRow === undefined) {
    console.log('stage 10: no null-model group on this table -- every run in this database recorded the model it ran on')
  } else {
    await assertEqual(nullModelRow.label, MODEL_NOT_RECORDED_LABEL, 'stage 10: what the null-model group calls itself')
    await assertEqual(nullModelRow.title, null, 'stage 10: and it carries no title, because there is no id to put in one')
  }
  const namedModelRow = modelRows.find((row) => row.model !== '')
  if (namedModelRow === undefined) await fail('stage 10: every by-model row is the null group -- the named-model half is unasserted')
  await assertEqual(namedModelRow.label, namedModelRow.model, 'stage 10: a model names itself -- its id IS its word')
  await assertEqual(namedModelRow.title, namedModelRow.model, 'stage 10: and it is on the title too')
  console.log(
    `stage 10 PASSED: ${String(rows.length)} by-profile and ${String(modelRows.length)} by-model rows, every visible ` +
      'cell a word or a figure, every key on a title or a data- attribute, and no column on either table a score',
  )

  // ---- Stage 11: the sort is what the caption says. --------------------------------------------
  const caption = (await page.getByTestId('evidence-sort-caption').textContent())?.trim() ?? ''
  console.log(`stage 11: the caption reads ${JSON.stringify(caption)}`)
  const lower = caption.toLowerCase()
  if (!lower.includes('most runs first')) await fail(`stage 11: the caption does not claim "most runs first": ${JSON.stringify(caption)}`)
  if (!lower.includes('name')) await fail(`stage 11: the caption does not claim a name tie-break: ${JSON.stringify(caption)}`)
  console.log(`stage 11: the rendered order = ${JSON.stringify(rows.map((row) => ({ name: row.name, attempted: row.attempted })))}`)
  for (let i = 1; i < rows.length; i += 1) {
    const before = rows[i - 1]
    const now = rows[i]
    if (before.attempted < now.attempted) {
      await fail(`stage 11: ${before.name} (${String(before.attempted)}) is above ${now.name} (${String(now.attempted)}) -- the caption claims most runs first`)
    }
    if (before.attempted === now.attempted && before.name.localeCompare(now.name) > 0) {
      await fail(`stage 11: ${before.name} is above ${now.name} on equal counts -- the caption claims a name tie-break`)
    }
  }
  console.log(`stage 11 PASSED: ${String(rows.length)} rows in the order the caption's own words claim`)

  // ============================================================================================
  // Stage 12: the analytics tiles handed over.
  // ============================================================================================
  const readTiles = async () =>
    await page.evaluate(() => ({
      tiles: [...document.querySelectorAll('[data-testid="kpi-tile"]')].map((node) => ({
        label: (node.firstElementChild?.textContent ?? '').trim(),
        text: (node.textContent ?? '').trim(),
      })),
      perf: [...document.querySelectorAll('[data-testid]')]
        .map((node) => node.getAttribute('data-testid') ?? '')
        .filter((id) => id.startsWith('perf-')),
      evidenceLink: document.querySelector('[data-testid="evidence-link"]')?.getAttribute('href') ?? null,
      evidenceText: document.querySelector('[data-testid="evidence-link"]')?.textContent?.trim() ?? null,
      slavePerformance: document.body.innerHTML.toLowerCase().includes('slave performance'),
    }))

  await gotoReliably(`${baseUrl}/analytics`)
  await waitVisible(page.getByTestId('kpi-tile').first(), 'the analytics KPI strip')
  const global = await readTiles()
  console.log(`stage 12: /analytics tiles = ${JSON.stringify(global.tiles.map((tile) => tile.label))}`)
  await assertEqual(global.tiles.length, 5, 'stage 12: how many KPI tiles /analytics draws')
  if (global.tiles.some((tile) => tile.label === 'Spend')) await fail('stage 12: /analytics still has a Spend tile -- R6 deleted the raw SUM(costUsd)')
  await assertEqual(global.perf, [], 'stage 12: perf-* testids anywhere in the DOM')
  await assertEqual(global.slavePerformance, false, 'stage 12: a `slave performance` panel anywhere on the page')
  await assertEqual(global.evidenceLink, '/workforce?tab=evidence', 'stage 12: where the hand-over line points')
  console.log(`stage 12: the hand-over reads ${JSON.stringify(global.evidenceText)}`)
  const spendNote = await page.evaluate(() => document.querySelector('[data-testid="kpi-note-Spend"]') !== null)
  await assertEqual(spendNote, false, 'stage 12: the Spend tile\'s own note')

  // The Projects home renders the same five from the same builder.
  await gotoReliably(`${baseUrl}/`)
  await waitVisible(page.getByTestId('kpi-tile').first(), "the Projects home's KPI strip")
  const home = await readTiles()
  console.log(`stage 12: the Projects home's tiles = ${JSON.stringify(home.tiles.map((tile) => tile.label))}`)
  await assertEqual(home.tiles.length, 5, 'stage 12: how many KPI tiles the Projects home draws')
  await assertEqual(
    home.tiles.map((tile) => tile.label),
    global.tiles.map((tile) => tile.label),
    'stage 12: the same five labels, from the same builder',
  )

  // ...and `?workspace=` still SCOPES rather than merely being accepted.
  const scopedResponse = await gotoReliably(`${baseUrl}/analytics?workspace=${workspace.id}`)
  await waitVisible(page.getByTestId('kpi-tile').first(), 'the scoped analytics KPI strip')
  await assertEqual(scopedResponse === null ? 200 : scopedResponse.status(), 200, 'stage 12: the status of /analytics?workspace=<id>')
  const scoped = await readTiles()
  console.log(`stage 12: scoped tiles = ${JSON.stringify(scoped.tiles.map((tile) => tile.text))}`)
  console.log(`stage 12: global tiles = ${JSON.stringify(global.tiles.map((tile) => tile.text))}`)
  await assertEqual(scoped.tiles.length, 5, 'stage 12: how many tiles the scoped page draws')
  const differing = scoped.tiles.filter((tile, index) => tile.text !== global.tiles[index]?.text).map((tile) => tile.label)
  console.log(`stage 12: the tiles whose figures differ between the global page and the scoped one = ${JSON.stringify(differing)}`)
  if (differing.length === 0) {
    await fail('stage 12: every scoped tile reads exactly what the global one does -- `?workspace=` was accepted and not applied')
  }
  console.log(
    `stage 12 PASSED: five tiles and no Spend, no per-slave table and no perf-* handle anywhere, a link to the ` +
      `Evidence tab, the same five on the Projects home, and ?workspace= still narrows (${JSON.stringify(differing)})`,
  )

  // ============================================================================================
  // The last thing measured: this gate left NOTHING in the operator's own state root (M52 C1).
  // ============================================================================================
  const operatorRunDirsAfter = operatorRunDirs()
  const leaked = operatorRunDirsAfter.filter((name) => !operatorRunDirsBefore.includes(name))
  console.log(
    `operator state root: ${operatorRunsDir} holds ${String(operatorRunDirsAfter.length)} run director(ies) after this ` +
      `gate (${String(operatorRunDirsBefore.length)} before)`,
  )
  if (leaked.length > 0) {
    await fail(
      `this gate left ${String(leaked.length)} run director(ies) in the operator's own state root ${operatorRunsDir}: ` +
        `${JSON.stringify(leaked.slice(0, 10))}${leaked.length > 10 ? ' …' : ''}`,
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
  for (const id of templateIds) await prisma.slaveTemplate.delete({ where: { id } }).catch(() => {})
  if (companyId !== null) {
    await prisma.simulationRun.deleteMany({ where: { companyId } }).catch(() => {})
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {})
  }
  if (gateUserId !== null) {
    await prisma.executionEvent.updateMany({ where: { userId: gateUserId }, data: { userId: null } }).catch(() => {})
    await deleteUser(gateUserId).catch(() => {})
    await prisma.user.delete({ where: { id: gateUserId } }).catch(() => {})
  }
  for (const path of repoPaths) rmSync(path, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
