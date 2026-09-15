import { randomBytes } from 'node:crypto'
import { accessSync, appendFileSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addCompanyTeam,
  addCredential,
  bindBrokerOp,
  adoptSimulation,
  answerQuestion,
  approveDecision,
  addCapability,
  addMemory,
  addRunbook,
  adoptRunbook,
  archiveWorkspace,
  backfillSlaveCapabilities,
  cancelTask,
  clearHalt,
  clearSlavePermission,
  clearStaffingPreference,
  assignCompany,
  assignPerson,
  createPerson,
  deletePerson,
  joinDepartment,
  leaveDepartment,
  listDepartmentMembers,
  movePerson,
  personEffectiveSkills,
  personFootprint,
  setPersonSkills,
  unassignPerson,
  CREDENTIAL_KINDS,
  CREDENTIAL_KIND_LABEL,
  claimResume,
  cloneSimulation,
  compareSimulations,
  condenseWorkspaceMemories,
  confirmIntegration,
  createCompany,
  createProjectTeam,
  createSimulation,
  createTemplate,
  createUser,
  createWorkspace,
  deleteCompany,
  deleteCompanyTeam,
  deleteSlaveTemplate,
  deleteTeam,
  deleteUser,
  emergencyStop,
  EXTERNAL_IGNORED_REASON_LABEL,
  haltSimulation,
  hireFromTemplate,
  importCatalog,
  INBOUND_EVENT_STATUS_LABEL,
  injectExternalEvent,
  isProviderKind,
  LIST_INBOUND_LIMIT,
  listBrokerBindings,
  listCatalogImports,
  listCapabilities,
  listCredentials,
  listEvidence,
  listExternalRepositories,
  listInboundEvents,
  listDecisions,
  listMemories,
  listGoalVersions,
  listPendingQuestions,
  listRunbooks,
  listStaffingPreferences,
  listTemplateDuplicates,
  listUsers,
  listWorkforceCatalog,
  loadSimulation,
  loadSupervisorWorld,
  mapExternalRepository,
  pauseSimulation,
  reassignQuestion,
  readMemory,
  readRunbook,
  readTemplateProfile,
  recomputeTemplateDuplicates,
  refusalText,
  rejectDecision,
  releasePerson,
  removeMemory,
  renameSlave,
  renameCompanyTeam,
  renameTeam,
  requestChange,
  requestPause,
  requestStop,
  restoreWorkspace,
  resumeSimulation,
  runbookStatus,
  setProfile,
  setRuntimeRoles,
  setSlavePermission,
  setStaffingPreference,
  setTemplateActivation,
  setTemplateDuplicateDismissal,
  setPersonCapabilities,
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
  syncCapabilityTaxonomy,
  setLifecycle,
  syncRunbooks,
  supersedeMemory,
  syncSkillCatalog,
  TEMPLATE_PICKER_MAX,
  tickSimulations,
  plural,
  unblockTask,
  unmapExternalRepository,
  verifyMemory,
  type ControlRefusal,
  type CredentialKind,
  type ImportReport,
  type ModelDecider,
  type Principal,
  type ProfileTarget,
} from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  BROKERED_OPERATIONS,
  BROKER_CLIENT_TIMEOUT_MS,
  BROKER_OP_LABEL,
  COST_PROVENANCE_WORD,
  DUPLICATE_BASIS_LABEL,
  DUPLICATE_CLASSES,
  DUPLICATE_CLASS_LABEL,
  DUPLICATE_FACETS,
  EVIDENCE_OUTCOME_LABEL,
  EXTERNAL_KIND_LABEL,
  EXTERNAL_SOURCES,
  EXTERNAL_SOURCE_LABEL,
  MEMORY_SCOPE_LABEL,
  MEMORY_STATUSES,
  MEMORY_STATUS_LABEL,
  MEMORY_TYPES,
  MEMORY_TYPE_LABEL,
  MODEL_NOT_RECORDED_LABEL,
  PERMISSION_LABEL,
  PERMISSION_RUN_KINDS,
  PROVIDER_KINDS,
  SLAVE_LIFECYCLES,
  SLAVE_LIFECYCLE_LABEL,
  SUPERVISOR_DEFAULT_MODEL,
  BREAKER_LEVEL_LABEL,
  BREAKER_TRIP_LABEL,
  candidates,
  chooseByRules,
  displayName,
  domainLabel,
  filterFresh,
  grantsFor,
  manifestFor,
  observe,
  provenanceLine,
  runContextManifestSchema,
  stageOrder,
  userPersonStatus,
  workspaceId as brandWorkspaceId,
  type BrokerOp,
  type BreakerTripKind,
  type DuplicateClass,
  type DuplicateFacet,
  type ExternalSource,
  type MemoryStatus,
  type MemoryType,
  type PermissionKind,
  type PermissionRunKind,
  type WorkspaceId,
} from '@slave-of-ai/domain'
import { sectors } from '@slave-of-ai/simulation'
import {
  DEFAULT_MODEL_TIMEOUT_MS,
  brokerReplyPathFor,
  buildRegistry,
  decideWithModel,
  type AdapterRegistry,
  type ProviderKind,
  type ProviderWiring,
} from '@slave-of-ai/providers'
import { REQUEST_LINE_MAX_BYTES, brokerReplySchema, isBrokerRefusalReason, type BrokerReplyRead } from './broker.js'
import { readCatalogDirectory } from './catalog.js'
import { runDaemon } from './daemon.js'
import { PLANNING_RETRY_CAP } from './planning.js'
import { replanVerdict } from './replan.js'
import { renderReplanPreview } from './runContext.js'
import { deliverAnswers } from './deliver.js'
import { claudeCommandFrom } from './claude-command.js'
import { fakeCliRefusal } from './require-fake-cli.js'
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
  breaker --run <id>                   print the run's breaker level, trips, steers, tool-call cap
                                       and its last trip. READ-ONLY: there is no steer or constrain
                                       verb -- the ladder is the system's, and a person who wants to
                                       intervene has pause, stop and the resume message box.
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
  request-change --workspace <id> --request "<text>"
                                       tell the Supervisor what changed. The request AMENDS the
                                       standing goal -- the document keeps its body and gains a
                                       dated entry under "Requested changes" -- and that amendment
                                       is a new VERSION, which is what makes the next tick re-plan
                                       it as a delta. The words themselves are kept on the version
                                       and on its event, so the project's timeline can show what
                                       was asked and not only what it produced. Prints the version,
                                       its sha256 and the composed goal. Nothing is hired, started
                                       or cancelled here: a re-plan's additions become tasks and
                                       its cancellations become proposals you approve.
  goal-history --workspace <id>        every version of this project's goal, newest first, as JSON:
                                       the text, its sha256, who set it, when, and the line-level
                                       diff against the version it replaced (null for v1).
  replan-status --workspace <id> [--prompt]
                                       why the next tick will, or will not, start a delta re-plan:
                                       the goal version,
                                       the highest version stamped on any task, terminal ones included,
                                       whether this version was already re-planned,
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
  import-catalog --dir <path> [--catalog <n>] [--division <d>[,<d>]]
                 [--role-map <division>=<role>,...] [--by <name>]
                 [--activate] [--verbose] [--allow-unknown-license] [--dry-run]
                                       import a directory of persona files into the template
                                       catalog. Re-runnable: an unchanged file is left alone, a
                                       changed one updates the template it created, and a profile a
                                       person has edited since is never overwritten. --catalog
                                       defaults to the directory's own name; --role-map translates a
                                       division into the role the template is created with, and only
                                       matters the first time a persona is imported. A name this
                                       catalog does not have -- in --division or in --role-map --
                                       gets a WARNING on stderr, not a refusal: every division that
                                       does exist is still imported. --dry-run decides everything
                                       and writes nothing -- write it LAST in the command, a flag
                                       after it would be swallowed as its value. NOTHING IMPORTED IS
                                       HIRABLE until somebody says so: every row arrives inactive,
                                       and --activate is that somebody saying so for this run.
                                       --verbose prints one line per row AS WELL AS the counts: the
                                       counts, the three duplicate numbers and the skips print
                                       either way, and it only adds the rows below them.
                                       --allow-unknown-license imports a checkout with no LICENSE
                                       file at its root, which is otherwise refused, because nothing
                                       could record where those personas came from.
  list-imports [--limit <n>]           the last catalog imports, newest first by the timestamp the
                                       line shows, with their four outcome counts and the three
                                       duplicate counts that import noticed. --limit defaults to 10
                                       and must be a positive integer
  create-template --name <n> --role <r> [--model <m> --provider <p>] [--description <d>]
                                       add a reusable slave template to the catalog. --model and
                                       --provider are a pair: give both or neither.
  create-company --name <n>            add a company (a persistent roster) to the catalog
  add-team --company <id> --name <n>   add a department template to a company's roster
  add-slave --team <companyTeamId> --template <id> --name <name> [--model <m> --provider <p>]
                                       create a person and put them in a department template, with
                                       no project. The roster row it used to create does not exist
                                       any more; this is a pooled person who is a member of a
                                       department.
  person create [--template <id>] [--name <name>] [--profile <text>] [--model <m> --provider <p>]
                [--capabilities a,b] [--department <companyTeamId>] [--project <teamId>]
  person list [--pool] [--released] [--department <companyTeamId>]
  person show --person <id>
  person assign --person <id> --team <teamId> [--role <title>] [--roles a,b]
  person unassign --person <id> --team <teamId> --reason <text>
  person move --person <id> --from <teamId> --to <teamId>
  person release --person <id> --reason <text>
  person delete --person <id> [--yes]
  person skills --person <id> [--grant a,b] [--revoke c] [--clear d]
  assign-company --workspace <id> --company <id>
                                       assign a company's roster to a workspace, seating each
                                       member on the project rather than copying them
  set-model --slave <workerId> | --person <id> --model <m> --provider <p>
  set-model --slave <workerId> | --person <id> --clear
                                       set or clear a model+provider override at the seat (--slave)
                                       or at the slave (--person). A model only means something
                                       inside the provider that runs it, so --model requires
                                       --provider.
  rename-slave --slave <id> --name <n> rename a project slave
  set-role --slave <id> --role <r>     change a project slave's TITLE -- the heading of its
                                       persona, not what it is dispatched as. Refused while the
                                       slave holds a live run.
  set-profile --slave <id> | --template <id> | --person <id>
              (--file <path> | --clear) [--by <name>]
                                       set (or clear) the persona Markdown at one level of the
                                       override chain: the seat, the slave, or the template. First
                                       non-null wins at dispatch. Prints which level it wrote.
                                       Read from a file, not a flag -- it can be 16k characters.
                                       --by names the operator on the event.
  show-profile --template <id> [--markdown]
                                       the specialist profile this template carries: the upstream
                                       structure an import mapped, the fields an operator has
                                       customised and the merge of the two, as JSON. --markdown
                                       prints the profile text a run is actually given instead.
  set-runtime-roles --slave <id> --roles a,b,c [--by <name>]
                                       replace the roles this slave may be DISPATCHED as -- the
                                       scheduler's match, reviewer/manager staffing, and message
                                       role-addressing all read this set. --roles '' parks the
                                       slave: it can be dispatched as nothing until it holds a
                                       role again.
  show-context --run <id> [--prompt]   what this run was told: the manifest of the sections its
                                       prompt was assembled from, and with --prompt the prompt
                                       itself after a rule

  capabilities sync                    reconcile the capability taxonomy against the checked-in
                                       list: adds what is missing, brings a seed row back to what
                                       the list says, and never touches a row an operator added.
  capabilities add --key <domain.name> --label <text> --role <r> [--synonyms a,b]
                                       add an operator's own capability. The key's prefix IS its
                                       domain, and --role is the runtime role it projects to.
  capabilities list                    every capability: key, label and the role it projects to.
  capabilities backfill [--workspace <id>]
                                       fill in what every worker created BEFORE capabilities
                                       existed provides, off the template it was already hired or
                                       materialised from, and add the runtime roles those project
                                       to. Only workers whose own capability set is empty; never
                                       one an operator has described by hand. Run once per project.
  template list [--division <d>] [--active | --inactive] [--duplicates <exact|near|overlapping|none>]
                                       every template, with whether it is hirable and the strongest
                                       duplicate signal beside it. Nothing an import created is
                                       hirable until \`template activate\` says so.
  template activate --template <id>    make one template a hiring candidate: the Supervisor may
  template deactivate --template <id>  propose it, and stops proposing it again. A worker already
                                       hired from it keeps working either way, and \`add-slave
                                       --template\` works on an inactive row -- naming a specific row
                                       by hand is the same deliberate act as activating it.
  template duplicates [--template <id>] [--class <exact|near|overlapping>] [--dismissed]
                      [--recompute] [--dismiss <pairId>] [--restore <pairId>]
                                       which catalog rows look like which. --recompute re-classifies
                                       the WHOLE table and is also the backfill for a catalog
                                       imported before this feature existed AND the repair after an
                                       import that was interrupted before it paired its rows; it may
                                       retire a pair that no longer looks alike. --dismiss says "I
                                       know" about one pair and keeps the row; --restore takes that
                                       back. The list says \`N of M pair(s)\` and stops at two
                                       hundred: narrow it with --template or --class to reach the
                                       rest. Nothing here ever deletes a template: that is
                                       \`delete-template\`, and it asks twice.
  runbooks sync                        reconcile the runbook table against the checked-in list:
                                       adds what is missing, brings a seed row back to what the
                                       list says, and never touches a persona or human row.
  runbooks list                        every runbook: key, name, stage count, where it came from,
                                       and how many projects follow it.
  runbooks show <key>                  one runbook's stages in order, with the capabilities, gates,
                                       retry and escalation of each.
  runbooks add --file <path.json>      write your own runbook from one JSON object. Its source is
                                       always human, so a sync can never rewrite it.
  memories list [--workspace <id>] [--status <s>] [--type <t>] [--task <id>] [--q <text>]
                                       what this organisation knows, and who says so: id, type,
                                       status, title and where it came from.
  memories show <id>                   one memory in full, with what it replaced, what replaced it
                                       and anything it summarises.
  memories add --workspace <id> --type <t> --title <t> --body <b> [--capabilities a,b]
                                       write one down yourself. It is verified the moment you do,
                                       because a person said it.
  memories verify <id> [--workspace <id>]
                                       a worker's unverified report becomes knowledge a run is
                                       given.
  memories supersede <id> --title <t> --body <b> [--workspace <id>]
                                       correct one: the old row is kept and pointed at the new.
  memories remove <id> --reason <why> [--workspace <id>]
                                       withdraw one. Nothing is deleted; the reason is stored.
                                       --workspace on these three names the project the move is
                                       filed under on the timeline, for a memory that belongs to a
                                       worker or a company rather than to a project.
  memories condense --workspace <id> [--type <t>]
                                       twenty verified memories of one kind become one summary that
                                       links every one of them. Nothing is replaced, and running it
                                       twice writes nothing the second time.
  adopt-runbook --workspace <id> --runbook <key>
                                       the project follows this runbook. The next planning run is
                                       asked to adapt it; nothing re-plans by itself.
  adopt-runbook --workspace <id> --clear
                                       the project follows no runbook. Tasks keep the stage they
                                       were planned with.
  runbook-status --workspace <id>      where this project is in its runbook: the current stage, and
                                       each stage's state -- done, active, pending or missing from
                                       the plan.
  set-capabilities --person <id> | --slave <id> --capabilities a,b [--by <name>]
                                       what the slave PROVIDES -- a fact about the person, so it
                                       holds on every project they sit on. --slave is accepted and
                                       resolved, with a line saying so. Keys, labels and synonyms
                                       are all accepted and resolved to keys; a word matching
                                       nothing is reported on stderr and not stored. The
                                       capabilities replace; the runtime roles they project to are
                                       ADDED, never removed -- use set-runtime-roles to take a role
                                       away. --capabilities '' clears them.
  hire --workspace <id> --template <id> --why <text> [--capability <key>]
       [--temporary --for-task <taskId>]
                                       put a specialist from the catalog on this project, carrying
                                       its template's capabilities and the roles those project to.
                                       Re-running for the same template REUSES the worker already
                                       hired from it rather than hiring a second -- unless that
                                       worker has been released, which is never reused. --why is
                                       required: it is the record of why this worker is here.
                                       --temporary hires for ONE assignment and needs --for-task:
                                       the worker is ephemeral, and release-worker ends it.
  release-worker --slave <id> --reason <text>
                                       end the person behind the seat: every open seat closes,
                                       the release is stamped, runtime roles empty so nothing
                                       dispatches them again, and finished tasks' worktrees are
                                       collected. Nothing is deleted -- every run, message and
                                       thing they learnt stays exactly where it is. Refused for
                                       a person already released, one with a live run, and one
                                       that is gone.
  set-lifecycle --person <id> | --slave <id> --lifecycle <permanent|project|ephemeral>
                                       move a slave between lifecycles by hand. --slave is accepted
                                       and resolved, with a line saying so. Nothing else ever does:
                                       a worker is never promoted automatically. Leaving ephemeral
                                       clears the engagement and the release with it, and restores
                                       no runtime roles -- use set-runtime-roles for that.
                                       permanent is refused for a worker on no company roster.

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

  delete-slave --slave <id> [--yes]    delete the PERSON sitting in this seat, and every other
                                       project they are on. Omit --yes to see how many projects
                                       would go. person delete is the same act by person id.
  move-company-slave --slave <personId> --team <companyTeamId>
                                       leave this company's other departments and join this one
  delete-company-slave --slave <personId> --team <companyTeamId>
                                       remove them from the department; they keep every project
                                       they are on
  rename-team --team <id> --name <n>   rename a project department
  delete-team --team <id> --yes        remove a department WITH its slaves and their run
                                       history -- refused only while any of its slaves holds a
                                       live run. Omit --yes to see what would be deleted without
                                       doing it.
  create-team --workspace <id> --name <n>
                                       add a department to a project (no template link)
  move-slave --slave <id> --team <id>  move a project slave to another department of the same
                                       project -- refused while the slave holds a live run
  rename-company-team --team <companyTeamId> --name <n>
                                       rename a department template
  delete-company-team --team <companyTeamId> --yes
                                       remove a department template WITH its catalog slaves;
                                       project departments copied from it keep living. Omit --yes
                                       to see what would be deleted without doing it.
  delete-company --company <id> --yes  remove a company with its department templates and their
                                       memberships; every slave who was a member keeps working, and
                                       projects keep their seats. Omit --yes to preview.
  delete-template --template <id> --yes
                                       remove a slave template; every slave hired from it keeps
                                       working and simply stops naming a persona
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

  permissions and the broker (M52)
  permission list --slave <id> [--run-kind implementation|review|planning]
                                       all six operations for one worker: the word, the key, the
                                       stored decision, where the effective answer came from
                                       (baseline / granted / refused / never) and who decided.
                                       The run kind is a flag because the BASELINE is: the same
                                       worker reads baseline for run_commands on an implementation
                                       run and never on a planning one.
  permission grant|deny --slave <id> --kind <k> [--by <username>]
                                       decide one operation for one worker. --by must name a real
                                       account: it is recorded on the row and on the event.
  permission revoke --slave <id> --kind <k> [--by <username>]
                                       take the decision back -- the row is DELETED and the kind
                                       returns to "nobody has ever been asked", which is not the
                                       same as deny.
  credential add --name <n> --kind deploy_token|git_token|api_key --env-var <VAR> [--workspace <id>]
                                       register a secret's NAME and the environment variable the
                                       orchestrator reads it from at execution time. The value is
                                       never stored, never printed and never asked for -- and this
                                       verb does not tell you whether the variable is set.
  credential list [--workspace <id>]   name, kind, variable name, when it was registered
  broker bind --op <op> --command <argv> [--command <argv> ...] [--credential <n>] [--workspace <id>]
                                       say what one brokered operation RUNS here. --command is
                                       repeated once per argv element, so a path with a space in
                                       it stays one argument. One binding per operation: this
                                       rebinds in place.
  broker list [--workspace <id>]       every bound operation, its command and the variable its
                                       credential names
  broker run <op> [--<parameter> <value> ...]
                                       THE WORKER'S OWN verb, and the only one here that touches
                                       no database: it appends one line to its run's broker
                                       channel and waits for the reply beside it. It only works
                                       inside a run the orchestrator started, and it exits with
                                       the operation's own exit code.

  the record, and who is asked for (M53)
  evidence list [--workspace <id>] [--domain <d>]
                                       every concluded run as one line: the profile's name and its
                                       key, the model it ran on, the domains its task asked for,
                                       what happened, which attempt it was, where the money figure
                                       came from, and when the fact was written. READ ONLY -- there
                                       is no evidence record and no evidence delete: the pipeline is
                                       the only writer and a row is never deleted. --workspace
                                       narrows to one project and omitting it is every project,
                                       because a profile works on more than one; --domain narrows by
                                       containment, so a run whose task asked for two domains shows
                                       under either. THE MOST RECENT 200 rows, newest first: a line
                                       per run is a page of history and not a window on all of it.
                                       History from before this milestone -- and any run whose fact
                                       a crash lost between its conclusion and its write -- is
                                       filled in by npm run backfill:evidence, never from here; that
                                       script is idempotent, safe on a live database, and judges
                                       nothing it records.
  staffing prefer --capability <key> [--template <id>] [--model <m>] [--workspace <id>] [--by <username>]
                                       say who -- or what model -- should take one capability on
                                       this project. Name a profile, a model, or both; naming
                                       neither is refused. One decision per capability per project:
                                       this replaces in place. ADVISORY -- the ranker reads it at
                                       step 3 of seven, so it never beats a permission a person
                                       refused (step 2) and it carries no weight for a worker who is
                                       busy (step 4). --by must name a real account.
  staffing clear --capability <key> [--workspace <id>] [--by <username>]
                                       take the decision back. Clearing a decision nobody took
                                       succeeds and records nothing.
  staffing list [--workspace <id>]     every decision on this project: the capability's label and
                                       its key, the profile, the model, when it was taken and who
                                       took it.

  what may tell this installation something (M54)
  triggers map --workspace <id> --source github --repository <owner/repo> --secret-env <VAR>
                                       connect one external repository to one project. Prints the
                                       path to paste into the provider and the NAME of the
                                       environment variable the WEB process reads the signing
                                       secret from at verification time. The value is never stored,
                                       never printed and never asked for -- and this verb does not
                                       tell you whether the variable is set, does not create the
                                       webhook at the provider, and sends nothing outbound. One
                                       project per repository: a repository something already maps
                                       is refused, and unmap is how a variable changes.
  triggers unmap --source github --repository <owner/repo> [--workspace <id>]
                                       disconnect it. THE OFF SWITCH -- there is no per-hook
                                       disable flag, because two ways to stop a hook is one more
                                       than a person can remember. Every delivery it already made
                                       stays recorded.
  triggers list [--workspace <id>]     every mapping: the project, the source and its key, the
                                       repository, the variable NAME, the path, and when it was
                                       made. --workspace narrows; omitting it is every project.
  triggers inbound [--workspace <id>]  every delivery, newest first: when, WHICH PROJECT it reached
                                       (a dash when it reached none), from where, what kind, what
                                       became of it, why nothing happened if nothing did, which
                                       goal version it produced if it produced one, and the
                                       provider's own delivery id. THE MOST RECENT
                                       ${String(LIST_INBOUND_LIMIT)}. This is the only surface that shows a delivery
                                       id -- no page does.

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

/**
 * Flags that repeat: every occurrence is collected, in order, rather than the usual last-wins.
 *
 * `command` joins the two workspace command lists (M52 R3) and is the one whose repetitions are not
 * separate commands but the ARGV OF ONE: `broker bind --command /opt/deploy.sh --command --now`
 * binds `['/opt/deploy.sh', '--now']`. Spelled one element per flag rather than as a single string
 * this file would have to split, because splitting is where a path with a space in it becomes two
 * arguments -- and a binding is the operator's own command line, not a guess about it.
 */
const REPEATABLE: ReadonlySet<string> = new Set(['verify', 'setup', 'command'])

/**
 * Flags that carry no value at all, so they may be written ANYWHERE in the command (M50 t3, widened
 * by M55 plan erratum E3).
 *
 * The parser below takes whatever follows a flag as its value, even another `--flag`, and then
 * CONSUMES it -- which is why every boolean this CLI had before M50 (`--yes`, `--dry-run`,
 * `--prompt`, `--markdown`, `--clear`) is documented as going LAST. That rule holds for ONE bare
 * flag per command and no more: `--temporary` is meaningless without `--for-task`, the two are read
 * as one phrase, and `hire ... --temporary --for-task <id>` would otherwise swallow the task id
 * entirely. M55 puts three more on `import-catalog`, two on `template list` and two on `template
 * duplicates`, so the same trap is now seven flags wide, and listing them here is the honest fix --
 * which is E3's own rule: every bare flag this milestone adds joins this set.
 *
 * The five older booleans keep their documented rule, because moving a rule for a flag nobody is
 * changing is a rename dressed as a fix -- so `--dry-run` is still written LAST, which is why
 * `gate:m42-catalog-import`'s dry run reads `--allow-unknown-license --dry-run` and not the other
 * way round.
 */
const VALUELESS: ReadonlySet<string> = new Set([
  'temporary',
  'activate',
  'verbose',
  'allow-unknown-license',
  'recompute',
  'active',
  'inactive',
  'dismissed',
])

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

    if (VALUELESS.has(token.slice(2))) {
      flags[token.slice(2)] = undefined
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
 * The PostToolUse tap (M51 R6), sourced exactly the way {@link hookPath} above sources the pause
 * gate -- derived from this file's own location so a checkout works with no configuration, and
 * overridable because an installed daemon's layout is not this one.
 *
 * **A tap that cannot be used is a WARNING, never a refusal to start.** This is the ruling the
 * spike's own measurement earns: the tap fills a gap only in a DEGRADED Claude stream, and
 * `reportsToolResults` is `true` for both providers on the stream alone, so the breaker works
 * without it. The pause gate is the opposite -- `preflightGate` fails the spawn, because a slave
 * running with no gate cannot be stopped -- and treating the two the same way would let a lost exec
 * bit on an optional script stop a whole fleet. So a missing or non-executable tap is reported once,
 * here, and `tapPath` is simply not wired: the deployment then runs exactly as it did before M51,
 * which is the honest null outcome R6 explicitly allows for.
 *
 * `SLAVEOFAI_TAP_PATH=''` disables it outright, for a deployment that does not want the hook at all.
 */
function tapPath(): string | undefined {
  const fromEnv = process.env['SLAVEOFAI_TAP_PATH']
  if (fromEnv === '') return undefined
  const path =
    fromEnv === undefined
      ? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'tool-result-tap.sh')
      : resolve(fromEnv)
  try {
    // The cheap half of a pre-flight, and the half that can run inside a synchronous registry
    // builder: is there an executable script there at all. The adapter runs the REAL one
    // (`preflightTap`, which spawns it with a synthetic payload) on every spawn.
    accessSync(path, constants.X_OK)
    return path
  } catch {
    console.warn(
      `[orchestrator] no usable tool-result tap at ${path}; tool results will come from the stream ` +
        'alone (this is not fatal -- both providers report them)',
    )
    return undefined
  }
}

/**
 * The CLI a worker's thin broker client runs (M52 erratum E6).
 *
 * THIS FILE: `import.meta.url` is `dist/cli.js`, which is precisely the entry `node` must be given
 * -- there is no `orchestrator` binary on anybody's PATH, and `package.json`'s `orchestrator` script
 * is an npm alias for this same path. Overridable for {@link hookPath}'s reason: an installed
 * daemon's layout is not this one.
 *
 * A fact about the RUNTIME and never a per-run input, which is why it is read here and passed to
 * the registry once (M52 Task 2's carried C3): it becomes every child's `SLAVEOFAI_BROKER_CLI`, and
 * a value that could differ between two runs of the same daemon would mean two workers on one host
 * talking to two different orchestrators.
 */
function brokerCliPath(): string {
  const fromEnv = process.env['SLAVEOFAI_BROKER_CLI']
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv)
  return fileURLToPath(import.meta.url)
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
 *
 * M56a R6: a LOOP over `PROVIDER_KINDS`, not one option block per vendor. Each kind's command comes
 * from its own manifest's `binEnvVar` (falling back to the binary it names), its extra argv from
 * `argsEnvVar`, and every kind is handed the SAME four script paths -- so the
 * `SLAVEOFAI_<PROVIDER>_BIN` convention is declared once, in the manifest, instead of being spelled
 * at four sites in three files. Both kinds stay configured unconditionally, for the reason above.
 *
 * EXPORTED (M56a §3 stage 5): the gate builds this registry in a process with both bin variables
 * set and asserts both kinds resolve to adapters whose `kind` fields are the two `ProviderKind`
 * members. Importing this module runs nothing -- `main()` is guarded by the `argv[1]` check at the
 * bottom of this file, which exists for exactly that reason.
 */
export function buildAdapterRegistry(): AdapterRegistry {
  // The refusal `claudeCommandFrom` used to raise on the way past. Asked ONCE here, because it is
  // about every registered binary now and not only the one this loop happens to read first
  // (M56a R10) -- and asked BEFORE anything is constructed, so a mis-armed process refuses to start
  // rather than refusing at its first dispatch.
  const refusal = fakeCliRefusal(process.env)
  if (refusal !== null) throw new Error(refusal)

  const tap = tapPath()
  const scripts = {
    // M12 Task 2: the hook path is a fact about the adapter instance, not a per-run input -- it used
    // to be threaded through `TickDeps`/`DaemonDeps` and into every `adapter.start()` call.
    hookPath: hookPath(),
    gatePath: cursorGatePath(),
    // M52 erratum E6 / Task 2's carried C3: the ONE place `brokerCliPath` is set, for both runtimes,
    // from the same reading -- a worker's broker client is the orchestrator's own CLI whichever
    // vendor is driving.
    brokerCliPath: brokerCliPath(),
    // M51 R6: a conditional spread because `exactOptionalPropertyTypes` treats an explicit
    // `undefined` as a different (and disallowed) thing from the key being absent -- and an absent
    // `tapPath` is exactly what "run as we did before M51" means to the adapter.
    ...(tap === undefined ? {} : { tapPath: tap }),
  }

  const wiring: Partial<Record<ProviderKind, ProviderWiring>> = {}
  for (const kind of PROVIDER_KINDS) {
    const { binEnvVar, argsEnvVar, binary } = manifestFor(kind).invocation
    const extra = process.env[argsEnvVar]
    wiring[kind] = {
      command: process.env[binEnvVar] ?? binary,
      ...(extra === undefined || extra === '' ? {} : { extraArgs: extra.split(' ') }),
      scripts,
    }
  }
  return buildRegistry(wiring)
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

/** M58 R11: the verbs an operator already types name a SEAT (`--slave <slaveId>`); every one of
 *  them is about the person sitting in it. One resolver, so no verb invents its own. */
async function personOfSeat(slaveId: string): Promise<{ readonly personId: string; readonly name: string }> {
  const seat = await prisma.slave.findUnique({
    where: { id: slaveId },
    select: { person: { select: { id: true, name: true } } },
  })
  if (seat === null) throw new Error(refusalText({ kind: 'slave_not_found', slaveId }))
  return { personId: seat.person.id, name: seat.person.name }
}

/**
 * The project a verb that takes an ID rather than a project should FILE ITS EVENT in, or null
 * (M49, final review Important 2).
 *
 * `memories verify|supersede|remove` address one memory by id, and a worker's lesson or a company's
 * fact has no project of its own -- so without a project named here the move reaches no timeline at
 * all. `--workspace` when the operator typed one, the single project when there is only one, and
 * NULL rather than a throw when there are several: these three verbs have never needed a project to
 * do their work, and refusing to withdraw a memory because the machine holds two projects would be
 * a new refusal in exchange for an event.
 */
async function eventWorkspace(flags: Flags): Promise<string | null> {
  const given = flagText(flags, 'workspace')
  if (given !== undefined) return given
  const all = await prisma.workspace.findMany({ where: { archivedAt: null }, select: { id: true } })
  return all.length === 1 && all[0] !== undefined ? all[0].id : null
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

/**
 * `--by`, with a blank value treated as no value (M42 t1 fix round 1).
 *
 * `parseArgs` records `--by ""` as the empty string, not as absent, so `?? 'operator'` let it
 * straight through to verbs that put it on an event payload -- where the schemas require a
 * non-empty name (`slave.message_sent.answeredBy`, `slave.message_reassigned.actor`). The throw
 * landed on `appendEvent`, AFTER the row the verb had already written: a non-zero exit over work
 * that had actually succeeded. An operator who typed nothing meaningful named nobody, which is
 * exactly what omitting the flag means.
 *
 * A name that is not blank is passed through byte for byte -- this trims only to decide, never to
 * rewrite what somebody deliberately typed.
 */
function operatorName(flags: Flags): string {
  const given = flagText(flags, 'by')
  return given === undefined || given.trim() === '' ? 'operator' : given
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
 * A flag whose value must be one of a closed list (M49 R4), or `undefined` when it was not given.
 *
 * A bare cast would hand Postgres a word that is not an enum member and answer an operator with a
 * Prisma stack trace; this answers with the list. The vocabularies are the domain's own arrays, so
 * a seventh memory type is offered here the moment it exists.
 */
function oneOfFlag<T extends string>(flags: Flags, name: string, allowed: readonly T[]): T | undefined {
  const value = flagText(flags, name)
  if (value === undefined) return undefined
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`--${name} must be one of ${allowed.join(', ')}`)
  }
  return value as T
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

/**
 * `--by <username>` as a {@link Principal}, or nothing at all.
 *
 * RESOLVED TO A ROW, never passed through as a name (M52 Task 3's trap R2). `Principal.userId` is a
 * foreign key: `setSlavePermission` puts it on `SlavePermission.grantedBy` and hands it to
 * `appendEvent`, where `ExecutionEvent.userId` references `User`. A name that is not an account
 * would write the row and then throw on the append -- a non-zero exit over work that had already
 * happened, which is the failure `operatorName` was written for in the other direction.
 *
 * Omitting `--by` is not an error: the CLI has always been allowed to act with no user
 * (`approve-decision`'s own comment), and the row then records no author.
 */
async function resolvePrincipal(flags: Flags): Promise<Principal | undefined> {
  const username = flagText(flags, 'by')
  if (username === undefined || username.trim() === '') return undefined
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true } })
  if (user === null) throw new Error(refusalText({ kind: 'user_not_found', username }))
  return { userId: user.id }
}

/**
 * What `triggers map` says about a refusal, which for ONE kind is not what `refusalText` says
 * (M54 R12, Task 2 hand-off).
 *
 * `external_repository_mapped` is the only refusal in this file whose sentence is composed here.
 * The kind CARRIES the id of the project that already holds the repository and `refusalText`
 * deliberately prints "a project" instead of it: a raw id is never visible text (M52 erratum E18),
 * and control has no boundary to resolve one at. THIS is that boundary -- the same one `staffing
 * list` crosses for a username -- and an operator who is told WHICH project holds the mapping can
 * act on the sentence instead of going looking.
 *
 * A project deleted between the refusal and this lookup falls back to control's own sentence,
 * which names the repository and the command and needs no project at all.
 */
async function mapRefusalText(refusal: ControlRefusal): Promise<string> {
  if (refusal.kind !== 'external_repository_mapped') return refusalText(refusal)
  const holder = await prisma.workspace.findUnique({ where: { id: refusal.workspaceId }, select: { name: true } })
  if (holder === null) return refusalText(refusal)
  return (
    `${refusal.repository} on ${EXTERNAL_SOURCE_LABEL[refusal.source]} is already mapped to project ` +
    `${holder.name}; unmap it there first with: triggers unmap --workspace <that project> ` +
    `--source ${refusal.source} --repository ${refusal.repository}`
  )
}

/** A brokered op's WORD, with the key left to the caller's own column (`docs/ia.md` rule 3). A
 *  binding row carries a plain `String`, so an op this version does not know prints as itself. */
function brokerOpLabel(op: string): string {
  return BROKER_OP_LABEL[op as BrokerOp] ?? op
}

/** How often the thin client looks for its reply. Two hundred milliseconds against a 150-second
 *  ceiling: 750 `stat` calls in the worst case, and a deploy that finished is noticed within a
 *  fifth of a second. */
const BROKER_POLL_MS = 200

/**
 * One of the three environment variables the orchestrator sets on a brokered child, or a refusal
 * that names it.
 *
 * The message says WHERE the variable comes from, because the person who meets this is almost
 * always an operator who typed `broker run` in their own shell: this verb is the worker's, it is
 * spawned by the orchestrator, and outside a run there is no channel to write to and no identity
 * to write with.
 */
function requireChildEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set: \`broker run\` is the worker's own verb and only works inside a run the ` +
        'orchestrator started, which is what sets it',
    )
  }
  return value
}

