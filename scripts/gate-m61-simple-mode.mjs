// M61's own gate (spec §5): "two modes, one frame that never scrolls, and nothing was removed".
//
// `gate-m57-ui-redesign.mjs`'s shape, which is `gate-m44-ux-foundation.mjs`'s, which is
// `gate-m16-chrome.mjs`'s: a free port, a real `next dev`, a real Chromium through
// `playwright-core` at CHROMIUM_PATH, no daemon.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m61-simple-mode
//
// THIS GATE SPENDS NOTHING AND CANNOT. It dispatches no run, so no CLI is ever invoked -- and the
// preflight still REFUSES to start unless SLAVEOFAI_CLAUDE_BIN points at an executable under
// `scripts/gate-fakes/` and SLAVEOFAI_REQUIRE_FAKE_CLI=1, so a later stage that grows a run cannot
// quietly reach a real account (Decision 10, M32 item 7).
//
// IT WRITES FIXTURE ROWS AND DELETES THEM IN `finally`, in FK order. The fixture is
// `gate-m57-ui-redesign.mjs`'s, verbatim in shape (plan erratum E7 says so, and says why: stages
// 2-10 of this gate need exactly the world that one already builds) -- two workspaces, one task in
// each of the five columns' statuses, a pending `SupervisorDecision`, two `workspace.goal_set`
// events one of them backdated a day, and a staffed catalog company with two `createSimulation`
// runs -- plus ONE ADDITION this milestone needs: a live `SlaveRun` in `working` on the seeded
// slave, attached to the `running` task, so stage 5 has a card whose `data-progress` is a real
// number off `lib/progress.ts` rather than a bar nobody drew. `git status` after a green run has
// to be empty.
//
// The eleven stages (spec §5):
//   1. NO FLASH. A stored `mode=developer` is on `<html>` from the FIRST mutation anybody can
//      observe, and it is never taken off again -- the pre-hydration `<head>` clause stamps it and
//      `ModeProvider`'s `hydrated` guard leaves it alone (R1).
//   2. FIXED VIEWPORT. Every route §2 names, both modes, 1440x900 and 1024x680:
//      `scrollingElement.scrollHeight === clientHeight` (and the same for width), with a
//      `ui/ScrollArea` on the page to do the scrolling instead (R4).
//   3. THE SWITCH. `mode-toggle` flips `data-mode`, moves `--accent` and grows the tab set from
//      four to six; `Mod+Shift+D` does the same; simple survives a reload as the ABSENCE of the
//      attribute (R1, R18).
//   4. HOME. The needs-you rows link into the project they belong to, the project rows ARE the
//      database's non-archived workspaces, and no feed sentence prints a bare event type (R11).
//   5. TEAM. One `team-card` per seat, an English `doing` sentence, a real progress number on the
//      live run's card, and `/w/:id/organization` landing on `/w/:id` with `organization-*` on it
//      (R7, R8).
//   6. THE SUPERVISOR. Open by default, remembered closed across a reload, re-opened by `Mod+J`,
//      and an overlay below 1280 (R14).
//   7. THE SHEET. `new-project` opens it, `Escape` closes it, focus goes back where it was, and a
//      reduced-motion visitor gets no transform transition (R15).
//   8. PEOPLE. Simple mode: `hire-from-catalogue` opens the catalogue in a Sheet, a row opens the
//      person in a Sheet with `?slave=` behind it, and `sheet-close` puts both back (R12).
//   9. THE OFFICE. A glass toolbar, and no mono/pixel type anywhere in the DOM around the canvas
//      in simple mode (R17).
//  10. RULE 2. Every route `docs/ia.md`'s tables name, every `?tab=` and `?view=` value, in BOTH
//      modes: 200, with the frame (or, for `/login`, its own marker).
//  11. VOCABULARY AND IMPORTS. `gate:m26-vocabulary` exits 0, `motion` is imported by at most the
//      two files R15 allows, and nothing animates `all`.
//
// SPEC READINGS THIS GATE MAKES, so a reader does not have to re-derive them:
//   - §5 stage 7 says "`new-project` opens `sheet`". A `Sheet`'s testid is the CALLER's
//     (`new-project-sheet`, `hire-sheet`, `person-sheet`); `sheet-close` is the shared close.
//     That is spec erratum E10, and it is why stage 7 asserts `new-project-sheet`.
//   - The same is true of `ui/ScrollArea`: `testId` defaults to `scroll-area` but Home's list
//     passes `home-projects`, the board passes `board-scroll`, `DataTable` passes
//     `data-table-rows`. Stage 2 therefore reads the primitive's OWN marker, `data-scroll-axis`,
//     which every `ScrollArea` stamps whatever its caller called it -- the same reading E10 makes
//     for `Sheet`, applied to the other primitive whose testid is the caller's.
//   - §5 stage 7 says a reduced-motion sheet's computed `transition-property` "has no
//     `transform`". `transition-property`'s INITIAL VALUE in CSS is the keyword `all`, so a panel
//     that declares no transition at all reads back as `all` with a `0s` duration -- the literal
//     reading fails a build that is doing exactly what R15 asks. Stage 7 measures the claim
//     instead: no transform-affecting property has a non-zero duration, no keyframe animation is
//     running, and the panel is not drawn offset -- the slide really did collapse to a fade.
//   - §5 stage 11 says the `motion` grep "lists exactly `ui/Sheet.tsx` and `ui/motion.ts`".
//     `ui/motion.ts` ships as PLAIN NUMBERS and imports nothing (Task 4's own docstring says why:
//     the dependency then stays load-bearing in one file rather than two). The claim R15 actually
//     makes is a CEILING -- "only `ui/Sheet.tsx` and `ui/motion.ts` import from `motion`, so a
//     later decision to drop the dependency is a two-file change" -- so this stage asserts the
//     ceiling (every hit is one of those two) and that the Sheet is in it. A third file importing
//     `motion` still fails here, which is the whole point of the grep.
//
// THE GATE ASSERTS, IT NEVER FIXES. Every stage prints every measured value before asserting it.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: like `gate-m14-fidelity.mjs`,
// `gate-m16-chrome.mjs`, `gate-m44-ux-foundation.mjs` and `gate-m57-ui-redesign.mjs`, it boots
// `next dev` against the repo's own `apps/web/.next` on a freshly-chosen free port, and a second
// `next dev` sharing that directory corrupts the on-disk build cache for both. Stop any running
// dev server first (`pgrep -af "next dev"`).

