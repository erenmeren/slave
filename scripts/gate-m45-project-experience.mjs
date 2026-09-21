// M45's own gate (spec R7): "open a project and understand it in ten seconds, then talk to ONE
// Supervisor".
//
// `gate-m44-ux-foundation.mjs`'s shape -- a free port, a real `next dev`, a real Chromium through
// `playwright-core` at CHROMIUM_PATH, no daemon -- plus a fixed scenario written with control verbs
// and prisma before the browser opens.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m45-project-experience
//
// THIS GATE SPENDS NOTHING AND CANNOT. It dispatches no run, so no CLI is ever invoked for a model
// -- and the preflight still REFUSES to start unless SLAVEOFAI_CLAUDE_BIN points at an executable
// under `scripts/gate-fakes/` and SLAVEOFAI_REQUIRE_FAKE_CLI=1, so a later stage that grows a run
// cannot quietly reach a real account. The two CLI calls it does make (`set-goal`,
// `request-change`, `replan-status`) are database verbs: none of them starts a process.
//
// IT WRITES ITS OWN SCENARIO, and that is the point (m44's erratum E10, again): the seeded
// database has no SupervisorDecision, no pending question, no un-integrated `done` task and no
// spend, so "the needs-you list has exactly four entries" would pass against an empty page. Every
// row it writes is deleted in the `finally`, in FK order, and `git status` after a green run has to
// be empty.
//
// The eight stages of R7:
//   1. The four fact tiles render inside the first viewport at 1440x900, with the expected words --
//      and the four facts that left the grid in M57 R17/R18 (the objective, the needs-you queue,
//      the team and the recent changes) are asserted on the surfaces they moved to.
//   2. The timeline shows the six lanes with the seeded entries in the RIGHT lanes, and no run.*
//      chatter anywhere on the page.
//   3. The needs-you list has exactly four entries, and every link resolves.
//   4. Approving the seeded proposal FROM THE TIMELINE cancels the task and the lane updates.
//   5. "Tell the Supervisor" is a MESSAGE now (F erratum E8): the composer writes the person's own
//      line and the reply placeholder the daemon settles, and writes no goal version at all.
//   6. A task row discloses its raw values only inside `Details` groups.
//   7. `data-simulation` never appears on the project page.
//   8. Every raw event type stays out of the visible words and inside `data-event-type`/`title`.
//
// THE GATE ASSERTS, IT NEVER FIXES. Every stage prints every measured value before asserting it.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: like `gate-m14-fidelity.mjs`,
// `gate-m16-chrome.mjs` and `gate-m44-ux-foundation.mjs`, it boots `next dev` against the repo's
// own `apps/web/.next` on a freshly-chosen free port, and a second `next dev` sharing that
// directory corrupts the on-disk build cache for both. Stop any running dev server first
// (`pgrep -af "next dev"`).

import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { chromium } from 'playwright-core'
import { prisma } from '../packages/db/dist/client.js'
import { EVENT_TYPE_BY_DOMAIN_TYPE } from '../packages/db/dist/enums.js'
import { LANE_LABEL, TIMELINE_LANES } from '../packages/domain/dist/index.js'

const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 100
/** `gate-m14-fidelity.mjs`'s own signature for next dev's torn `loadManifest` read. */
const MANIFEST_RACE_SIGNATURE = 'Unexpected end of JSON input'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const PASS_LINE = 'four fact tiles in one screen, six lanes, four things needing a person, and one Supervisor to tell'

// Suffixed per run (`gate-m44-ux-foundation.mjs`'s idiom): `Workspace.name` IS unique, and a
// distinct name per run keeps two overlapping executions from colliding on it. `preflightCleanup`
// removes leftovers by PREFIX.
const STAMP = new Date().toISOString().slice(11, 19)
const WORKSPACE_PREFIX = 'M45 Gate Project'
const WORKSPACE_NAME = `${WORKSPACE_PREFIX} ${STAMP}`
const TEAM_NAME = 'M45 Gate Department'
const DEVELOPER_NAME = 'Ada'
const REVIEWER_NAME = 'Bo'

const GOAL_V1 = 'Ship the checkout flow.'
const REQUEST_V2 = 'Add Apple Pay'
const REQUEST_V3 = 'Also support Google Pay'

const BLOCKED_REASON = 'the payment sandbox rejected every card'
const BLOCKED_BRANCH = 'slaveofai/m45-gate-blocked'
const BLOCKED_WORKTREE = '/tmp/slaveofai-m45-gate/worktrees/blocked'
/** The literal one `run.tool_call` payload carries, so stage 2's negative is not vacuous: a river
 *  of model chatter merged into the six lanes would put this string on the page. */
const CHATTER = 'GATE-CHATTER-MUST-NOT-APPEAR'
/** A role no seeded slave holds, which is what makes the seeded question unanswerable by anybody
 *  but a person (`holdersOf` in `packages/control/src/supervisorWorld.ts`). */
const NOBODY_ROLE = 'nobody-holds-this'

// M61 R7: the four-tile brief is gone as a WIDGET (`ProjectBrief.tsx` was deleted with the
// Overview) and each of its facts has a home -- spec §3 names the replacement:
// `brief`/`strip` -> `stat-goal` / `stat-work` / `stat-spend`. These are the three tiles the Team
// tab draws under the grid, in DOM order, and stage 1 measures the same thing it always did
// against them: that the facts are on ONE SCREEN.
//
// The two facts that are NOT one of the three tiles are asserted on the surfaces they moved to
// rather than dropped: the objective's own text and version are `stat-goal`'s value and note
// (M61 Task 11, controller Ruling 9), the SUPERVISOR's state is the right panel (`docs/ia.md`,
// "the Supervisor panel is the RIGHT PANEL on every project page") and the LATEST VERIFIED task
// is the Activity tab's river, where `task.integrated` already lived.
const EXPECTED_STAT_TILES = ['stat-goal', 'stat-work', 'stat-spend']

/** The first viewport. "Ten seconds" is a claim about ONE SCREEN, and stage 1 measures it. */
const VIEWPORT = { width: 1440, height: 900 }

/** A dotted raw event type as a whole string -- what stage 8 forbids as visible text and requires
 *  on `data-event-type`. */
const DOTTED_TYPE = /^(task|run|slave|workspace|org|supervisor|guardrail)\.[a-z_]+$/u

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Asks the OS for a free TCP port. `next dev -p <port>` still auto-increments if something grabs
 *  it between this call and the spawn, so the ready-wait parses the ACTUAL bound port back out of
 *  next dev's own ready line rather than trusting this one blindly.
 *  (`scripts/gate-m44-ux-foundation.mjs`, verbatim.) */
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
  const stale = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true },
  })
  for (const workspace of stale) {
    console.log(`preflight: removing leftover workspace ${workspace.id} (${workspace.name})`)
    // `ExecutionEvent` has no FK to `Workspace` (M2's append-only log outlives entity lifecycles
    // by design) so it goes explicitly first; the workspace delete cascades everything else.
    await prisma.executionEvent.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {})
    await prisma.slaveMessage.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {})
  }
}

let exitCode = 1
let nextServer = null
let nextOutput = ''
let browser = null
let page = null
let diagDir = null
let workspaceId = null
/** The browser console, newest last, for `fail()`'s dump. */
const browserConsole = []
/** Every URL `gotoReliably` retried, printed beside the PASS line so a rising rate is visible in
 *  GREEN runs too (`gate-m14-fidelity.mjs`'s accounting). */
const gotoRetries = []

