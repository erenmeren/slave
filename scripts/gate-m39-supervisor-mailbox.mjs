// M39's own gate (Task 5 brief): proves the milestone's central claim end to end, against a REAL
// daemon and the FAKE `claude` CLI -- a question one slave asked another no longer waits on a
// human by default. The Supervisor reads the mailbox and, for each pending question, answers it
// itself when every quote it cites is really there, drafts an answer for a person when it is not,
// refuses to answer at all when a deterministic list of words says only a human may, or puts the
// question in front of somebody who can actually reply. And the decision rows it leaves behind
// stop being kept once they are a month old.
//
// NEVER A MODEL CALL. Every daemon here is spawned with `SLAVEOFAI_CLAUDE_BIN=node`,
// `SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m36-flow [--answer-fixture <name>]"` and
// `SLAVEOFAI_REQUIRE_FAKE_CLI=1` (M32 item 7: lose the first two and the daemon refuses to start
// rather than falling back to the real binary) -- the same wiring `gate-m36-messaging.mjs` and
// `gate-m38-supervisor.mjs` use. `m36-flow` runs the asking leg (a `<slave-ask>` block patched in
// from `FAKE_CLAUDE_ASK_JSON`) and the resumed leg (a real commit, then `complete`), and every
// flow mode also carries the two Supervisor arms: a prompt containing `"candidateIndex"` replays
// `supervisor-decision` (index 0, $0.01) and one containing `"sources"` replays the fixture named
// by `--answer-fixture` (errata E3 and E6), which is how one gate gets both a sourced answer
// ($0.02, quoting "PostgreSQL on port 5433") and an unsourced one (quoting a sentence nobody
// wrote) without a mode of its own. So the Supervisor's "model" here is three files on disk, and
// the costs on the rows are what say which of them were opened.
//
// WHY THE QA REVIEWER KEEPS LOSING ITS ROLE. `ask.ts` refuses an ask addressed to a role no other
// slave in the workspace holds -- parking a task to wait for nobody is the bug that check exists to
// prevent -- so a question can only BECOME unanswerable after it was asked. That is exactly the
// real story `unanswerable_question` is for: the one QA in the project stops being dispatchable as
// one while the question is in flight. So each of the first three stages seeds `Qa` with the role,
// lets Dev's run ask it a question, and then takes the role away with the operator's own
// `set-runtime-roles --roles ''`. Nothing races: a fresh question whose role still has a holder
// raises no situation at all (`waiting_stale` needs half an hour), so the situation appears when,
// and only when, the roster changes.
//
// WHY STAGES 4 AND 5 RUN `tick` RATHER THAN A DAEMON. A one-shot `orchestrator tick` deliberately
// carries no model decider (`cli.ts`: "a command an operator runs by hand must never start
// spending on model calls"), so its Supervisor pass decides BY THE RULES -- which is the only way
// to see the routine half of the mailbox. `chooseByRules` prefers the single routine candidate,
// and on a stale question with an idle holder that candidate is the re-address; with a model wired
// the fixture's index 0 would always be the answer instead. Stage 5 uses the same command because
// `pruneDecisions` runs on every pass, model or no model.
//
// STAGES
//   1. An answer the Supervisor can prove is sent by itself. Dev asks the `qa` role a question
//      whose answer is a sentence in its own task description; the role loses its holder; the
//      Supervisor chooses `answer_question`, drafts one, verifies the quote in code and the row is
//      `applied`/`applied` with `draft.confidence: 'sourced'`, two calls' costs on it, and an
//      `answer` message whose envelope actor is `system` and whose payload says `answeredBy:
//      'supervisor'`. A LATER tick's `deliverAnswers` resumes the waiting run and it concludes.
//   2. An answer it cannot prove waits for a person -- and the person may rewrite it. The same
//      shape with `--answer-fixture supervisor-answer-unsourced`: the row is
//      `proposed`/`pending`, `draft.confidence: 'interpretation'` with the rejected citation on
//      it, and NO answer message exists. `approve-decision --id <id> --body-file <path>` sends the
//      operator's own words instead: the answer row carries the edited text, the row keeps both
//      (`draft.editedBody` beside the model's `draft.body`), and the run resumes.
//   3. Some questions are not answerable by a machine at all. A question that says "which API key
//      should I use" is escalated by the deterministic lexicon BEFORE any answer call is made
//      (erratum E2) -- and the fixture this stage's daemon carries is the SOURCED one, so what stopped the
//      answer is provably the lexicon and not a fixture that could not produce a quote. The row is
//      `escalated`/`pending` with `draft.body: null`, `draft.critical.lexicon` naming `secrets`,
//      `modelCalled: true` and a cost of exactly the choice call's $0.01: the second call never
//      happened.
//   4. A question can be re-addressed instead of answered. A `backend`-addressed question from
//      Dev's parked run, aged past the staleness threshold, with Dev busy and a second `backend`
//      holder idle: the rules apply `reassign_question` themselves, the QUESTION ROW moves
//      (`recipientSlaveId` set, `recipientRole` cleared) and `slave.message_reassigned` names the
//      decision behind it.
//   5. Decisions are history, and history is not kept forever -- except the ones that are money.
//      A resolved row 31 days old that called no model is gone after a tick; a PENDING row of the
//      same age is still there; and a resolved row of the same age that DID call a model is still
//      there with its cost, leaving `workspaceSpend` exactly where it was (erratum E7).
//
// Shape borrowed from `gate-m38-supervisor.mjs` (temp git repo + `prisma.workspace.create` setup,
// `preflightCleanup()`/`dumpGateRows()`/`fail()`/`waitUntil()`, the daemon lifecycle and its
// `findRealDaemonPids()` refusal, "print every measured value before asserting it", real CLI
// subprocesses through `execFileSync('node', [cliPath, ...])` with `loopbackChildEnv()`, `exitCode`
// starting at 1 and set to 0 only at the very end, teardown in FK order) and from
// `gate-m36-messaging.mjs` for the ask leg and the resume.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids } from './lib/daemon-process.mjs'
import { prisma } from '../packages/db/dist/client.js'
import { isAlive, sendMessage, workspaceSpend } from '../packages/control/dist/index.js'

