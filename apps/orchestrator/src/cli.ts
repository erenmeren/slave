import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addCompanyAgent,
  addCompanyTeam,
  assignCompany,
  claimResume,
  createCompany,
  createTemplate,
  createUser,
  createWorkspace,
  deleteAgent,
  deleteTeam,
  deleteUser,
  emergencyStop,
  listUsers,
  refusalText,
  renameAgent,
  renameTeam,
  requestPause,
  requestStop,
  setAgentModel,
  setAgentRole,
  setGoal,
  setPassword,
  describeSync,
  syncSkillCatalog,
} from '@ai-team-os/control'
import { prisma } from '@ai-team-os/db/client'
import { workspaceId as brandWorkspaceId, type WorkspaceId } from '@ai-team-os/domain'
import { buildRegistry, type AdapterRegistry, type ProviderKind } from '@ai-team-os/providers'
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
  set-goal --workspace <id> --goal "<text>"
                                       set the operator's standing instruction for what this
                                       workspace's agents are working toward
  create-workspace --name <n> --repo <abs path> [--base main] --verify "<cmd>" [--verify "<cmd>" ...]
                   [--setup "<cmd>" ...] [--budget <usd> | --no-budget] [--provider claude_code|cursor]
                                       attach an existing local clone as a workspace. The path
                                       must be absolute and a git work tree, the base branch must
                                       exist, and at least one verify command is required -- a
                                       workspace with none can never reach done. --verify and
                                       --setup repeat, one command each, run in the order given.
  skills sync                          rescan the skill catalog from this host's disk:
                                       ~/.claude/skills, the plugin cache, and <repo>/.claude/skills
  create-template --name <n> --role <r> [--model <m> --provider <p>] [--description <d>]
                                       add a reusable agent template to the catalog. --model and
                                       --provider are a pair: give both or neither.
  create-company --name <n>            add a company (a persistent roster) to the catalog
  add-team --company <id> --name <n>   add a team to a company's roster
  add-agent --team <companyTeamId> --template <id> --name <n> [--model <m> --provider <p>]
                                       add a roster member to a company team, instantiated from a
                                       template. --model and --provider are a pair: give both or
                                       neither.
  assign-company --workspace <id> --company <id>
                                       assign a company's roster to a workspace, materializing a
                                       project team/worker for every roster member with no
                                       matching row there yet
  set-model --agent <workerId> --model <m> --provider <p>
  set-model --agent <workerId> --clear
                                       set or clear a worker's own model+provider override -- the
                                       top of the resolution chain, above its roster row and its
                                       template's default. A model only means something inside the
                                       provider that runs it, so --model requires --provider.
  rename-agent --agent <id> --name <n> rename a project agent
  set-role --agent <id> --role <r>     change a project agent's role -- refused while the agent
                                       holds a live run
  delete-agent --agent <id> --yes      remove a project agent -- refused while it carries any run
                                       history, terminal or not. Omit --yes to see what would be
                                       deleted without doing it.
  rename-team --team <id> --name <n>   rename a project team
  delete-team --team <id> --yes        remove a project team -- refused while it still has any
                                       agent on its roster. Omit --yes to see what would be
                                       deleted without doing it.

  users
  create-user --name <u>                create a local account. The password is never a
                                       command-line argument -- it would land in shell history
                                       and process listings -- so it is read from stdin instead,
                                       its first line: printf "%s\\n" "$PW" | orchestrator
                                       create-user --name ada
  set-password --name <u>               replace a local account's password, read from stdin the
                                       same way
  delete-user --name <u> --yes          remove a local account. Omit --yes to see what would be
                                       deleted without doing it.
  list-users                            every local account, one per line: username  createdAt

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

type Flags = Readonly<Record<string, string | readonly string[] | undefined>>

