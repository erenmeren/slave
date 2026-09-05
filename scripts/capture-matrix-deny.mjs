// M19 Task A1: record what the REAL `claude` CLI emits when this repo's own permission matrix
// refuses a tool call -- and retire `packages/providers/test/fixtures/permission-matrix-deny.ndjson`,
// the one hand-authored fixture in that directory.
//
// This script is committed as the RUNNABLE PROVENANCE of that fixture, not as a gate. Nothing here
// asserts a product promise; it drives one paid run and saves what came back. But it is written to
// the gate scripts' shape on purpose (`gate-m12-providers.mjs` is the crib: `let exitCode = 1`, a
// single `try`, bounded waits that name what they waited for, a `finally` that kills every process
// it spawned and removes every row it created, `process.exit(exitCode)` last) because it spends
// real money on a real account, and a capture script that leaks a daemon or a workspace costs more
// than the run it was recording.
//
// WHAT MAKES THE DENY REAL. Everything in the enforcement chain is the repo's own, unfaked:
//
//   - the deny is an `AgentPermission` row (`{ tool: 'run tests', mode: 'deny' }`) --
//     `gate-m18-skill-and-teeth.mjs:504`'s seed;
//   - `apps/orchestrator/src/tick.ts` resolves it through `packages/control`'s `resolveDenyList`
//     and writes the run's own `permissions.json` at dispatch;
//   - `scripts/pause-gate.sh` (the PreToolUse hook the adapter registers) reads that file through
//     `scripts/lib/permissions.sh` and spells the deny;
//   - the orchestrator DAEMON dispatches, exactly as an operator's would.
//
// The ONLY thing this script inserts is a stdout tee: `SLAVEOFAI_CLAUDE_BIN` points at a two-line
// bash wrapper that runs the real binary and copies its stdout to disk. The pump persists no raw
// stream anywhere, so the transcript has to be taken at the source or it does not exist.
//
// WHY THE WRAPPER IS SHAPED THE WAY IT IS. `exec > >(tee "$OUT")` then `exec claude "$@"` is the
// obvious spelling and it is wrong: the first `exec` redirects the WRAPPER's stdout through a
// process substitution whose lifetime is not tied to the second `exec`, so the tail of the stream
// can be lost when the shell is replaced. A plain pipeline plus `exit ${PIPESTATUS[0]}` keeps the
// child's own exit status -- which the adapter reads to decide whether the run crashed -- while
// copying every byte.
//
// WHAT IT COSTS. Exactly ONE paid `claude` run, on the `sonnet` alias (`gate-m12-providers.mjs:85`'s
// precedent) against a task whose whole body is "read one small file, then try to run tests".
// `maxAttempts: 1` so a run that fails can never be reworked into a second paid attempt while this
// script is waiting on something else.
//
// DIVERGENCE IS DATA, NOT FAILURE. If the real CLI's stream does not match the hand-authored
// fixture's shape -- a different event order, a differently-shaped `permission_denials`, a run that
// concludes some other way -- this script SAVES THE CAPTURE ANYWAY and prints the divergence. A
// recording that contradicts an assumption is the most valuable thing this script can produce; a
// recording massaged until it agrees is worth nothing.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '../packages/db/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'

const POLL_INTERVAL_MS = 250
// Bounds on a REAL vendor round trip, tuned the way `gate-m12-providers.mjs` tunes its own: a
// timeout sized for a fake CLI's replay speed would abandon a paid run for being slow rather than
// for being wrong -- and an abandoned paid run is money spent for no recording.
const DISPATCH_TIMEOUT_MS = 180_000
const RUN_CONCLUDE_TIMEOUT_MS = 600_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
// Short, because everything it waits on has already happened: the CLI has printed its terminal
// `result` line and only its closing hook responses can still be in flight (see the wait itself).
const CAPTURE_SETTLE_TIMEOUT_MS = 30_000
const CAPTURE_SETTLE_POLLS = 4

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const runTimestamp = new Date().toISOString()

// Prefixed and timestamped for the reason `gate-m12-providers.mjs` gives: `Workspace.name` has no
// unique constraint, so a unique name per run keeps two executions apart, while `preflightCleanup`
// still removes leftovers by PREFIX so a run killed before its own `finally` cannot leave rows a
// later run would report as its own.
const WORKSPACE_PREFIX = 'M19 A1 Capture'
const WORKSPACE_NAME = `${WORKSPACE_PREFIX} ${runTimestamp}`
const WORKER_NAME = 'Capture Worker'
const WORKER_PROVIDER = 'claude_code'
// The cheap alias, pinned: `gate-m12-providers.mjs:85`'s precedent, and the structural reason this
// capture stays inside its $1 cap.
const WORKER_MODEL = 'sonnet'