import { execFileSync, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { chromium } from 'playwright-core'
import { createSimulation } from '../packages/control/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'
import { CAPABILITY_SEED } from '../packages/db/dist/capabilities.js'
import { EVENT_TYPE_BY_DOMAIN_TYPE, RUN_STATUSES, TASK_STATUSES } from '../packages/db/dist/enums.js'
import {
  BREAKER_LEVELS,
  BREAKER_TRIP_KINDS,
  DECISION_STATUSES,
  GUARDRAIL_KINDS,
  MEMORY_SCOPES,
  MEMORY_SOURCE_KINDS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  SITUATION_KINDS,
  SLAVE_LIFECYCLES,
  TIERS,
} from '../packages/domain/dist/index.js'
import { PROVIDER_KINDS } from '../packages/providers/dist/index.js'

const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 250

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const PASS_LINE = 'two modes, one frame that never scrolls, and nothing was removed'

// Suffixed per run (the `gate-m10-org.mjs` idiom `gate-m44` and `gate-m57` also use):
// `Workspace.name` IS unique, and a distinct name per run keeps two overlapping executions from
// colliding on it. `preflightCleanup` removes leftovers by PREFIX.
const STAMP = new Date().toISOString().slice(11, 19)
const WORKSPACE_PREFIX = 'M61 Gate Project'
const WORKSPACE_NAME = `${WORKSPACE_PREFIX} A ${STAMP}`
const OTHER_WORKSPACE_NAME = `${WORKSPACE_PREFIX} B ${STAMP}`
const TEAM_NAME = 'M61 Gate Department'
const SLAVE_NAME = 'M61 Gate Worker'
const TEMPLATE_PREFIX = 'M61 Gate Clerk'
const TEMPLATE_NAME = `${TEMPLATE_PREFIX} ${STAMP}`
const COMPANY_PREFIX = 'M61 Gate Trading'
const COMPANY_NAME = `${COMPANY_PREFIX} ${STAMP}`
const SIMULATION_A_NAME = `m61 gate A ${STAMP}`
const SIMULATION_B_NAME = `m61 gate B ${STAMP}`
/** The trade sector's own roster shape (`gate-m29-simulation.mjs`'s ROSTER, which `gate-m44` and
 *  `gate-m57` also copy): four departments, one catalog slave each, which is what
 *  `plugin.rosterFits` asks for. */
const SIM_ROSTER = [
  ['Sales', 'M61 Gate Sonia'],
  ['Purchasing', 'M61 Gate Pete'],
  ['Operations', 'M61 Gate Olga'],
  ['Finance', 'M61 Gate Fin'],
]

/** Every person this gate creates, by the name it creates them under -- the teardown's list. */
const GATE_PERSON_NAMES = [SLAVE_NAME, ...SIM_ROSTER.map(([, memberName]) => memberName)]

const SEEDED_REQUEST_YESTERDAY = 'Please add a printable invoice to the billing page'
const SEEDED_REQUEST_TODAY = 'Also let the invoice be emailed from the same screen'

/** The title of the task the seeded live run is working on. Stage 5 reads it back off the card's
 *  `doing` sentence, which is the claim R8 makes about that sentence: the live run's TASK TITLE,
 *  never an enum member. */
const RUNNING_TASK_TITLE = 'M61 gate task for In progress'

/**
 * The six tab ids `lib/routes.ts`'s `TABS` declares, in its order (spec R18).
 *
 * RE-DECLARED rather than imported, for the reason `gate-m57-ui-redesign.mjs` gives about
 * `COLUMN_FOR_STATUS`: `apps/web` compiles with `noEmit: true` under a bundler resolver, so there
 * is no built output a plain `node` script can load. `apps/web/test/integration/gate-surface-parity.test.ts`
 * PINS this array against `TABS` itself, so the copy cannot drift.
 */
const TAB_IDS = ['team', 'tasks', 'office', 'activity', 'graph', 'knowledge']

/** What `tabsFor('simple')` answers -- the first four. */
const SIMPLE_TAB_IDS = ['team', 'tasks', 'office', 'activity']

/**
 * The forbidden tokens, DERIVED from the shipped packages' own unions rather than typed here --
 * `gate-m44-ux-foundation.mjs`'s stage-4 blocklist, which `gate-m57` copies for the same reason:
 * every member that carries an underscore or a dot, which is every member a person could not have
 * written by accident. Stages 4 and 5 use it on the two sentences this milestone INVENTED --
 * Home's feed line and a Team card's `doing` line.
 */
const MEMORY_UNIONS = [...MEMORY_TYPES, ...MEMORY_SCOPES, ...MEMORY_STATUSES, ...MEMORY_SOURCE_KINDS]

const RAW_TOKENS = [
  ...TASK_STATUSES,
  ...RUN_STATUSES,
  ...SITUATION_KINDS,
  ...DECISION_STATUSES,
  ...TIERS,
  ...PROVIDER_KINDS,
  ...CAPABILITY_SEED.map((record) => record.key),
  ...Object.values(EVENT_TYPE_BY_DOMAIN_TYPE),
  ...Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE),
  ...MEMORY_UNIONS,
  ...SLAVE_LIFECYCLES,
  ...GUARDRAIL_KINDS,
  ...BREAKER_LEVELS,
  ...BREAKER_TRIP_KINDS,
].filter((token) => token.includes('_') || token.includes('.'))

/** A bare dotted event type as a WHOLE word (`run.started`, `workspace.goal_set`) -- spec §5
 *  stage 4's own regex. */
const DOTTED_TYPE = /^[a-z_]+\.[a-z_]+$/

/**
 * A THROWAWAY GIT REPOSITORY for the fixture workspaces (`gate-m47-team-formation.mjs`'s
 * `makeRepo`, copied with its reason sharpened by controller Ruling 12).
 *
 * `Workspace.repoPath` must never be THIS checkout. A planning run executes in
 * `workspace.repoPath` ITSELF -- `apps/orchestrator/src/planning.ts` passes
 * `worktreePath: workspace.repoPath`, because the manager plans in the repository rather than in
 * a worktree -- and `packages/providers/test/fake-claude.mjs` does `git add -A && git commit` in
 * its own cwd. A fixture row pointing at the repo root therefore lets ANY later gate's daemon
 * sweep the operator's entire working tree into a commit authored by `Fake Claude`. It happened
 * once, on 2026-09-19, from a leftover row of an interrupted run of this gate.
 *
 * One repository per run, in `tmpdir()`, removed in `finally`. Neither gate dispatches a run, so
 * nothing else about either changes -- this closes the door rather than fixing a symptom.
 */
function makeRepo(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Asks the OS for a free TCP port. (`scripts/gate-m16-chrome.mjs`, verbatim.) */
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

/** Removes anything a prior interrupted run left behind, by NAME PREFIX, in the same FK order the
 *  `finally` block below uses. Safe against an empty database. */
async function preflightCleanup() {
  const staleCompanies = await prisma.company.findMany({
    where: { name: { startsWith: COMPANY_PREFIX } },
    select: { id: true, name: true },
  })
  for (const company of staleCompanies) {
    console.log(`preflight: removing leftover company ${company.id} (${company.name}) and its simulation runs`)
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
  const stale = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true },
  })
  for (const workspace of stale) {
    console.log(`preflight: removing leftover workspace ${workspace.id} (${workspace.name})`)
    await prisma.executionEvent.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {})
  }
  await prisma.person.deleteMany({ where: { name: { in: GATE_PERSON_NAMES } } }).catch(() => {})
  // A WORKSPACE POINTING AT THIS CHECKOUT CAN ONLY BE A GATE LEFTOVER (controller Ruling 12), and
  // it is the dangerous kind: a planning run executes in `workspace.repoPath` itself, so the next
  // daemon any gate starts would plan inside this repository and the fake CLI would commit it.
  // Removed by repoPath, in the same FK order as the rows above.
  const inThisRepo = await prisma.workspace.findMany({ where: { repoPath: repoRoot }, select: { id: true, name: true } })
  for (const workspace of inThisRepo) {
    console.log(`preflight: removing workspace ${workspace.id} (${workspace.name}) seeded against this repository`)
    await prisma.executionEvent.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {})
  }
  console.log(`preflight: ${String(inThisRepo.length)} workspace(s) pointing at ${repoRoot} removed`)
}

