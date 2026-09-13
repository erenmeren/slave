// M38's own gate (Task 6 brief): proves the milestone's central claim end to end, against a REAL
// daemon and the FAKE `claude` CLI -- a workspace gets a Supervisor. It watches the project at the
// end of every tick, chooses from a catalogue the RULES built, applies the routine choices itself
// through the ordinary control verbs, records the risky ones as proposals a human answers, and
// stops thinking with a model the moment the money is gone.
//
// WHY THERE IS EXACTLY ONE SLAVE, AND WHY IT IS NOT A REVIEWER. `Dev` holds `runtimeRoles:
// ['backend']` and nothing else. That single fact is what makes stage 1 a measurement rather than
// an observation: the task really does reach `reviewing` and really cannot be reviewed, so the
// `no_reviewer` situation is produced by the world and not by a fixture -- and the ONE staffing
// candidate the rules can offer is `Dev`, which is why the fake CLI's `candidateIndex: 0` answer
// is a decision about this workspace and not a coin flip over a menu.
//
// NEVER A MODEL CALL. The daemon is spawned with `SLAVEOFAI_CLAUDE_BIN=node`,
// `SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m8a-flow"` and `SLAVEOFAI_REQUIRE_FAKE_CLI=1`
// (M32 item 7: lose the first two and the daemon refuses to start rather than falling back to the
// real binary) -- the same wiring `gate-m36-messaging.mjs` and `gate-m37-run-context.mjs` use.
// `m8a-flow` runs the work body and replays `review-approve` on a `"verdict"` prompt, and every
// flow mode answers a prompt carrying the literal `"candidateIndex"` from the `supervisor-decision`
// fixture: index 0, `total_cost_usd` 0.01. So the Supervisor's "model" here is a file on disk.
//
// HOW "NO MODEL CALL" IS PROVEN RATHER THAN ASSUMED. `SupervisorDecision.modelCalled` (spec
// erratum E6) records whether a call was made at all -- true even when the answer came back
// unusable and the rules chose. Stage 1 asserts it TRUE on the decision the model made, and stage 3
// asserts it FALSE on every row written after the budget guardrail halted the workspace. A pair of
// assertions about the same column, from the two sides of the seam, is a stronger statement than
// counting replays in a log the fake CLI does not keep.
//
// STAGES
//   1. A proposal is not an action. The task reaches `reviewing`; nobody can review it; the
//      Supervisor writes ONE row -- `no_reviewer`, `tier: proposed`, `status: pending`, action
//      `set_runtime_roles`, `decidedBy: model`, `modelCalled: true`, cost recorded -- and `Dev`'s
//      runtime roles are UNCHANGED, because a proposal is a question. Then a human answers it with
//      the operator's own `approve-decision --id <id>` as a real subprocess: the role is written,
//      and the very next tick staffs the review onto `Dev`.
//   2. A routine action is taken without asking. A task parked `blocked` by the review retry cap
//      (the one park E5 lets the Supervisor leave on its own), with attempts left, produces a row
//      that is `tier: applied` / `status: applied` from birth: the task is back in `rework` and the
//      `task.unblocked` envelope says `actor: system` (erratum E4) -- the log names the machine.
//   3. A broke workspace is not thought about. `budgetUsd` below a concluded run's `costUsd`
//      halts scheduling; the daemon supervises the halt branch anyway (spec §5 clarification), and
//      the one row it writes is `workspace_halted` / `escalate_to_human`, `decidedBy: rules`,
//      `modelCalled: false`, `modelCostUsd: null`. Nothing written after the halt called anybody.
//   4. A preview costs nothing. `supervise --workspace <id> --dry-run` prints the situation, its
//      candidates and the rules' own choice -- and the decision rows and the event log are
//      byte-for-byte the same afterwards.
//   5. The same stuck thing is not decided twice. Stage 2's task is re-parked inside `COOLDOWN_MS`;
//      a supervised pass demonstrably happens afterwards (it writes a decision about the OTHER
//      stuck task, and `review_cap_blocked` is observed before `task_blocked_human` in
//      `SITUATION_KINDS` order, so that pass provably looked at the re-parked one first) -- and no
//      second row exists for its key.
//
// Shape borrowed from `gate-m37-run-context.mjs` (temp git repo + `prisma.workspace.create` setup,
// `preflightCleanup()`/`dumpGateRows()`/`fail()`/`waitUntil()`, the daemon lifecycle and its
// `findRealDaemonPids()` refusal, "print every measured value before asserting it", real CLI
// subprocesses through `execFileSync('node', [cliPath, ...])` with `loopbackChildEnv()`, `exitCode`
// starting at 1 and set to 0 only at the very end, teardown in FK order) and from
// `gate-m35-pipeline-honesty.mjs` for building preconditions out of the rows production code
// itself writes.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids } from './lib/daemon-process.mjs'
import { prisma } from '../packages/db/dist/client.js'
import { appendEvent } from '../packages/events/dist/index.js'
import { isAlive } from '../packages/control/dist/index.js'

