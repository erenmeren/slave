// M35's own gate (Task 3 brief): proves the milestone's central claim end to end -- a task marked
// `done` does not unblock a dependent until its work is actually confirmed integrated, and a task
// parked `blocked` has a real, CLI-driven way out -- entirely at the control/orchestrator layer,
// with a real CLI subprocess for each of the two verbs this milestone added.
//
// NO browser, and that is a deliberate choice, not a shortcut: everything M35 changed lives in
// `Task.integratedAt`, `world.ts`'s scheduler predicate (`loadWorld`/`decide`), and two control
// verbs (`confirmIntegration`, `unblockTask`) reached through the real orchestrator CLI. `apps/web`'s
// only involvement (T2's "awaiting integration" marker on `TaskDetailPanel`, T4/T5's `blocked`
// surfacing) is a straight read of the exact same `integratedAt`/`status` columns this gate already
// asserts directly against `prisma` -- driving Chromium to confirm a label renders would prove
// strictly less than the direct read already does, at real cost (a `next dev` boot, a browser
// launch) for zero additional honesty. `gate-m33-adopt.mjs`'s own header makes the opposite call for
// its milestone because adoption's claim ("starts nothing") is precisely about what appears through
// the UI; M35's claim is precisely about what the scheduler and the CLI do, so the CLI and the
// control layer are the honest way to drive it.
//
// Shape borrowed from `gate-m11-shell.mjs` for the temp-git-repo + `prisma.workspace.create` setup
// and its `finally` teardown in FK order, and from `gate-m33-adopt.mjs` for the "print every
// measured value before asserting it" discipline and the real CLI-subprocess idiom
// (`execFileSync('node', [cliPath, ...])`, env from `loopbackChildEnv()`). `exitCode` starts at 1
// and is only set to 0 at the very end of a fully-asserted run.
//
// Stage 1 (the dependency gate, T2): a workspace with `autoMerge: false` and a real temp git repo,
// one department, two role-matched slaves (`backend`, `qa`), and two `backend` tasks where B
// depends on A. Task A is driven to `done` through the REAL `runMergePass`
// (`apps/orchestrator/src/merge.ts`), not a hand-written row update -- production code, built by
// hand only up to the preconditions `runMergePass` itself reads (a `merging` status and a
// `task.review_approved` event, exactly `merge.test.ts`'s own `seedMergingTask` fixture uses). No
// worktree is provisioned for task A: `runMergePass`'s `!autoMerge` branch (spec Decision 5, the
// exact path this stage exercises) never touches git at all -- it reads `Task.branch` only to name
// it in the `task.done` event payload, so a plausible (not real) branch string is enough, and
// `requireBranch` still demands one be set. Before confirming integration, `loadWorld`/`decide`
// (the orchestrator's and domain's own `dist`, never reimplemented here) say B is NOT schedulable:
// `dependenciesDone` false on B's own `SchedulableTask` row, no `start_run` command for it even
// though a free, role-matched slave exists. The real CLI, `confirm-integration --task <A>`, runs as
// a subprocess exactly as an operator would type it. Afterwards the same `loadWorld`/`decide` pair
// says B IS schedulable (`start_run` naming the free backend slave), a direct `prisma` read
// confirms `A.integratedAt` is set, and exactly one `task_integrated` event exists. A second
// `confirm-integration` on the same task is asserted to refuse through the CLI's own refusal path
// (`already_integrated`), not a status guess.
//
// Stage 2 (the blocked exit, T4/T5): a third task is parked `blocked` through a REAL park -- the
// operator-cancel path in `packages/control/src/stop.ts`'s `requestStop`, one of the milestone's
// four documented entrances to `blocked` (the other three all require a real implementation/review
// run this gate makes no model call to produce). `requestStop` needs a live run to signal;
// this run's `pid` is left `null` on purpose (a `SlaveRun` fixture, not a real `claude` child), so
// `killWithEscalation` takes its own "no live process to signal" branch
// (`packages/providers/src/runtime/process.ts`) -- the exact branch a real cancel takes on a run
// whose child already exited. Nothing here is fabricated state: `requestStop` runs for real and
// parks the task `blocked` on its own, clearing `activeRunId`. The real CLI, `unblock-task --task
// <id>`, then runs as a subprocess; the task becomes `rework`, a `task_unblocked` event is written,
// and `loadWorld`/`decide` confirm it is schedulable again onto the free `qa` slave. A second
// `unblock-task` on the same (now non-blocked) task is asserted to refuse through the CLI's own
// refusal path (`task_not_blocked`).
//
// Teardown (`finally`): the workspace's `ExecutionEvent` rows (no FK, so nothing cascades them),
// then the workspace itself (cascades `Team`/`Slave`/`Task`/`SlaveRun`/`TaskDependency`), then the
// temp repo directory.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { prisma } from '../packages/db/dist/client.js'
import { appendEvent } from '../packages/events/dist/index.js'
import { decide } from '../packages/domain/dist/index.js'
import { loadWorld } from '../apps/orchestrator/dist/world.js'
import { runMergePass } from '../apps/orchestrator/dist/merge.js'
import { requestStop } from '../packages/control/dist/index.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// Exact literals, never suffixed -- typed into real CLI args the way an operator would type them.
// `preflightCleanup` removes any leftover a prior crashed run left on this exact name.
const WORKSPACE_NAME = 'M35 Gate Project'
const TASK_A_TITLE = 'M35 Gate Task A'
const TASK_B_TITLE = 'M35 Gate Task B'
const TASK_C_TITLE = 'M35 Gate Task C'