/**
 * The WORKER'S OWN verb (M52 R3), and the only command in this file that touches no database.
 *
 * It writes one bounded line to `SLAVEOFAI_BROKER_CHANNEL` with `O_APPEND` -- atomic below
 * PIPE_BUF, which is why the line is capped -- then polls for `broker-<requestId>.json` up to
 * `BROKER_CLIENT_TIMEOUT_MS`, prints the bounded output and exits with the operation's own status.
 * It needs no secret, no port and no server, and it CANNOT reach the database: M52's
 * `CHILD_ENV_ALLOW` removes `DATABASE_URL` from every worker's environment, which is what makes a
 * database client impossible here and a file client sufficient.
 *
 * The client waits LONGER than the server runs (`BROKER_CLIENT_TIMEOUT_MS` > `BROKER_TIMEOUT_MS`,
 * pinned by a domain test): a client that gave up first would report "no answer" for an operation
 * that had in fact run, which is the one failure an audit trail cannot recover from.
 *
 * THE FLAGS ARE THE MANIFEST'S, not a list spelled here: the parameters a worker may pass are the
 * keys of `BROKERED_OPERATIONS[op].params`, so a second operation gets its flags the moment it is
 * added to the registry and this function keeps not knowing what a deploy is. Nothing is validated
 * here beyond the op's existence -- the strict schema on the daemon's side is the one authority,
 * and a client that pre-validated would be a second copy of a rule that must not drift.
 *
 * No hook rule is needed for the `Bash` call that invokes this: `run_commands` is in the
 * implementer baseline, so the call is already allowed, and command-string inspection stays out of
 * scope exactly as M18 ruled.
 */
