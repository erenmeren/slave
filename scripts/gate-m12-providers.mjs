// M12's own gate (Task 14 brief): "two runtimes kept one promise -- paused, resumed, and budgeted
// alike". Every earlier gate in this repo proves a *feature* against one runtime; this one proves
// the SEAM. Two workers in one workspace, one resolved to `claude_code` and one to `cursor`, both
// dispatched by the real orchestrator daemon against the real vendor binaries, both paused through
// `packages/control`'s own `requestPause`, both resumed through `requestResume` + the daemon's
// resume pass, and every assertion a direct `prisma` read -- never anything a process merely
// printed.
//
// Shape borrowed verbatim from `gate-m11-shell.mjs` / `gate-m8a-estop.mjs`: dist imports,
// everything created inside `try`, bounded waits that name what they waited for, preflight cleanup
// of prior `M12 Gate`-named rows, `finally` kills every process this script spawned and cleans up
// in FK order, `exitCode` starts at 1 and is only set to 0 at the very end of a fully-asserted run,
// `process.exit(exitCode)` is the last line.
//
// THE FIVE STAGES ARE THE PLAN'S, and they are asserted in the order 4, 1, 3, 2, 5 rather than
// 1..5. Two reasons, both about spending real money on real accounts:
//
//   - Stage 4 (a budgeted workspace refuses the cost-blind provider) spawns NOTHING -- the refusal
//     happens at dispatch, before any child exists. Running it first means a broken admission
//     guard is found in two seconds rather than after two paid runs.
//   - Stage 2 ("both runs reach a terminal state and write the same event and checkpoint shape")
//     can only be asserted once stage 3's pause and resume have happened: the checkpoint it
//     compares is *written by* the pause, and the terminal state is *reached by* the resume. So
//     stage 3 drives, and stage 2 reads what stage 3 left behind.
//
// WHAT THIS GATE COSTS. One execution spawns exactly two paid runs (one `claude`, one
// `cursor-agent`), each resumed once, on a prompt that creates two small files. Stage 4 spawns
// nothing. Every task is created with `maxAttempts: 1` so that a failed run can never be reworked
// into a second paid attempt while this script is waiting on something else.
//
// A FAIL from any stage dumps every `M12 Gate`-named run, checkpoint and event still in the DB --
// the `gate-m8a-estop.mjs` idiom of a thrown error carrying the state that made the call, not just
// "it timed out".

import { execFileSync, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { isAlive, requestPause, requestResume } from '../packages/control/dist/index.js'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '../packages/db/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'

const POLL_INTERVAL_MS = 25
// Generous by design, and every one of them is a bound on a REAL vendor round trip. Cursor's first
// turn is tens of seconds (Task 12 §3 measured 20.8s of API time on a two-step prompt before the
// first result line), and `claude`'s cold start is not much better under load, so a timeout tuned
// to a fake CLI's replay speed would fail this gate for being slow rather than for being wrong.
const DISPATCH_TIMEOUT_MS = 180_000
const WORKING_TIMEOUT_MS = 300_000
const PAUSE_SETTLE_TIMEOUT_MS = 180_000
const RESUME_TERMINAL_TIMEOUT_MS = 600_000
const TICK_TIMEOUT_MS = 120_000
// The window in which a pump that has already written its terminal ROW finishes writing its
// history. Short, because everything it is waiting on has already happened -- see the comment
// at stage 2's read for why it has to be a wait at all.
const LIFECYCLE_SETTLE_TIMEOUT_MS = 60_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const runTimestamp = new Date().toISOString()

// Suffixed with `runTimestamp` (the `gate-m10-org.mjs` idiom, not `gate-m11-shell.mjs`'s exact
// literals): nothing here is typed into a form, and `Workspace.name` has no unique constraint, so
// a unique name per run keeps two overlapping executions from reading each other's rows.
// `preflightCleanup` below still removes leftovers by PREFIX, so a run killed before its own
// `finally` cannot leave rows behind that a later run's diagnostics would report as its own.
const WORKSPACE_PREFIX = 'M12 Gate Project'
const UNBUDGETED_WORKSPACE = `${WORKSPACE_PREFIX} (unbudgeted) ${runTimestamp}`
const BUDGETED_WORKSPACE = `${WORKSPACE_PREFIX} (budgeted) ${runTimestamp}`
const CLAUDE_WORKER = 'Claude Worker'
const CURSOR_WORKER = 'Cursor Worker'
const PAUSE_REQUESTER = 'the M12 gate'

// The model half of each worker's `(model, provider)` pair. Both workers MUST name a model:
// `resolveRuntime` (packages/control/src/runtime.ts) only consults a level that names one, so a
// worker with a null model falls through to the workspace default and both workers would resolve
// to the SAME provider -- which is the one thing stage 1 exists to disprove.
//
// Chosen for cost, not for capability: `sonnet` is Claude Code's own alias, and `composer-2.5` is
// Cursor's in-house fast agentic model (read off `cursor-agent --list-models`, not off vendor
// docs). Both are asked to create two small files.
const CLAUDE_MODEL = 'sonnet'
const CURSOR_MODEL = 'composer-2.5'

// Two steps, so a pause can land BETWEEN them, and tiny, because both halves cost the operator's
// own account. The sequencing sentence is load-bearing: a runtime that batches both writes into
// one turn leaves no gap for a pause to land in, and this gate would then fail for a reason that
// has nothing to do with the seam it is measuring.
const TASK_TITLE = 'Create two small files'
const TASK_DESCRIPTION = [
  'Create a file named hello.txt whose entire contents are the word: hi',
  'Then create a second file named world.txt whose entire contents are the word: there',
  '',
  'Do them one at a time, in that order: create hello.txt first, and only once it exists create',
  'world.txt. Use one file-writing tool call per file. Do not run any other commands, and do not',
  'commit anything.',
].join('\n')

/** The exact refusal spec §6 promises for a budgeted workspace and a cost-blind runtime. */
const BUDGET_REFUSAL = 'a budget needs a provider that reports cost'

/** A run row that has stopped moving on its own. */
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'stopped'])

