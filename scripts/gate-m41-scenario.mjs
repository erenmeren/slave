// M41's own gate: ONE story, told once, through the whole system.
//
// Every earlier gate proves one seam under a real daemon -- m35 integration truth, m36 ask/answer
// across a restart, m37 the recorded prompt, m38 staffing and budget, m39 the mailbox, m40
// re-planning. None of them runs the seams in SEQUENCE, and the sequence's claim -- a team that
// coordinates itself and tells the truth about its state -- is only proven when one run crosses all
// of them. This is that run: an operator sets a requirement, a manager plans it, a worker starts,
// stops to ask a question nobody can answer, the Supervisor answers it from a sentence in the
// worker's own task and wakes it up, the work is verified, reviewed, merged by hand and confirmed,
// the requirement changes, a delta re-plan adds work and PROPOSES a cancellation, a human approves
// it -- and then, with nothing running, every operator surface is asked what happened and has to
// agree.
//
// NEVER A MODEL CALL. Every daemon here is spawned with `SLAVEOFAI_CLAUDE_BIN=node`,
// `SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m41-flow [--ask-on-task core]
// [--replan-cancel <id>]"` and `SLAVEOFAI_REQUIRE_FAKE_CLI=1` (M32 item 7: lose the first two and
// the daemon refuses to start rather than falling back to the real binary).
//
// WHY THE WORKSPACE DOES NOT AUTO-MERGE (erratum E4, and the load-bearing decision in this file).
// `autoMerge: false` buys three things at once:
//   1. `task.integrated` becomes real. `merge.ts`'s AUTO path stamps `Task.integratedAt` and emits
//      `task.done`; the `task.integrated` event exists only in `confirmIntegration`. Under
//      auto-merge the truth table's "task.integrated 2" would be zero.
//   2. M35's integration honesty becomes a measured ACT rather than a footnote: a task that is
//      `done` with an unmerged branch does not unblock its dependent, and this gate reads that off
//      the orchestrator's OWN `loadWorld` before merging the branch by hand.
//   3. It is the only thing that makes acts 4 and 5 deterministic, and it does it by a FACT about
//      the board rather than by any claim about when a tick runs. `polish` depends on `api`, and
//      `!autoMerge` means `api` reaches `done` with `integratedAt` NULL -- so `loadWorld` reports
//      `dependenciesDone: false` for `polish` and no scheduler, however often it is woken, can
//      start it until a person has merged and confirmed. Under auto-merge `api` would integrate
//      itself, `polish` would be startable the instant it did, the re-plan's cancellation of a
//      RUNNING task would be dropped by `applyCancelPolicy`, and act 6 would have nothing to
//      approve.
//
// WHY THERE IS A FIFTH SLAVE NOBODY EVER DISPATCHES (erratum E1). `ask.ts`'s `recipientCanAnswer`
// refuses an ask addressed to a role no OTHER slave holds -- parking a task to wait for nobody is
// the bug that check exists to prevent -- so a question can only BECOME unanswerable after it was
// asked. `Quinn` holds `qa` while the question is asked and loses it to the operator's own
// `set-runtime-roles --roles ''` immediately afterwards, which is `gate-m39-supervisor-mailbox.mjs`'s
// idiom and the only shape in which `unanswerable_question` is reachable at all. Quinn holds no
// task-shaped role, so the scheduler never dispatches it.
//
// WHY `--ask-on-task` CARRIES A ONE-WORD TOKEN OFF THE TITLE (erratum E2, and the trap under it).
// Two workers share the `backend` role and exactly one of them may stop to ask, so the fake CLI
// needs to know WHICH task. A work run's prompt does not contain its task's id anywhere:
// `runContext.ts` renders the `task` section as `Task: <title>\n\n<description>` and ids appear
// only in a planning run's board lines. The title under that literal prefix is the discriminator,
// and argv is the channel because a run's spawn args are the only deterministic per-daemon knob a
// gate has (M39 E6). The flag's VALUE cannot be the whole title, though:
// `apps/orchestrator/src/claude-command.ts` splits `SLAVEOFAI_CLAUDE_ARGS` on a single space, so a
// value with spaces in it arrives as four separate argv entries and `--ask-on-task` would read
// `Write` as the whole of it. The token is therefore the title's LAST WORD, and the fake CLI looks
// for it inside the `Task: ` line rather than on its own -- so a word that also occurs in some
// other task's description cannot turn that run into an asking leg.
//
// WHY THE TWO PLANNING ACTS RUN UNDER `tick`, NOT UNDER A DAEMON (erratum E16 -- a correction to
// the brief's timing premise, measured on the first run of this file). The brief assumed a daemon's next
// dispatch is one PERIOD away, so an act could land a plan and then stop the daemon inside that
// window. It is not: `runDaemon` opens `subscribeEvents` and wakes the coalescer on EVERY event in
// its workspace, so the `workspace.plan_created` that says the board exists is itself what wakes the
// tick that dispatches off it. Measured: the plan committed at T and `task.started` for `core`
// landed at T+24 ms, with the period set to 750. Raising the period does not widen that window --
// nothing about it is the timer -- and a gate that waited on the event and then raced the
// notification would be asserting a coin flip.
//
// So the two acts whose whole claim is "the board was planned and NOTHING started" do not run a
// daemon at all. They run the operator's own one-shot `tick`, which is the same `tick()` function
// the daemon calls and then, deliberately, waits for what it started (`drainPumps`): work is
// dispatched FIRST in a tick and only then is planning dispatched, so a single hand tick plans the
// board, concludes the plan, and exits with the dispatch phase already behind it. Nothing is timed,
// nothing is raced, and the claim is a certainty rather than a probability.
//
// So the cast is TWO real daemons and TWO hand ticks, not the brief's four daemons: `tick` for act
// 1's plan, `daemon-1` for acts 2 to 4's core leg (it carries `--ask-on-task core` and the ask
// envelope), `daemon-2` for act 4's api leg (no ask flag), `tick` again for act 5's re-plan (it
// carries `--replan-cancel <polish>` on its own argv exactly as a daemon would have). Acts 6 and 7
// run with nothing alive at all.
//
// WHERE A DAEMON IS STILL STOPPED AT A MEASURED POINT. Act 4 stops both of its daemons before work
// that must not begin, and both are bounded by the DEPENDENCY GATE rather than by a clock:
// `stopBeforeRunsFor` stops the process and then asserts that no `SlaveRun` row exists for tasks
// that `loadWorld` has just reported `dependenciesDone: false`. It carries the restart proof
// `gate-m36-messaging.mjs` established as well -- the pid answers no signal, `/proc/<pid>/cmdline`
// no longer reads as a daemon, and no orchestrator daemon is alive on this host at all.
//
// HOW THE OPERATOR'S SURFACES ARE ASSERTED WITHOUT `apps/web` (ruling R6, erratum E9). `apps/web`
// compiles with `noEmit: true` under a bundler resolver: there is no built output a plain `node`
// script can import, and no gate has ever imported one. It does not need one. Every field of the
// three builders is a control or domain verb they themselves compose, and this gate calls those:
//   buildSupervisorView().report      = summarise(loadSupervisorWorld(id).world)
//   buildSupervisorView().pending     = listDecisions(id, { pending: true })
//   buildSupervisorView().settings    = supervisorSettings(id)
//   buildGoalHistory()                = listGoalVersions(id)
//   TasksSnapshot.workspace.goalVersion / TaskBoardItem.{status,goalVersion,integratedAt}
//                                     = the Workspace and Task columns of those names
//   the task card's stale badge, counted = summarise(world).next.stale
//   OverviewSnapshot.tasks.*          = the board, counted by status
//   OverviewSnapshot.workspace.spentUsd = workspaceSpend(id).spentUsd
// `apps/web/test/integration/gate-surface-parity.test.ts` pins that mapping, so a builder that
// starts computing something of its own fails a test in the same commit rather than silently
// making this gate a measurement of nothing.
//
// EVERY PRICE IS READ AT RUNTIME. `fixtureCostUsd(name)` opens the fixture and takes the terminal
// `result` line's `total_cost_usd`. Nothing here memorises a number: a fixture re-recorded tomorrow
// moves every figure in the spend table with it, and a gate that had memorised one would be
// asserting history.
//
// ACTS
//   1. Plan. `set-goal` v1 prints {version:1, sha256}; ONE hand `tick`'s manager lands core -> api
//      -> polish, all `ready`, all goal v1; `workspace.plan_created` carries the version; the
//      planning run's manifest says `planning_goal.version 1` and has NO `replan` section. No work
//      run exists and nothing is left running, and both are asserted.
//   2. Work, and a question. Daemon-1 carries `--ask-on-task core` and the envelope. Core
//      dispatches to one of the two backend workers (recorded), the run parks `waiting_for_answer`,
//      the task parks `waiting`, one `question` row exists, no attempt is charged, nothing else on
//      the board moves. The run's manifest hashes the exact task text the renderer hashed. Then the
//      operator takes `qa` away from Quinn.
//   3. The answer. The Supervisor's next pass sees `unanswerable_question`, chooses
//      `answer_question`, drafts one, verifies its quote against core's own description, and the
//      row is `applied`/`applied` with `draft.confidence 'sourced'` and both calls' cost on it. One
//      `answer` message, actor `system`, `answeredBy: 'supervisor'`. A later tick's `deliverAnswers`
//      resumes the SAME session, and the resumed leg commits.
//   4. Verify, review, integrate -- and the dependency that stays shut until a human says so. Core
//      verifies, Rae reviews it, the merge pass marks it `done` with `integratedAt` NULL, and `api`
//      reports `dependenciesDone: false` through the orchestrator's own `loadWorld`. The operator
//      merges the branch into `main` for real and runs `confirm-integration`; `api` becomes
//      schedulable; daemon-2 takes it through the same pipeline with no question in it.
//   5. The requirement changes. `set-goal` v2; `goal-history` prints v2 before v1 with the diff;
//      `replan-status` says a re-plan is due with nothing in the way. A second hand `tick` carries
//      `--replan-cancel <polish>`; the re-plan run's manifest has a `replan` section (v1 -> v2) over
//      the NON-terminal board alone, its prompt carries `THE GOAL CHANGED` and both goal texts; on
//      conclusion one new task `docs` at goal v2, one PENDING `stale_task` proposal naming polish,
//      and `workspace.replanned` accounting for all four lists.
//   6. A human approves. `approve-decision` cancels polish with `task.cancelled { goalVersion: 1 }`
//      and actor `human`; then the operator merges api's branch and confirms its integration.
//   7. The truth table. With no daemon anywhere, every surface is asked and has to agree: the
//      board, the goal history, the Supervisor's report and decisions, the mailbox, the printed
//      spend table against `workspaceSpend`, and a per-type event census.
//
// Shape borrowed from `gate-m40-requirement-versioning.mjs` (temp git repo + `prisma.workspace.
// create` setup, `preflightCleanup()`/`dumpGateRows()`/`fail()`/`waitUntil()`, the daemon lifecycle
// and its `findRealDaemonPids()` refusal, "print every measured value before asserting it", real CLI
// subprocesses through `execFileSync('node', [cliPath, ...])` with `loopbackChildEnv()`, `exitCode`
// starting at 1 and set to 0 only at the very end, teardown in FK order), from
// `gate-m39-supervisor-mailbox.mjs` (`describeDecision` with the draft on it, `describeMessage`,
// `answersTo`, `sameMoney`), and from `gate-m36-messaging.mjs` (the restart proof).

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids, isRealDaemonProcess } from './lib/daemon-process.mjs'
import { prisma } from '../packages/db/dist/client.js'
import {
  isAlive,
  listDecisions,
  listGoalVersions,
  listPendingQuestions,
  loadSupervisorWorld,
  supervisorSettings,
  workspaceSpend,
  workspaceStats,
} from '../packages/control/dist/index.js'
import { NON_TERMINAL_RUN_STATUSES, goalSha256, runContextManifestSchema, summarise } from '../packages/domain/dist/index.js'
import { loadWorld } from '../apps/orchestrator/dist/index.js'

