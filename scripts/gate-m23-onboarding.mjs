// The M23 gate (spec §9): the whole milestone proved end to end, zero spend. Skeleton borrowed
// from `scripts/gate-m8a-merge.mjs` -- dist imports, `mkdtemp` repo, the daemon spawned against the
// fake `claude` CLI's `m8a-flow` fixture, a poll-until-`task.done` loop, one top-level `try` with a
// `finally` that tears down in a fixed order, `PASS:`/`FAIL:` lines, `exitCode` starting at 1 and
// flipped only by falling off the end of the `try`.
//
// Nine stages (spec §9), run in this order -- NOT the spec's own 1..9 numbering, because 4-7 need a
// live `next dev` and 1-3/9 do not, and two `next dev` boots must never overlap (M20's rule, restated
// in `gate-m15-boundary.mjs`/`gate-m20-auth.mjs`):
//   1. repo          -- `mkdtemp`, a real git history, a package.json whose `test` script exits 0.
//   2. CLI            -- `create-workspace` through `apps/orchestrator/dist/cli.js`, plus its two
//                        negative controls (a relative `--repo`, no `--verify`).
//   3. daemon to done -- two ready `backend` tasks (one for 4/5a/7, one for 5b), a `backend` worker,
//                        a `reviewer`, and an unrelated idle slave, driven by a real daemon
//                        subprocess against the fake CLI until BOTH tasks reach `done`. The daemon
//                        is then stopped -- everything from here on is reads plus one `next dev`.
//   5a. GC (aged)     -- in-process, no web needed: age the first task's `task.done` event past the
//                        TTL, run `collectWorktrees` once, assert the tree is gone, the branch
//                        survives, `worktreePath` is cleared, and the event landed.
//   [next dev, loopback mode, boot #1 of 2]
//   4. artifacts      -- the tasks snapshot lists a verify log, the reader route returns its text,
//                        a forged `/etc/hostname` row is refused 403.
//   5b. GC (operator) -- the second task's worktree collected through the DELETE route; an
//                        untouched non-terminal task refused 409.
//   7. communication  -- the graph names an implementer -> reviewer `review` edge.
//   6. org            -- `rename-slave`/`set-role`/`delete-slave` on an idle slave (all ok, three
//                        `org.changed` events), then `delete-slave --yes` on the busy worker
//                        deletes it WITH its terminal run history, and `delete-team --yes`
//                        deletes the department WITH its remaining slave (M27 §4: both refuse
//                        only a LIVE run, and there is none by this point) -- five `org.changed`
//                        events in all.
//   [next dev, accounts mode, boot #2 of 2]
//   8. accounts       -- `create-user` through the CLI (stdin password), login, a goal posted with
//                        the cookie (the event carries the user's id), the Activity page naming the
//                        user, `delete-user`, the same cookie now refused 401 `session revoked`.
//   9. finally        -- teardown (below).
//
// A workspace created through `createWorkspace` (`packages/control/src/workspace.ts`) always gets
// `autoMerge: false` -- there is no `--auto-merge` flag on `create-workspace` and this gate does not
// reach into Prisma to force one, unlike `gate-m8a-merge.mjs`. That is not a gap: `merge.ts`'s own
// comment says a workspace that "does not trust auto-merge still wants the task marked done and out
// of the queue, with the branch and worktree left for a human to merge by hand" -- exactly the shape
// stage 5 needs (a `done` task with its worktree still on disk and its branch unmerged, ready to be
// aged or collected on demand). Review still gates the transition to `merging` either way, so
// stage 7's communication edge is unaffected.
//
// Stage 8's Activity-page check is NOT a plain `fetch`, unlike everything else in this file --
// deliberately, and the deviation is recorded here rather than folded in silently. The task brief
// names a plain fetch; measured against this tree, a plain fetch can never satisfy the assertion,
// for a reason that has nothing to do with this gate's own code: `ActivityClient`'s `Timeline`
// virtualizes its rows through `@tanstack/react-virtual`, whose range calculation
// (`@tanstack/virtual-core`'s `calculateRange`) returns no range at all when the viewport's measured
// size is `0` -- exactly the SSR pass's `initialRect: { width: 0, height: 0 }`, since there is no DOM
// to measure before hydration. Verified directly against this tree (not inferred): a plain fetch of
// `/w/<id>/activity` for a workspace with a `userId`-carrying event renders ZERO `data-testid="event-
// *"` nodes and no "by <username>" text anywhere in the returned HTML -- the username appears only
// inside the page's serialized hydration payload, never as rendered text -- while the SAME page,
// visited with a real (headless) browser that actually hydrates, does render it. This is the exact
// situation `gate-m16-chrome.mjs` already exists for ("a plain `fetch` against the HTML cannot give
// it") -- browsers, not a special case -- so stage 8 reuses that gate's own tool for this one check:
// `playwright-core` driving a real Chromium at `CHROMIUM_PATH`. Nothing else in this file needed it.
//
// `finally` teardown, in order: kill whatever is still running (daemon, both `next dev` boots, the
// browser) -- then, if a workspace was ever created, delete events -> tasks -> runs -> slaves ->
// teams -> provider config -> workspace (mirrors cascade already covers most of this; the explicit
// order is kept anyway so a partial run leaves nothing behind even if a single step's filter turns
// out to miss something) -- then the stage 8 user, if it still exists -- then `rmSync` the repo, then
// `$disconnect`. Every delete tolerant of "already gone".
//
// NEVER RUN THIS WHILE A DAEMON OR A `next dev` IS ALREADY RUNNING -- the preflight below refuses
// (the `/proc/<pid>/cmdline` confirmation is `gate-m17-stability.mjs`'s and `gate-m20-auth.mjs`'s,
// copied: a `pgrep -f` candidate list self-matches this gate's own wrapper shell, so each candidate
// is confirmed against its REAL argv before being treated as a live daemon/`next dev`).
//
//   npm run gate:m23-onboarding
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { collectWorktrees } from '../apps/orchestrator/dist/collect.js'
import { WORKTREE_TTL_MS } from '../packages/control/dist/collect.js'
import { prisma } from '../packages/db/dist/client.js'
import { loopbackChildEnv } from './lib/child-env.mjs'