/** Same as `gate-m11-shell.mjs`'s `makeRepo` -- a real repository, because `Workspace.repoPath`
 *  names a real directory even though `runMergePass`'s `!autoMerge` branch never touches it. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m35-repo-'))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

/** Removes a leftover "M35 Gate Project" workspace a prior interrupted run left behind, in the
 *  same order the `finally` block below uses: events first (no FK), then the workspace (cascades
 *  Team/Slave/Task/SlaveRun/TaskDependency). Safe to run against an empty slate. */
async function preflightCleanup() {
  const stale = await prisma.workspace.findUnique({ where: { name: WORKSPACE_NAME } })
  if (stale === null) return
  await prisma.executionEvent.deleteMany({ where: { workspaceId: stale.id } }).catch(() => {})
  await prisma.workspace.delete({ where: { id: stale.id } }).catch(() => {})
}

let exitCode = 1
let repoPath = null
let workspaceId = null

/** Every row this gate could have written, for a FAIL's diagnostic dump -- not scoped to ids that
 *  might not be set yet if the failure happened early. BigInt `seq` is stringified for JSON. */
async function dumpGateRows() {
  const workspace =
    workspaceId === null
      ? null
      : await prisma.workspace.findUnique({
          where: { id: workspaceId },
          include: { tasks: true, teams: { include: { slaves: { include: { runs: true } } } } },
        })
  const events =
    workspaceId === null
      ? []
      : await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  return JSON.stringify({ workspace, events }, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
}

/** The `gate-m8a-estop`-style diagnostic dump, adapted for a gate with no browser: a thrown Error
 *  carrying every gate-owned row's current state rather than a bare assertion message. */
async function fail(message) {
  const dump = await dumpGateRows().catch(
    (cause) => `<could not dump gate rows: ${cause instanceof Error ? cause.message : String(cause)}>`,
  )
  throw new Error(`${message} -- gateRows=${dump}`)
}

try {
  const cliPath = join(repoRoot, 'apps/orchestrator/dist/cli.js')
  if (!existsSync(cliPath)) throw new Error(`orchestrator CLI not built at ${cliPath} -- run tsc --build first`)

  /** Runs the real orchestrator CLI as a subprocess, exactly as an operator's shell would, and
   *  returns its stdout. Throws (with `.status`/`.stdout`/`.stderr`) on a non-zero exit. */
  function runCli(args) {
    return execFileSync('node', [cliPath, ...args], {
      cwd: repoRoot,
      env: loopbackChildEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  /** Same subprocess call, for a call this gate expects to be refused: catches the non-zero exit
   *  and reports it as data instead of letting it escape as an uncaught throw. */
  function runCliExpectingRefusal(args) {
    try {
      const stdout = runCli(args)
      return { refused: false, stdout }
    } catch (error) {
      return { refused: true, status: error.status ?? null, stderr: String(error.stderr ?? '') }
    }
  }

  await preflightCleanup()

  // ---- Setup: one workspace, one department, one backend slave and one qa slave ----
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
  console.log(`workspace ${workspaceId} (${WORKSPACE_NAME}), autoMerge ${workspace.autoMerge}, repo ${repoPath}`)

  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  const backendSlave = await prisma.slave.create({ data: { teamId: team.id, name: 'Gate Backend', role: 'backend' } })
  const qaSlave = await prisma.slave.create({ data: { teamId: team.id, name: 'Gate QA', role: 'qa' } })
  console.log(`backend slave ${backendSlave.id} (idle), qa slave ${qaSlave.id} (idle)`)

  // ================= Stage 1: done does not unblock a dependent until integrated =================

  const taskA = await prisma.task.create({
    data: {
      workspaceId,
      title: TASK_A_TITLE,
      description: 'the dependency',
      status: 'merging',
      requiredRole: 'backend',
      maxAttempts: 5,
      // See the header comment: `runMergePass`'s `!autoMerge` branch never reads this as a real
      // git ref, only as a label for the `task.done` event payload -- `requireBranch` just
      // demands it be non-null.
      branch: 'T-gate-a-work',
    },
  })
  const taskB = await prisma.task.create({
    data: { workspaceId, title: TASK_B_TITLE, description: 'depends on A', status: 'ready', requiredRole: 'backend', maxAttempts: 5 },
  })
  await prisma.taskDependency.create({ data: { taskId: taskB.id, dependsOnTaskId: taskA.id } })
  console.log(`task A ${taskA.id} (merging), task B ${taskB.id} (ready, depends on A)`)

  // The FIFO-ordering precondition `runMergePass` itself reads (spec §4) -- exactly
  // `merge.test.ts`'s `seedMergingTask` fixture, minus the worktree this branch never touches.
  await appendEvent({ type: 'task.review_approved', workspaceId, taskId: taskA.id, actor: 'system', payload: { reason: 'looks good' } })

  await runMergePass(workspaceId)

  const taskAAfterMerge = await prisma.task.findUniqueOrThrow({ where: { id: taskA.id } })
  console.log(
    `task A after runMergePass: status ${taskAAfterMerge.status}, integratedAt ${JSON.stringify(taskAAfterMerge.integratedAt)}, mergeClaimedAt ${JSON.stringify(taskAAfterMerge.mergeClaimedAt)}`,
  )
  if (taskAAfterMerge.status !== 'done') await fail(`task A is ${taskAAfterMerge.status} after runMergePass, expected done`)
  if (taskAAfterMerge.integratedAt !== null) {
    await fail(`task A's integratedAt is ${JSON.stringify(taskAAfterMerge.integratedAt)} after the !autoMerge merge pass, expected null`)
  }
  if (taskAAfterMerge.mergeClaimedAt !== null) await fail(`task A's mergeClaimedAt is still set after runMergePass, expected null (claim released)`)

  const doneEvents = await prisma.executionEvent.findMany({ where: { workspaceId, taskId: taskA.id, type: 'task_done' } })
  console.log(`task_done events for A: ${doneEvents.length}`)
  if (doneEvents.length !== 1) await fail(`expected exactly one task_done event for A, found ${doneEvents.length}`)

  // ---- Before confirm-integration: B must not be schedulable, read from the scheduler's own world ----
  const worldBefore = await loadWorld(workspaceId)
  const bBefore = worldBefore.world.tasks.find((t) => t.id === taskB.id)
  console.log(`world.tasks entry for B before confirm-integration: ${JSON.stringify(bBefore)}`)
  if (bBefore === undefined) await fail('task B is missing from loadWorld\'s schedulable tasks')
  if (bBefore.dependenciesDone !== false) {
    await fail(`B's dependenciesDone is ${bBefore.dependenciesDone} before A is integrated, expected false`)
  }
  const commandsBefore = decide(worldBefore.world)
  console.log(`decide() before confirm-integration: ${JSON.stringify(commandsBefore)}`)
  if (commandsBefore.some((c) => c.kind === 'start_run' && c.taskId === taskB.id)) {
    await fail(`decide() scheduled B before A was confirmed integrated -- commands=${JSON.stringify(commandsBefore)}`)
  }

  // ---- The real CLI, confirm-integration ----
  const confirmOutput = runCli(['confirm-integration', '--task', taskA.id])
  console.log(`confirm-integration printed: ${JSON.stringify(confirmOutput.trim())}`)
  if (!/is now integrated/.test(confirmOutput)) await fail(`confirm-integration's stdout did not say "is now integrated" -- ${JSON.stringify(confirmOutput)}`)

  const taskAAfterConfirm = await prisma.task.findUniqueOrThrow({ where: { id: taskA.id } })
  console.log(`task A after confirm-integration: integratedAt ${JSON.stringify(taskAAfterConfirm.integratedAt)}`)
  if (taskAAfterConfirm.integratedAt === null) await fail('task A\'s integratedAt is still null after confirm-integration')

  const integratedEvents = await prisma.executionEvent.findMany({ where: { workspaceId, taskId: taskA.id, type: 'task_integrated' } })
  console.log(`task_integrated events for A: ${integratedEvents.length}`)
  if (integratedEvents.length !== 1) await fail(`expected exactly one task_integrated event for A, found ${integratedEvents.length}`)

  // ---- After confirm-integration: B must be schedulable, again read from the scheduler's own world ----
  const worldAfter = await loadWorld(workspaceId)
  const bAfter = worldAfter.world.tasks.find((t) => t.id === taskB.id)
  console.log(`world.tasks entry for B after confirm-integration: ${JSON.stringify(bAfter)}`)
  if (bAfter === undefined) await fail('task B is missing from loadWorld\'s schedulable tasks after confirm-integration')
  if (bAfter.dependenciesDone !== true) await fail(`B's dependenciesDone is ${bAfter.dependenciesDone} after A is integrated, expected true`)
  const commandsAfter = decide(worldAfter.world)
  console.log(`decide() after confirm-integration: ${JSON.stringify(commandsAfter)}`)
  const bStart = commandsAfter.find((c) => c.kind === 'start_run' && c.taskId === taskB.id)
  if (bStart === undefined) {
    await fail(`decide() did not schedule B even though A is integrated and a free backend slave exists -- commands=${JSON.stringify(commandsAfter)}`)
  }
  if (bStart.slaveId !== backendSlave.id) await fail(`decide() scheduled B onto ${bStart.slaveId}, expected the free backend slave ${backendSlave.id}`)
  console.log("stage 1 complete: B was not schedulable before confirm-integration and is schedulable after, both read from loadWorld/decide")

  // ---- A second confirm-integration must refuse, through the CLI's own refusal path ----
  const secondConfirm = runCliExpectingRefusal(['confirm-integration', '--task', taskA.id])
  console.log(`second confirm-integration: ${JSON.stringify(secondConfirm)}`)
  if (!secondConfirm.refused) await fail('a second confirm-integration on an already-integrated task did not refuse')
  if (!secondConfirm.stderr.includes('already integrated')) {
    await fail(`second confirm-integration's stderr did not say "already integrated" -- ${JSON.stringify(secondConfirm.stderr)}`)
  }

  // ================= Stage 2: a blocked task has a real exit =================

  const taskC = await prisma.task.create({
    data: { workspaceId, title: TASK_C_TITLE, description: 'gets cancelled, then unblocked', status: 'running', requiredRole: 'qa', maxAttempts: 5 },
  })
  // `pid: null` -- see the header comment: no real `claude` child, so `requestStop`'s kill takes
  // its own "no live process to signal" branch, but every other step of the cancel is real.
  const runC = await prisma.slaveRun.create({ data: { taskId: taskC.id, slaveId: qaSlave.id, status: 'working', pid: null } })
  await prisma.task.update({ where: { id: taskC.id }, data: { activeRunId: runC.id } })
  console.log(`task C ${taskC.id} (running), run ${runC.id} (working, pid null -- no real process to signal)`)

  const stopResult = await requestStop(runC.id, 'gate operator')
  if (!stopResult.ok) await fail(`requestStop refused unexpectedly: ${JSON.stringify(stopResult.error)}`)

  const taskCAfterStop = await prisma.task.findUniqueOrThrow({ where: { id: taskC.id } })
  console.log(`task C after requestStop: status ${taskCAfterStop.status}, activeRunId ${JSON.stringify(taskCAfterStop.activeRunId)}`)
  if (taskCAfterStop.status !== 'blocked') await fail(`task C is ${taskCAfterStop.status} after requestStop, expected blocked`)
  if (taskCAfterStop.activeRunId !== null) await fail(`task C's activeRunId is still ${JSON.stringify(taskCAfterStop.activeRunId)} after requestStop, expected null`)

  // Blocked is not startable -- confirmed before unblocking, the same loadWorld/decide pair.
  const worldBlocked = await loadWorld(workspaceId)
  const cBlocked = worldBlocked.world.tasks.find((t) => t.id === taskC.id)
  console.log(`world.tasks entry for C while blocked: ${JSON.stringify(cBlocked)}`)
  const commandsBlocked = decide(worldBlocked.world)
  if (commandsBlocked.some((c) => c.kind === 'start_run' && c.taskId === taskC.id)) {
    await fail(`decide() scheduled C while it was still blocked -- commands=${JSON.stringify(commandsBlocked)}`)
  }

  // ---- The real CLI, unblock-task ----
  const unblockOutput = runCli(['unblock-task', '--task', taskC.id])
  console.log(`unblock-task printed: ${JSON.stringify(unblockOutput.trim())}`)
  if (!/is unblocked and back in rework/.test(unblockOutput)) {
    await fail(`unblock-task's stdout did not say "is unblocked and back in rework" -- ${JSON.stringify(unblockOutput)}`)
  }

  const taskCAfterUnblock = await prisma.task.findUniqueOrThrow({ where: { id: taskC.id } })
  console.log(
    `task C after unblock-task: status ${taskCAfterUnblock.status}, attempt ${taskCAfterUnblock.attempt}, maxAttempts ${taskCAfterUnblock.maxAttempts}`,
  )
  if (taskCAfterUnblock.status !== 'rework') await fail(`task C is ${taskCAfterUnblock.status} after unblock-task, expected rework`)
  if (taskCAfterUnblock.attempt !== 0) await fail(`task C's attempt is ${taskCAfterUnblock.attempt} after unblock-task, expected 0 (unblock never resets or charges it)`)

  const unblockedEvents = await prisma.executionEvent.findMany({ where: { workspaceId, taskId: taskC.id, type: 'task_unblocked' } })
  console.log(`task_unblocked events for C: ${unblockedEvents.length}`)
  if (unblockedEvents.length !== 1) await fail(`expected exactly one task_unblocked event for C, found ${unblockedEvents.length}`)

  // ---- C must now be schedulable, again read from loadWorld/decide ----
  const worldUnblocked = await loadWorld(workspaceId)
  const cUnblocked = worldUnblocked.world.tasks.find((t) => t.id === taskC.id)
  console.log(`world.tasks entry for C after unblock-task: ${JSON.stringify(cUnblocked)}`)
  const commandsUnblocked = decide(worldUnblocked.world)
  console.log(`decide() after unblock-task: ${JSON.stringify(commandsUnblocked)}`)
  const cStart = commandsUnblocked.find((c) => c.kind === 'start_run' && c.taskId === taskC.id)
  if (cStart === undefined) {
    await fail(`decide() did not schedule C even though it is back in rework with a free qa slave -- commands=${JSON.stringify(commandsUnblocked)}`)
  }
  if (cStart.slaveId !== qaSlave.id) await fail(`decide() scheduled C onto ${cStart.slaveId}, expected the free qa slave ${qaSlave.id}`)

  // ---- A second unblock-task on a now-non-blocked task must refuse ----
  const secondUnblock = runCliExpectingRefusal(['unblock-task', '--task', taskC.id])
  console.log(`second unblock-task: ${JSON.stringify(secondUnblock)}`)
  if (!secondUnblock.refused) await fail('a second unblock-task on a non-blocked task did not refuse')
  if (!secondUnblock.stderr.includes('only a blocked task can be unblocked')) {
    await fail(`second unblock-task's stderr did not name the refusal -- ${JSON.stringify(secondUnblock.stderr)}`)
  }
  console.log('stage 2 complete: a task parked blocked through a real operator-cancel, unblocked through the real CLI, confirmed schedulable, and a repeat call refused')

  console.log(
    'PASS: done does not unblock a dependent until confirm-integration runs, and a blocked task has a real exit through unblock-task -- ' +
      'both proven through loadWorld/decide and the real orchestrator CLI, no hand-written status update anywhere in the assertion path',
  )
  exitCode = 0
} finally {
  if (workspaceId !== null) {
    await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
