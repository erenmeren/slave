// M40's own gate (Task 5 brief): proves the milestone's central claim end to end, against a REAL
// daemon and the FAKE `claude` CLI -- the workspace goal is a VERSIONED requirement, every planned
// task carries the version it was derived from, and changing the goal on a board that already has
// tasks runs a DELTA re-plan whose additions land at once and whose cancellations are proposals a
// human approves.
//
// NEVER A MODEL CALL. Every daemon here is spawned with `SLAVEOFAI_CLAUDE_BIN=node`,
// `SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m8-flow [--replan-cancel <id>]"` and
// `SLAVEOFAI_REQUIRE_FAKE_CLI=1` (M32 item 7: lose the first two and the daemon refuses to start
// rather than falling back to the real binary) -- the same wiring `gate-m8-plan.mjs` and
// `gate-m39-supervisor-mailbox.mjs` use. `m8-flow`'s planning arms are two files on disk: a prompt
// containing `"replan"` (which `REPLAN_INSTRUCTIONS` always emits, checked BEFORE `"task graph"`)
// replays `fixtures/replan-delta.ndjson`, and any other planning prompt replays `plan-graph`.
//
// WHY THE CANCEL TARGET NEEDS A SECOND DAEMON. The delta fixture cannot carry the id it asks to
// cancel: that id is a row the FIRST plan created, minutes after the file was written. `replanArm`
// substitutes `$CANCEL_ID` from `--replan-cancel <id>` in ARGV (erratum E3/E6 -- argv reaches the
// scrubbed decision child, an environment variable does not), so the gate runs stage 1 under
// daemon-1, stops it, reads the id of the task the first plan created, and spawns daemon-2 with
// that id on its command line.
//
// WHY NOTHING IS EVER DISPATCHED. The fake plan's three tasks are all `backend` and the workspace
// holds exactly ONE slave -- Atlas, `runtimeRoles: ['manager']` -- so the scheduler can staff a
// planning run and nothing else. The board therefore sits still at `ready` for the whole gate,
// which is what makes every count in it a measurement rather than a race with the pipeline. The
// Supervisor will keep noticing `ready_unstaffed` and proposing `set_runtime_roles`; those
// proposals are `proposed` on every branch (`tierOf`), so they change nothing, and every assertion
// below filters the decision table by `situationKind`.
//
// WHY DAEMON-1 IS STOPPED BEFORE THE GOAL MOVES (a correction to the brief's stage ordering). A
// re-plan fires on the first tick after `setGoal`, and daemon-1 carries NO `--replan-cancel`, so a
// daemon left running across the v2 set would run the re-plan itself with an empty `cancel` list --
// and the one-re-plan-per-version dedup would then refuse daemon-2's. Stage 1 therefore ends by
// stopping daemon-1, and every stage-2 read (`goal-history`, `replan-status`) is taken with no
// daemon running at all, which is also what makes `willReplan true, blockedBy null` a fact about
// the version rather than about the millisecond.
//
// STAGES
//   1. A goal has a version, and a plan is stamped with it. `set-goal` prints `{version:1,sha256}`;
//      the first plan lands three tasks, all `goalVersion 1`; the v1 `GoalVersion` row's text and
//      hash ARE `Workspace.goal`; `workspace.plan_created` and every `task.created` carry version
//      1; and the planning run's recorded manifest says `planning_goal.version 1` with no `replan`
//      section. (This is the backfill proof the brief asks for: the migration has already run on
//      this database, so a pre-M40 workspace cannot be hand-seeded any more -- what is provable
//      instead is that the version a task is stamped with is the version of the goal text that
//      produced it.)
//   2. Changing the goal re-plans the DELTA. `set-goal` v2 prints version 2; `goal-history` prints
//      v2 before v1 with the line diff between them; `replan-status` says the next tick will
//      re-plan and names nothing in the way. Daemon-2, carrying the core task's id, starts a run
//      whose manifest has a `replan` section (v1 -> v2, the board it was read against) and whose
//      prompt carries the re-plan trailer and both goal texts; `workspace.replan_started` marks it.
//      On conclusion: ONE new task, `ready` and stamped `goalVersion 2`; ONE pending `stale_task`
//      proposal to cancel core; `workspace.replanned` naming all four lists; and core STILL `ready`
//      -- a cancellation is a proposal, not a deletion (ruling R1). `replan-status` then says no
//      further re-plan is coming for this version.
//   3. Approving the proposal cancels the task, and a dependent stays blocked. `approve-decision`
//      turns core `cancelled` with `task.cancelled { goalVersion: 1 }`; `api`, which depends on it,
//      still reports `dependenciesDone: false` through the ORCHESTRATOR'S OWN `loadWorld` -- the
//      snapshot the scheduler decides from -- its `TaskDependency` row survives, and two further
//      ticks start nothing: not an implementation run (ruling R3: cancelled work was never done)
//      and not a PLANNING run either, because the goal has not moved since v2 and a board that has
//      caught up with its requirement is never re-planned again (erratum E8). Then the human's own
//      `cancel-task` takes `api` off the board too.
//   4. The same words are not a new version. `set-goal` with the v2 text byte for byte exits
//      NON-ZERO naming version 2, and leaves the history at two rows with no third `goal_set`.
//   5. The prompt a re-plan would get can be read without starting one (ruling R4). A third goal
//      version makes a re-plan pending again; `replan-status --prompt` renders the prompt that run
//      would be given -- the re-plan trailer and both ends of the move -- and the `RunContext`
//      table is exactly as large afterwards as it was before, because nothing was dispatched.
//
// Shape borrowed from `gate-m39-supervisor-mailbox.mjs` (temp git repo + `prisma.workspace.create`
// setup, `preflightCleanup()`/`dumpGateRows()`/`fail()`/`waitUntil()`, the daemon lifecycle and its
// `findRealDaemonPids()` refusal, "print every measured value before asserting it", real CLI
// subprocesses through `execFileSync('node', [cliPath, ...])` with `loopbackChildEnv()`, `exitCode`
// starting at 1 and set to 0 only at the very end, teardown in FK order) and from
// `gate-m8-plan.mjs` for seeding the goal through the real CLI and polling for the plan to land.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids } from './lib/daemon-process.mjs'
import { prisma } from '../packages/db/dist/client.js'
import { isAlive } from '../packages/control/dist/index.js'
import { NON_TERMINAL_RUN_STATUSES, goalSha256, runContextManifestSchema } from '../packages/domain/dist/index.js'
import { loadWorld } from '../apps/orchestrator/dist/index.js'

const POLL_INTERVAL_MS = 50
const DAEMON_PERIOD_MS = 500
// Generous, and every one of them bounds real work: a planning dispatch, a fake CLI replay, a
// conclusion that writes a transaction's worth of rows. Tuned to "a slow machine still passes".
const PLAN_TIMEOUT_MS = 180_000
const REPLAN_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