const PASS_LINE =
  'a repo attached, a tree collected, a log read, a roster edited, a hand-off drawn, a name on the event'

const POLL_INTERVAL_MS = 15
const DONE_TIMEOUT_MS = 120_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const NEXT_READY_TIMEOUT_MS = 180_000
const PORT_FREE_TIMEOUT_MS = 10_000
const ACTION_TIMEOUT_MS = 30_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// ---- preflight: no daemon, no next dev, a real Chromium ----------------------------------------
// `pgrep -f` is only a cheap CANDIDATE list -- this gate is routinely launched through `npm run`,
// whose wrapper shell's own argv contains the literal substrings "cli.js daemon" / "next dev" as
// ONE argv entry, so a naive `pgrep -f` match is this gate's own shadow, not a live process. A
// candidate counts only once its REAL argv (`/proc/<pid>/cmdline`, null-byte separated, unlike the
// space-joined string `ps`/`pgrep -a` print) shows two ADJACENT, EXACT entries.
function argvOf(pid) {
  let cmdline
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'latin1')
  } catch {
    return null // already gone, or /proc unreadable (non-Linux) -- not a match either way
  }
  return cmdline.split('\0').filter((part) => part !== '')
}

function isRealDaemonProcess(pid) {
  const argv = argvOf(pid)
  if (argv === null) return false
  for (let i = 0; i < argv.length - 1; i += 1) {
    if ((argv[i] === 'cli.js' || argv[i].endsWith('/cli.js')) && argv[i + 1] === 'daemon') return true
  }
  return false
}

function isRealNextDevProcess(pid) {
  const argv = argvOf(pid)
  if (argv === null) return false
  for (let i = 0; i < argv.length - 1; i += 1) {
    const entry = argv[i]
    if ((entry === 'next' || entry.endsWith('/next')) && argv[i + 1] === 'dev') return true
  }
  return false
}

/** The worker `next dev` forks renames itself `next-server (vX.Y.Z)` -- a SINGLE argv entry, so a
 *  wrapper shell (whose argv[0] is always its own binary path) can never impersonate one. */
function isRealNextServerProcess(pid) {
  const argv = argvOf(pid)
  return argv !== null && argv.length > 0 && argv[0].startsWith('next-server')
}

function confirmedPids(pattern, predicate) {
  const found = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
  return (found.stdout ?? '')
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
    .filter((pid) => predicate(pid))
}

function describe(pid) {
  return `${String(pid)} ${(argvOf(pid) ?? ['<gone>']).join(' ')}`
}

/** Same as `scripts/gate-m20-auth.mjs`'s free-port helper -- `next dev -p <port>` still
 *  auto-increments if something grabs the port between this call and the spawn, so the ready-wait
 *  parses the ACTUAL bound port back out of next dev's own ready line rather than trusting this. */
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

