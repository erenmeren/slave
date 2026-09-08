// M36's own gate (Task 4 brief): proves the milestone's central claim end to end, with real
// processes and the FAKE `claude` CLI -- a slave asks another slave a question, its task goes
// `waiting` with no attempt charged and no failure recorded, THE ORCHESTRATOR IS STOPPED AND
// STARTED AGAIN, the answer is delivered through the operator's own CLI verb, and the waiting slave
// resumes inside its original session and finishes the work.
//
// WHY THE RESTART IS THE POINT, AND WHY THIS ONE IS REAL. A message that only lives in a running
// daemon's memory would pass every other assertion in this file. So the daemon here is genuinely
// destroyed and a genuinely different process takes its place: stage 2 records the first daemon's
// pid, sends it SIGTERM (SIGKILL if it will not go), waits for the child to exit, reaps every
// vendor child off the `SlaveRun` rows, and then asserts THREE things before starting anything --
// `process.kill(pid1, 0)` raises ESRCH, `/proc/<pid1>/cmdline` no longer reads as a daemon, and
// `findRealDaemonPids()` (`scripts/lib/daemon-process.mjs`, extracted from `gate-m17-stability.mjs`
// for this) finds no orchestrator daemon anywhere on the host. The second daemon is then confirmed
// the same way, by argv out of `/proc/<pid2>/cmdline`, and `pid2 !== pid1`. A `pgrep -f 'cli.js
// daemon'` string match would not do: it matches this gate's OWN wrapper shell (see that helper's
// header), which is exactly the kind of self-shadowing this repo has already been bitten by.
//
// AND THE SWEEP DID NOT SPARE THE WAITING ROWS BY ACCIDENT. "Nothing touched them" is an absence,
// and an absence is not evidence: a startup reconcile that never ran would look identical. So a
// DECOY orphan -- a second task, `running`, holding a `working` run with a null pid -- is planted in
// the window while no daemon is alive. The restarted daemon's startup `reconcileOrphans` fails that
// decoy (its own stdout says `reconciled 1 run(s) left behind by a previous process`, and the row
// goes `failed` with the decoy task released to `rework`), which makes the very same pass's silence
// about the waiting run a MEASURED fact: the sweep ran, it acted, and it left `paused` alone
// (`sweep.ts`'s `ORPHANABLE` excludes exactly that status -- this is that exclusion, observed).
//
// NEVER A MODEL CALL. The daemon is spawned with `SLAVEOFAI_CLAUDE_BIN=node`,
// `SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m36-flow"` and `SLAVEOFAI_REQUIRE_FAKE_CLI=1`
// (M32 item 7: lose the first two and the daemon refuses to start rather than falling back to the
// real binary), the same wiring `gate-m8a-estop.mjs` and `gate-m10-org.mjs` use. `m36-flow` is a
// synthetic mode added to the fake for this gate, and it splits the two legs on ARGV, not on
// wording: a spawn WITHOUT `--resume` is the asking leg and carries the `<slave-ask>` envelope from
// `FAKE_CLAUDE_ASK_JSON` (appended to the real `complete` capture's last assistant text block, so
// the pump reads it out of the exact stream shape a real run produces); a spawn WITH `--resume` is
// the SAME session continuing, and replays `complete` unmodified after leaving a real commit in the
// worktree. `--resume <sessionId>` is what `ClaudeCodeAdapter.resume` itself appends, so the fake
// agrees with the protocol rather than with a sentence in `deliver.ts`.
//
// STAGES
//   1. The ask. The first daemon starts the task's run; the run ends `paused` with
//      `pauseReason = waiting_for_answer`, a `Checkpoint`, one `question` message addressed to the
//      other slave, one `slave_message_sent` event, one `run_paused` event -- and the task is
//      `waiting`, still pointing at this run, with `attempt` still 0 and no `run_failed` anywhere.
//   2. The restart. Stop, prove the process is gone, plant the decoy, start again, prove the new
//      process is a different real daemon, watch its startup reconcile fail the decoy, and assert
//      the waiting run/task/question/checkpoint rows are byte-identical to the snapshot taken
//      before the old daemon died.
//   3. The answer, delivered twice. The real CLI, `answer --message <id> --text "..."`, exactly as
//      an operator types it -- twice, with the same text. The second call always reports that
//      nothing is waiting (the answer already carries a `deliveredAt`); the first is allowed either
//      outcome, because the restarted daemon's own half-second tick may legitimately deliver in the
//      window between the row committing and this process reaching its own delivery pass. What is
//      asserted instead is the thing that is actually a fact about M36: exactly one `answer` row,
//      one `run_resumed` event, and one `SlaveRun` for the task -- the session was CONTINUED, not
//      restarted (same `sessionId`, a new child pid), it reaches `succeeded`, verify passes, and the
//      task lands in `reviewing` with its `attempt` still 0.
//
// Shape borrowed from `gate-m35-pipeline-honesty.mjs` (temp git repo + `prisma.workspace.create`
// setup, `preflightCleanup()`/`dumpGateRows()`/`fail()`, "print every measured value before
// asserting it", real CLI subprocesses through `execFileSync('node', [cliPath, ...])` with
// `loopbackChildEnv()`, `exitCode` starting at 1 and set to 0 only at the very end, teardown in FK
// order) and from `gate-m8a-estop.mjs`/`gate-m13-runtime.mjs` for the daemon lifecycle.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids, isRealDaemonProcess } from './lib/daemon-process.mjs'
import { isAlive } from '../packages/control/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'