// An exact literal, never suffixed -- `preflightCleanup` removes whatever a prior crashed run left
// on this exact name, in the same FK order the `finally` block uses.
const WORKSPACE_NAME = 'M40 Gate Project'

/** The three requirements this gate sets, in order. Each is ONE line, which is what makes the
 *  `goal-history` diff assertion exact: `goalDiff` is a set difference over trimmed non-blank
 *  lines, so a one-line edit is one addition and one removal and nothing else. */
const GOAL_V1 = 'Ship the M40 gate feature: a core module, an API on top of it, and the polish around it.'
const GOAL_V2 = 'Ship the M40 gate feature and document the new endpoint for the people who will call it.'
const GOAL_V3 = 'Ship the M40 gate feature, document the new endpoint, and write the migration guide.'

/** What `fixtures/plan-graph.ndjson` returns, and therefore what the FIRST plan must produce. */
const PLAN_TITLES = ['Write the feature core', 'Expose the API', 'Document and polish']
const CORE_TITLE = 'Write the feature core'
const API_TITLE = 'Expose the API'
/** What `fixtures/replan-delta.ndjson` adds. */
const ADDED_TITLE = 'Document the new endpoint'

/** Same as `gate-m8-plan.mjs`'s -- a real repository, because the tick provisions a real worktree
 *  in it regardless of which CLI it spawns. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m40-repo-'))
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
 *  RunContext/GoalVersion/TaskDependency and SupervisorDecision. This gate creates no org rows and
 *  no skill rows, so there is nothing else of its own anywhere in the database. */
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
  return JSON.stringify({ workspace, events, decisions, dependencies, daemonTails }, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

/** The `gate-m35`/`gate-m38`/`gate-m39` diagnostic throw: an Error carrying the state that made the
 *  call, not just the sentence that noticed. */
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

/** A decision row as this gate prints it. */
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
    situation: row.situation,
    rationale: row.rationale,
    failureReason: row.failureReason,
  })

/** An event as this gate prints it, `seq` stringified (it is a BigInt). */
const describeEvent = (row) =>
  JSON.stringify({ seq: String(row.seq), type: row.type, actor: row.actor, taskId: row.taskId, payload: row.payload })