/**
 * The event vocabulary stage 2 compares, and nothing else.
 *
 * Deliberately NOT every type the two runs emitted: `run.tool_call`, `run.output` and
 * `guardrail.tripped` are vendor-shaped noise (how many turns a model took, how much it said, and
 * whether its own permission mode refused something along the way), and asserting on them would
 * be asserting that two different runtimes think alike rather than that they keep the same
 * promise. The lifecycle is the promise.
 */
const LIFECYCLE_VOCABULARY = new Set([
  'run.started',
  'run.paused',
  'run.resumed',
  'run.succeeded',
  'run.failed',
  'run.stopped',
])
const TERMINAL_EVENTS = new Set(['run.succeeded', 'run.failed', 'run.stopped'])
/** The lifecycle members BOTH runs must have emitted, whichever runtime they were on. */
const REQUIRED_LIFECYCLE = ['run.started', 'run.paused', 'run.resumed']

/** Same as `gate-m8a-estop.mjs`'s `makeRepo` -- a real repository, because the tick provisions a
 *  real `git worktree` in it, and a real worktree root is exactly what `cursor-agent` needs for the
 *  `.cursor/hooks.json` the Cursor adapter writes to be found at all (Task 12 §10(c): hooks resolve
 *  against the GIT ROOT of the workspace, so a plain subdirectory of some other repository would
 *  silently disarm the gate). */
function makeRepo(suffix) {
  const dir = mkdtempSync(join(tmpdir(), `slaveofai-gate-m12-${suffix}-`))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/**
 * The absolute path of `name` on `PATH`, or `null`.
 *
 * Resolved through `PATH` rather than hardcoded (`cursor-agent` lives under `~/.local/bin` on this
 * machine and will not on another), and checked here rather than left for the adapter's spawn to
 * discover: a missing binary surfaces at spawn time as a run that failed to start, several minutes
 * and one paid Claude run into an execution that could never have passed.
 */
function resolveOnPath(name) {
  // An override that already names a path (`SLAVEOFAI_CURSOR_BIN=/opt/cursor/bin/cursor-agent`) is
  // checked where it points, not searched for on PATH -- `spawn` treats it that way too, so this
  // check has to agree with the thing it is checking for.
  if (name.includes('/')) {
    try {
      accessSync(name, constants.X_OK)
      return name
    } catch {
      return null
    }
  }
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here, or not executable. Keep looking.
    }
  }
  return null
}

/** Removes any `M12 Gate`-named rows a prior interrupted run left behind, in the same FK order the
 *  `finally` block below uses: the append-only events first (no FK to `Workspace`), then the
 *  workspace itself, which cascades Team/Agent/Task/AgentRun/Checkpoint/ProviderConfiguration. */
async function preflightCleanup() {
  const stale = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true },
  })
  for (const workspace of stale) {
    console.log(`preflight: removing leftover workspace ${workspace.id} (${workspace.name})`)
    await prisma.executionEvent.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {})
  }
}

let exitCode = 1
let unbudgetedRepo = null
let budgetedRepo = null
let unbudgetedWorkspaceId = null
let budgetedWorkspaceId = null
let daemon = null
let daemonOutput = ''
let daemonExited = false

/** Every `M12 Gate`-named run, checkpoint and lifecycle event still in the DB, for a FAIL's
 *  diagnostic dump -- scoped by workspace NAME rather than by this run's own tracked ids, since a
 *  failure can happen before some of those ids are even set. */
async function dumpGateRows() {
  const workspaces = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true, budgetUsd: true },
  })
  const dump = []
  for (const workspace of workspaces) {
    const runs = await prisma.agentRun.findMany({
      where: { agent: { team: { workspaceId: workspace.id } } },
      include: { agent: { select: { name: true } }, checkpoint: true },
      orderBy: { startedAt: 'asc' },
    })
    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { seq: 'asc' },
      select: { seq: true, runId: true, type: true, payload: true },
    })
    dump.push({
      workspace,
      runs: runs.map((run) => ({
        id: run.id,
        agent: run.agent.name,
        provider: run.provider,
        status: run.status,
        pid: run.pid,
        sessionId: run.sessionId,
        toolCalls: run.toolCalls,
        costUsd: run.costUsd,
        pauseReason: run.pauseReason,
        pausedAtStep: run.pausedAtStep,
        terminalAt: run.terminalAt,
        checkpoint:
          run.checkpoint === null
            ? null
            : {
                sessionId: run.checkpoint.sessionId,
                provider: run.checkpoint.provider,
                model: run.checkpoint.model,
                lastToolUseId: run.checkpoint.lastToolUseId,
                lastToolName: run.checkpoint.lastToolName,
                numTurns: run.checkpoint.numTurns,
                pauseReason: run.checkpoint.pauseReason,
                requestedBy: run.checkpoint.requestedBy,
                deniedToolUseIds: run.checkpoint.deniedToolUseIds,
              },
      })),
      events: events.map((event) => ({
        seq: event.seq,
        runId: event.runId,
        type: DOMAIN_EVENT_TYPE_BY_DB_VALUE[event.type] ?? event.type,
        payload: event.payload,
      })),
    })
  }
  // `ExecutionEvent.seq` is a BigInt; `JSON.stringify` refuses it outright, and a diagnostic dump that
  // throws is a diagnostic dump that is not there when it is needed.
  return JSON.stringify(dump, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
}