const POLL_INTERVAL_MS = 50
const DAEMON_PERIOD_MS = 500
// Generous, and every one of them bounds real work: a `git worktree add`, a fake CLI replay, a
// verify pass. Tuned to "a slow machine still passes", not to "a fast one is proven".
const DISPATCH_TIMEOUT_MS = 90_000
const WAITING_TIMEOUT_MS = 120_000
const RECONCILE_TIMEOUT_MS = 60_000
const RESUME_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

// Exact literals, never suffixed -- `preflightCleanup` removes whatever a prior crashed run left on
// this exact name, in the same FK order the `finally` block uses.
const WORKSPACE_NAME = 'M36 Gate Project'
const TASK_TITLE = 'M36 Gate Task'
const DECOY_TASK_TITLE = 'M36 Gate Decoy Task'
// A role no slave in this workspace holds, so the decoy task -- released to `rework` by the very
// reconcile pass this gate is measuring -- can never be scheduled onto anybody afterwards.
const DECOY_ROLE = 'm36-gate-nobody'
const QUESTION = 'Should this project store its numbers in Postgres or in SQLite?'
const ANSWER = 'Postgres. The instance on :5433 is already provisioned for it.'

/** Same as `gate-m35-pipeline-honesty.mjs`'s `makeRepo` -- a real repository, because the tick
 *  provisions a real worktree in it and the resumed leg commits into that worktree. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m36-repo-'))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/** Removes a leftover "M36 Gate Project" workspace a prior interrupted run left behind: events
 *  first (no FK), then the workspace (cascades Team/Slave/Task/SlaveRun/Checkpoint/SlaveMessage). */
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
          include: { tasks: true, teams: { include: { slaves: { include: { runs: { include: { checkpoint: true } } } } } } },
        })
  const events =
    workspaceId === null ? [] : await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  const messages =
    workspaceId === null ? [] : await prisma.slaveMessage.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  const daemonTails = daemons.map((d) => ({
    label: d.label,
    pid: d.proc.pid ?? null,
    exited: d.exited,
    output: d.output.length > 6_000 ? `…${d.output.slice(-6_000)}` : d.output,
  }))
  return JSON.stringify({ workspace, events, messages, daemonTails }, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

/** The `gate-m35`/`gate-m8a-estop` diagnostic throw: an Error carrying the state that made the call,
 *  not just the sentence that noticed. */
async function fail(message) {
  const dump = await dumpGateRows().catch(
    (cause) => `<could not dump gate rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
  )
  throw new Error(`${message} -- gateRows=${dump}`)
}

try {
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`orchestrator CLI not built at ${ORCHESTRATOR_CLI} -- run tsc --build first`)
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)

  // Refused rather than tolerated, for this gate's own reason (`gate-m17-stability.mjs` refuses for
  // a different one): stage 2 asserts that NO orchestrator daemon is running on this host in the
  // window between the two it owns, and a daemon somebody else left up would make that assertion a
  // lie about a process this gate never started.
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m36-messaging REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate stops and starts its own and cannot tell them apart from yours',
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
  console.log(`workspace ${workspaceId} (${WORKSPACE_NAME}), repo ${repoPath}`)

  // Without this row every dispatch refuses with `invalid_provider` (M12 Task 8) and nothing runs.
  await prisma.providerConfiguration.create({ data: { workspaceId, kind: 'claude_code', settings: {} } })

  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  const asker = await prisma.slave.create({ data: { teamId: team.id, name: 'Gate Asker', role: 'backend' } })
  // The one the question is addressed to. Its role is deliberately NOT `reviewer`: this gate stops
  // at `reviewing`, and a reviewer here would start a second run mid-assertion.
  const answerer = await prisma.slave.create({ data: { teamId: team.id, name: 'Gate Answerer', role: 'qa' } })
  console.log(`asker ${asker.id} (backend), answerer ${answerer.id} (qa)`)

  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: TASK_TITLE,
      description: 'Synthetic task driven by scripts/gate-m36-messaging.mjs.',
      status: 'ready',
      requiredRole: 'backend',
      maxAttempts: 5,
    },
  })
  console.log(`task ${task.id} (ready, backend), attempt ${task.attempt}`)

  /** The environment every child of this gate gets: the fake CLI, the refusal that guards it, and
   *  the ask envelope the asking leg writes. The recipient is a real slave id, so the envelope
   *  cannot be built anywhere but here -- see `ask.ts`'s `recipientCanAnswer`. */
  const askEnvelope = JSON.stringify({ slaveId: answerer.id, question: QUESTION })
  const childEnv = () =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m36-flow`,
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
      FAKE_CLAUDE_ASK_JSON: askEnvelope,
    })
  console.log(`ask envelope handed to the fake CLI: ${askEnvelope}`)

  /** The daemon this gate currently expects to be alive, or `null` in the window between the two.
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

  /** SIGTERM, then SIGKILL if it will not go, then wait for the child to actually be reaped. */
  async function stopDaemon(state) {
    if (activeDaemon === state) activeDaemon = null
    if (state.proc.exitCode !== null || state.exited) return
    state.proc.kill('SIGTERM')
    const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (!state.exited && Date.now() < deadline) await delay(POLL_INTERVAL_MS)
    if (!state.exited) {
      console.log(`${state.label} did not exit on SIGTERM within ${String(PROCESS_EXIT_TIMEOUT_MS)}ms -- SIGKILL`)
      state.proc.kill('SIGKILL')
      const hardDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
      while (!state.exited && Date.now() < hardDeadline) await delay(POLL_INTERVAL_MS)
    }
  }

  /** Every vendor child this gate caused, killed by pid off the `SlaveRun` rows -- `gate-m13-runtime`'s
   *  rule: a gate that exits leaving a provider process running is a gate that keeps going after it
   *  has reported. Returns the pids it had to kill (normally none: the asking run's child is long
   *  gone by the time the daemon is stopped). */
  async function reapVendorChildren() {
    const runs = await prisma.slaveRun.findMany({
      where: { slave: { team: { workspaceId } } },
      select: { id: true, pid: true },
    })
    const killed = []
    for (const run of runs) {
      if (run.pid === null || !isAlive(run.pid)) continue
      try {
        process.kill(run.pid, 'SIGKILL')
        killed.push(run.pid)
      } catch {
        // Already gone between the liveness check and the signal -- nothing to reap.
      }
    }
    return killed
  }

  // ================= Stage 1: a slave asks, and waits without failing =============================

  const daemon1 = spawnDaemon('daemon-1')
  const daemon1Pid = daemon1.proc.pid
  if (daemon1Pid === undefined) await fail('daemon-1 was spawned without a pid')

  const startedRun = await waitUntil('daemon-1 to start a run for the task', DISPATCH_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findFirst({ where: { taskId: task.id } })
    note(run === null ? 'no SlaveRun row yet' : `run ${run.id} is ${run.status}`)
    return run
  })
  console.log(`run ${startedRun.id} started (${startedRun.status})`)

  const waitingRun = await waitUntil('the run to park paused, waiting for an answer', WAITING_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findUnique({ where: { id: startedRun.id } })
    note(run === null ? 'the run row vanished' : `run is ${run.status}, pauseReason ${JSON.stringify(run.pauseReason)}`)
    return run !== null && run.status === 'paused' && run.pauseReason === 'waiting_for_answer' ? run : null
  })
  console.log(
    `run after the ask: status ${waitingRun.status}, pauseReason ${String(waitingRun.pauseReason)}, ` +
      `pausedAtStep ${String(waitingRun.pausedAtStep)}, endedAt ${JSON.stringify(waitingRun.endedAt)}, ` +
      `terminalAt ${JSON.stringify(waitingRun.terminalAt)}`,
  )
  if (waitingRun.endedAt !== null) await fail(`the waiting run has endedAt ${JSON.stringify(waitingRun.endedAt)}: it is terminal, not waiting`)
  if (waitingRun.terminalAt !== null) await fail(`the waiting run has terminalAt ${JSON.stringify(waitingRun.terminalAt)}: it is terminal, not waiting`)

  const checkpoint = await prisma.checkpoint.findUnique({ where: { runId: startedRun.id } })
  console.log(
    `checkpoint: ${checkpoint === null ? 'MISSING' : `sessionId ${checkpoint.sessionId}, pauseReason ${JSON.stringify(checkpoint.pauseReason)}`}`,
  )
  if (checkpoint === null) await fail('the waiting run has no Checkpoint: nothing could ever resume it')

  const taskWaiting = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
  console.log(
    `task after the ask: status ${taskWaiting.status}, attempt ${taskWaiting.attempt}, activeRunId ${JSON.stringify(taskWaiting.activeRunId)}`,
  )
  if (taskWaiting.status !== 'waiting') await fail(`the task is ${taskWaiting.status} after the ask, expected waiting`)
  if (taskWaiting.activeRunId !== startedRun.id) {
    await fail(`the task's activeRunId is ${JSON.stringify(taskWaiting.activeRunId)}, expected the asking run ${startedRun.id}`)
  }
  if (taskWaiting.attempt !== 0) await fail(`the task's attempt is ${taskWaiting.attempt} after the ask, expected 0 -- asking is not failing`)

  const questions = await prisma.slaveMessage.findMany({ where: { workspaceId, kind: 'question' }, orderBy: { seq: 'asc' } })
  console.log(
    `question messages: ${questions.length} -- ${JSON.stringify(
      questions.map((m) => ({ id: m.id, senderRunId: m.senderRunId, slaveId: m.slaveId, recipientSlaveId: m.recipientSlaveId, expectsReply: m.expectsReply, deliveredAt: m.deliveredAt, body: m.body })),
    )}`,
  )
  if (questions.length !== 1) await fail(`expected exactly one question message, found ${questions.length}`)
  const question = questions[0]
  if (question.senderRunId !== startedRun.id) await fail(`the question's senderRunId is ${JSON.stringify(question.senderRunId)}, expected ${startedRun.id}`)
  if (question.slaveId !== asker.id) await fail(`the question's sender slave is ${question.slaveId}, expected the asker ${asker.id}`)
  if (question.recipientSlaveId !== answerer.id) await fail(`the question is addressed to ${JSON.stringify(question.recipientSlaveId)}, expected the answerer ${answerer.id}`)
  if (!question.expectsReply) await fail('the question does not expect a reply')
  if (!question.body.includes(QUESTION)) await fail(`the question body does not carry the question the fake CLI asked -- ${JSON.stringify(question.body)}`)

  const messageSent = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'slave_message_sent' } })
  const runPaused = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'run_paused', runId: startedRun.id } })
  const runFailed = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'run_failed', runId: startedRun.id } })
  console.log(`events for the asking run: slave_message_sent ${messageSent.length}, run_paused ${runPaused.length}, run_failed ${runFailed.length}`)
  if (messageSent.length !== 1) await fail(`expected exactly one slave_message_sent event, found ${messageSent.length}`)
  if (runPaused.length !== 1) await fail(`expected exactly one run_paused event for the asking run, found ${runPaused.length}`)
  if (runFailed.length !== 0) await fail(`the asking run has ${runFailed.length} run_failed event(s): asking must not read as failing`)
  console.log('stage 1 complete: the slave asked, its task is waiting, no attempt was charged and nothing failed')

  // ================= Stage 2: the orchestrator is stopped and started again ======================

  /** The exact rows durability is a claim about, as a comparable string. Everything mutable that
   *  a sweep, a tick or a delivery pass could touch is in here; nothing that legitimately differs
   *  between two reads is. */
  async function snapshotWaitingRows() {
    const [run, taskRow, message, cp] = await Promise.all([
      prisma.slaveRun.findUnique({ where: { id: startedRun.id } }),
      prisma.task.findUnique({ where: { id: task.id } }),
      prisma.slaveMessage.findUnique({ where: { id: question.id } }),
      prisma.checkpoint.findUnique({ where: { runId: startedRun.id } }),
    ])
    return JSON.stringify({
      run:
        run === null
          ? null
          : {
              status: run.status,
              pauseReason: run.pauseReason,
              pausedAtStep: run.pausedAtStep,
              pid: run.pid,
              toolCalls: run.toolCalls,
              worktreePath: run.worktreePath,
              startedAt: run.startedAt,
              endedAt: run.endedAt,
              terminalAt: run.terminalAt,
              resumeRequestedAt: run.resumeRequestedAt,
              stopRequestedBy: run.stopRequestedBy,
            },
      task:
        taskRow === null
          ? null
          : { status: taskRow.status, attempt: taskRow.attempt, activeRunId: taskRow.activeRunId, branch: taskRow.branch },
      question:
        message === null
          ? null
          : {
              kind: message.kind,
              body: message.body,
              recipientSlaveId: message.recipientSlaveId,
              expectsReply: message.expectsReply,
              readAt: message.readAt,
              deliveredAt: message.deliveredAt,
              supersededAt: message.supersededAt,
            },
      checkpoint: cp === null ? null : { sessionId: cp.sessionId, worktreePath: cp.worktreePath, pauseReason: cp.pauseReason },
    })
  }

  const before = await snapshotWaitingRows()
  console.log(`waiting rows BEFORE the restart: ${before}`)

  console.log(`stopping daemon-1 (pid ${String(daemon1Pid)})`)
  await stopDaemon(daemon1)
  const reaped = await reapVendorChildren()
  console.log(`daemon-1 exited (code ${String(daemon1.proc.exitCode)}, signal ${String(daemon1.proc.signalCode)}); vendor children reaped: ${JSON.stringify(reaped)}`)
  if (!daemon1.exited) await fail('daemon-1 is still alive after SIGTERM and SIGKILL: the restart would not be a restart')

  // Three independent readings of "that process is gone", because this is the claim the whole
  // milestone rests on.
  let pid1Alive = true
  try {
    process.kill(daemon1Pid, 0)
  } catch (error) {
    pid1Alive = false
    console.log(`process.kill(${String(daemon1Pid)}, 0) raised ${String(error.code)} -- the old daemon's pid is gone`)
  }
  if (pid1Alive) await fail(`pid ${String(daemon1Pid)} still answers signal 0: daemon-1 is not dead`)
  const pid1StillADaemon = isRealDaemonProcess(daemon1Pid)
  console.log(`/proc/${String(daemon1Pid)}/cmdline still reads as an orchestrator daemon: ${String(pid1StillADaemon)}`)
  if (pid1StillADaemon) await fail(`/proc/${String(daemon1Pid)}/cmdline still names a daemon`)
  const betweenDaemons = findRealDaemonPids()
  console.log(`orchestrator daemons running on this host between the two: ${JSON.stringify(betweenDaemons)}`)
  if (betweenDaemons.length > 0) await fail(`an orchestrator daemon is still running between the stop and the start: ${JSON.stringify(betweenDaemons)}`)

  // The decoy orphan, planted while nothing is alive to reconcile it -- see the header.
  const decoyTask = await prisma.task.create({
    data: {
      workspaceId,
      title: DECOY_TASK_TITLE,
      description: 'A run the restarted daemon MUST reconcile, so its silence about the waiting run is a measured fact.',
      status: 'running',
      requiredRole: DECOY_ROLE,
      maxAttempts: 5,
    },
  })
  const decoyRun = await prisma.slaveRun.create({ data: { taskId: decoyTask.id, slaveId: answerer.id, status: 'working', pid: null } })
  await prisma.task.update({ where: { id: decoyTask.id }, data: { activeRunId: decoyRun.id } })
  console.log(`decoy planted: task ${decoyTask.id} (running, role ${DECOY_ROLE}), run ${decoyRun.id} (working, pid null)`)

  const daemon2 = spawnDaemon('daemon-2')
  const daemon2Pid = daemon2.proc.pid
  if (daemon2Pid === undefined) await fail('daemon-2 was spawned without a pid')
  console.log(`daemon-1 pid ${String(daemon1Pid)}, daemon-2 pid ${String(daemon2Pid)} -- different process: ${String(daemon2Pid !== daemon1Pid)}`)
  if (daemon2Pid === daemon1Pid) await fail('the restarted daemon has the same pid as the one that was stopped')

  await waitUntil('daemon-2 to appear as a real daemon in /proc', RECONCILE_TIMEOUT_MS, async (note) => {
    const real = isRealDaemonProcess(daemon2Pid)
    note(`isRealDaemonProcess(${String(daemon2Pid)}) = ${String(real)}`)
    return real ? true : null
  })
  const afterRestartDaemons = findRealDaemonPids()
  console.log(`orchestrator daemons running after the restart: ${JSON.stringify(afterRestartDaemons)}`)
  if (!afterRestartDaemons.includes(daemon2Pid)) {
    await fail(`daemon-2 (pid ${String(daemon2Pid)}) is not among the real daemons found on this host: ${JSON.stringify(afterRestartDaemons)}`)
  }

  // The restarted daemon's own startup reconcile, observed on its own stdout AND in the rows.
  await waitUntil('daemon-2 to report its startup reconcile', RECONCILE_TIMEOUT_MS, async (note) => {
    note(`daemon-2 has not printed a reconcile line yet (${String(daemon2.output.length)} bytes of output so far)`)
    return /reconciled 1 run\(s\) left behind by a previous process/.test(daemon2.output) ? true : null
  })
  const decoyRunAfter = await prisma.slaveRun.findUniqueOrThrow({ where: { id: decoyRun.id } })
  const decoyTaskAfter = await prisma.task.findUniqueOrThrow({ where: { id: decoyTask.id } })
  console.log(`decoy after the restart: run ${decoyRunAfter.status}, task ${decoyTaskAfter.status}, activeRunId ${JSON.stringify(decoyTaskAfter.activeRunId)}`)
  if (decoyRunAfter.status !== 'failed') await fail(`the decoy run is ${decoyRunAfter.status}, expected failed -- the startup reconcile did not act, so its silence about the waiting run proves nothing`)
  if (decoyTaskAfter.status !== 'rework') await fail(`the decoy task is ${decoyTaskAfter.status}, expected rework`)

  const after = await snapshotWaitingRows()
  console.log(`waiting rows AFTER the restart:  ${after}`)
  if (after !== before) await fail(`the waiting rows changed across the restart\n  before: ${before}\n  after:  ${after}`)
  const runFailedAfterRestart = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'run_failed', runId: startedRun.id } })
  console.log(`run_failed events for the waiting run after the restart: ${runFailedAfterRestart.length}`)
  if (runFailedAfterRestart.length !== 0) await fail('the restarted daemon failed the waiting run')
  console.log(
    'stage 2 complete: the daemon was destroyed and a different process took its place, that process ran its startup ' +
      'reconcile and failed a planted orphan, and the waiting run, task, question and checkpoint came through byte-identical',
  )

  // ================= Stage 3: the answer, delivered twice, resumes the slave once ================

  /** Runs the real orchestrator CLI as a subprocess, exactly as an operator's shell would. */
  function runCli(args) {
    return execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
      cwd: repoRoot,
      env: childEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  const listed = runCli(['messages', '--workspace', workspaceId])
  console.log(`messages printed:\n${listed.trim()}`)
  if (!listed.includes(question.id)) await fail(`the messages verb did not list the pending question ${question.id} -- ${JSON.stringify(listed)}`)

  const firstAnswer = runCli(['answer', '--message', question.id, '--text', ANSWER, '--by', 'the M36 gate'])
  console.log(`answer #1 printed: ${JSON.stringify(firstAnswer.trim())}`)
  // Two honest outcomes, and the gate must accept both. `answer` writes the row and then runs the
  // SAME `deliverAnswers` pass the tick runs -- so in the sub-millisecond window between the write
  // committing and this process reaching that pass, the restarted daemon's own half-second tick can
  // get there first. Then this call truthfully reports that nobody is waiting any more, because the
  // daemon has already woken them. Which of the two delivered is not a fact about M36; that exactly
  // ONE delivery and ONE resume happened is, and the row-level assertions below are what prove it.
  const deliveredByCli = firstAnswer.includes('is queued to resume')
  const deliveredByDaemon = firstAnswer.includes('No run is waiting on it right now')
  if (!deliveredByCli && !deliveredByDaemon) {
    await fail(`the first answer printed neither known outcome -- ${JSON.stringify(firstAnswer)}`)
  }
  console.log(`answer #1 delivery: ${deliveredByCli ? "this CLI call's own delivery pass" : "the restarted daemon's tick had already delivered it"}`)

  // The same answer again, the way an operator's retried command arrives: same question, same text.
  // This one IS deterministic, unlike the first: by the time it starts, the answer already carries a
  // `deliveredAt`, so no pass anywhere can claim it a second time.
  const secondAnswer = runCli(['answer', '--message', question.id, '--text', ANSWER, '--by', 'the M36 gate'])
  console.log(`answer #2 printed: ${JSON.stringify(secondAnswer.trim())}`)
  if (!secondAnswer.includes('No run is waiting on it right now')) {
    await fail(`the replayed answer was treated as a second delivery -- ${JSON.stringify(secondAnswer)}`)
  }

  const answers = await prisma.slaveMessage.findMany({ where: { workspaceId, kind: 'answer' }, orderBy: { seq: 'asc' } })
  console.log(
    `answer messages after two identical CLI calls: ${answers.length} -- ${JSON.stringify(
      answers.map((m) => ({ id: m.id, actor: m.actor, replyToId: m.replyToId, deliveredAt: m.deliveredAt, supersededAt: m.supersededAt })),
    )}`,
  )
  if (answers.length !== 1) await fail(`expected exactly one answer row after two identical answers, found ${answers.length}`)
  if (answers[0].replyToId !== question.id) await fail(`the answer replies to ${JSON.stringify(answers[0].replyToId)}, expected the question ${question.id}`)
  if (answers[0].actor !== 'human') await fail(`the operator's answer has actor ${answers[0].actor}, expected human`)
  if (answers[0].deliveredAt === null) await fail('the answer was never marked delivered')
  if (answers[0].supersededAt !== null) await fail(`the only answer is marked superseded (${JSON.stringify(answers[0].supersededAt)})`)

  // The resume itself belongs to the RESTARTED daemon: the CLI only recorded the intent.
  const observedRunStatuses = []
  const observedTaskStatuses = []
  const finishedRun = await waitUntil('the restarted daemon to resume the waiting run and finish it', RESUME_TIMEOUT_MS, async (note) => {
    const [run, taskNow] = await Promise.all([
      prisma.slaveRun.findUnique({ where: { id: startedRun.id } }),
      prisma.task.findUnique({ where: { id: task.id } }),
    ])
    if (run !== null && observedRunStatuses.at(-1) !== run.status) observedRunStatuses.push(run.status)
    if (taskNow !== null && observedTaskStatuses.at(-1) !== taskNow.status) observedTaskStatuses.push(taskNow.status)
    note(`run ${run === null ? 'missing' : run.status}, task ${taskNow === null ? 'missing' : taskNow.status}`)
    return run !== null && run.status === 'succeeded' ? run : null
  })
  console.log(`run statuses observed after the answer: ${observedRunStatuses.join(' -> ')}`)
  console.log(`task statuses observed after the answer: ${observedTaskStatuses.join(' -> ')}`)
  console.log(`resumed run: status ${finishedRun.status}, endedAt ${JSON.stringify(finishedRun.endedAt)}, toolCalls ${finishedRun.toolCalls}`)
  if (finishedRun.endedAt === null) await fail('the resumed run reports succeeded with no endedAt')
  // The pid on the row is rewritten by `executeResume` with the pid of the child it spawned. It
  // moved, so a SECOND provider process was started for this run AFTER the restart -- and the only
  // thing alive that could have started one is daemon-2. The CLI `answer` verb records the intent
  // and never spawns (`deliver.ts`: "control does not spawn children").
  console.log(`run pid before the restart ${String(waitingRun.pid)}, after the resume ${String(finishedRun.pid)}`)
  if (finishedRun.pid === null || finishedRun.pid === waitingRun.pid) {
    await fail(`the run's pid is still ${String(finishedRun.pid)}: no new child was spawned, so nothing actually resumed`)
  }
  if (finishedRun.pauseReason !== null) await fail(`the resumed run still carries pauseReason ${JSON.stringify(finishedRun.pauseReason)}`)

  const runsForTask = await prisma.slaveRun.findMany({ where: { taskId: task.id } })
  console.log(`SlaveRun rows for the task: ${runsForTask.length} -- ${JSON.stringify(runsForTask.map((r) => ({ id: r.id, status: r.status })))}`)
  if (runsForTask.length !== 1) {
    await fail(`the task has ${runsForTask.length} runs: the answer started a NEW run instead of continuing the waiting one`)
  }
  const checkpointAfter = await prisma.checkpoint.findUniqueOrThrow({ where: { runId: startedRun.id } })
  console.log(`checkpoint sessionId before ${checkpoint.sessionId}, after ${checkpointAfter.sessionId}`)
  if (checkpointAfter.sessionId !== checkpoint.sessionId) {
    await fail(`the session id changed from ${checkpoint.sessionId} to ${checkpointAfter.sessionId}: this was not the same session continuing`)
  }

  const resumedEvents = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'run_resumed', runId: startedRun.id } })
  console.log(`run_resumed events for the run: ${resumedEvents.length}`)
  if (resumedEvents.length !== 1) await fail(`expected exactly one run_resumed event, found ${resumedEvents.length} -- the answer was delivered twice`)

  const taskFinal = await waitUntil('the task to advance past the resumed run', RESUME_TIMEOUT_MS, async (note) => {
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    note(`task is ${row.status}`)
    return row.status === 'reviewing' ? row : null
  })
  console.log(`task after the resumed run: status ${taskFinal.status}, attempt ${taskFinal.attempt}, activeRunId ${JSON.stringify(taskFinal.activeRunId)}, branch ${JSON.stringify(taskFinal.branch)}`)
  if (taskFinal.attempt !== 0) await fail(`the task's attempt is ${taskFinal.attempt}: the ask/answer round trip charged one`)
  const verifyPassed = await prisma.executionEvent.findMany({ where: { workspaceId, taskId: task.id, type: 'task_verify_passed' } })
  console.log(`task_verify_passed events: ${verifyPassed.length}`)
  if (verifyPassed.length !== 1) await fail(`expected exactly one task_verify_passed event, found ${verifyPassed.length}`)
  console.log('stage 3 complete: one answer, one resume, the same session, the work finished and verified')

  console.log(
    'PASS: a slave asked another slave a question and waited without failing; the orchestrator was stopped and a ' +
      'different process started in its place; the waiting rows survived that restart untouched while the same ' +
      "startup sweep failed a planted orphan; and the operator's answer -- delivered twice -- resumed the original " +
      'session exactly once, which then finished and verified its work',
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
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