try {
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`orchestrator CLI not built at ${ORCHESTRATOR_CLI} -- run tsc --build first`)
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)

  // Refused rather than tolerated (`gate-m36`/`gate-m38`/`gate-m39`'s own refusal): this gate spawns
  // and stops daemons of its own and counts exactly what one planning pass wrote, and a second
  // daemon somebody else left running would be ticking other workspaces -- and holding the global
  // concurrency budget this one's runs need.
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m40-requirement-versioning REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate starts and stops daemons of its own and measures exactly what one planning pass wrote',
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
      autoMerge: false,
      verifyCommands: ['true'],
      setupCommands: [],
      maxAttempts: 5,
    },
  })
  workspaceId = workspace.id
  console.log(
    `workspace ${workspaceId} (${WORKSPACE_NAME}), repo ${repoPath}, goal ${JSON.stringify(workspace.goal)}, ` +
      `goalVersion ${String(workspace.goalVersion)}`,
  )
  // A brand-new workspace has never had a requirement: version 0 is "no version was ever recorded",
  // and every stage below counts from it.
  if (workspace.goalVersion !== 0) await fail(`a new workspace starts at goalVersion ${String(workspace.goalVersion)}, expected 0`)

  // Without this row every dispatch refuses with `invalid_provider` (M12 Task 8) and nothing runs.
  await prisma.providerConfiguration.create({ data: { workspaceId, kind: 'claude_code', settings: {} } })

  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  // The ONLY slave. It can be staffed as a manager (planning) and as nothing else, and the fake
  // plan's tasks are all `backend`, so the board this gate measures never moves under it.
  const atlas = await prisma.slave.create({
    data: { teamId: team.id, name: 'Atlas', role: 'Engineering Manager', runtimeRoles: ['manager'] },
  })
  console.log(`slaves: Atlas ${atlas.id} runtimeRoles ${JSON.stringify(atlas.runtimeRoles)} -- nobody holds "backend"`)

  /**
   * The environment a child of this gate gets: the fake CLI, the refusal that guards it, and -- for
   * daemon-2 -- the id its `"replan"` arm substitutes into the delta fixture.
   *
   * `--replan-cancel` rides on `SLAVEOFAI_CLAUDE_ARGS`, i.e. on ARGV, not on an environment
   * variable (errata E3/E6): the fake CLI reads it out of `process.argv`, and `decisionArgs` puts
   * the extra args first, which is already how `--fixture` arrives.
   */
  const childEnv = ({ replanCancelTaskId } = {}) =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS:
        `${FAKE_CLAUDE} --fixture m8-flow` +
        (replanCancelTaskId === undefined ? '' : ` --replan-cancel ${replanCancelTaskId}`),
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
    })

  /** Runs the real orchestrator CLI as a subprocess, exactly as an operator's shell would, and
   *  throws on a non-zero exit. */
  const runCli = (args) =>
    execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
      cwd: repoRoot,
      env: childEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  /** The same, for a command whose REFUSAL is the measurement: the exit status and both streams,
   *  never a throw. */
  const runCliRaw = (args) =>
    spawnSync('node', [ORCHESTRATOR_CLI, ...args], {
      cwd: repoRoot,
      env: childEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

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

  /** Stops a daemon and waits for the process to really be gone, so a stage that counts rows is
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

  /** Every task on the board, oldest first -- the order the plan created them in. */
  const board = () => prisma.task.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })

  /** One section of a recorded manifest, by kind -- the manifest is an ordered array, and every
   *  kind this gate asks about appears at most once (`gate-m37`'s own helper). */
  const sourceOfKind = (manifest, kind) => manifest.sections.find((section) => section.kind === kind)

  /** How many `RunContext` rows this workspace's runs have written. Stage 5's measurement: a
   *  PREVIEW must not add one (ruling R4). */
  const runContextCount = () => prisma.runContext.count({ where: { run: { slave: { team: { workspaceId } } } } })

  /** Every event of one type, oldest first. */
  const eventsOfType = (type) =>
    prisma.executionEvent.findMany({ where: { workspaceId, type }, orderBy: { seq: 'asc' } })

  /**
   * Waits until no planning run is in flight.
   *
   * A daemon whose tick read an EMPTY board milliseconds before `concludePlanning` committed one
   * dispatches a second first-plan run that then drops its own graph ("the board already has 3
   * tasks") -- ordinary, harmless, and still a LIVE planning run for as long as it lasts. Every
   * `replan-status` this gate takes is a claim about the version rather than about the millisecond,
   * and `livePlanningRun` is exactly the fact that would make it one about the millisecond.
   */
  const quiescePlanning = () =>
    waitUntil('every planning run to finish', PLAN_TIMEOUT_MS, async (note) => {
      const live = await prisma.slaveRun.count({
        where: { kind: 'planning', status: { in: [...NON_TERMINAL_RUN_STATUSES] }, slave: { team: { workspaceId } } },
      })
      note(`${String(live)} planning run(s) still in flight`)
      return live === 0 ? true : null
    })

  // ================= Stage 1: a goal has a version, and a plan is stamped with it ==================

  const setV1 = runCli(['set-goal', '--workspace', workspaceId, '--goal', GOAL_V1])
  console.log(`stage 1 set-goal printed: ${JSON.stringify(setV1.trim())}`)
  const v1Printed = JSON.parse(setV1)
  if (v1Printed.version !== 1) await fail(`stage 1's set-goal printed version ${String(v1Printed.version)}, expected 1`)
  // The hash the CLI prints is the hash of the text an operator typed, computed by the one function
  // the migration's backfill and the run-context builder also use.
  if (v1Printed.sha256 !== goalSha256(GOAL_V1)) {
    await fail(`stage 1's set-goal printed sha256 ${String(v1Printed.sha256)}, expected ${goalSha256(GOAL_V1)}`)
  }

  const v1Rows = await prisma.goalVersion.findMany({ where: { workspaceId }, orderBy: { version: 'asc' } })
  const afterV1 = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
  console.log(`stage 1 GoalVersion rows: ${JSON.stringify(v1Rows)}`)
  console.log(`stage 1 workspace: goal ${JSON.stringify(afterV1.goal)}, goalVersion ${String(afterV1.goalVersion)}`)
  if (v1Rows.length !== 1) await fail(`stage 1 wrote ${String(v1Rows.length)} GoalVersion rows, expected exactly one`)
  if (v1Rows[0].version !== 1) await fail(`stage 1's only GoalVersion row is version ${String(v1Rows[0].version)}, expected 1`)
  // The backfill proof the brief asks for, in the only shape still reachable now that the migration
  // has run: the version row IS the goal the workspace is carrying, text and hash.
  if (v1Rows[0].text !== GOAL_V1) await fail(`stage 1's v1 row reads ${JSON.stringify(v1Rows[0].text)}, expected the goal that was set`)
  if (v1Rows[0].text !== afterV1.goal) {
    await fail(`stage 1's v1 row and Workspace.goal disagree: ${JSON.stringify(v1Rows[0].text)} vs ${JSON.stringify(afterV1.goal)}`)
  }
  if (v1Rows[0].sha256 !== goalSha256(GOAL_V1)) {
    await fail(`stage 1's v1 row records sha256 ${v1Rows[0].sha256}, expected ${goalSha256(GOAL_V1)}`)
  }
  if (afterV1.goalVersion !== 1) await fail(`stage 1 left Workspace.goalVersion at ${String(afterV1.goalVersion)}, expected 1`)

  const goalSetV1 = await eventsOfType('workspace_goal_set')
  console.log(`stage 1 workspace.goal_set events (${String(goalSetV1.length)}): ${goalSetV1.map(describeEvent).join('\n  ')}`)
  if (goalSetV1.length !== 1) await fail(`stage 1 appended ${String(goalSetV1.length)} workspace.goal_set events, expected one`)
  if (goalSetV1[0].payload.version !== 1 || goalSetV1[0].payload.sha256 !== goalSha256(GOAL_V1)) {
    await fail(`stage 1's workspace.goal_set payload is ${JSON.stringify(goalSetV1[0].payload)}, expected version 1 with the goal's sha`)
  }

  const daemon1 = spawnDaemon('daemon-1')

  // Waited on the EVENT rather than on the board. `concludePlanning` creates the whole graph in one
  // transaction and appends `workspace.plan_created` after it commits, so a gate that polled the
  // board would routinely catch a board that is already complete and a log that has not caught up
  // -- and then assert about the log.
  const planCreated = await waitUntil('the first plan to land', PLAN_TIMEOUT_MS, async (note) => {
    const rows = await eventsOfType('workspace_plan_created')
    note(`${String(rows.length)} workspace.plan_created event(s) so far`)
    return rows.length === 0 ? null : rows
  })
  const planned = await board()
  console.log(`stage 1 board (${String(planned.length)}):\n  ${planned.map(describeTask).join('\n  ')}`)
  if (planned.length !== PLAN_TITLES.length) {
    await fail(`stage 1's plan produced ${String(planned.length)} tasks, expected ${String(PLAN_TITLES.length)}`)
  }
  for (const title of PLAN_TITLES) {
    if (!planned.some((task) => task.title === title)) await fail(`stage 1's plan has no task titled ${JSON.stringify(title)}`)
  }
  for (const task of planned) {
    if (task.goalVersion !== 1) {
      await fail(`stage 1's task ${JSON.stringify(task.title)} is stamped goalVersion ${String(task.goalVersion)}, expected 1`)
    }
    if (task.status !== 'ready') {
      await fail(`stage 1's task ${JSON.stringify(task.title)} is ${task.status}, expected ready -- nobody holds "backend", so nothing may move it`)
    }
  }
  const coreTask = planned.find((task) => task.title === CORE_TITLE)
  const apiTask = planned.find((task) => task.title === API_TITLE)

  console.log(`stage 1 workspace.plan_created (${String(planCreated.length)}): ${planCreated.map(describeEvent).join('\n  ')}`)
  if (planCreated.length !== 1) await fail(`stage 1 appended ${String(planCreated.length)} workspace.plan_created events, expected one`)
  if (planCreated[0].payload.goalVersion !== 1) {
    await fail(`stage 1's workspace.plan_created says goalVersion ${String(planCreated[0].payload.goalVersion)}, expected 1`)
  }
  const createdEvents = await eventsOfType('task_created')
  console.log(`stage 1 task.created (${String(createdEvents.length)}): ${createdEvents.map(describeEvent).join('\n  ')}`)
  for (const event of createdEvents) {
    if (event.payload.goalVersion !== 1) {
      await fail(`stage 1's task.created for ${String(event.taskId)} says goalVersion ${String(event.payload.goalVersion)}, expected 1`)
    }
  }

  // The run the EVENT names, not "the oldest planning run": a daemon whose tick read the board a
  // moment before the plan committed dispatches a second first-plan run that drops its own graph,
  // and the manifest this stage is about belongs to the run that produced the board.
  const planningRun = await prisma.slaveRun.findUniqueOrThrow({
    where: { id: planCreated[0].runId },
    include: { context: true },
  })
  if (planningRun.context === null) await fail(`stage 1: the planning run ${planningRun.id} recorded no context at all`)
  const planManifest = runContextManifestSchema.parse(planningRun.context.sections)
  console.log(`stage 1 planning run ${planningRun.id} (${planningRun.status}) manifest: ${JSON.stringify(planManifest)}`)
  console.log(`stage 1 planning prompt (${String(planningRun.context.prompt.length)} chars):\n${planningRun.context.prompt}`)
  if (planManifest.kind !== 'planning') await fail(`stage 1's planning manifest says kind ${planManifest.kind}, expected planning`)
  const planGoalSource = sourceOfKind(planManifest, 'planning_goal')
  if (planGoalSource === undefined) await fail('stage 1: the planning manifest records no planning_goal section')
  if (planGoalSource.version !== 1) {
    await fail(`stage 1's planning_goal section says version ${String(planGoalSource.version)}, expected 1`)
  }
  if (planGoalSource.sha256 !== goalSha256(GOAL_V1)) {
    await fail(`stage 1's planning_goal section hashes ${planGoalSource.sha256}, expected the v1 goal's ${goalSha256(GOAL_V1)}`)
  }
  // A FIRST plan, not a delta: the absence of this section is what `concludePlanning` routes on
  // (erratum E4), so its absence here is what says stage 2's presence means something.
  if (sourceOfKind(planManifest, 'replan') !== undefined) {
    await fail('stage 1: the FIRST planning run recorded a replan section -- it had no previous version to diff against')
  }
  if (!planningRun.context.prompt.includes(GOAL_V1)) {
    await fail('stage 1: the planning prompt does not carry the goal text the plan was derived from')
  }

  // Quiesced while the daemon is still alive to conclude what it started (see `quiescePlanning`),
  // and only then stopped -- BEFORE the goal moves. Daemon-1 carries no `--replan-cancel`, so a
  // re-plan it ran would ask to cancel nothing, and the one-per-version dedup would then refuse
  // daemon-2's.
  await quiescePlanning()
  await stopDaemon(daemon1)
  console.log(
    'stage 1 complete: an operator set a requirement, it became version 1 with a hash, and every task the plan produced ' +
      'carries the version of the goal that produced it -- as does the run that was asked for the plan',
  )

  // ================= Stage 2: changing the goal re-plans the DELTA ================================

  const setV2 = runCli(['set-goal', '--workspace', workspaceId, '--goal', GOAL_V2])
  console.log(`stage 2 set-goal printed: ${JSON.stringify(setV2.trim())}`)
  const v2Printed = JSON.parse(setV2)
  if (v2Printed.version !== 2) await fail(`stage 2's set-goal printed version ${String(v2Printed.version)}, expected 2`)
  if (v2Printed.sha256 !== goalSha256(GOAL_V2)) {
    await fail(`stage 2's set-goal printed sha256 ${String(v2Printed.sha256)}, expected ${goalSha256(GOAL_V2)}`)
  }

  const historyOutput = runCli(['goal-history', '--workspace', workspaceId])
  console.log(`stage 2 goal-history printed:\n${historyOutput}`)
  const history = JSON.parse(historyOutput)
  if (history.length !== 2) await fail(`stage 2's goal-history has ${String(history.length)} versions, expected 2`)
  // Newest first: the history is read the way a history is read, and each row's diff is against the
  // version it replaced -- the one BELOW it in the list.
  if (history[0].version !== 2 || history[1].version !== 1) {
    await fail(`stage 2's goal-history is ordered ${JSON.stringify(history.map((row) => row.version))}, expected [2, 1]`)
  }
  if (history[0].text !== GOAL_V2 || history[1].text !== GOAL_V1) {
    await fail(`stage 2's goal-history texts are ${JSON.stringify(history.map((row) => row.text))}, expected the two goals that were set`)
  }
  if (history[1].diff !== null) {
    await fail(`stage 2's v1 row carries a diff ${JSON.stringify(history[1].diff)} -- the first version replaced nothing`)
  }
  console.log(`stage 2 v2 diff: ${JSON.stringify(history[0].diff)}`)
  if (history[0].diff === null) await fail("stage 2's v2 row carries no diff against the version it replaced")
  if (!history[0].diff.added.includes(GOAL_V2) || !history[0].diff.removed.includes(GOAL_V1)) {
    await fail(`stage 2's v2 diff is ${JSON.stringify(history[0].diff)}, expected the new line added and the old one removed`)
  }

  const statusBefore = JSON.parse(runCli(['replan-status', '--workspace', workspaceId]))
  console.log(`stage 2 replan-status before the re-plan: ${JSON.stringify(statusBefore)}`)
  if (statusBefore.willReplan !== true) {
    await fail(`stage 2's replan-status says willReplan ${String(statusBefore.willReplan)} after the goal moved, expected true`)
  }
  // Nothing in the way: no halt, no archive, no live planning run, no earlier re-plan for this
  // version, no spent retries. Taken with NO daemon running, so it is a fact about the version.
  if (statusBefore.blockedBy !== null) {
    await fail(`stage 2's replan-status names ${JSON.stringify(statusBefore.blockedBy)} in the way, expected nothing`)
  }
  if (statusBefore.goalVersion !== 2 || statusBefore.boardVersion !== 1 || statusBefore.goalMoved !== true) {
    await fail(`stage 2's replan-status reads ${JSON.stringify(statusBefore)}, expected goal v2 over a board still at v1`)
  }
  if (statusBefore.intent === null || statusBefore.intent.previousVersion !== 1 || statusBefore.intent.version !== 2) {
    await fail(`stage 2's replan-status intent is ${JSON.stringify(statusBefore.intent)}, expected the move from 1 to 2`)
  }

  // The id the delta fixture's `$CANCEL_ID` becomes, on the command line of the daemon that will
  // run the re-plan (errata E3/E6). `core` deliberately: `api` depends on it, which is what makes
  // stage 3's ruling-R3 assertion possible.
  const daemon2 = spawnDaemon('daemon-2', { replanCancelTaskId: coreTask.id })

  const replanStarted = await waitUntil('the re-plan run to start', REPLAN_TIMEOUT_MS, async (note) => {
    const rows = await eventsOfType('workspace_replan_started')
    note(`${String(rows.length)} workspace.replan_started event(s) so far`)
    return rows.length === 0 ? null : rows
  })
  console.log(`stage 2 workspace.replan_started (${String(replanStarted.length)}): ${replanStarted.map(describeEvent).join('\n  ')}`)
  if (replanStarted.length !== 1) {
    await fail(`stage 2 started ${String(replanStarted.length)} re-plans, expected exactly one for this version`)
  }
  if (replanStarted[0].payload.version !== 2) {
    await fail(`stage 2's workspace.replan_started says version ${String(replanStarted[0].payload.version)}, expected 2`)
  }
  const replanRunId = replanStarted[0].payload.runId
  if (typeof replanRunId !== 'string') {
    await fail(`stage 2's workspace.replan_started names no run: ${JSON.stringify(replanStarted[0].payload)}`)
  }

  const replanContext = await waitUntil("the re-plan run's recorded context", REPLAN_TIMEOUT_MS, async (note) => {
    const row = await prisma.runContext.findUnique({ where: { runId: replanRunId } })
    note(row === null ? 'no RunContext row yet' : 'written')
    return row
  })
  const replanManifest = runContextManifestSchema.parse(replanContext.sections)
  console.log(`stage 2 re-plan run ${replanRunId} manifest: ${JSON.stringify(replanManifest)}`)
  console.log(`stage 2 re-plan prompt (${String(replanContext.prompt.length)} chars):\n${replanContext.prompt}`)
  const replanSource = sourceOfKind(replanManifest, 'replan')
  if (replanSource === undefined) {
    await fail('stage 2: the re-plan run recorded no replan section -- nothing would route it to concludeReplan (erratum E4)')
  }
  if (replanSource.previousVersion !== 1 || replanSource.version !== 2) {
    await fail(`stage 2's replan section moves ${String(replanSource.previousVersion)} -> ${String(replanSource.version)}, expected 1 -> 2`)
  }
  if (replanSource.previousSha256 !== goalSha256(GOAL_V1) || replanSource.sha256 !== goalSha256(GOAL_V2)) {
    await fail(`stage 2's replan section hashes ${JSON.stringify([replanSource.previousSha256, replanSource.sha256])}, expected the two goals' own`)
  }
  // The board the manager was SHOWN, recorded, so `workspace.replanned` can be checked against the
  // exact list of ids it was allowed to name.
  const shownBoard = [...replanSource.boardTaskIds].sort()
  const expectedBoard = planned.map((task) => task.id).sort()
  if (JSON.stringify(shownBoard) !== JSON.stringify(expectedBoard)) {
    await fail(`stage 2's replan section was read against ${JSON.stringify(shownBoard)}, expected the three planned tasks ${JSON.stringify(expectedBoard)}`)
  }
  const replanGoalSource = sourceOfKind(replanManifest, 'planning_goal')
  if (replanGoalSource === undefined || replanGoalSource.version !== 2) {
    await fail(`stage 2's re-plan planning_goal section is ${JSON.stringify(replanGoalSource)}, expected version 2`)
  }
  // The trailer `renderRunContext` chooses because a `replan` section is present (erratum E2) --
  // and the literal the fake CLI's own arm keys on.
  if (!replanContext.prompt.includes('"replan"')) {
    await fail('stage 2: the re-plan prompt does not contain the literal "replan" -- it was given the FIRST-plan instructions')
  }
  if (!replanContext.prompt.includes(GOAL_V1) || !replanContext.prompt.includes(GOAL_V2)) {
    await fail('stage 2: the re-plan prompt does not carry BOTH goal texts, so the manager cannot see what changed')
  }

  const replanned = await waitUntil('the re-plan to conclude', REPLAN_TIMEOUT_MS, async (note) => {
    const rows = await eventsOfType('workspace_replanned')
    note(`${String(rows.length)} workspace.replanned event(s) so far`)
    return rows.length === 0 ? null : rows
  })
  console.log(`stage 2 workspace.replanned (${String(replanned.length)}): ${replanned.map(describeEvent).join('\n  ')}`)
  if (replanned.length !== 1) await fail(`stage 2 concluded ${String(replanned.length)} re-plans, expected exactly one`)
  const replannedPayload = replanned[0].payload
  if (replannedPayload.version !== 2) {
    await fail(`stage 2's workspace.replanned says version ${String(replannedPayload.version)}, expected 2`)
  }
  if (replannedPayload.runId !== replanRunId) {
    await fail(`stage 2's workspace.replanned names run ${String(replannedPayload.runId)}, expected ${String(replanRunId)}`)
  }

  const afterReplan = await board()
  console.log(`stage 2 board after the re-plan (${String(afterReplan.length)}):\n  ${afterReplan.map(describeTask).join('\n  ')}`)
  const addedTasks = afterReplan.filter((task) => !planned.some((old) => old.id === task.id))
  console.log(`stage 2 added (${String(addedTasks.length)}):\n  ${addedTasks.map(describeTask).join('\n  ')}`)
  if (addedTasks.length !== 1) await fail(`stage 2's delta added ${String(addedTasks.length)} tasks, expected exactly one`)
  const addedTask = addedTasks[0]
  if (addedTask.title !== ADDED_TITLE) {
    await fail(`stage 2 added ${JSON.stringify(addedTask.title)}, expected ${JSON.stringify(ADDED_TITLE)}`)
  }
  // Erratum E7: an addition lands `ready`, exactly as `concludePlanning` has always created a
  // planned task. The scheduler's `dependenciesDone` gate still decides when it runs.
  if (addedTask.status !== 'ready') await fail(`stage 2's added task is ${addedTask.status}, expected ready`)
  if (addedTask.goalVersion !== 2) {
    await fail(`stage 2's added task is stamped goalVersion ${String(addedTask.goalVersion)}, expected 2 -- the version that asked for it`)
  }
  if (JSON.stringify(replannedPayload.added) !== JSON.stringify([addedTask.id])) {
    await fail(`stage 2's workspace.replanned lists added ${JSON.stringify(replannedPayload.added)}, expected ${JSON.stringify([addedTask.id])}`)
  }

  const staleDecisions = await waitUntil('the cancellation proposal', REPLAN_TIMEOUT_MS, async (note) => {
    const rows = await prisma.supervisorDecision.findMany({ where: { workspaceId, situationKind: 'stale_task' } })
    note(`${String(rows.length)} stale_task decision(s) so far`)
    return rows.length === 0 ? null : rows
  })
  console.log(`stage 2 stale_task decisions (${String(staleDecisions.length)}):\n  ${staleDecisions.map(describeDecision).join('\n  ')}`)
  if (staleDecisions.length !== 1) {
    await fail(`stage 2 recorded ${String(staleDecisions.length)} stale_task decisions, expected exactly one`)
  }
  const cancelProposal = staleDecisions[0]
  if (cancelProposal.subjectId !== coreTask.id) {
    await fail(`stage 2's proposal is about task ${String(cancelProposal.subjectId)}, expected the core task ${coreTask.id}`)
  }
  if (cancelProposal.action.kind !== 'cancel_task' || cancelProposal.action.taskId !== coreTask.id) {
    await fail(`stage 2's proposal chose ${JSON.stringify(cancelProposal.action)}, expected cancel_task on ${coreTask.id}`)
  }
  // Ruling R1, on the row: a cancellation is NEVER applied by the machine, whatever the workspace
  // is doing. `tierOf` pins `cancel_task` to `proposed` on both branches of its halt check.
  if (cancelProposal.tier !== 'proposed') await fail(`stage 2's proposal is tier ${cancelProposal.tier}, expected proposed`)
  if (cancelProposal.status !== 'pending') await fail(`stage 2's proposal is ${cancelProposal.status}, expected pending`)
  // The manager decided it, inside its re-plan run -- and no model call was made HERE to decide it,
  // so the Supervisor's spend must not gain one that never happened.
  if (cancelProposal.decidedBy !== 'model') await fail(`stage 2's proposal says decidedBy ${cancelProposal.decidedBy}, expected model`)
  if (cancelProposal.modelCalled !== false || cancelProposal.modelCostUsd !== null) {
    await fail(
      `stage 2's proposal records modelCalled ${String(cancelProposal.modelCalled)} / modelCostUsd ` +
        `${String(cancelProposal.modelCostUsd)} -- the re-plan run already paid for this decision`,
    )
  }
  if (cancelProposal.situation.facts.reason !== 'replan_cancel' || cancelProposal.situation.facts.currentVersion !== 2) {
    await fail(`stage 2's proposal situation is ${JSON.stringify(cancelProposal.situation)}, expected a replan_cancel at version 2`)
  }
  if (JSON.stringify(replannedPayload.proposedCancellations) !== JSON.stringify([coreTask.id])) {
    await fail(
      `stage 2's workspace.replanned lists proposedCancellations ${JSON.stringify(replannedPayload.proposedCancellations)}, ` +
        `expected ${JSON.stringify([coreTask.id])}`,
    )
  }
  // The three lists together account for every id the model asked to cancel (fix round 1). Here it
  // asked for one, it became a proposal, and neither of the other two lists has anything in it.
  if (!Array.isArray(replannedPayload.droppedCancellations) || replannedPayload.droppedCancellations.length !== 0) {
    await fail(`stage 2's workspace.replanned dropped ${JSON.stringify(replannedPayload.droppedCancellations)}, expected nothing dropped`)
  }
  if (!Array.isArray(replannedPayload.failedProposals) || replannedPayload.failedProposals.length !== 0) {
    await fail(`stage 2's workspace.replanned failed ${JSON.stringify(replannedPayload.failedProposals)}, expected no failures`)
  }

  const coreWhileProposed = await prisma.task.findUniqueOrThrow({ where: { id: coreTask.id } })
  console.log(`stage 2 core task while the proposal is pending: ${describeTask(coreWhileProposed)}`)
  if (coreWhileProposed.status !== 'ready') {
    await fail(`stage 2's core task is ${coreWhileProposed.status} though nobody approved the cancellation -- a proposal is not a deletion`)
  }

  await quiescePlanning()
  await stopDaemon(daemon2)

  const statusAfter = JSON.parse(runCli(['replan-status', '--workspace', workspaceId]))
  console.log(`stage 2 replan-status after the re-plan: ${JSON.stringify(statusAfter)}`)
  if (statusAfter.willReplan !== false) {
    await fail(`stage 2's replan-status still says willReplan ${String(statusAfter.willReplan)} -- a version gets ONE re-plan`)
  }
  // The dedup fact itself. `blockedBy` is deliberately NULL here rather than `'dedup'`: the
  // addition carries version 2, so `max(Task.goalVersion)` over the live board IS the goal version
  // and nothing is DUE -- `ReplanVerdict.blockedBy`'s own contract is "the first thing stopping a
  // re-plan the goal move has otherwise made due", and a board that has caught up is not being
  // stopped by anything. `alreadyReplanned` is what would stop it if the board fell behind again.
  if (statusAfter.alreadyReplanned !== true) {
    await fail(`stage 2's replan-status says alreadyReplanned ${String(statusAfter.alreadyReplanned)}, expected true`)
  }
  if (statusAfter.goalMoved !== false || statusAfter.boardVersion !== 2) {
    await fail(`stage 2's replan-status reads ${JSON.stringify(statusAfter)}, expected a board that has caught up to v2`)
  }
  if (statusAfter.intent !== null) {
    await fail(`stage 2's replan-status still intends ${JSON.stringify(statusAfter.intent)}, expected nothing`)
  }
  console.log(
    'stage 2 complete: the requirement changed, one run was asked for the DELTA against the board it was shown, the addition is on ' +
      'the board stamped with the version that asked for it, the cancellation is a proposal nobody has approved, and the version ' +
      'will not be re-planned again',
  )

  // ================= Stage 3: approving cancels, and a dependent stays blocked ====================

  const approveOutput = runCli(['approve-decision', '--id', cancelProposal.id])
  console.log(`stage 3 approve-decision printed: ${JSON.stringify(approveOutput.trim())}`)

  const approved = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: cancelProposal.id } })
  console.log(`stage 3 decision after approval: ${describeDecision(approved)}`)
  if (approved.status !== 'approved') await fail(`stage 3's decision is ${approved.status} after approval, expected approved`)
  if (approved.failureReason !== null) await fail(`stage 3's approval refused: ${String(approved.failureReason)}`)

  const coreAfter = await prisma.task.findUniqueOrThrow({ where: { id: coreTask.id } })
  console.log(`stage 3 core task after approval: ${describeTask(coreAfter)}`)
  if (coreAfter.status !== 'cancelled') await fail(`stage 3's core task is ${coreAfter.status} after approval, expected cancelled`)
  if (coreAfter.lastRejectionReason === null) await fail('stage 3: the cancelled task keeps no reason for why it was dropped')

  const cancelledEvents = await eventsOfType('task_cancelled')
  console.log(`stage 3 task.cancelled (${String(cancelledEvents.length)}): ${cancelledEvents.map(describeEvent).join('\n  ')}`)
  if (cancelledEvents.length !== 1) await fail(`stage 3 appended ${String(cancelledEvents.length)} task.cancelled events, expected one`)
  if (cancelledEvents[0].taskId !== coreTask.id) {
    await fail(`stage 3's task.cancelled names task ${String(cancelledEvents[0].taskId)}, expected ${coreTask.id}`)
  }
  // The TASK's own stamp -- the requirement whose work was dropped -- not the version that dropped
  // it, so the log says which requirement lost work without a reader joining the task row.
  if (cancelledEvents[0].payload.goalVersion !== 1) {
    await fail(`stage 3's task.cancelled says goalVersion ${String(cancelledEvents[0].payload.goalVersion)}, expected the task's own 1`)
  }
  // A PERSON approved it, so the envelope says a person -- `carryOut` runs an approved proposal
  // with `origin: 'human'` (the same rule M39's approved answer follows). `cancel_task` is
  // `proposed` on every branch (ruling R1), so this is the only origin it can ever have; what says
  // the Supervisor was behind it is the reason the decision carried, and the `supervisor.applied`
  // event that names the decision.
  if (cancelledEvents[0].actor !== 'human') {
    await fail(`stage 3's task.cancelled says actor ${cancelledEvents[0].actor}, expected human -- a person approved the proposal`)
  }
  if (cancelledEvents[0].payload.reason !== cancelProposal.action.reason) {
    await fail(
      `stage 3's task.cancelled records reason ${JSON.stringify(cancelledEvents[0].payload.reason)}, expected the proposal's own ` +
        JSON.stringify(cancelProposal.action.reason),
    )
  }
  const appliedEvents = await eventsOfType('supervisor_applied')
  console.log(`stage 3 supervisor.applied (${String(appliedEvents.length)}): ${appliedEvents.map(describeEvent).join('\n  ')}`)
  if (!appliedEvents.some((event) => event.payload.decisionId === cancelProposal.id)) {
    await fail(`stage 3 cancelled the task without recording which decision did it: ${appliedEvents.map(describeEvent).join('; ')}`)
  }

  // Ruling R3, measured through the snapshot the SCHEDULER decides from rather than through a
  // hand-written re-implementation of its rule.
  const dependencyRows = await prisma.taskDependency.findMany({ where: { taskId: apiTask.id } })
  console.log(`stage 3 TaskDependency rows for the api task: ${JSON.stringify(dependencyRows)}`)
  if (!dependencyRows.some((row) => row.dependsOnTaskId === coreTask.id)) {
    await fail(`stage 3: cancelling core removed the dependency row api -> core (${JSON.stringify(dependencyRows)})`)
  }
  const loaded = await loadWorld(workspaceId)
  const apiInWorld = loaded.world.tasks.find((task) => task.id === apiTask.id)
  console.log(`stage 3 world tasks: ${JSON.stringify(loaded.world.tasks)}`)
  if (apiInWorld === undefined) await fail(`stage 3: the scheduler's world does not hold the api task ${apiTask.id}`)
  if (apiInWorld.dependenciesDone !== false) {
    await fail(
      `stage 3: the api task reports dependenciesDone ${String(apiInWorld.dependenciesDone)} though the work it depends on was ` +
        'CANCELLED rather than done (ruling R3)',
    )
  }

  // And nothing moves it. Two hand-run ticks, which carry no model decider at all, so the board
  // this reads afterwards is what the SCHEDULER left alone.
  const planningRunsBeforeTicks = await prisma.slaveRun.count({ where: { kind: 'planning', slave: { team: { workspaceId } } } })
  for (const pass of [1, 2]) {
    const tickOutput = runCli(['tick', '--workspace', workspaceId])
    console.log(`stage 3 tick ${String(pass)} printed:\n${tickOutput}`)
  }

  // Erratum E8's regression guard, taken at the point the board is at its most terminal: the goal
  // has not moved since v2, so no tick may start a planning run of any kind. The trigger used to
  // take its board version over the NON-terminal tasks only, so a board whose tasks had all
  // finished had nothing to take a max over, the version fell to 0, and every finished project
  // re-planned itself on its next tick -- a real manager run told a requirement had changed when
  // nothing had.
  const planningRunsAfterTicks = await prisma.slaveRun.count({ where: { kind: 'planning', slave: { team: { workspaceId } } } })
  console.log(`stage 3 planning runs: ${String(planningRunsBeforeTicks)} before the ticks, ${String(planningRunsAfterTicks)} after`)
  if (planningRunsAfterTicks !== planningRunsBeforeTicks) {
    await fail(
      `stage 3's two ticks started ${String(planningRunsAfterTicks - planningRunsBeforeTicks)} planning run(s) on a board whose ` +
        'goal has not moved since v2 (erratum E8)',
    )
  }
  const replanStartedAfterTicks = await eventsOfType('workspace_replan_started')
  console.log(`stage 3 workspace.replan_started (${String(replanStartedAfterTicks.length)}): ${replanStartedAfterTicks.map(describeEvent).join('\n  ')}`)
  if (replanStartedAfterTicks.length !== 1 || replanStartedAfterTicks[0].payload.version !== 2) {
    await fail(
      `stage 3 left ${String(replanStartedAfterTicks.length)} workspace.replan_started event(s) ` +
        `(${JSON.stringify(replanStartedAfterTicks.map((event) => event.payload))}), expected only the one for version 2`,
    )
  }
  const apiAfterTicks = await prisma.task.findUniqueOrThrow({ where: { id: apiTask.id } })
  const apiRuns = await prisma.slaveRun.count({ where: { taskId: apiTask.id } })
  console.log(`stage 3 api task after two ticks: ${describeTask(apiAfterTicks)}, runs ${String(apiRuns)}`)
  if (apiAfterTicks.status !== 'ready') {
    await fail(`stage 3's api task is ${apiAfterTicks.status} after two ticks, expected it left exactly where it was`)
  }
  if (apiRuns !== 0) await fail(`stage 3 started ${String(apiRuns)} run(s) for a task whose dependency was cancelled`)

  // The human's own half of the same verb: `cancel-task` from the CLI, on a `ready` task.
  const HAND_CANCEL_REASON = 'the M40 gate takes it off the board by hand'
  const cancelTaskOutput = runCli(['cancel-task', '--task', apiTask.id, '--reason', HAND_CANCEL_REASON])
  console.log(`stage 3 cancel-task printed: ${JSON.stringify(cancelTaskOutput.trim())}`)
  const apiCancelled = await prisma.task.findUniqueOrThrow({ where: { id: apiTask.id } })
  console.log(`stage 3 api task after cancel-task: ${describeTask(apiCancelled)}`)
  if (apiCancelled.status !== 'cancelled') await fail(`stage 3's cancel-task left the api task ${apiCancelled.status}, expected cancelled`)
  const cancelledAfterCli = await eventsOfType('task_cancelled')
  console.log(`stage 3 task.cancelled after the CLI (${String(cancelledAfterCli.length)}): ${cancelledAfterCli.map(describeEvent).join('\n  ')}`)
  const apiCancelEvent = cancelledAfterCli.find((event) => event.taskId === apiTask.id)
  if (apiCancelEvent === undefined) await fail("stage 3's cancel-task wrote no task.cancelled event")
  if (apiCancelEvent.actor !== 'human') {
    await fail(`stage 3's hand cancellation says actor ${apiCancelEvent.actor}, expected human`)
  }
  // The operator's own words, and the task's own stamp -- no decision was involved at all here.
  if (apiCancelEvent.payload.reason !== HAND_CANCEL_REASON || apiCancelEvent.payload.goalVersion !== 1) {
    await fail(`stage 3's hand cancellation records ${JSON.stringify(apiCancelEvent.payload)}, expected the typed reason at goal version 1`)
  }
  if (apiCancelled.lastRejectionReason !== HAND_CANCEL_REASON) {
    await fail(`stage 3's hand-cancelled task keeps ${JSON.stringify(apiCancelled.lastRejectionReason)}, expected the typed reason`)
  }
  console.log(
    'stage 3 complete: a human approved the cancellation and the task went off the board with the version it came from on the ' +
      'record; the task that depended on it is still not schedulable, because cancelled work was never done',
  )

  // ================= Stage 4: the same words are not a new version ================================

  const unchanged = runCliRaw(['set-goal', '--workspace', workspaceId, '--goal', GOAL_V2])
  console.log(`stage 4 set-goal exit ${String(unchanged.status)}, stdout ${JSON.stringify(unchanged.stdout)}, stderr ${JSON.stringify(unchanged.stderr)}`)
  if (unchanged.status === 0) {
    await fail('stage 4: setting the goal to the text it already reads exited 0 -- a caller cannot tell "the version moved" from "it did not"')
  }
  // Erratum E5's refusal, in the operator's own words: it names the version that already reads this.
  if (!unchanged.stderr.includes('version 2')) {
    await fail(`stage 4's refusal does not name version 2: ${JSON.stringify(unchanged.stderr)}`)
  }
  const versionsAfterRefusal = await prisma.goalVersion.findMany({ where: { workspaceId }, orderBy: { version: 'asc' } })
  console.log(`stage 4 GoalVersion rows: ${JSON.stringify(versionsAfterRefusal.map((row) => row.version))}`)
  if (versionsAfterRefusal.length !== 2) {
    await fail(`stage 4 left ${String(versionsAfterRefusal.length)} GoalVersion rows, expected the same 2 -- nothing changed, so nothing is recorded`)
  }
  const goalSetAfterRefusal = await eventsOfType('workspace_goal_set')
  console.log(`stage 4 workspace.goal_set events: ${String(goalSetAfterRefusal.length)}`)
  if (goalSetAfterRefusal.length !== 2) {
    await fail(`stage 4 left ${String(goalSetAfterRefusal.length)} workspace.goal_set events, expected the same 2`)
  }
  console.log('stage 4 complete: re-typing the requirement it already has is not an edit -- no row, no event, and a non-zero exit that says so')

  // ================= Stage 5: the prompt a re-plan would get, without starting one ================

  // A pending re-plan is what a preview previews, and stage 2's was consumed by the run that
  // answered it: after it, the board has caught up and `replan-status --prompt` correctly refuses
  // to invent a prompt for a run that will not happen. So the move this stage previews is a REAL
  // one it makes first -- a third version of the requirement, with no daemon anywhere to act on it.
  const setV3 = runCli(['set-goal', '--workspace', workspaceId, '--goal', GOAL_V3])
  console.log(`stage 5 set-goal printed: ${JSON.stringify(setV3.trim())}`)
  if (JSON.parse(setV3).version !== 3) await fail(`stage 5's set-goal printed ${setV3.trim()}, expected version 3`)

  const contextsBefore = await runContextCount()
  const runsBefore = await prisma.slaveRun.count({ where: { slave: { team: { workspaceId } } } })
  console.log(`stage 5 before the preview: ${String(contextsBefore)} RunContext row(s), ${String(runsBefore)} run(s)`)

  const previewOutput = runCli(['replan-status', '--workspace', workspaceId, '--prompt'])
  console.log(`stage 5 replan-status --prompt printed:\n${previewOutput}`)
  const separator = `\n${'-'.repeat(40)}\n`
  const separatorAt = previewOutput.indexOf(separator)
  if (separatorAt === -1) {
    await fail(`stage 5's replan-status --prompt printed no prompt at all: ${JSON.stringify(previewOutput)}`)
  }
  const previewVerdict = JSON.parse(previewOutput.slice(0, separatorAt))
  const preview = previewOutput.slice(separatorAt + separator.length)
  console.log(`stage 5 preview verdict: ${JSON.stringify(previewVerdict)}`)
  if (previewVerdict.willReplan !== true || previewVerdict.blockedBy !== null) {
    await fail(`stage 5's verdict is ${JSON.stringify(previewVerdict)}, expected a re-plan due with nothing in the way`)
  }
  if (!preview.includes('"replan"')) {
    await fail('stage 5: the previewed prompt does not contain the literal "replan" -- it is not the prompt a re-plan run would get')
  }
  // BOTH ends of the move it is previewing: the requirement the board was built from and the one it
  // has to catch up to. Not compared byte for byte to a recorded prompt -- a preview has no run, so
  // it carries no persona (the manager who takes the run is chosen at dispatch).
  if (!preview.includes(GOAL_V2) || !preview.includes(GOAL_V3)) {
    await fail('stage 5: the previewed prompt does not carry both goal texts, so it does not show what changed')
  }

  const contextsAfter = await runContextCount()
  const runsAfter = await prisma.slaveRun.count({ where: { slave: { team: { workspaceId } } } })
  console.log(`stage 5 after the preview: ${String(contextsAfter)} RunContext row(s), ${String(runsAfter)} run(s)`)
  // Ruling R4: the tick is the only thing that starts a planning run, and a prompt nobody was given
  // must never appear in the one table that answers "what was this run told".
  if (contextsAfter !== contextsBefore) {
    await fail(`stage 5's preview wrote ${String(contextsAfter - contextsBefore)} RunContext row(s) for a run that does not exist`)
  }
  if (runsAfter !== runsBefore) {
    await fail(`stage 5's preview started ${String(runsAfter - runsBefore)} run(s) -- a read must dispatch nothing`)
  }
  console.log(
    'stage 5 complete: an operator can read the exact prompt the next re-plan would be given, both requirements and the re-plan ' +
      'instructions included, and reading it starts nothing and records nothing',
  )

  const finalBoard = await board()
  console.log(`the whole board this gate produced (${String(finalBoard.length)}):\n  ${finalBoard.map(describeTask).join('\n  ')}`)
  const finalVersions = await prisma.goalVersion.findMany({ where: { workspaceId }, orderBy: { version: 'asc' } })
  console.log(`every goal version (${String(finalVersions.length)}): ${JSON.stringify(finalVersions.map((row) => ({ version: row.version, sha256: row.sha256 })))}`)

  console.log(
    'PASS: a real daemon planned from a versioned requirement and stamped every task with the version that produced it; changing ' +
      'the requirement ran a delta re-plan that added work at once and only PROPOSED the cancellation; a human approved it and the ' +
      'task that depended on the cancelled work stayed unschedulable; re-typing the same requirement recorded nothing; and the ' +
      'prompt the next re-plan would get can be read without starting one',
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
    // Cascades Team/Slave/Task/SlaveRun/RunContext/TaskDependency/GoalVersion and
    // SupervisorDecision.
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