async function portIsFree(port) {
  return await new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

/** Killing `next dev` by its PID can leave the forked `next-server` worker holding the port. Left
 *  bound, it poisons the NEXT boot -- of this gate's own second boot, or of anything else sharing
 *  `apps/web/.next` -- so the port is waited out and then taken by force. */
async function ensurePortFree(port, label) {
  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await portIsFree(port)) return true
    await delay(200)
  }
  console.log(`cleanup: port ${String(port)} (${label}) is still bound after teardown -- killing whatever holds it`)
  spawnSync('fuser', ['-n', 'tcp', String(port), '-k'], { stdio: 'ignore' })
  await delay(500)
  const free = await portIsFree(port)
  if (!free) console.error(`cleanup: port ${String(port)} (${label}) is STILL bound after fuser -k`)
  return free
}

/** Generic child-process stop: SIGTERM, wait, SIGKILL if it did not listen. Used for the daemon and
 *  both `next dev` boots -- idempotent (a `null` or already-exited child is a no-op). */
async function stopChild(child) {
  if (child === null || child.exitCode !== null) return
  child.kill('SIGTERM')
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
  while (child.exitCode === null && Date.now() < deadline) await delay(50)
  if (child.exitCode === null) child.kill('SIGKILL')
}

/** A real repository, because the orchestrator's tick provisions a real worktree in it regardless
 *  of which CLI it spawns (`gate-m8a-merge.mjs`'s `makeRepo`, widened with a real `package.json` --
 *  this gate's workspace is created with `--verify "npm test"`, which actually runs it). */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m23-onboarding-'))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      { name: 'gate-m23-onboarding-fixture', version: '0.0.0', private: true, scripts: { test: 'node -e "process.exit(0)"' } },
      null,
      2,
    )}\n`,
  )
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/** `apps/orchestrator/dist/cli.js`, driven the way an operator would (`--env-file=.env`, one
 *  process per command). `input` feeds stdin -- the only way a password reaches `create-user`/
 *  `set-password` (F3: never a command-line argument). */
function runCli(args, { input } = {}) {
  const result = spawnSync('node', ['--env-file=.env', ORCHESTRATOR_CLI, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    input,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Boots `next dev` on a free port with the given environment, waits for its own ready line (the
 *  ACTUAL bound port, not the one asked for), and returns a handle `stopNextDev` tears down.
 *  Cribbed from `scripts/gate-m20-auth.mjs`'s run B boot block. */
async function bootNextDev(env, label) {
  const preferredPort = await findFreePort()
  const child = spawn(
    'node',
    ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort), '-H', '127.0.0.1'],
    { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  let exited = false
  let resolvedPort = null
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    output += text
    process.stdout.write(`[next:${label}] ${text}`)
    const match = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(output)
    if (match) resolvedPort = Number(match[1])
  })
  child.stderr.on('data', (chunk) => process.stderr.write(`[next:${label}] ${chunk}`))
  child.on('exit', () => {
    exited = true
  })
  child.on('error', (error) => {
    exited = true
    console.error(`[next:${label}] failed to start:`, error)
  })
  const deadline = Date.now() + NEXT_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exited) throw new Error(`next dev (${label}) exited before becoming ready -- output so far: ${output}`)
    if (resolvedPort !== null && /Ready in \d+/.test(output)) break
    await delay(50)
  }
  if (resolvedPort === null || !/Ready in \d+/.test(output)) {
    throw new Error(`next dev (${label}) did not become ready within ${String(NEXT_READY_TIMEOUT_MS)}ms -- output so far: ${output}`)
  }
  console.log(`next dev (${label}) ready at http://127.0.0.1:${String(resolvedPort)}`)
  return { child, port: resolvedPort, baseUrl: `http://127.0.0.1:${String(resolvedPort)}` }
}

async function stopNextDev(server, label) {
  if (server === null) return
  await stopChild(server.child)
  await ensurePortFree(server.port, label)
}

let exitCode = 1
let repoPath = null
let workspaceId = null
let daemon = null
let loopbackServer = null
let accountsServer = null
let browser = null
let accountsUsernameForCleanup = null