/** Flags that repeat: every occurrence is collected, in order, rather than the usual last-wins. */
const REPEATABLE: ReadonlySet<string> = new Set(['verify', 'setup'])

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
  const flags: Record<string, string | readonly string[] | undefined> = {}
  // Repeatable keys collect every occurrence, in order; every other key is last-wins, as before.
  const setFlag = (key: string, value: string): void => {
    flags[key] = REPEATABLE.has(key) ? [...((flags[key] as readonly string[] | undefined) ?? []), value] : value
  }
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === undefined || !token.startsWith('--')) continue

    const equals = token.indexOf('=')
    if (equals > 2) {
      setFlag(token.slice(2, equals), token.slice(equals + 1))
      continue
    }

    const next = rest[i + 1]
    if (next === undefined) {
      const key = token.slice(2)
      // A bare repeatable flag with no value is ignored: an empty command is dropped by the verb
      // anyway (`cleanCommands`), so there is nothing worth recording as a "value".
      if (!REPEATABLE.has(key)) flags[key] = undefined
      continue
    }
    // A value is whatever follows, even if it starts with `--`: an operator name or a resume
    // message is free-form text and may legitimately look like a flag.
    setFlag(token.slice(2), next)
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
 * Cursor's gate script, sourced exactly the way `hookPath()` above sources Claude's and for the
 * same reasons -- derived from this file's own location so a checkout works with no configuration,
 * overridable because an installed daemon's layout is not this one. A separate variable rather
 * than a shared one: the two runtimes' gates answer different protocols (Cursor's allow must be
 * spoken out loud; Claude's is silence), so pointing one at the other's script would produce a
 * gate that looks installed and blocks every tool call, or one that never blocks any.
 */
function cursorGatePath(): string {
  const fromEnv = process.env['AITEAMOS_CURSOR_GATE_PATH']
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv)
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'cursor-shell-gate.sh')
}

/**
 * The registry every command resolves its adapter from.
 *
 * The binary to spawn for a run is injectable through the environment rather than through a flag,
 * because Task 17's gate has to drive the fake CLI and the real one down the *same* code path —
 * and a flag only tests pass is a flag nobody runs.
 *
 * M12 Task 5: this used to build one `ClaudeCodeAdapter` directly (`buildAdapter`) and hand it to
 * every caller unconditionally -- the hardcoded selection this milestone exists to remove. It
 * builds a registry now. Task 8 made a run's provider a real per-run choice: every dispatch
 * resolves its OWN `ProviderKind` and looks it up here (`apps/orchestrator/src/provider.ts`'s
 * `resolveAdapter`), rather than every caller being handed the same adapter regardless of what it
 * asked for.
 *
 * M12 Task 12 registers the SECOND kind, which is the point at which "the registry picks the
 * adapter" stops being a claim about one entry. Both are configured unconditionally here: a
 * deployment that has no `cursor-agent` on its PATH refuses at spawn time with a message naming
 * the binary, which is a better answer than `invalid_provider` -- that refusal means "this process
 * was never wired for that provider", and after this task it would be false.
 */