async function runBrokerClient(argv: readonly string[], flags: Flags): Promise<number> {
  const channelPath = requireChildEnv('SLAVEOFAI_BROKER_CHANNEL')
  const runId = requireChildEnv('SLAVEOFAI_RUN_ID')
  const runToken = requireChildEnv('SLAVEOFAI_RUN_TOKEN')

  const op = argv[2]
  if (op === undefined) {
    throw new Error(`broker run needs an operation: ${Object.keys(BROKERED_OPERATIONS).join(', ')}`)
  }
  // Refused here rather than on the channel: an op the manifest does not carry has no parameters to
  // read either, so there is nothing to send. The sentence is `refusalText`'s own, so the worker
  // reads the same words whichever side refused.
  if (!Object.hasOwn(BROKERED_OPERATIONS, op)) {
    throw new Error(refusalText({ kind: 'broker_refused', op, reason: 'not_brokered' }))
  }
  const params: Record<string, string> = {}
  for (const key of Object.keys(BROKERED_OPERATIONS[op as BrokerOp].params.shape)) {
    const value = flagText(flags, key)
    if (value !== undefined) params[key] = value
  }

  const requestId = randomBytes(16).toString('hex')
  const line = `${JSON.stringify({ requestId, runId, runToken, op, params })}\n`
  // The same cap the server drops a line at. Refusing here turns "the daemon silently ignored me"
  // into a sentence the worker can act on, and it is the only thing this client checks about its
  // own request.
  if (Buffer.byteLength(line, 'utf8') > REQUEST_LINE_MAX_BYTES) {
    throw new Error(`${op}: that request is larger than the ${String(REQUEST_LINE_MAX_BYTES)}-byte limit for one line`)
  }
  appendFileSync(channelPath, line, { mode: 0o600 })

  // Beside the channel, from the same helper the daemon writes with -- never a filename spelled
  // twice.
  const replyPath = brokerReplyPathFor(dirname(channelPath), requestId)
  const deadline = Date.now() + BROKER_CLIENT_TIMEOUT_MS
  for (;;) {
    const reply = readBrokerReply(replyPath)
    if (reply !== null) {
      if (reply.requestId !== requestId) throw new Error(`${op}: the reply beside this request answers a different one`)
      return reportBrokerReply(op, reply)
    }
    if (Date.now() >= deadline) {
      throw new Error(`${op}: no answer from the orchestrator after ${String(BROKER_CLIENT_TIMEOUT_MS)}ms`)
    }
    await new Promise<void>((settle) => setTimeout(settle, BROKER_POLL_MS))
  }
}

/** The reply, or `null` for "not yet". A file that does not fit the schema is "not yet" too: it is
 *  in a directory the worker can write, so the only safe reading of a malformed one is that the
 *  answer has not arrived, and the wait ends at the client's own deadline. */