const POLL_INTERVAL_MS = 50
const DAEMON_PERIOD_MS = 500
// Generous, and every one of them bounds real work: a `git worktree add`, a fake CLI replay, a
// verify pass, a supervised tick, a resume. Tuned to "a slow machine still passes".
const DISPATCH_TIMEOUT_MS = 90_000
const WAITING_TIMEOUT_MS = 180_000
const SUPERVISOR_TIMEOUT_MS = 120_000
const RESUME_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')

// Exact literals, never suffixed -- `preflightCleanup` removes whatever a prior crashed run left on
// this exact name, in the same FK order the `finally` block uses.
const WORKSPACE_NAME = 'M39 Gate Project'
const SOURCED_TASK_TITLE = 'M39 Gate Sourced Task'
const DRAFT_TASK_TITLE = 'M39 Gate Draft Task'
const CRITICAL_TASK_TITLE = 'M39 Gate Critical Task'

/** The sentence `supervisor-answer.ndjson` cites, verbatim. It is in every gate task's description
 *  because that is what makes stage 1 a MEASUREMENT: `verifySources` looks the quote up in the
 *  asking task's own text, so the answer is sent because the evidence is really there. Stage 2's
 *  fixture cites "this sentence appears nowhere" against the same description, which is the same
 *  check failing. */
const SOURCED_QUOTE = 'PostgreSQL on port 5433'
const TASK_DESCRIPTION =
  `Synthetic task driven by scripts/gate-m39-supervisor-mailbox.mjs. The service talks to ` +
  `${SOURCED_QUOTE} in every environment, including the gate's own.`

/** What one call of each fixture reports as `total_cost_usd`. Stage 1 and 2 pay for both; stage 3
 *  pays for the choice alone, which is the whole of erratum E2's claim. */
const FIXTURE_CHOICE_COST_USD = 0.01
const FIXTURE_ANSWER_COST_USD = 0.02

/** The role the questions are addressed to, and the one whose holder keeps being taken away -- see
 *  the header. Deliberately not `reviewer`: a reviewer here would start a review run mid-stage. */
const ASKED_ROLE = 'qa'

/** Stage 4's question, addressed to a role that DOES have holders, and older than
 *  `WAITING_STALE_MS` (30 minutes) by the time the tick looks at it. */
const STALE_BY_MS = 45 * 60_000
const BACKEND_QUESTION = 'Which migration should the new column go in?'

/** Stage 5's three synthetic rows, and the age that makes history of the one that is prunable.
 *  `DECISION_RETENTION_MS` is 30 days. */
const RETENTION_AGE_MS = 31 * 86_400_000
const PRUNED_SUBJECT = 'gate-m39-resolved-31-days-old'
const KEPT_SUBJECT = 'gate-m39-pending-31-days-old'
/** Resolved 31 days ago like the prunable row, and different in exactly one column: it called a
 *  model and carries what that cost. Erratum E7 keeps it -- `workspaceSpend` sums these rows over
 *  all time, so pruning one would erase money a project really spent. */
const PAID_SUBJECT = 'gate-m39-resolved-31-days-old-with-a-cost'
const PAID_COST_USD = 0.42

/** Same as `gate-m38-supervisor.mjs`'s -- a real repository, because the tick provisions a real
 *  worktree in it and the fake CLI commits into that worktree. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m39-repo-'))
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
 *  RunContext/SlaveMessage and SupervisorDecision. This gate creates no org rows and no skill rows,
 *  so there is nothing else of its own anywhere in the database. */
async function preflightCleanup() {
  const stale = await prisma.workspace.findUnique({ where: { name: WORKSPACE_NAME } })
  if (stale === null) return
  console.log(`preflight: removing a leftover ${WORKSPACE_NAME} (${stale.id}) from an earlier interrupted run`)
  await prisma.executionEvent.deleteMany({ where: { workspaceId: stale.id } }).catch(() => {})
  await prisma.workspace.delete({ where: { id: stale.id } }).catch(() => {})
}