try {
  // ---- preflight ---------------------------------------------------------------------------
  {
    const daemonPids = confirmedPids('cli.js daemon', isRealDaemonProcess)
    assert(daemonPids.length === 0, `an orchestrator daemon is already running -- stop it first:\n${daemonPids.map(describe).join('\n')}`)
    const devPids = confirmedPids('next dev', isRealNextDevProcess)
    const workerPids = confirmedPids('next-server', isRealNextServerProcess)
    const runningNext = [...devPids, ...workerPids]
    assert(runningNext.length === 0, `a next dev is already running -- stop it first:\n${runningNext.map(describe).join('\n')}`)
    assert(
      existsSync(CHROMIUM_PATH),
      `no Chromium binary at ${CHROMIUM_PATH} -- stage 8 needs a real browser (set CHROMIUM_PATH to a ` +
        'playwright-installed chromium, e.g. ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome)',
    )
    console.log('preflight: no orchestrator daemon, no next dev/next-server, a real Chromium is present')
  }

  // ============================================================================================
  // 1. Repository.
  // ============================================================================================
  repoPath = makeRepo()
  console.log(`stage 1: fixture repository at ${repoPath} (package.json's "test" script exits 0)`)

  // ============================================================================================
  // 2. `create-workspace` through the CLI, plus its two negative controls.
  // ============================================================================================
  const workspaceName = `M23 Onboarding Gate ${new Date().toISOString()}`
  {
    const created = runCli(['create-workspace', '--name', workspaceName, '--repo', repoPath, '--verify', 'npm test', '--provider', 'claude_code'])
    assert(created.status === 0, `create-workspace: expected exit 0, got ${String(created.status)} -- stderr: ${created.stderr}`)
    const match = /^workspace (\S+) created/.exec(created.stdout.trim())
    assert(match !== null, `create-workspace: stdout did not match "workspace <id> created": ${created.stdout}`)
    workspaceId = match[1]

    const createdEvent = await prisma.executionEvent.findFirst({ where: { workspaceId, type: 'workspace_created' } })
    assert(createdEvent !== null, 'no workspace.created event was recorded')
    const providerConfig = await prisma.providerConfiguration.findFirst({ where: { workspaceId, kind: 'claude_code' } })
    assert(providerConfig !== null, 'no ProviderConfiguration row for claude_code')

    const relativeRepo = runCli([
      'create-workspace',
      '--name',
      `${workspaceName} (relative)`,
      '--repo',
      'relative/path',
      '--verify',
      'npm test',
      '--provider',
      'claude_code',
    ])
    assert(relativeRepo.status === 1, `relative --repo: expected exit 1, got ${String(relativeRepo.status)}`)
    assert(
      relativeRepo.stderr.includes('must be absolute'),
      `relative --repo: expected repo_path_not_absolute text, got: ${relativeRepo.stderr}`,
    )

    const noVerify = runCli(['create-workspace', '--name', `${workspaceName} (no-verify)`, '--repo', repoPath, '--provider', 'claude_code'])
    assert(noVerify.status === 1, `no --verify: expected exit 1, got ${String(noVerify.status)}`)
    assert(
      noVerify.stderr.includes('at least one verify command is required'),
      `no --verify: expected verify_commands_empty text, got: ${noVerify.stderr}`,
    )
  }
  console.log(`stage 2: workspace ${workspaceId} created via the CLI; both negative controls refused`)

  // ============================================================================================
  // 3. Seed the roster and two tasks, drive both to `done` with a real daemon against the fake
  //    `m8a-flow` fixture. Two tasks, not one: stage 5 needs a SECOND terminal task to collect
  //    through the operator route once the web app is up. The idle slave's role ('analyst') is
  //    deliberately not 'backend' or 'reviewer' -- it must never be eligible for dispatch, or it
  //    would gain run history and stop being "idle" by the time stage 6 needs it.
  // ============================================================================================
  let team
  let worker
  let reviewer
  let idle
  let taskA
  let taskB
  {
    team = await prisma.team.create({ data: { workspaceId, name: 'Gate Team' } })
    worker = await prisma.slave.create({ data: { teamId: team.id, name: 'Worker', role: 'backend' } })
    reviewer = await prisma.slave.create({ data: { teamId: team.id, name: 'Reviewer', role: 'reviewer' } })
    idle = await prisma.slave.create({ data: { teamId: team.id, name: 'Idle', role: 'analyst' } })
    const workspaceRow = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    taskA = await prisma.task.create({
      data: {
        workspaceId,
        title: 'Onboarding gate task A',
        description: 'stage 4/5a/7 fixture task (scripts/gate-m23-onboarding.mjs)',
        status: 'ready',
        requiredRole: 'backend',
        maxAttempts: workspaceRow.maxAttempts,
      },
    })
    taskB = await prisma.task.create({
      data: {
        workspaceId,
        title: 'Onboarding gate task B',
        description: 'stage 5b fixture task (scripts/gate-m23-onboarding.mjs)',
        status: 'ready',
        requiredRole: 'backend',
        maxAttempts: workspaceRow.maxAttempts,
      },
    })

    daemon = spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspaceId, '--period', '500'], {
      env: { ...process.env, SLAVEOFAI_CLAUDE_BIN: 'node', SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8a-flow` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    daemon.stdout.on('data', (chunk) => process.stdout.write(`[daemon] ${chunk}`))
    daemon.stderr.on('data', (chunk) => process.stderr.write(`[daemon] ${chunk}`))
    let daemonExited = false
    daemon.on('exit', () => {
      daemonExited = true
    })
    daemon.on('error', (error) => {
      daemonExited = true
      console.error('[daemon] failed to start:', error)
    })

    const deadline = Date.now() + DONE_TIMEOUT_MS
    let doneA = null
    let doneB = null
    while (Date.now() < deadline) {
      if (daemonExited) throw new Error('the daemon exited before both tasks reached done')
      if (doneA === null) {
        const current = await prisma.task.findUniqueOrThrow({ where: { id: taskA.id } })
        if (current.status === 'done') doneA = current
      }
      if (doneB === null) {
        const current = await prisma.task.findUniqueOrThrow({ where: { id: taskB.id } })
        if (current.status === 'done') doneB = current
      }
      if (doneA !== null && doneB !== null) break
      await delay(POLL_INTERVAL_MS)
    }
    assert(doneA !== null && doneB !== null, `both tasks never reached "done" within ${String(DONE_TIMEOUT_MS)}ms`)
    taskA = doneA
    taskB = doneB

    await stopChild(daemon)
    daemon = null
  }
  console.log('stage 3: two backend tasks driven to done by a real daemon against the fake m8a-flow fixture; daemon stopped')

  // ============================================================================================
  // 5a. GC, aged half -- in-process, no web app needed yet.
  // ============================================================================================
  let branchA
  {
    const runA = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: taskA.id, worktreePath: { not: null } } })
    const worktreePathA = runA.worktreePath
    assert(worktreePathA !== null, "task A's run carries no worktreePath")
    assert(existsSync(worktreePathA), `task A's worktree does not exist at ${worktreePathA}`)
    branchA = taskA.branch
    assert(branchA !== null, 'task A has no branch recorded')

    // Raw SQL needs the literal Postgres enum label, which is the DOTTED domain spelling
    // (`schema.prisma`'s `task_done @map("task.done")`) -- NOT `'task_done'`, which is only the
    // Prisma Client's own TS-side identifier for it (the form every ORM-query filter below uses).
    await prisma.$executeRaw`UPDATE "ExecutionEvent" SET ts = ts - interval '8 days' WHERE "taskId" = ${taskA.id} AND type = 'task.done'`

    const report = await collectWorktrees({ workspaceId, now: () => new Date(), ttlMs: WORKTREE_TTL_MS })
    assert(
      report.collected.some((entry) => entry.taskId === taskA.id),
      `collectWorktrees did not collect task A: ${JSON.stringify(report)}`,
    )
    assert(!existsSync(worktreePathA), `task A's worktree still exists at ${worktreePathA} after collection`)

    const branchList = execFileSync('git', ['branch', '--list', 'slaveofai/*'], { cwd: repoPath, encoding: 'utf8' })
    assert(branchList.includes(branchA), `git branch --list slaveofai/* does not name ${branchA}: ${branchList}`)

    const runAAfter = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runA.id } })
    assert(runAAfter.worktreePath === null, "task A's run still carries a worktreePath after collection")

    const collectedEvent = await prisma.executionEvent.findFirst({
      where: { taskId: taskA.id, type: 'task_worktree_collected' },
      orderBy: { seq: 'desc' },
    })
    assert(collectedEvent !== null, 'no task.worktree_collected event was recorded for task A')
    assert(
      collectedEvent.payload?.reason === 'aged',
      `task.worktree_collected payload.reason was not "aged": ${JSON.stringify(collectedEvent.payload)}`,
    )
  }
  console.log('stage 5a: an aged worktree was collected in-process -- directory gone, branch survives, worktreePath cleared')

  // ============================================================================================
  // next dev, loopback mode, boot #1 of 2 -- stages 4, 5b, 7, 6 (spec order: 4, 5, 6, 7).
  // ============================================================================================
  loopbackServer = await bootNextDev(loopbackChildEnv(), 'loopback')

  // ---- 4. Artifacts. --------------------------------------------------------------------------
  {
    const res = await fetch(`${loopbackServer.baseUrl}/api/w/${workspaceId}/tasks`)
    assert(res.status === 200, `tasks snapshot: expected 200, got ${res.status}`)
    const snapshot = await res.json()
    const taskARow = snapshot.tasks.find((t) => t.id === taskA.id)
    assert(taskARow !== undefined, 'task A is missing from the tasks snapshot')
    assert(taskARow.artifacts.length >= 1, `task A has no artifacts in the snapshot: ${JSON.stringify(taskARow)}`)

    const artifactSummary = taskARow.artifacts[0]
    const readRes = await fetch(`${loopbackServer.baseUrl}/api/w/${workspaceId}/tasks/${taskA.id}/artifacts/${artifactSummary.id}`)
    assert(readRes.status === 200, `artifact reader: expected 200, got ${readRes.status}`)
    const logText = await readRes.text()
    assert(logText.length > 0, 'the artifact reader returned no log text')

    const forged = await prisma.artifact.create({ data: { taskId: taskA.id, kind: 'forged', path: '/etc/hostname' } })
    const forgedRes = await fetch(`${loopbackServer.baseUrl}/api/w/${workspaceId}/tasks/${taskA.id}/artifacts/${forged.id}`)
    assert(forgedRes.status === 403, `forged artifact path: expected 403, got ${forgedRes.status}`)
    const forgedBody = await forgedRes.json()
    assert(
      forgedBody.error === 'artifact path outside the artifact root',
      `forged artifact path: unexpected body ${JSON.stringify(forgedBody)}`,
    )
  }
  console.log('stage 4: the tasks snapshot lists an artifact, its log reads back, a forged /etc/hostname row refused 403')

  // ---- 5b. GC, operator half. -----------------------------------------------------------------
  {
    const okRes = await fetch(`${loopbackServer.baseUrl}/api/w/${workspaceId}/tasks/${taskB.id}/worktree`, { method: 'DELETE' })
    assert(okRes.status === 200, `operator collect on task B: expected 200, got ${okRes.status}`)
    const okBody = await okRes.json()
    assert(okBody.ok === true, `operator collect on task B: unexpected body ${JSON.stringify(okBody)}`)

    const workspaceRow = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    const runningTask = await prisma.task.create({
      data: {
        workspaceId,
        title: 'Onboarding gate task C (untouched, running)',
        description: 'stage 5b negative fixture -- never dispatched, status forced to running',
        status: 'running',
        maxAttempts: workspaceRow.maxAttempts,
      },
    })
    const conflictRes = await fetch(`${loopbackServer.baseUrl}/api/w/${workspaceId}/tasks/${runningTask.id}/worktree`, { method: 'DELETE' })
    assert(conflictRes.status === 409, `operator collect on a running task: expected 409, got ${conflictRes.status}`)
    const conflictBody = await conflictRes.json()
    assert(
      conflictBody.error.includes('is running'),
      `operator collect on a running task: unexpected body ${JSON.stringify(conflictBody)}`,
    )
  }
  console.log('stage 5b: task B collected through the operator route; an untouched running task refused 409 task_not_terminal')

  // ---- 7. Communication graph. ----------------------------------------------------------------
  {
    const res = await fetch(`${loopbackServer.baseUrl}/api/w/${workspaceId}/graph/communication`)
    assert(res.status === 200, `communication graph: expected 200, got ${res.status}`)
    const graph = await res.json()
    const edge = graph.edges.find((e) => e.from === worker.id && e.to === reviewer.id && e.kind === 'review')
    assert(edge !== undefined, `no implementer -> reviewer review edge in the communication graph: ${JSON.stringify(graph.edges)}`)
    assert(edge.count >= 1, `implementer -> reviewer edge has count ${String(edge.count)}, expected >= 1`)
  }
  console.log('stage 7: the communication graph names an implementer -> reviewer review edge')

  // ---- 6. Org. --------------------------------------------------------------------------------
  {
    const rename = runCli(['rename-slave', '--slave', idle.id, '--name', 'Idle Renamed'])
    assert(rename.status === 0, `rename-slave: expected exit 0, got ${String(rename.status)} -- stderr: ${rename.stderr}`)
    assert(rename.stdout.includes(`slave ${idle.id} renamed`), `rename-slave: unexpected stdout ${rename.stdout}`)

    const setRole = runCli(['set-role', '--slave', idle.id, '--role', 'qa'])
    assert(setRole.status === 0, `set-role: expected exit 0, got ${String(setRole.status)} -- stderr: ${setRole.stderr}`)
    assert(setRole.stdout.includes(`role set to qa on ${idle.id}`), `set-role: unexpected stdout ${setRole.stdout}`)

    const deleteIdle = runCli(['delete-slave', '--slave', idle.id, '--yes'])
    assert(deleteIdle.status === 0, `delete-slave (idle): expected exit 0, got ${String(deleteIdle.status)} -- stderr: ${deleteIdle.stderr}`)
    assert(deleteIdle.stdout.includes(`slave ${idle.id} deleted`), `delete-slave (idle): unexpected stdout ${deleteIdle.stdout}`)

    const deleteWorker = runCli(['delete-slave', '--slave', worker.id, '--yes'])
    assert(deleteWorker.status === 0, `delete-slave (worker, terminal run history): expected exit 0, got ${String(deleteWorker.status)} -- stderr: ${deleteWorker.stderr}`)
    assert(deleteWorker.stdout.includes(`slave ${worker.id} deleted`), `delete-slave (worker): unexpected stdout ${deleteWorker.stdout}`)
    assert(
      (await prisma.slaveRun.count({ where: { slaveId: worker.id } })) === 0,
      'delete-slave (worker): its runs should be gone along with the row',
    )

    const deleteTeamRes = runCli(['delete-team', '--team', team.id, '--yes'])
    assert(deleteTeamRes.status === 0, `delete-team: expected exit 0, got ${String(deleteTeamRes.status)} -- stderr: ${deleteTeamRes.stderr}`)
    assert(deleteTeamRes.stdout.includes(`team ${team.id} deleted`), `delete-team: unexpected stdout ${deleteTeamRes.stdout}`)
    assert(
      (await prisma.team.findUnique({ where: { id: team.id } })) === null,
      'delete-team: the department row should be gone',
    )

    const orgEvents = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'org_changed' } })
    assert(orgEvents.length === 5, `expected exactly 5 org.changed events, got ${String(orgEvents.length)}`)
  }
  console.log('stage 6: the roster was renamed and re-roled; the idle slave, the busy worker with its run history, and the department were all deleted with --yes')

  await stopNextDev(loopbackServer, 'loopback')
  loopbackServer = null

  // ============================================================================================
  // next dev, accounts mode, boot #2 of 2 -- stage 8.
  // ============================================================================================
  const accountsSecret = randomBytes(32).toString('hex')
  const accountsUsername = `gate-${randomBytes(4).toString('hex')}`
  const accountsPassword = randomBytes(12).toString('base64url') // 16 chars, >= MIN_PASSWORD_LENGTH (12)

  const createUserRes = runCli(['create-user', '--name', accountsUsername], { input: `${accountsPassword}\n` })
  assert(createUserRes.status === 0, `create-user: expected exit 0, got ${String(createUserRes.status)} -- stderr: ${createUserRes.stderr}`)
  const createdUserMatch = /^user (\S+) created/.exec(createUserRes.stdout.trim())
  assert(createdUserMatch !== null, `create-user: stdout did not match "user <id> created": ${createUserRes.stdout}`)
  const accountsUserId = createdUserMatch[1]
  accountsUsernameForCleanup = accountsUsername
  console.log(`stage 8: created throwaway user ${accountsUsername} (${accountsUserId}) via the CLI`)

  accountsServer = await bootNextDev(
    (() => {
      const env = { ...process.env, SLAVEOFAI_SESSION_SECRET: accountsSecret }
      delete env.SLAVEOFAI_PASSWORD // a stale .env still setting it must not matter
      return env
    })(),
    'accounts',
  )

  const loginRes = await fetch(`${accountsServer.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: accountsUsername, password: accountsPassword }),
  })
  assert(loginRes.status === 204, `login: expected 204, got ${loginRes.status}`)
  const setCookie = loginRes.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0]
  assert(cookie.startsWith('slaveofai_session='), `login: unexpected Set-Cookie ${setCookie}`)
  console.log('stage 8: logged in, cookie minted')

  const goalText = 'gate:m23-onboarding accounts probe -- harmless, this workspace is a throwaway'
  const goalRes = await fetch(`${accountsServer.baseUrl}/api/w/${workspaceId}/goal`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ goal: goalText }),
  })
  assert(goalRes.status === 200, `goal post: expected 200, got ${goalRes.status}`)
  const goalBody = await goalRes.json()
  assert(goalBody.ok === true, `goal post: unexpected body ${JSON.stringify(goalBody)}`)

  const goalEvent = await prisma.executionEvent.findFirst({
    where: { workspaceId, type: 'workspace_goal_set' },
    orderBy: { seq: 'desc' },
  })
  assert(goalEvent !== null, 'no workspace.goal_set event was recorded')
  assert(goalEvent.userId === accountsUserId, `workspace.goal_set event userId is ${String(goalEvent.userId)}, expected ${accountsUserId}`)
  console.log("stage 8: goal set with the cookie -- the event's userId names the accounts user")

  // The Activity page check: a real headless Chromium, not `fetch` -- see the header comment for
  // why (`Timeline`'s virtualization renders zero rows server-side with no DOM to measure).
  {
    browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true })
    const context = await browser.newContext()
    await context.addCookies([{ name: 'slaveofai_session', value: cookie.slice('slaveofai_session='.length), url: accountsServer.baseUrl }])
    const page = await context.newPage()
    page.setDefaultTimeout(ACTION_TIMEOUT_MS)
    await page.goto(`${accountsServer.baseUrl}/w/${workspaceId}/activity`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
    await page
      .getByText(`by ${accountsUsername}`, { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
    await context.close()
    await browser.close()
    browser = null
  }
  console.log(`stage 8: the Activity page (rendered in a real browser) names "by ${accountsUsername}"`)

  const deleteUserRes = runCli(['delete-user', '--name', accountsUsername, '--yes'])
  assert(deleteUserRes.status === 0, `delete-user: expected exit 0, got ${String(deleteUserRes.status)} -- stderr: ${deleteUserRes.stderr}`)
  assert(deleteUserRes.stdout.includes(`user ${accountsUsername} deleted`), `delete-user: unexpected stdout ${deleteUserRes.stdout}`)
  accountsUsernameForCleanup = null // deleted here -- `finally` must not try again

  const revokedRes = await fetch(`${accountsServer.baseUrl}/api/w/${workspaceId}/goal`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ goal: 'must not land -- the user behind this cookie is gone' }),
  })
  assert(revokedRes.status === 401, `deleted user's cookie: expected 401, got ${revokedRes.status}`)
  const revokedBody = await revokedRes.json()
  assert(revokedBody.error === 'session revoked', `deleted user's cookie: unexpected body ${JSON.stringify(revokedBody)}`)
  console.log('stage 8: the user deleted; the same cookie now draws 401 session revoked on the same route')

  await stopNextDev(accountsServer, 'accounts')
  accountsServer = null

  console.log(`PASS: ${PASS_LINE}`)
  exitCode = 0
} finally {
  await stopChild(daemon)
  if (loopbackServer !== null) await stopNextDev(loopbackServer, 'loopback')
  if (accountsServer !== null) await stopNextDev(accountsServer, 'accounts')
  if (browser !== null) await browser.close().catch(() => {})

  if (workspaceId !== null) {
    // No FK from `ExecutionEvent` to `Workspace` (M2's append-only log outlives entity lifecycles
    // by design) -- deleted first. Everything after cascades from `Workspace` already, but the
    // explicit order (spec §9 stage 9 / the task brief) is kept so a partial run leaves nothing
    // behind even if some future schema change narrows a cascade this gate is relying on today.
    await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.task.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.slaveRun.deleteMany({ where: { slave: { team: { workspaceId } } } }).catch(() => {})
    await prisma.slave.deleteMany({ where: { team: { workspaceId } } }).catch(() => {})
    await prisma.team.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.providerConfiguration.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  if (accountsUsernameForCleanup !== null) {
    // Reached only when a stage threw between creating and deleting the throwaway user (the happy
    // path deletes it itself, in stage 8, and clears this back to null). `user_not_found` from a
    // race with stage 8's own delete is expected, not an error.
    const cleanup = runCli(['delete-user', '--name', accountsUsernameForCleanup, '--yes'])
    if (cleanup.status !== 0 && !cleanup.stderr.includes('no user named')) {
      console.error(`cleanup: could not delete ${accountsUsernameForCleanup}: ${cleanup.stderr}`)
    }
  }
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