// How often this gate looks at the database while a daemon works, and nothing more (erratum E16).
// It is deliberately NOT half of some window a stop has to fit inside: no act here races a tick.
// 25 ms rather than m39/m40's 50 only because acts 2 to 4 wait on a dozen transitions in a row and
// a tighter poll is a shorter gate.
const POLL_INTERVAL_MS = 25
// The daemon's timer, which on this system is a FALLBACK rather than the trigger (erratum E16):
// `runDaemon` subscribes to the event stream and wakes the coalescer on every event in its
// workspace, so a tick almost always runs because something was written, not because 750 ms passed.
// The value therefore bounds only how long an act waits when nothing at all has happened -- 750
// rather than m39/m40's 500 because acts 2 to 4 are the long ones and a spare quarter second per
// idle tick is cheaper than the extra process wake-ups.
const DAEMON_PERIOD_MS = 750
// Generous, and every one of them bounds real work: a `git worktree add`, a fake CLI replay, a
// verify pass, a supervised tick, a resume, a merge. Tuned to "a slow machine still passes".
const DISPATCH_TIMEOUT_MS = 120_000
const PLAN_TIMEOUT_MS = 180_000
const WAITING_TIMEOUT_MS = 180_000
const SUPERVISOR_TIMEOUT_MS = 180_000
const RESUME_TIMEOUT_MS = 180_000
const PIPELINE_TIMEOUT_MS = 240_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const FIXTURES_DIR = join(repoRoot, 'packages/providers/test/fixtures')

// An exact literal, never suffixed -- `preflightCleanup` removes whatever a prior crashed run left
// on this exact name, in the same FK order the `finally` block uses.
const WORKSPACE_NAME = 'M41 Scenario Project'

/** The two requirements this story sets, in order. Each is ONE line, which is what makes the
 *  `goal-history` diff assertion exact: `goalDiff` is a set difference over trimmed non-blank
 *  lines, so a one-line edit is one addition and one removal and nothing else. */
const GOAL_V1 = 'Ship the scenario service: a core module, an API on top of it, and the polish around it.'
const GOAL_V2 = 'Ship the scenario service and document the new endpoint for the people who will call it.'

/** What `fixtures/plan-graph-scenario.ndjson` returns, and therefore what the first plan must
 *  produce. `CORE_TITLE` is also where the `--ask-on-task` discriminator comes from (erratum E2). */
const PLAN_TITLES = ['Write the feature core', 'Expose the API', 'Document and polish']
const CORE_TITLE = 'Write the feature core'
const API_TITLE = 'Expose the API'
const POLISH_TITLE = 'Document and polish'
/** What `fixtures/replan-delta.ndjson` adds. */
const ADDED_TITLE = 'Document the new endpoint'

/** The sentence `supervisor-answer.ndjson` cites, verbatim, and which `plan-graph-scenario`'s core
 *  description carries (ruling R4). It is what makes act 3 a MEASUREMENT: `verifySources` looks the
 *  quote up in the asking task's own text, so the answer is sent because the evidence is there. */
const SOURCED_QUOTE = 'PostgreSQL on port 5433'

/** The role the question is addressed to, and the one Quinn loses right after asking (erratum E1).
 *  Deliberately not `reviewer`: taking that away would strand act 4's review. */
const ASKED_ROLE = 'qa'
const ASK_QUESTION = 'Which database should this service connect to?'

/** What one replay of a fixture reports as `total_cost_usd`, read off the file at runtime. */
function fixtureCostUsd(name) {
  for (const line of readFileSync(join(FIXTURES_DIR, `${name}.ndjson`), 'utf8').split('\n')) {
    if (line.length === 0) continue
    const parsed = JSON.parse(line)
    if (parsed.type === 'result') return parsed.total_cost_usd
  }
  throw new Error(`fixture ${name}.ndjson has no terminal result line to read a cost from`)
}

/** Two dollar amounts are equal when they are equal as money, not as floats: 0.01 + 0.02 is
 *  0.030000000000000002 in IEEE 754, and a gate that asserted `===` on that would be measuring the
 *  arithmetic rather than the milestone. */
const sameMoney = (actual, expected) => actual !== null && Math.abs(actual - expected) < 1e-9

/** A real repository, because every dispatch provisions a real worktree in it and the fake CLI
 *  commits into that worktree -- and because this gate merges two branches into `main` by hand. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m41-repo-'))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/** Removes what a prior interrupted run left behind, in the same order the `finally` block uses:
 *  the workspace's events (no FK), then the workspace, which cascades Team/Slave/Task/SlaveRun/
 *  RunContext/GoalVersion/TaskDependency/SlaveMessage and SupervisorDecision. This gate creates no
 *  org rows and no skill rows, so there is nothing else of its own anywhere in the database. */
async function preflightCleanup() {
  const stale = await prisma.workspace.findUnique({ where: { name: WORKSPACE_NAME } })
  if (stale === null) return
  console.log(`preflight: removing a leftover ${WORKSPACE_NAME} (${stale.id}) from an earlier interrupted run`)
  await prisma.executionEvent.deleteMany({ where: { workspaceId: stale.id } }).catch(() => {})
  await prisma.workspace.delete({ where: { id: stale.id } }).catch(() => {})
}

let exitCode = 1
let repoPath = null
let workspaceId = null
/** Every daemon this gate has ever spawned, in order -- the `finally` block kills whichever of them
 *  is somehow still alive, not just the last one. */
const daemons = []

