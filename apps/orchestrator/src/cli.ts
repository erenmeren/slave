import { mkdirSync, writeFileSync } from 'node:fs'
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
import { pumpRun } from './pump.js'
import { drainPumps, tick } from './tick.js'

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
  readonly flags: Readonly<Record<string, string>>
}

function parseArgs(argv: readonly string[]): Args {
  const [command = 'help', ...rest] = argv
  const flags: Record<string, string> = {}
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === undefined || !token.startsWith('--')) continue
    const next = rest[i + 1]
    flags[token.slice(2)] = next === undefined || next.startsWith('--') ? 'true' : next
    if (next !== undefined && !next.startsWith('--')) i += 1
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
async function resolveWorkspace(flags: Readonly<Record<string, string>>): Promise<WorkspaceId> {
  const given = flags['workspace']
  if (given !== undefined && given !== 'true') return brandWorkspaceId(given)

  const all = await prisma.workspace.findMany({ select: { id: true, name: true } })
  if (all.length === 1 && all[0] !== undefined) return brandWorkspaceId(all[0].id)
  if (all.length === 0) throw new Error('there are no workspaces: seed one first')
  throw new Error(
    `--workspace is required when there is more than one workspace. Available:\n` +
      all.map((w) => `  ${w.id}  ${w.name}`).join('\n'),
  )
}

function requireFlag(flags: Readonly<Record<string, string>>, name: string): string {
  const value = flags[name]
  if (value === undefined || value === 'true') throw new Error(`--${name} is required`)
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
        where: { task: { workspaceId }, endedAt: null },
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
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: run.task.workspaceId } })
      const dir = join(workspace.repoPath, '.aiteamos', 'runs', run.id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'pause.flag'), `${requestedBy}\n`)

      await prisma.agentRun.update({
        where: { id: run.id },
        // `pauseReason` is the *category*, and this is the one place that knows it: an operator
        // asked. Task 12 carried it forward as a column nothing wrote.
        data: { status: 'pause_requested', pauseReason: 'human' },
      })
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
      const checkpoint = await prisma.checkpoint.findUnique({ where: { runId: run.id } })
      if (checkpoint === null) {
        throw new Error(`run ${run.id} has no checkpoint: there is nothing to resume it from`)
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
        data: { status: 'resuming', pid: handle.pid, pauseReason: null },
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
        spawn: {
          settingsPath: checkpoint.settingsPath,
          pauseFlagPath: checkpoint.pauseFlagPath,
          hookPath: checkpoint.hookPath,
          gitIdentity: { name: checkpoint.gitAuthorName, email: checkpoint.gitAuthorEmail },
        },
      })
      process.stdout.write(`resumed ${run.id} as pid ${handle.pid}\n`)
      await pumped
      return 0
    }

    case 'cancel': {
      const run = await mustGetRun(requireFlag(flags, 'run'))
      const signalled = signalRun(run.pid, 'SIGTERM')
      const now = new Date()
      await prisma.agentRun.updateMany({
        where: { id: run.id, endedAt: null },
        data: { status: 'stopped', terminalAt: now, endedAt: now },
      })
      await prisma.task.updateMany({
        where: { id: run.taskId, activeRunId: run.id },
        data: { status: 'rework', activeRunId: null },
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
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
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