// The capability the matrix denies, and the vendor tool `packages/control/src/permission.ts`'s
// `CAPABILITY_TOOLS` resolves it to for `claude_code`. Named here so the printed summary and the
// README provenance quote the same two strings the seed uses.
const DENIED_CAPABILITY = 'run tests'
const EXPECTED_DENIED_TOOL = 'Bash'

// The scenario, mirroring the hand-authored fixture it replaces: one allowed `Read` of a known
// file, then a `Bash` call the matrix refuses, then the agent reporting what it found instead of
// retrying. The file's single line is what makes the third step checkable in the transcript.
const TARGET_FILE = 'target.txt'
const TARGET_LINE = 'line one: alpha\n'
const TASK_TITLE = 'Read a file and try to run tests'
const TASK_DESCRIPTION = 'Read `target.txt`, then run the test suite with `npm test`, then report what target.txt contains.'

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'stopped'])

/** Same as `gate-m12-providers.mjs`'s `makeRepo` -- a real repository, because the tick provisions
 *  a real `git worktree` in it. `target.txt` is COMMITTED rather than merely written: the run acts
 *  in a worktree checked out from `baseBranch`, so an uncommitted file would not be there to read. */
function makeRepo(suffix) {
  const dir = mkdtempSync(join(tmpdir(), `slaveofai-capture-matrix-deny-${suffix}-`))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Capture'])
  git(['config', 'user.email', 'capture@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  writeFileSync(join(dir, TARGET_FILE), TARGET_LINE)
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/** The absolute path of `name` on `PATH`, or `null` -- `gate-m12-providers.mjs`'s own resolver,
 *  verbatim, including its "an override that already names a path is checked where it points"
 *  arm, because `spawn` treats such a value that way too. */
function resolveOnPath(name) {
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

/**
 * The binary's own `--version`, recorded BEFORE the run -- `gate-m13-runtime.mjs:228-234`, copied
 * because it is a gate-local function there.
 *
 * The CLIs on this machine SELF-UPDATE between runs (project memory, 2026-09-01), so the version
 * that produced a given recording is not recoverable from the binary on disk afterwards: it is
 * captured here or it is gone, and a fixture whose provenance names the wrong version is a fixture
 * nobody can re-derive.
 */
function versionOf(bin) {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 60_000 }).trim().split('\n')[0] ?? '<empty>'
  } catch (cause) {
    return `<could not read --version: ${cause instanceof Error ? cause.message : String(cause)}>`
  }
}

/** True when `pid` really is an orchestrator daemon -- `gate-m18-skill-and-teeth.mjs:204`'s check.
 *  `pgrep -f 'cli.js daemon'` matches its OWN wrapper shell (and this script's, and any editor
 *  buffer holding the string), so the pid list it returns is confirmed against `/proc/<pid>/cmdline`
 *  argv-by-argv rather than believed. */
function isRealDaemonProcess(pid) {
  let cmdline
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'latin1')
  } catch {
    return false
  }
  const argv = cmdline.split('\0').filter((part) => part !== '')
  for (let i = 0; i < argv.length - 1; i += 1) {
    if ((argv[i] === 'cli.js' || argv[i].endsWith('/cli.js')) && argv[i + 1] === 'daemon') return true
  }
  return false
}

/** Removes any `M19 A1 Capture`-named rows a prior interrupted run left behind, in the FK order the
 *  `finally` below uses: the append-only events first (no FK to `Workspace`), then the workspace,
 *  which cascades Team/Agent/AgentPermission/Task/AgentRun/Checkpoint. */
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
let repoPath = null
let workspaceId = null
let daemon = null
let daemonOutput = ''
let daemonExited = false
let captureDir = null
let lastCaptureSize = -1
let settledPolls = 0

/** Every row this capture created, for a diagnostic throw -- scoped by workspace NAME rather than
 *  by tracked ids, since a failure can happen before some of those ids are even set. */
