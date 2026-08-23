import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claimResume, emergencyStop, refusalText, requestPause, requestStop } from '@ai-team-os/control'
import { prisma } from '@ai-team-os/db/client'
import { workspaceId as brandWorkspaceId, type WorkspaceId } from '@ai-team-os/domain'
import { ClaudeCodeAdapter } from '@ai-team-os/providers'
import { runDaemon } from './daemon.js'
import { NON_TERMINAL_RUN_STATUSES } from './world.js'
import { executeResume } from './resume.js'
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
  emergency-stop --workspace <id> [--by <name>]
                                       halt scheduling on the WHOLE workspace AND pause every
                                       active run in it -- the operator's stop-everything button

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
      const result = await requestPause(requireFlag(flags, 'run'), flags['by'] ?? 'operator')
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`pause_requested: the gate will deny ${requireFlag(flags, 'run')}'s next tool call\n`)
      return 0
    }

    case 'resume': {
      const run = await mustGetRun(requireFlag(flags, 'run'))
      const explicit = flags['message']
      // A halt is raised by a pause-gate failure or an unverifiable workspace (§13.1, §8), so
      // resuming into one relaunches an agent whose gate may still be broken -- the recurrence the
      // halt exists to bound. The help text promises this; it has to be true.
      //
      // Checked here rather than by calling `requestResume`: this command is synchronous and
      // continues the run itself, so recording an intent on the way to a failure would leave a
      // resume queued for the next daemon tick to execute -- an operator whose command errored out
      // would find the run resumed anyway, minutes later.
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: run.task.workspaceId } })
      if (workspace.haltedReason !== null) {
        throw new Error(
          `this workspace is halted (${workspace.haltedReason}). ` +
            `Nothing will run until an operator retracts it with: clear-halt --workspace ${workspace.id}`,
        )
      }

      const checkpoint = await prisma.checkpoint.findUnique({ where: { runId: run.id }, select: { id: true } })
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
      //
      // `claimResume` first, so an operator resuming a run the web already queued picks up that
      // instruction rather than silently discarding it. It claims only when an intent is recorded,
      // so a run nobody asked about falls through to the plain claim this command has always made.
      const intent = await claimResume(run.id)
      if (!intent.claimed) {
        const claimed = await prisma.agentRun.updateMany({
          where: { id: run.id, status: 'paused' },
          // Clears any intent columns too, closing the window where a web `requestResume` lands
          // between `claimResume`'s check and this fallback write: without this, that intent would
          // survive into `resuming` and later spontaneously resume the run on its own.
          data: { status: 'resuming', resumeRequestedAt: null, queuedMessage: null },
        })
        if (claimed.count === 0) {
          throw new Error(`run ${run.id} is not paused (it is ${run.status}): there is nothing to resume`)
        }
      }

      // An explicit `--message` beats the queued one: the operator typing it now is looking at the
      // run, and whatever was queued earlier is the older of the two intentions. The queued message
      // is consumed by the claim above either way -- it is a single slot, delivered once.
      const message = explicit === undefined || explicit === 'true' ? intent.queuedMessage : explicit

      await executeResume({
        runId: run.id,
        adapter: buildAdapter(),
        message,
        // Printed at the spawn, not after the stream ends: `resume` has always acknowledged
        // immediately and then waited, and a run can think for minutes.
        onSpawned: (handle) => {
          process.stdout.write(`resumed ${run.id} as pid ${handle.pid}\n`)
        },
      })
      return 0
    }

    case 'cancel': {
      const runIdFlag = requireFlag(flags, 'run')
      const result = await requestStop(runIdFlag, 'the operator')
      if (!result.ok) throw new Error(refusalText(result.error))
      // §7.4: the worktree is the inspection surface and is deliberately left in place.
      process.stdout.write(`stopped ${runIdFlag}; its worktree is preserved\n`)
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

    case 'emergency-stop': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      const result = await emergencyStop(workspaceId, flags['by'] ?? 'operator')
      if (!result.ok) throw new Error(refusalText(result.error))
      const { engaged, requested, refused } = result.value
      process.stdout.write(
        `${engaged ? 'emergency stop engaged' : 'workspace was already halted'} on ${workspaceId}: ` +
          `pause requested on ${requested.length} run(s), ${refused.length} already concluding. ` +
          `Retract with: clear-halt --workspace ${workspaceId}\n`,
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