/** `YYYY-MM-DD` in the process's own zone. */
function localDay(at) {
  const year = at.getFullYear()
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${String(year)}-${month}-${day}`
}

let exitCode = 1
let nextServer = null
let browser = null
let page = null
let diagDir = null
let repoPath = null
let workspaceId = null
let otherWorkspaceId = null
let teamId = null
let slaveId = null
let decisionId = null
let templateId = null
let companyId = null
let simulationAId = null
let simulationBId = null
/** The browser console, newest last, for `fail()`'s dump. */
const browserConsole = []

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m61-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ============================================================================================
  // Stage 0: preflight, and the fixture rows the eleven stages need.
  // ============================================================================================

  const fakeClaude = process.env['SLAVEOFAI_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'SLAVEOFAI_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m61-simple-mode',
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
      `no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m61-simple-mode passes ` +
        '--env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m61-simple-mode`')
  }
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
  console.log(`fake claude: ${fakeClaude}`)
  console.log(`chromium:    ${chromiumPath}`)
  console.log(
    `raw-token blocklist: ${String(RAW_TOKENS.length)} member(s) DERIVED from the dist enums ` +
      `(every union member containing "_" or "."), e.g. ${JSON.stringify(RAW_TOKENS.slice(0, 6))}`,
  )
  assert(
    !RAW_TOKENS.includes('working') && !RAW_TOKENS.includes('paused') && !RAW_TOKENS.includes('model'),
    'the derived blocklist swallowed a bare English word -- the product vocabulary is not forbidden',
  )
  assert(RAW_TOKENS.includes('pause_requested'), 'the derived blocklist lost the RunStatus members')
  assert(RAW_TOKENS.includes('run.tool_call'), 'the derived blocklist lost the event types')

  await preflightCleanup()

  repoPath = makeRepo('slaveofai-gate-m61-repo-')
  console.log(`fixture repository: ${repoPath} (never this checkout -- see makeRepo's docblock)`)

  // ---- The fixture (plan erratum E7: `gate-m57`'s, plus the live run). -------------------------
  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath,
      verifyCommands: [],
      setupCommands: [],
      goal: 'Prove the frame reads.',
      goalVersion: 2,
      // NO DAEMON EVER PLANS THESE ROWS. This gate starts none and dispatches nothing, and the
      // flag says so to any daemon a neighbouring gate leaves running (controller Ruling 12).
      supervisorEnabled: false,
    },
  })
  workspaceId = workspace.id
  const other = await prisma.workspace.create({
    data: { name: OTHER_WORKSPACE_NAME, repoPath, verifyCommands: [], setupCommands: [], supervisorEnabled: false },
  })
  otherWorkspaceId = other.id
  const team = await prisma.team.create({ data: { workspaceId, name: TEAM_NAME } })
  teamId = team.id
  const person = await prisma.person.upsert({
    where: { name: SLAVE_NAME },
    create: { name: SLAVE_NAME },
    update: {
      templateId: null,
      profile: null,
      model: null,
      provider: null,
      capabilities: [],
      lifecycle: 'project',
      releasedAt: null,
      releaseReason: null,
      selectionRationale: null,
    },
  })
  const slave = await prisma.slave.create({
    data: {
      teamId,
      role: 'engineer',
      runtimeRoles: ['engineer'],
      model: 'sonnet',
      provider: 'claude_code',
      personId: person.id,
    },
  })
  slaveId = slave.id

  // ONE TASK PER COLUMN, named by the column it belongs in so a failure reads itself.
  const COLUMN_FIXTURE = [
    ['ready', 'Queued'],
    ['running', 'In progress'],
    ['reviewing', 'Review'],
    ['blocked', 'Blocked'],
    ['done', 'Done'],
  ]
  let runningTaskId = null
  for (const [status, column] of COLUMN_FIXTURE) {
    const task = await prisma.task.create({
      data: {
        workspaceId,
        title: `M61 gate task for ${column}`,
        description: 'One task per column, so the board is measured against tasks.',
        status,
        maxAttempts: 3,
        goalVersion: 2,
        requiredRole: 'engineer',
        ...(status === 'blocked' ? { lastRejectionReason: 'the gate parked it here' } : {}),
        ...(status === 'done' ? { integratedAt: new Date() } : {}),
      },
    })
    if (status === 'running') runningTaskId = task.id
  }
  assert(runningTaskId !== null, 'stage 0: the running task was not created')

  // THE LIVE RUN (plan erratum E7's one addition to `gate-m57`'s fixture). `working` is a
  // NON-TERMINAL run status, so `buildOverviewSnapshot` picks it up as the seat's live run, its
  // task's `running` status reaches `lib/progress.ts`'s table at 35, and the run's own step
  // progress moves it inside the 35-60 band (plan erratum E2). Stage 5 asserts the bar is drawn
  // and positive; it does not assert the exact number, which is a function of the tool-call
  // ceiling this fixture deliberately does not pin.
  await prisma.slaveRun.create({
    data: {
      slaveId,
      taskId: runningTaskId,
      kind: 'implementation',
      status: 'working',
      provider: 'claude_code',
      toolCalls: 4,
    },
  })

  // ONE MEMORY, so the Knowledge tab has a LIST. R4 names Knowledge as one of the three long
  // tables that render their rows through `@tanstack/react-virtual` inside a `ScrollArea`, and an
  // empty Knowledge page draws an `EmptyState` with no scrolling region at all -- which would let
  // stage 2 measure "this page does not scroll" over a page with nothing on it. It cascades away
  // with the workspace (`Memory.workspace` is `onDelete: Cascade`), so the teardown is unchanged.
  await prisma.memory.create({
    data: {
      type: 'fact',
      scope: 'workspace',
      workspaceId,
      title: 'The billing page renders its invoice from the order summary',
      body: 'Found while adding the printable invoice: the order summary is the single source for the totals.',
      status: 'verified',
      sourceKind: 'run_output',
      createdBy: 'human',
      verifiedAt: new Date(),
      verifiedBy: 'human',
    },
  })

  const decision = await prisma.supervisorDecision.create({
    data: {
      workspaceId,
      situationKind: 'no_reviewer',
      subjectId: 'reviewer',
      situation: {
        kind: 'no_reviewer',
        subjectId: 'reviewer',
        summary: 'Nobody on this project may review, so finished work has nobody to check it.',
        facts: { role: 'reviewer', reviewers: 0 },
      },
      candidates: [
        { action: { kind: 'set_runtime_roles', slaveId, roles: ['reviewer'] }, tier: 'proposed', why: 'one worker already here can take the role' },
      ],
      chosenIndex: 0,
      action: { kind: 'set_runtime_roles', slaveId, roles: ['reviewer'] },
      rationale: 'The project has ready work and no reviewer; the smallest fix is to widen one worker.',
      tier: 'proposed',
      status: 'pending',
      decidedBy: 'model',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  })
  decisionId = decision.id

  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  yesterday.setHours(12, 0, 0, 0)
  const YESTERDAY_DAY = localDay(yesterday)
  const GOAL_SET = EVENT_TYPE_BY_DOMAIN_TYPE['workspace.goal_set']
  await prisma.executionEvent.create({
    data: { type: GOAL_SET, ts: yesterday, workspaceId, actor: 'human', payload: { version: 1, request: SEEDED_REQUEST_YESTERDAY } },
  })
  await prisma.executionEvent.create({
    data: { type: GOAL_SET, workspaceId, actor: 'human', payload: { version: 2, request: SEEDED_REQUEST_TODAY } },
  })

  const template = await prisma.slaveTemplate.create({ data: { name: TEMPLATE_NAME, role: 'clerk' } })
  templateId = template.id
  const company = await prisma.company.create({ data: { name: COMPANY_NAME } })
  companyId = company.id
  for (const [department, memberName] of SIM_ROSTER) {
    const companyTeam = await prisma.companyTeam.create({ data: { companyId, name: department } })
    await prisma.person.upsert({
      where: { name: memberName },
      create: { templateId, name: memberName, lifecycle: 'permanent', departments: { create: { companyTeamId: companyTeam.id } } },
      update: {
        templateId,
        lifecycle: 'permanent',
        departments: { deleteMany: {}, create: { companyTeamId: companyTeam.id } },
        profile: null,
        model: null,
        provider: null,
        capabilities: [],
        releasedAt: null,
        releaseReason: null,
        selectionRationale: null,
      },
    })
  }
  for (const [name, policy] of [[SIMULATION_A_NAME, 'A'], [SIMULATION_B_NAME, 'B']]) {
    const created = await createSimulation({ companyId, name, sector: 'trade', policy, seed: 5 })
    if (!created.ok) throw new Error(`could not create the fixture simulation ${name}: ${JSON.stringify(created.error)}`)
    if (simulationAId === null) simulationAId = created.value.id
    else simulationBId = created.value.id
  }

  console.log('stage 0 PASSED: the fixture rows the eleven stages need')
  console.log(`  workspace ${workspaceId} (${WORKSPACE_NAME}) · second workspace ${otherWorkspaceId} (${OTHER_WORKSPACE_NAME})`)
  console.log(`  team ${teamId} · slave ${slaveId} (${SLAVE_NAME}) · live SlaveRun on task ${runningTaskId}`)
  console.log(`  tasks: ${JSON.stringify(COLUMN_FIXTURE)}`)
  console.log('  one verified workspace Memory, so the Knowledge tab has a virtualized list')
  console.log(`  SupervisorDecision ${decisionId} no_reviewer/proposed/pending/model`)
  console.log(`  two workspace.goal_set events, one dated ${YESTERDAY_DAY} and one today`)
  console.log(`  Company ${companyId} (${COMPANY_NAME}) · SlaveTemplate ${templateId} · SimulationRun ${simulationAId} (A) and ${simulationBId} (B)`)

  // ---- The real web shell, on a free port, loopback-bound. -------------------------------------
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

  /**
   * A browser context pinned to one MODE, one viewport and (optionally) reduced motion. Every
   * one of them is closed by `browser.close()` in the `finally` block, so a stage that throws
   * mid-way leaks nothing.
   *
   * The mode is written into `localStorage` by an init script rather than by clicking the toggle:
   * a stage that wants developer mode wants it on the FIRST paint, which is exactly what R1's
   * pre-hydration `<head>` clause reads. `'simple'` is written explicitly rather than left absent
   * so a context can never inherit another stage's choice.
   */
  async function modeContext(mode, { width = 1440, height = 900, reducedMotion } = {}) {
    const context = await browser.newContext({
      viewport: { width, height },
      ...(reducedMotion === undefined ? {} : { reducedMotion }),
    })
    await context.addInitScript((value) => {
      try {
        window.localStorage.setItem('mode', value)
      } catch {
        /* the page still renders; the stage's own assertion fails loudly rather than silently */
      }
      // `next dev`'s own dev-tools indicator (`<nextjs-portal>`) is a fixed element in the
      // BOTTOM-LEFT corner -- exactly where R5 puts the rail's footer controls -- and it swallows
      // the pointer events aimed at `mode-toggle`. It is a property of the dev server, not of the
      // product (`next build` never renders it), and the two gates that read page TEXT already
      // exclude it by name (`gate-m44`, `gate-m45`). Hidden here so a click lands on the control
      // a person would actually click, and on nothing else.
      const hideDevOverlay = () => {
        const style = document.createElement('style')
        style.setAttribute('data-gate', 'hide-next-dev-overlay')
        style.textContent = 'nextjs-portal{display:none !important}'
        document.documentElement.appendChild(style)
      }
      if (document.documentElement !== null) hideDevOverlay()
      else document.addEventListener('DOMContentLoaded', hideDevOverlay, { once: true })
    }, mode)
    return context
  }

  const context = await modeContext('simple')
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  page.on('pageerror', (error) => {
    console.error(`[browser:pageerror] ${error}`)
    browserConsole.push(`[pageerror] ${String(error).slice(0, 300)}`)
  })
  page.on('console', (message) => browserConsole.push(`[${message.type()}] ${message.text().slice(0, 300)}`))
  page.on('requestfailed', (request) => browserConsole.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`))

  /** The m8a-estop-style diagnostic throw (`gate-m44-ux-foundation.mjs`'s `fail`). */
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

  /** Bounded-waits for `locator` to become visible; a timeout routes through `fail`. */
  async function waitVisible(locator, description) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
    } catch {
      await fail(`timed out waiting for ${description} to become visible`)
    }
  }

  /** Polls `probe` until it reports `{done:true}`, then answers its `value`. */
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

  /** `page.goto`, with a 5xx routed through `fail()`'s dump. `target` defaults to the gate's own
   *  primary page; stages that run in their own context pass theirs. */
  async function gotoReliably(url, target = page) {
    let response = null
    try {
      response = await target.goto(url, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
    } catch (cause) {
      await fail(`goto ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (response !== null && response.status() >= 500) {
      await fail(`goto ${url} returned ${String(response.status())}`)
    }
    return response
  }

  /** Clicks `locator`, then bounded-waits for `predicate`. */
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

  /**
   * Bounded-waits until `ModeProvider` has HYDRATED and settled on `mode`.
   *
   * Every mode-dependent surface (`team-technical`, the six-tab strip, the workforce segments)
   * is rendered by a client component whose first render is flat `'simple'` -- that is R1's own
   * anti-hydration-mismatch rule, the same one `ThemeProvider` keeps. A stage that reads one of
   * them straight after `goto` reads the pre-hydration frame and gets the wrong answer for a
   * reason that has nothing to do with what it is asserting.
   */
  async function waitForMode(target, mode) {
    await waitUntil(`the page to settle in ${mode} mode`, ACTION_TIMEOUT_MS, async () => {
      const seen = await target.evaluate(() => ({
        attr: document.documentElement.getAttribute('data-mode'),
        // `aria-checked` is only correct once `ModeProvider`'s storage read has landed, so it is
        // the hydration signal; the attribute alone is stamped by the pre-hydration script.
        checked: document.querySelector('[data-testid="mode-toggle"]')?.getAttribute('aria-checked') ?? null,
      }))
      const settled = mode === 'developer' ? seen.attr === 'developer' && seen.checked === 'true' : seen.attr === null && seen.checked === 'false'
      return settled ? { done: true, value: seen } : { done: false, detail: JSON.stringify(seen) }
    })
  }

  // ============================================================================================
  // Stage 1: no flash (spec §5.1, R1).
  //
  // The observer is installed at document-start, BEFORE the root layout's inline `<head>` clause
  // runs, and it records EVERY value `data-mode` ever holds. Recording only the first would pass
  // a build whose hydration took the attribute straight back off again -- which is precisely the
  // bug `ModeProvider`'s `hydrated` guard exists to prevent -- so the sequence is asserted whole:
  // the first observation is `developer`, and simple (the ABSENT attribute, read here as `''`)
  // never appears in it at all.
  // ============================================================================================
  {
    const ctx = await modeContext('developer')
    const flashPage = await ctx.newPage()
    flashPage.setDefaultTimeout(ACTION_TIMEOUT_MS)
    await ctx.addInitScript(() => {
      window.__modeSeen = []
      // `document` is always there at document-start; `document.documentElement` may not be, so
      // the observer watches the document with `subtree` rather than the root element directly.
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.target === document.documentElement) {
            window.__modeSeen.push(document.documentElement.dataset.mode ?? '')
          }
        }
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-mode'] })
    })
    await gotoReliably(`${baseUrl}/`, flashPage)
    // Hydration has to have HAPPENED before the sequence means anything: the rail's own mode
    // switch only reports `aria-checked="true"` once `ModeProvider` has read storage.
    await waitUntil('the rail mode switch to report developer after hydration', ACTION_TIMEOUT_MS, async () => {
      const checked = await flashPage.evaluate(
        () => document.querySelector('[data-testid="mode-toggle"]')?.getAttribute('aria-checked') ?? null,
      )
      return checked === 'true' ? { done: true, value: checked } : { done: false, detail: JSON.stringify(checked) }
    })
    const seen = await flashPage.evaluate(() => ({
      sequence: window.__modeSeen ?? [],
      now: document.documentElement.dataset.mode ?? '',
    }))
    console.log(`stage 1: data-mode observations = ${JSON.stringify(seen.sequence)}, settled at ${JSON.stringify(seen.now)}`)
    if (seen.sequence.length === 0) {
      await fail('stage 1: no data-mode mutation was observed at all -- the pre-hydration clause never stamped it')
    }
    if (seen.sequence[0] !== 'developer') {
      await fail(`stage 1: the FIRST data-mode observed was ${JSON.stringify(seen.sequence[0])}, not "developer" -- developer mode flashed simple before hydration`)
    }
    const flashed = seen.sequence.filter((value) => value !== 'developer')
    if (flashed.length > 0) {
      await fail(`stage 1: data-mode was taken off the root element mid-load (${JSON.stringify(seen.sequence)}) -- hydration flashed simple`)
    }
    if (seen.now !== 'developer') await fail(`stage 1: the page settled at data-mode=${JSON.stringify(seen.now)}`)
    await flashPage.close()
    console.log('stage 1 PASSED: a stored developer mode is on <html> from the first observable mutation and never comes off')
  }

  // ============================================================================================
  // Stage 2: the frame never scrolls (spec §5.2, R4).
  //
  // `scrollHeight === clientHeight` AND `scrollWidth === clientWidth` on the scrolling element,
  // for every route §2 names, in both modes, at 1440x900 and at the 1024x680 floor -- the two
  // sizes R4 states.
  //
  // EVERY ROUTE WAITS FOR A MARKER FIRST, because a page that never scrolls because it never
  // rendered is not the claim this stage makes. For sixteen of the nineteen the marker IS the
  // `ui/ScrollArea` R4 says the page must put its content in; the other three own no scrolling
  // region at all, deliberately, and name their own marker instead:
  //   - `/w/:id/office` is a CANVAS (R17 keeps the engine and its own `overflow-hidden` box) with
  //     a fixed-width focus card beside it -- there is no list on it to scroll;
  //   - `/w/:id/graph` is the same shape: a canvas plus its own 352px aside (`docs/ia.md`,
  //     "Panels that stay where they are");
  //   - `/login` is a centred card and renders no shell body at all (ruling T3-3).
  // The anti-vacuity guarantee is identical in both cases -- something this page and only this
  // page draws has to be on screen before anything is measured.
  //
  // `data-scroll-axis`, not `[data-testid="scroll-area"]`: `ScrollArea`'s testid is the CALLER's
  // (Home's list is `home-projects`, the board is `board-scroll`, a Sheet's body is
  // `<testId>-body`) -- the same fact spec erratum E10 records for `Sheet`.
  // ============================================================================================
  {
    const SCROLLS = '[data-scroll-axis]'
    const ROUTES = [
      ['/', SCROLLS],
      [`/w/${workspaceId}`, SCROLLS],
      [`/w/${workspaceId}/tasks`, SCROLLS],
      [`/w/${workspaceId}/office`, '[data-testid="office-canvas"]'],
      [`/w/${workspaceId}/activity`, SCROLLS],
      [`/w/${workspaceId}/activity?view=digest`, SCROLLS],
      [`/w/${workspaceId}/graph`, '[data-testid="graph-canvas"]'],
      [`/w/${workspaceId}/knowledge`, SCROLLS],
      [`/w/${workspaceId}/settings`, SCROLLS],
      [`/w/${workspaceId}/settings?section=runbook`, SCROLLS],
      ['/workforce', SCROLLS],
      ['/workforce?tab=catalog', SCROLLS],
      ['/settings', SCROLLS],
      ['/settings?section=repositories', SCROLLS],
      ['/analytics', SCROLLS],
      ['/sim', SCROLLS],
      [`/sim/${simulationAId}`, SCROLLS],
      [`/sim/compare?a=${simulationAId}&b=${simulationBId}`, SCROLLS],
      ['/login', '[data-testid="login-unconfigured"]'],
    ]
    let measured = 0
    for (const mode of ['simple', 'developer']) {
      for (const [width, height] of [[1440, 900], [1024, 680]]) {
        const ctx = await modeContext(mode, { width, height })
        const pg = await ctx.newPage()
        pg.setDefaultTimeout(ACTION_TIMEOUT_MS)
        for (const [route, marker] of ROUTES) {
          await gotoReliably(`${baseUrl}${route}`, pg)
          try {
            await pg.waitForSelector(marker, { timeout: ACTION_TIMEOUT_MS })
          } catch {
            await fail(
              `stage 2: ${route} never rendered ${marker} in ${mode} at ${String(width)}x${String(height)} -- ` +
                'a page that measures as "does not scroll" because it drew nothing proves nothing',
            )
          }
          const m = await pg.evaluate(() => ({
            sh: document.scrollingElement.scrollHeight,
            ch: document.scrollingElement.clientHeight,
            sw: document.scrollingElement.scrollWidth,
            cw: document.scrollingElement.clientWidth,
            areas: document.querySelectorAll('[data-scroll-axis]').length,
          }))
          console.log(
            `stage 2: ${mode} ${String(width)}x${String(height)} ${route} scrollHeight=${String(m.sh)} clientHeight=${String(m.ch)} ` +
              `scrollWidth=${String(m.sw)} clientWidth=${String(m.cw)} scrollAreas=${String(m.areas)}`,
          )
          if (m.sh !== m.ch || m.sw !== m.cw) {
            await fail(
              `stage 2: ${route} grows past the viewport in ${mode} at ${String(width)}x${String(height)} ` +
                `(${String(m.sw)}x${String(m.sh)} of ${String(m.cw)}x${String(m.ch)})`,
            )
          }
          measured += 1
        }
        await pg.close()
        await ctx.close()
      }
    }
    console.log(`stage 2 PASSED: ${String(measured)} measurements, and not one page grew past its own viewport`)
  }

  // ============================================================================================
  // Stage 3: the switch (spec §5.3, R1/R2/R18).
  //
  // NO COLOUR LITERAL (ruling R2): the palette's movement is asserted as INEQUALITY of `--accent`
  // before and after, never against a hex. Which two colours the two modes use is a design
  // decision the token files own; that they are not the same colour is what this gate is for.
  // ============================================================================================
  {
    const ctx = await modeContext('simple')
    const pg = await ctx.newPage()
    pg.setDefaultTimeout(ACTION_TIMEOUT_MS)
    await gotoReliably(`${baseUrl}/w/${workspaceId}`, pg)
    await waitVisible(pg.getByTestId('project-tab'), "the project's own tab bar")
    const accentBefore = await pg.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
    const tabsBefore = await pg.$$eval('[data-testid="project-tab"]', (els) => els.map((e) => e.dataset.tab))
    await clickUntil(
      pg.getByTestId('mode-toggle'),
      async () => (await pg.$$eval('[data-testid="project-tab"]', (els) => els.length)) === TAB_IDS.length,
      'the rail mode switch',
    )
    const accentAfter = await pg.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
    const tabsAfter = await pg.$$eval('[data-testid="project-tab"]', (els) => els.map((e) => e.dataset.tab))
    const modeAfter = await pg.evaluate(() => document.documentElement.getAttribute('data-mode'))
    console.log(`stage 3: accent ${JSON.stringify(accentBefore)} -> ${JSON.stringify(accentAfter)}; tabs ${JSON.stringify(tabsBefore)} -> ${JSON.stringify(tabsAfter)}; data-mode -> ${JSON.stringify(modeAfter)}`)
    if (accentBefore === '' || accentAfter === '') await fail('stage 3: --accent resolved to nothing -- the token sheet is not loaded')
    if (accentBefore === accentAfter) await fail(`stage 3: the palette did not change (--accent stayed ${JSON.stringify(accentBefore)})`)
    if (modeAfter !== 'developer') await fail(`stage 3: data-mode is ${JSON.stringify(modeAfter)} after the toggle`)
    if (JSON.stringify(tabsBefore) !== JSON.stringify(SIMPLE_TAB_IDS)) {
      await fail(`stage 3: simple mode drew ${JSON.stringify(tabsBefore)}, expected ${JSON.stringify(SIMPLE_TAB_IDS)}`)
    }
    if (JSON.stringify(tabsAfter) !== JSON.stringify(TAB_IDS)) {
      await fail(`stage 3: developer mode drew ${JSON.stringify(tabsAfter)}, expected ${JSON.stringify(TAB_IDS)}`)
    }
    // The keyboard does the same thing the control does -- and, per R1, animates nothing on its way.
    await pg.keyboard.press('Control+Shift+D')
    const backToSimple = await waitUntil('Mod+Shift+D to put the four simple tabs back', ACTION_TIMEOUT_MS, async () => {
      const ids = await pg.$$eval('[data-testid="project-tab"]', (els) => els.map((e) => e.dataset.tab))
      return ids.length === SIMPLE_TAB_IDS.length ? { done: true, value: ids } : { done: false, detail: JSON.stringify(ids) }
    })
    console.log(`stage 3: after Mod+Shift+D, tabs = ${JSON.stringify(backToSimple)}`)
    await gotoReliably(`${baseUrl}/w/${workspaceId}`, pg)
    await waitVisible(pg.getByTestId('project-tab'), 'the tab bar after the reload')
    const afterReload = await pg.evaluate(() => ({
      attr: document.documentElement.getAttribute('data-mode'),
      stored: (() => { try { return window.localStorage.getItem('mode') } catch { return 'THREW' } })(),
      tabs: [...document.querySelectorAll('[data-testid="project-tab"]')].map((el) => el.getAttribute('data-tab')),
    }))
    console.log(`stage 3: after a reload = ${JSON.stringify(afterReload)}`)
    if (afterReload.attr !== null) await fail(`stage 3: simple mode is the ABSENCE of the attribute, and the reload stamped ${JSON.stringify(afterReload.attr)}`)
    if (afterReload.stored !== 'simple') await fail(`stage 3: the choice did not survive a reload (localStorage.mode = ${JSON.stringify(afterReload.stored)})`)
    if (JSON.stringify(afterReload.tabs) !== JSON.stringify(SIMPLE_TAB_IDS)) {
      await fail(`stage 3: after the reload the tabs are ${JSON.stringify(afterReload.tabs)}`)
    }
    await pg.close()
    console.log('stage 3 PASSED: one control and one shortcut move the palette and the tab set, and the choice survives a reload')
  }

  // ============================================================================================
  // Stage 4: Home (spec §5.4, R11).
  // ============================================================================================
  {
    const ctx = await modeContext('simple')
    const pg = await ctx.newPage()
    pg.setDefaultTimeout(ACTION_TIMEOUT_MS)
    await gotoReliably(`${baseUrl}/`, pg)
    await waitVisible(pg.getByTestId('home-projects'), 'the project list on Home')
    const dbProjects = await prisma.workspace.findMany({ where: { archivedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
    const rows = await waitUntil(`Home to draw ${String(dbProjects.length)} project row(s)`, ACTION_TIMEOUT_MS, async () => {
      const seen = await pg.evaluate(() =>
        [...document.querySelectorAll('[data-testid="project-row"]')].map((row) => ({
          id: row.getAttribute('data-workspace'),
          status: row.getAttribute('data-status'),
          needs: row.getAttribute('data-needs-you'),
          team: row.getAttribute('data-team-size'),
        })),
      )
      return seen.length === dbProjects.length ? { done: true, value: seen } : { done: false, detail: JSON.stringify(seen.map((r) => r.id)) }
    })
    console.log(`stage 4: project rows = ${JSON.stringify(rows)}`)
    console.log(`stage 4: database non-archived workspaces = ${JSON.stringify(dbProjects.map((p) => p.id))}`)
    const rowIds = [...rows.map((row) => row.id)].sort()
    const dbIds = [...dbProjects.map((row) => row.id)].sort()
    if (JSON.stringify(rowIds) !== JSON.stringify(dbIds)) {
      await fail(`stage 4: Home lists ${JSON.stringify(rowIds)} and the database has ${JSON.stringify(dbIds)}`)
    }
    const seededRow = rows.find((row) => row.id === workspaceId)
    if (seededRow === undefined || seededRow.status === null || seededRow.needs === null || seededRow.team === null) {
      await fail(`stage 4: the seeded project's row is missing one of data-status/data-needs-you/data-team-size (${JSON.stringify(seededRow)})`)
    }

    // NEEDS YOU: every row links into the project it is about.
    await waitVisible(pg.getByTestId('home-needs-you'), "Home's needs-you list")
    const needs = await pg.evaluate(() =>
      [...document.querySelectorAll('[data-testid="home-needs-you"] [data-testid="needs-you-row"]')].map((row) => ({
        kind: row.getAttribute('data-kind'),
        href: row.querySelector('a')?.getAttribute('href') ?? null,
        project: row.querySelector('[data-testid="needs-you-project"]')?.textContent?.trim() ?? null,
      })),
    )
    console.log(`stage 4: needs-you rows = ${JSON.stringify(needs)}`)
    if (needs.length === 0) await fail('stage 4: the seeded pending decision is not on Home -- the needs-you list is empty')
    for (const row of needs) {
      if (row.href === null || !/^\/w\/[^/]+/.test(row.href)) {
        await fail(`stage 4: a needs-you row links to ${JSON.stringify(row.href)}, which is not a project route`)
      }
    }
    if (!needs.some((row) => (row.href ?? '').startsWith(`/w/${workspaceId}`))) {
      await fail(`stage 4: no needs-you row links into the seeded project ${workspaceId}`)
    }

    // THE FEED: sentences, not event types.
    await waitVisible(pg.getByTestId('home-feed'), "Home's Happening now feed")
    const feed = await waitUntil('the Happening now feed to draw the seeded events', ACTION_TIMEOUT_MS, async () => {
      const seen = await pg.evaluate(() =>
        [...document.querySelectorAll('[data-testid="feed-item"]')].map((item) => ({
          type: item.getAttribute('title'),
          text: (item.textContent ?? '').replace(/\s+/g, ' ').trim(),
        })),
      )
      return seen.length > 0 ? { done: true, value: seen } : { done: false, detail: '0 feed items' }
    })
    for (const item of feed) console.log(`stage 4: feed [${String(item.type)}] ${JSON.stringify(item.text.slice(0, 120))}`)
    for (const item of feed) {
      for (const word of item.text.split(/\s+/)) {
        if (DOTTED_TYPE.test(word)) {
          await fail(`stage 4: a feed sentence prints the bare event type ${JSON.stringify(word)}: ${JSON.stringify(item.text)}`)
        }
      }
      for (const token of RAW_TOKENS) {
        if (item.text.includes(token)) {
          await fail(`stage 4: a feed sentence contains the raw token ${JSON.stringify(token)}: ${JSON.stringify(item.text)}`)
        }
      }
      // `docs/ia.md` rule 3's second half: the raw value stays reachable, on `title`.
      if (item.type === null || item.type === '') {
        await fail(`stage 4: a feed item carries no raw type on its title attribute: ${JSON.stringify(item.text)}`)
      }
    }
    await pg.close()
    console.log(`stage 4 PASSED: ${String(rows.length)} project rows against the database, ${String(needs.length)} needs-you row(s) linking into their project, and ${String(feed.length)} feed sentence(s) with no bare event type`)
  }

  // ============================================================================================
  // Stage 5: the Team tab (spec §5.5, R7/R8).
  //
  // Developer mode, for one reason: `organization-rows` (the roster the redirect target has to
  // keep -- R7's own argument for redirecting `/organization` at all) renders in developer mode.
  // The card assertions below are mode-independent.
  // ============================================================================================
  {
    const ctx = await modeContext('developer')
    const pg = await ctx.newPage()
    pg.setDefaultTimeout(ACTION_TIMEOUT_MS)
    await gotoReliably(`${baseUrl}/w/${workspaceId}`, pg)
    await waitVisible(pg.getByTestId('team-live'), 'the Team tab')
    await waitForMode(pg, 'developer')
    const seats = await prisma.slave.count({ where: { team: { workspaceId } } })
    const cards = await waitUntil(`the Team tab to draw ${String(seats)} card(s)`, ACTION_TIMEOUT_MS, async () => {
      const seen = await pg.evaluate(() =>
        [...document.querySelectorAll('[data-testid="team-card"]')].map((card) => ({
          slave: card.getAttribute('data-slave'),
          status: card.getAttribute('data-status'),
          state: card.getAttribute('data-state'),
          doing: card.querySelector('[data-testid="team-doing"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
          progress: card.querySelector('[data-testid="team-progress"]')?.getAttribute('data-progress') ?? null,
          technical: card.querySelector('[data-testid="team-technical"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
        })),
      )
      return seen.length === seats ? { done: true, value: seen } : { done: false, detail: `${String(seen.length)} card(s)` }
    })
    console.log(`stage 5: seats in the database = ${String(seats)}; cards = ${JSON.stringify(cards)}`)
    for (const card of cards) {
      if (card.doing === null || card.doing === '') await fail(`stage 5: a team card says nothing about what its person is doing (${JSON.stringify(card)})`)
      for (const token of RAW_TOKENS) {
        if (card.doing.includes(token)) {
          await fail(`stage 5: a "doing" sentence prints the raw member ${JSON.stringify(token)}: ${JSON.stringify(card.doing)}`)
        }
      }
    }
    const live = cards.find((card) => card.slave === slaveId)
    if (live === undefined) await fail(`stage 5: the seeded seat ${slaveId} has no card`)
    if (live.progress === null) await fail(`stage 5: the seeded live run's card drew no progress bar (${JSON.stringify(live)})`)
    if (!(Number(live.progress) > 0)) {
      await fail(`stage 5: the seeded live run's card reads data-progress=${JSON.stringify(live.progress)}, expected a positive number`)
    }
    if (!live.doing.includes(RUNNING_TASK_TITLE)) {
      await fail(`stage 5: the live card's sentence is ${JSON.stringify(live.doing)}, expected it to name the task it is on`)
    }
    if (live.technical === null) await fail('stage 5: developer mode drew no technical line on the live card (R7)')

    // THE REDIRECT (R7): one page, one URL, and the roster still on it.
    const response = await gotoReliably(`${baseUrl}/w/${workspaceId}/organization?slave=nobody`, pg)
    await waitForMode(pg, 'developer')
    await waitVisible(pg.getByTestId('organization-rows'), 'the roster on the redirect target')
    const landed = pg.url()
    console.log(`stage 5: /w/<id>/organization?slave=nobody -> ${landed} (${String(response?.status())})`)
    if (!landed.startsWith(`${baseUrl}/w/${workspaceId}`) || landed.includes('/organization')) {
      await fail(`stage 5: /organization landed on ${landed}, expected the Team tab at /w/${workspaceId}`)
    }
    if (!landed.includes('slave=nobody')) {
      await fail(`stage 5: the redirect dropped the query string (${landed}) -- R7 says it is preserved`)
    }
    await pg.close()
    console.log('stage 5 PASSED: one card per seat, English sentences, a real bar on the live run, and the organization URL landing on the Team tab')
  }

  // ============================================================================================
  // Stage 6: the Supervisor (spec §5.6, R14).
  // ============================================================================================
  {
    const ctx = await modeContext('simple')
    const pg = await ctx.newPage()
    pg.setDefaultTimeout(ACTION_TIMEOUT_MS)
    await gotoReliably(`${baseUrl}/w/${workspaceId}`, pg)
    await waitVisible(pg.getByTestId('right-panel'), 'the Supervisor panel on a first visit')
    const firstVisit = await pg.evaluate(() => ({
      right: document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-right') ?? null,
      stored: (() => { try { return window.localStorage.getItem('supervisor') } catch { return 'THREW' } })(),
      mode: document.querySelector('[data-testid="right-panel"]')?.getAttribute('data-mode') ?? null,
    }))
    console.log(`stage 6: first visit = ${JSON.stringify(firstVisit)}`)
    if (firstVisit.right !== 'panel') await fail(`stage 6: the first visit opened with data-right=${JSON.stringify(firstVisit.right)}, expected "panel"`)
    if (firstVisit.mode !== 'supervisor') await fail(`stage 6: the default content is ${JSON.stringify(firstVisit.mode)}, expected the Supervisor`)

    await clickUntil(pg.getByTestId('panel-collapse'), async () => pg.getByTestId('right-dock').isVisible(), 'the panel collapse »')
    await gotoReliably(`${baseUrl}/w/${workspaceId}`, pg)
    const remembered = await waitUntil('the collapsed panel to be remembered across a reload', ACTION_TIMEOUT_MS, async () => {
      const seen = await pg.evaluate(() => ({
        right: document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-right') ?? null,
        dock: document.querySelector('[data-testid="right-dock"]') !== null,
        stored: (() => { try { return window.localStorage.getItem('supervisor') } catch { return 'THREW' } })(),
      }))
      return seen.right === 'dock' && seen.dock ? { done: true, value: seen } : { done: false, detail: JSON.stringify(seen) }
    })
    console.log(`stage 6: after collapse + reload = ${JSON.stringify(remembered)}`)

    await pg.keyboard.press('Control+j')
    const reopened = await waitUntil('Mod+J to re-open the panel', ACTION_TIMEOUT_MS, async () => {
      const seen = await pg.evaluate(() => ({
        right: document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-right') ?? null,
        panel: document.querySelector('[data-testid="right-panel"]') !== null,
      }))
      return seen.right === 'panel' && seen.panel ? { done: true, value: seen } : { done: false, detail: JSON.stringify(seen) }
    })
    console.log(`stage 6: after Mod+J = ${JSON.stringify(reopened)}`)

    await pg.setViewportSize({ width: 1200, height: 800 })
    const narrow = await waitUntil('the panel to become an overlay below 1280px', ACTION_TIMEOUT_MS, async () => {
      const seen = await pg.evaluate(() => ({
        right: document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-right') ?? null,
        overlay: document.querySelector('[data-testid="right-overlay"]') !== null,
        width: document.querySelector('[data-testid="right-overlay"]') === null ? null : getComputedStyle(document.querySelector('[data-testid="right-overlay"]')).width,
      }))
      return seen.right === 'overlay' && seen.overlay ? { done: true, value: seen } : { done: false, detail: JSON.stringify(seen) }
    })
    console.log(`stage 6: at 1200x800 = ${JSON.stringify(narrow)}`)
    await pg.close()
    console.log('stage 6 PASSED: open by default, remembered closed, re-opened by Mod+J, an overlay below 1280')
  }

  // ============================================================================================
  // Stage 7: the Sheet (spec §5.7, R15).
  //
  // Spec erratum E10: a `Sheet`'s testid is the caller's, so the New project conversation is
  // `new-project-sheet` and the shared close is `sheet-close`.
  // ============================================================================================
  {
    const ctx = await modeContext('simple')
    const pg = await ctx.newPage()
    pg.setDefaultTimeout(ACTION_TIMEOUT_MS)
    await gotoReliably(`${baseUrl}/`, pg)
    await waitVisible(pg.getByTestId('new-project'), "Home's + New project action")
    await clickUntil(pg.getByTestId('new-project'), async () => pg.getByTestId('new-project-sheet').isVisible(), '+ New project')
    const opened = await pg.evaluate(() => ({
      role: document.querySelector('[data-testid="new-project-sheet"]')?.getAttribute('role') ?? null,
      modal: document.querySelector('[data-testid="new-project-sheet"]')?.getAttribute('aria-modal') ?? null,
      close: document.querySelector('[data-testid="new-project-sheet"] [data-testid="sheet-close"]') !== null,
      focusInside: document.querySelector('[data-testid="new-project-sheet"]')?.contains(document.activeElement) ?? false,
    }))
    console.log(`stage 7: the opened sheet = ${JSON.stringify(opened)}`)
    if (opened.role !== 'dialog' || opened.modal !== 'true') await fail(`stage 7: the sheet is not a modal dialog (${JSON.stringify(opened)})`)
    if (!opened.close) await fail('stage 7: the sheet has no sheet-close')
    if (!opened.focusInside) await fail('stage 7: opening the sheet did not move focus into it')
    await pg.keyboard.press('Escape')
    const closed = await waitUntil('Escape to close the sheet and give focus back', ACTION_TIMEOUT_MS, async () => {
      const seen = await pg.evaluate(() => ({
        present: document.querySelector('[data-testid="new-project-sheet"]') !== null,
        focused: document.activeElement?.getAttribute('data-testid') ?? null,
      }))
      return !seen.present && seen.focused === 'new-project' ? { done: true, value: seen } : { done: false, detail: JSON.stringify(seen) }
    })
    console.log(`stage 7: after Escape = ${JSON.stringify(closed)}`)
    await pg.close()

    // REDUCED MOTION: the same sheet, opened by a visitor who asked for no animation. R15 collapses
    // it to an opacity fade, so nothing about its transition may name `transform`.
    const reducedCtx = await modeContext('simple', { reducedMotion: 'reduce' })
    const reducedPage = await reducedCtx.newPage()
    reducedPage.setDefaultTimeout(ACTION_TIMEOUT_MS)
    await gotoReliably(`${baseUrl}/`, reducedPage)
    await waitVisible(reducedPage.getByTestId('new-project'), "Home's + New project action (reduced motion)")
    await clickUntil(reducedPage.getByTestId('new-project'), async () => reducedPage.getByTestId('new-project-sheet').isVisible(), '+ New project (reduced motion)')
    const motionRead = await reducedPage.evaluate(() => {
      const node = document.querySelector('[data-testid="new-project-sheet"]')
      if (node === null) return null
      const style = getComputedStyle(node)
      const properties = style.transitionProperty.split(',').map((value) => value.trim())
      const durations = style.transitionDuration.split(',').map((value) => value.trim())
      return {
        properties,
        durations,
        animationName: style.animationName,
        transform: style.transform,
      }
    })
    console.log(`stage 7: reduced-motion sheet = ${JSON.stringify(motionRead)}`)
    if (motionRead === null) await fail('stage 7: the reduced-motion sheet never rendered')
    // `transition-property` is `all` by CSS DEFAULT -- that is the property's initial value, not a
    // declaration -- so reading it alone says nothing. What R15 promises is that NOTHING MOVES:
    // no transform is animated (a property is only animated when its own duration is non-zero),
    // no keyframe animation runs, and the panel is not offset at all, because the slide collapsed
    // to an opacity fade.
    const animatedTransforms = motionRead.properties
      .map((property, index) => ({ property, duration: motionRead.durations[index % motionRead.durations.length] ?? '0s' }))
      .filter((pair) => (pair.property === 'transform' || pair.property === 'all') && Number.parseFloat(pair.duration) > 0)
    if (animatedTransforms.length > 0) {
      await fail(`stage 7: a reduced-motion sheet still transitions a transform: ${JSON.stringify(animatedTransforms)}`)
    }
    if (motionRead.animationName !== 'none') {
      await fail(`stage 7: a reduced-motion sheet runs the keyframe animation ${JSON.stringify(motionRead.animationName)}`)
    }
    if (!(motionRead.transform === 'none' || motionRead.transform === 'matrix(1, 0, 0, 1, 0, 0)')) {
      await fail(`stage 7: a reduced-motion sheet is drawn offset (transform ${JSON.stringify(motionRead.transform)}) -- the slide did not collapse to a fade`)
    }
    await reducedPage.close()
    console.log('stage 7 PASSED: one modal surface, Escape closes it, focus comes back, and reduced motion gets no transform')
  }

  // ============================================================================================
  // Stage 8: People (spec §5.8, R12). Simple mode, per the controller's own ruling.
  // ============================================================================================
  {
    const ctx = await modeContext('simple')
    const pg = await ctx.newPage()
    pg.setDefaultTimeout(ACTION_TIMEOUT_MS)
    await gotoReliably(`${baseUrl}/workforce`, pg)
    await waitVisible(pg.getByTestId('people-table'), 'the People table')
    await waitForMode(pg, 'simple')
    const segments = await pg.$$eval('[data-testid^="workforce-segment"]', (els) => els.length)
    console.log(`stage 8: simple mode drew ${String(segments)} workforce segment(s) -- the page IS People (R12)`)

    await waitVisible(pg.getByTestId('hire-from-catalogue'), 'the Hire from catalogue action')
    await clickUntil(pg.getByTestId('hire-from-catalogue'), async () => pg.getByTestId('hire-sheet').isVisible(), 'Hire from catalogue')
    const catalogInside = await pg.evaluate(() =>
      [...document.querySelectorAll('[data-testid="hire-sheet"] [data-testid]')]
        .map((node) => node.getAttribute('data-testid') ?? '')
        .filter((id) => id.startsWith('catalog-')),
    )
    console.log(`stage 8: the hire sheet holds ${JSON.stringify(catalogInside)}`)
    if (catalogInside.length === 0) await fail("stage 8: the hire sheet holds none of the catalog's own testids")
    await clickUntil(
      pg.locator('[data-testid="hire-sheet"] [data-testid="sheet-close"]'),
      async () => (await pg.$$eval('[data-testid="hire-sheet"]', (els) => els.length)) === 0,
      "the hire sheet's close",
    )

    const firstRow = pg.locator('[data-testid^="person-row-"]').first()
    await waitVisible(firstRow, 'a row in the People table')
    await clickUntil(firstRow, async () => pg.getByTestId('person-sheet').isVisible(), 'a person row')
    const personSheet = await waitUntil('the person sheet to finish opening', ACTION_TIMEOUT_MS, async () => {
      const seen = await pg.evaluate(() => ({
        panel: document.querySelector('[data-testid="person-sheet"] [data-testid="slave-panel"]') !== null,
        url: window.location.search,
      }))
      return seen.panel && seen.url.includes('slave=') ? { done: true, value: seen } : { done: false, detail: JSON.stringify(seen) }
    })
    console.log(`stage 8: person sheet = ${JSON.stringify(personSheet)}`)
    await clickUntil(
      pg.locator('[data-testid="person-sheet"] [data-testid="sheet-close"]'),
      async () => (await pg.evaluate(() => document.querySelector('[data-testid="person-sheet"]') === null && !window.location.search.includes('slave='))),
      "the person sheet's close",
    )
    console.log(`stage 8: after sheet-close the URL is ${pg.url()}`)
    await pg.close()
    console.log('stage 8 PASSED: the catalogue is one button away, a row is a Sheet, and ?slave= is still the source of truth')
  }

  // ============================================================================================
  // Stage 9: the Office (spec §5.9, R17).
  //
  // "Mono type inside the canvas stays (it is drawn by the canvas); mono type in the DOM around it
  // goes." The canvas element itself and anything inside it are exempt; everything else inside
  // `<main>` is read off `getComputedStyle`.
  // ============================================================================================
  {
    const ctx = await modeContext('simple')
    const pg = await ctx.newPage()
    pg.setDefaultTimeout(ACTION_TIMEOUT_MS)
    await gotoReliably(`${baseUrl}/w/${workspaceId}/office`, pg)
    await waitVisible(pg.getByTestId('office-canvas'), 'the office canvas')
    await waitVisible(pg.getByTestId('office-toolbar'), 'the office glass toolbar')
    await waitForMode(pg, 'simple')
    const offenders = await pg.evaluate(() => {
      const canvas = document.querySelector('[data-testid="office-canvas"]')
      const out = []
      let scanned = 0
      for (const node of document.querySelectorAll('main *')) {
        if (canvas !== null && (node === canvas || canvas.contains(node))) continue
        scanned += 1
        const family = getComputedStyle(node).fontFamily
        if (/silkscreen|monospace|ui-monospace/i.test(family)) {
          out.push({
            testId: node.getAttribute('data-testid'),
            tag: node.tagName.toLowerCase(),
            family,
            text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
          })
        }
      }
      return { out, scanned }
    })
    console.log(`stage 9: scanned ${String(offenders.scanned)} element(s) inside <main> outside the canvas`)
    if (offenders.scanned === 0) await fail('stage 9: nothing was scanned -- the office page rendered no DOM around its canvas')
    if (offenders.out.length > 0) {
      await fail(`stage 9: mono/pixel type in the DOM around the canvas in simple mode: ${JSON.stringify(offenders.out.slice(0, 8))}`)
    }
    await pg.close()
    console.log('stage 9 PASSED: a glass toolbar, and the pixel font stays inside the canvas that draws it')
  }

  // ============================================================================================
  // Stage 10: nothing was removed, only moved -- in BOTH modes (spec §5.10, `docs/ia.md` rule 2).
  //
  // THE INVENTORY IS `docs/ia.md`'S OWN, ALL OF IT, plus every `?tab=` and `?view=` value the
  // product accepts. There is no `?mode=` value to sweep: R1 puts the mode in `localStorage` and
  // on `<html>`, never in the URL -- which is why this stage runs the whole list TWICE, once per
  // mode, instead of appending a query parameter.
  //
  // TWO TIERS: a SHELL route answers 200 and draws the `Main` navigation landmark (the rail, spec
  // erratum E9); an EDGE route answers 200 and a marker of its own, because `/login` deliberately
  // renders no tree body (ruling T3-3) and the other three are not in the per-project sweep.
  // ============================================================================================
  {
    const SHELL_ROUTES = [
      '/', '/workforce', '/workforce?tab=slaves', '/workforce?tab=departments', '/workforce?tab=catalog',
      '/workforce?tab=skills', '/workforce?tab=runbooks', '/workforce?tab=evidence',
      '/slaves', '/skills', '/settings', '/sim', `/analytics?workspace=${workspaceId}`,
      `/w/${workspaceId}`, `/w/${workspaceId}/tasks`, `/w/${workspaceId}/organization`,
      `/w/${workspaceId}/knowledge`, `/w/${workspaceId}/activity`, `/w/${workspaceId}/activity?view=digest`,
      `/w/${workspaceId}/settings`, `/w/${workspaceId}/graph`, `/w/${workspaceId}/office`,
    ]
    const EDGE_ROUTES = [
      ['/analytics', 'kpi-tile', true],
      ['/login', 'login-unconfigured', false],
      [`/sim/${simulationAId}`, 'sim-company', true],
      [`/sim/compare?a=${simulationAId}&b=${simulationBId}`, 'sim-compare-strip', true],
    ]
    let swept = 0
    for (const mode of ['simple', 'developer']) {
      const ctx = await modeContext(mode)
      const pg = await ctx.newPage()
      pg.setDefaultTimeout(ACTION_TIMEOUT_MS)
      for (const route of SHELL_ROUTES) {
        const response = await pg.goto(`${baseUrl}${route}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
        const status = response === null ? null : response.status()
        console.log(`stage 10 (${mode}, shell): ${route} -> ${String(status)}`)
        if (status !== 200) await fail(`stage 10: ${route} answered ${String(status)} in ${mode} -- ia.md rule 2 says every destination still answers`)
        await waitVisible(pg.getByRole('navigation', { name: 'Main' }), `the rail on ${route} in ${mode}`)
        swept += 1
      }
      for (const [route, marker, alsoTheShell] of EDGE_ROUTES) {
        const response = await pg.goto(`${baseUrl}${route}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
        const status = response === null ? null : response.status()
        console.log(`stage 10 (${mode}, edge): ${route} -> ${String(status)} (marker [data-testid=${marker}])`)
        if (status !== 200) await fail(`stage 10: ${route} answered ${String(status)} in ${mode}`)
        await waitVisible(pg.getByTestId(marker), `${route}'s own marker [data-testid=${marker}] in ${mode}`)
        if (alsoTheShell) await waitVisible(pg.getByRole('navigation', { name: 'Main' }), `the rail on ${route} in ${mode}`)
        swept += 1
      }
      await pg.close()
      await ctx.close()
    }
    console.log(`stage 10 PASSED: ${String(swept)} destination loads across two modes -- every route docs/ia.md names, and every ?tab= and ?view= value`)
  }

  // ============================================================================================
  // Stage 11: the vocabulary, and the two greps R15 and R3 make into promises (spec §5.11).
  // ============================================================================================
  {
    const vocabulary = execFileSync('npm', ['run', '--silent', 'gate:m26-vocabulary'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    console.log(`stage 11: gate:m26-vocabulary said ${JSON.stringify(vocabulary.trim().split('\n').slice(-3).join(' | '))}`)

    /** `grep -rn`, with "nothing matched" (exit 1) answered as an empty list rather than a throw. */
    function grepLines(pattern) {
      try {
        return execFileSync('grep', ['-rn', pattern, 'apps/web/src'], { cwd: repoRoot, encoding: 'utf8' })
          .split('\n')
          .filter((line) => line.trim() !== '')
      } catch (error) {
        if (error !== null && typeof error === 'object' && 'status' in error && error.status === 1) return []
        throw error
      }
    }

    const motionHits = grepLines("from 'motion")
    const motionFiles = [...new Set(motionHits.map((line) => line.split(':')[0]))]
    console.log(`stage 11: files importing the motion package = ${JSON.stringify(motionFiles)}`)
    const ALLOWED_MOTION_FILES = ['apps/web/src/components/ui/Sheet.tsx', 'apps/web/src/components/ui/motion.ts']
    const strays = motionFiles.filter((file) => !ALLOWED_MOTION_FILES.includes(file))
    if (strays.length > 0) {
      assert(false, `stage 11: ${JSON.stringify(strays)} import the motion package -- R15 allows only ${JSON.stringify(ALLOWED_MOTION_FILES)}`)
    }
    assert(
      motionFiles.includes('apps/web/src/components/ui/Sheet.tsx'),
      'stage 11: nothing imports the motion package at all -- ui/Sheet.tsx is supposed to be the one file that does',
    )

    const transitionAll = grepLines('transition: all\\|transition-all')
    console.log(`stage 11: "transition: all" / "transition-all" hits = ${String(transitionAll.length)}`)
    assert(transitionAll.length === 0, `stage 11: something animates every property: ${JSON.stringify(transitionAll.slice(0, 5))}`)
    console.log('stage 11 PASSED: one vocabulary, the motion dependency confined to the files R15 names, and nothing transitioning all')
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
  // FK-ordered. `ExecutionEvent` has no FK to `Workspace` (M2's append-only log outlives entity
  // lifecycles by design) so it goes explicitly first; the workspace delete then cascades
  // Team/Slave/Task/SlaveRun/SupervisorDecision/GoalVersion.
  for (const id of [workspaceId, otherWorkspaceId]) {
    if (id === null) continue
    await prisma.executionEvent.deleteMany({ where: { workspaceId: id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id } }).catch(() => {})
  }
  for (const id of [simulationAId, simulationBId]) {
    if (id !== null) await prisma.simulationRun.delete({ where: { id } }).catch(() => {})
  }
  if (companyId !== null) await prisma.company.delete({ where: { id: companyId } }).catch(() => {})
  // M58 R1: this gate's PEOPLE. A person is not cascaded away with the workspace whose seat held
  // them, nor with the company whose department listed them.
  await prisma.person.deleteMany({ where: { name: { in: GATE_PERSON_NAMES } } }).catch(() => {})
  if (templateId !== null) await prisma.slaveTemplate.delete({ where: { id: templateId } }).catch(() => {})
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