/** The m8a-estop-style diagnostic throw: the state that made the call, not just "it timed out".
 *  No separate `catch` -- same all-in-`try` shape the other gates use, where the only path to
 *  `exitCode = 0` is falling off the end of the try block. */
async function fail(message) {
  const rows = await dumpGateRows().catch(
    (cause) => `<could not dump gate rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
  )
  const daemonTail = daemonOutput.length > 4_000 ? `…${daemonOutput.slice(-4_000)}` : daemonOutput
  throw new Error(`${message}\n--- daemon output (tail) ---\n${daemonTail}\n--- gate rows ---\n${rows}`)
}

/**
 * Polls `probe` until it reports `{ done: true }`, then returns its `value`.
 *
 * `probe` returns its own `detail` string on every unsatisfied tick, and that string is what the
 * timeout message reports -- so a wait that runs out says what it last SAW rather than only what
 * it wanted. Every wait in this file goes through here for that reason.
 */
async function waitUntil(description, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs
  let lastDetail = '<never probed>'
  for (;;) {
    if (daemonExited) {
      await fail(`the daemon exited while waiting for ${description}`)
    }
    const result = await probe()
    if (result.done) return result.value
    lastDetail = result.detail
    if (Date.now() > deadline) {
      await fail(`timed out after ${timeoutMs}ms waiting for ${description} -- last seen: ${lastDetail}`)
    }
    await delay(POLL_INTERVAL_MS)
  }
}

/** The run row for one of the two gate workers, or `null` while the tick has not created it yet. */
async function runForWorker(workerName) {
  return prisma.agentRun.findFirst({
    where: { agent: { name: workerName, team: { workspaceId: unbudgetedWorkspaceId } } },
    orderBy: { startedAt: 'asc' },
  })
}

try {
  // ---- Preflight. Every one of these fails FAST and by name: this gate never skips a stage, so
  // an unrunnable precondition has to be an error here rather than a stage quietly doing nothing.
  const envPath = join(repoRoot, '.env')
  if (!existsSync(envPath)) {
    throw new Error(
      `no .env at ${envPath} -- this gate runs against the DEVELOPMENT database and reads DATABASE_URL from it ` +
        '(npm run gate:m12-providers passes --env-file=.env). Create it before running this gate.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m12-providers`, which passes --env-file=.env')
  }

  const claudeBinName = process.env['SLAVEOFAI_CLAUDE_BIN'] ?? 'claude'
  const cursorBinName = process.env['SLAVEOFAI_CURSOR_BIN'] ?? 'cursor-agent'
  const claudeBin = resolveOnPath(claudeBinName)
  const cursorBin = resolveOnPath(cursorBinName)
  if (claudeBin === null) {
    throw new Error(
      `no executable ${JSON.stringify(claudeBinName)} on PATH. This gate drives the REAL Claude Code CLI; ` +
        'there is no fixture mode and no skip. Install it, or point SLAVEOFAI_CLAUDE_BIN at it.',
    )
  }
  if (cursorBin === null) {
    throw new Error(
      `no executable ${JSON.stringify(cursorBinName)} on PATH. This gate drives the REAL Cursor CLI; ` +
        'there is no fixture mode and no skip. Install it (it lives under ~/.local/bin on a default ' +
        'install), or point SLAVEOFAI_CURSOR_BIN at it.',
    )
  }
  console.log(`claude:       ${claudeBin}`)
  console.log(`cursor-agent: ${cursorBin}`)

  try {
    await prisma.$queryRaw`select 1`
  } catch (cause) {
    throw new Error(
      `the database at DATABASE_URL is not reachable (${cause instanceof Error ? cause.message : String(cause)}) -- ` +
        'start Postgres and apply migrations before running this gate.',
    )
  }

  await preflightCleanup()

  // ============================================================================================
  // Stage 4, run FIRST: a budgeted workspace refuses the cost-blind provider.
  //
  // Nothing is spawned by this stage -- `admitProvider` refuses inside the tick's `startRun`,
  // after the adapter resolves and before any child exists -- which is exactly why it goes first:
  // if this guard is broken, it is broken in two seconds rather than after two paid runs.
  // ============================================================================================
  budgetedRepo = makeRepo('budgeted')
  const budgeted = await prisma.workspace.create({
    data: {
      name: BUDGETED_WORKSPACE,
      repoPath: budgetedRepo,
      // `budgetUsd` deliberately UNSET, so the schema's `@default(20)` applies: this workspace is
      // budgeted the way every ordinary workspace in this system is, not by a special value the
      // gate invented for itself.
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  budgetedWorkspaceId = budgeted.id
  if (budgeted.budgetUsd === null) {
    await fail(`${BUDGETED_WORKSPACE} was created with a null budget: stage 4 cannot test a budgeted workspace with no budget`)
  }
  const budgetedTeam = await prisma.team.create({ data: { workspaceId: budgeted.id, name: 'Gate Team' } })
  await prisma.agent.create({
    data: { teamId: budgetedTeam.id, name: CURSOR_WORKER, role: 'backend', model: CURSOR_MODEL, provider: 'cursor' },
  })
  const budgetedTask = await prisma.task.create({
    data: {
      workspaceId: budgeted.id,
      title: TASK_TITLE,
      description: TASK_DESCRIPTION,
      status: 'ready',
      requiredRole: 'backend',
      // One attempt: a refusal that could be retried would be dispatched again on the next tick,
      // and this gate must never leave a task behind that some later tick would pay to run.
      maxAttempts: 1,
    },
  })
  console.log(`budgeted workspace: ${budgeted.id} (budgetUsd=${budgeted.budgetUsd})`)

  // The real CLI's single tick, not a hand-built call: `startRun`'s admission re-check is what is
  // being measured, and it only runs on the dispatch path an operator actually uses.
  execFileSync('node', [ORCHESTRATOR_CLI, 'tick', '--workspace', budgeted.id], {
    timeout: TICK_TIMEOUT_MS,
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  const refusedRuns = await prisma.agentRun.findMany({
    where: { agent: { team: { workspaceId: budgeted.id } } },
  })
  if (refusedRuns.length !== 1) {
    await fail(`stage 4: expected exactly 1 attempted run in the budgeted workspace, found ${refusedRuns.length}`)
  }
  const refusedRun = refusedRuns[0]
  if (refusedRun.status !== 'failed') {
    await fail(`stage 4: the budgeted workspace's run is ${refusedRun.status}, expected failed`)
  }
  if (refusedRun.pid !== null) {
    await fail(
      `stage 4: the refused run recorded pid ${refusedRun.pid} -- a refusal that spawned a process is not a refusal, ` +
        'and the cost-blind runtime was admitted after all',
    )
  }
  const refusalEvents = await prisma.executionEvent.findMany({
    where: { runId: refusedRun.id },
    orderBy: { seq: 'asc' },
  })
  const refusalReasons = refusalEvents
    .filter((event) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[event.type] === 'run.failed')
    .map((event) => (event.payload === null ? null : event.payload.reason))
  if (!refusalReasons.includes(BUDGET_REFUSAL)) {
    await fail(
      `stage 4: no run.failed event carried the exact refusal ${JSON.stringify(BUDGET_REFUSAL)} -- ` +
        `reasons seen: ${JSON.stringify(refusalReasons)}`,
    )
  }
  const parkedTask = await prisma.task.findUniqueOrThrow({ where: { id: budgetedTask.id } })
  if (parkedTask.activeRunId !== null) {
    await fail(`stage 4: the refused task still holds activeRunId ${parkedTask.activeRunId}`)
  }
  console.log(
    `stage 4 PASSED: a budgeted workspace (budgetUsd=${budgeted.budgetUsd}) refused the cost-blind cursor provider ` +
      `with the exact text ${JSON.stringify(BUDGET_REFUSAL)}, and spawned nothing`,
  )

  // ============================================================================================
  // Stage 1: one workspace, two workers -- one resolved to `claude_code`, one to `cursor`.
  // ============================================================================================
  unbudgetedRepo = makeRepo('unbudgeted')
  const workspace = await prisma.workspace.create({
    data: {
      name: UNBUDGETED_WORKSPACE,
      repoPath: unbudgetedRepo,
      // Explicitly `null`, and this is the whole reason stage 4 needs a workspace of its own: the
      // schema's `@default(20)` makes EVERY workspace budgeted unless an operator clears it, and a
      // budgeted workspace refuses `cursor` outright (that is stage 4). Spec §6 makes an unbudgeted
      // workspace the only state in which a cost-blind runtime may run at all.
      budgetUsd: null,
      verifyCommands: ['true'],
      setupCommands: [],
    },
  })
  unbudgetedWorkspaceId = workspace.id
  // The workspace's own configured default. Neither worker below actually resolves through it --
  // both name their own `(model, provider)` pair, which wins -- but a workspace with no
  // `ProviderConfiguration` row at all is a misconfigured workspace (`workspaceDefaultProvider`
  // returns null and dispatch refuses), and this gate should look like a real deployment.
  await prisma.providerConfiguration.create({
    data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Gate Team' } })
  // Both workers carry an explicit pair. `resolveRuntime` only consults a level that NAMES a model,
  // so a worker with a null model would fall through to the workspace default and both would
  // resolve to `claude_code` -- the seam this stage exists to prove would be invisible.
  const claudeAgent = await prisma.agent.create({
    data: { teamId: team.id, name: CLAUDE_WORKER, role: 'backend', model: CLAUDE_MODEL, provider: 'claude_code' },
  })
  const cursorAgent = await prisma.agent.create({
    data: { teamId: team.id, name: CURSOR_WORKER, role: 'backend', model: CURSOR_MODEL, provider: 'cursor' },
  })
  // Two tasks, one per worker, both `maxAttempts: 1` for the spend reason stage 4's task gives.
  for (const suffix of ['A', 'B']) {
    await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: `${TASK_TITLE} (${suffix})`,
        description: TASK_DESCRIPTION,
        status: 'ready',
        requiredRole: 'backend',
        maxAttempts: 1,
      },
    })
  }
  console.log(`unbudgeted workspace: ${workspace.id} (budgetUsd=${workspace.budgetUsd})`)
  console.log(`workers: ${CLAUDE_WORKER}=${claudeAgent.id} (claude_code/${CLAUDE_MODEL}), ${CURSOR_WORKER}=${cursorAgent.id} (cursor/${CURSOR_MODEL})`)

  // The real daemon, in the background -- the same thing an operator leaves running. No
  // `SLAVEOFAI_*_BIN` overrides: both adapters resolve the real vendor binaries the preflight
  // above just proved are on PATH.
  daemon = spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspace.id, '--period', '500'], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemon.stdout.on('data', (chunk) => {
    daemonOutput += chunk.toString()
    process.stdout.write(`[daemon] ${chunk}`)
  })
  daemon.stderr.on('data', (chunk) => {
    daemonOutput += chunk.toString()
    process.stderr.write(`[daemon] ${chunk}`)
  })
  daemon.on('exit', (code, signal) => {
    daemonExited = true
    daemonOutput += `\n<daemon exited: code=${String(code)} signal=${String(signal)}>\n`
  })
  daemon.on('error', (error) => {
    daemonExited = true
    daemonOutput += `\n<daemon failed to start: ${String(error)}>\n`
  })

  // Both runs dispatched, both with a pid and a provider written. `provider` is written alongside
  // `pid` after a successful spawn (`tick.ts`), so waiting for it is waiting for a run that really
  // started rather than one whose row merely exists.
  const dispatched = await waitUntil('both workers to be dispatched with a pid and a provider', DISPATCH_TIMEOUT_MS, async () => {
    const claudeRun = await runForWorker(CLAUDE_WORKER)
    const cursorRun = await runForWorker(CURSOR_WORKER)
    const ready = (run) => run !== null && run.pid !== null && run.provider !== null
    if (ready(claudeRun) && ready(cursorRun)) return { done: true, value: { claudeRun, cursorRun } }
    const describe = (run) => (run === null ? 'no run' : `${run.status} pid=${String(run.pid)} provider=${String(run.provider)}`)
    return { done: false, detail: `${CLAUDE_WORKER}: ${describe(claudeRun)}; ${CURSOR_WORKER}: ${describe(cursorRun)}` }
  })

  if (dispatched.claudeRun.provider !== 'claude_code') {
    await fail(`stage 1: ${CLAUDE_WORKER}'s run resolved to provider ${JSON.stringify(dispatched.claudeRun.provider)}, expected "claude_code"`)
  }
  if (dispatched.cursorRun.provider !== 'cursor') {
    await fail(`stage 1: ${CURSOR_WORKER}'s run resolved to provider ${JSON.stringify(dispatched.cursorRun.provider)}, expected "cursor"`)
  }
  if (dispatched.claudeRun.id === dispatched.cursorRun.id) {
    await fail('stage 1: both workers resolved to the same run row')
  }
  const claudeRunId = dispatched.claudeRun.id
  const cursorRunId = dispatched.cursorRun.id
  console.log(
    `stage 1 PASSED: one workspace, two workers, two providers -- ` +
      `${CLAUDE_WORKER} run ${claudeRunId} on claude_code (pid ${dispatched.claudeRun.pid}), ` +
      `${CURSOR_WORKER} run ${cursorRunId} on cursor (pid ${dispatched.cursorRun.pid})`,
  )

  // ============================================================================================
  // Stage 3: the pause lands on both -- hook on Claude, cancel on Cursor -- and both resume and
  // continue. This is the stage the whole milestone is about: ONE control verb, two mechanisms.
  // ============================================================================================

  /**
   * Pauses one run through the real control path and asserts it settled.
   *
   * The two runs are driven CONCURRENTLY (`Promise.all` below), not one after the other, and that
   * is not a speed optimisation: the two runtimes' first turns are seconds apart, and pausing them
   * in sequence would leave whichever one finished first with nothing left to interrupt.
   *
   * `requestPause` -- `packages/control`'s own verb, the one the CLI's `pause` and the web's pause
   * button both call -- not a hand-written flag write or kill. It dispatches on the RUN'S OWN
   * provider (`signalPause`), which is precisely the seam under test: for `claude_code` it writes
   * the pause flag and the run's hook denies the next tool call; for `cursor` it writes the same
   * flag and then ends the process, because Cursor has no mid-run gate (`canPauseMidRun: false`).
   *
   * The trigger is the SAME for both -- `working`, with at least one tool call recorded. One rule,
   * so neither runtime is given an easier moment than the other; `toolCalls >= 1` rather than bare
   * `working`, so the checkpoint both mechanisms write has a last tool call to name and stage 2 is
   * comparing two fully-populated checkpoints rather than two differently-empty ones.
   */
  async function pauseAndSettle(label, runId) {
    await waitUntil(`${label} to be working with at least one tool call recorded`, WORKING_TIMEOUT_MS, async () => {
      const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
      if (row.status === 'working' && row.toolCalls >= 1) return { done: true }
      if (TERMINAL_STATUSES.has(row.status)) {
        await fail(
          `stage 3: ${label} reached ${row.status} before the gate could pause it (toolCalls=${row.toolCalls}). ` +
            'There is nothing left to interrupt, so the pause could not be measured on this run.',
        )
      }
      return { done: false, detail: `status=${row.status} toolCalls=${row.toolCalls}` }
    })

    const paused = await requestPause(runId, PAUSE_REQUESTER, 'human')
    if (!paused.ok) {
      await fail(`stage 3: requestPause refused ${label}: ${JSON.stringify(paused.error)}`)
    }
    console.log(`stage 3: pause requested on ${label} (${runId})`)

    // A `paused` ROW is not a finished pause, and this gate learned that the expensive way
    // (execution 1, artifacts/execution-1.log). The pump writes the `paused` status and the
    // checkpoint FIRST -- deliberately, so the orphan sweep cannot fail a run whose child is
    // already being killed -- and only then stops the child: `killWithEscalation`, which is
    // SIGTERM, a two-second grace window, then SIGKILL. The real `claude` CLI does not exit on
    // SIGTERM (M5's live-gate finding, quoted in `pump.ts`), so for two whole seconds the row
    // reads `paused` while the child is still alive. Resuming inside that window is exactly what
    // `ClaudeCodeAdapter.resume` refuses -- "its previous process (pid N) is still running" -- and
    // the daemon then concludes the run FAILED. Execution 1's Claude event log records the
    // collision in order: `run.resume_requested`, `run.failed`, and only afterwards `run.paused`.
    //
    // So the wait is for the pause PROTOCOL to be complete, not for the row to flip: the pump's
    // own `run.paused` announcement -- which it emits only after the kill -- plus a dead pid. Both
    // are facts about the run this gate can read without knowing which runtime it is on, which is
    // the point. See this report's finding on the window itself: an operator who clicks Resume in
    // those two seconds loses the run the same way this script did.
    return waitUntil(`${label} to settle on paused with a checkpoint, a run.paused event and a stopped process`, PAUSE_SETTLE_TIMEOUT_MS, async () => {
      const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
      if (TERMINAL_STATUSES.has(row.status)) {
        await fail(
          `stage 3: ${label} went ${row.status} instead of paused after requestPause -- the pause signal did not ` +
            'stop the run',
        )
      }
      if (row.status !== 'paused') return { done: false, detail: `status=${row.status}` }
      const checkpoint = await prisma.checkpoint.findUnique({ where: { runId } })
      if (checkpoint === null) return { done: false, detail: 'paused, but no checkpoint written yet' }
      const announced = await prisma.executionEvent.findFirst({
        where: { runId, type: 'run_paused' },
        select: { seq: true },
      })
      if (announced === null) return { done: false, detail: 'paused with a checkpoint, but run.paused not announced yet' }
      if (isAlive(row.pid)) return { done: false, detail: `paused and announced, but pid ${String(row.pid)} is still alive` }
      return { done: true, value: checkpoint }
    })
  }

  const [claudeCheckpoint, cursorCheckpoint] = await Promise.all([
    pauseAndSettle(`${CLAUDE_WORKER}'s run`, claudeRunId),
    pauseAndSettle(`${CURSOR_WORKER}'s run`, cursorRunId),
  ])

  // The two facts the brief singles out, asserted on both checkpoints before anything is resumed:
  // a checkpoint without them cannot continue the run it belongs to.
  for (const [label, checkpoint, expectedProvider] of [
    [CLAUDE_WORKER, claudeCheckpoint, 'claude_code'],
    [CURSOR_WORKER, cursorCheckpoint, 'cursor'],
  ]) {
    if (checkpoint.sessionId === null || checkpoint.sessionId === '') {
      await fail(`stage 3: ${label}'s checkpoint carries no sessionId -- nothing could resume it`)
    }
    if (checkpoint.provider !== expectedProvider) {
      await fail(
        `stage 3: ${label}'s checkpoint records provider ${JSON.stringify(checkpoint.provider)}, expected ` +
          `${JSON.stringify(expectedProvider)} -- a resume replays the checkpoint's provider verbatim, so this run ` +
          'would come back on the wrong runtime',
      )
    }
  }
  console.log(
    `stage 3: both runs paused with a checkpoint carrying sessionId and provider -- ` +
      `claude_code session ${claudeCheckpoint.sessionId} (pauseReason ${JSON.stringify(claudeCheckpoint.pauseReason)}), ` +
      `cursor session ${cursorCheckpoint.sessionId} (pauseReason ${JSON.stringify(cursorCheckpoint.pauseReason)})`,
  )

  // Resume through the real path too: `requestResume` records the operator's intent, and the
  // DAEMON's own resume pass claims it (`claimResume`) and continues the run (`executeResume`).
  // That is the web button's path end to end, and it is the only one where the process that claims
  // is the process that spawns.
  for (const [label, runId] of [
    [CLAUDE_WORKER, claudeRunId],
    [CURSOR_WORKER, cursorRunId],
  ]) {
    const resumed = await requestResume(runId, null, PAUSE_REQUESTER)
    if (!resumed.ok) {
      await fail(`stage 3: requestResume refused ${label}'s run: ${JSON.stringify(resumed.error)}`)
    }
  }
  console.log('stage 3: resume requested on both runs; waiting for the daemon to claim and continue them')

  async function waitForTerminal(label, runId) {
    return waitUntil(`${label} to reach a terminal state after its resume`, RESUME_TERMINAL_TIMEOUT_MS, async () => {
      const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
      if (TERMINAL_STATUSES.has(row.status)) return { done: true, value: row }
      return { done: false, detail: `status=${row.status} toolCalls=${row.toolCalls}` }
    })
  }
  const [claudeTerminal, cursorTerminal] = await Promise.all([
    waitForTerminal(`${CLAUDE_WORKER}'s run`, claudeRunId),
    waitForTerminal(`${CURSOR_WORKER}'s run`, cursorRunId),
  ])
  console.log(
    `stage 3 PASSED: one pause verb reached two runtimes and both came back -- ` +
      `${CLAUDE_WORKER} paused at step ${claudeCheckpoint.numTurns} then ended ${claudeTerminal.status}; ` +
      `${CURSOR_WORKER} paused at step ${cursorCheckpoint.numTurns} then ended ${cursorTerminal.status}`,
  )

  // ============================================================================================
  // Stage 2: both runs reached a terminal state, and they wrote the same event and checkpoint
  // SHAPE. Shape, not payload: two different vendors' runs must be recognisable as the same kind
  // of history, not as identical histories.
  // ============================================================================================
  async function lifecycleOf(runId) {
    const rows = await prisma.executionEvent.findMany({ where: { runId }, orderBy: { seq: 'asc' } })
    const types = rows.map((row) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type)
    return {
      all: types,
      lifecycle: [...new Set(types.filter((type) => LIFECYCLE_VOCABULARY.has(type)))].sort(),
    }
  }

  // The event log is NOT settled the moment the run row goes terminal, and reading it as if it
  // were is a race this gate lost on its own first rehearsal. A paused Claude run's pump writes
  // the `paused` row and the checkpoint, THEN kills the child (`killWithEscalation`, a two-second
  // grace window), and only then appends `run.paused` -- while this script, which polls the row
  // every 25ms, has already asked for the resume and can see the resumed run conclude inside that
  // same window. The row is a state; the log is a history, and the history is finished last.
  //
  // So the read is a bounded wait for the history to be complete, not a snapshot: exactly the
  // lifecycle stage 2 is about to assert on. A timeout here dumps every event both runs wrote, in
  // order, which is the only useful thing to look at when a lifecycle really is missing a member.
  const { claudeEvents, cursorEvents } = await waitUntil(
    "both runs' event logs to carry a complete lifecycle",
    LIFECYCLE_SETTLE_TIMEOUT_MS,
    async () => {
      const claude = await lifecycleOf(claudeRunId)
      const cursor = await lifecycleOf(cursorRunId)
      const complete = (events) =>
        REQUIRED_LIFECYCLE.every((type) => events.lifecycle.includes(type)) &&
        events.lifecycle.filter((type) => TERMINAL_EVENTS.has(type)).length === 1
      if (complete(claude) && complete(cursor)) return { done: true, value: { claudeEvents: claude, cursorEvents: cursor } }
      return {
        done: false,
        detail: `${CLAUDE_WORKER}: ${JSON.stringify(claude.all)}; ${CURSOR_WORKER}: ${JSON.stringify(cursor.all)}`,
      }
    },
  )

  for (const [label, terminal] of [
    [CLAUDE_WORKER, claudeTerminal],
    [CURSOR_WORKER, cursorTerminal],
  ]) {
    if (terminal.terminalAt === null || terminal.endedAt === null) {
      await fail(
        `stage 2: ${label}'s run is ${terminal.status} but has terminalAt=${String(terminal.terminalAt)} ` +
          `endedAt=${String(terminal.endedAt)} -- a terminal status with no terminal timestamp leaves the run ` +
          'non-terminal for everything that reads those columns',
      )
    }
  }
  for (const [label, events] of [
    [CLAUDE_WORKER, claudeEvents],
    [CURSOR_WORKER, cursorEvents],
  ]) {
    for (const required of REQUIRED_LIFECYCLE) {
      if (!events.lifecycle.includes(required)) {
        await fail(
          `stage 2: ${label}'s run never emitted ${required} -- its lifecycle was ${JSON.stringify(events.lifecycle)}, ` +
            `and every event it wrote, in order, was ${JSON.stringify(events.all)}`,
        )
      }
    }
    const terminalEvents = events.lifecycle.filter((type) => TERMINAL_EVENTS.has(type))
    if (terminalEvents.length !== 1) {
      await fail(
        `stage 2: ${label}'s run emitted ${terminalEvents.length} distinct terminal event type(s) ` +
          `(${JSON.stringify(terminalEvents)}), expected exactly 1`,
      )
    }
  }
  // The non-terminal lifecycle compared member for member. The terminal member deliberately is
  // NOT: `run.succeeded` and `run.failed` are both honest terminal reports, and which one a
  // runtime lands on depends on what its own model did with the prompt (a denied tool call carried
  // through a resume makes a clean finish a failure -- Task 12 §10(f)), not on whether the seam
  // kept its promise. Requiring the two vendors to agree on the VERDICT would be asserting that
  // two models behave identically, which is not what this gate measures.
  const claudeNonTerminal = claudeEvents.lifecycle.filter((type) => !TERMINAL_EVENTS.has(type))
  const cursorNonTerminal = cursorEvents.lifecycle.filter((type) => !TERMINAL_EVENTS.has(type))
  if (JSON.stringify(claudeNonTerminal) !== JSON.stringify(cursorNonTerminal)) {
    await fail(
      `stage 2: the two runtimes' lifecycles differ -- claude_code ${JSON.stringify(claudeNonTerminal)} vs ` +
        `cursor ${JSON.stringify(cursorNonTerminal)}`,
    )
  }

  // The checkpoint shape: the same set of columns actually populated, whichever runtime wrote it.
  // Compared as a KEY SET rather than by value, because the values are vendor facts (a session id,
  // a deny message, a tool name) and demanding they match would be demanding the vendors be the
  // same product. `id`, `runId` and `ts` are this row's own identity, not part of its shape.
  const shapeOf = (checkpoint) =>
    Object.entries(checkpoint)
      .filter(([key, value]) => !['id', 'runId', 'ts'].includes(key) && value !== null && value !== undefined)
      .map(([key]) => key)
      .sort()
  const claudeShape = shapeOf(claudeCheckpoint)
  const cursorShape = shapeOf(cursorCheckpoint)
  if (JSON.stringify(claudeShape) !== JSON.stringify(cursorShape)) {
    const onlyClaude = claudeShape.filter((key) => !cursorShape.includes(key))
    const onlyCursor = cursorShape.filter((key) => !claudeShape.includes(key))
    await fail(
      `stage 2: the two checkpoints have different non-null shapes -- only on claude_code: ` +
        `${JSON.stringify(onlyClaude)}; only on cursor: ${JSON.stringify(onlyCursor)}`,
    )
  }
  console.log(
    `stage 2 PASSED: both runs terminal (${claudeTerminal.status} / ${cursorTerminal.status}) with the same ` +
      `lifecycle ${JSON.stringify(claudeNonTerminal)} + one terminal event each, and the same checkpoint shape ` +
      `${JSON.stringify(claudeShape)}`,
  )

  // ============================================================================================
  // Stage 5: `AgentRun.costUsd` is `null` for the Cursor run and a real number for the Claude run.
  // Not coalesced, on purpose: `0` would be a lie a budget guardrail believes.
  //
  // READ THE ANNOUNCEMENT, NOT ONLY THE COLUMN. A null in `AgentRun.costUsd` has two completely
  // different meanings and this stage exists to keep them apart. `pump.ts` writes the column only
  // on the path that HAD a terminal result to write it from; a run whose stream ends without one
  // is concluded `failed` with the column never touched (`pump.ts:667-681`), and an untouched
  // column reads byte-for-byte like "this runtime reports no cost". Stage 2 admits such a run --
  // it emitted `run.started`/`run.paused`/`run.resumed` and exactly one terminal event, and the
  // terminal member is deliberately not compared between runtimes -- so a Cursor run that died
  // mid-stream after its resume would have satisfied the old `costUsd !== null` check for exactly
  // the wrong reason. That is the conflation this milestone was written to remove, reproduced
  // inside the gate meant to prove it gone.
  //
  // So the figure is read from `run.succeeded`, whose payload carries what the runtime actually
  // REPORTED (`pump.ts:709`), and the run is required to have reached `succeeded` first. A run
  // that ended any other way did not report a cost, and a cost nobody wrote is not a cost the
  // provider reported.
  // ============================================================================================

  /** The `costUsd` a run's own `run.succeeded` event announced -- proof the figure was reported,
   *  not left over. Fails, naming the status, for a run that never got to announce anything. */
  async function reportedCostOf(label, runId, terminal) {
    if (terminal.status !== 'succeeded') {
      await fail(
        `stage 5: ${label}'s run ended ${terminal.status}, not succeeded, so no cost was ever reported for it. ` +
          "Its costUsd column says whatever nobody wrote, and this stage cannot tell that apart from a runtime's " +
          'honest "I do not report cost" -- which is the whole distinction it exists to make.',
      )
    }
    const announcement = await prisma.executionEvent.findFirst({
      where: { runId, type: 'run_succeeded' },
      orderBy: { seq: 'desc' },
    })
    if (announcement === null) {
      await fail(`stage 5: ${label}'s run is succeeded but never emitted run.succeeded, so nothing announced its cost`)
    }
    const payload = announcement.payload
    if (payload === null || typeof payload !== 'object' || !('costUsd' in payload)) {
      await fail(
        `stage 5: ${label}'s run.succeeded payload carries no costUsd key at all (${JSON.stringify(payload)}) -- ` +
          'the terminal announcement is where a reader learns what a run cost',
      )
    }
    return payload.costUsd
  }

  const cursorReportedCost = await reportedCostOf(CURSOR_WORKER, cursorRunId, cursorTerminal)
  const claudeReportedCost = await reportedCostOf(CLAUDE_WORKER, claudeRunId, claudeTerminal)

  if (cursorTerminal.costUsd !== null || cursorReportedCost !== null) {
    await fail(
      `stage 5: the cursor run recorded costUsd=${String(cursorTerminal.costUsd)} and announced ` +
        `costUsd=${String(cursorReportedCost)}; both must be null. Cursor reports no cost ` +
        '(reportsCost: false); any number here is invented, and a budget that believes an invented number is ' +
        'worse than no budget at all.',
    )
  }
  if (typeof claudeTerminal.costUsd !== 'number' || !Number.isFinite(claudeTerminal.costUsd)) {
    await fail(
      `stage 5: the claude_code run recorded costUsd=${String(claudeTerminal.costUsd)}, expected a finite number -- ` +
        'Claude Code reports its own cost and the run row is where a budget reads it',
    )
  }
  if (claudeReportedCost !== claudeTerminal.costUsd) {
    await fail(
      `stage 5: the claude_code run's row says costUsd=${String(claudeTerminal.costUsd)} but its run.succeeded ` +
        `announced ${String(claudeReportedCost)} -- the column and the log must be the same measurement, or a ` +
        'reader of one is being told something a reader of the other is not',
    )
  }
  console.log(
    `stage 5 PASSED: both runs reached succeeded and announced their own cost -- null for the cursor run, ` +
      `${claudeTerminal.costUsd} for the claude_code run (row and run.succeeded agree) -- unknown and measured, ` +
      'never coalesced and never merely unwritten',
  )

  console.log('PASS: two providers kept one promise')
  exitCode = 0
} finally {
  if (daemon !== null && daemon.exitCode === null) {
    daemon.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (daemon.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (daemon.exitCode === null) daemon.kill('SIGKILL')
  }
  // FK-ordered cleanup, the same order `gate-m11-shell.mjs` uses: `ExecutionEvent` has no FK to
  // `Workspace` (M2's append-only log outlives entity lifecycles by design) so it is deleted
  // explicitly first, then the workspace delete cascades Team/Agent/Task/AgentRun/Checkpoint/
  // ProviderConfiguration.
  for (const workspaceId of [unbudgetedWorkspaceId, budgetedWorkspaceId]) {
    if (workspaceId !== null) {
      await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    }
  }
  for (const workspaceId of [unbudgetedWorkspaceId, budgetedWorkspaceId]) {
    if (workspaceId !== null) {
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
    }
  }
  // The repositories carry the run worktrees, the `.slaveofai` run directories and the git exclude
  // file the Cursor adapter appended to -- all of it inside these two trees, so nothing this gate
  // wrote outlives them.
  if (unbudgetedRepo !== null) rmSync(unbudgetedRepo, { recursive: true, force: true })
  if (budgetedRepo !== null) rmSync(budgetedRepo, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