const POLL_INTERVAL_MS = 50
const DAEMON_PERIOD_MS = 500
// Generous, and every one of them bounds real work: a `git worktree add`, a fake CLI replay, a
// verify pass, a merge pass, a supervised tick. Tuned to "a slow machine still passes".
const DISPATCH_TIMEOUT_MS = 90_000
const RUN_TIMEOUT_MS = 180_000
const REVIEW_TIMEOUT_MS = 120_000
const SUPERVISOR_TIMEOUT_MS = 120_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

// Exact literals, never suffixed -- `preflightCleanup` removes whatever a prior crashed run left on
// this exact name, in the same FK order the `finally` block uses.
const WORKSPACE_NAME = 'M38 Gate Project'
const REVIEWED_TASK_TITLE = 'M38 Gate Reviewed Task'
const CAPPED_TASK_TITLE = 'M38 Gate Capped Task'
const PARKED_TASK_TITLE = 'M38 Gate Parked Task'

/** The cost the `supervisor-decision` fixture reports for one call (`total_cost_usd`). */
const FIXTURE_DECISION_COST_USD = 0.01
/** Stage 3's budget and the concluded run that blows straight through it. */
const STAGE_3_BUDGET_USD = 0.5
const STAGE_3_RUN_COST_USD = 5

/** The role nobody in this workspace holds. Stages 2 and 4 park their tasks under it so the
 *  scheduler has nothing to dispatch for them -- `decide()` skips a task whose required role has no
 *  holder, silently and without an event -- and the gate's later stages are measuring the
 *  Supervisor rather than racing a run it did not ask for. `ready_unstaffed` keys on `ready` tasks
 *  only, so a `blocked` or `rework` task under this role raises no situation of its own. */
const UNHELD_ROLE = 'qa'