function buildAdapterRegistry(): AdapterRegistry {
  const command = process.env['AITEAMOS_CLAUDE_BIN'] ?? 'claude'
  const extra = process.env['AITEAMOS_CLAUDE_ARGS']
  const cursorExtra = process.env['AITEAMOS_CURSOR_ARGS']
  return buildRegistry({
    claudeCode: {
      command,
      ...(extra === undefined || extra === '' ? {} : { extraArgs: extra.split(' ') }),
      // M12 Task 2: the hook path is a fact about this adapter instance now, not a per-run input --
      // it used to be threaded through `TickDeps`/`DaemonDeps` and into every `adapter.start()`
      // call; now it is set once, here.
      hookPath: hookPath(),
    },
    cursor: {
      // Injectable through the environment for the same reason `AITEAMOS_CLAUDE_BIN` is: the gate
      // has to drive a fake CLI and the real one down the same code path, and a flag only tests
      // pass is a flag nobody runs.
      command: process.env['AITEAMOS_CURSOR_BIN'] ?? 'cursor-agent',
      ...(cursorExtra === undefined || cursorExtra === '' ? {} : { extraArgs: cursorExtra.split(' ') }),
      gatePath: cursorGatePath(),
    },
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
  const given = flagText(flags, 'workspace')
  if (given !== undefined) return brandWorkspaceId(given)

  const all = await prisma.workspace.findMany({ select: { id: true, name: true } })
  if (all.length === 1 && all[0] !== undefined) return brandWorkspaceId(all[0].id)
  if (all.length === 0) throw new Error('there are no workspaces: seed one first')
  throw new Error(
    `--workspace is required when there is more than one workspace. Available:\n` +
      all.map((w) => `  ${w.id}  ${w.name}`).join('\n'),
  )
}

/**
 * The string-typed read every non-repeatable flag goes through, now that `Flags` also holds
 * arrays. A repeated non-repeatable flag can't happen by construction (`REPEATABLE` is the only
 * source of arrays in `parseArgs`), so the throw here is the type guard's honest fallback rather
 * than a reachable user-facing refusal.
 */
function flagText(flags: Flags, name: string): string | undefined {
  const value = flags[name]
  if (Array.isArray(value)) throw new Error(`--${name} was given more than once`)
  return value as string | undefined
}

/** Every value given for a repeatable flag, in order; a single occurrence still comes back as one-element. */
function flagList(flags: Flags, name: string): readonly string[] {
  const value = flags[name]
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value as string]
}

function requireFlag(flags: Flags, name: string): string {
  const value = flagText(flags, name)
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}

/**
 * A password read from stdin, never a command-line argument (M23 F3) -- a flag value lands in
 * shell history and in `ps`'s process listing for anyone else on the machine; stdin does not.
 * Reads only up to the first `\n` (or EOF, whichever comes first) rather than draining the whole
 * stream, so an interactive terminal is not left waiting on a second line that will never come;
 * a trailing `\r` is stripped so a CRLF-terminated pipe still yields a clean password.
 */
async function readSecretLine(): Promise<string> {
  let buffer = ''
  for await (const chunk of process.stdin) {
    buffer += (chunk as Buffer).toString('utf8')
    const newline = buffer.indexOf('\n')
    if (newline !== -1) {
      process.stdin.destroy()
      return buffer.slice(0, newline).replace(/\r$/, '')
    }
  }
  return buffer.replace(/\r$/, '')
}

const STDIN_PASSWORD_ERROR =
  'the password is read from stdin: printf "%s\\n" "$PW" | orchestrator create-user --name ada'

async function mustGetRun(runId: string) {
  // `agent -> team`, not `task`: a `planning` run (M8b) has no `Task` row, and `agent -> team ->
  // workspace` is the only linkage such a run has to a workspace -- the only thing this helper's
  // callers read off the include.
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: { agent: { include: { team: true } } },
  })
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
        registry: buildAdapterRegistry(),
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
      const period = Number(flagText(flags, 'period') ?? '1000')
      await runDaemon({
        workspaceId: await resolveWorkspace(flags),
        registry: buildAdapterRegistry(),
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
        // Scoped through `agent -> team`, not `task`: a `planning` run (M8b) has no `Task` row.
        where: { agent: { team: { workspaceId } }, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
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
      const result = await requestPause(requireFlag(flags, 'run'), flagText(flags, 'by') ?? 'operator')
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`pause_requested: the gate will deny ${requireFlag(flags, 'run')}'s next tool call\n`)
      return 0
    }

    case 'resume': {
      const run = await mustGetRun(requireFlag(flags, 'run'))
      const explicit = flagText(flags, 'message')
      // A halt is raised by a pause-gate failure or an unverifiable workspace (§13.1, §8), so
      // resuming into one relaunches an agent whose gate may still be broken -- the recurrence the
      // halt exists to bound. The help text promises this; it has to be true.
      //
      // Checked here rather than by calling `requestResume`: this command is synchronous and
      // continues the run itself, so recording an intent on the way to a failure would leave a
      // resume queued for the next daemon tick to execute -- an operator whose command errored out
      // would find the run resumed anyway, minutes later.
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: run.agent.team.workspaceId } })
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
        registry: buildAdapterRegistry(),
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
      const result = await emergencyStop(workspaceId, flagText(flags, 'by') ?? 'operator')
      if (!result.ok) throw new Error(refusalText(result.error))
      const { engaged, requested, refused } = result.value
      process.stdout.write(
        `${engaged ? 'emergency stop engaged' : 'workspace was already halted'} on ${workspaceId}: ` +
          `pause requested on ${requested.length} run(s), ${refused.length} already concluding. ` +
          `Retract with: clear-halt --workspace ${workspaceId}\n`,
      )
      return 0
    }

    case 'set-goal': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      const goal = requireFlag(flags, 'goal')
      const result = await setGoal(workspaceId, goal)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`goal set on ${workspaceId}\n`)
      return 0
    }

    case 'skills': {
      // The sub-verb is a positional, and `parseArgs` collects only flags -- so it is read off the
      // raw argv rather than `flags`. `argv[1]` because `argv[0]` is the command itself.
      const sub = argv[1]
      if (sub !== 'sync') {
        process.stderr.write(`unknown skills subcommand: ${String(sub)}\n\n${USAGE}`)
        return 1
      }
      const result = await syncSkillCatalog()
      process.stdout.write(describeSync(result))
      return 0
    }

    case 'create-template': {
      const name = requireFlag(flags, 'name')
      const role = requireFlag(flags, 'role')
      const description = flagText(flags, 'description')
      const model = flagText(flags, 'model')
      const provider = flagText(flags, 'provider')
      const result = await createTemplate(name, role, {
        ...(description !== undefined ? { description } : {}),
        ...(model !== undefined ? { defaultModel: model } : {}),
        ...(provider !== undefined ? { provider: provider as ProviderKind } : {}),
      })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`template ${result.value.id} created\n`)
      return 0
    }

    case 'create-company': {
      const name = requireFlag(flags, 'name')
      const result = await createCompany(name)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`company ${result.value.id} created\n`)
      return 0
    }

    case 'add-team': {
      const companyId = requireFlag(flags, 'company')
      const name = requireFlag(flags, 'name')
      const result = await addCompanyTeam(companyId, name)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`team ${result.value.id} created\n`)
      return 0
    }

    case 'add-agent': {
      const companyTeamId = requireFlag(flags, 'team')
      const templateId = requireFlag(flags, 'template')
      const name = requireFlag(flags, 'name')
      const model = flagText(flags, 'model')
      const provider = flagText(flags, 'provider')
      const result = await addCompanyAgent(companyTeamId, templateId, name, {
        ...(model !== undefined ? { model } : {}),
        ...(provider !== undefined ? { provider: provider as ProviderKind } : {}),
      })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`agent ${result.value.id} created\n`)
      return 0
    }

    case 'assign-company': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      const companyId = requireFlag(flags, 'company')
      const result = await assignCompany(workspaceId, companyId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`company assigned to ${workspaceId}: ${result.value.createdWorkers.length} new worker(s)\n`)
      return 0
    }

    case 'create-workspace': {
      const name = requireFlag(flags, 'name')
      const repoPath = requireFlag(flags, 'repo')
      const budgetText = flagText(flags, 'budget')
      const noBudget = 'no-budget' in flags
      if (budgetText !== undefined && noBudget) throw new Error('--budget and --no-budget are exclusive')
      const budgetUsd = noBudget ? null : budgetText === undefined ? undefined : Number(budgetText)
      const result = await createWorkspace({
        name,
        repoPath,
        ...(flagText(flags, 'base') !== undefined ? { baseBranch: flagText(flags, 'base') as string } : {}),
        verifyCommands: flagList(flags, 'verify'),
        setupCommands: flagList(flags, 'setup'),
        ...(budgetUsd === undefined ? {} : { budgetUsd }),
        ...(flagText(flags, 'provider') !== undefined ? { provider: flagText(flags, 'provider') as ProviderKind } : {}),
      })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`workspace ${result.value.id} created\n`)
      return 0
    }

    case 'set-model': {
      const agentId = requireFlag(flags, 'agent')
      // `'clear' in flags`, not `flags['clear'] !== undefined`: a bare `--clear` (no value
      // following it) is exactly how `parseArgs` records a flag with no argument -- it sets the
      // key to `undefined` rather than leaving it absent, so `!== undefined` can never see it.
      const clear = 'clear' in flags
      const model = flagText(flags, 'model')
      const provider = flagText(flags, 'provider')
      if (!clear && model === undefined) throw new Error('--model or --clear is required')
      const result = await setAgentModel(
        agentId,
        clear ? null : (model as string),
        clear ? null : ((provider as ProviderKind | undefined) ?? null),
      )
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(clear ? `model cleared on ${agentId}\n` : `model set to ${model} on ${agentId}\n`)
      return 0
    }

    // ---- D2: CLI surfaces for the roster editing verbs (M23 §5) --------------------------------
    // `rename-agent`/`set-role`/`delete-agent`/`rename-team`/`delete-team` mirror `set-model`'s
    // shape: resolve the flags, call the verb, print its refusal text through `refusalText` on
    // failure. The two deletes add one thing `set-model` doesn't need -- a `--yes` gate. Deleting
    // is the one edit here with no undo (`renameAgent`/`setAgentRole`/`renameTeam` can all be
    // pointed back), so a bare `delete-agent --agent <id>` names what it WOULD have deleted and
    // stops, rather than doing it on the strength of the command alone.

    case 'rename-agent': {
      const agentId = requireFlag(flags, 'agent')
      const name = requireFlag(flags, 'name')
      const result = await renameAgent(agentId, name)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`agent ${agentId} renamed\n`)
      return 0
    }

    case 'set-role': {
      const agentId = requireFlag(flags, 'agent')
      const role = requireFlag(flags, 'role')
      const result = await setAgentRole(agentId, role)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`role set to ${role} on ${agentId}\n`)
      return 0
    }

    case 'delete-agent': {
      const agentId = requireFlag(flags, 'agent')
      // `'yes' in flags`, not `flags['yes'] !== undefined`: same reasoning as `set-model`'s
      // `--clear` above -- a bare `--yes` records `undefined` as its value, not the string `true`.
      if (!('yes' in flags)) {
        const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { name: true } })
        throw new Error(`refusing without --yes: this would delete agent ${agent?.name ?? agentId} (${agentId})`)
      }
      const result = await deleteAgent(agentId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`agent ${agentId} deleted\n`)
      return 0
    }

    case 'rename-team': {
      const teamId = requireFlag(flags, 'team')
      const name = requireFlag(flags, 'name')
      const result = await renameTeam(teamId, name)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`team ${teamId} renamed\n`)
      return 0
    }

    case 'delete-team': {
      const teamId = requireFlag(flags, 'team')
      if (!('yes' in flags)) {
        const team = await prisma.team.findUnique({ where: { id: teamId }, select: { name: true } })
        throw new Error(`refusing without --yes: this would delete team ${team?.name ?? teamId} (${teamId})`)
      }
      const result = await deleteTeam(teamId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`team ${teamId} deleted\n`)
      return 0
    }

    // ---- F3: local accounts (M23 §7) ------------------------------------------------------------
    // The password is always read from stdin (`readSecretLine`), never a `--password` flag -- see
    // `STDIN_PASSWORD_ERROR` above for why. `delete-user` takes the same `--yes` gate as
    // `delete-agent`/`delete-team`: the username IS the identifier here, so there is no separate
    // id to look up and name in the refusal the way those two do.

    case 'create-user': {
      const name = requireFlag(flags, 'name')
      const password = await readSecretLine()
      if (password.length === 0) throw new Error(STDIN_PASSWORD_ERROR)
      const result = await createUser(name, password)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`user ${result.value.id} created\n`)
      return 0
    }

    case 'set-password': {
      const name = requireFlag(flags, 'name')
      const password = await readSecretLine()
      if (password.length === 0) throw new Error(STDIN_PASSWORD_ERROR)
      const result = await setPassword(name, password)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`password set for ${name}\n`)
      return 0
    }

    case 'delete-user': {
      const name = requireFlag(flags, 'name')
      if (!('yes' in flags)) throw new Error(`refusing without --yes: this would delete user ${name}`)
      const result = await deleteUser(name)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`user ${name} deleted\n`)
      return 0
    }

    case 'list-users': {
      const users = await listUsers()
      for (const user of users) {
        process.stdout.write(`${user.username}  ${user.createdAt.toISOString()}\n`)
      }
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