let exitCode = 1
let repoPath = null
let bodyDir = null
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
  const messages =
    workspaceId === null ? [] : await prisma.slaveMessage.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
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
  return JSON.stringify({ workspace, events, messages, decisions, daemonTails }, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

/** The `gate-m35`/`gate-m38` diagnostic throw: an Error carrying the state that made the call, not
 *  just the sentence that noticed. */
async function fail(message) {
  const dump = await dumpGateRows().catch(
    (cause) => `<could not dump gate rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
  )
  throw new Error(`${message} -- gateRows=${dump}`)
}

/** A decision row as this gate prints it, DRAFT included: the draft is what four of the five stages
 *  assert on, and a failure that shows only ids is a failure nobody can diagnose from the log. */
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

/** A message row as this gate prints it. */
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

/** Two dollar amounts are equal when they are equal as money, not as floats: 0.01 + 0.02 is
 *  0.030000000000000002 in IEEE 754, and a gate that asserted `===` on that would be measuring the
 *  arithmetic rather than the milestone. */
const sameMoney = (actual, expected) => actual !== null && Math.abs(actual - expected) < 1e-9

try {
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`orchestrator CLI not built at ${ORCHESTRATOR_CLI} -- run tsc --build first`)
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)

  // Refused rather than tolerated (`gate-m36`/`gate-m38`'s own refusal): this gate spawns and stops
  // daemons of its own and counts what one supervised pass wrote, and a second daemon somebody else
  // left running would be ticking other workspaces -- and holding the global concurrency budget
  // this one's runs need.
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m39-supervisor-mailbox REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate starts and stops daemons of its own and measures exactly what one supervised pass wrote',
    )
  }

  await preflightCleanup()

  // ---- Setup ------------------------------------------------------------------------------------
  repoPath = makeRepo()
  bodyDir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m39-body-'))

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
    `workspace ${workspaceId} (${WORKSPACE_NAME}), repo ${repoPath}, supervisorEnabled ${String(workspace.supervisorEnabled)}`,
  )
  if (!workspace.supervisorEnabled) await fail('a new workspace starts with its Supervisor switched off')

  // Without this row every dispatch refuses with `invalid_provider` (M12 Task 8) and nothing runs.
  await prisma.providerConfiguration.create({ data: { workspaceId, kind: 'claude_code', settings: {} } })

  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  // The only worker who can be dispatched the gate's tasks, and therefore the only asker.
  const dev = await prisma.slave.create({
    data: { teamId: team.id, name: 'Dev', role: 'Senior Engineer', runtimeRoles: ['backend'] },
  })
  // The recipient the first three questions are addressed to -- by ROLE, and the role is taken away
  // from it after each ask (see the header). It holds no task-shaped role, so the scheduler never
  // dispatches it and it never answers anything.
  const qa = await prisma.slave.create({
    data: { teamId: team.id, name: 'Quinn', role: 'QA Engineer', runtimeRoles: [ASKED_ROLE] },
  })
  console.log(
    `slaves: Dev ${dev.id} runtimeRoles ${JSON.stringify(dev.runtimeRoles)}, Quinn ${qa.id} runtimeRoles ${JSON.stringify(qa.runtimeRoles)}`,
  )

  /**
   * The environment a child of this gate gets: the fake CLI, the refusal that guards it, and
   * whatever the current stage's daemon needs on top -- the ask envelope its asking leg patches
   * into the stream (`FAKE_CLAUDE_ASK_JSON`, read by a RUN, which does inherit the daemon's
   * environment) and the answer fixture its `"sources"` arm replays.
   *
   * The answer fixture rides on `SLAVEOFAI_CLAUDE_ARGS`, NOT on `FAKE_CLAUDE_ANSWER_FIXTURE`
   * (erratum E6). A decision call's child is spawned with `buildDecisionEnv()` -- PATH, HOME, LANG,
   * TERM and nothing else, so a simulation actor never sees `DATABASE_URL` (M31a §4 ruling R1) --
   * so an env var exported here could never reach the answer arm, and a gate that set one would
   * quietly measure the DEFAULT (sourced) fixture while believing it had asked for the unsourced
   * one. `extraArgs` do reach it: `decisionArgs` puts them first, which is already how `--fixture`
   * arrives.
   */
  const childEnv = ({ askJson, answerFixture } = {}) =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS:
        `${FAKE_CLAUDE} --fixture m36-flow` +
        (answerFixture === undefined ? '' : ` --answer-fixture ${answerFixture}`),
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
      ...(askJson === undefined ? {} : { FAKE_CLAUDE_ASK_JSON: askJson }),
    })

  /** Runs the real orchestrator CLI as a subprocess, exactly as an operator's shell would. */
  const runCli = (args) =>
    execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
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
    console.log(`${label} spawned as pid ${String(proc.pid)} with ${JSON.stringify(stage)}`)
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

  /** The operator's own command, and the roster change that makes a question unanswerable. */
  const setQaRoles = (roles) => {
    const printed = runCli(['set-runtime-roles', '--slave', qa.id, '--roles', roles])
    console.log(`set-runtime-roles printed: ${JSON.stringify(printed.trim())}`)
  }

  /** One task for one stage, `ready` and dispatchable only by Dev. */
  const makeTask = (title) =>
    prisma.task.create({
      data: { workspaceId, title, description: TASK_DESCRIPTION, status: 'ready', requiredRole: 'backend', maxAttempts: 5 },
    })

  /** The run the daemon started for `taskId`, once it has parked itself on a question, and the
   *  question it asked. Both stages 1-3 begin exactly here. */
  async function askedQuestion(label, taskId) {
    const started = await waitUntil(`${label} to start a run for the task`, DISPATCH_TIMEOUT_MS, async (note) => {
      const run = await prisma.slaveRun.findFirst({ where: { taskId } })
      note(run === null ? 'no SlaveRun row yet' : `run ${run.id} is ${run.status}`)
      return run
    })
    const waiting = await waitUntil('the run to park paused, waiting for an answer', WAITING_TIMEOUT_MS, async (note) => {
      const run = await prisma.slaveRun.findUnique({ where: { id: started.id } })
      note(run === null ? 'the run row vanished' : `run is ${run.status}, pauseReason ${JSON.stringify(run.pauseReason)}`)
      return run !== null && run.status === 'paused' && run.pauseReason === 'waiting_for_answer' ? run : null
    })
    const question = await waitUntil('the question row the run asked', SUPERVISOR_TIMEOUT_MS, async (note) => {
      const row = await prisma.slaveMessage.findFirst({ where: { workspaceId, kind: 'question', senderRunId: waiting.id } })
      note(row === null ? 'no question row yet' : `question ${row.id}`)
      return row
    })
    console.log(`${label}: run ${waiting.id} is ${waiting.status}/${String(waiting.pauseReason)}`)
    console.log(`${label}: question ${describeMessage(question)}`)
    // Waited for rather than read once. `concludeWithQuestion` writes in this order -- checkpoint,
    // message, claim the run `paused`, park the task `waiting` -- and the first three are already
    // done by the time the two waits above return, so a single read here genuinely catches the task
    // still `running` a millisecond before its park lands. Missing after this wait is a real
    // defect; missing immediately is a gate racing the verb.
    const parkedTask = await waitUntil(`${label}'s task to park waiting`, WAITING_TIMEOUT_MS, async (note) => {
      const row = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
      note(`task is ${row.status}`)
      return row.status === 'waiting' ? row : null
    })
    console.log(`${label}: task ${taskId} is ${parkedTask.status}`)
    return { run: waiting, question }
  }

  /** The Supervisor's decision about one question, once it has written one. */
  const decisionFor = (label, kind, messageId) =>
    waitUntil(`the Supervisor to decide the ${kind} about ${label}`, SUPERVISOR_TIMEOUT_MS, async (note) => {
      const rows = await prisma.supervisorDecision.findMany({ where: { workspaceId, situationKind: kind, subjectId: messageId } })
      note(`${String(rows.length)} ${kind} decision(s) so far`)
      return rows.length === 0 ? null : rows[0]
    })

  /** Every answer written in reply to one question. */
  const answersTo = (questionId) =>
    prisma.slaveMessage.findMany({ where: { workspaceId, kind: 'answer', replyToId: questionId }, orderBy: { seq: 'asc' } })

  /** Waits for the parked run to be resumed by its answer and to conclude. The resume belongs to a
   *  LATER tick than the one that answered -- `deliverAnswers` runs at the START of a tick and the
   *  Supervisor at its end -- which is why this is a wait and never a read. */
  async function resumedAndConcluded(label, parked) {
    const finished = await waitUntil(`${label} to resume and conclude`, RESUME_TIMEOUT_MS, async (note) => {
      const run = await prisma.slaveRun.findUnique({ where: { id: parked.id } })
      note(run === null ? 'the run row vanished' : `run is ${run.status}`)
      return run !== null && run.status === 'succeeded' ? run : null
    })
    console.log(
      `${label}: resumed run ${finished.id} is ${finished.status}, endedAt ${JSON.stringify(finished.endedAt)}, ` +
        `pauseReason ${JSON.stringify(finished.pauseReason)}, pid before ${String(parked.pid)} after ${String(finished.pid)}`,
    )
    if (finished.endedAt === null) await fail(`${label}: the resumed run reports succeeded with no endedAt`)
    if (finished.pauseReason !== null) {
      await fail(`${label}: the resumed run still carries pauseReason ${JSON.stringify(finished.pauseReason)}`)
    }
    // A SECOND provider process was started for this run after it parked, which is what "resumed"
    // means: `executeResume` writes the new child's pid back over the null the ask left.
    if (finished.pid === null) await fail(`${label}: the run has no pid after the resume, so nothing actually resumed it`)
    const runsForTask = await prisma.slaveRun.findMany({ where: { taskId: finished.taskId } })
    console.log(`${label}: SlaveRun rows for the task: ${String(runsForTask.length)}`)
    if (runsForTask.length !== 1) {
      await fail(`${label}: the task has ${String(runsForTask.length)} runs -- the answer started a NEW run instead of continuing the waiting one`)
    }
    return finished
  }

  // ================= Stage 1: an answer it can prove is sent by itself ============================

  const sourcedTask = await makeTask(SOURCED_TASK_TITLE)
  console.log(`stage 1 task ${sourcedTask.id} (ready, backend), description ${JSON.stringify(TASK_DESCRIPTION)}`)

  const daemon1 = spawnDaemon('daemon-1', {
    askJson: JSON.stringify({ role: ASKED_ROLE, question: 'Which database should this service connect to?' }),
    answerFixture: 'supervisor-answer',
  })

  const stage1 = await askedQuestion('stage 1', sourcedTask.id)

  // The roster change that makes the question unanswerable -- and the whole reason stage 1 has a
  // situation to decide. Until this runs, a fresh question to a role somebody holds is not stuck.
  setQaRoles('')

  const sourcedDecision = await decisionFor('stage 1', 'unanswerable_question', stage1.question.id)
  console.log(`stage 1 decision: ${describeDecision(sourcedDecision)}`)
  console.log(`  situation: ${JSON.stringify(sourcedDecision.situation)}`)

  if (sourcedDecision.action.kind !== 'answer_question') {
    await fail(`stage 1 chose ${String(sourcedDecision.action.kind)}, expected answer_question`)
  }
  if (sourcedDecision.action.messageId !== stage1.question.id) {
    await fail(`stage 1 answered ${String(sourcedDecision.action.messageId)}, expected the question ${stage1.question.id}`)
  }
  if (sourcedDecision.tier !== 'applied') await fail(`stage 1's decision is tier ${sourcedDecision.tier}, expected applied`)
  if (sourcedDecision.status !== 'applied') await fail(`stage 1's decision is ${sourcedDecision.status}, expected applied`)
  if (sourcedDecision.failureReason !== null) await fail(`stage 1's decision records a failure: ${String(sourcedDecision.failureReason)}`)
  if (sourcedDecision.decidedBy !== 'model') await fail(`stage 1's decision says decidedBy ${sourcedDecision.decidedBy}, expected model`)
  if (sourcedDecision.modelCalled !== true) await fail('stage 1: the Supervisor wrote an answer without calling a model')
  // Both calls, added: the choice and the answer. This is the number that says the second call
  // really happened -- and stage 3 asserts its absence with the same column.
  if (!sameMoney(sourcedDecision.modelCostUsd, FIXTURE_CHOICE_COST_USD + FIXTURE_ANSWER_COST_USD)) {
    await fail(
      `stage 1 recorded modelCostUsd ${String(sourcedDecision.modelCostUsd)}, expected the two fixtures' ` +
        `${String(FIXTURE_CHOICE_COST_USD + FIXTURE_ANSWER_COST_USD)}`,
    )
  }

  const sourcedDraft = sourcedDecision.draft
  if (sourcedDraft === null) await fail('stage 1: the answer decision carries no draft')
  if (sourcedDraft.confidence !== 'sourced') {
    await fail(`stage 1's draft is ${String(sourcedDraft.confidence)}, expected sourced`)
  }
  if (!Array.isArray(sourcedDraft.sources) || sourcedDraft.sources.length === 0) {
    await fail(`stage 1's draft cites nothing: ${JSON.stringify(sourcedDraft.sources)}`)
  }
  if (!sourcedDraft.sources.some((source) => source.quote === SOURCED_QUOTE)) {
    await fail(`stage 1's verified citations do not include ${JSON.stringify(SOURCED_QUOTE)}: ${JSON.stringify(sourcedDraft.sources)}`)
  }
  if (!Array.isArray(sourcedDraft.rejectedSources) || sourcedDraft.rejectedSources.length !== 0) {
    await fail(`stage 1's draft has rejected citations though it was called sourced: ${JSON.stringify(sourcedDraft.rejectedSources)}`)
  }

  const sourcedAnswers = await waitUntil('the Supervisor answer to be written', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const rows = await answersTo(stage1.question.id)
    note(`${String(rows.length)} answer(s) so far`)
    return rows.length === 0 ? null : rows
  })
  console.log(`stage 1 answers (${String(sourcedAnswers.length)}): ${sourcedAnswers.map(describeMessage).join('\n  ')}`)
  if (sourcedAnswers.length !== 1) await fail(`stage 1 wrote ${String(sourcedAnswers.length)} answers, expected exactly one`)
  const sourcedAnswer = sourcedAnswers[0]
  // The envelope actor of a machine's answer. `human` here would mean a person was credited with
  // words nobody typed.
  if (sourcedAnswer.actor !== 'system') await fail(`stage 1's answer row says actor ${sourcedAnswer.actor}, expected system`)
  if (sourcedAnswer.body !== sourcedDraft.body) {
    await fail(`stage 1 sent ${JSON.stringify(sourcedAnswer.body)}, expected the draft's own ${JSON.stringify(sourcedDraft.body)}`)
  }
  if (!sourcedAnswer.body.includes(SOURCED_QUOTE)) {
    await fail(`stage 1's answer does not carry the quote it was sourced from: ${JSON.stringify(sourcedAnswer.body)}`)
  }

  const sentEvent = await waitUntil('the slave.message_sent event for the answer', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.executionEvent.findFirst({
      where: { workspaceId, type: 'slave_message_sent' },
      orderBy: { seq: 'desc' },
    })
    note(row === null ? 'no slave.message_sent event yet' : `newest names message ${String(row.payload.messageId)}`)
    return row !== null && row.payload.messageId === sourcedAnswer.id ? row : null
  })
  console.log(`stage 1 slave.message_sent: actor ${sentEvent.actor}, payload ${JSON.stringify(sentEvent.payload)}`)
  if (sentEvent.actor !== 'system') await fail(`stage 1's answer envelope says actor ${sentEvent.actor}, expected system`)
  if (sentEvent.payload.answeredBy !== 'supervisor') {
    await fail(`stage 1's answer says answeredBy ${String(sentEvent.payload.answeredBy)}, expected supervisor`)
  }

  await resumedAndConcluded('stage 1', stage1.run)
  console.log(
    'stage 1 complete: the Supervisor read a question nobody could answer, found the answer in the asking task, checked the quote ' +
      'in code, sent it as the machine -- and the next tick woke the run that had been waiting for it',
  )

  // ================= Stage 2: an answer it cannot prove waits for a person ========================

  await stopDaemon(daemon1)
  setQaRoles(ASKED_ROLE)

  const draftTask = await makeTask(DRAFT_TASK_TITLE)
  console.log(`stage 2 task ${draftTask.id} (ready, backend)`)

  const daemon2 = spawnDaemon('daemon-2', {
    askJson: JSON.stringify({ role: ASKED_ROLE, question: 'Which connection string should the migration use?' }),
    // The same shape of answer, citing a sentence that is in no source at all (erratum E3: the
    // fixture is chosen per daemon spawn, so one gate sees both sides of "sourced").
    answerFixture: 'supervisor-answer-unsourced',
  })

  const stage2 = await askedQuestion('stage 2', draftTask.id)
  setQaRoles('')

  const draftDecision = await decisionFor('stage 2', 'unanswerable_question', stage2.question.id)
  console.log(`stage 2 decision: ${describeDecision(draftDecision)}`)
  if (draftDecision.action.kind !== 'answer_question') {
    await fail(`stage 2 chose ${String(draftDecision.action.kind)}, expected answer_question`)
  }
  if (draftDecision.tier !== 'proposed') await fail(`stage 2's decision is tier ${draftDecision.tier}, expected proposed`)
  if (draftDecision.status !== 'pending') await fail(`stage 2's decision is ${draftDecision.status}, expected pending`)
  if (draftDecision.modelCalled !== true) await fail('stage 2: no model call was recorded for a drafted answer')
  if (!sameMoney(draftDecision.modelCostUsd, FIXTURE_CHOICE_COST_USD + FIXTURE_ANSWER_COST_USD)) {
    await fail(`stage 2 recorded modelCostUsd ${String(draftDecision.modelCostUsd)}, expected both calls`)
  }
  const unsourcedDraft = draftDecision.draft
  if (unsourcedDraft === null) await fail('stage 2: the proposal carries no draft for a human to read')
  if (unsourcedDraft.confidence !== 'interpretation') {
    await fail(`stage 2's draft is ${String(unsourcedDraft.confidence)}, expected interpretation`)
  }
  if (!Array.isArray(unsourcedDraft.rejectedSources) || unsourcedDraft.rejectedSources.length === 0) {
    await fail(`stage 2's draft names no rejected citation, so nothing says WHY it is an interpretation: ${JSON.stringify(unsourcedDraft)}`)
  }
  console.log(`stage 2 rejected citations: ${JSON.stringify(unsourcedDraft.rejectedSources)}`)
  if (unsourcedDraft.editedBody !== undefined && unsourcedDraft.editedBody !== null) {
    await fail(`stage 2's draft already carries an edit nobody made: ${JSON.stringify(unsourcedDraft.editedBody)}`)
  }

  // The measured negative, and the whole point of the tier: a draft is not an answer.
  const beforeApproval = await answersTo(stage2.question.id)
  console.log(`stage 2 answers while the proposal is pending: ${String(beforeApproval.length)}`)
  if (beforeApproval.length !== 0) {
    await fail(`stage 2 sent ${String(beforeApproval.length)} answer(s) for a proposal nobody approved: ${beforeApproval.map(describeMessage).join('; ')}`)
  }
  const stillWaiting = await prisma.slaveRun.findUniqueOrThrow({ where: { id: stage2.run.id } })
  console.log(`stage 2 run while the proposal is pending: ${stillWaiting.status}/${String(stillWaiting.pauseReason)}`)
  if (stillWaiting.status !== 'paused') await fail(`stage 2's run is ${stillWaiting.status} though nobody answered it`)

  // The operator's own words, in a file, the way `--body-file` is meant to be used: written in an
  // editor and read UNTRIMMED, trailing newline and all.
  const EDITED_BODY = 'Use the staging connection string from the deploy notes, not the one in the task text.\n'
  const bodyPath = join(bodyDir, 'edited-answer.txt')
  writeFileSync(bodyPath, EDITED_BODY)
  const approveOutput = runCli(['approve-decision', '--id', draftDecision.id, '--body-file', bodyPath])
  console.log(`approve-decision printed: ${JSON.stringify(approveOutput.trim())}`)

  const approved = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: draftDecision.id } })
  console.log(`stage 2 decision after approval: ${describeDecision(approved)}`)
  if (approved.status !== 'approved') await fail(`stage 2's decision is ${approved.status} after approval, expected approved`)
  if (approved.resolvedAt === null) await fail('stage 2: the approved decision has no resolvedAt')
  if (approved.draft.editedBody !== EDITED_BODY) {
    await fail(`stage 2's row records editedBody ${JSON.stringify(approved.draft.editedBody)}, expected the operator's ${JSON.stringify(EDITED_BODY)}`)
  }
  // The row keeps BOTH texts -- what the Supervisor said and what the human sent.
  if (approved.draft.body !== unsourcedDraft.body) {
    await fail(`approving with an edit rewrote the model's own draft body to ${JSON.stringify(approved.draft.body)}`)
  }

  const editedAnswers = await answersTo(stage2.question.id)
  console.log(`stage 2 answers after approval (${String(editedAnswers.length)}): ${editedAnswers.map(describeMessage).join('\n  ')}`)
  if (editedAnswers.length !== 1) await fail(`stage 2 wrote ${String(editedAnswers.length)} answers, expected exactly one`)
  const editedAnswer = editedAnswers[0]
  if (editedAnswer.body !== EDITED_BODY) {
    await fail(`stage 2 sent ${JSON.stringify(editedAnswer.body)}, expected the operator's own ${JSON.stringify(EDITED_BODY)}`)
  }
  // A person approved it, so the envelope says a person -- the one difference from stage 1's row.
  if (editedAnswer.actor !== 'human') await fail(`stage 2's answer says actor ${editedAnswer.actor}, expected human`)

  await resumedAndConcluded('stage 2', stage2.run)
  console.log(
    'stage 2 complete: an answer the Supervisor could not prove was written down and sent to nobody until a human rewrote it, and ' +
      'the row keeps both texts',
  )

  // ================= Stage 3: some questions are not answerable by a machine ======================

  await stopDaemon(daemon2)
  setQaRoles(ASKED_ROLE)

  const criticalTask = await makeTask(CRITICAL_TASK_TITLE)
  console.log(`stage 3 task ${criticalTask.id} (ready, backend)`)

  const daemon3 = spawnDaemon('daemon-3', {
    askJson: JSON.stringify({
      role: ASKED_ROLE,
      question: 'Which api key should I use for the staging deployment?',
    }),
    // Deliberately the SOURCED fixture: if this stage's answer call had been made, it would have
    // come back with a verifiable quote and the row would have been `applied`. It is `escalated`
    // because the lexicon stopped the call, not because the fixture could not answer.
    answerFixture: 'supervisor-answer',
  })

  const stage3 = await askedQuestion('stage 3', criticalTask.id)
  setQaRoles('')

  const criticalDecision = await decisionFor('stage 3', 'unanswerable_question', stage3.question.id)
  console.log(`stage 3 decision: ${describeDecision(criticalDecision)}`)
  // The action a MODEL chose is still on the row -- the lexicon overrides the tier, not the choice,
  // which is what makes "no second call" a claim about this decision rather than about a different
  // one taken instead of it.
  if (criticalDecision.action.kind !== 'answer_question') {
    await fail(`stage 3 chose ${String(criticalDecision.action.kind)}, expected answer_question at tier escalated`)
  }
  if (criticalDecision.tier !== 'escalated') await fail(`stage 3's decision is tier ${criticalDecision.tier}, expected escalated`)
  if (criticalDecision.status !== 'pending') await fail(`stage 3's decision is ${criticalDecision.status}, expected pending`)
  const criticalDraft = criticalDecision.draft
  if (criticalDraft === null) await fail('stage 3: the escalation carries no draft for a human to type into')
  if (criticalDraft.body !== null) {
    await fail(`stage 3's draft carries a body a model wrote about a credential: ${JSON.stringify(criticalDraft.body)}`)
  }
  if (!Array.isArray(criticalDraft.critical?.lexicon) || !criticalDraft.critical.lexicon.includes('secrets')) {
    await fail(`stage 3's draft does not name the "secrets" lexicon key: ${JSON.stringify(criticalDraft.critical)}`)
  }
  console.log(`stage 3 critical flags: ${JSON.stringify(criticalDraft.critical)}`)
  // Erratum E2, measured on the money: the CHOICE call happened (a model picked `answer_question`
  // out of the catalogue) and the ANSWER call never did, so the row carries exactly one fixture's
  // cost. `modelCalled` alone could not tell those two apart.
  if (criticalDecision.modelCalled !== true) await fail('stage 3: no model call at all was recorded, so nothing chose this action')
  if (!sameMoney(criticalDecision.modelCostUsd, FIXTURE_CHOICE_COST_USD)) {
    await fail(
      `stage 3 recorded modelCostUsd ${String(criticalDecision.modelCostUsd)}, expected the choice call's ` +
        `${String(FIXTURE_CHOICE_COST_USD)} alone -- a larger number means an answer call was made about a credential`,
    )
  }

  const criticalAnswers = await answersTo(stage3.question.id)
  console.log(`stage 3 answers: ${String(criticalAnswers.length)}`)
  if (criticalAnswers.length !== 0) {
    await fail(`stage 3 answered a critical question by itself: ${criticalAnswers.map(describeMessage).join('; ')}`)
  }
  console.log(
    'stage 3 complete: a question about an API key was escalated by a deterministic list of words before any model was asked to ' +
      'answer it, and the draft it left is an empty box for a human to type into',
  )

  // ================= Stage 4: a question can be re-addressed instead of answered ==================

  // The daemon goes, and stage 3's run stays parked on its escalated question -- which is what
  // makes Dev BUSY for this stage and gives the new question a real asker that is really waiting.
  await stopDaemon(daemon3)

  const ops = await prisma.slave.create({
    data: { teamId: team.id, name: 'Ops', role: 'Platform Engineer', runtimeRoles: ['backend'] },
  })
  console.log(`stage 4: second backend holder Ops ${ops.id}, idle`)

  // The same verb `ask.ts` writes a question with -- the sender is derived from the run, so this is
  // Dev asking a second question from the session it is already parked in.
  const sent = await sendMessage(stage3.run.id, {
    kind: 'question',
    body: BACKEND_QUESTION,
    recipientRole: 'backend',
    expectsReply: true,
    taskId: criticalTask.id,
    idempotencyKey: `gate-m39:stage4:${stage3.run.id}`,
  })
  if (!sent.ok) await fail(`stage 4 could not send its question: ${JSON.stringify(sent.error)}`)
  // Aged past `WAITING_STALE_MS` (30 minutes), which is what turns a question nobody has answered
  // yet into a situation. Everything else about it is what the verb wrote.
  const staleQuestion = await prisma.slaveMessage.update({
    where: { id: sent.value.id },
    data: { createdAt: new Date(Date.now() - STALE_BY_MS) },
  })
  console.log(`stage 4 question: ${describeMessage(staleQuestion)}`)

  const devNow = await prisma.slaveRun.findUniqueOrThrow({ where: { id: stage3.run.id } })
  const opsRuns = await prisma.slaveRun.count({ where: { slaveId: ops.id } })
  console.log(`stage 4: Dev holds run ${devNow.id} (${devNow.status}) -- busy; Ops has ${String(opsRuns)} runs -- idle`)
  if (devNow.status !== 'paused') await fail(`stage 4 needs Dev busy on its parked run, but that run is ${devNow.status}`)
  if (opsRuns !== 0) await fail(`stage 4 needs Ops idle, but it has ${String(opsRuns)} run(s)`)

  // A one-shot tick: no decider, so the RULES decide -- and the rules take the one routine action
  // the catalogue offers, which for a stale question with an idle holder is the re-address.
  const tickOutput = runCli(['tick', '--workspace', workspaceId])
  console.log(`stage 4 tick printed:\n${tickOutput}`)

  const reassignRows = await prisma.supervisorDecision.findMany({
    where: { workspaceId, situationKind: 'waiting_stale', subjectId: staleQuestion.id },
  })
  console.log(`stage 4 decisions (${String(reassignRows.length)}): ${reassignRows.map(describeDecision).join('\n  ')}`)
  if (reassignRows.length !== 1) await fail(`stage 4 wrote ${String(reassignRows.length)} waiting_stale decisions, expected exactly one`)
  const reassign = reassignRows[0]
  if (reassign.action.kind !== 'reassign_question') {
    await fail(`stage 4 chose ${String(reassign.action.kind)}, expected reassign_question`)
  }
  if (reassign.action.toSlaveId !== ops.id) {
    await fail(`stage 4 re-addressed to ${String(reassign.action.toSlaveId)}, expected the idle holder Ops ${ops.id}`)
  }
  if (reassign.tier !== 'applied') await fail(`stage 4's decision is tier ${reassign.tier}, expected applied`)
  if (reassign.status !== 'applied') await fail(`stage 4's decision is ${reassign.status}, expected applied`)
  if (reassign.failureReason !== null) await fail(`stage 4's re-address refused: ${String(reassign.failureReason)}`)
  if (reassign.decidedBy !== 'rules') await fail(`stage 4's decision says decidedBy ${reassign.decidedBy}, expected rules`)
  if (reassign.modelCalled !== false) await fail('stage 4: a hand-run tick called a model, which it must never do')

  const moved = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: staleQuestion.id } })
  console.log(`stage 4 question after the re-address: ${describeMessage(moved)}`)
  if (moved.recipientSlaveId !== ops.id) {
    await fail(`stage 4's question is addressed to ${String(moved.recipientSlaveId)}, expected Ops ${ops.id}`)
  }
  // Both columns, always: a row addressed to a slave AND a role would stay in every holder's inbox.
  if (moved.recipientRole !== null) {
    await fail(`stage 4's question still carries recipientRole ${JSON.stringify(moved.recipientRole)}`)
  }

  const reassignEvent = await prisma.executionEvent.findFirst({
    where: { workspaceId, type: 'slave_message_reassigned' },
    orderBy: { seq: 'desc' },
  })
  console.log(
    `stage 4 slave.message_reassigned: ${reassignEvent === null ? 'none' : `actor ${reassignEvent.actor}, payload ${JSON.stringify(reassignEvent.payload)}`}`,
  )
  if (reassignEvent === null) await fail('stage 4 moved the question without appending slave.message_reassigned')
  if (reassignEvent.payload.messageId !== staleQuestion.id) {
    await fail(`stage 4's event names message ${String(reassignEvent.payload.messageId)}, expected ${staleQuestion.id}`)
  }
  if (reassignEvent.payload.decisionId !== reassign.id) {
    await fail(`stage 4's event names decision ${String(reassignEvent.payload.decisionId)}, expected ${reassign.id}`)
  }
  if (reassignEvent.payload.to.slaveId !== ops.id) {
    await fail(`stage 4's event says it moved to ${String(reassignEvent.payload.to.slaveId)}, expected Ops ${ops.id}`)
  }
  if (reassignEvent.payload.from.role !== 'backend') {
    await fail(`stage 4's event says it moved from ${JSON.stringify(reassignEvent.payload.from)}, expected the "backend" role`)
  }
  if (reassignEvent.actor !== 'system') {
    await fail(`stage 4's event says actor ${reassignEvent.actor}, expected system for a Supervisor-applied action`)
  }

  const stage4Answers = await answersTo(staleQuestion.id)
  console.log(`stage 4 answers: ${String(stage4Answers.length)}`)
  if (stage4Answers.length !== 0) {
    await fail(`stage 4 answered the question it was supposed to re-address: ${stage4Answers.map(describeMessage).join('; ')}`)
  }
  console.log(
    'stage 4 complete: a question that had waited too long for a busy role was put in front of the colleague who could answer it ' +
      'now -- nothing answered, nobody resumed, and the log names the decision behind the move',
  )

  // ================= Stage 5: decisions are history, and history is not kept forever ==============

  const longAgo = new Date(Date.now() - RETENTION_AGE_MS)
  const oldSituation = (subjectId) => ({
    kind: 'task_blocked_human',
    subjectId,
    summary: 'A synthetic situation seeded by scripts/gate-m39-supervisor-mailbox.mjs to age past retention.',
    facts: { taskId: subjectId },
  })
  const oldRow = (subjectId, status) => ({
    workspaceId,
    situationKind: 'task_blocked_human',
    subjectId,
    situation: oldSituation(subjectId),
    candidates: [{ action: { kind: 'escalate_to_human', summary: 'seeded' }, tier: 'escalated', why: 'seeded' }],
    chosenIndex: 0,
    action: { kind: 'escalate_to_human', summary: 'seeded' },
    rationale: 'Seeded 31 days old by the M39 gate.',
    tier: 'escalated',
    status,
    decidedBy: 'rules',
    createdAt: longAgo,
  })

  const prunable = await prisma.supervisorDecision.create({
    // Resolved 31 days ago, which is the anchor `pruneDecisions` measures from, and `modelCalled`
    // false (the column default) -- a decision the RULES made, which cost nothing and is therefore
    // nothing but history once it is this old.
    data: { ...oldRow(PRUNED_SUBJECT, 'rejected'), resolvedAt: longAgo, modelCalled: false },
  })
  const paid = await prisma.supervisorDecision.create({
    // The same age, the same resolved status, and a model call behind it. Erratum E7: this row is
    // the Supervisor's spend, not its history.
    data: {
      ...oldRow(PAID_SUBJECT, 'rejected'),
      resolvedAt: longAgo,
      decidedBy: 'model',
      modelCalled: true,
      modelCostUsd: PAID_COST_USD,
    },
  })
  const kept = await prisma.supervisorDecision.create({
    // Still pending at 31 days old. `expiresAt` is deliberately in the FUTURE so the expiry sweep --
    // which runs first on every tick, and would otherwise resolve this row before the pruner ever
    // saw it -- leaves it alone: what this stage measures is the PRUNER refusing to delete a
    // pending row, and a row the sweep had already retired would prove nothing about that.
    data: { ...oldRow(KEPT_SUBJECT, 'pending'), expiresAt: new Date(Date.now() + 86_400_000) },
  })
  console.log(
    `stage 5 seeded: ${describeDecision(prunable)}\n  ${describeDecision(paid)}\n  ${describeDecision(kept)}`,
  )
  const spendBefore = await workspaceSpend(workspaceId)
  console.log(`stage 5 spend before the tick: ${JSON.stringify(spendBefore)}`)

  const pruneTick = runCli(['tick', '--workspace', workspaceId])
  console.log(`stage 5 tick printed:\n${pruneTick}`)
  const pruneReport = JSON.parse(pruneTick)
  console.log(`stage 5 supervisor report: ${JSON.stringify(pruneReport.supervisor)}`)
  if (pruneReport.supervisor === undefined || pruneReport.supervisor.pruned < 1) {
    await fail(`stage 5's tick reports ${JSON.stringify(pruneReport.supervisor)}, expected at least one pruned row`)
  }

  const prunableAfter = await prisma.supervisorDecision.findUnique({ where: { id: prunable.id } })
  const paidAfter = await prisma.supervisorDecision.findUnique({ where: { id: paid.id } })
  const keptAfter = await prisma.supervisorDecision.findUnique({ where: { id: kept.id } })
  console.log(`stage 5 after the tick: resolved row ${prunableAfter === null ? 'GONE' : describeDecision(prunableAfter)}`)
  console.log(`stage 5 after the tick: paid row ${paidAfter === null ? 'GONE' : describeDecision(paidAfter)}`)
  console.log(`stage 5 after the tick: pending row ${keptAfter === null ? 'GONE' : describeDecision(keptAfter)}`)
  if (prunableAfter !== null) await fail('stage 5: a decision resolved 31 days ago that cost nothing is still in the table')
  if (paidAfter === null) {
    await fail('stage 5: a month-old decision that CALLED A MODEL was pruned -- that row is the project\'s spend (erratum E7)')
  }
  if (paidAfter.modelCostUsd !== PAID_COST_USD) {
    await fail(`stage 5's paid row now costs ${String(paidAfter.modelCostUsd)}, expected ${String(PAID_COST_USD)}`)
  }
  if (keptAfter === null) await fail('stage 5: a PENDING decision was pruned -- an unanswered proposal is not history')
  if (keptAfter.status !== 'pending') {
    await fail(`stage 5's kept row is ${keptAfter.status}, expected it to be left exactly as it was`)
  }

  const spendAfter = await workspaceSpend(workspaceId)
  console.log(`stage 5 spend after the tick: ${JSON.stringify(spendAfter)}`)
  if (spendAfter.spentUsd !== spendBefore.spentUsd) {
    await fail(
      `stage 5: the prune moved the project's recorded spend from ${String(spendBefore.spentUsd)} to ` +
        `${String(spendAfter.spentUsd)} -- retention must never erase money that was spent`,
    )
  }
  console.log(
    'stage 5 complete: a month-old resolved decision that cost nothing is gone, the one that called a model is still there with ' +
      'its cost, the project\'s spend is unchanged, and a month-old question to a human is still waiting',
  )

  const finalDecisions = await prisma.supervisorDecision.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })
  console.log(`every decision this gate produced (${String(finalDecisions.length)}):\n  ${finalDecisions.map(describeDecision).join('\n  ')}`)
  const finalMessages = await prisma.slaveMessage.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  console.log(`every message this gate produced (${String(finalMessages.length)}):\n  ${finalMessages.map(describeMessage).join('\n  ')}`)

  console.log(
    'PASS: the Supervisor read a real mailbox through a real daemon -- answered the question whose answer it could prove and woke ' +
      'the slave waiting on it, drafted the one it could not and sent nothing until a human rewrote it, refused to answer a ' +
      'question about an API key without paying for a second call to find that out, re-addressed a stale question to the ' +
      'colleague who could answer it, and threw away only the decisions that had stopped being anybody\'s business',
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
    // Cascades Team/Slave/Task/SlaveRun/RunContext/SlaveMessage and SupervisorDecision.
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  if (bodyDir !== null) rmSync(bodyDir, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