/** Same as `gate-m37-run-context.mjs`'s -- a real repository, because the tick provisions a real
 *  worktree in it and the fake CLI commits into that worktree. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m38-repo-'))
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
 *  RunContext and -- since M38 -- SupervisorDecision. This gate creates no org rows and no skill
 *  rows, so there is nothing else of its own anywhere in the database. */
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
          include: { tasks: true, teams: { include: { slaves: { include: { runs: true } } } } },
        })
  const events =
    workspaceId === null ? [] : await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  const decisions =
    workspaceId === null
      ? []
      : await prisma.supervisorDecision.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })
  const daemonTails = daemons.map((d) => ({
    label: d.label,
    pid: d.proc.pid ?? null,
    exited: d.exited,
    output: d.output.length > 6_000 ? `…${d.output.slice(-6_000)}` : d.output,
  }))
  return JSON.stringify({ workspace, events, decisions, daemonTails }, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

/** The `gate-m35`/`gate-m37` diagnostic throw: an Error carrying the state that made the call, not
 *  just the sentence that noticed. */
async function fail(message) {
  const dump = await dumpGateRows().catch(
    (cause) => `<could not dump gate rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
  )
  throw new Error(`${message} -- gateRows=${dump}`)
}

/** A decision row as this gate prints it: the JSON columns are what every assertion below reads,
 *  and a failure that shows only ids is a failure nobody can diagnose from the log. */
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
    rationale: row.rationale,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  })

try {
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`orchestrator CLI not built at ${ORCHESTRATOR_CLI} -- run tsc --build first`)
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)

  // Refused rather than tolerated (`gate-m36-messaging.mjs`'s own refusal): this gate spawns and
  // stops daemons of its own and counts what a supervised tick wrote, and a second daemon somebody
  // else left running would be ticking other workspaces -- and holding the global concurrency
  // budget this one's runs need.
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m38-supervisor REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate starts and stops daemons of its own and measures exactly what one supervised tick wrote',
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
    `workspace ${workspaceId} (${WORKSPACE_NAME}), repo ${repoPath}, budgetUsd ${String(workspace.budgetUsd)}, ` +
      `supervisorEnabled ${String(workspace.supervisorEnabled)}`,
  )
  if (!workspace.supervisorEnabled) await fail('a new workspace starts with its Supervisor switched off')

  // Without this row every dispatch refuses with `invalid_provider` (M12 Task 8) and nothing runs.
  await prisma.providerConfiguration.create({ data: { workspaceId, kind: 'claude_code', settings: {} } })

  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  // ONE worker, and no `reviewer` in its runtime role set. Its TITLE deliberately does not contain
  // the word "reviewer" either: `staffingCandidates` orders its offers by whether the title reads
  // as the role, and a gate whose only candidate matched on the title would be proving the
  // ordering rather than the decision.
  const slave = await prisma.slave.create({
    data: { teamId: team.id, name: 'Dev', role: 'Senior Engineer', runtimeRoles: ['backend'] },
  })
  console.log(`slave ${slave.id} "Dev": role ${JSON.stringify(slave.role)}, runtimeRoles ${JSON.stringify(slave.runtimeRoles)}`)

  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: REVIEWED_TASK_TITLE,
      description: 'Synthetic task driven by scripts/gate-m38-supervisor.mjs.',
      status: 'ready',
      requiredRole: 'backend',
      maxAttempts: 5,
    },
  })
  console.log(`task ${task.id} (ready, backend)`)

  /** The environment every child of this gate gets: the fake CLI and the refusal that guards it. */
  const childEnv = () =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8a-flow`,
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
    })

  /** Runs the real orchestrator CLI as a subprocess, exactly as an operator's shell would. */
  const runCli = (args) =>
    execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
      cwd: repoRoot,
      env: childEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  /** The daemon this gate currently expects to be alive. `waitUntil` fails immediately when it dies
   *  rather than sitting out a whole timeout. */
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
  function spawnDaemon(label) {
    const proc = spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspaceId, '--period', String(DAEMON_PERIOD_MS)], {
      cwd: repoRoot,
      env: childEnv(),
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
    console.log(`${label} spawned as pid ${String(proc.pid)}`)
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

  /** Every decision this workspace has, oldest first -- read fresh each time it is asked for. */
  const allDecisions = () => prisma.supervisorDecision.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })

  // ================= Stage 1: a proposal is not an action =========================================

  spawnDaemon('daemon-1')

  const startedRun = await waitUntil('the daemon to start a run for the task', DISPATCH_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findFirst({ where: { taskId: task.id } })
    note(run === null ? 'no SlaveRun row yet' : `run ${run.id} is ${run.status}`)
    return run
  })
  console.log(`implementation run ${startedRun.id} started (${startedRun.status}, kind ${startedRun.kind})`)

  const reviewingTask = await waitUntil('the task to reach reviewing', RUN_TIMEOUT_MS, async (note) => {
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    note(`task is ${row.status}`)
    return row.status === 'reviewing' ? row : null
  })
  console.log(`task ${task.id} is ${reviewingTask.status} on branch ${JSON.stringify(reviewingTask.branch)} -- and nobody holds "reviewer"`)

  const proposal = await waitUntil('the Supervisor to write a no_reviewer decision', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const rows = await prisma.supervisorDecision.findMany({ where: { workspaceId, situationKind: 'no_reviewer' } })
    note(`${String(rows.length)} no_reviewer decision(s) so far`)
    return rows.length === 0 ? null : rows[0]
  })
  console.log(`no_reviewer decision: ${describeDecision(proposal)}`)
  console.log(`  the situation it was made on: ${JSON.stringify(proposal.situation)}`)
  console.log(`  the catalogue it chose from: ${JSON.stringify(proposal.candidates)}`)

  if (proposal.tier !== 'proposed') await fail(`the no_reviewer decision is tier ${proposal.tier}, expected proposed`)
  if (proposal.status !== 'pending') await fail(`the no_reviewer decision is ${proposal.status}, expected pending`)
  if (proposal.action.kind !== 'set_runtime_roles') {
    await fail(`the no_reviewer decision's action is ${String(proposal.action.kind)}, expected set_runtime_roles`)
  }
  if (proposal.action.slaveId !== slave.id) {
    await fail(`the proposal names slave ${String(proposal.action.slaveId)}, expected the workspace's only worker ${slave.id}`)
  }
  if (JSON.stringify(proposal.action.roles) !== JSON.stringify(['backend', 'reviewer'])) {
    await fail(`the proposal would write roles ${JSON.stringify(proposal.action.roles)}, expected ["backend","reviewer"]`)
  }
  // The model half of the "never a real model call" pair: a call WAS made, through the fake CLI,
  // and its cost is on the row and therefore in the workspace's spend.
  if (proposal.decidedBy !== 'model') await fail(`the no_reviewer decision says decidedBy ${proposal.decidedBy}, expected model`)
  if (proposal.modelCalled !== true) await fail('the no_reviewer decision says no model call was made')
  if (proposal.modelCostUsd === null || Math.abs(proposal.modelCostUsd - FIXTURE_DECISION_COST_USD) > 1e-9) {
    await fail(
      `the no_reviewer decision recorded modelCostUsd ${String(proposal.modelCostUsd)}, expected the fixture's ${String(FIXTURE_DECISION_COST_USD)}`,
    )
  }
  if (proposal.chosenIndex !== 0) await fail(`the model picked candidate ${String(proposal.chosenIndex)}, expected the fixture's 0`)

  // The measured negative, and the whole point of the tier: the row says what it WOULD do, and the
  // world is untouched.
  const slaveBeforeApproval = await prisma.slave.findUniqueOrThrow({ where: { id: slave.id } })
  console.log(`Dev while the proposal is pending: runtimeRoles ${JSON.stringify(slaveBeforeApproval.runtimeRoles)}`)
  if (JSON.stringify(slaveBeforeApproval.runtimeRoles) !== JSON.stringify(['backend'])) {
    await fail(`a PENDING proposal already changed Dev's runtime roles to ${JSON.stringify(slaveBeforeApproval.runtimeRoles)}`)
  }
  const runsBeforeApproval = await prisma.slaveRun.findMany({ where: { taskId: task.id } })
  console.log(`runs for the task while the proposal is pending: ${JSON.stringify(runsBeforeApproval.map((r) => ({ id: r.id, kind: r.kind })))}`)
  if (runsBeforeApproval.some((run) => run.kind === 'review')) {
    await fail('a review run exists while nobody holds the reviewer role -- the proposal was applied, not proposed')
  }

  // WAIT ON STATEMENT TWO, NEVER ON STATEMENT ONE (M53 final wave; pre-existing race). The decision
  // ROW and its `supervisor.proposed` EVENT are two writes: the wait above returns the moment the
  // row exists, so reading the event straight afterwards asserts a write that may still be in
  // flight -- which is what flaked under a full ladder's load and passed alone.
  const proposedEvent = await waitUntil('the supervisor.proposed event for the pending proposal', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.executionEvent.findFirst({
      where: { workspaceId, type: 'supervisor_proposed' },
      orderBy: { seq: 'asc' },
    })
    note(row === null ? 'the decision row exists, its event has not committed yet' : 'appended')
    return row
  })
  console.log(`supervisor.proposed event: ${JSON.stringify(proposedEvent.payload)}`)
  if (proposedEvent.payload.decisionId !== proposal.id) {
    await fail(`the supervisor.proposed event names decision ${String(proposedEvent.payload.decisionId)}, expected ${proposal.id}`)
  }

  // The human's answer, typed the way an operator types it. No `--by`: the CLI has no session and
  // acts with no principal, so the row's `resolvedByUserId` is honestly null.
  const approveOutput = runCli(['approve-decision', '--id', proposal.id])
  console.log(`approve-decision printed: ${JSON.stringify(approveOutput.trim())}`)

  const approved = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: proposal.id } })
  console.log(`the decision after approval: ${describeDecision(approved)}, resolvedByUserId ${JSON.stringify(approved.resolvedByUserId)}`)
  if (approved.status !== 'approved') await fail(`the approved decision is ${approved.status}, expected approved`)
  if (approved.resolvedAt === null) await fail('the approved decision has no resolvedAt')

  const slaveAfterApproval = await prisma.slave.findUniqueOrThrow({ where: { id: slave.id } })
  console.log(
    `Dev after approval: role ${JSON.stringify(slaveAfterApproval.role)}, runtimeRoles ${JSON.stringify(slaveAfterApproval.runtimeRoles)}`,
  )
  if (!slaveAfterApproval.runtimeRoles.includes('reviewer')) {
    await fail(`approving the proposal did not put reviewer in Dev's runtime role set (${JSON.stringify(slaveAfterApproval.runtimeRoles)})`)
  }
  if (slaveAfterApproval.role !== 'Senior Engineer') {
    await fail(`applying the proposal changed Dev's TITLE to ${JSON.stringify(slaveAfterApproval.role)}`)
  }

  const reviewRun = await waitUntil('a review run to be staffed', REVIEW_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findFirst({ where: { taskId: task.id, kind: 'review' }, orderBy: { startedAt: 'asc' } })
    note(run === null ? 'no review run yet' : `review run ${run.id} is ${run.status}`)
    return run
  })
  console.log(`review run ${reviewRun.id} (${reviewRun.status}) staffed onto slave ${reviewRun.slaveId}`)
  if (reviewRun.slaveId !== slave.id) {
    await fail(`the review was staffed onto ${reviewRun.slaveId}, expected the only worker in this workspace ${slave.id}`)
  }
  console.log(
    'stage 1 complete: the Supervisor saw a workspace that could not review its own work, proposed the one staffing action the ' +
      'rules offered and changed nothing until a human said yes -- and the next tick staffed the review it had been waiting for',
  )

  // ================= Stage 2: a routine action is taken without asking ============================

  // Waited out rather than raced: the review run holds Dev, and stage 2's row is about what the
  // Supervisor does with a task NOBODY is working on. `endedAt`, not `succeeded`, because the
  // verdict itself is `gate-m8a-merge.mjs`'s subject, not this gate's.
  const concludedReview = await waitUntil('the review run to conclude', REVIEW_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: reviewRun.id } })
    note(`review run is ${run.status}`)
    return run.endedAt === null ? null : run
  })
  console.log(`review run concluded: ${concludedReview.status}`)

  // The preconditions `review.ts` itself leaves behind when the review retry cap is spent: the task
  // parked `blocked` with `activeRunId` cleared, and a `guardrail.tripped` naming the cap, on the
  // task, appended through the one write gate. Attempt 1 of 5, so attempts remain -- which is the
  // difference between the routine `unblock_task` and the `raise_max_attempts` a human signs off.
  const cappedTask = await prisma.task.create({
    data: {
      workspaceId,
      title: CAPPED_TASK_TITLE,
      description: 'Parked at the review retry cap by scripts/gate-m38-supervisor.mjs.',
      status: 'blocked',
      requiredRole: UNHELD_ROLE,
      attempt: 1,
      maxAttempts: 5,
    },
  })
  await appendEvent({
    type: 'guardrail.tripped',
    workspaceId,
    taskId: cappedTask.id,
    actor: 'system',
    payload: {
      guardrail: 'review_retry_cap_exhausted',
      detail: `task "${CAPPED_TASK_TITLE}" could not be reviewed: the review retry cap is spent.`,
    },
  })
  console.log(`capped task ${cappedTask.id} (blocked, attempt ${String(cappedTask.attempt)} of ${String(cappedTask.maxAttempts)}, guardrail review_retry_cap_exhausted)`)

  const applied = await waitUntil('the Supervisor to decide the review-cap block', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const rows = await prisma.supervisorDecision.findMany({
      where: { workspaceId, situationKind: 'review_cap_blocked', subjectId: cappedTask.id },
    })
    note(`${String(rows.length)} review_cap_blocked decision(s) so far`)
    return rows.length === 0 ? null : rows[0]
  })
  console.log(`review_cap_blocked decision: ${describeDecision(applied)}`)
  if (applied.tier !== 'applied') await fail(`the review_cap_blocked decision is tier ${applied.tier}, expected applied`)
  if (applied.status !== 'applied') await fail(`the review_cap_blocked decision is ${applied.status}, expected applied`)
  if (applied.action.kind !== 'unblock_task') {
    await fail(`the review_cap_blocked decision's action is ${String(applied.action.kind)}, expected unblock_task`)
  }
  if (applied.action.taskId !== cappedTask.id) {
    await fail(`the unblock names task ${String(applied.action.taskId)}, expected ${cappedTask.id}`)
  }
  if (applied.failureReason !== null) await fail(`the applied decision records a failure: ${String(applied.failureReason)}`)

  const unblockedTask = await waitUntil('the capped task to go back to rework', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.task.findUniqueOrThrow({ where: { id: cappedTask.id } })
    note(`capped task is ${row.status}`)
    return row.status === 'rework' ? row : null
  })
  console.log(`capped task after the applied decision: status ${unblockedTask.status}, attempt ${String(unblockedTask.attempt)} of ${String(unblockedTask.maxAttempts)}`)

  // Waited for rather than read once: `unblockTask` moves the row and THEN appends, outside one
  // transaction, so a poll that saw `rework` can genuinely be a few milliseconds ahead of the log.
  // Missing after this wait is a real defect; missing immediately is a gate racing the verb.
  const unblockedEvent = await waitUntil('the task.unblocked event', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.executionEvent.findFirst({
      where: { workspaceId, taskId: cappedTask.id, type: 'task_unblocked' },
      orderBy: { seq: 'desc' },
    })
    note(row === null ? 'no task.unblocked event yet' : 'found it')
    return row
  })
  console.log(`task.unblocked event: actor ${unblockedEvent.actor}, payload ${JSON.stringify(unblockedEvent.payload)}`)
  // Erratum E4: the envelope enum has no `supervisor`, so a machine-made unblock says `system` --
  // never `human`, which is what an operator's own `unblock-task` writes.
  if (unblockedEvent.actor !== 'system') {
    await fail(`the task.unblocked envelope says actor ${unblockedEvent.actor}, expected system for a Supervisor-applied action`)
  }
  console.log(
    'stage 2 complete: the one park the Supervisor knows a safe exit from was left without asking anybody, and the log names ' +
      'the machine rather than a person who did nothing',
  )

  // ================= Stage 3: a broke workspace is not thought about ==============================

  const decisionsBeforeHalt = await allDecisions()
  const idsBeforeHalt = new Set(decisionsBeforeHalt.map((row) => row.id))
  console.log(`decisions before the budget is blown: ${String(decisionsBeforeHalt.length)}`)

  // A concluded run whose measured cost alone is ten times the budget. `workspaceSpend` sums
  // `SlaveRun.costUsd` over every run of the workspace (joined through slave -> team, which is why
  // this one needs no task), so the budget guardrail sees it on the very next tick.
  const expensiveRun = await prisma.slaveRun.create({
    data: { slaveId: slave.id, kind: 'planning', status: 'succeeded', costUsd: STAGE_3_RUN_COST_USD, endedAt: new Date() },
  })
  await prisma.workspace.update({ where: { id: workspaceId }, data: { budgetUsd: STAGE_3_BUDGET_USD } })
  console.log(
    `budget set to $${String(STAGE_3_BUDGET_USD)} with a concluded run ${expensiveRun.id} costing $${String(STAGE_3_RUN_COST_USD)}`,
  )

  const halted = await waitUntil('the Supervisor to escalate the halted workspace', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const rows = await prisma.supervisorDecision.findMany({ where: { workspaceId, situationKind: 'workspace_halted' } })
    note(`${String(rows.length)} workspace_halted decision(s) so far`)
    return rows.length === 0 ? null : rows
  })
  console.log(`workspace_halted decisions (${String(halted.length)}): ${halted.map(describeDecision).join('\n  ')}`)
  if (halted.length !== 1) await fail(`${String(halted.length)} workspace_halted decisions exist, expected exactly one`)
  const haltDecision = halted[0]
  if (haltDecision.subjectId !== workspaceId) {
    await fail(`the workspace_halted decision's subject is ${haltDecision.subjectId}, expected the workspace ${workspaceId}`)
  }
  if (haltDecision.status !== 'pending') await fail(`the workspace_halted decision is ${haltDecision.status}, expected pending`)
  if (haltDecision.tier !== 'escalated') await fail(`the workspace_halted decision is tier ${haltDecision.tier}, expected escalated`)
  if (haltDecision.action.kind !== 'escalate_to_human') {
    await fail(`the workspace_halted decision's action is ${String(haltDecision.action.kind)}, expected escalate_to_human`)
  }
  if (haltDecision.decidedBy !== 'rules') await fail(`the workspace_halted decision says decidedBy ${haltDecision.decidedBy}, expected rules`)
  if (haltDecision.modelCalled !== false) await fail('the Supervisor called a model about a workspace whose budget is gone')
  if (haltDecision.modelCostUsd !== null) {
    await fail(`the workspace_halted decision recorded a cost of ${String(haltDecision.modelCostUsd)}, expected null`)
  }
  console.log(`the halt itself: ${JSON.stringify(haltDecision.situation.facts)}`)
  // Not just THAT it escalated a halt, but that it escalated THIS one (final review Minor 8). The
  // two fields `observe.ts` writes into a `workspace_halted` situation are `reason` -- the durable
  // `Workspace.haltedReason` if one is set, else the guardrail name `haltOf` picked -- and
  // `budgetExhausted`. Without this the stage passed on a circuit-breaker halt, which the failing
  // runs earlier in the gate can genuinely produce, and would have reported the wrong cause as
  // proof of the budget path.
  if (haltDecision.situation.facts.reason !== 'budget_exhausted') {
    await fail(
      `the workspace_halted decision blames "${String(haltDecision.situation.facts.reason)}", expected budget_exhausted -- ` +
        'the stage blew the budget, so anything else means the workspace stopped for a different reason',
    )
  }
  if (haltDecision.situation.facts.budgetExhausted !== true) {
    await fail('the workspace_halted decision does not say the budget is exhausted, though the stage spent past it')
  }

  // The stronger form of the same claim: not just that THIS row cost nothing, but that nothing
  // written since the money ran out called anybody at all.
  const decisionsSinceHalt = (await allDecisions()).filter((row) => !idsBeforeHalt.has(row.id))
  console.log(`decisions written since the budget was blown (${String(decisionsSinceHalt.length)}):\n  ${decisionsSinceHalt.map(describeDecision).join('\n  ')}`)
  const spenders = decisionsSinceHalt.filter((row) => row.modelCalled || row.modelCostUsd !== null)
  if (spenders.length > 0) {
    await fail(`${String(spenders.length)} decision(s) made after the halt called a model: ${spenders.map(describeDecision).join('; ')}`)
  }
  console.log(
    'stage 3 complete: the daemon supervised a halted workspace, said out loud that a human has to look at it, and spent nothing ' +
      'finding that out',
  )

  // ================= Stage 4: a preview costs nothing =============================================

  // The daemon is stopped for this stage, and only for this stage. "The dry run wrote nothing" is a
  // claim about the whole database between two readings of it, and a tick landing between them
  // would be indistinguishable from the dry run having written something.
  await stopDaemon(daemons[daemons.length - 1])

  // A park the Supervisor may NOT leave on its own (erratum E5): `blocked` under a guardrail that
  // is not the review cap is `task_blocked_human`, and it exists here so the preview has a real,
  // fresh situation to print -- every other situation this workspace has is either resolved inside
  // its cooldown or already pending in front of a human.
  const parkedTask = await prisma.task.create({
    data: {
      workspaceId,
      title: PARKED_TASK_TITLE,
      description: 'Parked by a verify misconfiguration, by scripts/gate-m38-supervisor.mjs.',
      status: 'blocked',
      requiredRole: UNHELD_ROLE,
      attempt: 1,
      maxAttempts: 5,
    },
  })
  await appendEvent({
    type: 'guardrail.tripped',
    workspaceId,
    taskId: parkedTask.id,
    actor: 'system',
    payload: { guardrail: 'verify_could_not_run', detail: 'the verify command could not be run' },
  })
  console.log(`parked task ${parkedTask.id} (blocked, guardrail verify_could_not_run)`)

  const decisionsBeforePreview = await allDecisions()
  const eventsBeforePreview = await prisma.executionEvent.count({ where: { workspaceId } })
  console.log(`before the dry run: ${String(decisionsBeforePreview.length)} decision(s), ${String(eventsBeforePreview)} event(s)`)

  // `--dry-run` last: `parseArgs` swallows the second of two adjacent bare boolean flags, so a
  // boolean flag in this CLI is only safe as the final argument.
  const previewOutput = runCli(['supervise', '--workspace', workspaceId, '--dry-run'])
  console.log(`supervise --dry-run printed:\n${previewOutput}`)
  const preview = JSON.parse(previewOutput)
  if (!Array.isArray(preview)) await fail(`supervise --dry-run printed ${typeof preview}, expected an array of situations`)
  if (preview.length !== 1) {
    await fail(`the preview lists ${String(preview.length)} situation(s), expected exactly the one fresh park`)
  }
  const previewed = preview[0]
  if (previewed.situation.kind !== 'task_blocked_human' || previewed.situation.subjectId !== parkedTask.id) {
    await fail(`the preview's situation is ${previewed.situation.kind} on ${previewed.situation.subjectId}, expected task_blocked_human on ${parkedTask.id}`)
  }
  if (!Array.isArray(previewed.candidates) || previewed.candidates.length === 0) {
    await fail(`the preview offers no candidates for ${previewed.situation.kind}`)
  }
  const ruleChoice = previewed.candidates[previewed.ruleChoice]
  console.log(`the rules' own choice for the preview: index ${String(previewed.ruleChoice)} -> ${JSON.stringify(ruleChoice)}`)
  if (ruleChoice === undefined) await fail(`ruleChoice ${String(previewed.ruleChoice)} is outside the candidate list`)
  // Nothing here is routine -- an operator's park is a human's to reverse -- so the rules escalate.
  if (ruleChoice.action.kind !== 'escalate_to_human') {
    await fail(`the rules would take ${String(ruleChoice.action.kind)} on a human's park, expected escalate_to_human`)
  }

  const decisionsAfterPreview = await allDecisions()
  const eventsAfterPreview = await prisma.executionEvent.count({ where: { workspaceId } })
  console.log(`after the dry run: ${String(decisionsAfterPreview.length)} decision(s), ${String(eventsAfterPreview)} event(s)`)
  if (decisionsAfterPreview.length !== decisionsBeforePreview.length) {
    await fail(
      `the dry run wrote ${String(decisionsAfterPreview.length - decisionsBeforePreview.length)} decision row(s): ` +
        decisionsAfterPreview.filter((row) => !decisionsBeforePreview.some((before) => before.id === row.id)).map(describeDecision).join('; '),
    )
  }
  if (eventsAfterPreview !== eventsBeforePreview) {
    await fail(`the dry run appended ${String(eventsAfterPreview - eventsBeforePreview)} event(s)`)
  }
  console.log('stage 4 complete: the operator saw what the Supervisor would do, and the database is exactly what it was before')

  // ================= Stage 5: the same stuck thing is not decided twice ===========================

  const cappedKeyBefore = await prisma.supervisorDecision.count({
    where: { workspaceId, situationKind: 'review_cap_blocked', subjectId: cappedTask.id },
  })
  console.log(`decisions for (review_cap_blocked, ${cappedTask.id}) before the re-park: ${String(cappedKeyBefore)}`)

  // Re-parked exactly as it was in stage 2, and BEFORE the daemon is started again, so the pass
  // that produces the witness below is a pass that saw this.
  await prisma.task.update({ where: { id: cappedTask.id }, data: { status: 'blocked', activeRunId: null } })
  await appendEvent({
    type: 'guardrail.tripped',
    workspaceId,
    taskId: cappedTask.id,
    actor: 'system',
    payload: {
      guardrail: 'review_retry_cap_exhausted',
      detail: `task "${CAPPED_TASK_TITLE}" is at the review retry cap again, minutes after the Supervisor unblocked it.`,
    },
  })
  const reparked = await prisma.task.findUniqueOrThrow({ where: { id: cappedTask.id } })
  console.log(`capped task re-parked: status ${reparked.status}, attempt ${String(reparked.attempt)} of ${String(reparked.maxAttempts)}`)

  spawnDaemon('daemon-2')

  // The witness. `SITUATION_KINDS` orders `review_cap_blocked` BEFORE `task_blocked_human`, and
  // `observe` returns them in that order, so a pass that decided the parked task provably looked at
  // the re-parked one first and chose to leave it alone. Waiting on "a decision about the OTHER
  // task" is what turns "no second row" from "nothing has happened yet" into a measurement.
  const witness = await waitUntil('a supervised pass after the re-park', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.supervisorDecision.findFirst({
      where: { workspaceId, situationKind: 'task_blocked_human', subjectId: parkedTask.id },
    })
    note(row === null ? 'no decision about the parked task yet' : 'found it')
    return row
  })
  console.log(`the pass that ran after the re-park decided: ${describeDecision(witness)}`)

  const cappedKeyAfter = await prisma.supervisorDecision.findMany({
    where: { workspaceId, situationKind: 'review_cap_blocked', subjectId: cappedTask.id },
    orderBy: { createdAt: 'asc' },
  })
  console.log(`decisions for (review_cap_blocked, ${cappedTask.id}) after the re-park: ${String(cappedKeyAfter.length)}\n  ${cappedKeyAfter.map(describeDecision).join('\n  ')}`)
  if (cappedKeyAfter.length !== cappedKeyBefore) {
    await fail(
      `the re-parked task got ${String(cappedKeyAfter.length - cappedKeyBefore)} extra decision(s) inside its cooldown, expected none`,
    )
  }
  console.log('stage 5 complete: a situation decided minutes ago is left alone, however loudly it comes back inside its cooldown')

  const finalDecisions = await allDecisions()
  console.log(`every decision this gate produced (${String(finalDecisions.length)}):\n  ${finalDecisions.map(describeDecision).join('\n  ')}`)
  // Stage 3's "exactly one" re-read at the end, after every tick stages 4 and 5 added: a second
  // escalation about the same halt would be the cooldown failing several minutes later, which the
  // read taken the instant the first row appeared could not have seen.
  const haltRowsAtTheEnd = finalDecisions.filter((row) => row.situationKind === 'workspace_halted')
  if (haltRowsAtTheEnd.length !== 1) {
    await fail(`${String(haltRowsAtTheEnd.length)} workspace_halted decisions exist by the end of the gate, expected exactly one`)
  }
  const spendersAtTheEnd = finalDecisions.filter((row) => !idsBeforeHalt.has(row.id) && (row.modelCalled || row.modelCostUsd !== null))
  if (spendersAtTheEnd.length > 0) {
    await fail(`by the end of the gate, ${String(spendersAtTheEnd.length)} post-halt decision(s) had called a model`)
  }

  console.log(
    'PASS: the Supervisor watched a real workspace through a real daemon -- proposed the staffing it could not do by itself and ' +
      'waited for a human, took the one routine action it is trusted with and signed it as the machine, escalated a workspace ' +
      'whose money was gone without spending a cent to decide that, previewed itself without writing a row, and refused to ' +
      'decide the same stuck thing twice',
  )
  exitCode = 0
} finally {
  for (const state of daemons) {
    if (state.proc.exitCode === null && !state.exited) {
      state.proc.kill('SIGTERM')
      const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
      while (!state.exited && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
      if (!state.exited) state.proc.kill('SIGKILL')
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
    // Cascades Team/Slave/Task/SlaveRun/RunContext and SupervisorDecision.
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