async function dumpRows() {
  const workspaces = await prisma.workspace.findMany({
    where: { name: { startsWith: WORKSPACE_PREFIX } },
    select: { id: true, name: true },
  })
  const dump = []
  for (const workspace of workspaces) {
    const runs = await prisma.agentRun.findMany({
      where: { agent: { team: { workspaceId: workspace.id } } },
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
        status: run.status,
        pid: run.pid,
        provider: run.provider,
        sessionId: run.sessionId,
        toolCalls: run.toolCalls,
        costUsd: run.costUsd,
        pausedAtStep: run.pausedAtStep,
        terminalAt: run.terminalAt,
      })),
      events: events.map((event) => ({
        seq: event.seq,
        runId: event.runId,
        type: DOMAIN_EVENT_TYPE_BY_DB_VALUE[event.type] ?? event.type,
        payload: event.payload,
      })),
    })
  }
  // `ExecutionEvent.seq` is a BigInt and `JSON.stringify` refuses it outright; a diagnostic dump
  // that throws is a diagnostic dump that is not there when it is needed.
  return JSON.stringify(dump, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)
}

/** The `gate-m8a-estop.mjs` idiom: a throw carrying the state that made the call, not just "it
 *  timed out". Never used for a SHAPE divergence -- those are printed and the capture is kept. */
