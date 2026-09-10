import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addCompanySlave,
  addCompanyTeam,
  adoptSimulation,
  answerQuestion,
  approveDecision,
  archiveWorkspace,
  cancelTask,
  assignCompany,
  claimResume,
  cloneSimulation,
  compareSimulations,
  confirmIntegration,
  createCompany,
  createProjectTeam,
  createSimulation,
  createTemplate,
  createUser,
  createWorkspace,
  deleteCompany,
  deleteCompanySlave,
  deleteSlave,
  deleteCompanyTeam,
  deleteSlaveTemplate,
  deleteTeam,
  deleteUser,
  emergencyStop,
  haltSimulation,
  injectExternalEvent,
  listDecisions,
  listGoalVersions,
  listPendingQuestions,
  listUsers,
  loadSimulation,
  loadSupervisorWorld,
  moveSlave,
  moveCompanySlave,
  pauseSimulation,
  reassignQuestion,
  refusalText,
  rejectDecision,
  renameSlave,
  renameCompanyTeam,
  renameTeam,
  requestPause,
  requestStop,
  restoreWorkspace,
  resumeSimulation,
  setProfile,
  setRuntimeRoles,
  setSlaveModel,
  setSlaveRole,
  setGoal,
  setPassword,
  setSupervisorSettings,
  describeSync,
  DEFAULT_MAX_MODEL_CALLS,
  simulationStatus,
  startAutoRun,
  stepSimulation,
  stopAutoRun,
  syncSkillCatalog,
  tickSimulations,
  plural,
  unblockTask,
  type ModelDecider,
  type ProfileTarget,
} from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  SUPERVISOR_DEFAULT_MODEL,
  candidates,
  chooseByRules,
  displayName,
  filterFresh,
  observe,
  runContextManifestSchema,
  workspaceId as brandWorkspaceId,
  type WorkspaceId,
} from '@slave-of-ai/domain'
import { sectors } from '@slave-of-ai/simulation'
import { DEFAULT_MODEL_TIMEOUT_MS, buildRegistry, decideWithModel, type AdapterRegistry, type ProviderKind } from '@slave-of-ai/providers'
import { runDaemon } from './daemon.js'
import { PLANNING_RETRY_CAP } from './planning.js'
import { replanVerdict } from './replan.js'
import { renderReplanPreview } from './runContext.js'
import { deliverAnswers } from './deliver.js'
import { claudeCommandFrom } from './claude-command.js'
import { NON_TERMINAL_RUN_STATUSES } from './world.js'
import { executeResume } from './resume.js'
import { supervise } from './supervisor.js'
import { drainPumps, tick } from './tick.js'

// Every sector the platform knows, from the registry itself -- a literal `trade|software` here
// would be a third place to edit when a sector is added (M31b §1 principle 1).
const SECTOR_CHOICES = Object.keys(sectors).join('|')

