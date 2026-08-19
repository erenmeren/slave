import { realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma } from '@ai-team-os/db/client'
import {
  agentId as brandAgentId,
  runId as brandRunId,
  taskId as brandTaskId,
  workspaceId as brandWorkspaceId,
  type WorkspaceId,
} from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import { ClaudeCodeAdapter } from '@ai-team-os/providers'
import { runDaemon } from './daemon.js'
import { NON_TERMINAL_RUN_STATUSES } from './world.js'
import { pumpRun } from './pump.js'
import { drainPumps, runFilePaths, tick } from './tick.js'
import { verifyConcludedRun } from './verify.js'

const USAGE = `usage: orchestrator <command> [options]

  tick [--workspace <id>]              run exactly one tick and print the report
  daemon [--workspace <id>] [--period <ms>]
                                       the periodic + notification-driven loop
  status [--workspace <id>]            active runs with their pids, worktrees and states,
                                       and any workspace halt with the reason it happened
  pause --run <id> [--by <name>]       ask a run to stop at its next tool call
  resume --run <id> [--message <text>] continue a paused run, with an optional instruction
  cancel --run <id>                    stop a run for good; its worktree is preserved
  clear-halt --workspace <id>          retract a WORKSPACE-WIDE safety halt

  clear-halt and resume are different actions and it matters which you reach for.
  resume --run continues ONE paused run that is waiting to be continued.
  clear-halt --workspace retracts a safety halt that stopped the WHOLE workspace from
  scheduling anything. It starts nothing by itself -- it removes the reason nothing was
  starting. Reaching for resume while the workspace is halted does nothing, confusingly;
  reaching for clear-halt to nudge one run retracts a safety guard you did not mean to.

  --workspace may be omitted when the database holds exactly one workspace.
`

interface Args {
  readonly command: string
  readonly flags: Flags
}

type Flags = Readonly<Record<string, string | undefined>>

/**
 * `--flag value`, `--flag=value`, and `--flag` on its own.
 *
 * The `=` form is supported rather than ignored: silently dropping `--workspace=<id>` means a
 * command runs against whichever workspace happens to be the only one, which is the exact mistake
 * `resolveWorkspace` exists to prevent. A missing value is `undefined`, not the string `"true"` --
 * a sentinel that reads as a value is how `pause --by` ended up recording "true" as the operator's
 * name, and how a legitimate value starting with `--` was silently replaced by it.
 */
function parseArgs(argv: readonly string[]): Args {
  const [command = 'help', ...rest] = argv
  const flags: Record<string, string | undefined> = {}
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === undefined || !token.startsWith('--')) continue

    const equals = token.indexOf('=')
    if (equals > 2) {
      flags[token.slice(2, equals)] = token.slice(equals + 1)
      continue
    }

    const next = rest[i + 1]
    if (next === undefined) {
      flags[token.slice(2)] = undefined
      continue
    }
    // A value is whatever follows, even if it starts with `--`: an operator name or a resume
    // message is free-form text and may legitimately look like a flag.
    flags[token.slice(2)] = next
    i += 1
  }
  return { command, flags }
}

/**
 * The gate script is the **orchestrator's**, not the workspace repo's (Task 13's R5). Derived from
 * this file's own location so a checkout works with no configuration, and overridable because an
 * installed daemon's layout is not this one.
 */
function hookPath(): string {
  const fromEnv = process.env['AITEAMOS_HOOK_PATH']
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv)
  // dist/cli.js -> apps/orchestrator -> apps -> repo root
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'pause-gate.sh')
}

/**
 * The binary to spawn for a run.
 *
 * Injectable through the environment rather than through a flag, because Task 17's gate has to
 * drive the fake CLI and the real one down the *same* code path — and a flag only tests pass is a
 * flag nobody runs.
 */
function buildAdapter(): ClaudeCodeAdapter {
  const command = process.env['AITEAMOS_CLAUDE_BIN'] ?? 'claude'
  const extra = process.env['AITEAMOS_CLAUDE_ARGS']
  return new ClaudeCodeAdapter({
    command,
    ...(extra === undefined || extra === '' ? {} : { extraArgs: extra.split(' ') }),
  })
}

/**
 * The workspace a command acts on.
 *
 * With exactly one workspace, omitting `--workspace` is unambiguous; with more than one it is a
 * guess, and guessing here means an operator reads one workspace's runs believing they are
 * another's. So: name them and refuse.
 */