function readBrokerReply(replyPath: string): BrokerReplyRead | null {
  if (!existsSync(replyPath)) return null
  try {
    const parsed = brokerReplySchema.safeParse(JSON.parse(readFileSync(replyPath, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * What the worker sees, and what this process exits with.
 *
 * `ok` says the operation RAN, never that it succeeded: a bound script that exits 3 is an execution,
 * and 3 is what this returns -- the worker's shell then sees exactly what it would have seen had it
 * been allowed to run the command itself. Every other outcome is a thrown sentence and `main`'s own
 * catch turns it into stderr and exit 1, which is this file's rule for every verb: the distinction
 * lives in the WORDS, because that is what a worker (and the person reading its transcript) reads.
 */
function reportBrokerReply(op: string, reply: BrokerReplyRead): number {
  if (!reply.ok) {
    throw new Error(
      isBrokerRefusalReason(reply.reason)
        ? refusalText({ kind: 'broker_refused', op, reason: reply.reason })
        : `${op}: the orchestrator could not answer (${reply.reason ?? 'no reason given'})`,
    )
  }
  if (reply.output !== '') process.stdout.write(reply.output.endsWith('\n') ? reply.output : `${reply.output}\n`)
  // Bounded to what an exit status can actually be. A real child's code is always in range; this
  // file is parsed out of a directory the WORKER can write, and a number outside it would be masked
  // by Node into an unrelated one -- 256 would exit 0, which is the one value it must never become.
  if (reply.exitCode !== null && reply.exitCode >= 0 && reply.exitCode <= 255) return reply.exitCode
  if (reply.exitCode !== null) return 1
  // A killed or timed-out operation has no exit status to report, and silence here would read as
  // success.
  process.stderr.write(`${op}: the operation reported no exit status -- it was killed or it timed out\n`)
  return 1
}

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

/**
 * The import report an operator reads (M42 §2, rewritten by M55 R7).
 *
 * **Counts by default, lines only when asked.** A real catalog is three hundred files, and a
 * three-hundred-line wall is not a report -- it is the thing an operator scrolls past to find the
 * two rows that mattered. `--verbose` prints the per-row lines this used to print unconditionally.
 *
 * **The SKIPS still print every time.** A skip is a thing the operator has to act on, and a count of
 * four with no reasons is not actionable. They get a breakdown line AND their own detail lines,
 * because "2 name_taken" says how many and the lines say which.
 *
 * A drifting role is printed on its own line whatever the verbosity: the template keeps the role it
 * was created with, and an operator who expected --role-map to change it needs to be told it did
 * not.
 */
function describeImport(report: ImportReport, verbose: boolean): string {
  const lines: string[] = []
  if (report.dryRun) lines.push('DRY RUN: nothing was written.')
  // M46 E22, final wave M4: the backfill writes a `profileSpec` onto a row whose FILE has not
  // changed, so its outcome is `unchanged` and nothing in this report mentioned it -- an operator
  // re-importing an old catalog precisely to get specialist profiles could not tell it had
  // happened. APPENDED to the four counts, never mixed into them: `structured` is a subset of
  // `unchanged`, and the four numbers are what the m42 gate reads. Printed only when there is one,
  // like `overrides kept` below.
  const structured = [...report.created, ...report.updated, ...report.unchanged].filter(
    (row) => row.structured === true,
  ).length
  lines.push(
    `${report.catalog} (${report.directory}): created ${String(report.created.length)}, ` +
      `updated ${String(report.updated.length)}, unchanged ${String(report.unchanged.length)}, ` +
      `skipped ${String(report.skipped.length)}` +
      (structured > 0 ? `, structured ${String(structured)}` : ''),
  )
  // M55 R7: the three duplicate counts, always -- including three zeroes, which is a real answer
  // ("nothing looked alike") and is what makes the line's absence impossible to misread as one.
  lines.push(
    `  duplicates: ${String(report.duplicates.exact)} exact, ${String(report.duplicates.near)} near, ` +
      `${String(report.duplicates.overlapping)} overlapping` +
      (report.scanTruncated ? ' (the scan was truncated: not every row was paired)' : ''),
  )
  if (report.skipped.length > 0) {
    // The breakdown AND the detail lines below: this says how many of each reason, and those say
    // which row. A `Map` keyed by the reason keeps the order the reasons first appeared in, which is
    // the order the directory was walked.
    const byReason = new Map<string, number>()
    for (const row of report.skipped) byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + 1)
    lines.push(
      `  skipped: ${[...byReason.entries()].map(([reason, count]) => `${String(count)} ${reason}`).join(', ')}`,
    )
  }
  if (verbose) {
    for (const row of report.created) lines.push(`  created  ${row.name}  [${row.role}]  ${row.sourceId}`)
    for (const row of report.updated) {
      // M46 D10: the count only when there IS one. An operator re-importing three hundred untouched
      // rows does not need "overrides kept 0" three hundred times; the row that DID keep somebody's
      // customisation through an upstream change is the one worth a word.
      const kept =
        row.overridesKept !== undefined && row.overridesKept > 0
          ? `  (overrides kept ${String(row.overridesKept)})`
          : ''
      lines.push(`  updated  ${row.name}  [${row.role}]  ${row.sourceId}${kept}`)
    }
  }
  for (const row of report.skipped) lines.push(`  skipped  ${row.reason}  ${row.name ?? row.sourceId}: ${row.detail}`)
  for (const row of [...report.created, ...report.updated, ...report.unchanged]) {
    if (row.roleDrift === undefined) continue
    lines.push(
      `  role     ${row.name} stays "${row.roleDrift.stored}" (the map said "${row.roleDrift.mapped}"): ` +
        "a template's role is set when it is created -- delete it and import it again to change one",
    )
  }
  if (report.importId !== null) lines.push(`recorded as import ${report.importId}`)
  return `${lines.join('\n')}\n`
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
      const result = await requestPause(requireFlag(flags, 'run'), operatorName(flags))
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

    case 'breaker': {
      // M51 R3, and READ-ONLY on purpose (D18). There is no `steer` or `constrain` verb: the ladder
      // is the system's, and a hand-typed rung would be a fourth actor in a design whose whole shape
      // is three. A person who wants to intervene already has `pause`, `stop` and the resume message
      // box. What this answers is the question somebody standing in front of a stuck run actually
      // has -- what does the breaker think, and what did it last see.
      const run = await mustGetRun(requireFlag(flags, 'run'))
      const [trip] = await prisma.executionEvent.findMany({
        where: { runId: run.id, type: 'run_breaker' },
        orderBy: { seq: 'desc' },
        take: 1,
      })
      const cap = run.toolCallCap === null ? 'none' : String(run.toolCallCap)
      process.stdout.write(
        `run ${run.id} is ${BREAKER_LEVEL_LABEL[run.breakerLevel].toLowerCase()} ` +
          `(${String(run.breakerTrips)} trip(s), ${String(run.breakerSteers)} steer(s))\n` +
          `  tool calls  ${String(run.toolCalls)}, cap ${cap}\n`,
      )
      if (trip === undefined) {
        // Not an error and not silence: "the breaker has never tripped on this run" is the answer
        // for nearly every run there is, and a verb that printed nothing would read as broken.
        process.stdout.write('  last trip   none\n')
        return 0
      }
      const payload = trip.payload as { trip: string; count: number; detail: string }
      process.stdout.write(
        `  last trip   ${BREAKER_TRIP_LABEL[payload.trip as BreakerTripKind] ?? payload.trip}` +
          ` (${payload.trip}), ${String(payload.count)}x, ${payload.detail}\n` +
          `              at ${trip.ts.toISOString()}\n`,
      )
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
      process.stdout.write(`task ${taskIdFlag} is unblocked and back in ${result.value.status}\n`)
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
        select: { id: true, role: true, person: { select: { name: true } } },
      })
      // `displayName` (`@slave-of-ai/domain`), not a local `${name} (${role})` -- M37 §3 made that
      // one function so the CLI, the inbox, the ask roster and delivery cannot drift apart.
      const nameById = new Map(
        roster.map((slave) => [slave.id, displayName({ name: slave.person.name, role: slave.role })]),
      )
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
        answeredBy: operatorName(flags),
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
      const result = await reassignQuestion(messageId, toSlaveId, operatorName(flags), 'human')
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
      const result = await clearHalt(workspaceId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(
        `cleared the safety halt on ${workspaceId}. This starts nothing by itself: it removes the ` +
          `reason nothing was starting.\n`,
      )
      return 0
    }

    case 'emergency-stop': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      const result = await emergencyStop(workspaceId, operatorName(flags))
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

    case 'request-change': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      const request = requireFlag(flags, 'request')
      // No `--by`: `GoalVersion.setByUserId` needs a `User` row and this CLI resolves no principal
      // -- `set-goal` above passes none either (M45 plan erratum E9).
      const result = await requestChange(workspaceId, request)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(
        `${JSON.stringify({ version: result.value.version, sha256: result.value.sha256, goal: result.value.goal })}\n`,
      )
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

    case 'import-catalog': {
      const dir = requireFlag(flags, 'dir')
      // `'dry-run' in flags`, not `!== undefined`: a bare flag's recorded value is `undefined`, the
      // repo's own `--yes`/`--clear` idiom.
      const dryRun = 'dry-run' in flags
      // M55 R10, the same idiom for the same reason: a bare flag's recorded value IS `undefined`
      // (`parseArgs`), so a `!== undefined` test would read every one of these as absent.
      const activate = 'activate' in flags
      const verbose = 'verbose' in flags
      const allowUnknownLicense = 'allow-unknown-license' in flags
      const divisionText = flagText(flags, 'division')
      const divisions =
        divisionText === undefined
          ? undefined
          : divisionText
              .split(',')
              .map((division) => division.trim())
              .filter((division) => division !== '')
      const roleMapText = flagText(flags, 'role-map')
      const roleMap: Record<string, string> = {}
      // Collected as pairs, not written straight into `roleMap`, so a repeated division is
      // DETECTED rather than one entry silently overwriting the other: a plain object cannot hold
      // two values under one key, so writing as we go would let `engineering=backend,engineering=
      // frontend` collapse to whichever came last before `normaliseRoleMap`'s own duplicate check
      // -- built for exactly this -- ever saw two entries to compare (I2). The trim happens here,
      // not there, only because the check needs it: two divisions distinct before trimming
      // (`" engineering "` and `"engineering"`) are the SAME duplicate the verb refuses.
      const roleMapPairs: [string, string][] = []
      for (const pair of roleMapText === undefined ? [] : roleMapText.split(',')) {
        const [division, role] = pair.split('=')
        if (division === undefined || role === undefined) {
          throw new Error(`--role-map entries look like division=role; got ${JSON.stringify(pair)}`)
        }
        roleMapPairs.push([division.trim(), role.trim()])
      }
      const seenRoleMapDivisions = new Set<string>()
      for (const [division, role] of roleMapPairs) {
        if (seenRoleMapDivisions.has(division)) {
          // The verb's own wording (`normaliseRoleMap`'s `invalid_role_map` detail), reached
          // through `refusalText` rather than typed out a second time: two spellings of the same
          // refusal is how they drift apart.
          throw new Error(refusalText({ kind: 'invalid_role_map', detail: `the division "${division}" is named twice` }))
        }
        seenRoleMapDivisions.add(division)
        roleMap[division] = role
      }

      const walk = readCatalogDirectory(dir, {
        ...(flagText(flags, 'catalog') !== undefined ? { catalog: requireFlag(flags, 'catalog') } : {}),
        ...(divisions !== undefined ? { divisions } : {}),
      })

      // A name this catalog does not have is a WARNING, not a refusal: the rest of the run is
      // still the one the operator asked for, and a silently ignored name is how somebody
      // concludes the flag does not work at all. Both live HERE rather than in the verb -- the
      // verb takes entries and a map and applies them, and has no idea what was on the disk.
      for (const division of walk.missingDivisions) {
        process.stderr.write(
          `WARNING: --division names "${division}", which is not a directory in this catalog; nothing was read from it\n`,
        )
      }
      // M2 fix round 2: `divisions.json` itself named a division that is not there -- a fact about
      // the catalog's own manifest, not about anything the operator typed, so it gets its own
      // wording rather than borrowing `--division`'s. When every declared division is stale this
      // is the only WARNING printed at all, `walk.entries` is empty, and `importCatalog` below
      // refuses with `catalog_empty` -- there is nothing left for this run to do.
      for (const division of walk.staleManifestDivisions) {
        process.stderr.write(
          `WARNING: divisions.json names "${division}", which is not a directory in this catalog; nothing was read from it\n`,
        )
      }
      // Against the divisions the WALK resolved, not the ones that yielded entries (fix round 1,
      // minor 4): a real division that happens to hold no persona is a name the operator got
      // right, and calling it unknown would send them looking for a typo that is not there.
      const present = new Set(walk.divisions)
      for (const division of Object.keys(roleMap)) {
        if (present.has(division)) continue
        process.stderr.write(
          `WARNING: --role-map names "${division}", which is not a division in this catalog; that entry maps nothing\n`,
        )
      }

      // R4: printed rather than silent -- "no revision" is a fact about the operator's directory
      // (it is not a git checkout), and somebody reading a catalog page later will ask why.
      process.stdout.write(
        `catalog ${walk.catalog}: revision ${walk.revision ?? 'unknown (not a git work tree)'}, licence ${walk.license ?? 'unknown (no LICENSE at the root)'}\n`,
      )

      const result = await importCatalog(
        {
          catalog: walk.catalog,
          directory: resolve(dir),
          entries: walk.entries,
          revision: walk.revision,
          license: walk.license,
          ...(Object.keys(roleMap).length > 0 ? { roleMap } : {}),
          ...(dryRun ? { dryRun: true } : {}),
          ...(activate ? { activate: true } : {}),
          ...(allowUnknownLicense ? { allowUnknownLicense: true } : {}),
          // M55 R7: one line per batch of a hundred rows and one at the end. The VERB reports and
          // THIS prints -- `packages/control` writes to no stream, so a progress line is a callback
          // rather than a `console.log` buried in a control module.
          onProgress: (progress) => {
            process.stdout.write(
              `  … ${String(progress.done)}/${String(progress.total)} rows — ` +
                `created ${String(progress.created)}, updated ${String(progress.updated)}, ` +
                `unchanged ${String(progress.unchanged)}, skipped ${String(progress.skipped)}\n`,
            )
          },
        },
        operatorName(flags),
      )
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(describeImport(result.value, verbose))
      return 0
    }

    case 'list-imports': {
      const limitText = flagText(flags, 'limit')
      // (M3) `Number.parseInt` reads a leading run of digits and silently drops whatever follows
      // it -- `3abc` and `3.9` both used to parse as `3` and sail through. `/^\d+$/` is the whole
      // string or nothing, which is also what rules out a leading `-` or `+` and stray whitespace
      // without a second check.
      if (limitText !== undefined && !/^\d+$/.test(limitText)) {
        throw new Error('--limit must be a positive integer')
      }
      const limit = limitText === undefined ? 10 : Number.parseInt(limitText, 10)
      if (limit < 1) throw new Error('--limit must be a positive integer')
      // The verb itself clamps to its own ceiling of 100 (a caller cannot pull the whole table
      // into a response) -- reported here, not refused, because a `--limit 500` typed by an
      // operator who forgot the ceiling is still answered with the closest thing to what they
      // asked for, just told so they do not conclude the flag was ignored.
      if (limit > 100) process.stdout.write(`note: --limit ${String(limit)} was clamped to 100\n`)
      const rows = await listCatalogImports(limit)
      if (rows.length === 0) {
        process.stdout.write('no catalog has been imported yet\n')
        return 0
      }
      // The header names the three slashed numbers ONCE, above the rows, because `0/0/0` on its own
      // is a shape and not an answer (M55 plan erratum E9: seven numbers, not six).
      process.stdout.write('when  catalog  by  outcomes  duplicates exact/near/overlapping  directory\n')
      for (const row of rows) {
        process.stdout.write(
          `${row.finishedAt.toISOString()}  ${row.catalog}  by ${row.by ?? 'nobody named'}  ` +
            `created ${String(row.created)}, updated ${String(row.updated)}, unchanged ${String(row.unchanged)}, ` +
            `skipped ${String(row.skipped)}  ` +
            `duplicates ${String(row.duplicates.exact)}/${String(row.duplicates.near)}/${String(row.duplicates.overlapping)}  ` +
            `(${row.directory})\n`,
        )
      }
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
      // M58 R11: the verb an operator already knows, on the new model -- a PERSON in a department,
      // and no project. The roster row it used to create does not exist any more; what it meant
      // ("somebody the organisation has, not yet on a board") is exactly a pooled person who is a
      // member of a department.
      const created = await createPerson({
        templateId,
        name,
        ...(model !== undefined ? { model } : {}),
        ...(provider !== undefined ? { provider: provider as ProviderKind } : {}),
        lifecycle: 'permanent',
      })
      if (!created.ok) throw new Error(refusalText(created.error))
      const joined = await joinDepartment(created.value.personId, companyTeamId)
      if (!joined.ok) throw new Error(refusalText(joined.error))
      process.stdout.write(`slave ${created.value.personId} created (${created.value.name}) in department ${companyTeamId}\n`)
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
      // M58 R11: `--person` writes the slave-level pair; `--slave` writes the seat. Exactly one.
      const personFlag = flagText(flags, 'person')
      const slaveFlag = flagText(flags, 'slave')
      if (personFlag === undefined && slaveFlag === undefined) throw new Error('--person or --slave is required')
      if (personFlag !== undefined && slaveFlag !== undefined) {
        throw new Error('exactly one of --person or --slave is required')
      }
      // `'clear' in flags`, not `flags['clear'] !== undefined`: a bare `--clear` (no value
      // following it) is exactly how `parseArgs` records a flag with no argument -- it sets the
      // key to `undefined` rather than leaving it absent, so `!== undefined` can never see it.
      const clear = 'clear' in flags
      const model = flagText(flags, 'model')
      const provider = flagText(flags, 'provider')
      if (!clear && model === undefined) throw new Error('--model or --clear is required')
      if (personFlag !== undefined) {
        const nextModel = clear ? null : (model as string)
        const nextProvider = clear ? null : ((provider as ProviderKind | undefined) ?? null)
        if (nextModel !== null && nextModel.trim() === '') {
          throw new Error(refusalText({ kind: 'invalid_model' }))
        }
        if ((nextModel !== null) !== (nextProvider !== null)) {
          throw new Error(refusalText({ kind: 'model_without_provider' }))
        }
        if (nextProvider !== null && !isProviderKind(nextProvider)) {
          throw new Error(refusalText({ kind: 'invalid_provider', provider: nextProvider }))
        }
        const written = await prisma.person.updateMany({
          where: { id: personFlag },
          data: { model: nextModel, provider: nextProvider },
        })
        if (written.count === 0) throw new Error(refusalText({ kind: 'person_not_found', personId: personFlag }))
        process.stdout.write(clear ? `model cleared on ${personFlag}\n` : `model set to ${model} on ${personFlag}\n`)
        process.stdout.write('at the slave level\n')
        return 0
      }
      const slaveId = slaveFlag as string
      const result = await setSlaveModel(
        slaveId,
        clear ? null : (model as string),
        clear ? null : ((provider as ProviderKind | undefined) ?? null),
      )
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(clear ? `model cleared on ${slaveId}\n` : `model set to ${model} on ${slaveId}\n`)
      process.stdout.write('at the seat level\n')
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
        ...(flagText(flags, 'person') !== undefined ? [{ personId: requireFlag(flags, 'person') }] : []),
      ]
      if (targets.length !== 1 || targets[0] === undefined) {
        throw new Error('exactly one of --slave, --template or --person is required')
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

      const result = await setProfile(target, profile, operatorName(flags))
      if (!result.ok) throw new Error(refusalText(result.error))
      const level = 'slaveId' in target ? 'seat' : 'personId' in target ? 'slave' : 'template'
      process.stdout.write(clear ? `profile cleared at the ${level} level\n` : `profile set at the ${level} level\n`)
      return 0
    }

    case 'show-profile': {
      const templateId = requireFlag(flags, 'template')
      const result = await readTemplateProfile(templateId)
      if (!result.ok) throw new Error(refusalText(result.error))
      const view = result.value
      if ('markdown' in flags) {
        process.stdout.write(view.markdown === null ? 'this template has no profile\n' : `${view.markdown}\n`)
        return 0
      }
      // JSON, not a rendered report: this verb exists so a person -- or a gate -- can read the
      // structure back exactly as it is stored, and a prose summary of a fourteen-field object
      // would be a second, drifting rendering of it.
      process.stdout.write(
        `${JSON.stringify(
          {
            templateId: view.templateId,
            name: view.name,
            rawOverride: view.rawOverride,
            overridden: view.overridden,
            effective: view.effective,
            upstream: view.upstream,
            overrides: view.overrides,
          },
          null,
          2,
        )}\n`,
      )
      return 0
    }

    case 'set-runtime-roles': {
      const slaveId = requireFlag(flags, 'slave')
      // `--roles ''` is how a slave is PARKED (spec §7): an empty set is a real state, so an empty
      // string splits to nothing rather than to one blank entry the verb would refuse.
      const raw = requireFlag(flags, 'roles')
      const roles = raw.trim() === '' ? [] : raw.split(',')
      const result = await setRuntimeRoles(slaveId, roles, operatorName(flags))
      if (!result.ok) throw new Error(refusalText(result.error))
      const after = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId }, select: { runtimeRoles: true } })
      process.stdout.write(
        after.runtimeRoles.length === 0
          ? `${slaveId} now holds no runtime roles: it cannot be dispatched until it holds one\n`
          : `runtime roles set to ${after.runtimeRoles.join(', ')} on ${slaveId}\n`,
      )
      return 0
    }

    case 'capabilities': {
      // `capabilities sync | add | list` -- one command with a subcommand, the `skills` verb's own
      // shape in this file (the sub-verb is a positional, and `parseArgs` collects only flags, so
      // it is read off the raw argv), because three sibling top-level verbs for one table would
      // read as three unrelated features.
      const sub = argv[1] ?? 'list'
      if (sub === 'sync') {
        const out = await syncCapabilityTaxonomy()
        process.stdout.write(
          `taxonomy synced: ${String(out.created)} added, ${String(out.updated)} brought back to the checked-in list\n`,
        )
        return 0
      }
      if (sub === 'add') {
        const result = await addCapability({
          key: requireFlag(flags, 'key'),
          label: requireFlag(flags, 'label'),
          role: requireFlag(flags, 'role'),
          ...(flagText(flags, 'synonyms') === undefined ? {} : { synonyms: requireFlag(flags, 'synonyms').split(',') }),
        })
        if (!result.ok) throw new Error(refusalText(result.error))
        process.stdout.write(`${result.value.key} added: ${result.value.label}, dispatched as "${result.value.role}"\n`)
        return 0
      }
      if (sub === 'backfill') {
        // M47 final review, Important 4. `Slave.capabilities` is `@default([])` and nothing
        // backfilled it, so on a project that predates M47 the first and cheapest staffing tier --
        // "somebody already here who can do it and was never given the role" -- has nothing to
        // read and never fires. One verb, run once, and it says what it did rather than reporting
        // a silent success.
        const out = await backfillSlaveCapabilities(flagText(flags, 'workspace'))
        process.stdout.write(
          `capabilities backfilled: ${String(out.updated)} worker(s) described from their template, ` +
            `${String(out.skipped)} left alone\n`,
        )
        return 0
      }
      if (sub === 'list') {
        for (const record of await listCapabilities()) {
          process.stdout.write(`${record.key}\t${record.label}\t-> ${record.role}\n`)
        }
        return 0
      }
      throw new Error('capabilities takes sync, add, backfill or list')
    }

    case 'template': {
      // `template list | activate | deactivate | duplicates` -- the `capabilities`/`runbooks`/
      // `memories` shape in this file (the sub-verb is a POSITIONAL read off raw argv, because
      // `parseArgs` collects only flags), for its own reason: four sibling top-level verbs for one
      // table would read as four unrelated features.
      //
      // It is NOT called `templates`: `create-template`, `set-profile --template` and
      // `show-profile --template` already spell the noun singular, and two spellings of one noun in
      // one CLI is one more thing an operator has to remember.
      const sub = argv[1] ?? 'list'

      if (sub === 'list') {
        const activeFlag = 'active' in flags
        const inactiveFlag = 'inactive' in flags
        if (activeFlag && inactiveFlag) throw new Error('--active and --inactive are opposites: pass one or neither')
        const duplicates = oneOfFlag<DuplicateFacet>(flags, 'duplicates', [...DUPLICATE_FACETS])
        const page = await listWorkforceCatalog(
          {
            ...(flagText(flags, 'division') === undefined ? {} : { division: requireFlag(flags, 'division') }),
            ...(activeFlag ? { active: true } : {}),
            ...(inactiveFlag ? { active: false } : {}),
            ...(duplicates === undefined ? {} : { duplicates }),
          },
          { pageSize: TEMPLATE_PICKER_MAX },
        )
        // The COUNT first, because `template list` on a full catalog prints hundreds of lines and an
        // operator piping it into `head` should still learn how many there were.
        process.stdout.write(`${String(page.rows.length)} of ${String(page.total)} template(s)\n`)
        for (const row of page.rows) {
          // Tab-separated, the shape every other list verb here uses. Five columns an operator can
          // cut, and the two that name a vocabulary print WORDS (`docs/ia.md` rule 3): `active` /
          // `inactive` for a boolean nobody should read as `true`, and the class label for a pair.
          const signal =
            row.duplicate === null
              ? '-'
              : `${DUPLICATE_CLASS_LABEL[row.duplicate.class]} ${row.duplicate.otherName}` +
                (row.duplicateCount > 1 ? ` (+${String(row.duplicateCount - 1)})` : '')
          process.stdout.write(
            `${row.id}\t${row.name}\t${row.sourceDivision ?? row.role}\t${row.active ? 'active' : 'inactive'}\t${signal}\n`,
          )
        }
        return 0
      }

      if (sub === 'activate' || sub === 'deactivate') {
        const templateId = requireFlag(flags, 'template')
        const active = sub === 'activate'
        const result = await setTemplateActivation(templateId, active, operatorName(flags))
        if (!result.ok) throw new Error(refusalText(result.error))
        // The NAME, read back after the write, because an operator types an id and reads a name --
        // and because "it worked" without saying what worked is the sentence somebody runs twice.
        const row = await prisma.slaveTemplate.findUnique({ where: { id: templateId }, select: { name: true } })
        const name = row?.name ?? templateId
        process.stdout.write(
          result.value.changed
            ? `${name} is now ${active ? 'active' : 'inactive'}\n`
            : `${name} was already ${active ? 'active' : 'inactive'}\n`,
        )
        return 0
      }

      if (sub === 'duplicates') {
        // `--recompute` FIRST, so `template duplicates --recompute` prints what the pass did and
        // then the pairs it left behind -- one command, one picture.
        if ('recompute' in flags) {
          const scan = await recomputeTemplateDuplicates()
          const total = scan.counts.exact + scan.counts.near + scan.counts.overlapping
          process.stdout.write(
            `recomputed: ${String(total)} pair(s) -- ${String(scan.counts.exact)} exact, ` +
              `${String(scan.counts.near)} near, ${String(scan.counts.overlapping)} overlapping; ` +
              `${String(scan.created)} new, ${String(scan.updated)} re-classified, ${String(scan.removed)} retired, ` +
              `${String(scan.backfilled)} row(s) backfilled` +
              (scan.truncated ? ' (the scan was truncated: not every row was paired)' : '') +
              '\n',
          )
        }
        const dismiss = flagText(flags, 'dismiss')
        const restore = flagText(flags, 'restore')
        if (dismiss !== undefined && restore !== undefined) {
          throw new Error('--dismiss and --restore are opposites: pass one or neither')
        }
        if (dismiss !== undefined || restore !== undefined) {
          const pairId = dismiss ?? (restore as string)
          const result = await setTemplateDuplicateDismissal(pairId, dismiss !== undefined, operatorName(flags))
          if (!result.ok) throw new Error(refusalText(result.error))
          process.stdout.write(
            result.value.changed
              ? `${pairId} is now ${dismiss !== undefined ? 'dismissed' : 'showing again'}\n`
              : `${pairId} was already ${dismiss !== undefined ? 'dismissed' : 'showing'}\n`,
          )
          return 0
        }
        const klass = oneOfFlag<DuplicateClass>(flags, 'class', [...DUPLICATE_CLASSES])
        const page = await listTemplateDuplicates({
          ...(flagText(flags, 'template') === undefined ? {} : { templateId: requireFlag(flags, 'template') }),
          ...(klass === undefined ? {} : { class: klass }),
          ...('dismissed' in flags ? { includeDismissed: true } : {}),
        })
        if (page.rows.length === 0) {
          process.stdout.write('no duplicate pair has been detected\n')
          return 0
        }
        // The COUNT first, `template list`'s own line (final wave, Important 2): the read stops at
        // `TEMPLATE_DUPLICATES_LIMIT` and a list printed without its total looks complete when it is
        // not -- narrow it with --template or --class to see the rest.
        process.stdout.write(`${String(page.rows.length)} of ${String(page.total)} pair(s)\n`)
        for (const row of page.rows) {
          // Labels, never keys: the class and the basis both come from the domain's own tables, and
          // the raw members appear nowhere in this line. The SCORE is printed to three decimals,
          // which is exactly what was stored.
          process.stdout.write(
            `${row.id}\t${DUPLICATE_CLASS_LABEL[row.class]}\t${row.aName} / ${row.bName}\t` +
              `${row.score.toFixed(3)}\t${DUPLICATE_BASIS_LABEL[row.basis]}\t` +
              `${row.detectedAt.toISOString().slice(0, 10)}` +
              (row.dismissedAt === null ? '' : `\tdismissed by ${row.dismissedBy ?? 'nobody named'}`) +
              '\n',
          )
        }
        return 0
      }

      throw new Error('template takes list, activate, deactivate or duplicates')
    }

    case 'runbooks': {
      // `runbooks sync | list | show <key> | add --file <path>` -- `capabilities`' own shape in this
      // file (the sub-verb is a positional read off raw argv, because `parseArgs` collects only
      // flags), for its own reason: four sibling top-level verbs for one table would read as four
      // unrelated features.
      const sub = argv[1] ?? 'list'
      if (sub === 'sync') {
        const out = await syncRunbooks()
        process.stdout.write(
          `runbooks synced: ${String(out.created)} added, ${String(out.updated)} brought back to the checked-in list\n`,
        )
        return 0
      }
      if (sub === 'list') {
        for (const runbook of await listRunbooks()) {
          process.stdout.write(
            `${runbook.key}\t${runbook.name}\t${String(runbook.stages.length)} stages\t${runbook.source}\t${String(runbook.workspaceCount)} project(s)\n`,
          )
        }
        return 0
      }
      if (sub === 'show') {
        const key = argv[2]
        if (key === undefined) throw new Error('runbooks show needs a key')
        const result = await readRunbook(key)
        if (!result.ok) throw new Error(refusalText(result.error))
        const runbook = result.value
        process.stdout.write(`${runbook.name} (${runbook.key}, ${runbook.source})\n${runbook.description}\n`)
        for (const stage of stageOrder(runbook.stages)) {
          process.stdout.write(
            `  ${stage.key}: ${stage.title} -- ${stage.objective}\n` +
              (stage.capabilities.length === 0 ? '' : `    capabilities: ${stage.capabilities.join(', ')}\n`) +
              (stage.gates.length === 0 ? '' : `    gates: ${stage.gates.join(' && ')}\n`) +
              (stage.retry === null ? '' : `    retry: ${String(stage.retry.maxAttempts)} attempts\n`) +
              (stage.escalation === null ? '' : `    escalation: ${stage.escalation}\n`),
          )
        }
        return 0
      }
      if (sub === 'add') {
        const file = requireFlag(flags, 'file')
        const result = await addRunbook(JSON.parse(readFileSync(file, 'utf8')) as unknown, operatorName(flags))
        if (!result.ok) throw new Error(refusalText(result.error))
        process.stdout.write(`${result.value.key} added: ${String(result.value.stages.length)} stages, source human\n`)
        return 0
      }
      throw new Error('runbooks takes sync, list, show or add')
    }

    case 'memories': {
      // `memories list | show <id> | add | verify <id> | supersede <id> | remove <id>` -- the
      // `runbooks`/`capabilities` shape in this file (the sub-verb is a POSITIONAL read off raw
      // argv, because `parseArgs` collects only flags), for its own reason: six sibling top-level
      // verbs for one table would read as six unrelated features.
      const sub = argv[1] ?? 'list'
      if (sub === 'list') {
        const workspaceId = await resolveWorkspace(flags)
        const status = oneOfFlag<MemoryStatus>(flags, 'status', MEMORY_STATUSES)
        const type = oneOfFlag<MemoryType>(flags, 'type', MEMORY_TYPES)
        const rows = await listMemories({
          workspaceId,
          ...(status === undefined ? {} : { statuses: [status] }),
          ...(type === undefined ? {} : { type }),
          ...(flagText(flags, 'task') === undefined ? {} : { taskId: requireFlag(flags, 'task') }),
          ...(flagText(flags, 'q') === undefined ? {} : { q: requireFlag(flags, 'q') }),
        })
        for (const memory of rows) {
          // Tab-separated, the shape every other list verb here uses: five columns an operator can
          // cut, and labels rather than keys in the two that name a vocabulary (docs/ia.md rule 3).
          process.stdout.write(
            `${memory.id}\t${MEMORY_TYPE_LABEL[memory.type]}\t${MEMORY_STATUS_LABEL[memory.status]}\t` +
              `${memory.title}\t${provenanceLine(memory, null)}\n`,
          )
        }
        return 0
      }
      if (sub === 'show') {
        const id = argv[2]
        if (id === undefined) throw new Error('memories show needs an id')
        const result = await readMemory(id)
        if (!result.ok) throw new Error(refusalText(result.error))
        const { memory, supersedes, supersededBy, sources } = result.value
        process.stdout.write(
          `${MEMORY_TYPE_LABEL[memory.type]} · ${MEMORY_STATUS_LABEL[memory.status]} · ${MEMORY_SCOPE_LABEL[memory.scope]}\n` +
            `${memory.title}\n${memory.body}\n${provenanceLine(memory, null)}\n`,
        )
        // `supersedes` is a LIST (Task 2 fix round 1): one verified fact retires every candidate
        // its task left behind, so "what did this replace" has more than one answer.
        for (const replaced of supersedes) process.stdout.write(`  replaced: ${replaced.id} ${replaced.title}\n`)
        if (supersededBy !== null) process.stdout.write(`  replaced by: ${supersededBy.id} ${supersededBy.title}\n`)
        for (const source of sources) process.stdout.write(`  summarises: ${source.id} ${source.title}\n`)
        return 0
      }
      if (sub === 'add') {
        const type = oneOfFlag<MemoryType>(flags, 'type', MEMORY_TYPES)
        if (type === undefined) throw new Error('--type is required')
        const capabilities = flagText(flags, 'capabilities')
        const result = await addMemory({
          workspaceId: await resolveWorkspace(flags),
          scope: 'workspace',
          type,
          title: requireFlag(flags, 'title'),
          body: requireFlag(flags, 'body'),
          capabilities: capabilities === undefined ? [] : capabilities.split(','),
        })
        if (!result.ok) throw new Error(refusalText(result.error))
        // "verified by a person" is the whole point of the verb: a memory an operator typed is
        // knowledge on somebody's authority, and the line says whose.
        process.stdout.write(`${result.value.id} added: ${MEMORY_TYPE_LABEL[result.value.type]}, verified by a person\n`)
        return 0
      }
      if (sub === 'verify') {
        const id = argv[2]
        if (id === undefined) throw new Error('memories verify needs an id')
        const result = await verifyMemory(id, undefined, await eventWorkspace(flags))
        if (!result.ok) throw new Error(refusalText(result.error))
        process.stdout.write(`${result.value.id} is now ${MEMORY_STATUS_LABEL[result.value.status]}\n`)
        return 0
      }
      if (sub === 'supersede') {
        const id = argv[2]
        if (id === undefined) throw new Error('memories supersede needs an id')
        const result = await supersedeMemory(
          id,
          { title: requireFlag(flags, 'title'), body: requireFlag(flags, 'body') },
          undefined,
          await eventWorkspace(flags),
        )
        if (!result.ok) throw new Error(refusalText(result.error))
        process.stdout.write(`${result.value.created.id} replaces ${result.value.superseded.id}\n`)
        return 0
      }
      if (sub === 'remove') {
        const id = argv[2]
        if (id === undefined) throw new Error('memories remove needs an id')
        const result = await removeMemory(id, requireFlag(flags, 'reason'), undefined, await eventWorkspace(flags))
        if (!result.ok) throw new Error(refusalText(result.error))
        process.stdout.write(`${result.value.id} withdrawn: ${result.value.removedReason ?? ''}\n`)
        return 0
      }
      if (sub === 'condense') {
        // Deterministic text and no model call (R5): the same rows produce the same summary, so a
        // person can run this twice and the second run finds nothing rather than writing a second
        // summary of the same knowledge.
        const result = await condenseWorkspaceMemories(
          await resolveWorkspace(flags),
          flagText(flags, 'type') === undefined ? undefined : oneOfFlag<MemoryType>(flags, 'type', MEMORY_TYPES),
        )
        if (!result.ok) throw new Error(refusalText(result.error))
        if (result.value.length === 0) {
          process.stdout.write(
            'nothing to summarise: no scope holds 20 verified memories of one type that are not already in a summary\n',
          )
          return 0
        }
        for (const one of result.value) {
          // The type WRITTEN (M49 t5 fix round 1): a worker's twenty lessons are a Procedure, and
          // this line has to name what `memories show` on the same id will say.
          process.stdout.write(`${one.memoryId}: ${MEMORY_TYPE_LABEL[one.type]} summary of ${String(one.sources)} sources\n`)
        }
        return 0
      }
      throw new Error('memories takes list, show, add, verify, supersede, remove or condense')
    }

    case 'adopt-runbook': {
      const workspaceId = requireFlag(flags, 'workspace')
      // `--clear` and `--runbook` are the two halves of one column, so they are one verb. Clearing
      // a project that has adopted nothing is a no-op that says so, rather than a refusal: there is
      // nothing to report and nothing to undo.
      const key = 'clear' in flags ? null : requireFlag(flags, 'runbook')
      const result = await adoptRunbook(workspaceId, key, { origin: 'human' })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(
        result.value.adopted === null
          ? result.value.changed
            ? `${workspaceId} follows no runbook now\n`
            : `${workspaceId} already followed no runbook: nothing was recorded\n`
          : `${workspaceId} follows ${result.value.adopted.name} (${result.value.adopted.key})` +
            `${result.value.changed ? '' : ' already'}\n`,
      )
      return 0
    }

    case 'runbook-status': {
      // D12: the ladder is derived in ONE place, so this verb and the Overview panel cannot
      // disagree about what a stage's state is.
      const result = await runbookStatus(requireFlag(flags, 'workspace'))
      if (!result.ok) throw new Error(refusalText(result.error))
      const status = result.value
      if (status.runbook === null) {
        process.stdout.write('no runbook adopted\n')
        return 0
      }
      process.stdout.write(`${status.runbook.name} (${status.runbook.key}), current stage: ${status.currentStage ?? 'none'}\n`)
      for (const stage of status.stages) {
        process.stdout.write(`  ${stage.state === 'active' ? '>' : ' '} ${stage.key}\t${stage.state}\t${String(stage.taskCount)} task(s)\n`)
      }
      if (status.unknownStages.length > 0) {
        process.stderr.write(`WARNING: ${status.unknownStages.join(', ')} name(s) no stage of this runbook\n`)
      }
      return 0
    }

    case 'set-capabilities': {
      // M58 R11: `--person` is the honest flag -- a capability is a fact about the specialist, not
      // about one project's seat. `--slave` is still accepted and resolved, with a line SAYING so,
      // because that is the flag every script and every gate already passes.
      const personFlag = flagText(flags, 'person')
      const slaveFlag = flagText(flags, 'slave')
      if (personFlag === undefined && slaveFlag === undefined) throw new Error('--person or --slave is required')
      const resolved = personFlag !== undefined ? { personId: personFlag, viaSeat: false } : { ...(await personOfSeat(slaveFlag as string)), viaSeat: true }
      const raw = requireFlag(flags, 'capabilities')
      const result = await setPersonCapabilities(resolved.personId, raw.trim() === '' ? [] : raw.split(','), operatorName(flags))
      if (!result.ok) throw new Error(refusalText(result.error))
      if (resolved.viaSeat) {
        process.stdout.write(
          `a capability belongs to the slave, not the seat: applied to slave ${resolved.personId}, on every project they are on\n`,
        )
      }
      process.stdout.write(
        `${resolved.personId} provides ${result.value.keys.length === 0 ? 'nothing' : result.value.keys.join(', ')}; ` +
          `runtime roles ${result.value.runtimeRoles.join(', ')}\n`,
      )
      for (const unresolved of result.value.unresolved) {
        process.stderr.write(`WARNING: "${unresolved}" matches no capability in the taxonomy and was not stored\n`)
      }
      return 0
    }

    case 'hire': {
      // `'temporary' in flags`, not `flags['temporary'] !== undefined`: a valueless `--temporary`
      // records `undefined` as its value, the same trap `delete-slave`'s `--yes` documents.
      const temporary = 'temporary' in flags
      // M50 R2 (plan decision D3): an assignment is not optional for a temporary hire. A worker
      // brought in for nothing in particular is one `engagement_over` can never fire for, and a
      // specialist nobody can release is exactly the promise this milestone exists to keep. An
      // ordinary missing-flag error, not a refusal kind -- nothing has been written yet.
      const forTask = temporary ? requireFlag(flags, 'for-task') : undefined
      const result = await hireFromTemplate(requireFlag(flags, 'workspace'), requireFlag(flags, 'template'), {
        rationale: requireFlag(flags, 'why'),
        ...(flagText(flags, 'capability') === undefined ? {} : { capabilities: [requireFlag(flags, 'capability')] }),
        ...(forTask === undefined ? {} : { temporary: true, engagementTaskId: forTask }),
      })
      if (!result.ok) throw new Error(refusalText(result.error))
      const hired = await prisma.person.findUniqueOrThrow({
        where: { id: result.value.personId },
        select: { name: true },
      })
      process.stdout.write(
        `${result.value.reused ? 'reused' : 'hired'} ${result.value.slaveId} (${hired.name}): provides ${result.value.capabilities.join(', ')}, ` +
          `dispatchable as ${result.value.runtimeRoles.join(', ')}` +
          // A REUSED worker keeps the lifecycle the hire that created it wrote (erratum E13), so
          // saying "for one assignment" over one would be a claim about a row nobody just changed.
          `${forTask !== undefined && !result.value.reused ? `, for one assignment (${forTask})` : ''}\n`,
      )
      return 0
    }

    // ---- M58 R12: everything a PERSON is, in one verb family --------------------------------
    // The sub-verb is a positional, read off `argv[1]` -- `parseArgs` collects only flags, the same
    // shape `skills`, `template`, `capabilities` and `triggers` already use.
    case 'person': {
      const sub = argv[1]
      switch (sub) {
        case 'create': {
          const templateId = flagText(flags, 'template')
          const name = flagText(flags, 'name')
          const capabilities = flagText(flags, 'capabilities')
          const created = await createPerson({
            ...(templateId === undefined ? {} : { templateId }),
            ...(name === undefined ? {} : { name }),
            ...(flagText(flags, 'profile') === undefined ? {} : { profile: flagText(flags, 'profile') as string }),
            ...(flagText(flags, 'model') === undefined ? {} : { model: flagText(flags, 'model') as string }),
            ...(flagText(flags, 'provider') === undefined
              ? {}
              : { provider: flagText(flags, 'provider') as ProviderKind }),
            ...(capabilities === undefined
              ? {}
              : { capabilities: capabilities.trim() === '' ? [] : capabilities.split(',') }),
          })
          if (!created.ok) throw new Error(refusalText(created.error))
          process.stdout.write(`slave ${created.value.personId} created (${created.value.name}); in the pool\n`)

          const departmentId = flagText(flags, 'department')
          if (departmentId !== undefined) {
            const joined = await joinDepartment(created.value.personId, departmentId)
            if (!joined.ok) throw new Error(refusalText(joined.error))
            process.stdout.write(`joined department ${departmentId}\n`)
          }
          const teamId = flagText(flags, 'project')
          if (teamId !== undefined) {
            const seated = await assignPerson(created.value.personId, teamId)
            if (!seated.ok) throw new Error(refusalText(seated.error))
            process.stdout.write(`seated on ${teamId} (seat ${seated.value.slaveId})\n`)
          }
          return 0
        }

        case 'list': {
          const onlyPool = 'pool' in flags
          const onlyReleased = 'released' in flags
          const departmentId = flagText(flags, 'department')
          const rows = await prisma.person.findMany({
            where: {
              ...(onlyReleased ? { releasedAt: { not: null } } : { releasedAt: null }),
              ...(onlyPool ? { seats: { none: { closedAt: null } } } : {}),
              ...(departmentId === undefined ? {} : { departments: { some: { companyTeamId: departmentId } } }),
            },
            orderBy: { name: 'asc' },
            include: {
              template: { select: { name: true } },
              seats: { where: { closedAt: null }, include: { team: { include: { workspace: { select: { name: true } } } } } },
            },
          })
          if (rows.length === 0) {
            process.stdout.write('nobody matches\n')
            return 0
          }
          for (const row of rows) {
            // The WORD, never the state key: `userPersonStatus` is the one table (`docs/ia.md`
            // rule 3), and the raw state rides in the parentheses beside it for a script to read.
            const word = userPersonStatus({
              releasedAt: row.releasedAt?.toISOString() ?? null,
              openSeats: row.seats.length,
            })
            const where =
              row.seats.length === 0
                ? word.label.toLowerCase()
                : row.seats.map((seat) => seat.team.workspace.name).join(', ')
            process.stdout.write(`${row.id}  ${row.name}  ${row.template?.name ?? '-'}  ${where}  (${word.state})\n`)
          }
          return 0
        }

        case 'show': {
          const personId = requireFlag(flags, 'person')
          const footprint = await personFootprint(personId)
          if (footprint === null) throw new Error(refusalText({ kind: 'person_not_found', personId }))
          const row = await prisma.person.findUniqueOrThrow({
            where: { id: personId },
            include: {
              template: { select: { name: true } },
              departments: { include: { companyTeam: { select: { id: true, name: true } } } },
              seats: { include: { team: { include: { workspace: { select: { name: true } } } } } },
            },
          })
          process.stdout.write(`${row.name} (${row.id})\n`)
          process.stdout.write(`  persona: ${row.template?.name ?? 'none'}\n`)
          process.stdout.write(`  lifecycle: ${row.lifecycle}${row.releasedAt === null ? '' : `, released ${row.releasedAt.toISOString()}`}\n`)
          process.stdout.write(`  provides: ${row.capabilities.length === 0 ? 'nothing recorded' : row.capabilities.join(', ')}\n`)
          process.stdout.write(`  departments: ${row.departments.length === 0 ? 'none' : row.departments.map((m) => m.companyTeam.name).join(', ')}\n`)
          for (const seat of row.seats) {
            process.stdout.write(
              `  seat ${seat.id}  ${seat.team.workspace.name} / ${seat.team.name}  ${seat.role}  ` +
                `[${seat.runtimeRoles.join(', ')}]${seat.closedAt === null ? '' : `  (closed ${seat.closedAt.toISOString()})`}\n`,
            )
          }
          const skills = await personEffectiveSkills(personId)
          if (!skills.ok) throw new Error(refusalText(skills.error))
          process.stdout.write(
            `  skills: ${skills.value.length === 0 ? 'none' : skills.value.map((s) => `${s.name} (${s.origin})`).join(', ')}\n`,
          )
          return 0
        }

        case 'assign': {
          const personId = requireFlag(flags, 'person')
          const teamId = requireFlag(flags, 'team')
          const roles = flagText(flags, 'roles')
          const result = await assignPerson(personId, teamId, {
            ...(flagText(flags, 'role') === undefined ? {} : { role: flagText(flags, 'role') as string }),
            ...(roles === undefined ? {} : { runtimeRoles: roles.trim() === '' ? [] : roles.split(',') }),
          })
          if (!result.ok) throw new Error(refusalText(result.error))
          process.stdout.write(
            `${result.value.reopened ? 'seat reopened' : 'seated'} on ${teamId} (seat ${result.value.slaveId})\n`,
          )
          return 0
        }

        case 'unassign': {
          const personId = requireFlag(flags, 'person')
          const teamId = requireFlag(flags, 'team')
          const result = await unassignPerson(personId, teamId, { reason: requireFlag(flags, 'reason') })
          if (!result.ok) throw new Error(refusalText(result.error))
          process.stdout.write(
            `removed from ${teamId}; the seat and its history stay (seat ${result.value.slaveId}, closed)\n`,
          )
          return 0
        }

        case 'move': {
          const personId = requireFlag(flags, 'person')
          const from = requireFlag(flags, 'from')
          const to = requireFlag(flags, 'to')
          const result = await movePerson(personId, from, to)
          if (!result.ok) throw new Error(refusalText(result.error))
          process.stdout.write(`moved from ${from} to ${to} (seat ${result.value.slaveId})\n`)
          return 0
        }

        case 'release': {
          const personId = requireFlag(flags, 'person')
          const result = await releasePerson(personId, requireFlag(flags, 'reason'))
          if (!result.ok) throw new Error(refusalText(result.error))
          const person = await prisma.person.findUniqueOrThrow({ where: { id: personId }, select: { name: true } })
          process.stdout.write(
            `released ${person.name} (${personId}): ${plural(result.value.seatsClosed, 'seat')} closed, ` +
              `${plural(result.value.worktreesCollected, 'worktree')} collected; ` +
              'every run, message and thing they learnt is untouched\n',
          )
          return 0
        }

        case 'delete': {
          const personId = requireFlag(flags, 'person')
          // `'yes' in flags`, not `!== undefined`: a bare `--yes` records `undefined` as its value.
          if (!('yes' in flags)) {
            const footprint = await personFootprint(personId)
            if (footprint === null) throw new Error(refusalText({ kind: 'person_not_found', personId }))
            throw new Error(
              `refusing without --yes: this would delete ${footprint.name} (${personId}) — ` +
                `${plural(footprint.projects.length, 'project')} (${footprint.projects.join(', ') || 'none'}) ` +
                `and ${plural(footprint.runs, 'run')}; all of it goes`,
            )
          }
          const result = await deletePerson(personId)
          if (!result.ok) throw new Error(refusalText(result.error))
          process.stdout.write(
            `slave ${personId} deleted: ${plural(result.value.seats, 'seat')} on ` +
              `${result.value.projects.join(', ') || 'no project'}, ${plural(result.value.runs, 'run')} and ` +
              `${plural(result.value.memories, 'memory')} went with them\n`,
          )
          return 0
        }

        case 'skills': {
          const personId = requireFlag(flags, 'person')
          const listOf = (name: string): readonly string[] | undefined => {
            const raw = flagText(flags, name)
            return raw === undefined ? undefined : raw.trim() === '' ? [] : raw.split(',')
          }
          const change = {
            ...(listOf('grant') === undefined ? {} : { grant: listOf('grant') as readonly string[] }),
            ...(listOf('revoke') === undefined ? {} : { revoke: listOf('revoke') as readonly string[] }),
            ...(listOf('clear') === undefined ? {} : { clear: listOf('clear') as readonly string[] }),
          }
          if (Object.keys(change).length > 0) {
            const result = await setPersonSkills(personId, change)
            if (!result.ok) throw new Error(refusalText(result.error))
          }
          const effective = await personEffectiveSkills(personId)
          if (!effective.ok) throw new Error(refusalText(effective.error))
          process.stdout.write(
            effective.value.length === 0
              ? 'no skills\n'
              : `${effective.value.map((row) => `${row.name} (${row.origin})`).join(', ')}\n`,
          )
          return 0
        }

        default:
          process.stderr.write(`unknown person subcommand: ${String(sub)}\n\n${USAGE}`)
          return 1
      }
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
          return { situation, candidates: situationCandidates, ruleChoice: chooseByRules(situationCandidates, situation.kind) }
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
      const { personId } = await personOfSeat(slaveId)
      if (!('yes' in flags)) {
        const footprint = await personFootprint(personId)
        if (footprint === null) throw new Error(refusalText({ kind: 'person_not_found', personId }))
        // M58 R13: the count is the WHOLE point of the confirmation -- deleting a slave from one
        // project's page takes every other project's work with them.
        throw new Error(
          `refusing without --yes: this would delete ${footprint.name} (${personId}) — ` +
            `${plural(footprint.projects.length, 'project')} (${footprint.projects.join(', ') || 'none'}) ` +
            `and ${plural(footprint.runs, 'run')}; all of it goes`,
        )
      }
      const result = await deletePerson(personId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(
        `slave ${personId} deleted: ${plural(result.value.seats, 'seat')} on ` +
          `${result.value.projects.join(', ') || 'no project'}, ${plural(result.value.runs, 'run')} went with them\n`,
      )
      return 0
    }

    // ---- M50 R4: the two verbs a person moves a worker's lifecycle with ------------------------
    case 'release-worker': {
      const slaveId = requireFlag(flags, 'slave')
      const { personId, name } = await personOfSeat(slaveId)
      const result = await releasePerson(personId, requireFlag(flags, 'reason'))
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(
        `released ${name} (${personId}): ${plural(result.value.seatsClosed, 'seat')} closed, ` +
          `${plural(result.value.worktreesCollected, 'worktree')} collected; ` +
          'every run, message and memory they produced is untouched\n',
      )
      return 0
    }

    case 'set-lifecycle': {
      const personFlag = flagText(flags, 'person')
      const slaveFlag = flagText(flags, 'slave')
      if (personFlag === undefined && slaveFlag === undefined) throw new Error('--person or --slave is required')
      const resolved =
        personFlag !== undefined
          ? { personId: personFlag, viaSeat: false }
          : { ...(await personOfSeat(slaveFlag as string)), viaSeat: true }
      // Checked here rather than in the verb: the verb's parameter is typed, and the honest error
      // for a word an operator mistyped is the list of the three there are. `oneOfFlag` is the
      // M49 helper that already words it that way for the memory vocabularies.
      const wanted = oneOfFlag(flags, 'lifecycle', SLAVE_LIFECYCLES)
      if (wanted === undefined) throw new Error('--lifecycle is required')
      const result = await setLifecycle(resolved.personId, wanted)
      if (!result.ok) throw new Error(refusalText(result.error))
      if (resolved.viaSeat) {
        process.stdout.write(
          `a lifecycle belongs to the slave, not the seat: applied to slave ${resolved.personId}, on every project they are on\n`,
        )
      }
      // The LABEL on the way out, the key on the way in (`docs/ia.md` rule 3): an operator types
      // `ephemeral` because that is the value the flag takes, and reads `Ephemeral` because that
      // is what the thing is called.
      process.stdout.write(
        result.value.from === result.value.to
          ? `${resolved.personId} was already ${SLAVE_LIFECYCLE_LABEL[result.value.to]}; nothing changed\n`
          : `${resolved.personId} moved from ${SLAVE_LIFECYCLE_LABEL[result.value.from]} to ${SLAVE_LIFECYCLE_LABEL[result.value.to]}\n`,
      )
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
      const seat = await prisma.slave.findUnique({ where: { id: slaveId }, select: { teamId: true, personId: true } })
      if (seat === null) throw new Error(refusalText({ kind: 'slave_not_found', slaveId }))
      const result = await movePerson(seat.personId, seat.teamId, teamId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`slave ${slaveId} moved to department ${teamId}\n`)
      return 0
    }

    case 'move-company-slave': {
      const personId = requireFlag(flags, 'slave')
      const companyTeamId = requireFlag(flags, 'team')
      // M58 R11: a person can be in more than one department, so "move" is leave-then-join over the
      // departments of the SAME company -- which is what this verb always meant and can now say.
      const person = await prisma.person.findUnique({
        where: { id: personId },
        include: { departments: { include: { companyTeam: { select: { id: true, companyId: true } } } } },
      })
      if (person === null) throw new Error(refusalText({ kind: 'person_not_found', personId }))
      const target = await prisma.companyTeam.findUnique({ where: { id: companyTeamId }, select: { companyId: true } })
      if (target === null) throw new Error(refusalText({ kind: 'company_team_not_found', companyTeamId }))
      for (const membership of person.departments) {
        if (membership.companyTeam.companyId !== target.companyId) continue
        const left = await leaveDepartment(personId, membership.companyTeam.id)
        if (!left.ok) throw new Error(refusalText(left.error))
      }
      const joined = await joinDepartment(personId, companyTeamId)
      if (!joined.ok) throw new Error(refusalText(joined.error))
      process.stdout.write(`${person.name} moved to department template ${companyTeamId}\n`)
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
        const catalogSlaves = await prisma.companyTeamMember.count({ where: { companyTeamId } })
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
        const catalogSlaves = await prisma.companyTeamMember.count({ where: { companyTeam: { companyId } } })
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
      const personId = requireFlag(flags, 'slave')
      const companyTeamId = requireFlag(flags, 'team')
      // M58 R11: this verb used to delete a roster ROW; there is no such row now, and deleting the
      // PERSON would be a far bigger act than the verb's name promises. It removes them from the
      // department -- `person delete` is what deletes somebody, and says so.
      const person = await prisma.person.findUnique({ where: { id: personId }, select: { name: true } })
      if (person === null) throw new Error(refusalText({ kind: 'person_not_found', personId }))
      const left = await leaveDepartment(personId, companyTeamId)
      if (!left.ok) throw new Error(refusalText(left.error))
      process.stdout.write(
        `${person.name} left department template ${companyTeamId}; they keep every project they are on. ` +
          `To delete them entirely: person delete --person ${personId} --yes\n`,
      )
      return 0
    }

    case 'delete-template': {
      const templateId = requireFlag(flags, 'template')
      if (!('yes' in flags)) {
        const template = await prisma.slaveTemplate.findUnique({ where: { id: templateId }, select: { name: true } })
        // M58 R1: `Person.templateId` is `SetNull`, so nothing goes with the template -- what the
        // preview names is how many people stop naming a persona and keep working.
        const persons = await prisma.person.count({ where: { templateId } })
        throw new Error(
          `refusing without --yes: this would delete template ${template?.name ?? templateId} (${templateId}) and unlink ${plural(persons, 'slave')}`,
        )
      }
      const result = await deleteSlaveTemplate(templateId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`template ${templateId} deleted; ${plural(result.value.personsUnlinked, 'slave')} unlinked from it\n`)
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
      // M56a R2: membership from `isProviderKind`, which is this tree's one answer for an untrusted
      // provider string (`packages/control/src/org.ts`). The SENTENCE stays hand-written: it is
      // prose an operator reads, `oneOfFlag` would reword it to "must be one of claude_code,
      // cursor", and this milestone changes no operator-visible text (plan erratum E9).
      if (modelProviderText !== undefined && !isProviderKind(modelProviderText)) throw new Error('--model-provider must be claude_code or cursor')
      const modelProvider = modelProviderText as ProviderKind | undefined
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

    /**
     * M52 R1/R5: the six operations, for one worker.
     *
     * `list` prints all six every time -- a matrix that showed only the decided rows would read as a
     * matrix with four operations in it, and the whole point of default-deny is that "nobody ever
     * asked" is a state a person has to be able to see. `revoke` is the third state's own verb: it
     * DELETES the row, which is the way back from a decision taken in error, where `deny` is a
     * considered refusal.
     */
    case 'permission': {
      const sub = argv[1] ?? 'list'
      const slaveId = requireFlag(flags, 'slave')

      if (sub === 'list') {
        // The run kind is a parameter because the BASELINE is: the same worker reads `baseline` for
        // `run_commands` on an implementation run and `never` on a planning one, and both are true.
        const runKind = oneOfFlag<PermissionRunKind>(flags, 'run-kind', PERMISSION_RUN_KINDS) ?? 'implementation'
        const rows = await prisma.slavePermission.findMany({
          where: { slaveId },
          select: { kind: true, mode: true, grantedBy: true, grantedAt: true },
        })
        // Names, not ids, for whoever decided -- an operator reading `by <uuid>` learns nothing.
        // One query for every author on the matrix, never one per row.
        const authors = await prisma.user.findMany({
          where: { id: { in: rows.map((row) => row.grantedBy).filter((id): id is string => id !== null) } },
          select: { id: true, username: true },
        })
        const nameById = new Map(authors.map((user) => [user.id, user.username]))
        const grants = grantsFor(
          rows.map((row) => ({
            kind: row.kind,
            mode: row.mode,
            grantedBy: row.grantedBy,
            grantedAt: row.grantedAt === null ? null : row.grantedAt.toISOString(),
          })),
          runKind,
        )
        for (const grant of grants) {
          // Label first and the key beside it (`docs/ia.md` rule 3): the word is what a person
          // reads, the key is what they copy into `--kind`, and a CLI's "expanded view" is the line.
          // THE RAW ID IS NEVER VISIBLE TEXT (plan erratum E18). A granter whose `User` row has
          // been deleted since resolves to no name at all, and printing the uuid there would put
          // back exactly what this rule removes -- the web says `a person no longer on record` for
          // that case and the CLI says the same words, so one sentence means one thing on every
          // surface. `somebody unrecorded` is the other null: no principal at the write (the CLI
          // and the daemon carry none), which is a different fact and says so.
          const granter =
            grant.by === null ? 'somebody unrecorded' : (nameById.get(grant.by) ?? 'a person no longer on record')
          const decided =
            grant.by === null && grant.at === null ? '' : `\tby ${granter}${grant.at === null ? '' : ` at ${grant.at}`}`
          process.stdout.write(
            `${PERMISSION_LABEL[grant.kind]}\t${grant.kind}\t${grant.mode ?? 'unset'}\t${grant.source}${decided}\n`,
          )
        }
        return 0
      }

      const kind = requireFlag(flags, 'kind')
      // BEFORE the write, so a `--by` nobody carries refuses instead of leaving a row behind.
      const principal = await resolvePrincipal(flags)

      if (sub === 'grant' || sub === 'deny') {
        const mode = sub === 'grant' ? 'allow' : 'deny'
        const result = await setSlavePermission(slaveId, kind, mode, principal)
        if (!result.ok) throw new Error(refusalText(result.error))
        process.stdout.write(
          `${PERMISSION_LABEL[kind as PermissionKind]} (${kind}) is ${mode === 'allow' ? 'allowed' : 'denied'} for slave ${slaveId}\n`,
        )
        return 0
      }
      if (sub === 'revoke') {
        const result = await clearSlavePermission(slaveId, kind, principal)
        if (!result.ok) throw new Error(refusalText(result.error))
        process.stdout.write(
          `${PERMISSION_LABEL[kind as PermissionKind]} (${kind}) is back to nobody-has-decided for slave ${slaveId}\n`,
        )
        return 0
      }
      throw new Error('permission takes list, grant, deny or revoke')
    }

    /**
     * M52 R3: what a brokered operation may be run WITH -- a name and a variable, never a value.
     *
     * There is no `credential show` and no way to ask whether a variable is set: that question is
     * an enumeration oracle pointed at the daemon's own environment, and the broker's
     * `credential_unset` refusal is the one place it is answered, about one operation, at the
     * moment it matters.
     */
    case 'credential': {
      const sub = argv[1] ?? 'list'
      const workspaceId = await resolveWorkspace(flags)
      if (sub === 'add') {
        const kind = oneOfFlag<CredentialKind>(flags, 'kind', CREDENTIAL_KINDS)
        if (kind === undefined) throw new Error(`--kind must be one of ${CREDENTIAL_KINDS.join(', ')}`)
        const result = await addCredential(
          workspaceId,
          { name: requireFlag(flags, 'name'), kind, envVar: requireFlag(flags, 'env-var') },
          await resolvePrincipal(flags),
        )
        if (!result.ok) throw new Error(refusalText(result.error))
        process.stdout.write(
          `credential ${result.value.name} (${CREDENTIAL_KIND_LABEL[result.value.kind]}) registered: the ` +
            `orchestrator reads ${result.value.envVar} from its own environment when an operation bound ` +
            'to it runs\n',
        )
        return 0
      }
      if (sub === 'list') {
        for (const credential of await listCredentials(workspaceId)) {
          // The WORD, never the key (`docs/ia.md` rule 3). Unlike `permission list` and
          // `broker list`, no column here carries the raw value beside it: nothing an operator
          // types takes a credential kind as an argument, so the key would be a column nobody
          // could use.
          process.stdout.write(
            `${credential.name}\t${CREDENTIAL_KIND_LABEL[credential.kind]}\t${credential.envVar}\t` +
              `${credential.createdAt.toISOString()}\n`,
          )
        }
        return 0
      }
      throw new Error('credential takes add or list')
    }

    case 'broker': {
      const sub = argv[1] ?? 'list'
      // The worker's own verb comes first and returns before a workspace is ever resolved: it has
      // no database to resolve one against. Every other subcommand below is an ordinary operator
      // verb in the shape this file has fifty of.
      if (sub === 'run') return await runBrokerClient(argv, flags)

      const workspaceId = await resolveWorkspace(flags)
      if (sub === 'bind') {
        const credentialName = flagText(flags, 'credential')
        const result = await bindBrokerOp(
          workspaceId,
          {
            op: requireFlag(flags, 'op'),
            command: flagList(flags, 'command'),
            ...(credentialName === undefined ? {} : { credentialName }),
          },
          await resolvePrincipal(flags),
        )
        if (!result.ok) throw new Error(refusalText(result.error))
        process.stdout.write(
          `${brokerOpLabel(result.value.op)} (${result.value.op}) runs ${result.value.command.join(' ')}\n` +
            // The parenthetical only when there is a name to put in it (fix round 1, review
            // Minor 3): a binding with a variable and no credential name printed `(credential )`.
            (result.value.envVar === null
              ? '  with no credential\n'
              : result.value.credentialName === null
                ? `  with ${result.value.envVar}\n`
                : `  with ${result.value.envVar} (credential ${result.value.credentialName})\n`),
        )
        return 0
      }
      if (sub === 'list') {
        for (const binding of await listBrokerBindings(workspaceId)) {
          process.stdout.write(
            `${brokerOpLabel(binding.op)}\t${binding.op}\t${binding.command.join(' ')}\t` +
              `${binding.credentialName ?? '-'}\t${binding.envVar ?? '-'}\n`,
          )
        }
        return 0
      }
      throw new Error('broker takes run, bind or list')
    }

    /**
     * M53 R12: the fact table, as lines. A READ ONLY -- there is no `evidence record` and no
     * `evidence delete`: the pipeline is the only writer (R3) and a row is never deleted, so a verb
     * that wrote one by hand would be a second derivation with a person's hand in it. Filling in
     * history is `npm run backfill:evidence`, a script an operator runs deliberately, and not a
     * subcommand somebody reaches by tab completion (plan decision D30).
     *
     * `listEvidence` caps at 200 rows (`packages/control/src/evidence.ts`'s
     * `LIST_EVIDENCE_LIMIT`) and this verb takes no `--limit`. The cap is NAMED in the usage text
     * (final wave, carried minor): an operator who reads 200 lines and is told nothing cannot tell
     * whether that is the whole record or the top of it.
     */
    case 'evidence': {
      const sub = argv[1] ?? 'list'
      if (sub !== 'list') throw new Error('evidence takes list')
      // `--workspace` NARROWS; omitting it is every project. Unlike every other verb in this file
      // this one does not resolve a single project by default: a record is a claim about a
      // PROFILE, and a profile works on more than one project.
      const workspaceId = flagText(flags, 'workspace') === undefined ? null : await resolveWorkspace(flags)
      const domain = flagText(flags, 'domain') ?? null
      for (const row of await listEvidence({ workspaceId, domain })) {
        // The WORDS first and the keys beside them (`docs/ia.md` rule 3): the label is what a person
        // reads, the key is what they paste into `--domain`, and a CLI's "expanded view" is the line.
        // A null `model` is `Model not recorded` and never a blank column -- every pre-M51 run
        // recorded none, and a blank reads as a model called nothing (R1).
        process.stdout.write(
          `${row.profileName}\t${row.profileKey}\t${row.model ?? MODEL_NOT_RECORDED_LABEL}\t` +
            `${row.domains.map(domainLabel).join(', ')}\t${EVIDENCE_OUTCOME_LABEL[row.outcome]}\t` +
            `attempt ${String(row.attempt)}\t${COST_PROVENANCE_WORD[row.costProvenance]}\t` +
            `${row.recordedAt.toISOString()}\n`,
        )
      }
      return 0
    }

    /** M53 R9: who -- or what model -- should take a capability on this project. */
    case 'staffing': {
      const sub = argv[1] ?? 'list'
      const workspaceId = await resolveWorkspace(flags)
      if (sub === 'list') {
        const rows = await listStaffingPreferences(workspaceId)
        // Names, not ids, for whoever decided -- one query for every author on the table, never one
        // per row. `StaffingPreference.setBy` is a `User.id` and control deliberately leaves it one
        // ("resolving it to a username is each surface's own boundary"); THIS is that boundary.
        const authors = await prisma.user.findMany({
          where: { id: { in: rows.map((one) => one.setBy).filter((id): id is string => id !== null) } },
          select: { id: true, username: true },
        })
        const nameById = new Map(authors.map((user) => [user.id, user.username]))
        for (const one of rows) {
          // THE RAW ID IS NEVER VISIBLE TEXT (M52 erratum E18). An account deleted since resolves to
          // no name at all, and printing the uuid there would put back exactly what this rule
          // removes -- so the CLI says the words the web says for that state. `somebody unrecorded`
          // is the other null: no principal at the write, which is a different fact.
          const setter =
            one.setBy === null ? 'somebody unrecorded' : (nameById.get(one.setBy) ?? 'a person no longer on record')
          process.stdout.write(
            `${one.capabilityLabel}\t${one.capability}\t${one.templateName ?? '-'}\t${one.model ?? '-'}\t` +
              `${one.setAt.toISOString()}\tby ${setter}\n`,
          )
        }
        return 0
      }
      const capability = requireFlag(flags, 'capability')
      // BEFORE the write, so a `--by` nobody carries refuses instead of leaving a row behind.
      const principal = await resolvePrincipal(flags)
      if (sub === 'prefer') {
        const templateId = flagText(flags, 'template')
        const model = flagText(flags, 'model')
        const result = await setStaffingPreference(
          workspaceId,
          { capability, ...(templateId === undefined ? {} : { templateId }), ...(model === undefined ? {} : { model }) },
          principal,
        )
        if (!result.ok) throw new Error(refusalText(result.error))
        process.stdout.write(
          `${result.value.capabilityLabel} (${capability}) goes to ` +
            `${result.value.templateName ?? 'whoever is free'}${result.value.model === null ? '' : ` on ${result.value.model}`}\n`,
        )
        return 0
      }
      if (sub === 'clear') {
        // The LABEL read BEFORE the clear, because `clearStaffingPreference` answers `void` and a
        // line naming only the key would be the one line of this verb without a word on it
        // (`docs/ia.md` rule 3). One row, and the fallback is `capabilityLabel`'s own: a key this
        // taxonomy does not carry prints as itself, which is the honest thing to show for it.
        const known = await prisma.capability.findUnique({ where: { key: capability }, select: { label: true } })
        const result = await clearStaffingPreference(workspaceId, capability, principal)
        if (!result.ok) throw new Error(refusalText(result.error))
        process.stdout.write(
          `nobody in particular is asked for on ${known?.label ?? capability} (${capability}) any more\n`,
        )
        return 0
      }
      throw new Error('staffing takes prefer, clear or list')
    }

    /**
     * M54 R12: what may tell this installation something, and what has.
     *
     * The ONE place a mapping is made. There is no web form, deliberately: connecting a repository
     * is a one-off installation act that must be paired with exporting a variable into the WEB
     * process's environment and pasting a url into a provider's settings, and a form that can do
     * only the first of the three would imply the other two happened.
     *
     * This verb never creates the webhook at the provider (no outbound call, no token), never
     * disables a hook without unmapping it, and offers no "test delivery" button -- a provider's
     * own redelivery is the test, and it exercises the real path.
     *
     * And it never says whether a variable is SET. `addCredential`'s own comment calls that an
     * enumeration oracle pointed at a daemon's environment; the web process's is no different, and
     * the one place the question is answered is the log line a refused delivery writes (R10).
     */
    case 'triggers': {
      const sub = argv[1] ?? 'list'
      if (sub === 'map') {
        const source = oneOfFlag<ExternalSource>(flags, 'source', EXTERNAL_SOURCES)
        if (source === undefined) throw new Error(`--source must be one of ${EXTERNAL_SOURCES.join(', ')}`)
        const result = await mapExternalRepository(
          await resolveWorkspace(flags),
          {
            source,
            repository: requireFlag(flags, 'repository'),
            secretEnvVar: requireFlag(flags, 'secret-env'),
          },
          await resolvePrincipal(flags),
        )
        if (!result.ok) throw new Error(await mapRefusalText(result.error))
        // The three things an operator still has to do, in the order they have to do them. The last
        // line is the whole reason there is no form: this verb cannot export a variable and cannot
        // reach a provider, and saying so is better than implying otherwise by silence. The PATH
        // and the variable's NAME travel to the provider separately -- the operator pairs them
        // there, and nothing in this process ever holds the value.
        process.stdout.write(
          `${result.value.repository} on ${EXTERNAL_SOURCE_LABEL[result.value.source]} now belongs to ` +
            `${result.value.workspaceName}\n` +
            `  paste this path into the repository's webhook settings: ${result.value.hookPath}\n` +
            `  export the signing secret as ${result.value.secretEnvVar} in the web process's environment\n` +
            '  this verb does not create the webhook and does not tell you whether that variable is set\n',
        )
        return 0
      }
      if (sub === 'unmap') {
        const source = oneOfFlag<ExternalSource>(flags, 'source', EXTERNAL_SOURCES)
        if (source === undefined) throw new Error(`--source must be one of ${EXTERNAL_SOURCES.join(', ')}`)
        const repository = requireFlag(flags, 'repository')
        const result = await unmapExternalRepository(
          await resolveWorkspace(flags),
          { source, repository },
          await resolvePrincipal(flags),
        )
        if (!result.ok) throw new Error(refusalText(result.error))
        process.stdout.write(
          `${repository} on ${EXTERNAL_SOURCE_LABEL[source]} no longer reaches this installation; every ` +
            'delivery it already made is still recorded\n',
        )
        return 0
      }
      if (sub === 'list') {
        // `--workspace` NARROWS; omitting it is every project. An operator checking a fresh install
        // is asking about the INSTALLATION, and a mapping is the installation's own state.
        const workspaceId = flagText(flags, 'workspace') === undefined ? null : await resolveWorkspace(flags)
        for (const row of await listExternalRepositories(workspaceId)) {
          // The WORDS first and the keys beside them (`docs/ia.md` rule 3): the label is what a
          // person reads, the key is what they type into `--source`, and a CLI's expanded view is
          // the line. The project is its NAME, never the id it was addressed by; the variable is a
          // NAME too, and nothing here reads what is in it.
          process.stdout.write(
            `${row.workspaceName}\t${EXTERNAL_SOURCE_LABEL[row.source]}\t${row.source}\t${row.repository}\t` +
              `${row.secretEnvVar}\t${row.hookPath}\t${row.createdAt.toISOString()}\n`,
          )
        }
        return 0
      }
      if (sub === 'inbound') {
        const workspaceId = flagText(flags, 'workspace') === undefined ? null : await resolveWorkspace(flags)
        // `listInboundEvents` applies `LIST_INBOUND_LIMIT` itself and this verb takes no `--limit`;
        // the cap is NAMED in the usage text (`evidence list`'s own choice for its own reason), so
        // an operator who reads 200 lines can tell the whole record from the top of it.
        const rows = await listInboundEvents({ workspaceId })
        // The PROJECT column (fix-wave item 25). `listInboundEvents` answers a `workspaceId`, which
        // is an id and never visible text (M52 erratum E18), and this is the boundary that resolves
        // one -- the same one `triggers map`'s refusal and `staffing list` cross. ONE read for the
        // whole page rather than one per line, and `-` for the two rows that legitimately have no
        // project: a delivery for a repository nobody mapped, and one a hook may not speak for.
        const ids = [...new Set(rows.map((row) => row.workspaceId).filter((id): id is string => id !== null))]
        const names = new Map(
          (ids.length === 0
            ? []
            : await prisma.workspace.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
          ).map((workspace) => [workspace.id, workspace.name]),
        )
        for (const row of rows) {
          // The delivery id IS printed here and on no page (R9): it is the correlation id an
          // operator pastes into a provider's own delivery log, and this is an operator's terminal.
          process.stdout.write(
            `${row.receivedAt.toISOString()}\t${row.workspaceId === null ? '-' : (names.get(row.workspaceId) ?? '-')}\t` +
              `${EXTERNAL_SOURCE_LABEL[row.source]}\t${row.repository}\t` +
              `${EXTERNAL_KIND_LABEL[row.eventKind]}\t${INBOUND_EVENT_STATUS_LABEL[row.status]}\t` +
              `${row.ignoredReason === null ? '-' : EXTERNAL_IGNORED_REASON_LABEL[row.ignoredReason]}\t` +
              `${row.goalVersion === null ? '-' : `v${String(row.goalVersion)}`}\t${row.deliveryId}\n`,
          )
        }
        return 0
      }
      throw new Error('triggers takes map, unmap, list or inbound')
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