try {
  diagDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m45-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // ============================================================================================
  // Stage 0: preflight, and the scenario every later stage reads.
  // ============================================================================================

  // Zero spend, ENFORCED (Decision 10, M32 item 7). This gate dispatches nothing today; the
  // refusal is here so that a later stage which grows a run cannot quietly reach a real account.
  const fakeClaude = process.env['SLAVEOFAI_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'SLAVEOFAI_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m45-project-experience',
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
      `no .env at ${envPath} -- this gate reads DATABASE_URL from it (npm run gate:m45-project-experience passes ` +
        '--env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m45-project-experience`')
  }
  if (!existsSync(ORCHESTRATOR_CLI)) {
    throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI} -- run \`npx tsc --build\` first`)
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
  // The lanes this gate checks are the DOMAIN's own list, never a second one typed here.
  assert(TIMELINE_LANES.length === 6, `the domain declares ${String(TIMELINE_LANES.length)} timeline lanes, expected 6`)
  console.log(`domain lanes: ${JSON.stringify(TIMELINE_LANES.map((lane) => [lane, LANE_LABEL[lane]]))}`)

  await preflightCleanup()

  /** The orchestrator CLI as an operator's shell would run it. Throws on a non-zero exit.
   *  (`gate-m40-requirement-versioning.mjs`'s `runCli`, with this gate's own child env: the fake
   *  binary and the refusal flag ride through from the parent, and the session secret is blanked
   *  so nothing this spawns can be talked into account mode.) */
  const runCli = (args) =>
    execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
      cwd: repoRoot,
      env: loopbackChildEnv({ SLAVEOFAI_REQUIRE_FAKE_CLI: '1' }),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  // ---- The project. Every row exists to make one assertion below mean something. ---------------
  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath: repoRoot,
      verifyCommands: [],
      setupCommands: [],
      // A HAND-MERGE project: `autoMerge: false` is what makes a `done` task with no `integratedAt`
      // "ready to integrate" rather than merely finished (`needsYou`'s third rule), which is one of
      // stage 3's four entries.
      autoMerge: false,
      budgetUsd: 25,
      supervisorEnabled: true,
    },
  })
  workspaceId = workspace.id
  const team = await prisma.team.create({ data: { workspaceId, name: TEAM_NAME } })
  const developer = await prisma.slave.create({ data: { teamId: team.id, role: 'developer', runtimeRoles: ['developer'], model: 'sonnet', provider: 'claude_code', personId: (await prisma.person.upsert({ where: { name: DEVELOPER_NAME }, create: { name: DEVELOPER_NAME }, update: { templateId: null, profile: null, model: null, provider: null, capabilities: [], lifecycle: 'project', releasedAt: null, releaseReason: null, selectionRationale: null } })).id } })
  const reviewer = await prisma.slave.create({ data: { teamId: team.id, role: 'reviewer', runtimeRoles: ['reviewer'], model: 'sonnet', provider: 'claude_code', personId: (await prisma.person.upsert({ where: { name: REVIEWER_NAME }, create: { name: REVIEWER_NAME }, update: { templateId: null, profile: null, model: null, provider: null, capabilities: [], lifecycle: 'project', releasedAt: null, releaseReason: null, selectionRationale: null } })).id } })
  console.log(`stage 0: workspace ${workspaceId} (${WORKSPACE_NAME}) · team ${team.id}`)
  console.log(`stage 0: slaves ${developer.id} (${DEVELOPER_NAME}/developer) · ${reviewer.id} (${REVIEWER_NAME}/reviewer)`)

  // ---- The goal, through the REAL verbs. A fixture row here would prove nothing about R3. -------
  const setGoalOutput = runCli(['set-goal', '--workspace', workspaceId, '--goal', GOAL_V1])
  console.log(`stage 0: set-goal printed ${JSON.stringify(setGoalOutput.trim())}`)
  const v1Printed = JSON.parse(setGoalOutput)
  assert(v1Printed.version === 1, `stage 0: set-goal printed version ${String(v1Printed.version)}, expected 1`)
  const requestOutput = runCli(['request-change', '--workspace', workspaceId, '--request', REQUEST_V2])
  console.log(`stage 0: request-change printed ${JSON.stringify(requestOutput.trim())}`)
  const v2Printed = JSON.parse(requestOutput)
  assert(v2Printed.version === 2, `stage 0: request-change printed version ${String(v2Printed.version)}, expected 2`)
  const v2Row = await prisma.goalVersion.findFirst({ where: { workspaceId, version: 2 }, select: { request: true, text: true } })
  console.log(`stage 0: GoalVersion v2.request = ${JSON.stringify(v2Row?.request)}`)
  assert(v2Row !== null, 'stage 0: no GoalVersion v2 row was written')
  assert(
    v2Row.request === REQUEST_V2,
    `stage 0: GoalVersion v2.request is ${JSON.stringify(v2Row.request)}, expected ${JSON.stringify(REQUEST_V2)}`,
  )
  assert(
    v2Row.text.includes(GOAL_V1) && v2Row.text.includes(REQUEST_V2),
    `stage 0: GoalVersion v2.text lost the body or the request: ${JSON.stringify(v2Row.text)}`,
  )

  // ---- Seven tasks, one per state, plus the integrated one. -------------------------------------
  // `goalVersion: 1` on every one of them, so the board is a version behind the goal `request-change`
  // wrote above -- which is what stage 3's `stale_task` proposal and stage 1's goal tile are about.
  // (It used to be what stage 5's `replan-status` measured; F moved that claim to
  // `gate:m39-supervisor-mailbox` stage 6, see stage 5 below.)
  const task = async (title, status, extra = {}) =>
    prisma.task.create({
      data: {
        workspaceId,
        title,
        description: `${title} — seeded by gate:m45-project-experience.`,
        status,
        maxAttempts: 3,
        goalVersion: 1,
        ...extra,
      },
    })
  const readyTask = await task('Wire the gift-card page', 'ready')
  const runningTask = await task('Add the Apple Pay button', 'running', { assigneeId: developer.id })
  const verifyingTask = await task('Validate the card form', 'verifying', { assigneeId: developer.id })
  const reviewingTask = await task('Review the checkout summary', 'reviewing', { assigneeId: reviewer.id })
  const waitingTask = await task('Pick the payment sandbox', 'waiting', { assigneeId: developer.id, requiredRole: 'developer' })
  const blockedTask = await task('Charge a real test card', 'blocked', {
    assigneeId: developer.id,
    lastRejectionReason: BLOCKED_REASON,
    branch: BLOCKED_BRANCH,
  })
  const doneTask = await task('Write the receipt email', 'done')
  const integratedTask = await task('Model the basket', 'done', { integratedAt: new Date() })
  const tasks = [
    ['ready', readyTask],
    ['running', runningTask],
    ['verifying', verifyingTask],
    ['reviewing', reviewingTask],
    ['waiting', waitingTask],
    ['blocked', blockedTask],
    ['done (not integrated)', doneTask],
    ['done (integrated)', integratedTask],
  ]
  for (const [what, row] of tasks) console.log(`stage 0: task ${row.id} status=${row.status} — ${what} — ${row.title}`)

  // ---- Runs: one measured, one unmeasured, one parked on a question. ----------------------------
  const succeededRun = await prisma.slaveRun.create({
    data: { taskId: integratedTask.id, slaveId: developer.id, status: 'succeeded', provider: 'claude_code', costUsd: 3.5, toolCalls: 12 },
  })
  // `costUsd: null` on a CONCLUDED run is the unmeasured-run hole (M32): counted apart, never
  // folded into the total as a zero. Its `worktreePath` is what stage 6 folds and unfolds.
  const failedRun = await prisma.slaveRun.create({
    data: {
      taskId: blockedTask.id,
      slaveId: developer.id,
      status: 'failed',
      provider: 'claude_code',
      costUsd: null,
      toolCalls: 4,
      worktreePath: BLOCKED_WORKTREE,
    },
  })
  // The run the question parked. `stillPendingQuestion` (packages/control/src/messaging.ts) only
  // counts a question whose SENDER RUN is `paused`/`waiting_for_answer` -- without this row the
  // seeded question is not pending, the needs-you queue has three entries and stage 3 would be
  // asserting against a queue this gate never really built.
  const waitingRun = await prisma.slaveRun.create({
    data: {
      taskId: waitingTask.id,
      slaveId: developer.id,
      status: 'paused',
      pauseReason: 'waiting_for_answer',
      provider: 'claude_code',
      toolCalls: 7,
    },
  })
  console.log(`stage 0: runs ${succeededRun.id} succeeded $3.50 · ${failedRun.id} failed (unmeasured) · ${waitingRun.id} paused on a question`)

  // ---- The question nobody holds. `threadId` is the opener's own id, so both are generated here
  //      (the application-side rule `SlaveMessage.threadId`'s own doc comment states).
  const questionId = randomUUID()
  const question = await prisma.slaveMessage.create({
    data: {
      id: questionId,
      threadId: questionId,
      workspaceId,
      taskId: waitingTask.id,
      slaveId: developer.id,
      senderRunId: waitingRun.id,
      recipientRole: NOBODY_ROLE,
      kind: 'question',
      body: 'Which payment sandbox account may I charge?',
      actor: 'slave',
      expectsReply: true,
    },
  })
  console.log(`stage 0: question ${question.id} to role ${JSON.stringify(NOBODY_ROLE)} — nobody can answer it but a person`)

  // ---- The pending proposal, about the READY task. ---------------------------------------------
  const decision = await prisma.supervisorDecision.create({
    data: {
      workspaceId,
      situationKind: 'stale_task',
      subjectId: readyTask.id,
      situation: {
        kind: 'stale_task',
        subjectId: readyTask.id,
        summary: 'This work was planned for an older version of the goal.',
        facts: { taskGoalVersion: 1, workspaceGoalVersion: 2 },
      },
      candidates: [
        { action: { kind: 'cancel_task', taskId: readyTask.id, reason: 'the goal moved' }, tier: 'proposed', why: 'nothing on the current goal needs it' },
      ],
      chosenIndex: 0,
      action: { kind: 'cancel_task', taskId: readyTask.id, reason: 'the goal moved' },
      rationale: 'The goal moved to v2 and this task was derived from v1; cancelling it costs one backlog row.',
      tier: 'proposed',
      status: 'pending',
      decidedBy: 'model',
      modelCalled: false,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  })
  // A SECOND, already-resolved decision whose model call was MADE and never reported a cost. It is
  // what puts a real figure behind stage 1's `unmeasured calls charged at $1.00 each` sentence:
  // `workspaceSpend`'s unmeasured tally is `modelCalled && modelCostUsd == null`, and the pending
  // proposal above is deliberately `modelCalled: false` (the brief's shape), so without this row
  // that sentence would not render at all and the assertion would be asserting an absence.
  // Resolved, so it never joins the pending queue stage 3 counts.
  const unmeasuredDecision = await prisma.supervisorDecision.create({
    data: {
      workspaceId,
      situationKind: 'waiting_stale',
      subjectId: waitingTask.id,
      situation: {
        kind: 'waiting_stale',
        subjectId: waitingTask.id,
        summary: 'This task has been waiting on an answer for a long time.',
        facts: { minutesWaiting: 90 },
      },
      candidates: [{ action: { kind: 'no_action' }, tier: 'noop', why: 'waiting is still the right move' }],
      chosenIndex: 0,
      action: { kind: 'no_action' },
      rationale: 'Waiting is still the right move; a person has been told.',
      tier: 'proposed',
      status: 'rejected',
      decidedBy: 'model',
      modelCalled: true,
      modelCostUsd: null,
      resolvedAt: new Date(),
    },
  })
  console.log(`stage 0: decision ${decision.id} stale_task/proposed/pending about task ${readyTask.id}`)
  console.log(`stage 0: decision ${unmeasuredDecision.id} rejected, modelCalled with no cost — the unmeasured call`)

  // ---- The events the timeline reads. Written in this order, so `seq` is the story's own order.
  const event = async (type, extra = {}) =>
    prisma.executionEvent.create({
      data: {
        type: EVENT_TYPE_BY_DOMAIN_TYPE[type],
        workspaceId,
        actor: 'system',
        payload: {},
        ...extra,
      },
    })
  // `workspace.goal_set` x2 is already in the log: `set-goal` and `request-change` wrote them
  // through the real verb, and the second carries the request words on its payload (R3).
  await event('workspace.replan_started', { payload: { version: 2, runId: succeededRun.id } })
  // The FULL payload `packages/domain/src/events/schema.ts` requires (M61 Task 11): `runId` and
  // `droppedCancellations` are not optional there, and `activity/cards.tsx`'s
  // `WorkspaceReplannedCard` reads `droppedCancellations.length` straight off the row. This
  // fixture wrote neither, so the card threw the moment the river drew it -- a client-side crash
  // that took the whole Activity page with it, found once M61's bounded scroll region put this
  // row inside the virtualizer's rendered window.
  await event('workspace.replanned', {
    payload: { version: 2, runId: succeededRun.id, added: [runningTask.id], proposedCancellations: [], droppedCancellations: [] },
  })
  await event('task.created', { taskId: runningTask.id, payload: { title: runningTask.title } })
  await event('task.started', { taskId: runningTask.id, slaveId: developer.id, payload: { title: runningTask.title } })
  await event('task.verify_passed', { taskId: verifyingTask.id, payload: { title: verifyingTask.title } })
  await event('task.review_approved', { taskId: reviewingTask.id, payload: { title: reviewingTask.title } })
  await event('task.integrated', { taskId: integratedTask.id, payload: { title: integratedTask.title } })
  // The chatter. NOT on any lane (`LANE_BY_TYPE['run.tool_call']` is null), and its payload carries
  // a literal nothing else on this page can produce -- so stage 2's "no model chatter" is a real
  // measurement rather than a statement about an empty log.
  await event('run.tool_call', {
    actor: 'slave',
    taskId: blockedTask.id,
    slaveId: developer.id,
    runId: failedRun.id,
    payload: { tool: 'Bash', summary: CHATTER },
  })
  // The POSITIVE counterpart of that negative (final wave I2). `run.paused` is a `run.*` type on
  // the WORK IN PROGRESS lane (`LANE_BY_TYPE['run.paused']` is `'work'`), so a negative written as
  // "no type beginning `run.`" would have passed by excluding an event the domain deliberately
  // keeps -- and would have kept passing if the lane table ever dropped it. With this row seeded,
  // stage 2 asserts the two named chatter types are gone AND that this one arrived.
  await event('run.paused', {
    actor: 'slave',
    taskId: waitingTask.id,
    slaveId: developer.id,
    runId: waitingRun.id,
    // The domain's own payload for this type (`ExecutionEvent`'s `run.paused` arm is
    // `{ atStep: number }`), so the row the gate seeds is a row the system could really write.
    payload: { atStep: 7 },
  })
  const seededEvents = await prisma.executionEvent.count({ where: { workspaceId } })
  console.log(
    `stage 0: ${String(seededEvents)} events in the log, including one run.tool_call carrying ${JSON.stringify(CHATTER)} and one run.paused on the WORK IN PROGRESS lane`,
  )
  console.log('stage 0 PASSED: a project with a v2 goal made by request-change, eight tasks, three runs, a question nobody holds, two decisions and a river of chatter')

  // ---- The real web shell, on a free port, loopback-bound. -------------------------------------
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
    const text = chunk.toString()
    nextOutput += text
    process.stdout.write(`[next] ${text}`)
    // `-H 127.0.0.1` changes next's own ready line from `http://localhost:<port>` to
    // `http://127.0.0.1:<port>` -- matching both keeps this resilient to either spelling.
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
  const projectUrl = `${baseUrl}/w/${workspaceId}`
  /** Where the Supervisor's six-lane timeline lives since M61 R10/Task 7 -- it left the deleted
   *  Overview for the Activity tab's raw view, under "Recent changes", where the whole river
   *  already was. Every stage that reads `timeline-*` navigates here. */
  const activityUrl = `${baseUrl}/w/${workspaceId}/activity`
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
    // The STACK, not only the message: a bare `TypeError: Cannot read properties of undefined` is
    // a diagnostic that names no file, and this gate's whole job is to say what broke and where.
    console.error(`[browser:pageerror] ${error}\n${error instanceof Error ? (error.stack ?? '<no stack>') : ''}`)
    browserConsole.push(`[pageerror] ${String(error).slice(0, 300)}`)
  })
  page.on('console', (message) => browserConsole.push(`[${message.type()}] ${message.text().slice(0, 300)}`))
  page.on('requestfailed', (request) => browserConsole.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`))

  /** The m8a-estop-style diagnostic throw (`gate-m14-fidelity.mjs`'s `fail`, minus the daemon it
   *  has and this gate does not): the state that made the call, not just "it timed out". */
  async function fail(message) {
    let screenshotPath = null
    if (page !== null && diagDir !== null) {
      screenshotPath = join(diagDir, `failure-${String(Date.now())}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
    }
    const pageUrl = page === null ? '<no page>' : page.url()
    const rows = await prisma.task
      .findMany({ where: { workspaceId }, select: { id: true, title: true, status: true, integratedAt: true } })
      .then((found) => JSON.stringify(found))
      .catch((cause) => `<could not dump tasks: ${cause instanceof Error ? cause.message : String(cause)}>`)
    throw new Error(
      `${message}\n--- browser url ---\n${pageUrl}\n--- screenshot ---\n${screenshotPath ?? '<none>'}\n` +
        `--- tasks ---\n${rows}\n--- browser console (tail) ---\n${browserConsole.slice(-40).join('\n')}`,
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

  /**
   * Polls `probe` until it reports `{ done: true }`, then returns its `value`.
   *
   * `probe` returns its own `detail` string on every unsatisfied tick, and that string is what the
   * timeout message reports -- so a wait that runs out says what it last SAW rather than only what
   * it wanted. (`gate-m14-fidelity.mjs`'s `waitUntil`, minus the daemon-death check: this gate
   * starts no daemon.)
   */
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

  /**
   * `page.goto`, retried ONCE and only on next dev's own manifest-race signature
   * (`gate-m14-fidelity.mjs`'s `gotoReliably`, whose docblock has the full reasoning). This gate
   * navigates well over thirty times -- eight needs-you round trips alone -- so the retry earns its
   * place here as it does there; a 5xx with no such signature fails immediately, through `fail()`.
   */
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
    // A `null` response is Playwright's own answer for a same-document (anchor) navigation, and
    // four of stage 3's links ARE anchors on the page already open. Accepted, and reported.
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

  /** Clicks `locator`, then bounded-waits for `predicate`. (`gate-m14-fidelity.mjs`'s helper: it
   *  deliberately does NOT re-click on every tick -- a second click would send a second real POST.) */
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
   * Every string a person can actually READ on the page right now, with the testid path of the
   * element that renders it. `gate-m44-ux-foundation.mjs`'s `readVisibleText`, VERBATIM -- the same
   * `nextjs-portal, script, style, [aria-hidden="true"], .sr-only` exclusion, the same three-test
   * distinction between "in the DOM" and "on somebody's screen", and the same `hidden` bucket
   * returned rather than silently dropped.
   */
  async function readVisibleText(root) {
    return page.evaluate((selector) => {
      const scope = selector === null ? document.body : document.querySelector(selector)
      if (scope === null) return { shown: [], hidden: [] }
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
      const shown = []
      const hidden = []
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const parent = node.parentElement
        if (parent === null) continue
        if (parent.closest('nextjs-portal, script, style, [aria-hidden="true"], .sr-only') !== null) continue
        const value = (node.nodeValue ?? '').trim()
        if (value === '') continue
        const owner = parent.closest('[data-testid]')
        const where = owner === null ? parent.tagName.toLowerCase() : `[data-testid="${owner.getAttribute('data-testid') ?? ''}"]`
        const entry = { text: value, where }
        const closed = parent.closest('details:not([open])')
        const summary = closed === null ? null : closed.querySelector(':scope > summary')
        const inSummary = summary !== null && summary.contains(parent)
        const rendered =
          parent.getClientRects().length > 0 && (typeof parent.checkVisibility !== 'function' || parent.checkVisibility())
        if ((closed !== null && !inSummary) || !rendered) hidden.push(entry)
        else shown.push(entry)
      }
      return { shown, hidden }
    }, root ?? null)
  }

  // ============================================================================================
  // Stage 1: the four fact tiles, inside the first viewport -- and the four facts that left the
  // grid in M57, on the surfaces they moved to.
  // ============================================================================================
  await gotoReliably(projectUrl)
  // M61 R7/Task 6: the four-tile brief left `/w/<id>` with the Overview it was part of --
  // `stat-work` is the Team tab's own always-rendered marker that the page has finished its first
  // paint (selector rename only; the fact-tile assertions below this point are a known gap left
  // for a follow-up task -- see the M61 Task 6 report).
  await waitVisible(page.getByTestId('stat-work'), "the project page on /w/<id>")
  const tiles = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="stat-goal"], [data-testid="stat-work"], [data-testid="stat-spend"]')].map((tile) => ({
      fact: tile.getAttribute('data-testid') ?? '',
      bottom: Math.round(tile.getBoundingClientRect().bottom),
      text: (tile.textContent ?? '').replace(/\s+/g, ' ').trim(),
    })),
  )
  console.log(`stage 1: stat tiles in DOM order = ${JSON.stringify(tiles.map((tile) => tile.fact))}`)
  if (JSON.stringify(tiles.map((tile) => tile.fact)) !== JSON.stringify(EXPECTED_STAT_TILES)) {
    await fail(
      `stage 1: the Team tab renders ${JSON.stringify(tiles.map((tile) => tile.fact))}, expected the three tiles ` +
        `${JSON.stringify(EXPECTED_STAT_TILES)}`,
    )
  }
  // THE MILESTONE'S ACTUAL CLAIM, measured rather than paraphrased: "ten seconds" is a claim about
  // ONE SCREEN, and a fact below the fold is a fact nobody read.
  for (const tile of tiles) {
    console.log(`stage 1: tile ${tile.fact} bottom = ${String(tile.bottom)}px (fold at ${String(VIEWPORT.height)}px)`)
  }
  const belowFold = tiles.filter((tile) => tile.bottom > VIEWPORT.height)
  if (belowFold.length > 0) {
    await fail(
      `stage 1: ${JSON.stringify(belowFold.map((tile) => [tile.fact, tile.bottom]))} -- a fact whose bottom edge is below ` +
        `the ${String(VIEWPORT.height)}px fold at ${String(VIEWPORT.width)}x${String(VIEWPORT.height)} is a fact nobody read in ten seconds`,
    )
  }

  const tileText = (fact) => tiles.find((tile) => tile.fact === fact)?.text ?? ''
  // The SAME facts, in M61's words. The work tile counted `WORKING` and `IN REVIEW` as two of
  // `ProjectBrief.work`'s five figures; `stat-work` says how much work is in flight and how much
  // landed, which is the same question asked once. The cost tile's `$25` total and its
  // unmeasured-calls caveat are `stat-spend`'s value and note -- the caveat is M32's upper-bound
  // policy and it is on the tile again (M61 Task 11) rather than nowhere.
  const wants = [
    ['stat-work', 'in progress'],
    ['stat-work', 'done'],
    ['stat-spend', '$25'],
    ['stat-spend', 'unmeasured calls charged at $1.00 each'],
  ]
  for (const [fact, needle] of wants) {
    const text = tileText(fact)
    console.log(`stage 1: ${fact} tile ${JSON.stringify(text.slice(0, 160))}`)
    if (!text.includes(needle)) {
      await fail(`stage 1: the ${fact} tile does not say ${JSON.stringify(needle)} -- it reads ${JSON.stringify(text)}`)
    }
  }

  // M57 R17 / M61 R7: the objective is `stat-goal` -- its value is the goal's own words and its
  // note is the version (controller Ruling 9), with the raw number on `data-goal-version` the way
  // `docs/ia.md` rule 3 asks. The same two things are asserted as ever: the goal text and its
  // version.
  const goalLine = await page.evaluate(
    () => document.querySelector('[data-testid="project-goal-line"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  )
  const goalVersion = await page.evaluate(
    () => document.querySelector('[data-testid="stat-goal"] [data-goal-version]')?.getAttribute('data-goal-version') ?? null,
  )
  console.log(`stage 1: goal line = ${JSON.stringify(goalLine)}, data-goal-version = ${JSON.stringify(goalVersion)}`)
  if (!goalLine.includes(GOAL_V1)) {
    await fail(`stage 1: the goal line does not say ${JSON.stringify(GOAL_V1)} -- it reads ${JSON.stringify(goalLine)}`)
  }
  if (goalVersion !== '2') {
    await fail(`stage 1: stat-goal's note reads version ${JSON.stringify(goalVersion)}, expected "2" -- request-change wrote a v2`)
  }
  const goalNote = await page.evaluate(
    () => document.querySelector('[data-testid="stat-goal"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  )
  if (!goalNote.includes('v2')) {
    await fail(`stage 1: stat-goal does not PRINT the version -- it reads ${JSON.stringify(goalNote)}`)
  }

  // M57 R18: the team left the tile grid for the Team ROWS, which list EVERY worker rather than the
  // five the tile sliced to. Same two names, more of them.
  // M61 R7 review fix round 1, Ruling 6: `[data-testid="team"] [data-testid="slave-card"]` ->
  // `[data-testid="team-live"] [data-testid="team-card"]` (the Team tab's own root and row now).
  const teamNames = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="team-live"] [data-testid="team-card"]')].map((row) =>
      (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ),
  )
  console.log(`stage 1: team rows = ${JSON.stringify(teamNames)}`)
  for (const needle of [DEVELOPER_NAME, REVIEWER_NAME]) {
    if (!teamNames.some((row) => row.includes(needle))) {
      await fail(`stage 1: no Team row names ${JSON.stringify(needle)} -- rows read ${JSON.stringify(teamNames)}`)
    }
  }

  // M57: the needs-you tile became the Needs-you CARD, above the tiles. It was asserted nowhere in
  // this gate before (the tile was only in EXPECTED_BRIEF_FACTS); it is asserted now, because a
  // surface that answers a decision in place is a stronger claim than a surface that lists one.
  const needsYouRows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="needs-you-row"]')].map((row) => row.getAttribute('data-kind') ?? ''),
  )
  console.log(`stage 1: needs-you rows = ${JSON.stringify(needsYouRows)}`)
  if (!needsYouRows.includes('decision')) {
    await fail(`stage 1: the Needs you card does not carry the seeded pending decision -- it reads ${JSON.stringify(needsYouRows)}`)
  }

  // M61 R7 review fix round 1, Ruling 6: `brief-supervisor-state` is parked, not renamed -- the
  // Supervisor's state lives in the right panel since M61; no tile.

  // M57 R17: "recent changes" is the `recent-changes` section now, not a five-line tile. The two
  // things this block has always asserted are asserted still: there ARE rows, and none of them
  // prints a raw dotted event type (`docs/ia.md` rule 3).
  //
  // M61 R7 review fix round 1, Ruling 6: `recent-changes`/`timeline-entry` moved off the deleted
  // Overview to `/w/<id>/activity`, under "Recent changes" -- but only once Task 7 mounts
  // `OverviewPanels`/`SupervisorTimeline` there. THIS STAGE IS RED UNTIL TASK 7 LANDS: navigating
  // here is the correct target, not a working fix, and `fail()` below will fire for real until
  // that task's own commit.
  await gotoReliably(`${baseUrl}/w/${workspaceId}/activity`)
  const changes = await page.evaluate(() => {
    const section = document.querySelector('[data-testid="recent-changes"]')
    return section === null
      ? []
      : [...section.querySelectorAll('[data-testid="timeline-entry"]')].map((row) =>
          (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
        )
  })
  console.log(`stage 1: recent changes = ${JSON.stringify(changes)}`)
  if (changes.length === 0) {
    await fail('stage 1: the recent-changes section has no entries -- the two goal_set events this gate wrote should be in it')
  }
  for (const line of changes) {
    for (const word of line.split(/\s+/)) {
      if (DOTTED_TYPE.test(word)) {
        await fail(`stage 1: a recent-changes row prints the raw event type ${JSON.stringify(word)}: ${JSON.stringify(line)}`)
      }
    }
  }
  // M45 R1's `latest verified` fact. The brief tile that carried it went with `ProjectBrief.tsx`
  // (M61 R7) and the question it answered -- "what was the last thing that actually landed?" --
  // is answered by the Activity tab's river, where `task.integrated` already lived before any of
  // this. The SAME two things are asserted, on the surface they moved to: the task's own title,
  // and the fact that it was integrated, said in words (stage 8 is what forbids the raw type).
  // POLLED, not read once: the river is VIRTUALISED (M61 R4 put it inside a bounded `ScrollArea`),
  // so its rows mount after the viewport has a measured height and the fetch has landed -- a
  // single read on the load frame sees an empty list and proves nothing.
  const verified = await waitUntil('the Activity river to draw its cards', ACTION_TIMEOUT_MS, async () => {
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="activity-card"]')].map((card) => ({
        type: card.querySelector('[data-testid="event-kind"]')?.getAttribute('title') ?? null,
        text: (card.textContent ?? '').replace(/\s+/g, ' ').trim(),
      })),
    )
    return cards.length > 0 ? { done: true, value: cards } : { done: false, detail: '0 activity-card(s)' }
  })
  const integratedCards = verified.filter((card) => card.type === 'task.integrated')
  console.log(`stage 1: task.integrated cards on the river = ${JSON.stringify(integratedCards.map((card) => card.text.slice(0, 120)))}`)
  if (integratedCards.length === 0) {
    await fail(
      `stage 1: no task.integrated card on the Activity river -- the latest-verified fact has nowhere to be read ` +
        `(${String(verified.length)} card(s) on the page)`,
    )
  }
  for (const needle of [integratedTask.title, 'integrated']) {
    if (!integratedCards.some((card) => card.text.toLowerCase().includes(needle.toLowerCase()))) {
      await fail(
        `stage 1: the task.integrated card does not say ${JSON.stringify(needle)} -- it reads ` +
          `${JSON.stringify(integratedCards.map((card) => card.text.slice(0, 160)))}`,
      )
    }
  }

  console.log(
    'stage 1 PASSED: three tiles, the objective and its version on stat-goal, the team in rows, the changes in the ' +
      'timeline and the latest verified task on the river -- every tile above the fold at 1440x900, saying what R1 promises',
  )

  // ============================================================================================
  // Stage 2: six lanes, the right entries, and no model chatter.
  // ============================================================================================
  // M61 R7 review fix round 1, Ruling 6: `supervisor-timeline` moved off the deleted Overview to
  // `/w/<id>/activity` alongside `recent-changes` above -- re-navigated here too (stage 1 already
  // left the browser there, but this stage does not depend on that). STILL RED UNTIL TASK 7 LANDS
  // (see stage 1's own note): `SupervisorTimeline` is not mounted on `/activity` yet.
  await gotoReliably(`${baseUrl}/w/${workspaceId}/activity`)
  await waitVisible(page.getByTestId('supervisor-timeline'), "the project's own timeline")
  const laneButtons = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="timeline-lanes"] button')].map((button) => [
      button.getAttribute('data-lane') ?? '',
      (button.textContent ?? '').trim(),
    ]),
  )
  console.log(`stage 2: lane filters = ${JSON.stringify(laneButtons)}`)
  const expectedLanes = TIMELINE_LANES.map((lane) => [lane, LANE_LABEL[lane]])
  if (JSON.stringify(laneButtons) !== JSON.stringify(expectedLanes)) {
    await fail(`stage 2: the lane filters are ${JSON.stringify(laneButtons)}, expected the domain's own ${JSON.stringify(expectedLanes)}`)
  }

  const readEntries = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="timeline-entry"]')].map((entry) => ({
        lane: entry.getAttribute('data-lane') ?? '',
        type: entry.getAttribute('data-event-type'),
        title: entry.getAttribute('title'),
        resolved: entry.getAttribute('data-resolved'),
        text: (entry.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      })),
    )
  const entries = await readEntries()
  for (const entry of entries) console.log(`stage 2: entry lane=${entry.lane} type=${String(entry.type)} — ${entry.text}`)
  const EXPECTED_LANE_OF = [
    ['workspace.goal_set', 'user_request'],
    ['workspace.replanned', 'interpretation'],
    ['task.created', 'plan_change'],
    ['task.started', 'work'],
    ['task.integrated', 'verified'],
  ]
  for (const [type, lane] of EXPECTED_LANE_OF) {
    const found = entries.filter((entry) => entry.type === type)
    if (found.length === 0) await fail(`stage 2: no timeline entry of type ${type} -- the seeded event never reached the lanes`)
    for (const entry of found) {
      if (entry.lane !== lane) {
        await fail(`stage 2: a ${type} entry is on lane ${JSON.stringify(entry.lane)}, expected ${JSON.stringify(lane)}`)
      }
    }
    // The raw type is on `data-event-type` AND in `title`, never in the words (docs/ia.md rule 3).
    for (const entry of found) {
      if (entry.title !== type) {
        await fail(`stage 2: a ${type} entry's title is ${JSON.stringify(entry.title)}, expected the raw type`)
      }
    }
    console.log(`stage 2: ${type} → ${lane} (${String(found.length)} entr(y/ies))`)
  }

  // MODEL CHATTER is the spec's own two types -- `run.output` and `run.tool_call` (R2, and
  // `LANE_BY_TYPE`'s doc comment). Not "everything beginning `run.`": `run.paused` and
  // `run.resumed` are WORK IN PROGRESS entries the domain puts on the timeline on purpose, and a
  // prefix negative quietly asserted the opposite of the lane table (final wave I2).
  const CHATTER_TYPES = ['run.output', 'run.tool_call']
  const chatterEntries = entries.filter((entry) => CHATTER_TYPES.includes(entry.type ?? ''))
  console.log(`stage 2: entries of ${JSON.stringify(CHATTER_TYPES)} = ${String(chatterEntries.length)}`)
  if (chatterEntries.length > 0) {
    await fail(`stage 2: model chatter reached the timeline: ${JSON.stringify(chatterEntries)}`)
  }
  // And the positive that makes the negative a measurement rather than a prefix rule: the seeded
  // `run.paused` IS on the timeline, on WORK IN PROGRESS.
  const pausedEntries = entries.filter((entry) => entry.type === 'run.paused')
  console.log(`stage 2: run.paused entries = ${JSON.stringify(pausedEntries)}`)
  if (pausedEntries.length !== 1) {
    await fail(`stage 2: ${String(pausedEntries.length)} run.paused entr(y/ies), expected the one seeded — a run.* type the domain KEEPS`)
  }
  if (pausedEntries[0]?.lane !== 'work') {
    await fail(`stage 2: the run.paused entry is on lane ${JSON.stringify(pausedEntries[0]?.lane)}, expected "work"`)
  }
  // SCOPED TO THE SUPERVISOR'S OWN SECTION (M61 R10/Task 7). The claim has always been that model
  // chatter does not reach the INTERPRETED timeline -- the six lanes, which is what `LANE_BY_TYPE`
  // leaves `run.tool_call` off. Until M61 that section was the only thing on the page this ran
  // against; now it lives on `/w/:id/activity` beside the RAW RIVER, and the raw river shows every
  // event by design (`docs/ia.md`: "`/w/:id/activity` still the whole river"). Scanning the whole
  // page would therefore be asserting that the river is not the river. The root moved with the
  // section; the assertion did not change.
  const chatterRoot = '[data-testid="recent-changes"]'
  const { shown: pageStrings } = await readVisibleText(chatterRoot)
  if (pageStrings.length === 0) {
    await fail(`stage 2: nothing rendered inside ${chatterRoot} -- a negative over an empty section proves nothing`)
  }
  const chatterLeak = pageStrings.filter((entry) => entry.text.includes(CHATTER))
  console.log(
    `stage 2: strings inside ${chatterRoot} containing ${JSON.stringify(CHATTER)} = ${String(chatterLeak.length)} of ` +
      `${String(pageStrings.length)}`,
  )
  if (chatterLeak.length > 0) {
    await fail(`stage 2: the run.tool_call literal reached the Supervisor timeline: ${JSON.stringify(chatterLeak)}`)
  }

  // The pending proposal is PINNED: inside `timeline-decisions`, and that section comes before the
  // river it is pinned above. `compareDocumentPosition & 4` is "the argument follows the node".
  const pinned = await page.evaluate(() => {
    const timeline = document.querySelector('[data-testid="supervisor-timeline"]')
    const decisions = document.querySelector('[data-testid="timeline-decisions"]')
    const river = document.querySelector('[data-testid="timeline"]')
    if (timeline === null || decisions === null || river === null) {
      return { decisions: decisions !== null, river: river !== null, timeline: timeline !== null }
    }
    return {
      timeline: true,
      decisions: true,
      river: true,
      proposalsInside: decisions.querySelectorAll('[data-testid="supervisor-proposal"]').length,
      proposalsAnywhere: document.querySelectorAll('[data-testid="supervisor-proposal"]').length,
      // The pinned section is the FIRST element inside the timeline root, and it precedes the river.
      firstChildTestId: timeline.firstElementChild?.getAttribute('data-testid') ?? null,
      decisionsBeforeRiver: (decisions.compareDocumentPosition(river) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    }
  })
  console.log(`stage 2: pinned decision section = ${JSON.stringify(pinned)}`)
  if (!pinned.decisions) await fail('stage 2: there is no timeline-decisions section at all -- the seeded proposal is pending')
  if (pinned.proposalsInside !== 1 || pinned.proposalsAnywhere !== 1) {
    await fail(`stage 2: expected exactly one supervisor-proposal, inside timeline-decisions (${JSON.stringify(pinned)})`)
  }
  if (pinned.firstChildTestId !== 'timeline-decisions' || !pinned.decisionsBeforeRiver) {
    await fail(`stage 2: DECISION REQUIRED is not pinned above the river (${JSON.stringify(pinned)})`)
  }

  // The filter: one lane on, then off again.
  const verifiedFilter = page.getByTestId('timeline-lane-filter-verified')
  await clickUntil(
    verifiedFilter,
    async () => (await verifiedFilter.first().getAttribute('aria-pressed')) === 'true',
    'the VERIFIED RESULT lane filter',
  )
  const filtered = await readEntries()
  console.log(`stage 2: with VERIFIED RESULT on, ${String(filtered.length)} entr(y/ies) remain: ${JSON.stringify(filtered.map((e) => e.lane))}`)
  if (filtered.length === 0) await fail('stage 2: filtering to VERIFIED RESULT emptied the river -- the seeded task.integrated should survive it')
  for (const entry of filtered) {
    if (entry.lane !== 'verified') await fail(`stage 2: a ${JSON.stringify(entry.lane)} entry survived the VERIFIED RESULT filter`)
  }
  await clickUntil(
    verifiedFilter,
    async () => (await verifiedFilter.first().getAttribute('aria-pressed')) === 'false',
    'the VERIFIED RESULT lane filter, off again',
  )
  const restored = await readEntries()
  console.log(`stage 2: filter off again — ${String(restored.length)} entries (was ${String(entries.length)})`)
  if (restored.length !== entries.length) {
    await fail(`stage 2: turning the filter off left ${String(restored.length)} entries, expected the original ${String(entries.length)}`)
  }
  console.log(
    'stage 2 PASSED: six lanes from the domain, the seeded events on the right ones, DECISION REQUIRED pinned, run.paused kept and run.output/run.tool_call gone',
  )

  // ============================================================================================
  // Stage 3: exactly four things need a person, and every link works.
  // ============================================================================================
  // M61 R7/Task 6: the queue is the command strip's `NeedsYouBar` now, and a row states its kind
  // on ITSELF -- `data-kind`, the attribute `NeedsYouRow` stamps -- rather than through a nested
  // `chip` whose `title` carried it. The same fact, read off the element that now holds it; the
  // dot beside the title is a `LiveDot`, not a word, so there is no chip text left to read.
  const needsYou = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="needs-you-row"]')].map((row) => ({
      kind: row.getAttribute('data-kind'),
      // `getAttribute`, not `.href`: the DOM property resolves to an absolute URL.
      href: row.querySelector('a')?.getAttribute('href') ?? null,
      title: row.querySelector('a')?.textContent?.trim() ?? '',
    })),
  )
  for (const item of needsYou) console.log(`stage 3: needs-you ${JSON.stringify(item)}`)
  if (needsYou.length !== 4) {
    await fail(`stage 3: ${String(needsYou.length)} needs-you row(s), expected exactly four (blocked, decision, question, integrate)`)
  }
  const kinds = [...needsYou.map((item) => item.kind)].sort()
  const EXPECTED_KINDS = ['blocked_task', 'decision', 'integrate', 'question']
  console.log(`stage 3: kinds = ${JSON.stringify(kinds)}`)
  if (JSON.stringify(kinds) !== JSON.stringify(EXPECTED_KINDS)) {
    await fail(`stage 3: the four things needing a person are ${JSON.stringify(kinds)}, expected ${JSON.stringify(EXPECTED_KINDS)}`)
  }

  for (const item of needsYou) {
    if (item.href === null || item.href === '') await fail(`stage 3: the ${String(item.kind)} row has no link at all`)
    const response = await gotoReliably(`${baseUrl}${item.href}`)
    // `page-shell` is on ten paths; `/workforce` names its own frame `workforce` (M44 R3), and
    // since M61 R7 every project route draws `command-strip` from its own layout -- the three are
    // accepted as "a real page rendered". The Work tab stopped being a `PageShell` when the board
    // moved inside a `ScrollArea` (M61 R9), which is why the third name is here: the marker moved,
    // the assertion did not.
    //
    // The not-found probe reads `main#main`, NOT `document.body`: `textContent` on the body
    // includes every inlined `<script>`, and a Next app's RSC flight payload carries the default
    // not-found boundary's own words on EVERY page. Read from the body it said "404" about a board
    // that had rendered perfectly.
    const landed = await page.evaluate(() => ({
      url: window.location.pathname + window.location.hash,
      shell:
        document.querySelectorAll('[data-testid="page-shell"]').length +
        document.querySelectorAll('[data-testid="workforce"]').length +
        document.querySelectorAll('[data-testid="command-strip"]').length,
      mains: document.querySelectorAll('main#main').length,
      notFound: /this page could not be found/iu.test(document.querySelector('main#main')?.textContent ?? ''),
    }))
    const status = response === null ? '<same-document>' : String(response.status())
    console.log(`stage 3: ${String(item.kind)} → ${item.href} answered ${status} and landed on ${JSON.stringify(landed)}`)
    if (response !== null && response.status() >= 400) {
      await fail(`stage 3: the ${String(item.kind)} row's link ${item.href} answered ${String(response.status())}`)
    }
    if (landed.shell === 0 || landed.mains !== 1 || landed.notFound) {
      await fail(`stage 3: the ${String(item.kind)} row's link ${item.href} did not resolve to a rendered page (${JSON.stringify(landed)})`)
    }
  }
  console.log('stage 3 PASSED: exactly four things need a person, and every one of their links resolves')

  // ============================================================================================
  // Stage 4: approving FROM THE TIMELINE really cancels the task.
  // ============================================================================================
  // ON THE ACTIVITY TAB (M61 R10/Task 7): the timeline moved there with the rest of "Recent
  // changes". The assertion -- that Approve on a pinned proposal really cancels the task -- is
  // unchanged; only the URL the timeline is read at moved.
  await gotoReliably(activityUrl)
  await waitVisible(page.getByTestId('timeline-decisions'), 'the pinned DECISION REQUIRED section')
  const before = await prisma.task.findUniqueOrThrow({ where: { id: readyTask.id }, select: { status: true } })
  console.log(`stage 4: subject task ${readyTask.id} status before = ${before.status}`)
  const approve = page.locator('[data-testid="timeline-decisions"] [data-testid="supervisor-approve"]')
  await waitVisible(approve, "the proposal's approve button, inside the timeline")
  await clickUntil(
    approve,
    async () => (await prisma.task.findUnique({ where: { id: readyTask.id }, select: { status: true } }))?.status === 'cancelled',
    'the timeline proposal\'s approve button',
  )
  const after = await prisma.task.findUniqueOrThrow({ where: { id: readyTask.id }, select: { status: true, lastRejectionReason: true } })
  const decidedRow = await prisma.supervisorDecision.findUniqueOrThrow({
    where: { id: decision.id },
    select: { status: true, resolvedAt: true },
  })
  console.log(`stage 4: subject task status after = ${after.status} (${JSON.stringify(after.lastRejectionReason)})`)
  console.log(`stage 4: decision ${decision.id} status=${decidedRow.status} resolvedAt=${String(decidedRow.resolvedAt?.toISOString() ?? null)}`)
  if (after.status !== 'cancelled') await fail(`stage 4: the subject task is ${after.status}, expected cancelled`)
  if (decidedRow.status !== 'approved' || decidedRow.resolvedAt === null) {
    await fail(`stage 4: the decision reads ${JSON.stringify(decidedRow)}, expected approved with a resolvedAt`)
  }
  // The lane updates over the STREAM, with no reload: the proposal leaves the pinned section. The
  // section itself stays -- the seeded question and blocked task are still waiting on a person, and
  // a heading that vanished while two of its three rows remained would be the bug, not the proof.
  const emptied = await waitUntil('the approved proposal to leave the pinned lane', 30_000, async () => {
    const counts = await page.evaluate(() => ({
      proposals: document.querySelectorAll('[data-testid="timeline-decisions"] [data-testid="supervisor-proposal"]').length,
      answers: document.querySelectorAll('[data-testid="timeline-decisions"] [data-testid="timeline-answer-send"]').length,
      unblocks: document.querySelectorAll('[data-testid="timeline-decisions"] [data-testid="timeline-unblock"]').length,
      section: document.querySelectorAll('[data-testid="timeline-decisions"]').length,
    }))
    return counts.proposals === 0
      ? { done: true, value: counts }
      : { done: false, detail: JSON.stringify(counts) }
  })
  console.log(`stage 4: pinned lane after the approval = ${JSON.stringify(emptied)}`)
  if (emptied.section !== 1 || emptied.answers !== 1 || emptied.unblocks !== 1) {
    await fail(
      `stage 4: the pinned lane reads ${JSON.stringify(emptied)} -- the answered proposal should be gone while the ` +
        'question and the blocked task, which nobody has answered, stay',
    )
  }
  // And the answer is HISTORY, on the lane where it was asked (spec erratum E27).
  const resolvedEntry = await waitUntil('the resolved decision to appear on the DECISION REQUIRED lane', 30_000, async () => {
    const found = (await readEntries()).filter((entry) => entry.type === 'supervisor.resolved')
    return found.length > 0 ? { done: true, value: found } : { done: false, detail: 'no supervisor.resolved entry yet' }
  })
  console.log(`stage 4: resolved entries = ${JSON.stringify(resolvedEntry)}`)
  for (const entry of resolvedEntry) {
    if (entry.lane !== 'decision' || entry.resolved !== 'true') {
      await fail(`stage 4: the resolved decision reads ${JSON.stringify(entry)}, expected lane "decision" and data-resolved "true"`)
    }
  }
  console.log('stage 4 PASSED: approving from the timeline cancelled the task and the lane updated over the stream, with no reload')

  // ============================================================================================
  // Stage 5: telling the Supervisor starts a CONVERSATION.
  // ============================================================================================
  // REWRITTEN BY F (spec erratum E8), not deleted. The composer used to POST `{ request }` to
  // `/api/w/:id/goal/request` and this stage read back the goal v3 that came out the other side;
  // it now posts a MESSAGE, and asking for the goal to change is something the REPLY may propose.
  // A question that wanted an answer no longer re-plans the whole board.
  //
  // So what one send writes is what this stage measures: the person's own line, and the reply
  // placeholder the daemon will settle. It settles no further here -- this gate starts no daemon
  // and wires no fake CLI (see the header: it dispatches no run and cannot spend), so the
  // placeholder stays `answering` for the rest of the run, which is exactly the panel's
  // "thinking…" row. The other half of the old claim -- a reply that asks for a goal change,
  // applied under `act`, with an attached brief's path in the new version -- is proven end to end
  // against a real daemon and the fake CLI in `gate:m39-supervisor-mailbox` stage 6.
  //
  // SCOPED to the shell's right panel (M57 t5): the Supervisor's composer lives there.
  const supervisorPanel = page.locator('[data-testid="right-panel"]')
  await supervisorPanel.getByTestId('supervisor-request-input').fill(REQUEST_V3)
  // The DATABASE is the predicate, not a line on the page: the panel re-reads the thread after a
  // successful send, so a row is the only thing that says the send really landed rather than that
  // something was optimistically drawn. A second click cannot double-send -- the send clears the
  // box and the button is disabled while it is empty.
  await clickUntil(
    supervisorPanel.getByTestId('supervisor-request-send'),
    async () => (await prisma.supervisorMessage.count({ where: { workspaceId, role: 'human' } })) > 0,
    'the "tell the Supervisor" send button',
  )
  const conversation = await prisma.supervisorMessage.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  for (const row of conversation) {
    console.log(
      `stage 5: message seq ${String(row.seq)} ${row.role}/${row.status} text ${JSON.stringify(row.text)} ` +
        `attachments ${JSON.stringify(row.attachments)} actions ${JSON.stringify(row.actions)}`,
    )
  }
  if (conversation.length !== 2) {
    await fail(`stage 5: one send wrote ${String(conversation.length)} message row(s), expected the person's line and one reply`)
  }
  const [said, reply] = conversation
  if (said.role !== 'human' || said.status !== 'sent') {
    await fail(`stage 5: the first row is ${said.role}/${said.status}, expected human/sent`)
  }
  if (said.text !== REQUEST_V3) {
    await fail(`stage 5: the person's row reads ${JSON.stringify(said.text)}, expected ${JSON.stringify(REQUEST_V3)}`)
  }
  if (reply.role !== 'supervisor' || reply.status !== 'answering') {
    await fail(`stage 5: the second row is ${reply.role}/${reply.status}, expected supervisor/answering -- the reply placeholder`)
  }
  if (reply.text !== '') {
    await fail(`stage 5: the placeholder already carries text ${JSON.stringify(reply.text)} -- nothing has answered it yet`)
  }
  // E8's own claim, as a NEGATIVE: the composer writes no goal version at all any more. Without
  // this the stage would pass just as happily against the old route, which is what it used to
  // measure.
  const v3Row = await prisma.goalVersion.findFirst({ where: { workspaceId, version: 3 } })
  console.log(`stage 5: GoalVersion v3 = ${v3Row === null ? 'none, as F intends' : JSON.stringify(v3Row)}`)
  if (v3Row !== null) {
    await fail('stage 5: the composer wrote a goal version -- F R2 makes it a message, and a goal change is what a REPLY may propose')
  }
  // THE `replan-status` ASSERTIONS ARE GONE, and this is where they went. They read "a FRESH goal
  // version arms the next tick's re-plan", and the only fresh version in this gate was the one the
  // composer wrote: stage 0 seeds a `workspace.replan_started` for v2 against a succeeded run, so
  // v2 reads `alreadyReplanned: true` / `blockedBy: "dedup"` and asking the same question here would
  // measure M40's dedup rather than anything a person did in the panel. The goal-change path a
  // conversation takes -- a reply asking for one, applied under `act`, the new version carrying an
  // attached brief's path -- is proven end to end against a real daemon and the fake CLI in
  // `gate:m39-supervisor-mailbox` stage 6, which is where a goal version now comes from.
  console.log(
    'stage 5 PASSED: one sentence became the person\'s own line and a reply waiting on the daemon, and not one goal version',
  )

  // ============================================================================================
  // Stage 6: the raw values are FOLDED, not hidden.
  // ============================================================================================
  // TWO HALVES, because M61 R9 turned this stage's claim into a claim about a MODE: "the M45
  // progressive disclosure's `Details` toggle becomes 'developer mode shows it'".
  //
  // THE SIMPLE-MODE HALF, first and in a context of its own: a person who does not read code
  // opens the same blocked task and gets the same one word and the same one reason, with NO
  // `details-group` at all -- and therefore no task id, no branch and no worktree path anywhere
  // in the panel. That is the stronger version of what this stage always measured (the old
  // assertion was "folded"; this one is "not there"), and it is measured rather than assumed,
  // because a fold that quietly opened in simple mode would look identical to one that did not
  // exist.
  {
    const simpleContext = await browser.newContext({ viewport: VIEWPORT })
    await simpleContext.addInitScript(() => {
      try {
        window.localStorage.setItem('mode', 'simple')
      } catch {
        /* the assertions below fail loudly rather than silently passing on a hidden group */
      }
    })
    const simplePage = await simpleContext.newPage()
    simplePage.setDefaultTimeout(ACTION_TIMEOUT_MS)
    await simplePage.goto(`${baseUrl}/w/${workspaceId}/tasks`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
    await simplePage.getByTestId('column').first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
    // Hydration first (M61 R1): `TasksClient` reads the mode once and passes `isDeveloper` down,
    // and its first client render is flat `'simple'` -- so a read taken on the load frame would
    // agree with this assertion for the wrong reason.
    await simplePage.waitForFunction(
      () => document.querySelector('[data-testid="mode-toggle"]')?.getAttribute('aria-checked') === 'false',
      null,
      { timeout: ACTION_TIMEOUT_MS },
    )
    await simplePage.getByTestId('task-card').filter({ hasText: blockedTask.title }).first().click()
    await simplePage.locator('aside [data-testid="detail-status"]').first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
    const simplePanel = await simplePage.evaluate(
      ([taskId, branch, worktree]) => {
        const aside = document.querySelector('aside')
        if (aside === null) return { aside: false }
        const text = (aside.textContent ?? '').replace(/\s+/g, ' ')
        return {
          aside: true,
          status: aside.querySelector('[data-testid="detail-status"]')?.textContent?.trim() ?? null,
          why: aside.querySelector('[data-testid="task-why"]')?.textContent?.trim() ?? null,
          groups: [...aside.querySelectorAll('[data-testid="details-group"]')].map((group) => group.getAttribute('data-group') ?? ''),
          worktreePaths: aside.querySelectorAll('[data-testid="worktree-path"]').length,
          leaks: { uuid: text.includes(taskId), branch: text.includes(branch), worktree: text.includes(worktree) },
        }
      },
      [blockedTask.id, BLOCKED_BRANCH, BLOCKED_WORKTREE],
    )
    console.log(`stage 6 (simple): the panel = ${JSON.stringify(simplePanel)}`)
    await simplePage.close()
    await simpleContext.close()
    if (!simplePanel.aside) await fail('stage 6 (simple): clicking the blocked card opened no detail panel at all')
    if (simplePanel.status !== 'BLOCKED') {
      await fail(`stage 6 (simple): the panel's status word is ${JSON.stringify(simplePanel.status)}, expected "BLOCKED"`)
    }
    if (simplePanel.why !== BLOCKED_REASON) {
      await fail(`stage 6 (simple): task-why reads ${JSON.stringify(simplePanel.why)}, expected ${JSON.stringify(BLOCKED_REASON)}`)
    }
    // THE TECHNICAL GROUPS, not every group. `cost` is money -- what this task has spent -- and a
    // person who runs a company reads money in both modes; R9's "developer mode shows it" is about
    // the run, its messages, what it saw, its verification attempts, its worktree and its events.
    // Measured against the list the developer half below prints, so the two halves cannot drift:
    // anything on this list in simple mode is a leak, and `cost` being here is a decision.
    const DEVELOPER_ONLY_GROUPS = ['run', 'messages', 'context', 'memories', 'verification', 'worktree', 'events']
    const leakedGroups = simplePanel.groups.filter((group) => DEVELOPER_ONLY_GROUPS.includes(group))
    if (leakedGroups.length > 0) {
      await fail(
        `stage 6 (simple): simple mode rendered the developer-only group(s) ${JSON.stringify(leakedGroups)} -- R9 says ` +
          `the fold became the mode (the whole panel drew ${JSON.stringify(simplePanel.groups)})`,
      )
    }
    if (simplePanel.worktreePaths !== 0 || simplePanel.leaks.uuid || simplePanel.leaks.branch || simplePanel.leaks.worktree) {
      await fail(`stage 6 (simple): a raw value is on screen with no group to hold it: ${JSON.stringify(simplePanel)}`)
    }
    console.log(
      `stage 6 (simple): one word, one reason, ${JSON.stringify(simplePanel.groups)} on screen (money, which both modes ` +
        'show) and not one of the seven technical groups -- so not one raw value either',
    )
  }

  // THE DEVELOPER-MODE HALF: the run/worktree/artifact groups render for the person who built the
  // thing, and the fold INSIDE them is unchanged -- closed on arrival except `run`, opening on a
  // click, with the raw value only then.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('mode', 'developer')
    } catch {
      /* the assertions below fail loudly rather than silently passing on a hidden group */
    }
  })
  await gotoReliably(`${baseUrl}/w/${workspaceId}/tasks`)
  await waitVisible(page.getByTestId('column'), 'the task board')
  const blockedCard = page.getByTestId('task-card').filter({ hasText: blockedTask.title })
  await waitVisible(blockedCard, "the blocked task's card")
  await clickUntil(
    blockedCard.first(),
    async () => page.locator('aside [data-testid="detail-status"]').first().isVisible(),
    "the blocked task's card",
  )
  const panel = await page.evaluate(
    ([taskId, branch, worktree]) => {
      // EVERYTHING scoped to the panel's own `<aside>`: `task-why` is rendered by the CARD as well
      // (R4 puts the same one line in both places), and the cards come first in the document, so an
      // unscoped `querySelector` read some other task's reason and called it this panel's.
      const aside = document.querySelector('aside')
      if (aside === null) return { aside: false }
      const status = aside.querySelector('[data-testid="detail-status"]')
      const why = aside.querySelector('[data-testid="task-why"]')
      const text = (aside.textContent ?? '').replace(/\s+/g, ' ')
      return {
        aside: true,
        status: status?.textContent?.trim() ?? null,
        statusTitle: status?.getAttribute('title') ?? null,
        why: why?.textContent?.trim() ?? null,
        groups: [...aside.querySelectorAll('[data-testid="details-group"]')].map((group) => [
          group.getAttribute('data-group') ?? '',
          group.getAttribute('data-open') ?? '',
        ]),
        worktreePaths: aside.querySelectorAll('[data-testid="worktree-path"]').length,
        leaks: {
          uuid: text.includes(taskId),
          branch: text.includes(branch),
          worktree: text.includes(worktree),
        },
      }
    },
    [blockedTask.id, BLOCKED_BRANCH, BLOCKED_WORKTREE],
  )
  if (!panel.aside) await fail('stage 6: clicking the blocked card opened no detail panel at all')
  console.log(`stage 6: detail-status = ${JSON.stringify(panel.status)} (title ${JSON.stringify(panel.statusTitle)})`)
  console.log(`stage 6: task-why = ${JSON.stringify(panel.why)}`)
  for (const [name, open] of panel.groups) console.log(`stage 6: details group ${name} data-open=${open}`)
  console.log(`stage 6: raw values visible while folded = ${JSON.stringify(panel.leaks)}`)
  if (panel.status !== 'BLOCKED' || panel.statusTitle !== 'blocked') {
    await fail(`stage 6: the panel's status word is ${JSON.stringify(panel.status)}/${JSON.stringify(panel.statusTitle)}, expected "BLOCKED"/"blocked"`)
  }
  if (panel.why !== BLOCKED_REASON) {
    await fail(`stage 6: task-why reads ${JSON.stringify(panel.why)}, expected the seeded reason ${JSON.stringify(BLOCKED_REASON)}`)
  }
  if (panel.groups.length === 0) await fail('stage 6: the panel renders no details-group at all')
  for (const [name, open] of panel.groups) {
    const expected = name === 'run' ? 'true' : 'false'
    if (open !== expected) {
      await fail(`stage 6: the ${name} group is data-open=${open} on arrival, expected ${expected} (only "run" leads)`)
    }
  }
  if (panel.leaks.uuid || panel.leaks.branch || panel.leaks.worktree) {
    await fail(`stage 6: a raw value is on screen with its group closed: ${JSON.stringify(panel.leaks)}`)
  }
  if (panel.worktreePaths !== 0) {
    await fail(`stage 6: ${String(panel.worktreePaths)} worktree-path element(s) while the worktree group is closed, expected 0`)
  }
  // FOLDED, not hidden: the negative above is about the disclosure, and this is the other half.
  await clickUntil(
    page.locator('aside [data-testid="details-group"][data-group="worktree"] button').first(),
    async () => page.locator('aside [data-testid="worktree-path"]').first().isVisible(),
    'the Worktree details group',
  )
  const unfolded = await page.evaluate(() =>
    [...(document.querySelector('aside')?.querySelectorAll('[data-testid="worktree-path"]') ?? [])].map((row) =>
      (row.textContent ?? '').trim(),
    ),
  )
  console.log(`stage 6: worktree paths once the group is open = ${JSON.stringify(unfolded)}`)
  if (!unfolded.includes(BLOCKED_WORKTREE)) {
    await fail(`stage 6: opening the Worktree group showed ${JSON.stringify(unfolded)}, expected ${JSON.stringify(BLOCKED_WORKTREE)}`)
  }
  console.log(
    'stage 6 PASSED: in simple mode not one of the seven technical groups and not one raw value; in developer mode ' +
      'one word, one reason, and every raw value folded away until a person asks for it',
  )

  // ============================================================================================
  // Stage 7: real is not simulated.
  // ============================================================================================
  await gotoReliably(projectUrl)
  // M61 R7/Task 6: selector rename, see stage 1's note above.
  await waitVisible(page.getByTestId('stat-work'), 'the project page, for the simulation check')
  const simulationMarkers = await page.evaluate(() => document.querySelectorAll('[data-simulation]').length)
  console.log(`stage 7: [data-simulation] elements on /w/<id> = ${String(simulationMarkers)}`)
  if (simulationMarkers !== 0) {
    await fail(`stage 7: ${String(simulationMarkers)} simulated-money marker(s) on a real project page, expected 0 (R6)`)
  }
  console.log('stage 7 PASSED: nothing on the project page claims to be a simulation')

  // ============================================================================================
  // Stage 8: no dotted event type is visible text -- and at least one really is an event.
  // ============================================================================================
  const { shown, hidden } = await readVisibleText(null)
  const dotted = shown.filter((entry) => DOTTED_TYPE.test(entry.text))
  console.log(`stage 8: ${String(shown.length)} rendered string(s), ${String(hidden.length)} un-rendered; ${String(dotted.length)} of the rendered ones ARE a raw event type`)
  if (dotted.length > 0) {
    await fail(`stage 8: a raw event type is visible text: ${JSON.stringify(dotted.slice(0, 10))}`)
  }
  // The POSITIVE half reads the timeline, which is on the Activity tab since M61 R10/Task 7 --
  // the negative above deliberately stays on the project page it was always about.
  await gotoReliably(activityUrl)
  await waitVisible(page.getByTestId('recent-changes'), 'the Recent changes section, for the positive half')
  const typedEntries = (await readEntries()).filter((entry) => entry.type !== null && DOTTED_TYPE.test(entry.type))
  console.log(`stage 8 POSITIVE: ${String(typedEntries.length)} timeline entr(y/ies) carry a raw event type on data-event-type, e.g. ${JSON.stringify(typedEntries.slice(0, 3).map((entry) => entry.type))}`)
  if (typedEntries.length === 0) {
    await fail(
      'stage 8: no timeline entry carries a dotted event type on data-event-type at all -- the negative above would pass ' +
        'on a page with no events, and this is what stops it',
    )
  }
  console.log('stage 8 PASSED: every raw event type is on an attribute and none of them is a word')

  console.log(`gotoReliably retries this run: ${String(gotoRetries.length)}${gotoRetries.length === 0 ? '' : ` (${JSON.stringify(gotoRetries)})`}`)
  console.log(`PASS: ${PASS_LINE}`)
  exitCode = 0
} finally {
  // The browser and the web shell first -- neither can spawn anything, and this gate starts no
  // daemon and dispatches no run, so there is nothing else to stop.
  if (browser !== null) await browser.close().catch(() => {})
  if (nextServer !== null && nextServer.exitCode === null) {
    nextServer.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextServer.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextServer.exitCode === null) nextServer.kill('SIGKILL')
  }
  // FK order. `ExecutionEvent` has no FK to `Workspace` (M2's append-only log outlives entity
  // lifecycles by design), so it goes explicitly first; `SlaveMessage` is scoped by a
  // denormalized `workspaceId` and is deleted explicitly for the same reason its cascade runs
  // through `Slave`/`Task` rather than the workspace. The workspace delete then cascades
  // SupervisorDecision, SlaveRun, GoalVersion, Task, Slave and Team.
  if (workspaceId !== null) {
    await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.supervisorDecision.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.slaveMessage.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.slaveRun.deleteMany({ where: { slave: { team: { workspaceId } } } }).catch(() => {})
    await prisma.goalVersion.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.task.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.slave.deleteMany({ where: { team: { workspaceId } } }).catch(() => {})
    await prisma.team.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

process.exit(exitCode)