/** Every row this gate could have written, for a FAIL's diagnostic dump. BigInt `seq` stringified. */
async function dumpGateRows() {
  const workspace =
    workspaceId === null
      ? null
      : await prisma.workspace.findUnique({
          where: { id: workspaceId },
          include: { tasks: true, goalVersions: true, teams: { include: { slaves: { include: { runs: true } } } } },
        })
  const events =
    workspaceId === null ? [] : await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  const messages =
    workspaceId === null ? [] : await prisma.slaveMessage.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  const decisions =
    workspaceId === null
      ? []
      : await prisma.supervisorDecision.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })
  const dependencies =
    workspaceId === null ? [] : await prisma.taskDependency.findMany({ where: { task: { workspaceId } } })
  const daemonTails = daemons.map((d) => ({
    label: d.label,
    pid: d.proc.pid ?? null,
    exited: d.exited,
    output: d.output.length > 6_000 ? `…${d.output.slice(-6_000)}` : d.output,
  }))
  return JSON.stringify({ workspace, events, messages, decisions, dependencies, daemonTails }, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

/** The `gate-m35`/`gate-m38`/`gate-m39`/`gate-m40` diagnostic throw: an Error carrying the state
 *  that made the call, not just the sentence that noticed. */
async function fail(message) {
  const dump = await dumpGateRows().catch(
    (cause) => `<could not dump gate rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
  )
  throw new Error(`${message} -- gateRows=${dump}`)
}

/** A task as this gate prints it. */
const describeTask = (row) =>
  JSON.stringify({
    id: row.id,
    title: row.title,
    status: row.status,
    goalVersion: row.goalVersion,
    requiredRole: row.requiredRole,
    createdBy: row.createdBy,
    lastRejectionReason: row.lastRejectionReason,
  })

/** A decision row as this gate prints it, DRAFT included: act 3 asserts on the draft, and a failure
 *  that shows only ids is a failure nobody can diagnose from the log (`gate-m39`'s own). */
const describeDecision = (row) =>
  JSON.stringify({
    id: row.id,
    situationKind: row.situationKind,
    subjectId: row.subjectId,
    tier: row.tier,
    status: row.status,
    decidedBy: row.decidedBy,
    modelCalled: row.modelCalled,
    modelCostUsd: row.modelCostUsd,
    action: row.action,
    draft: row.draft,
    rationale: row.rationale,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  })

/** A message row as this gate prints it (`gate-m39`'s own). */
const describeMessage = (row) =>
  JSON.stringify({
    id: row.id,
    kind: row.kind,
    actor: row.actor,
    slaveId: row.slaveId,
    senderRunId: row.senderRunId,
    recipientRole: row.recipientRole,
    recipientSlaveId: row.recipientSlaveId,
    replyToId: row.replyToId,
    body: row.body,
    createdAt: row.createdAt,
  })

/** An event as this gate prints it, `seq` stringified (it is a BigInt). */
const describeEvent = (row) =>
  JSON.stringify({ seq: String(row.seq), type: row.type, actor: row.actor, taskId: row.taskId, payload: row.payload })

try {
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`orchestrator CLI not built at ${ORCHESTRATOR_CLI} -- run tsc --build first`)
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)

  // Refused rather than tolerated (`gate-m36`/`gate-m38`/`gate-m39`/`gate-m40`'s own refusal): this
  // gate starts and stops daemons of its own, asserts that NO daemon is alive in the windows
  // between them, and counts exactly what one story wrote. A daemon somebody else left running
  // would be ticking other workspaces and holding the global concurrency budget this one needs.
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m41-scenario REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate starts and stops daemons of its own and measures exactly what one story wrote',
    )
  }

  await preflightCleanup()

  // ---- Setup ------------------------------------------------------------------------------------
  repoPath = makeRepo()

  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath,
      baseBranch: 'main',
      // Erratum E4, and the header's own paragraph: integration is the operator's act here, which
      // is what makes `task.integrated` real, M35's dependency gate measurable, and acts 4 and 5
      // deterministic instead of racing the scheduler.
      autoMerge: false,
      verifyCommands: ['true'],
      setupCommands: [],
      maxAttempts: 5,
      budgetUsd: 20,
    },
  })
  workspaceId = workspace.id
  console.log(
    `workspace ${workspaceId} (${WORKSPACE_NAME}), repo ${repoPath}, autoMerge ${String(workspace.autoMerge)}, ` +
      `budgetUsd ${String(workspace.budgetUsd)}, supervisorEnabled ${String(workspace.supervisorEnabled)}, ` +
      `goalVersion ${String(workspace.goalVersion)}`,
  )
  if (!workspace.supervisorEnabled) await fail('a new workspace starts with its Supervisor switched off')
  if (workspace.goalVersion !== 0) await fail(`a new workspace starts at goalVersion ${String(workspace.goalVersion)}, expected 0`)

  // Without this row every dispatch refuses with `invalid_provider` (M12 Task 8) and nothing runs.
  await prisma.providerConfiguration.create({ data: { workspaceId, kind: 'claude_code', settings: {} } })

  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  // The whole company. Atlas plans; Dev and Ops both hold `backend`, which is what makes
  // `--ask-on-task` necessary (exactly one of them may stop to ask); Rae reviews and does nothing
  // else, so it can never be dispatched a `backend` task mid-review nor be the author of the work
  // it reviews -- `dispatchReview` excludes nobody, so a reviewer that also coded COULD review its
  // own diff, and a fourth slave removes the ambiguity at zero product cost (ruling R5). Quinn
  // holds `qa` only until the question has been asked (erratum E1).
  const atlas = await prisma.slave.create({ data: { teamId: team.id, name: 'Atlas', role: 'Engineering Manager', runtimeRoles: ['manager'] } })
  const dev = await prisma.slave.create({ data: { teamId: team.id, name: 'Dev', role: 'Senior Engineer', runtimeRoles: ['backend'] } })
  const ops = await prisma.slave.create({ data: { teamId: team.id, name: 'Ops', role: 'Platform Engineer', runtimeRoles: ['backend'] } })
  const rae = await prisma.slave.create({ data: { teamId: team.id, name: 'Rae', role: 'Staff Reviewer', runtimeRoles: ['reviewer'] } })
  const quinn = await prisma.slave.create({ data: { teamId: team.id, name: 'Quinn', role: 'QA Engineer', runtimeRoles: [ASKED_ROLE] } })
  for (const slave of [atlas, dev, ops, rae, quinn]) {
    console.log(`slave ${slave.name} ${slave.id} runtimeRoles ${JSON.stringify(slave.runtimeRoles)}`)
  }

  /** The environment a child of this gate gets. `--ask-on-task` and `--replan-cancel` ride on
   *  `SLAVEOFAI_CLAUDE_ARGS`, i.e. on ARGV -- `claudeCommandFrom` splits it into `extraArgs`, which
   *  `ClaudeCodeAdapter.spawnRun`/`resume` put FIRST on every run's argv and `decisionArgs` puts
   *  first on every decision call's. `FAKE_CLAUDE_ASK_JSON` is an env var because a RUN inherits the
   *  daemon's environment (a DECISION child does not -- `buildDecisionEnv()` gives it PATH, HOME,
   *  LANG and TERM and nothing else, M31a §4 R1 -- which is exactly why the two flags are argv). */
  const childEnv = ({ askOnTask, askJson, replanCancelTaskId } = {}) =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS:
        `${FAKE_CLAUDE} --fixture m41-flow` +
        (askOnTask === undefined ? '' : ` --ask-on-task ${askOnTask}`) +
        (replanCancelTaskId === undefined ? '' : ` --replan-cancel ${replanCancelTaskId}`),
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
      ...(askJson === undefined ? {} : { FAKE_CLAUDE_ASK_JSON: askJson }),
    })

  /** The `--ask-on-task` token. `SLAVEOFAI_CLAUDE_ARGS` is split on a single space
   *  (`apps/orchestrator/src/claude-command.ts`), so a value with spaces in it would arrive as four
   *  separate argv entries and the flag would read `Write` as its whole value. The token is the
   *  LAST WORD of the task's title -- `core`, which appears in `Task: Write the feature core` and in
   *  no other task's title, description or roster line in this workspace -- so the substring the
   *  fake CLI looks for is `Task: ...core`'s own tail. Asserted below rather than assumed: the gate
   *  checks that exactly one of the three planned titles ends with it. */
  const ASK_ON_TASK_TOKEN = CORE_TITLE.split(' ').at(-1)

  if (PLAN_TITLES.filter((title) => title.split(' ').includes(ASK_ON_TASK_TOKEN)).length !== 1) {
    await fail(`the ask token ${JSON.stringify(ASK_ON_TASK_TOKEN)} does not identify exactly one planned title among ${JSON.stringify(PLAN_TITLES)}`)
  }

  /** Runs the real orchestrator CLI as a subprocess, exactly as an operator's shell would, and
   *  throws on a non-zero exit. `envOpts` is for the ONE command that needs a per-invocation fake
   *  CLI knob: act 5's hand `tick`, which carries `--replan-cancel <polish>` the way act 5's daemon
   *  would have. The timeout is the outer bound on a hand `tick` that plans and drains; every other
   *  command here returns in milliseconds and would never reach it. */
  const runCli = (args, envOpts) =>
    execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
      cwd: repoRoot,
      env: childEnv(envOpts),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PLAN_TIMEOUT_MS,
    })

  /** The same, for a command whose REFUSAL is the measurement. */
  const runCliRaw = (args) =>
    spawnSync('node', [ORCHESTRATOR_CLI, ...args], {
      cwd: repoRoot,
      env: childEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  /** Git, in the operator's own repository -- act 4's and act 6's hand merges. */
  const git = (args) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' })

  /** The daemon this gate currently expects to be alive, or `null` between two of them.
   *  `waitUntil` fails immediately when it dies rather than sitting out a whole timeout. */
  let activeDaemon = null

  /** Polls until `probe` returns something non-null, or fails naming what it last saw. */
  async function waitUntil(description, timeoutMs, probe) {
    const deadline = Date.now() + timeoutMs
    let lastSeen = '<nothing yet>'
    for (;;) {
      const result = await probe((seen) => {
        lastSeen = seen
      })
      if (result !== null && result !== undefined) return result
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
  function spawnDaemon(label, stage) {
    const proc = spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspaceId, '--period', String(DAEMON_PERIOD_MS)], {
      cwd: repoRoot,
      env: childEnv(stage),
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
    console.log(`${label} spawned as pid ${String(proc.pid)} with ${JSON.stringify(stage ?? {})}`)
    return state
  }

  /** Stops a daemon and waits for the process to really be gone, so an act that counts rows is
   *  never counting them against a tick still in flight. */
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

  /** Every task on the board, oldest first -- the order the plans created them in. */
  const board = () => prisma.task.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })
  /** Every event of one type, oldest first. */
  const eventsOfType = (type) => prisma.executionEvent.findMany({ where: { workspaceId, type }, orderBy: { seq: 'asc' } })
  /** One section of a recorded manifest, by kind (`gate-m37`'s own helper). */
  const sourceOfKind = (manifest, kind) => manifest.sections.find((section) => section.kind === kind)
  /** Every answer written in reply to one question (`gate-m39`'s own helper). */
  const answersTo = (questionId) =>
    prisma.slaveMessage.findMany({ where: { workspaceId, kind: 'answer', replyToId: questionId }, orderBy: { seq: 'asc' } })
  /**
   * What the two hand-`tick` acts assert instead of stopping a daemon: nothing is running anywhere,
   * and the work this act was NOT supposed to start has no `SlaveRun` row.
   *
   * Nothing here is timed. `tick` dispatches work FIRST and plans afterwards, and the CLI waits for
   * what its tick started (`drainPumps`) before the process exits -- so by the time `runCli`
   * returns, the plan has committed, the dispatch phase that preceded it saw a board without it,
   * and no process exists that could take another look. The `NON_TERMINAL_RUN_STATUSES` count is
   * the proof that `drainPumps` really did drain: a planning run still in flight after the command
   * exited would mean the plan this act just read was concluded by nobody.
   */
  async function noRunsFor(label, tasks) {
    const alive = findRealDaemonPids()
    console.log(`${label}: orchestrator daemons running on this host: ${JSON.stringify(alive)}`)
    if (alive.length > 0) await fail(`${label}: a daemon is alive though this act ran no daemon at all: ${JSON.stringify(alive)}`)

    const live = await prisma.slaveRun.findMany({
      where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] }, slave: { team: { workspaceId } } },
    })
    console.log(`${label}: runs still in flight after the hand tick: ${String(live.length)}`)
    if (live.length > 0) {
      await fail(`${label}: the hand tick exited with ${String(live.length)} run(s) still in flight -- ${live.map((run) => `${run.id} (${run.kind}, ${run.status})`).join(', ')}`)
    }

    const runs = await prisma.slaveRun.findMany({ where: { taskId: { in: tasks.map((task) => task.id) } } })
    console.log(
      `${label}: runs for ${JSON.stringify(tasks.map((task) => task.title))} after the hand tick: ${String(runs.length)}`,
    )
    if (runs.length > 0) {
      await fail(
        `${label}: ${String(runs.length)} run(s) exist for work this act was supposed to leave alone -- ` +
          runs.map((run) => `${run.id} (task ${String(run.taskId)}, ${run.status})`).join(', '),
      )
    }
  }

  /**
   * Stops a daemon and then PROVES the work this act was stopped before has still not begun.
   *
   * Both callers are bounded by the DEPENDENCY GATE, not by a clock: each one has just read
   * `dependenciesDone: false` for the tasks it names off the orchestrator's own `loadWorld`, so the
   * scheduler could not have started them however many times it was woken (and it is woken by every
   * event, not by its period -- see the header). A run that exists anyway is a FAILURE, not a
   * tolerance: the story's claim about what had and had not started would be false, and every count
   * after it would be a race rather than a measurement.
   *
   * Also the restart proof `gate-m36-messaging.mjs` established: the stopped pid answers no signal,
   * `/proc/<pid>/cmdline` no longer reads as a daemon, and no orchestrator daemon is alive on this
   * host at all in the window this gate is about to take its readings in.
   */
  async function stopBeforeRunsFor(label, daemon, tasks) {
    const stoppedPid = daemon.proc.pid
    await stopDaemon(daemon)

    let stillAlive = true
    try {
      process.kill(stoppedPid, 0)
    } catch (error) {
      stillAlive = false
      console.log(`${label}: process.kill(${String(stoppedPid)}, 0) raised ${String(error.code)} -- ${daemon.label} is gone`)
    }
    if (stillAlive) await fail(`${label}: pid ${String(stoppedPid)} still answers signal 0 -- ${daemon.label} is not dead`)
    if (isRealDaemonProcess(stoppedPid)) await fail(`${label}: /proc/${String(stoppedPid)}/cmdline still names an orchestrator daemon`)
    const alive = findRealDaemonPids()
    console.log(`${label}: orchestrator daemons running on this host now: ${JSON.stringify(alive)}`)
    if (alive.length > 0) await fail(`${label}: an orchestrator daemon is still running after ${daemon.label} was stopped: ${JSON.stringify(alive)}`)

    const ids = tasks.map((task) => task.id)
    const runs = await prisma.slaveRun.findMany({ where: { taskId: { in: ids } } })
    console.log(
      `${label}: runs for ${JSON.stringify(tasks.map((task) => task.title))} at the moment ${daemon.label} stopped: ${String(runs.length)}`,
    )
    if (runs.length > 0) {
      await fail(
        `${label}: ${daemon.label} started ${String(runs.length)} run(s) for work this act was stopped before -- ` +
          runs.map((run) => `${run.id} (task ${String(run.taskId)}, ${run.status})`).join(', '),
      )
    }
  }

  /** The operator merges a finished task's branch into the base branch, for real, and then says so.
   *  This is the `!autoMerge` half of M35 t2: `merge.ts` left the branch alone on purpose, and
   *  `confirmIntegration` is the ONLY other writer of `Task.integratedAt`. */
  async function mergeAndConfirm(label, task) {
    if (task.branch === null) await fail(`${label}: task ${task.id} finished with no branch to merge`)
    const before = git(['log', '--oneline', 'main']).trim().split('\n').length
    console.log(`${label}: merging ${String(task.branch)} into main by hand (main has ${String(before)} commit(s))`)
    git(['merge', '--no-ff', task.branch, '-m', `merge: ${task.title}`])
    const log = git(['log', '--oneline', 'main'])
    console.log(`${label}: main after the merge:\n${log}`)
    if (!log.includes('fake work')) await fail(`${label}: the merged branch left no work on main:\n${log}`)

    const printed = runCli(['confirm-integration', '--task', task.id])
    console.log(`${label}: confirm-integration printed ${JSON.stringify(printed.trim())}`)
    const confirmed = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    console.log(`${label}: ${describeTask(confirmed)} integratedAt ${JSON.stringify(confirmed.integratedAt)}`)
    if (confirmed.integratedAt === null) await fail(`${label}: confirm-integration left integratedAt null`)
    return confirmed
  }

  /** What the orchestrator's OWN scheduler snapshot says about one task -- not a hand-written
   *  re-implementation of its dependency rule (`gate-m40` stage 3's idiom). */
  async function worldTask(label, taskId) {
    const loaded = await loadWorld(workspaceId)
    const found = loaded.world.tasks.find((task) => task.id === taskId)
    console.log(`${label}: the scheduler's world holds ${JSON.stringify(found)}`)
    if (found === undefined) await fail(`${label}: the scheduler's world does not hold task ${taskId}`)
    return found
  }

  // ================= Act 1: an operator sets a requirement, and a manager plans it ================

  const setV1 = runCli(['set-goal', '--workspace', workspaceId, '--goal', GOAL_V1])
  console.log(`act 1 set-goal printed: ${JSON.stringify(setV1.trim())}`)
  const v1Printed = JSON.parse(setV1)
  if (v1Printed.version !== 1) await fail(`act 1's set-goal printed version ${String(v1Printed.version)}, expected 1`)
  if (v1Printed.sha256 !== goalSha256(GOAL_V1)) {
    await fail(`act 1's set-goal printed sha256 ${String(v1Printed.sha256)}, expected ${goalSha256(GOAL_V1)}`)
  }

  // ONE hand tick, and no daemon: see the header. `tick` dispatches work before it plans, and the
  // CLI waits for what the tick started, so this single command lands the whole board with the
  // dispatch phase that could have taken it already behind it. Nothing here is polled, because
  // nothing here is in flight when the command returns.
  const tick1 = runCli(['tick', '--workspace', workspaceId])
  console.log(`act 1 tick reported:\n${tick1}`)

  // Read after the command rather than polled for: `concludePlanning` creates the whole graph in
  // one transaction and appends `workspace.plan_created` after it commits, and `drainPumps` means
  // that commit has already happened.
  const planCreated = await eventsOfType('workspace_plan_created')
  const planned = await board()
  console.log(`act 1 board (${String(planned.length)}):\n  ${planned.map(describeTask).join('\n  ')}`)
  if (planned.length !== PLAN_TITLES.length) await fail(`act 1's plan produced ${String(planned.length)} tasks, expected ${String(PLAN_TITLES.length)}`)
  for (const title of PLAN_TITLES) {
    if (!planned.some((task) => task.title === title)) await fail(`act 1's plan has no task titled ${JSON.stringify(title)}`)
  }
  for (const task of planned) {
    if (task.goalVersion !== 1) await fail(`act 1's ${JSON.stringify(task.title)} is stamped goalVersion ${String(task.goalVersion)}, expected 1`)
    if (task.status !== 'ready') await fail(`act 1's ${JSON.stringify(task.title)} is ${task.status}, expected ready`)
  }
  const coreTask = planned.find((task) => task.title === CORE_TITLE)
  const apiTask = planned.find((task) => task.title === API_TITLE)
  const polishTask = planned.find((task) => task.title === POLISH_TITLE)
  // Ruling R4's own claim, on the row this story will quote from in act 3.
  if (!coreTask.description.includes(SOURCED_QUOTE)) {
    await fail(`act 1's core task does not carry ${JSON.stringify(SOURCED_QUOTE)}: ${JSON.stringify(coreTask.description)}`)
  }

  console.log(`act 1 workspace.plan_created: ${planCreated.map(describeEvent).join('\n  ')}`)
  if (planCreated.length !== 1) await fail(`act 1 appended ${String(planCreated.length)} workspace.plan_created events, expected one`)
  if (planCreated[0].payload.goalVersion !== 1) {
    await fail(`act 1's workspace.plan_created says goalVersion ${String(planCreated[0].payload.goalVersion)}, expected 1`)
  }
  for (const event of await eventsOfType('task_created')) {
    if (event.payload.goalVersion !== 1) {
      await fail(`act 1's task.created for ${String(event.taskId)} says goalVersion ${String(event.payload.goalVersion)}, expected 1`)
    }
  }

  // The run the EVENT names, not "the oldest planning run".
  const planningRun = await prisma.slaveRun.findUniqueOrThrow({ where: { id: planCreated[0].runId }, include: { context: true } })
  if (planningRun.context === null) await fail(`act 1: planning run ${planningRun.id} recorded no context at all`)
  const planManifest = runContextManifestSchema.parse(planningRun.context.sections)
  console.log(`act 1 planning run ${planningRun.id} (${planningRun.status}) manifest: ${JSON.stringify(planManifest)}`)
  if (planManifest.kind !== 'planning') await fail(`act 1's planning manifest says kind ${planManifest.kind}, expected planning`)
  const planGoalSource = sourceOfKind(planManifest, 'planning_goal')
  if (planGoalSource === undefined || planGoalSource.version !== 1 || planGoalSource.sha256 !== goalSha256(GOAL_V1)) {
    await fail(`act 1's planning_goal section is ${JSON.stringify(planGoalSource)}, expected version 1 with the v1 goal's hash`)
  }
  // A FIRST plan, not a delta: its absence here is what makes act 5's presence mean something.
  if (sourceOfKind(planManifest, 'replan') !== undefined) await fail('act 1: the FIRST planning run recorded a replan section')
  if (!planningRun.context.prompt.includes(GOAL_V1)) await fail('act 1: the planning prompt does not carry the goal it was derived from')

  // The board is complete and not one task has started. Not a timing claim any more (the header's
  // own correction): with no daemon in the world there is nothing that could have started one.
  await noRunsFor('act 1', [coreTask, apiTask, polishTask])

  const replanBefore = JSON.parse(runCli(['replan-status', '--workspace', workspaceId]))
  console.log(`act 1 replan-status: ${JSON.stringify(replanBefore)}`)
  if (replanBefore.willReplan !== false || replanBefore.blockedBy !== null) {
    await fail(`act 1's replan-status reads ${JSON.stringify(replanBefore)}, expected willReplan false with nothing in the way`)
  }
  if (replanBefore.goalVersion !== 1 || replanBefore.boardVersion !== 1) {
    await fail(`act 1's replan-status reads goal ${String(replanBefore.goalVersion)} / board ${String(replanBefore.boardVersion)}, expected 1 / 1`)
  }
  console.log('act 1 complete: a requirement became version 1, a manager turned it into three tasks, and every one of them carries the version that produced it -- and not one of them has started')

  // ================= Act 2: a worker starts, and stops to ask =====================================

  const daemon1 = spawnDaemon('daemon-1', {
    askOnTask: ASK_ON_TASK_TOKEN,
    askJson: JSON.stringify({ role: ASKED_ROLE, question: ASK_QUESTION }),
  })

  const coreRunStarted = await waitUntil('a run for the core task', DISPATCH_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findFirst({ where: { taskId: coreTask.id }, include: { slave: true } })
    note(run === null ? 'no SlaveRun row yet' : `run ${run.id} is ${run.status}`)
    return run
  })
  // WHICH of the two backend workers took it is recorded, not asserted: `decide()` picks the first
  // non-busy holder in the world's own slave order, and the story is true whichever it is.
  console.log(`act 2: core was dispatched to ${coreRunStarted.slave.name} (${coreRunStarted.slaveId}) as run ${coreRunStarted.id}`)

  const parkedRun = await waitUntil('the run to park waiting for an answer', WAITING_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findUnique({ where: { id: coreRunStarted.id } })
    note(run === null ? 'the run row vanished' : `run is ${run.status}, pauseReason ${JSON.stringify(run.pauseReason)}`)
    return run !== null && run.status === 'paused' && run.pauseReason === 'waiting_for_answer' ? run : null
  })
  const question = await waitUntil('the question row the run asked', WAITING_TIMEOUT_MS, async (note) => {
    const row = await prisma.slaveMessage.findFirst({ where: { workspaceId, kind: 'question', senderRunId: parkedRun.id } })
    note(row === null ? 'no question row yet' : `question ${row.id}`)
    return row
  })
  console.log(`act 2 question: ${describeMessage(question)}`)
  if (question.recipientRole !== ASKED_ROLE) await fail(`act 2's question is addressed to ${JSON.stringify(question.recipientRole)}, expected the ${ASKED_ROLE} role`)
  if (!question.body.includes(ASK_QUESTION)) await fail(`act 2's question body is ${JSON.stringify(question.body)}, expected the envelope's own question`)

  // Waited for rather than read once: `concludeWithQuestion` writes checkpoint -> message -> claim
  // the run -> park the task, and the first three are already done when the waits above return.
  const parkedTask = await waitUntil('the core task to park waiting', WAITING_TIMEOUT_MS, async (note) => {
    const row = await prisma.task.findUniqueOrThrow({ where: { id: coreTask.id } })
    note(`task is ${row.status}`)
    return row.status === 'waiting' ? row : null
  })
  console.log(`act 2 core task: ${describeTask(parkedTask)}`)
  // Asking is not failing: no attempt is charged, and nothing announced a failure.
  if (parkedTask.attempt !== 0) await fail(`act 2 charged the core task attempt ${String(parkedTask.attempt)} for stopping to ask, expected 0`)
  if (parkedTask.activeRunId !== parkedRun.id) await fail(`act 2's parked task points at run ${String(parkedTask.activeRunId)}, expected ${parkedRun.id}`)
  const runFailed = await eventsOfType('run_failed')
  console.log(`act 2 run.failed events: ${String(runFailed.length)}`)
  if (runFailed.length !== 0) await fail(`act 2 recorded ${String(runFailed.length)} run.failed event(s): ${runFailed.map(describeEvent).join('; ')}`)
  const questions = await prisma.slaveMessage.findMany({ where: { workspaceId, kind: 'question' } })
  if (questions.length !== 1) await fail(`act 2 wrote ${String(questions.length)} question rows, expected exactly one`)

  // Nothing else moved: api depends on core, polish on api, and neither may start.
  for (const task of [apiTask, polishTask]) {
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    const runs = await prisma.slaveRun.count({ where: { taskId: task.id } })
    console.log(`act 2 ${JSON.stringify(task.title)}: ${row.status}, ${String(runs)} run(s)`)
    if (row.status !== 'ready' || runs !== 0) await fail(`act 2 moved ${JSON.stringify(task.title)}: ${row.status} with ${String(runs)} run(s)`)
  }

  // The manifest hashed the task text the renderer hashed -- computed with the product's OWN
  // exported hash (`goalSha256` is a general SHA-256 of a UTF-8 string, cross-checked against
  // `node:crypto` by its own test), never re-implemented here (erratum E12).
  const coreContext = await prisma.runContext.findUniqueOrThrow({ where: { runId: parkedRun.id } })
  const coreManifest = runContextManifestSchema.parse(coreContext.sections)
  const taskSource = sourceOfKind(coreManifest, 'task')
  const expectedTaskSha = goalSha256(`${coreTask.title}\n${coreTask.description}`)
  console.log(`act 2 task section: ${JSON.stringify(taskSource)}; expected sha256 ${expectedTaskSha}`)
  if (taskSource === undefined || taskSource.taskId !== coreTask.id) await fail(`act 2's manifest task section is ${JSON.stringify(taskSource)}`)
  if (taskSource.sha256 !== expectedTaskSha) await fail(`act 2's manifest hashed ${String(taskSource.sha256)}, expected ${expectedTaskSha}`)
  // Erratum E2, on the recorded prompt itself: the discriminator is in there and the id is not.
  if (!coreContext.prompt.includes(`Task: ${CORE_TITLE}`)) await fail("act 2: the run's prompt does not carry its task section's `Task: <title>` line")
  if (coreContext.prompt.includes(coreTask.id)) await fail('act 2: the work prompt contains the task id -- erratum E2 says it does not, and the fake CLI keys on the title because of it')

  // The roster change that makes the question unanswerable, and the whole reason act 3 has a
  // situation to decide (erratum E1): until this runs, a question to a role somebody holds is not
  // stuck, and before the ask it could not have been sent at all.
  const rolesPrinted = runCli(['set-runtime-roles', '--slave', quinn.id, '--roles', ''])
  console.log(`act 2 set-runtime-roles printed: ${JSON.stringify(rolesPrinted.trim())}`)
  console.log('act 2 complete: one worker took the only startable task, hit a wall, and asked the QA role a question -- no attempt charged, no failure announced, and nothing else on the board moved')

  // ================= Act 3: the Supervisor answers what nobody else can ===========================

  const FIXTURE_CHOICE_COST_USD = fixtureCostUsd('supervisor-decision')
  const FIXTURE_ANSWER_COST_USD = fixtureCostUsd('supervisor-answer')

  const decision = await waitUntil('the Supervisor to decide about the question', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const rows = await prisma.supervisorDecision.findMany({ where: { workspaceId, situationKind: 'unanswerable_question', subjectId: question.id } })
    note(`${String(rows.length)} unanswerable_question decision(s) so far`)
    return rows.length === 0 ? null : rows[0]
  })
  console.log(`act 3 decision: ${describeDecision(decision)}`)
  console.log(`  situation: ${JSON.stringify(decision.situation)}`)
  if (decision.action.kind !== 'answer_question') await fail(`act 3 chose ${String(decision.action.kind)}, expected answer_question`)
  if (decision.action.messageId !== question.id) await fail(`act 3 answered ${String(decision.action.messageId)}, expected ${question.id}`)
  if (decision.tier !== 'applied' || decision.status !== 'applied') await fail(`act 3's decision is ${decision.tier}/${decision.status}, expected applied/applied`)
  if (decision.failureReason !== null) await fail(`act 3's decision records a failure: ${String(decision.failureReason)}`)
  if (decision.decidedBy !== 'model' || decision.modelCalled !== true) await fail(`act 3's decision says decidedBy ${decision.decidedBy}, modelCalled ${String(decision.modelCalled)}`)
  // Both calls, added: the choice and the answer. Read off the fixtures at runtime.
  if (!sameMoney(decision.modelCostUsd, FIXTURE_CHOICE_COST_USD + FIXTURE_ANSWER_COST_USD)) {
    await fail(`act 3 recorded modelCostUsd ${String(decision.modelCostUsd)}, expected ${String(FIXTURE_CHOICE_COST_USD + FIXTURE_ANSWER_COST_USD)}`)
  }
  const draft = decision.draft
  if (draft === null) await fail('act 3: the answer decision carries no draft')
  if (draft.confidence !== 'sourced') await fail(`act 3's draft is ${String(draft.confidence)}, expected sourced`)
  if (!Array.isArray(draft.sources) || !draft.sources.some((source) => source.quote === SOURCED_QUOTE)) {
    await fail(`act 3's verified citations do not include ${JSON.stringify(SOURCED_QUOTE)}: ${JSON.stringify(draft.sources)}`)
  }
  if (!Array.isArray(draft.rejectedSources) || draft.rejectedSources.length !== 0) {
    await fail(`act 3's draft has rejected citations though it was called sourced: ${JSON.stringify(draft.rejectedSources)}`)
  }

  const answers = await waitUntil('the Supervisor answer to be written', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const rows = await answersTo(question.id)
    note(`${String(rows.length)} answer(s) so far`)
    return rows.length === 0 ? null : rows
  })
  console.log(`act 3 answers (${String(answers.length)}):\n  ${answers.map(describeMessage).join('\n  ')}`)
  if (answers.length !== 1) await fail(`act 3 wrote ${String(answers.length)} answers, expected exactly one`)
  const answer = answers[0]
  // The envelope actor of a machine's answer. `human` here would credit a person with words nobody
  // typed.
  if (answer.actor !== 'system') await fail(`act 3's answer says actor ${answer.actor}, expected system`)
  if (answer.body !== draft.body) await fail(`act 3 sent ${JSON.stringify(answer.body)}, expected the draft's own text`)
  if (!answer.body.includes(SOURCED_QUOTE)) await fail(`act 3's answer does not carry the quote it was sourced from: ${JSON.stringify(answer.body)}`)

  const sentEvent = await waitUntil('the slave.message_sent event for the answer', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.executionEvent.findFirst({ where: { workspaceId, type: 'slave_message_sent' }, orderBy: { seq: 'desc' } })
    note(row === null ? 'no slave.message_sent event yet' : `newest names message ${String(row.payload.messageId)}`)
    return row !== null && row.payload.messageId === answer.id ? row : null
  })
  console.log(`act 3 slave.message_sent: actor ${sentEvent.actor}, payload ${JSON.stringify(sentEvent.payload)}`)
  if (sentEvent.actor !== 'system') await fail(`act 3's answer envelope says actor ${sentEvent.actor}, expected system`)
  if (sentEvent.payload.answeredBy !== 'supervisor') await fail(`act 3's answer says answeredBy ${String(sentEvent.payload.answeredBy)}, expected supervisor`)

  // The resume belongs to a LATER tick than the one that answered (`deliverAnswers` runs early in a
  // tick, the Supervisor at its end), which is why this is a wait and never a read.
  const resumed = await waitUntil('the parked run to resume and conclude', RESUME_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findUnique({ where: { id: parkedRun.id } })
    note(run === null ? 'the run row vanished' : `run is ${run.status}`)
    return run !== null && run.status === 'succeeded' ? run : null
  })
  console.log(`act 3 resumed run ${resumed.id}: ${resumed.status}, pauseReason ${JSON.stringify(resumed.pauseReason)}, pid ${String(resumed.pid)}, costUsd ${String(resumed.costUsd)}`)
  if (resumed.pauseReason !== null) await fail(`act 3's resumed run still carries pauseReason ${JSON.stringify(resumed.pauseReason)}`)
  // A SECOND provider process was started for this run after it parked, which is what "resumed"
  // means: `executeResume` writes the new child's pid back over the null the ask left.
  if (resumed.pid === null) await fail('act 3: the run has no pid after the resume, so nothing actually resumed it')
  const coreRuns = await prisma.slaveRun.findMany({ where: { taskId: coreTask.id } })
  if (coreRuns.length !== 1) await fail(`act 3: the core task has ${String(coreRuns.length)} runs -- the answer started a NEW run instead of continuing the waiting one`)

  // The SAME session, continued: `--resume <sessionId>` never mints a new id (ADR 0001 §3/§5), so
  // the two events have to name one session or the "same slave, woken up" claim is false.
  const startedEvents = await prisma.executionEvent.findMany({ where: { workspaceId, runId: parkedRun.id, type: 'run_started' }, orderBy: { seq: 'asc' } })
  const resumedEvents = await prisma.executionEvent.findMany({ where: { workspaceId, runId: parkedRun.id, type: 'run_resumed' }, orderBy: { seq: 'asc' } })
  console.log(`act 3 run.started: ${startedEvents.map(describeEvent).join('; ')}`)
  console.log(`act 3 run.resumed: ${resumedEvents.map(describeEvent).join('; ')}`)
  if (resumedEvents.length !== 1) await fail(`act 3 recorded ${String(resumedEvents.length)} run.resumed events, expected one`)
  if (resumedEvents[0].payload.sessionId !== startedEvents[0].payload.sessionId) {
    await fail(`act 3 resumed session ${String(resumedEvents[0].payload.sessionId)}, expected the one it started, ${String(startedEvents[0].payload.sessionId)}`)
  }

  // The operator's surface, through the verb `buildSupervisorView` composes (ruling R6).
  const mailboxWorld = await loadSupervisorWorld(workspaceId, new Date())
  const mailboxReport = summarise(mailboxWorld.world)
  console.log(`act 3 supervisor report mailbox: ${JSON.stringify(mailboxReport.mailbox)}`)
  if (mailboxReport.mailbox.answeredBySupervisor24h !== 1) {
    await fail(`act 3's report says answeredBySupervisor24h ${String(mailboxReport.mailbox.answeredBySupervisor24h)}, expected 1`)
  }
  if (mailboxReport.mailbox.draftsAwaiting !== 0) {
    await fail(`act 3's report says draftsAwaiting ${String(mailboxReport.mailbox.draftsAwaiting)}, expected 0 -- this answer needed nobody`)
  }
  console.log('act 3 complete: nobody in the company could answer the question, so the Supervisor found the answer in the asking task, checked the quote in code, sent it as the machine -- and the next tick woke the run that had been waiting for it')

  // ================= Act 4: verified, reviewed, and integrated by a human =========================

  const coreDone = await waitUntil('the core task to finish', PIPELINE_TIMEOUT_MS, async (note) => {
    const row = await prisma.task.findUniqueOrThrow({ where: { id: coreTask.id } })
    note(`core is ${row.status}`)
    return row.status === 'done' ? row : null
  })
  console.log(`act 4 core: ${describeTask(coreDone)}, integratedAt ${JSON.stringify(coreDone.integratedAt)}, branch ${JSON.stringify(coreDone.branch)}`)
  // M35 t2 on the row: `merge.ts`'s !autoMerge path marks the task done and leaves the branch for a
  // human, EXPLICITLY leaving `integratedAt` null.
  if (coreDone.integratedAt !== null) await fail(`act 4's core task is already integrated (${String(coreDone.integratedAt)}) on a workspace that does not auto-merge`)
  for (const type of ['task_verifying', 'task_verify_passed', 'task_review_started', 'task_review_approved', 'task_done']) {
    const rows = await eventsOfType(type)
    console.log(`act 4 ${type}: ${String(rows.length)} -- ${rows.map(describeEvent).join('; ')}`)
    if (!rows.some((row) => row.taskId === coreTask.id)) await fail(`act 4: core reached done with no ${type} event`)
  }
  // Rae reviewed it, and Rae is not the author (ruling R5).
  const coreReview = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: coreTask.id, kind: 'review' }, include: { slave: true } })
  console.log(`act 4 core review run ${coreReview.id} by ${coreReview.slave.name} (${coreReview.status})`)
  if (coreReview.slaveId !== rae.id) await fail(`act 4's core review was taken by ${coreReview.slave.name}, expected Rae`)

  // M35's whole claim, measured through the snapshot the SCHEDULER decides from: work that is done
  // but not merged does not unblock anything.
  const apiBeforeIntegration = await worldTask('act 4 (before the hand merge)', apiTask.id)
  if (apiBeforeIntegration.dependenciesDone !== false) {
    await fail('act 4: api reports dependenciesDone true while the work it depends on is done but still sitting on an unmerged branch')
  }
  // Read for ITSELF, not inferred from api's (fix round 1, minor 3). The stop below names both
  // tasks, and what makes that stop a measurement rather than a race is that NEITHER of them was
  // startable -- `polish` sits behind `api`, which is not even done yet, and a claim about it that
  // was only transitively true would be a claim this gate never actually took.
  const polishBeforeMerge = await worldTask('act 4 (polish before the hand merge)', polishTask.id)
  if (polishBeforeMerge.dependenciesDone !== false) {
    await fail('act 4: polish reports dependenciesDone true though the api task it depends on has not even been written yet')
  }

  await stopBeforeRunsFor('act 4 (before the merge)', daemon1, [apiTask, polishTask])
  await mergeAndConfirm('act 4', coreDone)

  const integratedEvents = await eventsOfType('task_integrated')
  console.log(`act 4 task.integrated: ${integratedEvents.map(describeEvent).join('; ')}`)
  if (integratedEvents.length !== 1 || integratedEvents[0].taskId !== coreTask.id) {
    await fail(`act 4 recorded ${String(integratedEvents.length)} task.integrated events, expected one for core`)
  }
  if (integratedEvents[0].actor !== 'human') await fail(`act 4's task.integrated says actor ${integratedEvents[0].actor}, expected human -- a person merged it`)

  const apiAfterIntegration = await worldTask('act 4 (after the hand merge)', apiTask.id)
  if (apiAfterIntegration.dependenciesDone !== true) await fail('act 4: api is still not schedulable after its dependency was merged and confirmed')

  // Daemon-2 carries NO ask flag, so api's work run commits instead of asking. (It would not ask
  // anyway -- the token names core's title alone -- but the story is about a project that has
  // stopped needing to ask, and the argv says so.)
  const daemon2 = spawnDaemon('daemon-2')

  const apiDone = await waitUntil('the api task to finish', PIPELINE_TIMEOUT_MS, async (note) => {
    const row = await prisma.task.findUniqueOrThrow({ where: { id: apiTask.id } })
    note(`api is ${row.status}`)
    return row.status === 'done' ? row : null
  })
  console.log(`act 4 api: ${describeTask(apiDone)}, integratedAt ${JSON.stringify(apiDone.integratedAt)}, branch ${JSON.stringify(apiDone.branch)}`)
  if (apiDone.integratedAt !== null) await fail('act 4: api integrated itself on a workspace that does not auto-merge')
  const apiRuns = await prisma.slaveRun.findMany({ where: { taskId: apiTask.id }, include: { slave: true } })
  console.log(`act 4 api runs: ${apiRuns.map((run) => `${run.kind} by ${run.slave.name} (${run.status})`).join(', ')}`)
  const apiImplementations = apiRuns.filter((run) => run.kind === 'implementation')
  if (apiImplementations.length !== 1) {
    await fail(
      `act 4 started ${String(apiImplementations.length)} implementation runs for api, expected one -- ` +
        `api's runs are ${JSON.stringify(apiRuns.map((run) => `${run.kind}/${run.status}`))}`,
    )
  }
  const apiReview = apiRuns.find((run) => run.kind === 'review')
  if (apiReview === undefined || apiReview.slaveId !== rae.id) await fail('act 4: api was not reviewed by Rae')
  // Nobody asked anything this time.
  if ((await prisma.slaveMessage.count({ where: { workspaceId, kind: 'question' } })) !== 1) {
    await fail('act 4: a second question was asked -- the ask flag names core alone')
  }

  // api is `done` and unintegrated, so polish CANNOT start. That is what makes stopping here a
  // certainty rather than a race, and it is what act 5 depends on.
  const polishBeforeReplan = await worldTask('act 4 (polish before the re-plan)', polishTask.id)
  if (polishBeforeReplan.dependenciesDone !== false) await fail('act 4: polish is schedulable though api is done but unmerged')
  await stopBeforeRunsFor('act 4 (before polish)', daemon2, [polishTask])

  // The spend so far, printed as a table and asserted against the one formula every surface reads
  // (`workspaceSpend`). The asking leg's own line is erratum E3.
  const COST_PLAN = fixtureCostUsd('plan-graph-scenario')
  const COST_WORK = fixtureCostUsd('complete')
  const COST_REVIEW = fixtureCostUsd('review-approve')
  const partialTable = [
    { kind: 'planning run (the first plan)', count: 1, unitUsd: COST_PLAN },
    { kind: 'implementation run, core (asking leg $0 + resumed leg: ONE row, ONE recorded cost)', count: 1, unitUsd: COST_WORK },
    { kind: 'implementation run, api', count: 1, unitUsd: COST_WORK },
    { kind: 'review run', count: 2, unitUsd: COST_REVIEW },
    { kind: 'supervisor decision: choose an action', count: 1, unitUsd: FIXTURE_CHOICE_COST_USD },
    { kind: 'supervisor decision: draft the answer', count: 1, unitUsd: FIXTURE_ANSWER_COST_USD },
  ]
  const printTable = (label, table) => {
    let total = 0
    console.log(`${label}:`)
    for (const row of table) {
      const subtotal = row.count * row.unitUsd
      total += subtotal
      console.log(`  ${String(row.count).padStart(2)} x $${row.unitUsd.toFixed(6)} = $${subtotal.toFixed(6)}  ${row.kind}`)
    }
    console.log(`  total $${total.toFixed(6)}`)
    return total
  }
  const partialTotal = printTable('act 4 spend so far', partialTable)
  const partialSpend = await workspaceSpend(workspaceId)
  console.log(`act 4 workspaceSpend: ${JSON.stringify(partialSpend)}`)
  if (!sameMoney(partialSpend.spentUsd, partialTotal)) {
    await fail(`act 4's workspaceSpend says $${String(partialSpend.spentUsd)}, the table says $${String(partialTotal)}`)
  }
  // Erratum E3, stated on the row itself: the paused leg wrote no cost, so the one row for the
  // asking task carries exactly ONE `complete`.
  if (!sameMoney(resumed.costUsd, COST_WORK)) {
    await fail(`act 4: the run that asked and resumed records $${String(resumed.costUsd)}, expected exactly one \`complete\` ($${String(COST_WORK)}) -- a paused leg records no cost at all`)
  }
  console.log('act 4 complete: two tasks were written, verified, reviewed by a slave that wrote neither of them, and merged onto main by a person -- and the second could not start until the first really landed there')

  // ================= Act 5: the requirement changes, and the board catches up =====================

  const setV2 = runCli(['set-goal', '--workspace', workspaceId, '--goal', GOAL_V2])
  console.log(`act 5 set-goal printed: ${JSON.stringify(setV2.trim())}`)
  if (JSON.parse(setV2).version !== 2) await fail(`act 5's set-goal printed ${setV2.trim()}, expected version 2`)

  const historyOutput = runCli(['goal-history', '--workspace', workspaceId])
  console.log(`act 5 goal-history printed:\n${historyOutput}`)
  const history = JSON.parse(historyOutput)
  if (history.length !== 2 || history[0].version !== 2 || history[1].version !== 1) {
    await fail(`act 5's goal-history is ${JSON.stringify(history.map((row) => row.version))}, expected [2, 1]`)
  }
  if (history[0].text !== GOAL_V2 || history[1].text !== GOAL_V1) await fail("act 5's goal-history does not carry both texts")
  if (history[0].sha256 !== goalSha256(GOAL_V2) || history[1].sha256 !== goalSha256(GOAL_V1)) await fail("act 5's goal-history hashes do not match the texts")
  if (history[0].diff === null || history[0].diff.added.length === 0 || history[0].diff.removed.length === 0) {
    await fail(`act 5's newest version carries no diff against the one it replaced: ${JSON.stringify(history[0].diff)}`)
  }
  if (history[1].diff !== null) await fail(`act 5's v1 carries a diff (${JSON.stringify(history[1].diff)}) though it replaced nothing`)
  // The CONTROL verb the web's history route reads through (ruling R6) has to agree with the CLI.
  const versionsViaControl = await listGoalVersions(workspaceId)
  if (!versionsViaControl.ok || JSON.stringify(versionsViaControl.value) !== JSON.stringify(history)) {
    await fail(`act 5: listGoalVersions and \`goal-history\` disagree:\n  ${JSON.stringify(versionsViaControl)}\n  ${historyOutput}`)
  }

  const replanDue = JSON.parse(runCli(['replan-status', '--workspace', workspaceId]))
  console.log(`act 5 replan-status: ${JSON.stringify(replanDue)}`)
  if (replanDue.willReplan !== true || replanDue.blockedBy !== null) {
    await fail(`act 5's replan-status reads ${JSON.stringify(replanDue)}, expected a re-plan due with nothing in the way`)
  }
  if (replanDue.goalVersion !== 2 || replanDue.boardVersion !== 1) {
    await fail(`act 5's replan-status reads goal ${String(replanDue.goalVersion)} / board ${String(replanDue.boardVersion)}, expected 2 / 1`)
  }

  // The second hand tick, and for the same reason as act 1's: the re-plan's own conclusion is what
  // would wake a daemon into starting `docs`, and act 7's board says `docs` never started. The
  // `--replan-cancel <polish>` knob rides on this invocation's argv exactly as it would have on a
  // daemon's -- `replanArm` substitutes it into the delta fixture's `$CANCEL_ID`.
  const tick2 = runCli(['tick', '--workspace', workspaceId], { replanCancelTaskId: polishTask.id })
  console.log(`act 5 tick reported:\n${tick2}`)

  const replanStarted = await eventsOfType('workspace_replan_started')
  console.log(`act 5 workspace.replan_started: ${replanStarted.map(describeEvent).join('; ')}`)
  if (replanStarted.length !== 1 || replanStarted[0].payload.version !== 2) {
    await fail(`act 5 started ${String(replanStarted.length)} re-plans: ${JSON.stringify(replanStarted.map((event) => event.payload))}`)
  }
  const replanRunId = replanStarted[0].payload.runId
  const replanContext = await prisma.runContext.findUnique({ where: { runId: replanRunId } })
  if (replanContext === null) await fail(`act 5: the re-plan run ${String(replanRunId)} recorded no context at all`)
  const replanManifest = runContextManifestSchema.parse(replanContext.sections)
  console.log(`act 5 re-plan manifest: ${JSON.stringify(replanManifest)}`)
  const replanSource = sourceOfKind(replanManifest, 'replan')
  if (replanSource === undefined) await fail('act 5: the re-plan run recorded no replan section')
  if (replanSource.previousVersion !== 1 || replanSource.version !== 2) {
    await fail(`act 5's replan section moves ${String(replanSource.previousVersion)} -> ${String(replanSource.version)}, expected 1 -> 2`)
  }
  if (replanSource.previousSha256 !== goalSha256(GOAL_V1) || replanSource.sha256 !== goalSha256(GOAL_V2)) {
    await fail(`act 5's replan section hashes ${JSON.stringify(replanSource)}, expected both goal texts' own hashes`)
  }
  // Erratum E11: the prompt's board is the NON-terminal board -- "every task that is not done,
  // failed or cancelled" -- so the only thing the manager was shown is the work still outstanding.
  if (JSON.stringify([...replanSource.boardTaskIds].sort()) !== JSON.stringify([polishTask.id])) {
    await fail(`act 5's manager was shown ${JSON.stringify(replanSource.boardTaskIds)}, expected only the unfinished ${polishTask.id}`)
  }
  if (!replanContext.prompt.includes('"replan"')) await fail('act 5: the re-plan prompt does not contain the literal "replan" -- it was given the FIRST-plan instructions')
  if (!replanContext.prompt.includes('THE GOAL CHANGED')) await fail('act 5: the re-plan prompt does not say the goal changed')
  if (!replanContext.prompt.includes(GOAL_V1) || !replanContext.prompt.includes(GOAL_V2)) {
    await fail('act 5: the re-plan prompt does not carry BOTH goal texts, so the manager cannot see what changed')
  }

  const replanned = await eventsOfType('workspace_replanned')
  console.log(`act 5 workspace.replanned: ${replanned.map(describeEvent).join('; ')}`)
  if (replanned.length !== 1) await fail(`act 5 concluded ${String(replanned.length)} re-plans, expected one`)
  const replannedPayload = replanned[0].payload

  const afterReplan = await board()
  const docsTask = afterReplan.find((task) => !planned.some((old) => old.id === task.id))
  console.log(`act 5 board (${String(afterReplan.length)}):\n  ${afterReplan.map(describeTask).join('\n  ')}`)
  if (afterReplan.length !== 4 || docsTask === undefined) await fail(`act 5's delta produced ${String(afterReplan.length - 3)} additions, expected exactly one`)
  if (docsTask.title !== ADDED_TITLE) await fail(`act 5 added ${JSON.stringify(docsTask.title)}, expected ${JSON.stringify(ADDED_TITLE)}`)
  if (docsTask.status !== 'ready' || docsTask.goalVersion !== 2) {
    await fail(`act 5's addition is ${docsTask.status} at goal v${String(docsTask.goalVersion)}, expected ready at v2`)
  }
  // The tasks the delta did not mention are untouched, and still carry the version that made them.
  for (const task of [coreTask, apiTask, polishTask]) {
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    if (row.goalVersion !== 1) await fail(`act 5 restamped ${JSON.stringify(task.title)} to goal v${String(row.goalVersion)}`)
  }
  if (JSON.stringify(replannedPayload.added) !== JSON.stringify([docsTask.id])) {
    await fail(`act 5's workspace.replanned lists added ${JSON.stringify(replannedPayload.added)}, expected ${JSON.stringify([docsTask.id])}`)
  }
  if (JSON.stringify(replannedPayload.proposedCancellations) !== JSON.stringify([polishTask.id])) {
    await fail(`act 5's workspace.replanned proposes ${JSON.stringify(replannedPayload.proposedCancellations)}, expected ${JSON.stringify([polishTask.id])}`)
  }
  // The three lists together account for every id the model asked to cancel.
  if (replannedPayload.droppedCancellations.length !== 0 || replannedPayload.failedProposals.length !== 0) {
    await fail(`act 5 dropped ${JSON.stringify(replannedPayload.droppedCancellations)} and failed ${JSON.stringify(replannedPayload.failedProposals)}, expected neither`)
  }

  // Read, not waited for: `concludeReplan` records the proposal in the same transaction that adds
  // the task, and that transaction had already committed when the hand tick's process exited.
  const proposal = await prisma.supervisorDecision.findMany({ where: { workspaceId, situationKind: 'stale_task' } })
  console.log(`act 5 stale_task decisions (${String(proposal.length)}):\n  ${proposal.map(describeDecision).join('\n  ')}`)
  if (proposal.length !== 1) await fail(`act 5 recorded ${String(proposal.length)} stale_task decisions, expected one`)
  const cancelProposal = proposal[0]
  if (cancelProposal.subjectId !== polishTask.id) await fail(`act 5's proposal is about ${String(cancelProposal.subjectId)}, expected polish`)
  if (cancelProposal.action.kind !== 'cancel_task' || cancelProposal.action.taskId !== polishTask.id) {
    await fail(`act 5's proposal chose ${JSON.stringify(cancelProposal.action)}, expected cancel_task on polish`)
  }
  // Ruling R1 of M40, on the row: a cancellation is NEVER applied by the machine.
  if (cancelProposal.tier !== 'proposed' || cancelProposal.status !== 'pending') {
    await fail(`act 5's proposal is ${cancelProposal.tier}/${cancelProposal.status}, expected proposed/pending`)
  }
  // The re-plan run already paid for this judgement; the Supervisor's spend must not gain a call
  // that never happened.
  if (cancelProposal.modelCalled !== false || cancelProposal.modelCostUsd !== null) {
    await fail(`act 5's proposal records modelCalled ${String(cancelProposal.modelCalled)} / modelCostUsd ${String(cancelProposal.modelCostUsd)}`)
  }
  const polishWhileProposed = await prisma.task.findUniqueOrThrow({ where: { id: polishTask.id } })
  if (polishWhileProposed.status !== 'ready') await fail(`act 5's polish task is ${polishWhileProposed.status} though nobody approved the cancellation`)

  // `docs` is the only thing on this board that COULD start (polish is still blocked behind an
  // unintegrated api), and it is the last act's "what comes next", not work done. Under a daemon
  // that would be a race with the notification the re-plan itself sent; under a hand tick it is a
  // fact, because the dispatch phase of the only tick there was ran before `docs` existed.
  await noRunsFor('act 5 (before docs)', [docsTask, polishTask])
  console.log('act 5 complete: the requirement moved, one run was asked for the DELTA against the board it was shown, the addition is on the board stamped with the version that asked for it, and the cancellation is a proposal nobody has approved')

  // ================= Act 6: a human approves the cancellation =====================================

  const approvePrinted = runCli(['approve-decision', '--id', cancelProposal.id])
  console.log(`act 6 approve-decision printed: ${JSON.stringify(approvePrinted.trim())}`)
  const approved = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: cancelProposal.id } })
  console.log(`act 6 decision after approval: ${describeDecision(approved)}`)
  // Erratum E6: an approved proposal reads `approved`, not `applied` -- `approveDecision` claims the
  // row to `approved` and then carries the action out.
  if (approved.status !== 'approved') await fail(`act 6's decision is ${approved.status} after approval, expected approved`)
  if (approved.failureReason !== null) await fail(`act 6's approval refused: ${String(approved.failureReason)}`)

  const polishCancelled = await prisma.task.findUniqueOrThrow({ where: { id: polishTask.id } })
  console.log(`act 6 polish: ${describeTask(polishCancelled)}`)
  if (polishCancelled.status !== 'cancelled') await fail(`act 6's polish task is ${polishCancelled.status}, expected cancelled`)
  if (polishCancelled.lastRejectionReason === null) await fail('act 6: the cancelled task keeps no reason for why it was dropped')

  const cancelledEvents = await eventsOfType('task_cancelled')
  console.log(`act 6 task.cancelled: ${cancelledEvents.map(describeEvent).join('; ')}`)
  if (cancelledEvents.length !== 1 || cancelledEvents[0].taskId !== polishTask.id) {
    await fail(`act 6 appended ${String(cancelledEvents.length)} task.cancelled events, expected one for polish`)
  }
  // The TASK's own stamp -- the requirement whose work was dropped -- not the version that dropped it.
  if (cancelledEvents[0].payload.goalVersion !== 1) {
    await fail(`act 6's task.cancelled says goalVersion ${String(cancelledEvents[0].payload.goalVersion)}, expected the task's own 1`)
  }
  if (cancelledEvents[0].actor !== 'human') await fail(`act 6's task.cancelled says actor ${cancelledEvents[0].actor}, expected human`)
  const appliedEvents = await eventsOfType('supervisor_applied')
  if (!appliedEvents.some((event) => event.payload.decisionId === cancelProposal.id)) {
    await fail(`act 6 cancelled the task without recording which decision did it: ${appliedEvents.map(describeEvent).join('; ')}`)
  }

  // ...and the operator finishes the job on the work that DID survive. Safe with no daemon running,
  // and safe from unblocking anything: the only dependent of api is the task just cancelled.
  await mergeAndConfirm('act 6', apiDone)
  console.log('act 6 complete: a person approved the cancellation, the dropped work went off the board carrying the requirement it came from, and the work that survived is on main')

  // ================= Act 7: with nothing running, every surface has to agree ======================

  const stillRunning = findRealDaemonPids()
  console.log(`act 7 orchestrator daemons on this host: ${JSON.stringify(stillRunning)}`)
  if (stillRunning.length > 0) await fail(`act 7 is taking its readings while a daemon is alive: ${JSON.stringify(stillRunning)}`)

  // ---- the board --------------------------------------------------------------------------------
  const finalBoard = await board()
  console.log(`act 7 board (${String(finalBoard.length)}):\n  ${finalBoard.map(describeTask).join('\n  ')}`)
  const expectedBoard = [
    { title: CORE_TITLE, status: 'done', goalVersion: 1, integrated: true },
    { title: API_TITLE, status: 'done', goalVersion: 1, integrated: true },
    { title: POLISH_TITLE, status: 'cancelled', goalVersion: 1, integrated: false },
    { title: ADDED_TITLE, status: 'ready', goalVersion: 2, integrated: false },
  ]
  if (finalBoard.length !== expectedBoard.length) await fail(`act 7's board holds ${String(finalBoard.length)} tasks, expected ${String(expectedBoard.length)}`)
  for (const expected of expectedBoard) {
    const row = finalBoard.find((task) => task.title === expected.title)
    if (row === undefined) await fail(`act 7's board has no task titled ${JSON.stringify(expected.title)}`)
    if (row.status !== expected.status || row.goalVersion !== expected.goalVersion || (row.integratedAt !== null) !== expected.integrated) {
      await fail(`act 7's ${JSON.stringify(expected.title)} reads ${describeTask(row)} integratedAt ${JSON.stringify(row.integratedAt)}, expected ${JSON.stringify(expected)}`)
    }
  }

  // ---- the stale badge, as a COUNT (erratum E8) --------------------------------------------------
  const finalWorld = await loadSupervisorWorld(workspaceId, new Date())
  const finalReport = summarise(finalWorld.world)
  const finalWorkspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
  console.log(`act 7 report.next: ${JSON.stringify(finalReport.next)}; workspace.goalVersion ${String(finalWorkspace.goalVersion)}`)
  if (finalWorkspace.goalVersion !== 2) await fail(`act 7's workspace is on goal v${String(finalWorkspace.goalVersion)}, expected 2`)
  // Nothing is stale: the two v1 tasks that survived are `done` and the third is `cancelled`, and a
  // terminal task is never behind its requirement.
  if (finalReport.next.stale !== 0) await fail(`act 7's stale count is ${String(finalReport.next.stale)}, expected 0`)
  if (finalReport.next.ready !== 1 || finalReport.next.running !== 0 || finalReport.next.waiting !== 0 || finalReport.next.blocked !== 0) {
    await fail(`act 7's report.next is ${JSON.stringify(finalReport.next)}, expected exactly one ready task and nothing else moving`)
  }
  if (finalReport.done.integrated !== 2 || finalReport.done.awaitingIntegration !== 0) {
    await fail(`act 7's report.done is ${JSON.stringify(finalReport.done)}, expected two integrated and none waiting`)
  }
  if (finalReport.stuck.length !== 0) await fail(`act 7 leaves ${String(finalReport.stuck.length)} situation(s) stuck: ${JSON.stringify(finalReport.stuck)}`)

  // ---- the Supervisor ---------------------------------------------------------------------------
  const decisionsOutput = runCli(['supervisor-decisions', '--workspace', workspaceId])
  console.log(`act 7 supervisor-decisions printed:\n${decisionsOutput}`)
  const decisions = JSON.parse(decisionsOutput)
  if (decisions.length !== 2) await fail(`act 7's decision history has ${String(decisions.length)} rows, expected exactly two`)
  const byKind = Object.fromEntries(decisions.map((row) => [row.situationKind, row]))
  if (byKind.unanswerable_question?.status !== 'applied') await fail(`act 7's answer decision is ${String(byKind.unanswerable_question?.status)}, expected applied`)
  if (byKind.stale_task?.status !== 'approved') await fail(`act 7's cancellation decision is ${String(byKind.stale_task?.status)}, expected approved`)
  const pendingOutput = JSON.parse(runCli(['supervisor-decisions', '--workspace', workspaceId, '--pending']))
  console.log(`act 7 pending decisions: ${JSON.stringify(pendingOutput)}`)
  if (pendingOutput.length !== 0) await fail(`act 7 leaves ${String(pendingOutput.length)} decision(s) waiting on a human`)
  // Erratum E6: `applied` counts the ONE the Supervisor carried out itself; the approved one is
  // `approved`, and neither is an escalation or a failure.
  console.log(`act 7 report.supervisor: ${JSON.stringify(finalReport.supervisor)}`)
  if (finalReport.supervisor.applied !== 1 || finalReport.supervisor.pending !== 0 || finalReport.supervisor.escalated !== 0 || finalReport.supervisor.failed !== 0) {
    await fail(`act 7's report.supervisor is ${JSON.stringify(finalReport.supervisor)}, expected one applied and nothing pending, escalated or failed`)
  }
  // The other half of `buildSupervisorView` (ruling R6): the CLI and the panel read one list.
  const viaControl = await listDecisions(workspaceId)
  if (JSON.stringify(viaControl) !== JSON.stringify(decisions)) {
    await fail(`act 7: listDecisions and \`supervisor-decisions\` disagree:\n  ${JSON.stringify(viaControl)}\n  ${decisionsOutput}`)
  }
  const settings = await supervisorSettings(workspaceId)
  console.log(`act 7 supervisor settings: ${JSON.stringify(settings)}`)
  if (settings === null || settings.enabled !== true) await fail(`act 7's Supervisor settings read ${JSON.stringify(settings)}, expected it enabled`)

  // ---- the mailbox ------------------------------------------------------------------------------
  const messagesOutput = runCli(['messages', '--workspace', workspaceId])
  console.log(`act 7 messages printed:\n${messagesOutput}`)
  // `messages` lists PENDING questions -- the ones a slave is still waiting on. This one was
  // answered, so the honest end state is that nobody is waiting.
  if (!messagesOutput.includes('no slave is waiting on an answer')) {
    await fail(`act 7's \`messages\` still shows somebody waiting:\n${messagesOutput}`)
  }
  const pendingQuestions = await listPendingQuestions(workspaceId)
  if (!pendingQuestions.ok || pendingQuestions.value.length !== 0) await fail(`act 7's pending questions: ${JSON.stringify(pendingQuestions)}`)
  const thread = await prisma.slaveMessage.findMany({ where: { workspaceId, threadId: question.threadId }, orderBy: { seq: 'asc' } })
  console.log(`act 7 the whole thread (${String(thread.length)}):\n  ${thread.map(describeMessage).join('\n  ')}`)
  if (thread.length !== 2) await fail(`act 7's thread is ${String(thread.length)} messages long, expected the question and its answer`)
  if (thread[0].kind !== 'question' || thread[1].kind !== 'answer') await fail(`act 7's thread reads ${JSON.stringify(thread.map((row) => row.kind))}, expected question then answer`)
  console.log(`act 7 report.mailbox: ${JSON.stringify(finalReport.mailbox)}`)
  if (finalReport.mailbox.pendingQuestions !== 0 || finalReport.mailbox.draftsAwaiting !== 0 || finalReport.mailbox.answeredBySupervisor24h !== 1) {
    await fail(`act 7's report.mailbox is ${JSON.stringify(finalReport.mailbox)}, expected nothing waiting and one answer sent`)
  }

  // ---- the spend --------------------------------------------------------------------------------
  const fullTable = [
    ...partialTable,
    { kind: 'planning run (the re-plan)', count: 1, unitUsd: fixtureCostUsd('replan-delta') },
    { kind: 'supervisor decision: the cancellation proposal (the re-plan run already paid; no model here)', count: 1, unitUsd: 0 },
  ]
  const fullTotal = printTable("act 7 the whole story's spend", fullTable)
  const runsByKind = await prisma.slaveRun.groupBy({ by: ['kind'], where: { slave: { team: { workspaceId } } }, _count: { _all: true } })
  console.log(`act 7 runs by kind: ${JSON.stringify(runsByKind)}`)
  const countOfKind = (kind) => runsByKind.find((row) => row.kind === kind)?._count._all ?? 0
  // Asserted BEFORE the total, so a run this story did not intend -- a duplicated plan, a second
  // implementation attempt -- fails here with a diagnosis rather than as an unexplained dollar
  // figure.
  if (countOfKind('planning') !== 2 || countOfKind('implementation') !== 2 || countOfKind('review') !== 2) {
    await fail(`act 7 counted ${JSON.stringify(runsByKind)}, expected 2 planning (a plan and a re-plan), 2 implementation and 2 review runs`)
  }
  const finalSpend = await workspaceSpend(workspaceId)
  const finalStats = await workspaceStats(workspaceId)
  console.log(`act 7 workspaceSpend: ${JSON.stringify(finalSpend)}`)
  console.log(`act 7 workspaceStats.stats: ${JSON.stringify(finalStats.stats)}`)
  if (!sameMoney(finalSpend.spentUsd, fullTotal)) await fail(`act 7's workspaceSpend says $${String(finalSpend.spentUsd)}, the table says $${String(fullTotal)}`)
  if (finalSpend.supervisorUnmeasuredCalls !== 0) await fail(`act 7 charged ${String(finalSpend.supervisorUnmeasuredCalls)} Supervisor call(s) at the cap`)
  // Erratum E7: `workspaceStats` carries no task counts. What it does carry is the ONE spend
  // formula every guardrail evaluates, and it has to be the same number.
  if (!sameMoney(finalStats.stats.spentUsd, finalSpend.spentUsd)) await fail('act 7: workspaceStats and workspaceSpend disagree about what this project spent')
  if (finalStats.stats.activeRuns !== 0 || finalStats.stats.consecutiveFailures !== 0 || finalStats.stats.emergencyStopped !== false) {
    await fail(`act 7's stats read ${JSON.stringify(finalStats.stats)}, expected an idle, unbroken, unhalted project`)
  }

  // ---- the event log ----------------------------------------------------------------------------
  const allEvents = await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  const census = new Map()
  for (const event of allEvents) census.set(event.type, (census.get(event.type) ?? 0) + 1)
  console.log(`act 7 event census (${String(allEvents.length)} events):`)
  for (const [type, count] of [...census].sort()) console.log(`  ${String(count).padStart(3)}  ${type}`)
  // Only the load-bearing ones are asserted. The rest are printed so a change in them is READABLE
  // in the log of a passing run rather than invisible until something else breaks.
  const expectedCounts = {
    workspace_goal_set: 2,
    workspace_plan_created: 1,
    workspace_replan_started: 1,
    workspace_replanned: 1,
    task_created: 4,
    task_cancelled: 1,
    task_integrated: 2,
    task_done: 2,
    slave_message_sent: 2,
    run_paused: 1,
    run_resumed: 1,
    run_failed: 0,
    // Erratum E5: the Supervisor's events are `supervisor.decided`/`proposed`/`applied`/`resolved`/
    // `failed`. Two decisions were recorded; one of them was a proposal; one was applied by the
    // machine and one by a person's approval; one was resolved by that person.
    supervisor_decided: 2,
    supervisor_proposed: 1,
    supervisor_applied: 2,
    supervisor_resolved: 1,
    supervisor_failed: 0,
    slave_runtime_roles_changed: 1,
    // The whole story ran inside its guardrails: nothing tripped, and the budget was never warned
    // about.
    guardrail_tripped: 0,
  }
  for (const [type, expected] of Object.entries(expectedCounts)) {
    const actual = census.get(type) ?? 0
    if (actual !== expected) await fail(`act 7 counted ${String(actual)} ${type} event(s), expected ${String(expected)}`)
  }

  // ---- the CLI's own last word ------------------------------------------------------------------
  const statusOutput = runCli(['status', '--workspace', workspaceId])
  console.log(`act 7 status printed:\n${statusOutput}`)
  const status = JSON.parse(statusOutput)
  if (status.halt !== null) await fail(`act 7's status reports a halt: ${JSON.stringify(status.halt)}`)
  if (status.archived !== null) await fail(`act 7's status reports the project archived: ${String(status.archived)}`)
  if (status.runs.length !== 0) await fail(`act 7's status still lists ${String(status.runs.length)} live run(s): ${JSON.stringify(status.runs)}`)

  const contextOutput = runCli(['show-context', '--run', replanRunId, '--prompt'])
  console.log(`act 7 show-context on the re-plan run printed:\n${contextOutput}`)
  if (!contextOutput.includes('"kind": "replan"')) await fail("act 7: show-context does not render the re-plan run's replan section")
  if (!contextOutput.includes('THE GOAL CHANGED')) await fail('act 7: show-context does not print the prompt the re-plan was given')

  const finalReplanStatus = JSON.parse(runCli(['replan-status', '--workspace', workspaceId]))
  console.log(`act 7 replan-status: ${JSON.stringify(finalReplanStatus)}`)
  if (finalReplanStatus.willReplan !== false || finalReplanStatus.boardVersion !== 2) {
    await fail(`act 7's replan-status reads ${JSON.stringify(finalReplanStatus)}, expected a board that has caught up to v2 with no further re-plan due`)
  }
  // Re-typing the requirement it already has is not an edit -- the last thing an operator is likely
  // to do by accident, and the last thing this story proves.
  const unchanged = runCliRaw(['set-goal', '--workspace', workspaceId, '--goal', GOAL_V2])
  console.log(`act 7 set-goal (same text) exit ${String(unchanged.status)}, stderr ${JSON.stringify(unchanged.stderr)}`)
  if (unchanged.status === 0) await fail('act 7: setting the goal to the text it already reads exited 0')
  if ((await prisma.goalVersion.count({ where: { workspaceId } })) !== 2) await fail('act 7: the refused set-goal wrote a third version')

  console.log(
    'PASS: one requirement became a plan, a worker took the first task and stopped to ask a question nobody in the company could ' +
      "answer, the Supervisor answered it from a sentence in the worker's own task and woke it up, two tasks were verified, " +
      'reviewed by a slave that wrote neither of them and merged onto main by a person, a changed requirement produced a delta ' +
      're-plan that added work and only PROPOSED a cancellation, a human approved it -- and with nothing running, the board, the ' +
      'goal history, the Supervisor, the mailbox, the spend and the event log all tell the same story',
  )
  exitCode = 0
} finally {
  // Every daemon this gate ever spawned, whichever exit path got here.
  for (const state of daemons) {
    if (state.proc.exitCode === null && !state.exited) {
      state.proc.kill('SIGTERM')
      const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
      while (!state.exited && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
      if (!state.exited) state.proc.kill('SIGKILL')
    }
  }
  // ...and a last sweep for one that outlived its own `state`: a daemon killed with SIGKILL while
  // it was mid-spawn can leave the child this gate started behind, and a stray daemon is exactly
  // what this gate refuses to START next to. Only pids this gate itself spawned are killed --
  // somebody else's daemon is not this script's to stop.
  const ourPids = new Set(daemons.map((state) => state.proc.pid).filter((pid) => pid !== undefined))
  for (const pid of findRealDaemonPids()) {
    if (!ourPids.has(pid)) continue
    console.warn(`teardown: a daemon this gate spawned (pid ${String(pid)}) is still alive -- killing it`)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
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
    await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    // Cascades Team/Slave/Task/SlaveRun/RunContext/TaskDependency/GoalVersion/SlaveMessage and
    // SupervisorDecision.
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  // The last two are the only statements left in this block that can throw, and a throw HERE is the
  // worst kind (fix round 1, minor 5): out of a `finally` it replaces whatever the `try` was failing
  // with -- the gate's own diagnosis, row dump and all -- and on the success path it would skip
  // `process.exit(exitCode)` below and leave the process to exit on an unhandled rejection instead
  // of on the 0 the story earned. A temp directory that would not delete and a Prisma client that
  // would not close are both worth SAYING and neither is worth losing the run's verdict over.
  if (repoPath !== null) {
    try {
      rmSync(repoPath, { recursive: true, force: true })
    } catch (error) {
      console.error(`teardown: could not remove the temporary repository ${repoPath}: ${String(error)}`)
    }
  }
  try {
    await prisma.$disconnect()
  } catch (error) {
    console.error(`teardown: Prisma would not disconnect cleanly: ${String(error)}`)
  }
}

process.exit(exitCode)