async function fail(message) {
  const rows = await dumpRows().catch(
    (cause) => `<could not dump rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
  )
  const daemonTail = daemonOutput.length > 4_000 ? `…${daemonOutput.slice(-4_000)}` : daemonOutput
  throw new Error(`${message}\n--- daemon output (tail) ---\n${daemonTail}\n--- rows ---\n${rows}`)
}

/** Polls `probe` until it reports `{ done: true }`. Every unsatisfied tick supplies its own
 *  `detail`, so a wait that runs out says what it last SAW rather than only what it wanted. */
async function waitUntil(description, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs
  let lastDetail = '<never probed>'
  for (;;) {
    if (daemonExited) await fail(`the daemon exited while waiting for ${description}`)
    const result = await probe()
    if (result.done) return result.value
    lastDetail = result.detail
    if (Date.now() > deadline) {
      await fail(`timed out after ${timeoutMs}ms waiting for ${description} -- last seen: ${lastDetail}`)
    }
    await delay(POLL_INTERVAL_MS)
  }
}

/** Notes a difference between what the hand-authored fixture claimed and what the real CLI did.
 *  Printed, collected, and reported at the end -- never fatal. */
const divergences = []
function note(divergence) {
  divergences.push(divergence)
  console.log(`DIVERGENCE: ${divergence}`)
}

try {
  // ---- Preflight. Each one fails FAST and by name: a precondition discovered mid-run is a
  // precondition discovered after the money is spent.
  const envPath = join(repoRoot, '.env')
  if (!existsSync(envPath)) {
    throw new Error(
      `no .env at ${envPath} -- this capture runs against the DEVELOPMENT database and reads DATABASE_URL from it. ` +
        'Run it as `node --env-file=.env scripts/capture-matrix-deny.mjs`.',
    )
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this as `node --env-file=.env scripts/capture-matrix-deny.mjs`')
  }
  if (!existsSync(ORCHESTRATOR_CLI)) {
    throw new Error(`no orchestrator CLI at ${ORCHESTRATOR_CLI} -- run \`npx tsc --build\` first`)
  }

  const claudeBinName = process.env['SLAVEOFAI_CLAUDE_BIN'] ?? 'claude'
  const claudeBin = resolveOnPath(claudeBinName)
  if (claudeBin === null) {
    throw new Error(
      `no executable ${JSON.stringify(claudeBinName)} on PATH. This capture drives the REAL Claude Code CLI; ` +
        'there is no fixture mode and no skip.',
    )
  }
  // The one refusal no other script in this repo needs. Every gate here can be pointed at
  // `scripts/gate-fakes/fake-claude.mjs`, and most are; this script exists precisely to stop doing
  // that, and a fake resolved here would produce a "recording" of a replay of the very
  // hand-authored fixture it is meant to retire -- a lie that would look exactly like a success.
  if (claudeBin.includes('gate-fakes')) {
    throw new Error(
      `REFUSED: ${claudeBin} is a gate fake. This script records the REAL CLI; capturing a fake replaying the ` +
        'hand-authored fixture would reproduce that fixture and call it evidence. Unset SLAVEOFAI_CLAUDE_BIN.',
    )
  }

  try {
    await prisma.$queryRaw`select 1`
  } catch (cause) {
    throw new Error(
      `the database at DATABASE_URL is not reachable (${cause instanceof Error ? cause.message : String(cause)}) -- ` +
        'start Postgres and apply migrations first.',
    )
  }

  // A second live daemon on this host could dispatch this capture's freshly-created `ready` task
  // out from under it, on a binary this script never wrapped -- money spent producing no recording.
  const candidatePids = (spawnSync('pgrep', ['-f', 'cli.js daemon'], { encoding: 'utf8' }).stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => Number(line))
  const realDaemonPids = candidatePids.filter((pid) => isRealDaemonProcess(pid))
  if (realDaemonPids.length > 0) {
    throw new Error(`REFUSED -- an orchestrator daemon is already running (pid ${realDaemonPids.join(', ')})`)
  }

  // The version FIRST, before anything is spawned: see `versionOf`'s docstring.
  const claudeVersion = versionOf(claudeBin)
  console.log(`claude:  ${claudeBin}`)
  console.log(`version: ${claudeVersion}`)

  await preflightCleanup()

  // ---- The tee wrapper. Kept OUTSIDE the temp repository on purpose: the `finally` removes the
  // repository (it carries the worktree and the run scratch directory), and the capture is the one
  // thing that must outlive this script.
  captureDir = mkdtempSync(join(tmpdir(), 'slaveofai-capture-matrix-deny-out-'))
  const wrapperPath = join(captureDir, 'claude-tee.sh')
  writeFileSync(
    wrapperPath,
    [
      '#!/usr/bin/env bash',
      '# Generated by scripts/capture-matrix-deny.mjs. Runs the REAL claude CLI and copies its',
      '# stdout to disk. One file per invocation, named by this wrapper shell\'s pid, so that a',
      '# second spawn (a resume, a retry) shows up as a second file instead of silently',
      '# concatenating into the first. `exit ${PIPESTATUS[0]}` preserves the CLI\'s own status --',
      "# the adapter reads it to decide whether the run crashed, and `tee`'s status is not it.",
      `printf '%s\\n' "$*" >> ${JSON.stringify(join(captureDir, 'invocations.log'))}`,
      `${JSON.stringify(claudeBin)} "$@" | tee ${JSON.stringify(join(captureDir, 'raw'))}-$$.ndjson`,
      'exit ${PIPESTATUS[0]}',
      '',
    ].join('\n'),
  )
  chmodSync(wrapperPath, 0o755)
  console.log(`capture dir: ${captureDir}`)

  // ---- One workspace, one team, one agent carrying the matrix deny, one task ----------------
  repoPath = makeRepo('repo')
  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath,
      autoMerge: false,
      verifyCommands: ['true'],
      setupCommands: [],
      // `budgetUsd` deliberately UNSET, so the schema's `@default(20)` applies: this run is
      // budget-guarded the way every ordinary workspace in this system is.
    },
  })
  workspaceId = workspace.id
  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  const agent = await prisma.agent.create({
    data: { teamId: team.id, name: WORKER_NAME, role: 'backend', provider: WORKER_PROVIDER, model: WORKER_MODEL },
  })
  // `gate-m18-skill-and-teeth.mjs:504`'s seed, verbatim: 'run tests' resolves to `Bash` for
  // `claude_code` (`CAPABILITY_TOOLS`), which is exactly the tool the task below is certain to try.
  await prisma.agentPermission.create({ data: { agentId: agent.id, tool: DENIED_CAPABILITY, mode: 'deny' } })
  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: TASK_TITLE,
      description: TASK_DESCRIPTION,
      status: 'ready',
      requiredRole: 'backend',
      // One attempt, for the reason `gate-m12-providers.mjs` gives: a failed run that could be
      // reworked would be dispatched again -- a second paid attempt this script never asked for.
      maxAttempts: 1,
    },
  })
  console.log(`workspace ${workspaceId}; agent ${agent.id}; task ${task.id}`)
  console.log(`matrix: deny ${JSON.stringify(DENIED_CAPABILITY)} -> expected vendor tool ${EXPECTED_DENIED_TOOL}`)

  // ---- The real daemon, driven exactly as `gate-m12-providers.mjs:493` drives it. The ONLY
  // override is the stdout tee; `SLAVEOFAI_CLAUDE_ARGS` is deliberately left untouched, so the
  // adapter builds the same argv a production dispatch builds.
  daemon = spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspaceId, '--period', '500'], {
    cwd: repoRoot,
    env: { ...process.env, SLAVEOFAI_CLAUDE_BIN: wrapperPath },
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

  const dispatched = await waitUntil('the worker to be dispatched with a pid and a provider', DISPATCH_TIMEOUT_MS, async () => {
    const row = await prisma.agentRun.findFirst({ where: { agentId: agent.id }, orderBy: { startedAt: 'desc' } })
    if (row === null) return { done: false, detail: 'no run row yet' }
    if (row.pid === null || row.provider === null) {
      return { done: false, detail: `${row.status} pid=${String(row.pid)} provider=${String(row.provider)}` }
    }
    return { done: true, value: row }
  })
  console.log(`dispatched run ${dispatched.id} (pid ${String(dispatched.pid)}, provider ${String(dispatched.provider)})`)

  const concluded = await waitUntil('the run to reach a terminal state', RUN_CONCLUDE_TIMEOUT_MS, async () => {
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: dispatched.id } })
    if (TERMINAL_STATUSES.has(row.status)) return { done: true, value: row }
    return { done: false, detail: `run is ${row.status} (toolCalls=${row.toolCalls})` }
  })
  console.log(`run ${concluded.id} concluded ${concluded.status} (costUsd=${String(concluded.costUsd)})`)

  // ---- What the run left in the database. Read, reported, and compared against what the
  // hand-authored fixture asserted -- but NEVER used to reject the recording.
  const events = await prisma.executionEvent.findMany({
    where: { runId: concluded.id },
    orderBy: { seq: 'asc' },
    select: { type: true, payload: true },
  })
  const eventTypes = events.map((event) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[event.type] ?? event.type)
  const toolDenied = events.filter((event) => (DOMAIN_EVENT_TYPE_BY_DB_VALUE[event.type] ?? event.type) === 'run.tool_denied')
  console.log(`events: ${JSON.stringify(eventTypes)}`)
  console.log(`run.tool_denied payloads: ${JSON.stringify(toolDenied.map((event) => event.payload))}`)

  if (toolDenied.length === 0) {
    note(
      'the run emitted NO run.tool_denied event -- the agent never attempted a matrix-denied tool, or the deny ' +
        'did not reach the stream. This capture does not record a matrix deny.',
    )
  } else if (toolDenied.length !== 1) {
    note(`the run emitted ${toolDenied.length} run.tool_denied events; the hand-authored fixture models exactly 1`)
  }
  for (const event of toolDenied) {
    const payload = event.payload
    if (payload?.tool !== EXPECTED_DENIED_TOOL || payload?.capability !== DENIED_CAPABILITY) {
      note(
        `a run.tool_denied payload is ${JSON.stringify(payload)}, not ` +
          `{"tool":"${EXPECTED_DENIED_TOOL}","capability":"${DENIED_CAPABILITY}"}`,
      )
    }
  }
  if (concluded.status !== 'succeeded') {
    note(
      `the run concluded ${concluded.status}, not succeeded -- the hand-authored fixture models a matrix deny the ` +
        'run survives',
    )
  }
  if (eventTypes.includes('run.paused')) {
    note('the run emitted run.paused -- a matrix deny must never pause the run (M18 Task 6 routing)')
  }
  if (eventTypes.includes('guardrail.tripped')) {
    note('the run emitted guardrail.tripped, which the hand-authored fixture models as absent for a matrix deny')
  }

  // ---- The recording itself. One file per `claude` invocation; more than one means the run was
  // resumed or retried, and this script says so rather than picking one and calling it the capture.
  const rawFiles = readdirSync(captureDir)
    .filter((name) => name.startsWith('raw') && name.endsWith('.ndjson'))
    .sort()
  if (rawFiles.length === 0) {
    await fail(
      `no raw capture was written into ${captureDir} -- the tee wrapper never ran, so SLAVEOFAI_CLAUDE_BIN did not ` +
        'reach the adapter (or the CLI wrote nothing at all)',
    )
  }
  if (rawFiles.length !== 1) {
    note(`${rawFiles.length} claude invocations were captured (${rawFiles.join(', ')}); a single start produces one`)
  }
  const rawPath = join(captureDir, rawFiles[0])
  // The row going terminal does NOT mean the stream is finished. `pumpRun` writes `run.succeeded`
  // the moment it parses the terminal `result` line, and the CLI keeps emitting after that -- this
  // very capture ends with a `Stop` hook response two lines PAST the `result`. Reading here without
  // waiting would truncate the recording at whatever byte the tee had flushed, and a truncated
  // recording is exactly the fabrication this script exists to remove. So: wait for the file to
  // stop growing, bounded, before reading a byte of it.
  await waitUntil('the captured stream to stop growing', CAPTURE_SETTLE_TIMEOUT_MS, async () => {
    const size = statSync(rawPath).size
    if (size === lastCaptureSize && size > 0) {
      settledPolls += 1
      if (settledPolls >= CAPTURE_SETTLE_POLLS) return { done: true, value: size }
    } else {
      settledPolls = 0
      lastCaptureSize = size
    }
    return { done: false, detail: `${size} bytes, stable for ${settledPolls} poll(s)` }
  })
  const raw = readFileSync(rawPath, 'utf8')
  const lines = raw.split('\n').filter((line) => line.trim() !== '')
  // `Buffer.byteLength`, not `raw.length`: the latter counts UTF-16 code units, and this stream
  // carries non-ASCII (the agent's own report uses an em dash), so the two disagree by exactly the
  // multi-byte characters -- which reads like a truncated capture when it is nothing of the kind.
  console.log(`capture: ${rawPath} (${lines.length} lines, ${Buffer.byteLength(raw, 'utf8')} bytes)`)

  // The terminal `result` line is where `total_cost_usd` and `permission_denials` live -- the two
  // facts the fixture's README has to quote, and the two the pump's failure computation reads.
  let terminal = null
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      if (parsed?.type === 'result') terminal = parsed
    } catch {
      // A line that is not JSON is itself a finding, reported below; it is never a reason to stop.
    }
  }
  const unparsable = lines.filter((line) => {
    try {
      JSON.parse(line)
      return false
    } catch {
      return true
    }
  })
  if (unparsable.length > 0) note(`${unparsable.length} captured line(s) are not JSON`)

  if (terminal === null) {
    note('the capture carries NO terminal `result` line -- no cost and no permission_denials to quote')
  } else {
    console.log(`total_cost_usd: ${String(terminal.total_cost_usd)}`)
    console.log(`permission_denials: ${JSON.stringify(terminal.permission_denials)}`)
    console.log(`is_error: ${String(terminal.is_error)}; subtype: ${String(terminal.subtype)}; num_turns: ${String(terminal.num_turns)}`)
    if (!Array.isArray(terminal.permission_denials) || terminal.permission_denials.length === 0) {
      note(
        'the terminal result line carries no permission_denials entry -- the hand-authored fixture asserts a matrix ' +
          "deny lands there, matching what hook-deny.ndjson measures the real CLI doing for any hook deny",
      )
    }
  }

  const last = lines.at(-1)
  let lastParsed = null
  try {
    lastParsed = last === undefined ? null : JSON.parse(last)
  } catch {
    lastParsed = null
  }
  if (lastParsed?.hook_event !== 'Stop') {
    note(
      `the capture's last line is ${JSON.stringify(lastParsed?.type ?? '<unparsable>')}/` +
        `${JSON.stringify(lastParsed?.subtype ?? null)}, not the routine Stop hook line every fixture in the replay ` +
        "namespace ends with (fake-claude.test.ts's 'every fixture file ends with the routine Stop hook line')",
    )
  }

  console.log('')
  console.log('---- capture summary ----')
  console.log(`version:    ${claudeVersion}`)
  console.log(`date:       ${runTimestamp.slice(0, 10)}`)
  console.log(`command:    node --env-file=.env scripts/capture-matrix-deny.mjs`)
  console.log(`cost:       ${terminal === null ? '<no terminal line>' : String(terminal.total_cost_usd)}`)
  console.log(`capture:    ${rawPath}`)
  console.log(`divergences: ${divergences.length === 0 ? 'none' : String(divergences.length)}`)
  for (const [index, divergence] of divergences.entries()) console.log(`  ${index + 1}. ${divergence}`)

  // Exit 0 means THE CAPTURE HAPPENED, not that it agreed with the fixture it replaces. A
  // divergence is the finding this script exists to surface; refusing to exit 0 on one would make
  // a disagreement look like a broken script and invite a re-run that spends the money again.
  exitCode = 0
} finally {
  if (daemon !== null && daemon.exitCode === null) {
    daemon.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (daemon.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (daemon.exitCode === null) daemon.kill('SIGKILL')
  }
  // FK-ordered, the same order the gates use: `ExecutionEvent` has no FK to `Workspace` (M2's
  // append-only log outlives entity lifecycles by design), so it goes first; the workspace delete
  // then cascades Team/Agent/AgentPermission/Task/AgentRun/Checkpoint.
  if (workspaceId !== null) {
    await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  // The repository carries the worktree and the run's scratch directory (`permissions.json`,
  // `settings.json`, `pause.flag`), so nothing this script wrote there outlives it. `captureDir` is
  // deliberately NOT removed: it holds the recording.
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