async function resolveWorkspace(flags: Flags): Promise<WorkspaceId> {
  const given = flags['workspace']
  if (given !== undefined) return brandWorkspaceId(given)

  const all = await prisma.workspace.findMany({ select: { id: true, name: true } })
  if (all.length === 1 && all[0] !== undefined) return brandWorkspaceId(all[0].id)
  if (all.length === 0) throw new Error('there are no workspaces: seed one first')
  throw new Error(
    `--workspace is required when there is more than one workspace. Available:\n` +
      all.map((w) => `  ${w.id}  ${w.name}`).join('\n'),
  )
}

function requireFlag(flags: Flags, name: string): string {
  const value = flags[name]
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}

/**
 * Signals a run's process directly, by pid.
 *
 * The adapter cannot do this from here: its registry of live children is per-process, and a CLI
 * invocation is a *different* process from the daemon that spawned the run — so `adapter.cancel`
 * would throw "no run found" for every run there is. Task 15 carried this forward as the reason a
 * run whose process outlives its daemon had no path to being killed. The pid is in the row; that is
 * what it is for.
 */
/** How long a cancelled process gets to exit on its own before it is killed outright. */
const KILL_GRACE_MS = 2_000

function isAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function signalRun(pid: number | null, signal: NodeJS.Signals): boolean {
  if (pid === null || pid <= 0) return false
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

async function mustGetRun(runId: string) {
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, include: { task: true } })
  if (run === null) throw new Error(`no run with id ${runId}`)
  return run
}