const USAGE = `usage: orchestrator <command> [options]

  tick [--workspace <id>]              run exactly one tick and print the report
  daemon [--workspace <id>] [--period <ms>]
                                       the periodic + notification-driven loop
  status [--workspace <id>]            active runs with their pids, worktrees and states,
                                       and any workspace halt with the reason it happened
  pause --run <id> [--by <name>]       ask a run to stop at its next tool call
  resume --run <id> [--message <text>] continue a paused run, with an optional instruction
  cancel --run <id>                    stop a run for good; its worktree is preserved
  confirm-integration --task <id>      a human merged a done task's branch by hand -- the
                                       autoMerge-off workspace's own default -- so stamp it
                                       integrated and let its dependents start. Refused unless
                                       the task is done and not already integrated.
  unblock-task --task <id> [--allow-another-attempt]
                                       moves a blocked task back to rework so the scheduler picks
                                       it up again. Refused unless the task is blocked. attempt is
                                       never reset -- a task already at its attempt ceiling is
                                       refused unless --allow-another-attempt raises the ceiling
                                       by exactly one.
  cancel-task --task <id> --reason "<text>"
                                       take a task off the board for good: it becomes cancelled and
                                       the reason is kept on it. Only from backlog, ready or blocked
                                       -- work already in the pipeline is refused, and so is a task
                                       holding a live run. Anything that DEPENDS on it stays blocked
                                       until a human removes the dependency: the work was never
                                       done. No --by flag: the verb records no operator name, only
                                       that a human did it.
  messages [--workspace <id>]          every question a slave is still waiting on an answer to,
                                       with the message id the answer verb needs
  answer --message <id> --text "<t>" [--by <name>]
                                       answer a slave's question as a human, and hand the answer
                                       to the run that is waiting for it. The waiting run is
                                       queued to resume; the daemon (or one tick) continues it.
  reassign-question --message <id> --to <slaveId> [--by <name>]
                                       put an unanswered question in front of a different slave --
                                       the one who can actually answer it. Refused unless that
                                       slave holds the role the question was addressed to (or, for
                                       a question addressed to a slave by name, a role the asker's
                                       task requires), and refused once the question has been
                                       answered. Nothing is answered and nobody is resumed: the
                                       asker keeps waiting until the new recipient replies.
  clear-halt --workspace <id>          retract a WORKSPACE-WIDE safety halt
  emergency-stop --workspace <id> [--by <name>]
                                       halt scheduling on the WHOLE workspace AND pause every
                                       active run in it -- the operator's stop-everything button
  set-goal --workspace <id> --goal "<text>"
                                       set the operator's standing instruction for what this
                                       workspace's slaves are working toward. Every accepted set is
                                       a new VERSION of the requirement; prints the version it wrote
                                       and that text's sha256. Refused (non-zero) when the new text
                                       is byte-identical to the current version -- nothing is
                                       recorded, because nothing changed.
  goal-history --workspace <id>        every version of this project's goal, newest first, as JSON:
                                       the text, its sha256, who set it, when, and the line-level
                                       diff against the version it replaced (null for v1).
  replan-status --workspace <id> [--prompt]
                                       why the next tick will, or will not, start a delta re-plan:
                                       the goal version, the highest version stamped on an
                                       unfinished task, whether this version was already re-planned,
                                       whether a planning run is live, the failed attempts against
                                       the cap, and willReplan. --prompt also prints the re-plan
                                       prompt such a run would be given -- rendered and thrown away,
                                       never recorded, and it starts nothing.
  create-workspace --name <n> --repo <abs path> [--base main] --verify "<cmd>" [--verify "<cmd>" ...]
                   [--setup "<cmd>" ...] [--budget <usd> | --no-budget] [--provider claude_code|cursor]
                                       attach an existing local clone as a workspace. The path
                                       must be absolute and a git work tree, the base branch must
                                       exist, and at least one verify command is required -- a
                                       workspace with none can never reach done. --verify and
                                       --setup repeat, one command each, run in the order given.
  archive-workspace --workspace <id>   archive a project: every row stays, nothing runs until
                                       restore-workspace. Refused while a run is live.
  restore-workspace --workspace <id>   bring an archived project back
  list-workspaces                      every project, archived ones marked
  skills sync                          rescan the skill catalog from this host's disk:
                                       ~/.claude/skills, the plugin cache, and <repo>/.claude/skills
  create-template --name <n> --role <r> [--model <m> --provider <p>] [--description <d>]
                                       add a reusable slave template to the catalog. --model and
                                       --provider are a pair: give both or neither.
  create-company --name <n>            add a company (a persistent roster) to the catalog
  add-team --company <id> --name <n>   add a department template to a company's roster
  add-slave --team <companyTeamId> --template <id> --name <n> [--model <m> --provider <p>]
                                       add a roster member to a company team, instantiated from a
                                       template. --model and --provider are a pair: give both or
                                       neither.
  assign-company --workspace <id> --company <id>
                                       assign a company's roster to a workspace, materializing a
                                       project team/worker for every roster member with no
                                       matching row there yet
  set-model --slave <workerId> --model <m> --provider <p>
  set-model --slave <workerId> --clear
                                       set or clear a worker's own model+provider override -- the
                                       top of the resolution chain, above its roster row and its
                                       template's default. A model only means something inside the
                                       provider that runs it, so --model requires --provider.
  rename-slave --slave <id> --name <n> rename a project slave
  set-role --slave <id> --role <r>     change a project slave's TITLE -- the heading of its
                                       persona, not what it is dispatched as. Refused while the
                                       slave holds a live run.
  set-profile --slave <id> | --template <id> | --company-slave <id>
              (--file <path> | --clear) [--by <name>]
                                       set (or clear) the persona Markdown at one level of the
                                       override chain: the worker's own, its roster row's, or its
                                       template's. First non-null wins at dispatch. Read from a
                                       file, not a flag -- it can be 16k characters. --by names
                                       the operator on the event.
  set-runtime-roles --slave <id> --roles a,b,c [--by <name>]
                                       replace the roles this slave may be DISPATCHED as -- the
                                       scheduler's match, reviewer/manager staffing, and message
                                       role-addressing all read this set. --roles '' parks the
                                       slave: it can be dispatched as nothing until it holds a
                                       role again.
  show-context --run <id> [--prompt]   what this run was told: the manifest of the sections its
                                       prompt was assembled from, and with --prompt the prompt
                                       itself after a rule

  supervise --workspace <id> [--dry-run]
                                       one pass of the Supervisor over this workspace: observes
                                       stuck situations, decides an action for each from a fixed
                                       catalogue (a model when one is wired, the rules otherwise),
                                       applies the routine ones and records the risky ones as
                                       proposals for a human. --dry-run prints what it WOULD
                                       decide -- every fresh situation, its candidates and the
                                       rules' own choice -- and writes nothing at all: no decision
                                       row, no event, no model call.
  supervisor-decisions --workspace <id> [--pending] [--limit <n>]
                                       the workspace's Supervisor decisions, newest first, as
                                       JSON -- the situation each was made on, the candidates it
                                       chose from and why. --pending narrows to what is still
                                       waiting on a human; --limit caps how many come back
                                       (default 50). An answer decision also carries the DRAFT it
                                       proposes -- the body, the citations that verified and the
                                       ones that did not, its confidence (sourced or
                                       interpretation) and the critical flags that stopped it.
  approve-decision --id <id> [--body-file <path>]
                                       a human says yes to a pending proposal: carries out its
                                       action and marks it approved. --body-file replaces a drafted
                                       ANSWER with your own words, read from a file untrimmed and
                                       kept on the decision as the edit; it is also how you answer
                                       a question the Supervisor escalated instead of drafting.
  reject-decision --id <id> [--reason <text>]
                                       a human says no to a pending proposal: its action never
                                       reaches the world. --reason is kept with the decision.
  set-supervisor --workspace <id> [--enable | --disable]
                 [--profile-file <path> | --clear-profile]
                                       switch a workspace's Supervisor on or off, and/or set (from
                                       a file) or clear its persona/house-rules profile. Refused
                                       with no flag at all, with both --enable and --disable, or
                                       with both --profile-file and --clear-profile.

  delete-slave --slave <id> --yes      remove a project slave WITH its run history -- refused
                                       only while it holds a live run. Omit --yes to see what
                                       would be deleted without doing it.
  rename-team --team <id> --name <n>   rename a project department
  delete-team --team <id> --yes        remove a department WITH its slaves and their run
                                       history -- refused only while any of its slaves holds a
                                       live run. Omit --yes to see what would be deleted without
                                       doing it.
  create-team --workspace <id> --name <n>
                                       add a department to a project (no template link)
  move-slave --slave <id> --team <id>  move a project slave to another department of the same
                                       project -- refused while the slave holds a live run
  move-company-slave --slave <companySlaveId> --team <companyTeamId>
                                       move a catalog slave to another department template of
                                       the same company
  rename-company-team --team <companyTeamId> --name <n>
                                       rename a department template
  delete-company-team --team <companyTeamId> --yes
                                       remove a department template WITH its catalog slaves;
                                       project departments copied from it keep living. Omit --yes
                                       to see what would be deleted without doing it.
  delete-company --company <id> --yes  remove a company with its department templates and catalog
                                       slaves; projects keep their copies. Omit --yes to preview.
  delete-company-slave --slave <companySlaveId> --yes
                                       remove a catalog slave; project copies survive. Omit --yes
                                       to see how many of them stay.
  delete-template --template <id> --yes
                                       remove a slave template with the catalog slaves made from
                                       it; project slaves keep their role
  create-simulation --sector ${SECTOR_CHOICES} --company <id> --name <n> --policy A|B [--seed <n>]
      [--decision-provider rules|llm] [--model-provider claude_code] [--model <id>]
      [--max-model-cost-usd <n>]
                                       create a company SIMULATION from a catalog company's
                                       roster (frozen at creation). No repository. The rules
                                       provider (default) makes no model call; an llm run needs
                                       --model-provider, --model and a positive
                                       --max-model-cost-usd, and steps only through auto-run.
                                       Synthetic data.
  step-simulation --simulation <id> [--steps <n> | --until-day <d>]
                                       advance the simulation clock (one day per step) — refused
                                       for an llm run; its steps happen in the daemon
  simulation-status --simulation <id>  the run's summary, company panel, metrics and model
                                       usage (spentUsd/capUsd apart from the simulated money) as
                                       JSON — real cost apart
  pause-simulation --simulation <id>   pause: refuse every next step (clears auto-run)
  resume-simulation --simulation <id>  resume a paused simulation (auto-run is not restored)
  halt-simulation --simulation <id> [--reason <text>]
                                       the emergency stop for a simulation
  inject-simulation-event --simulation <id> --day <d> --event '<json>'
                                       inject an external event the sector allows on a future day
  clone-simulation --simulation <id> --name <n> --policy A|B [--seed <n>]
                                       a new run from this run's frozen scenario: same world,
                                       different policy or seed, day 0, nothing carried over
  adopt-simulation --simulation <id> --workspace <id>
      [--max-concurrent <n>] [--max-attempts <n>] [--apply-model]
                                       put the run's organisation onto a real, company-less
                                       project: the current roster with the run's roles, a
                                       settings proposal (override with --max-concurrent /
                                       --max-attempts), autoMerge off. --apply-model sets an llm
                                       run's model on the lead's roster row -- real, paid use.
                                       Starts nothing. Only a run whose sector allows adoption is
                                       adoptable.
  auto-run-simulation --simulation <id> [--every-ms <n>] [--until-day <d>]
                                       let the daemon step it (default every 1000 ms to the horizon)
  stop-auto-run --simulation <id>
  compare-simulations --a <id> --b <id>
                                       both runs' metrics, b − a deltas and whether they share a
                                       world, as JSON — no verdict

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
  const fromEnv = process.env['SLAVEOFAI_HOOK_PATH']
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv)
  // dist/cli.js -> apps/orchestrator -> apps -> repo root
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'pause-gate.sh')
}

/**
 * The deny-all gate a SIMULATION's model call is spawned with (M31a §4), sourced exactly the way
 * `hookPath()` above sources the pause gate and for the same reasons. A separate script, not a
 * parameterisation of the pause gate: this one denies EVERY tool call unconditionally, whatever
 * any flag says -- `preflightDenyAll` refuses to start a decision call whose hook does anything
 * else -- because a simulation actor has no business touching a real tool at all.
 */
function denyAllHookPath(): string {
  const fromEnv = process.env['SLAVEOFAI_DENY_ALL_HOOK_PATH']
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv)
  // dist/cli.js -> apps/orchestrator -> apps -> repo root
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'deny-all-gate.sh')
}

/**
 * The `claude` binary this process spawns, and any extra argv in front of its own flags. Injectable
 * through the environment for the reason `buildAdapterRegistry` documents: the gates have to drive
 * the fake CLI and the real one down the SAME code path. Extracted (M31a Task 4) because a
 * simulation's model call (`decideWithModel`) is the second caller that must spawn exactly what an
 * adapter would -- two readings of the same two variables would drift.
 *
 * A thin wrapper (M34 t3) around {@link claudeCommandFrom}, the pure part -- unit-tested on its own
 * in `claude-command.test.ts` -- so this file's one job here is reading `process.env`. The
 * `SLAVEOFAI_REQUIRE_FAKE_CLI` refusal `claudeCommandFrom` throws propagates unchanged: `main`'s
 * own catch turns it into a message and exit 1, so the daemon and every verb that builds an
 * adapter or a model decider refuse together.
 */
function claudeCommand(): { readonly command: string; readonly extraArgs?: readonly string[] } {
  return claudeCommandFrom(process.env)
}

/**
 * The decider the DAEMON injects into `tickSimulations` (M31a §4). The control layer holds no
 * knowledge of how a model is called -- it hands out a prompt and a budget and takes an outcome --
 * so this closure is the whole seam between a simulation's decision point and a real model call.
 * Built here, next to `claudeCommand()` and the gate paths, rather than inside the daemon: this
 * file is the one place that reads the environment for spawn configuration.
 */
function buildModelDecider(): ModelDecider {
  return (input) =>
    decideWithModel({
      ...claudeCommand(),
      hookPath: denyAllHookPath(),
      model: input.model,
      prompt: input.prompt,
      maxBudgetUsd: input.maxBudgetUsd,
      timeoutMs: Number(process.env['SLAVEOFAI_MODEL_TIMEOUT_MS'] ?? DEFAULT_MODEL_TIMEOUT_MS),
    })
}

/**
 * How many simulation model calls the daemon keeps in flight at once (M32 item 2). Read here for
 * the same reason `buildModelDecider` is built here: this file is the one place that reads the
 * environment for spawn configuration. A value that is not a positive integer is ignored rather
 * than obeyed -- `SLAVEOFAI_MAX_MODEL_CALLS=0` would arm an llm auto-run that can never step, and
 * a typo must not silently do that.
 */
function maxConcurrentModelCalls(): number {
  const parsed = Number(process.env['SLAVEOFAI_MAX_MODEL_CALLS'])
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_MODEL_CALLS
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
  const fromEnv = process.env['SLAVEOFAI_CURSOR_GATE_PATH']
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
  const cursorExtra = process.env['SLAVEOFAI_CURSOR_ARGS']
  return buildRegistry({
    claudeCode: {
      ...claudeCommand(),
      // M12 Task 2: the hook path is a fact about this adapter instance now, not a per-run input --
      // it used to be threaded through `TickDeps`/`DaemonDeps` and into every `adapter.start()`
      // call; now it is set once, here.
      hookPath: hookPath(),
    },
    cursor: {
      // Injectable through the environment for the same reason `SLAVEOFAI_CLAUDE_BIN` is: the gate
      // has to drive a fake CLI and the real one down the same code path, and a flag only tests
      // pass is a flag nobody runs.
      command: process.env['SLAVEOFAI_CURSOR_BIN'] ?? 'cursor-agent',
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

  // M27 §3.3: the auto-pick only ever considers a project that is not archived -- an explicit
  // `--workspace` may still name an archived one, and `tick`/`status` handle that themselves.
  const all = await prisma.workspace.findMany({ where: { archivedAt: null }, select: { id: true, name: true } })
  if (all.length === 1 && all[0] !== undefined) return brandWorkspaceId(all[0].id)
  if (all.length === 0) {
    // Every project archived is a different situation from no project at all; say which.
    const archived = await prisma.workspace.count({ where: { archivedAt: { not: null } } })
    throw new Error(
      archived > 0
        ? `every project is archived (${archived}): restore one with restore-workspace --workspace <id>, or name one with --workspace`
        : 'there are no projects: seed one first',
    )
  }
  throw new Error(
    `--workspace is required when there is more than one project. Available:\n` +
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
  // `slave -> team`, not `task`: a `planning` run (M8b) has no `Task` row, and `slave -> team ->
  // workspace` is the only linkage such a run has to a workspace -- the only thing this helper's
  // callers read off the include.
  const run = await prisma.slaveRun.findUnique({
    where: { id: runId },
    include: { slave: { include: { team: true } } },
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
      const simulations = await tickSimulations({ now: new Date() })
      process.stdout.write(`${JSON.stringify({ ...report, simulations }, null, 2)}\n`)

      // The command waits for what it started, even though the *function* deliberately does not.
      // A daemon keeps running and its pumps outlive each tick by design (spec §5.6); a one-shot
      // command's process is about to exit, and exiting would leave a live slave with nobody
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
        // M31a §4: only the daemon carries a decider. The one-shot `tick` above deliberately does
        // not -- a command an operator runs by hand must never start spending on model calls -- so
        // it reports `skippedNoDecider` instead and the llm runs wait for the daemon.
        modelDecider: buildModelDecider(),
        // M38 §5 / spec erratum E3: the Supervisor's own model. Read here, where the environment
        // is read, rather than defaulted inside the tick -- and overridable per host, because a
        // decision prompt is small and cheap and an operator may want a smaller model on it than
        // M31a's simulation calls use (those take theirs from the simulation intent).
        supervisorModel: process.env['SLAVEOFAI_SUPERVISOR_MODEL'] ?? SUPERVISOR_DEFAULT_MODEL,
        maxConcurrentModelCalls: maxConcurrentModelCalls(),
      })
      return 0
    }

    case 'status': {
      const workspaceId = await resolveWorkspace(flags)
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
      const runs = await prisma.slaveRun.findMany({
        // On the status column, not on `endedAt`: the two can disagree, and everything else in the
        // system -- `loadWorld`'s busy check, the sweep, the orphan pass -- asks the status.
        // Scoped through `slave -> team`, not `task`: a `planning` run (M8b) has no `Task` row.
        where: { slave: { team: { workspaceId } }, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
        orderBy: { startedAt: 'desc' },
      })
      process.stdout.write(
        `${JSON.stringify(
          {
            // M27 §3, and inside the object deliberately (final review, minor 6): `status`'s whole
            // output is one JSON document -- every caller, this repo's own tests included, reads it
            // with `JSON.parse(stdout)` -- so a bare `archived: …` line printed before it made the
            // command unparseable for exactly the projects it was added to describe.
            archived: workspace.archivedAt === null ? null : workspace.archivedAt.toISOString(),
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
      // resuming into one relaunches a slave whose gate may still be broken -- the recurrence the
      // halt exists to bound. The help text promises this; it has to be true.
      //
      // Checked here rather than by calling `requestResume`: this command is synchronous and
      // continues the run itself, so recording an intent on the way to a failure would leave a
      // resume queued for the next daemon tick to execute -- an operator whose command errored out
      // would find the run resumed anyway, minutes later.
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: run.slave.team.workspaceId } })
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
      // *terminal* run -- measured: a second slave in the finished run's worktree, `terminalAt`
      // rewritten, a second `run.succeeded` in the log -- and against a live daemon it puts two
      // slaves on one branch while overwriting the pid that could have killed the first. The
      // adapter's live-child guard cannot help: a CLI invocation is always the cross-process case
      // its registry is empty for.
      //
      // `claimResume` first, so an operator resuming a run the web already queued picks up that
      // instruction rather than silently discarding it. It claims only when an intent is recorded,
      // so a run nobody asked about falls through to the second call below -- which is the SAME
      // function with the intent requirement dropped, not a second claim written out by hand
      // (M36 t2 fix round 1, finding 2): every resume has to reclaim the task of a run that was
      // waiting for an answer, and a hand-rolled `updateMany` here is precisely how one path comes
      // to forget it. It clears the intent columns either way, closing the window where a web
      // `requestResume` lands between the two calls: without that, the intent would survive into
      // `resuming` and later spontaneously resume the run on its own.
      const requested = await claimResume(run.id)
      const intent = requested.claimed ? requested : await claimResume(run.id, { requireIntent: false })
      if (!intent.claimed) {
        throw new Error(`run ${run.id} is not paused (it is ${run.status}): there is nothing to resume`)
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

    case 'confirm-integration': {
      const taskIdFlag = requireFlag(flags, 'task')
      const result = await confirmIntegration(taskIdFlag)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`task ${taskIdFlag} is now integrated; its dependents may start\n`)
      return 0
    }

    case 'unblock-task': {
      const taskIdFlag = requireFlag(flags, 'task')
      // Same idiom as `adopt-simulation --apply-model` (`'apply-model' in flags`, not
      // `!== undefined`): a bare `--allow-another-attempt` with no argument is exactly how
      // `parseArgs` records a flag with no value, setting the key to `undefined` rather than
      // leaving it absent.
      const allowAnotherAttempt = 'allow-another-attempt' in flags
      const result = await unblockTask(taskIdFlag, { allowAnotherAttempt })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`task ${taskIdFlag} is unblocked and back in rework\n`)
      return 0
    }

    case 'cancel-task': {
      // No `--by`, unlike `unblock-task`'s neighbours above: `cancelTask` has no operator-name
      // field to put one in. Its third argument is the ENVELOPE actor (`'human'` here -- a person
      // ran this command; the Supervisor's own approval path passes `'system'`), and its fourth is
      // a `Principal`, which the CLI has never had (`approve-decision`'s own comment: "the CLI and
      // the orchestrator act with no user"). A `--by` that reached neither would be a flag that
      // silently did nothing, so the reason is the only place a name can go, and an operator who
      // wants one writes it there.
      const taskIdFlag = requireFlag(flags, 'task')
      const reason = requireFlag(flags, 'reason')
      const result = await cancelTask(taskIdFlag, reason, 'human')
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(
        `task ${taskIdFlag} is cancelled: ${reason}\nAnything that depends on it stays blocked until you remove the dependency.\n`,
      )
      return 0
    }

    case 'messages': {
      const workspaceId = await resolveWorkspace(flags)
      const result = await listPendingQuestions(workspaceId)
      if (!result.ok) throw new Error(refusalText(result.error))
      if (result.value.length === 0) {
        process.stdout.write('no slave is waiting on an answer\n')
        return 0
      }
      // Names, not ids, for the two slaves -- an operator reading `from <uuid> to <uuid>` learns
      // nothing. One query for the whole roster, not one per row.
      const roster = await prisma.slave.findMany({
        where: { team: { workspaceId } },
        select: { id: true, name: true, role: true },
      })
      // `displayName` (`@slave-of-ai/domain`), not a local `${name} (${role})` -- M37 §3 made that
      // one function so the CLI, the inbox, the ask roster and delivery cannot drift apart.
      const nameById = new Map(roster.map((slave) => [slave.id, displayName(slave)]))
      // The id first on every line: it is the one thing an operator has to copy into `answer`.
      for (const message of result.value) {
        const from = nameById.get(message.senderSlaveId) ?? message.senderSlaveId
        const to =
          message.recipientSlaveId !== null
            ? (nameById.get(message.recipientSlaveId) ?? message.recipientSlaveId)
            : `anyone with the ${message.recipientRole ?? 'unknown'} role`
        process.stdout.write(`${message.id}  from ${from} to ${to}\n  ${message.body.replaceAll('\n', '\n  ')}\n`)
      }
      return 0
    }

    case 'answer': {
      const messageId = requireFlag(flags, 'message')
      const result = await answerQuestion(messageId, {
        body: requireFlag(flags, 'text'),
        answeredBy: flagText(flags, 'by') ?? 'operator',
      })
      if (!result.ok) throw new Error(refusalText(result.error))

      // The same delivery pass the tick runs, not a second path: writing the answer and deciding
      // whether a waiting run may be resumed by it are different questions, and only one place in
      // the system is allowed to answer the second (`deliver.ts`).
      const delivered = await deliverAnswers(result.value.workspaceId)
      const woke = delivered.find((one) => one.answerId === result.value.id)
      process.stdout.write(
        woke === undefined
          ? `answered ${messageId}. No run is waiting on it right now, so nothing was resumed.\n`
          : `answered ${messageId}. Run ${woke.runId} is queued to resume -- the daemon (or one \`tick\`) continues it.\n`,
      )
      return 0
    }

    case 'reassign-question': {
      // The human's own half of the Supervisor's `reassign_question` (M39 §6): the same verb, with
      // `origin: 'human'` so the event reads as a person's act, and no decision id -- nothing
      // proposed this, an operator did it. `--by` names them on the payload exactly as `answer`'s
      // does; there is no session here to name instead (see `approve-decision` below).
      const messageId = requireFlag(flags, 'message')
      const toSlaveId = requireFlag(flags, 'to')
      const result = await reassignQuestion(messageId, toSlaveId, flagText(flags, 'by') ?? 'operator', 'human')
      if (!result.ok) throw new Error(refusalText(result.error))
      // No delivery pass, unlike `answer` above: re-addressing writes no answer, so nobody is
      // resumed by it. The question is now in another worker's inbox, and that worker reads it on
      // its next dispatch.
      process.stdout.write(
        `question ${messageId} is now addressed to ${toSlaveId}. Nothing was answered and nobody was resumed: ` +
          `the asker keeps waiting until that slave replies.\n`,
      )
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
          `pause requested on ${plural(requested.length, 'run')}, ${refused.length} already concluding. ` +
          `Retract with: clear-halt --workspace ${workspaceId}\n`,
      )
      return 0
    }

    case 'set-goal': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      const goal = requireFlag(flags, 'goal')
      const result = await setGoal(workspaceId, goal)
      // `goal_unchanged` exits NON-zero with the refusal's own words, like every other refusal this
      // file reports (M40 t4 ruling). Only the WEB softens it into "no change": a browser form has
      // a person in front of it who just pressed a button, and a command in a script has a caller
      // that has to be able to tell "the version moved" from "it did not".
      if (!result.ok) throw new Error(refusalText(result.error))
      // JSON, like `show-context` and `supervisor-decisions`: the version is the number the re-plan
      // trigger counts and a caller has to be able to read it back without parsing a sentence.
      process.stdout.write(`${JSON.stringify({ version: result.value.version, sha256: result.value.sha256 })}\n`)
      return 0
    }

    case 'goal-history': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      const result = await listGoalVersions(workspaceId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`)
      return 0
    }

    case 'replan-status': {
      // A READ, and ruling R4 is why it stays one: the tick is the only thing that starts a
      // planning run, so this prints the verdict the tick would reach and dispatches nothing --
      // including with `--prompt`, which renders the prompt and throws it away.
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      const workspace = await prisma.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { goalVersion: true },
      })
      // The same helper `dispatchPlanning` asks, at the same cap -- one idea of when a re-plan
      // fires, not a second one that can drift from the tick's.
      const verdict = await replanVerdict(workspaceId, workspace.goalVersion, PLANNING_RETRY_CAP)
      process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`)

      if ('prompt' in flags) {
        if (verdict.intent === null) {
          // Nothing to preview: the prompt this would render is for a run that will not happen, and
          // inventing a previous version to diff against would put a requirement nobody set in
          // front of an operator.
          process.stdout.write(
            `${'-'.repeat(40)}\nno re-plan is pending for goal v${String(verdict.goalVersion)}, so there is no prompt to preview\n`,
          )
          return 0
        }
        // A rule between the verdict and the prompt, `show-context --prompt`'s own separator: the
        // prompt is free text and can contain anything, including JSON.
        const prompt = await renderReplanPreview({
          workspaceId,
          previousVersion: verdict.intent.previousVersion,
          version: verdict.intent.version,
        })
        process.stdout.write(`${'-'.repeat(40)}\n${prompt}\n`)
      }
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
      process.stdout.write(`department template ${result.value.id} created\n`)
      return 0
    }

    case 'add-slave': {
      const companyTeamId = requireFlag(flags, 'team')
      const templateId = requireFlag(flags, 'template')
      const name = requireFlag(flags, 'name')
      const model = flagText(flags, 'model')
      const provider = flagText(flags, 'provider')
      const result = await addCompanySlave(companyTeamId, templateId, name, {
        ...(model !== undefined ? { model } : {}),
        ...(provider !== undefined ? { provider: provider as ProviderKind } : {}),
      })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`slave ${result.value.id} created\n`)
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

    case 'archive-workspace': {
      const workspaceId = requireFlag(flags, 'workspace')
      const result = await archiveWorkspace(workspaceId)
      if (!result.ok) throw new Error(refusalText(result.error))
      const f = result.value.footprint
      process.stdout.write(`project ${workspaceId} archived: ${plural(f.departments, 'department')}, ${plural(f.slaves, 'slave')}, ${plural(f.tasks, 'task')}, ${plural(f.runs, 'run')} stay on record\n`)
      return 0
    }

    case 'restore-workspace': {
      const workspaceId = requireFlag(flags, 'workspace')
      const result = await restoreWorkspace(workspaceId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`project ${workspaceId} restored\n`)
      return 0
    }

    case 'list-workspaces': {
      const all = await prisma.workspace.findMany({ select: { id: true, name: true, archivedAt: true }, orderBy: { name: 'asc' } })
      for (const w of all) process.stdout.write(`${w.id}  ${w.name}${w.archivedAt === null ? '' : `  (archived ${w.archivedAt.toISOString()})`}\n`)
      return 0
    }

    case 'set-model': {
      const slaveId = requireFlag(flags, 'slave')
      // `'clear' in flags`, not `flags['clear'] !== undefined`: a bare `--clear` (no value
      // following it) is exactly how `parseArgs` records a flag with no argument -- it sets the
      // key to `undefined` rather than leaving it absent, so `!== undefined` can never see it.
      const clear = 'clear' in flags
      const model = flagText(flags, 'model')
      const provider = flagText(flags, 'provider')
      if (!clear && model === undefined) throw new Error('--model or --clear is required')
      const result = await setSlaveModel(
        slaveId,
        clear ? null : (model as string),
        clear ? null : ((provider as ProviderKind | undefined) ?? null),
      )
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(clear ? `model cleared on ${slaveId}\n` : `model set to ${model} on ${slaveId}\n`)
      return 0
    }

    // ---- D2: CLI surfaces for the roster editing verbs (M23 §5) --------------------------------
    // `rename-slave`/`set-role`/`delete-slave`/`rename-team`/`delete-team` mirror `set-model`'s
    // shape: resolve the flags, call the verb, print its refusal text through `refusalText` on
    // failure. The two deletes add one thing `set-model` doesn't need -- a `--yes` gate. Deleting
    // is the one edit here with no undo (`renameSlave`/`setSlaveRole`/`renameTeam` can all be
    // pointed back), so a bare `delete-slave --slave <id>` names what it WOULD have deleted and
    // stops, rather than doing it on the strength of the command alone.

    case 'rename-slave': {
      const slaveId = requireFlag(flags, 'slave')
      const name = requireFlag(flags, 'name')
      const result = await renameSlave(slaveId, name)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`slave ${slaveId} renamed\n`)
      return 0
    }

    case 'set-role': {
      const slaveId = requireFlag(flags, 'slave')
      const role = requireFlag(flags, 'role')
      // The TITLE, not what the slave is dispatched as (M37 §5) -- `set-runtime-roles` below is
      // the verb for that. Printed as such so an operator who reaches for this one expecting the
      // scheduler to notice is told, in the confirmation itself, that it will not.
      const result = await setSlaveRole(slaveId, role)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(
        `title set to ${role} on ${slaveId} — this is the profile's heading, not what it is ` +
          'dispatched as; use set-runtime-roles for that\n',
      )
      return 0
    }

    // ---- M37 t3: the persona, the dispatchable roles, and what a run was actually told ----------

    case 'set-profile': {
      // Exactly one target, checked here rather than left to `setProfile`'s union: the union makes
      // an ambiguous call unrepresentable in TypeScript, and `flags` is not TypeScript.
      const targets: ProfileTarget[] = [
        ...(flagText(flags, 'slave') !== undefined ? [{ slaveId: requireFlag(flags, 'slave') }] : []),
        ...(flagText(flags, 'template') !== undefined ? [{ templateId: requireFlag(flags, 'template') }] : []),
        ...(flagText(flags, 'company-slave') !== undefined ? [{ companySlaveId: requireFlag(flags, 'company-slave') }] : []),
      ]
      if (targets.length !== 1 || targets[0] === undefined) {
        throw new Error('exactly one of --slave, --template or --company-slave is required')
      }
      const target = targets[0]

      // `--file`, never `--text`: a persona is Markdown of up to 16k characters, and a shell
      // argument that long is the wrong tool -- it lands in history, in `ps`, and in whatever the
      // shell decides to do with its newlines. `'clear' in flags` (not `!== undefined`) is the
      // repo's own idiom for a bare flag, whose recorded value is `undefined`.
      const clear = 'clear' in flags
      const file = flagText(flags, 'file')
      if (clear === (file !== undefined)) throw new Error('exactly one of --file <path> or --clear is required')
      const profile = clear ? null : readFileSync(requireFlag(flags, 'file'), 'utf8')

      const result = await setProfile(target, profile, flagText(flags, 'by') ?? 'operator')
      if (!result.ok) throw new Error(refusalText(result.error))
      const which = 'slaveId' in target ? target.slaveId : 'templateId' in target ? target.templateId : target.companySlaveId
      process.stdout.write(clear ? `profile cleared on ${which}\n` : `profile set on ${which}\n`)
      return 0
    }

    case 'set-runtime-roles': {
      const slaveId = requireFlag(flags, 'slave')
      // `--roles ''` is how a slave is PARKED (spec §7): an empty set is a real state, so an empty
      // string splits to nothing rather than to one blank entry the verb would refuse.
      const raw = requireFlag(flags, 'roles')
      const roles = raw.trim() === '' ? [] : raw.split(',')
      const result = await setRuntimeRoles(slaveId, roles, flagText(flags, 'by') ?? 'operator')
      if (!result.ok) throw new Error(refusalText(result.error))
      const after = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId }, select: { runtimeRoles: true } })
      process.stdout.write(
        after.runtimeRoles.length === 0
          ? `${slaveId} now holds no runtime roles: it cannot be dispatched until it holds one\n`
          : `runtime roles set to ${after.runtimeRoles.join(', ')} on ${slaveId}\n`,
      )
      return 0
    }

    case 'show-context': {
      const runIdFlag = requireFlag(flags, 'run')
      const row = await prisma.runContext.findUnique({ where: { runId: runIdFlag } })
      // Not a `ControlRefusal`: this is a read, and the one thing that can go wrong with it is
      // that the run never recorded a context -- which for a run that started is impossible (the
      // row is written before the spawn), so the honest message says which two things it can mean.
      if (row === null) {
        throw new Error(`no recorded context for run ${runIdFlag}: either no such run, or it never started`)
      }
      // Validated rather than cast (M37 §3): `sections` is a `Json` column, and a hand-edited or
      // pre-M37 row must produce a clear error here instead of a confusing one downstream.
      const manifest = runContextManifestSchema.safeParse(row.sections)
      if (!manifest.success) {
        throw new Error(`run ${runIdFlag} has a context manifest this version cannot read: ${manifest.error.message}`)
      }
      process.stdout.write(`${JSON.stringify(manifest.data, null, 2)}\n`)
      if ('prompt' in flags) {
        // A rule between the manifest and the prompt so the two are separable by eye and by
        // `sed`: the prompt is free text and can contain anything, including JSON.
        process.stdout.write(`${'-'.repeat(40)}\n${row.prompt}\n`)
      }
      return 0
    }

    // ---- M38 t4: the Supervisor's CLI verbs ------------------------------------------------------
    // `supervise` is a SEPARATE one-shot from `tick` -- `tick`'s own supervisor pass (wired in
    // `tick.ts`) always runs rules-only, because a command an operator runs by hand must never
    // spend on a model call by itself (the same discipline `buildModelDecider` is kept off `tick`
    // for). This verb is the one place an operator asks for a supervised pass WITH the model seam,
    // or previews one with none of it at all.

    case 'supervise': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })

      if ('dry-run' in flags) {
        // The dry-run building blocks, called directly rather than through `supervise()` --
        // `recordDecision`/`applyDecision`/`expirePendingDecisions` and the model are never
        // reached, which is the whole point: an operator previewing what the Supervisor would do
        // must not spend a cooldown, a proposal's TTL, or a cent finding out.
        const { world } = await loadSupervisorWorld(workspaceId, new Date())
        const situations = filterFresh(observe(world), world)
        const preview = situations.map((situation) => {
          const situationCandidates = candidates(situation, world)
          return { situation, candidates: situationCandidates, ruleChoice: chooseByRules(situationCandidates) }
        })
        process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`)
        return 0
      }

      const report = await supervise({
        workspaceId,
        decider: buildModelDecider(),
        // Same expression `daemon`'s case reads above (spec erratum E3): an operator's one-shot
        // pass thinks with the same model the daemon would, unless the environment says otherwise.
        model: process.env['SLAVEOFAI_SUPERVISOR_MODEL'] ?? SUPERVISOR_DEFAULT_MODEL,
      })
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return 0
    }

    case 'supervisor-decisions': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      const limitText = flagText(flags, 'limit')
      let limit: number | undefined
      if (limitText !== undefined) {
        limit = Number(limitText)
        if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer')
      }
      const decisions = await listDecisions(workspaceId, {
        ...('pending' in flags ? { pending: true } : {}),
        ...(limit !== undefined ? { limit } : {}),
      })
      process.stdout.write(`${JSON.stringify(decisions, null, 2)}\n`)
      return 0
    }

    case 'approve-decision': {
      // No `Principal`: the CLI has no session, and every verb here has always acted with none
      // (`Workspace.goalSetByUserId`'s own comment -- "the CLI and the orchestrator act with no
      // user"). `approveDecision`'s `principal?` is optional for exactly this caller (fix round 2)
      // -- the row's `resolvedByUserId` and the `supervisor.resolved` event's `userId` are honestly
      // null; the envelope actor is still `'human'`, because a human ran this command.
      const decisionId = requireFlag(flags, 'id')
      // `--body-file`, not a `--body` flag, and read UNTRIMMED -- `set-profile --file`'s rule for
      // the same reason (M39 §6): an answer is up to `ANSWER_MAX_CHARS` of prose that an operator
      // writes in an editor, and the newline that editor leaves at the end is their text, not
      // noise for this command to tidy away. Absent, the model's own draft is what goes out.
      const bodyFile = flagText(flags, 'body-file')
      const body = bodyFile === undefined ? undefined : readFileSync(bodyFile, 'utf8')
      const result = await approveDecision(decisionId, undefined, body === undefined ? undefined : { body })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(
        body === undefined
          ? `decision ${decisionId} approved\n`
          : `decision ${decisionId} approved with your own answer (${plural(body.length, 'character')})\n`,
      )
      return 0
    }

    case 'reject-decision': {
      // No `Principal`, same reasoning as `approve-decision` above.
      const decisionId = requireFlag(flags, 'id')
      const result = await rejectDecision(decisionId, undefined, flagText(flags, 'reason'))
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`decision ${decisionId} rejected\n`)
      return 0
    }

    case 'set-supervisor': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      // `'enable' in flags`, not `flagText(...) !== undefined`: same idiom as `set-model --clear`
      // above -- a bare `--enable`/`--disable` (no value following it) is exactly how `parseArgs`
      // records a flag with no argument, setting the key to `undefined` rather than leaving it
      // absent.
      const enableFlag = 'enable' in flags
      const disableFlag = 'disable' in flags
      if (enableFlag && disableFlag) throw new Error('--enable and --disable are exclusive')
      const profileFile = flagText(flags, 'profile-file')
      const clearProfile = 'clear-profile' in flags
      if (profileFile !== undefined && clearProfile) throw new Error('exactly one of --profile-file or --clear-profile is allowed, not both')
      if (!enableFlag && !disableFlag && profileFile === undefined && !clearProfile) {
        throw new Error('one of --enable, --disable, --profile-file or --clear-profile is required')
      }

      const result = await setSupervisorSettings(workspaceId, {
        ...(enableFlag ? { enabled: true } : {}),
        ...(disableFlag ? { enabled: false } : {}),
        ...(profileFile !== undefined ? { profile: readFileSync(profileFile, 'utf8') } : {}),
        ...(clearProfile ? { profile: null } : {}),
      })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`supervisor settings updated on ${workspaceId}\n`)
      return 0
    }

    case 'delete-slave': {
      const slaveId = requireFlag(flags, 'slave')
      // `'yes' in flags`, not `flags['yes'] !== undefined`: same reasoning as `set-model`'s
      // `--clear` above -- a bare `--yes` records `undefined` as its value, not the string `true`.
      if (!('yes' in flags)) {
        const slave = await prisma.slave.findUnique({ where: { id: slaveId }, select: { name: true } })
        const runs = await prisma.slaveRun.count({ where: { slaveId } })
        throw new Error(`refusing without --yes: this would delete slave ${slave?.name ?? slaveId} (${slaveId}) and ${plural(runs, 'run')}`)
      }
      const result = await deleteSlave(slaveId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`slave ${slaveId} deleted; ${plural(result.value.runs, 'run')} went with it\n`)
      return 0
    }

    case 'rename-team': {
      const teamId = requireFlag(flags, 'team')
      const name = requireFlag(flags, 'name')
      const result = await renameTeam(teamId, name)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`department ${teamId} renamed\n`)
      return 0
    }

    case 'delete-team': {
      const teamId = requireFlag(flags, 'team')
      if (!('yes' in flags)) {
        const team = await prisma.team.findUnique({ where: { id: teamId }, select: { name: true } })
        const slaves = await prisma.slave.count({ where: { teamId } })
        const runs = await prisma.slaveRun.count({ where: { slave: { teamId } } })
        throw new Error(`refusing without --yes: this would delete department ${team?.name ?? teamId} (${teamId}) and ${plural(slaves, 'slave')}, ${plural(runs, 'run')}`)
      }
      const result = await deleteTeam(teamId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`department ${teamId} deleted; ${plural(result.value.slaves, 'slave')} and ${plural(result.value.runs, 'run')} went with it\n`)
      return 0
    }

    // ---- M25 §3.3: departments -----------------------------------------------------------------
    case 'create-team': {
      const workspaceId = requireFlag(flags, 'workspace')
      const name = requireFlag(flags, 'name')
      const result = await createProjectTeam(workspaceId, name)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`department ${result.value.id} created in ${workspaceId}\n`)
      return 0
    }

    case 'move-slave': {
      const slaveId = requireFlag(flags, 'slave')
      const teamId = requireFlag(flags, 'team')
      const result = await moveSlave(slaveId, teamId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`slave ${slaveId} moved to department ${teamId}\n`)
      return 0
    }

    case 'move-company-slave': {
      const companySlaveId = requireFlag(flags, 'slave')
      const companyTeamId = requireFlag(flags, 'team')
      const result = await moveCompanySlave(companySlaveId, companyTeamId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`catalog slave ${companySlaveId} moved to department template ${companyTeamId}\n`)
      return 0
    }

    case 'rename-company-team': {
      const companyTeamId = requireFlag(flags, 'team')
      const name = requireFlag(flags, 'name')
      const result = await renameCompanyTeam(companyTeamId, name)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`department template ${companyTeamId} renamed\n`)
      return 0
    }

    case 'delete-company-team': {
      const companyTeamId = requireFlag(flags, 'team')
      if (!('yes' in flags)) {
        const team = await prisma.companyTeam.findUnique({ where: { id: companyTeamId }, select: { name: true } })
        const catalogSlaves = await prisma.companySlave.count({ where: { companyTeamId } })
        throw new Error(
          `refusing without --yes: this would delete department template ${team?.name ?? companyTeamId} (${companyTeamId}) and ${plural(catalogSlaves, 'catalog slave')}`,
        )
      }
      const result = await deleteCompanyTeam(companyTeamId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`department template ${companyTeamId} deleted; ${plural(result.value.catalogSlaves, 'catalog slave')} went with it\n`)
      return 0
    }

    case 'delete-company': {
      const companyId = requireFlag(flags, 'company')
      if (!('yes' in flags)) {
        const company = await prisma.company.findUnique({ where: { id: companyId }, select: { name: true } })
        const templates = await prisma.companyTeam.count({ where: { companyId } })
        const catalogSlaves = await prisma.companySlave.count({ where: { companyTeam: { companyId } } })
        throw new Error(
          `refusing without --yes: this would delete company ${company?.name ?? companyId} (${companyId}) and ${plural(templates, 'department template')}, ${plural(catalogSlaves, 'catalog slave')}`,
        )
      }
      const result = await deleteCompany(companyId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(
        `company ${companyId} deleted; ${plural(result.value.templates, 'department template')} and ${plural(result.value.catalogSlaves, 'catalog slave')} went with it, ${plural(result.value.projectsDetached, 'project')} detached\n`,
      )
      return 0
    }

    case 'delete-company-slave': {
      const companySlaveId = requireFlag(flags, 'slave')
      if (!('yes' in flags)) {
        const slave = await prisma.companySlave.findUnique({ where: { id: companySlaveId }, select: { name: true } })
        // Spec §5.2: every preview prints the footprint. This verb's footprint is what SURVIVES
        // rather than what goes -- `Slave.companySlaveId` is `SetNull`, so each project copy stays
        // and is simply unlinked -- and saying so is the whole point of the preview here: the
        // number an operator is deciding against is "how many working slaves does this touch".
        const copies = await prisma.slave.count({ where: { companySlaveId } })
        throw new Error(
          `refusing without --yes: this would delete catalog slave ${slave?.name ?? companySlaveId} (${companySlaveId}); ${copies === 1 ? '1 project copy stays' : `${copies} project copies stay`}`,
        )
      }
      const result = await deleteCompanySlave(companySlaveId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`catalog slave ${companySlaveId} deleted\n`)
      return 0
    }

    case 'delete-template': {
      const templateId = requireFlag(flags, 'template')
      if (!('yes' in flags)) {
        const template = await prisma.slaveTemplate.findUnique({ where: { id: templateId }, select: { name: true } })
        const catalogSlaves = await prisma.companySlave.count({ where: { templateId } })
        throw new Error(
          `refusing without --yes: this would delete template ${template?.name ?? templateId} (${templateId}) and ${plural(catalogSlaves, 'catalog slave')}`,
        )
      }
      const result = await deleteSlaveTemplate(templateId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`template ${templateId} deleted; ${plural(result.value.catalogSlaves, 'catalog slave')} went with it\n`)
      return 0
    }

    case 'create-simulation': {
      const companyId = requireFlag(flags, 'company')
      const name = requireFlag(flags, 'name')
      const policy = requireFlag(flags, 'policy')
      if (policy !== 'A' && policy !== 'B') throw new Error('--policy must be A or B')
      // M31b T4: no default -- every sector the platform knows is one the operator must name.
      const sector = requireFlag(flags, 'sector')
      const seedText = flagText(flags, 'seed')
      let seed: number | undefined
      if (seedText !== undefined) {
        seed = Number.parseInt(seedText, 10)
        if (!Number.isInteger(seed) || String(seed) !== seedText.trim()) throw new Error('--seed must be an integer')
      }
      // M31a §5: `--decision-provider llm` is a paid, capped run -- `createSimulation` itself
      // refuses a missing `--model-provider`/`--model`/`--max-model-cost-usd`, so the CLI passes
      // whatever was given straight through rather than re-validating it here.
      const decisionProviderText = flagText(flags, 'decision-provider')
      if (decisionProviderText !== undefined && decisionProviderText !== 'rules' && decisionProviderText !== 'llm') throw new Error('--decision-provider must be rules or llm')
      const decisionProvider = decisionProviderText as 'rules' | 'llm' | undefined
      const modelProviderText = flagText(flags, 'model-provider')
      if (modelProviderText !== undefined && modelProviderText !== 'claude_code' && modelProviderText !== 'cursor') throw new Error('--model-provider must be claude_code or cursor')
      const modelProvider = modelProviderText as 'claude_code' | 'cursor' | undefined
      const model = flagText(flags, 'model')
      const maxModelCostUsdText = flagText(flags, 'max-model-cost-usd')
      const maxModelCostUsd = maxModelCostUsdText !== undefined ? Number(maxModelCostUsdText) : undefined
      const result = await createSimulation({
        companyId, name, sector, policy,
        ...(seed !== undefined ? { seed } : {}),
        ...(decisionProvider !== undefined ? { decisionProvider } : {}),
        ...(modelProvider !== undefined ? { modelProvider } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(maxModelCostUsd !== undefined ? { maxModelCostUsd } : {}),
      })
      if (!result.ok) throw new Error(refusalText(result.error))
      const providerText = decisionProvider === 'llm' ? `llm provider · ${String(modelProvider)} · ${String(model)}, cap $${Number(maxModelCostUsd).toFixed(2)}` : 'rules provider'
      process.stdout.write(`simulation ${result.value.id} created (${sector}, policy ${policy}, ${providerText}, synthetic)\n`)
      return 0
    }

    case 'step-simulation': {
      const simulationId = requireFlag(flags, 'simulation')
      const steps = flagText(flags, 'steps')
      const untilDay = flagText(flags, 'until-day')
      const result = await stepSimulation(simulationId, { ...(steps !== undefined ? { steps: Number(steps) } : {}), ...(untilDay !== undefined ? { untilDay: Number(untilDay) } : {}) })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`simulation ${simulationId} at day ${result.value.day} (${result.value.status}), version ${result.value.version}, ${result.value.entries} journal ${result.value.entries === 1 ? 'entry' : 'entries'}\n`)
      return 0
    }

    case 'simulation-status': {
      const simulationId = requireFlag(flags, 'simulation')
      const snapshot = await simulationStatus(simulationId)
      if (!snapshot.ok) throw new Error(refusalText(snapshot.error))
      // M31a §5: the run's own cap alongside `modelUsage`'s `{ calls, spentUsd, unmeasured }` --
      // real spend against the cap without the caller cross-referencing `summary.maxModelCostUsd`
      // by hand. `capUsd` is the only field added; the three names are the reader's own (final
      // review, Minor #5 -- this used to print `costUsd` AND a `spentUsd` copy of it).
      const printed = { ...snapshot.value, modelUsage: { ...snapshot.value.modelUsage, capUsd: snapshot.value.summary.maxModelCostUsd } }
      process.stdout.write(`${JSON.stringify(printed, null, 2)}\n`)
      return 0
    }

    case 'compare-simulations': {
      const a = requireFlag(flags, 'a')
      const b = requireFlag(flags, 'b')
      const result = await compareSimulations(a, b)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`)
      return 0
    }

    case 'pause-simulation': {
      const simulationId = requireFlag(flags, 'simulation')
      const result = await pauseSimulation(simulationId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`simulation ${simulationId} paused\n`)
      return 0
    }

    case 'resume-simulation': {
      const simulationId = requireFlag(flags, 'simulation')
      const result = await resumeSimulation(simulationId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`simulation ${simulationId} resumed\n`)
      return 0
    }

    case 'halt-simulation': {
      const simulationId = requireFlag(flags, 'simulation')
      const reason = flagText(flags, 'reason') ?? 'operator'
      const result = await haltSimulation(simulationId, reason)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`simulation ${simulationId} halted: ${reason}\n`)
      return 0
    }

    case 'inject-simulation-event': {
      const simulationId = requireFlag(flags, 'simulation')
      const dayText = requireFlag(flags, 'day')
      const day = Number(dayText)
      if (!Number.isInteger(day)) throw new Error('--day must be an integer')
      const eventText = requireFlag(flags, 'event')
      let event: unknown
      try {
        event = JSON.parse(eventText)
      } catch {
        throw new Error('--event must be JSON')
      }
      const result = await injectExternalEvent(simulationId, { day, event })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`event injected into simulation ${simulationId} on day ${day}\n`)
      return 0
    }

    case 'clone-simulation': {
      const sourceId = requireFlag(flags, 'simulation')
      const name = requireFlag(flags, 'name')
      const policy = requireFlag(flags, 'policy')
      if (policy !== 'A' && policy !== 'B') throw new Error('--policy must be A or B')
      const seedText = flagText(flags, 'seed')
      let seed: number | undefined
      if (seedText !== undefined) {
        seed = Number.parseInt(seedText, 10)
        if (!Number.isInteger(seed) || String(seed) !== seedText.trim()) throw new Error('--seed must be an integer')
      }
      const result = await cloneSimulation(sourceId, { name, policy, ...(seed !== undefined ? { seed } : {}) })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`simulation ${result.value.id} created (cloned from ${sourceId}, policy ${policy})\n`)
      return 0
    }

    case 'adopt-simulation': {
      const simulationId = requireFlag(flags, 'simulation')
      const workspaceId = requireFlag(flags, 'workspace')
      const maxConcurrentText = flagText(flags, 'max-concurrent')
      const maxAttemptsText = flagText(flags, 'max-attempts')
      // Same idiom as `set-model --clear` (`'apply-model' in flags`, not `!== undefined`): a bare
      // `--apply-model` (no value following it) is exactly how `parseArgs` records a flag with no
      // argument, setting the key to `undefined` rather than leaving it absent.
      const applyModel = 'apply-model' in flags
      const result = await adoptSimulation(simulationId, {
        workspaceId,
        ...(maxConcurrentText !== undefined ? { maxConcurrentRuns: Number(maxConcurrentText) } : {}),
        ...(maxAttemptsText !== undefined ? { maxAttempts: Number(maxAttemptsText) } : {}),
        ...(applyModel ? { applyModel: true } : {}),
      })
      if (!result.ok) throw new Error(refusalText(result.error))
      // `adoptSimulation`'s own return carries the assign report but not the settings it actually
      // wrote (they may be the run's proposal or the operator's own override) -- read back off the
      // workspace row, the same one the drawer and the overview page read.
      const adopted = await prisma.workspace.findUniqueOrThrow({ where: { id: result.value.workspaceId }, select: { maxConcurrentRuns: true, maxAttempts: true, autoMerge: true } })
      process.stdout.write(
        `simulation ${simulationId} adopted into ${result.value.workspaceId}: ` +
          `${plural(result.value.assigned.createdTeams.length, 'department')}, ${plural(result.value.assigned.createdWorkers.length, 'worker')}; ` +
          `maxConcurrentRuns ${adopted.maxConcurrentRuns}, maxAttempts ${adopted.maxAttempts}, autoMerge ${adopted.autoMerge}\n`,
      )
      return 0
    }

    case 'auto-run-simulation': {
      const simulationId = requireFlag(flags, 'simulation')
      const everyMsText = flagText(flags, 'every-ms')
      const everyMs = everyMsText === undefined ? 1000 : Number(everyMsText)
      const untilDayText = flagText(flags, 'until-day')
      let untilDay: number
      if (untilDayText === undefined) {
        const loaded = await loadSimulation(simulationId)
        if (!loaded.ok) throw new Error(refusalText(loaded.error))
        untilDay = loaded.value.summary.horizonDays
      } else {
        untilDay = Number(untilDayText)
      }
      const result = await startAutoRun(simulationId, { everyMs, untilDay })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`simulation ${simulationId} auto-running every ${everyMs} ms to day ${untilDay}\n`)
      return 0
    }

    case 'stop-auto-run': {
      const simulationId = requireFlag(flags, 'simulation')
      const result = await stopAutoRun(simulationId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`simulation ${simulationId} auto-run stopped\n`)
      return 0
    }

    // ---- F3: local accounts (M23 §7) ------------------------------------------------------------
    // The password is always read from stdin (`readSecretLine`), never a `--password` flag -- see
    // `STDIN_PASSWORD_ERROR` above for why. `delete-user` takes the same `--yes` gate as
    // `delete-slave`/`delete-team`: the username IS the identifier here, so there is no separate
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