export async function main(argv: readonly string[]): Promise<number> {
  const { command, flags } = parseArgs(argv)

  switch (command) {
    case 'tick': {
      // One tick, and deliberately no orphan reconciliation: this may be running alongside a live
      // daemon, and Task 15's pass is startup-only because a run that is mid-spawn is
      // indistinguishable from one it should fail.
      const report = await tick({
        workspaceId: await resolveWorkspace(flags),
        adapter: buildAdapter(),
        hookPath: hookPath(),
      })
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

      // The command waits for what it started, even though the *function* deliberately does not.
      // A daemon keeps running and its pumps outlive each tick by design (spec §5.6); a one-shot
      // command's process is about to exit, and exiting would leave a live agent with nobody
      // reading its stream -- every event it produced from that moment lost, and the run left for
      // Task 15's orphan pass to fail on some later startup. The distinction is between a tick and
      // a process that only runs one.
      await drainPumps()
      return 0
    }

    case 'daemon': {
      const period = Number(flags['period'] ?? '1000')
      await runDaemon({
        workspaceId: await resolveWorkspace(flags),
        adapter: buildAdapter(),
        hookPath: hookPath(),
        periodMs: Number.isFinite(period) && period > 0 ? period : 1000,
      })
      return 0
    }

    case 'status': {
      const workspaceId = await resolveWorkspace(flags)
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
      const runs = await prisma.agentRun.findMany({
        // On the status column, not on `endedAt`: the two can disagree, and everything else in the
        // system -- `loadWorld`'s busy check, the sweep, the orphan pass -- asks the status.
        where: { task: { workspaceId }, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
        orderBy: { startedAt: 'desc' },
      })
      process.stdout.write(
        `${JSON.stringify(
          {
            // The *reason*, not just that it is halted: `decide()` surfaces only the guardrail name
            // (`emergency_stop`), which says nothing about the hook path that caused it.
            halt:
              workspace.haltedReason === null
                ? null
                : { reason: workspace.haltedReason, since: workspace.haltedAt },
            runs: runs.map((run) => ({
              id: run.id,
              status: run.status,
              pid: run.pid,
              worktreePath: run.worktreePath,
              toolCalls: run.toolCalls,
              startedAt: run.startedAt,
            })),
          },
          null,
          2,
        )}\n`,
      )
      return 0
    }

    case 'pause': {
      const run = await mustGetRun(requireFlag(flags, 'run'))
      const requestedBy = flags['by'] ?? 'operator'

      // Write the flag; the gate denies the next tool call and the *stream owner* follows the rest
      // of the protocol. A CLI invocation has no handle on the child and no view of its stream, so
      // it cannot await the outcome -- the daemon's pump is what observes the deny and records
      // `run.paused`. Spec §11 says "write the flag, follow the protocol"; this is the half a
      // separate process can perform.

      // Claimed, not written. `pause_requested` is a non-terminal status, so pausing a run that
      // already finished puts a *concluded* run back into `activeRuns`, makes its agent look busy,
      // and leaves it for the next restart's orphan sweep to flip to `failed` -- corrupting the
      // record of a run that actually succeeded.
      const claimed = await prisma.agentRun.updateMany({
        where: { id: run.id, status: { in: ['starting', 'working', 'resuming'] } },
        // `pauseReason` is the *category*, and this is the one place that knows it: an operator
        // asked. Task 12 carried it forward as a column nothing wrote.
        data: { status: 'pause_requested', pauseReason: 'human' },
      })
      if (claimed.count === 0) {
        throw new Error(`run ${run.id} cannot be paused: it is ${run.status}`)
      }

      // The same derivation the tick used to tell the child where its flag is -- re-deriving it as
      // a second literal is how the two come to disagree, and a gate reading a path nobody writes
      // means an operator watches a "pausing" run keep working (spec §5.5's named failure).
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: run.task.workspaceId } })
      const { pauseFlagPath } = runFilePaths(workspace.repoPath, brandRunId(run.id))
      writeFileSync(pauseFlagPath, `${requestedBy}\n`)
      await appendEvent({
        type: 'run.pause_requested',
        workspaceId: run.task.workspaceId,
        taskId: run.taskId,
        agentId: run.agentId,
        runId: run.id,
        actor: 'human',
        payload: { requestedBy },
      })
      process.stdout.write(`pause_requested: the gate will deny ${run.id}'s next tool call\n`)
      return 0
    }

    case 'resume': {
      const run = await mustGetRun(requireFlag(flags, 'run'))
      const message = flags['message']
      // A halt is raised by a pause-gate failure or an unverifiable workspace (§13.1, §8), so
      // resuming into one relaunches an agent whose gate may still be broken -- the recurrence the
      // halt exists to bound. The help text promises this; it has to be true.
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: run.task.workspaceId } })
      if (workspace.haltedReason !== null) {
        throw new Error(
          `this workspace is halted (${workspace.haltedReason}). ` +
            `Nothing will run until an operator retracts it with: clear-halt --workspace ${workspace.id}`,
        )
      }

      const checkpoint = await prisma.checkpoint.findUnique({ where: { runId: run.id } })
      if (checkpoint === null) {
        throw new Error(`run ${run.id} has no checkpoint: there is nothing to resume it from`)
      }

      // Claimed before anything irreversible happens, mirroring the domain's own edge
      // (`resume_requested` is legal only from `paused`). Without it, `resume` re-spawns a
      // *terminal* run -- measured: a second agent in the finished run's worktree, `terminalAt`
      // rewritten, a second `run.succeeded` in the log -- and against a live daemon it puts two
      // agents on one branch while overwriting the pid that could have killed the first. The
      // adapter's live-child guard cannot help: a CLI invocation is always the cross-process case
      // its registry is empty for.
      const claimed = await prisma.agentRun.updateMany({
        where: { id: run.id, status: 'paused' },
        data: { status: 'resuming' },
      })
      if (claimed.count === 0) {
        throw new Error(`run ${run.id} is not paused (it is ${run.status}): there is nothing to resume`)
      }

      const adapter = buildAdapter()
      // The checkpoint is the whole point of `resume`'s signature: this process never called
      // `start()` for that run, so the settings file, the hook path and the git identity exist
      // nowhere else. `resume()` clears the pause flag and verifies it is gone before spawning --
      // otherwise the gate denies every tool call the resumed run attempts.
      const handle = await adapter.resume(
        brandRunId(run.id),
        {
          sessionId: checkpoint.sessionId,
          worktreePath: checkpoint.worktreePath,
          pauseFlagPath: checkpoint.pauseFlagPath,
          settingsPath: checkpoint.settingsPath,
          hookPath: checkpoint.hookPath,
          gitAuthorName: checkpoint.gitAuthorName,
          gitAuthorEmail: checkpoint.gitAuthorEmail,
          lastToolUseId: checkpoint.lastToolUseId,
          lastToolName: checkpoint.lastToolName,
          numTurns: checkpoint.numTurns,
          deniedToolUseIds: checkpoint.deniedToolUseIds,
          headCommit: checkpoint.headCommit,
          dirtyFiles: checkpoint.dirtyFiles,
          cumulativeCostUsd: checkpoint.cumulativeCostUsd,
          cumulativeTokens: checkpoint.cumulativeTokens,
        },
        message === undefined || message === 'true' ? null : message,
      )

      await prisma.agentRun.update({
        where: { id: run.id },
        // `pausedAtStep` is cleared with the pause itself: the domain's `resuming -> working` edge
        // clears it, and a running run reporting where it once paused reads as still paused.
        data: { pid: handle.pid, pauseReason: null, pausedAtStep: null },
      })
      await appendEvent({
        type: 'run.resumed',
        workspaceId: run.task.workspaceId,
        taskId: run.taskId,
        agentId: run.agentId,
        runId: run.id,
        actor: 'human',
        payload: { sessionId: checkpoint.sessionId },
      })

      // This process owns the resumed run's stream, so it pumps it and waits -- the same reason
      // `tick` waits for what it started. `run.resumed` is emitted above rather than left to the
      // pump, which emits `run.started` from the session line and cannot tell a first spawn from a
      // continuation (Task 12's carry).
      const pumped = pumpRun({
        runId: brandRunId(run.id),
        taskId: brandTaskId(run.taskId),
        agentId: brandAgentId(run.agentId),
        workspaceId: brandWorkspaceId(run.task.workspaceId),
        events: adapter.events(brandRunId(run.id)),
        cancel: () => adapter.cancel(brandRunId(run.id)),
        // The pump cannot tell a continuation from a first spawn -- a resumed process emits
        // `system/init` just like a fresh one -- so it is told, and `run.resumed` above is the
        // only announcement. Task 12's carry, closed at the caller that knows.
        resumed: true,
        spawn: {
          settingsPath: checkpoint.settingsPath,
          pauseFlagPath: checkpoint.pauseFlagPath,
          hookPath: checkpoint.hookPath,
          gitIdentity: { name: checkpoint.gitAuthorName, email: checkpoint.gitAuthorEmail },
        },
      })
      process.stdout.write(`resumed ${run.id} as pid ${handle.pid}\n`)
      await pumped
      // The same reaction the tick chains onto its pumps: a resumed run's completion is a
      // completion like any other, and a success that left the task `running` forever would make
      // pause/resume a trap rather than a control. This process awaited the stream, so it is the
      // one that knows the run concluded.
      await verifyConcludedRun(brandRunId(run.id))
      return 0
    }

    case 'cancel': {
      const run = await mustGetRun(requireFlag(flags, 'run'))
      const signalled = signalRun(run.pid, 'SIGTERM')
      if (signalled) {
        // The adapter's own kill escalates; a CLI cancel that only asks politely is strictly
        // weaker than the thing it replaces, which reopens a thinner version of the Task 15 carry
        // it was written to close.
        await new Promise((res) => setTimeout(res, KILL_GRACE_MS))
        if (isAlive(run.pid)) signalRun(run.pid, 'SIGKILL')
      }
      const now = new Date()
      await prisma.agentRun.updateMany({
        where: { id: run.id, endedAt: null },
        data: { status: 'stopped', terminalAt: now, endedAt: now },
      })
      // `blocked`, not `rework`: the help and the README both say cancel stops a run for good, and
      // `rework` is startable -- the next tick would hand the task to a fresh agent on the same
      // worktree, with `attempt` never incremented so repeated cancels never reach the cap. The
      // spec does not decide this (§11 says only "kill and preserve the worktree"); shipping a
      // command that says one thing and does another is the part that is not a judgement call.
      await prisma.task.updateMany({
        where: { id: run.taskId, activeRunId: run.id },
        data: { status: 'blocked', activeRunId: null },
      })
      await appendEvent({
        type: 'run.stopped',
        workspaceId: run.task.workspaceId,
        taskId: run.taskId,
        agentId: run.agentId,
        runId: run.id,
        actor: 'human',
        payload: {
          reason: signalled
            ? 'cancelled by the operator'
            : `cancelled by the operator; no live process to signal (pid ${String(run.pid)})`,
        },
      })
      // §7.4: the worktree is the inspection surface and is deliberately left in place.
      process.stdout.write(`stopped ${run.id}; its worktree is preserved\n`)
      return 0
    }

    case 'clear-halt': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { haltedReason: null, haltedAt: null },
      })
      process.stdout.write(
        `cleared the safety halt on ${workspaceId}. This starts nothing by itself: it removes the ` +
          `reason nothing was starting.\n`,
      )
      return 0
    }

    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE)
      return 0

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
      return 1
  }
}

// Run only when invoked as a program. Comparing the resolved argv[1] against this module's own URL
// is what keeps it from firing when a test runner imports the file.
// `realpathSync`, because Node resolves `import.meta.url` to the real path while `process.argv[1]`
// keeps the symlink an npm bin install creates -- and a mismatch here means the command exits 0
// having done nothing at all, which is the worst possible failure for something a cron job wraps.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]))) {
  main(process.argv.slice(2))
    .then(async (code) => {
      await prisma.$disconnect()
      process.exitCode = code
    })
    .catch(async (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      await prisma.$disconnect()
      process.exitCode = 1
    })
}
