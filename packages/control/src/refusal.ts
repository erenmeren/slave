/**
 * Why a control operation (`requestPause`, `requestStop`, and — Task 4 — resume) declined to act.
 *
 * `workspace_halted` and `no_checkpoint` are defined here now, ahead of Task 4's resume logic that
 * will produce them, so the taxonomy is whole from the start rather than grown one refusal at a
 * time across tasks that each own a slice of it. `unmeasurable_budget` follows the same
 * convention: it is defined here (M12 Task 7) ahead of the budget admission logic (Task 9) that
 * will actually raise it.
 */
import { sectors } from '@slave-of-ai/simulation'
import { plural } from './plural.js'

export type ControlRefusal =
  | { readonly kind: 'run_not_found'; readonly runId: string }
  | {
      readonly kind: 'wrong_status'
      readonly runId: string
      readonly status: string
      readonly needed: readonly string[]
    }
  | { readonly kind: 'workspace_halted'; readonly workspaceId: string; readonly reason: string }
  /** `admitRun` on an archived project (M27 §3.3): nothing dispatches for it until `restore-workspace`. */
  | { readonly kind: 'workspace_archived'; readonly workspaceId: string }
  /** `archiveWorkspace` on a project that is already archived (M27 §3.2). */
  | { readonly kind: 'already_archived'; readonly workspaceId: string }
  /** `restoreWorkspace` on a project that is not archived (M27 §3.2). */
  | { readonly kind: 'not_archived'; readonly workspaceId: string }
  /** M27 §2: every destructive verb refuses while a run is live. `entity` names what was being
   *  archived or deleted; `runs` how many non-terminal runs stood in the way. */
  | { readonly kind: 'live_runs'; readonly entity: 'workspace' | 'team' | 'slave'; readonly id: string; readonly runs: number }
  | { readonly kind: 'no_checkpoint'; readonly runId: string }
  /**
   * The run's row says `paused` but its process is still alive (M13 §3.2). The pump's ordering
   * (Task 1) is supposed to make this unreachable; this is the SECOND lock (Decision 3), and it is
   * cheap: it turns a future ordering regression into a refusal instead of two slaves on one branch.
   */
  | { readonly kind: 'run_still_stopping'; readonly runId: string }
  /** `requestPause` claimed the run but `signalPause` threw; the claim was rolled back (M13 §3.4). */
  | { readonly kind: 'pause_unsignalled'; readonly runId: string; readonly reason: string }
  /**
   * The run's provider cannot continue a session it stopped (`canResumeSession: false`), so there
   * is no resume to record (M12 final review I1, spec §4). Unreachable for both shipped providers,
   * which is why it is defined with the rest of the taxonomy rather than at its one raise site.
   */
  | { readonly kind: 'provider_cannot_resume'; readonly runId: string; readonly provider: string }
  | { readonly kind: 'task_not_found'; readonly taskId: string }
  /** `confirmIntegration` (M35 t2) on a task that has not reached `done` yet -- only a done task's
   *  work is even in a state that could be "integrated". */
  | { readonly kind: 'task_not_done'; readonly taskId: string; readonly status: string }
  /** `confirmIntegration` on a task whose `integratedAt` is already set -- a second confirmation
   *  is a no-op the caller should know did nothing, not a silent success. */
  | { readonly kind: 'already_integrated'; readonly taskId: string }
  /** `unblockTask` (M35 t5) on a task that is not `blocked` -- only a blocked task has anything
   *  for this verb to do. Same shape as `task_not_done`: this milestone's precedent for "the verb
   *  needs one specific status and the task carries a different one". */
  | { readonly kind: 'task_not_blocked'; readonly taskId: string; readonly status: string }
  /**
   * `unblockTask` on a task that carries `activeRunId` despite being `blocked` -- every one of the
   * four parks (`tick.ts`, `verify.ts`, `review.ts`, `stop.ts`) clears it in the SAME write that
   * sets `blocked`, so a blocked task with one set is not a state this verb's own precondition
   * checks can repair with confidence: the run it points at might still mean something to
   * whichever path left it there. Refused rather than silently cleared (M35 t5 judgment call 2).
   */
  | { readonly kind: 'task_run_active'; readonly taskId: string; readonly runId: string }
  /**
   * `unblockTask` on a task already at (or, after a lowered `maxAttempts`, past) its attempt
   * ceiling, with no explicit allowance given. `attempt` is never reset by this verb (M35 t5
   * judgment call 3) -- an un-block that did not also raise the ceiling would hand the task
   * straight back to whatever next failure re-blocks or re-fails it, so the ceiling is enforced
   * here rather than left to repeat the trip.
   */
  | { readonly kind: 'attempt_ceiling_reached'; readonly taskId: string; readonly attempt: number; readonly maxAttempts: number }
  | { readonly kind: 'self_dependency'; readonly taskId: string }
  | { readonly kind: 'duplicate_dependency'; readonly taskId: string; readonly dependsOnTaskId: string }
  /**
   * Two members share this literal (M36 t1 reused it rather than mint a second name for the same
   * refused thing): `dependency.ts`'s own shape above, and `sendMessage`'s below, refusing a named
   * recipient in another workspace. `refusalText`'s one `case 'cross_workspace'` distinguishes
   * them with `'taskId' in refusal` -- TypeScript cannot narrow a discriminated union further than
   * "one of these shapes" when two members carry the same tag, so this is the one place in the
   * file that checks a second field instead of switching on `kind` alone.
   */
  | { readonly kind: 'cross_workspace'; readonly taskId: string; readonly dependsOnTaskId: string }
  | { readonly kind: 'cross_workspace'; readonly runId: string; readonly recipientSlaveId: string }
  | { readonly kind: 'dependency_not_found'; readonly taskId: string; readonly dependsOnTaskId: string }
  | { readonly kind: 'dependency_cycle'; readonly taskId: string; readonly dependsOnTaskId: string }
  | { readonly kind: 'workspace_not_found'; readonly workspaceId: string }
  | { readonly kind: 'invalid_goal' }
  /**
   * M45 R3: `requestChange` was handed a blank request. Distinct from `invalid_goal` because
   * nothing about the GOAL was wrong -- a person pressed "Tell the Supervisor" with an empty box,
   * and telling them a goal must be non-empty would name the wrong thing.
   */
  | { readonly kind: 'invalid_request' }
  /**
   * M45 spec erratum E27: `requestChange` was handed the request the NEWEST goal version already
   * records -- a double-submitted "Tell the Supervisor". Writing it would make a second version of
   * a document nobody changed and arm a second delta re-plan for it, which is the expensive half.
   * Distinct from `goal_unchanged` because the composed TEXT does differ (the entry is dated and
   * appended); what repeats is the request.
   */
  | { readonly kind: 'duplicate_request'; readonly workspaceId: string; readonly version: number }
  /**
   * M40 erratum E5: `setGoal` was handed text that hashes to the CURRENT goal version's, so there
   * is nothing to record -- no row, no event, no cache move. A refusal rather than a silent
   * success because a version is what the re-plan trigger counts: manufacturing one for a re-save
   * of an unedited goal would dispatch a re-plan run for a requirement that did not change.
   * `version` is the version it is unchanged FROM.
   */
  | { readonly kind: 'goal_unchanged'; readonly workspaceId: string; readonly version: number }
  | { readonly kind: 'duplicate_name'; readonly name: string }
  | { readonly kind: 'template_not_found'; readonly templateId: string }
  /** M47 R1: a capability key nothing in the taxonomy table has. Nothing matches on a key that is
   *  not a row -- `capabilities add` is how one gets there. */
  | { readonly kind: 'capability_not_found'; readonly key: string }
  /** M47 R1: a key, label or role that cannot become a taxonomy row (a malformed key, a blank
   *  label, a role that is not a role, a key that already exists). */
  | { readonly kind: 'invalid_capability'; readonly detail: string }
  /**
   * M48 t1: an approved `adopt_runbook` decision reached `carryOut` and there is no verb behind it
   * yet -- Task 2 writes `adoptRunbook`, and this arm's body becomes a call to it.
   *
   * TEMPORARY, and unreachable today: `loadSupervisorWorld` fills `runbooks` with the empty list,
   * so `observe` never raises `runbook_recommended`, so no `adopt_runbook` decision can exist to be
   * approved. It is here because `carryOut`'s switch is exhaustive over `Action` and spec §4 says a
   * Supervisor action that cannot be carried out is RECORDED (as `supervisor.failed`), never thrown
   * and never reported as applied.
   */
  | { readonly kind: 'runbook_adoption_unavailable'; readonly runbookId: string }
  /** M46 R2: `profileOverrides` are a partial of `profileSpec`, and there is no spec on this row to
   *  be partial OF -- a hand-made template, or one whose catalog has not been imported since M46.
   *  Refused rather than invented: writing overrides against an empty spec would re-render the
   *  Markdown of a template whose profile a person wrote by hand. */
  | { readonly kind: 'profile_not_structured'; readonly templateId: string }
  /** M46 R2: the patch does not match `profileOverridesSchema`. */
  | { readonly kind: 'invalid_profile_overrides'; readonly detail: string }
  /** M46 R2: `clearProfileOverride` was asked for a field that is not one an operator may take
   *  over -- `PROFILE_OVERRIDABLE_FIELDS`, the thirteen (plan erratum E21 keeps `runtimeRole` out
   *  of them, so clearing it is as meaningless as setting it). */
  | { readonly kind: 'unknown_profile_field'; readonly field: string }
  | { readonly kind: 'company_not_found'; readonly companyId: string }
  | { readonly kind: 'company_team_not_found'; readonly companyTeamId: string }
  /** `deleteCompanySlave` on a `companySlaveId` no `CompanySlave` row carries (M27 §5). */
  | { readonly kind: 'company_slave_not_found'; readonly companySlaveId: string }
  | { readonly kind: 'invalid_name' }
  | { readonly kind: 'invalid_model' }
  /** A budget was set to something that is neither a non-negative number nor `null` (M13 §6.1). */
  | { readonly kind: 'invalid_budget' }
  /** A model was set (or cleared) with no provider to match it, or vice versa (M12 Task 7). */
  | { readonly kind: 'model_without_provider' }
  /** `provider` named a string that is not a member of `ProviderKind` (M12 Task 7). */
  | { readonly kind: 'invalid_provider'; readonly provider: string }
  /**
   * A workspace budget was set on a provider that never reports cost (M12 Task 9, not raised
   * yet -- see the header comment above).
   */
  | { readonly kind: 'unmeasurable_budget'; readonly workspaceId: string; readonly provider: string }
  | { readonly kind: 'company_already_assigned'; readonly workspaceId: string; readonly companyName: string }
  | { readonly kind: 'slave_not_found'; readonly slaveId: string }
  /** A role was set (or re-set) to blank text (M23 D1). */
  | { readonly kind: 'invalid_role' }
  /**
   * `setSlaveRole` (and `deleteSlave`) on a slave that holds a run in a
   * `NON_TERMINAL_RUN_STATUSES` status (M23 D1).
   *
   * The original reason was dispatch: the scheduler matched `Task.requiredRole` to `Slave.role` by
   * equality, so re-rolling mid-run stranded the decision the run started with. M37 t3 moved that
   * match to `Slave.runtimeRoles` and left the refusal standing on a better reason: `role` is the
   * TITLE rendered into a live run's prompt (`displayName`, the ask roster, message envelopes) and
   * recorded verbatim in its `RunContext` row, so renaming it under a live run leaves the record
   * and the roster disagreeing about who that run is.
   */
  | { readonly kind: 'slave_run_active'; readonly slaveId: string; readonly runId: string }
  /** `renameTeam`/`deleteTeam` on a `teamId` no `Team` row carries (M23 D1). */
  | { readonly kind: 'team_not_found'; readonly teamId: string }
  /** `moveSlave`'s target department belongs to another project than the slave (M25 §3.1). */
  | { readonly kind: 'team_workspace_mismatch'; readonly slaveId: string; readonly teamId: string }
  /** `moveCompanySlave`'s target department template belongs to another company than the catalog
   *  slave (M25 §3.1). */
  | { readonly kind: 'company_mismatch'; readonly companySlaveId: string; readonly companyTeamId: string }
  /** A skill id that no `Skill` row carries (M14 §4.3). */
  | { readonly kind: 'skill_not_found'; readonly skillId: string }
  /** A permission tool outside `PERMISSION_TOOLS` (M14 §5.7). */
  | { readonly kind: 'invalid_tool'; readonly tool: string }
  /** A permission mode that is neither `allow` nor `deny`. */
  | { readonly kind: 'invalid_permission_mode'; readonly mode: string }
  /** `createWorkspace`'s `repoPath` was not an absolute path (M23 A1, spec §2 A1). */
  | { readonly kind: 'repo_path_not_absolute'; readonly path: string }
  /** No directory exists at `createWorkspace`'s `repoPath`. */
  | { readonly kind: 'repo_not_found'; readonly path: string }
  /** `repoPath` exists but is not a git work tree (`GitProbe.isRepository` said so). */
  | { readonly kind: 'not_a_git_repository'; readonly path: string }
  /** The requested (or default `main`) base branch does not exist in the repository. */
  | { readonly kind: 'base_branch_not_found'; readonly path: string; readonly branch: string }
  /** Spec §10: a workspace with no verify command can never reach `done` on its own. */
  | { readonly kind: 'verify_commands_empty' }
  /** `collectTaskWorktree` (M23 B2): the task has not yet reached one of `TERMINAL`'s statuses. */
  | { readonly kind: 'task_not_terminal'; readonly taskId: string; readonly status: string }
  /** `collectTaskWorktree`: a run on the task is still non-terminal, or its process is still alive
   *  by pid -- either way its worktree may still be in use. */
  | { readonly kind: 'run_still_alive'; readonly taskId: string; readonly runId: string }
  /** `collectTaskWorktree`: no run on this (terminal) task carries a worktree path to remove. */
  | { readonly kind: 'nothing_to_collect'; readonly taskId: string }
  /** `collectTaskWorktree` (M23 B2 fix round 1): `git worktree remove`/`prune` itself threw,
   *  inside the row-locked transaction -- the row is left untouched (nothing was written before
   *  the throw) so a retry sees the same terminal task with the same path. */
  | { readonly kind: 'worktree_remove_failed'; readonly taskId: string; readonly path: string; readonly reason: string }
  /** `createUser`'s `username` does not match `USERNAME_RE` (M23 F3). */
  | { readonly kind: 'invalid_username'; readonly username: string }
  /** `createUser`/`setPassword`'s `password` is shorter than `MIN_PASSWORD_LENGTH` (M23 F3). */
  | { readonly kind: 'weak_password'; readonly minimum: number }
  /** `setPassword`/`deleteUser` on a `username` no `User` row carries (M23 F3). */
  | { readonly kind: 'user_not_found'; readonly username: string }
  /** M29: the simulation verbs (`simulation.ts`). */
  | { readonly kind: 'simulation_not_found'; readonly simulationId: string }
  | { readonly kind: 'unsupported_simulation'; readonly sector: string; readonly mode: string }
  | { readonly kind: 'simulation_not_runnable'; readonly simulationId: string; readonly status: string }
  | { readonly kind: 'stale_version'; readonly simulationId: string; readonly expected: number; readonly actual: number }
  | { readonly kind: 'simulation_corrupt'; readonly simulationId: string; readonly reason: string }
  /** `deleteCompany` while simulation runs still reference the company (M29 §3). */
  | { readonly kind: 'live_simulations'; readonly companyId: string; readonly simulations: number }
  | { readonly kind: 'invalid_simulation_input'; readonly detail: string }
  /** `stepSimulation` on a run whose `decisionProvider` is `llm` (M31a §3): its steps happen in
   *  the auto-run daemon, not through the manual step verb. */
  | { readonly kind: 'llm_steps_in_daemon'; readonly simulationId: string }
  /** `createSimulation`'s `modelProvider` named a provider this simulation cannot run on --
   *  either it isn't a `ProviderKind` at all, or (`cursor`) it reports no cost so a
   *  `maxModelCostUsd` cap could never be enforced (M31a §3). */
  | { readonly kind: 'unsupported_model_provider'; readonly provider: string; readonly reason: string }
  /** M33 §3: `adoptSimulation`/`adoptionPreview` on a run whose sector says its organisation does
   *  not map onto software work. The `reason` is the SECTOR's own sentence
   *  (`SectorPlugin.adoptable`), printed verbatim -- control never writes a sector's reason for
   *  it. */
  | { readonly kind: 'not_adoptable'; readonly simulationId: string; readonly reason: string }
  /** M36 t1: the messaging verbs (`messaging.ts`). `sendMessage`'s recipient named neither a
   *  worker nor a role, or named both -- exactly one must identify who a message is addressed
   *  to. */
  | { readonly kind: 'invalid_recipient'; readonly detail: string }
  /** `sendMessage`'s `body` was blank. */
  | { readonly kind: 'invalid_message_body' }
  /** `sendMessage`'s `replyToId`, or `markMessageRead`'s `messageId`, named no row in this
   *  workspace -- including a row that exists but belongs to another workspace, which reads back
   *  the same as "does not exist" from a scoped caller's side of the boundary. */
  | { readonly kind: 'message_not_found'; readonly messageId: string }
  /** `markMessageRead` on a message addressed to neither this slave nor a role it holds. */
  | { readonly kind: 'not_message_recipient'; readonly messageId: string; readonly slaveId: string }
  /** M36 t3: `answerQuestion` was pointed at a message that is not a `question` -- an answer to an
   *  `information` or a `handoff` has nobody waiting on it, and nothing to resume. */
  | { readonly kind: 'not_a_question'; readonly messageId: string; readonly messageKind: string }
  /** M39 t2: `reassignQuestion` was pointed at a message that is not a `question`. Its own kind,
   *  rather than `not_a_question`'s wording: re-addressing is about WHO a row waits on, and an
   *  `information` or a `handoff` waits on nobody, so there is nothing to move. */
  | { readonly kind: 'message_not_question'; readonly messageId: string }
  /** M39 t2: the question is no longer waiting on anybody -- a reply has landed, or the asking run
   *  has stopped waiting for one (`stillPendingQuestion`'s definition, shared with the worker's own
   *  inbox). Re-addressing it would put a settled question in a second worker's inbox. */
  | { readonly kind: 'question_answered'; readonly messageId: string }
  /**
   * M39 t2: the worker named cannot answer this question, so moving it there would only hide it.
   *
   * The same rule `answerBar` (`@slave-of-ai/domain`) stamps a routine `reassign_question` with --
   * literally the same function, called from both sides -- enforced here at the write: the asker
   * never, a role-addressed question needs a holder of THAT role, and a slave-addressed one falls
   * back to the asker's task's `requiredRole`. `reason` is a whole sentence because the cases need
   * different fixes -- staff the role first, or pick somebody else.
   */
  | { readonly kind: 'reassign_not_permitted'; readonly messageId: string; readonly slaveId: string; readonly reason: string }
  /** M39 t2: `applyDecision`/`approveDecision` on an `answer_question` decision that carries no
   *  draft, or one whose `body` is null (erratum E2's escalated shape -- the lexicon stopped it
   *  before a model ever saw it). There is no text to send, and the Supervisor never writes one
   *  at apply time. Also what an EDIT is refused with when the decision is not an answer at all. */
  | { readonly kind: 'draft_missing'; readonly decisionId: string }
  /** M37 t3: `setProfile`'s text is longer than `PROFILE_MAX_CHARS` (`@slave-of-ai/domain`),
   *  measured after trimming. `limit` and `length` are both carried so the message can say how far
   *  over it is without the caller re-measuring -- and so a web form can show it. The same cap is
   *  re-checked at dispatch by `buildRunContext`, which is the only way a stored profile can be
   *  over it (the constant was lowered after the text was written). */
  | { readonly kind: 'profile_too_long'; readonly limit: number; readonly length: number }
  /** M37 t3: `setRuntimeRoles` was given a set it will not write -- a blank entry, a duplicate
   *  (after trimming), or more than `MAX_RUNTIME_ROLES` of them. NOT for an empty set, which is a
   *  real, deliberate state: a worker with no runtime roles cannot be dispatched, and
   *  `set-runtime-roles --roles ''` is how an operator parks one. The `reason` is a whole
   *  sentence, because the three cases need three different fixes. */
  | { readonly kind: 'invalid_runtime_roles'; readonly reason: string }
  /** M38 t2: `approveDecision`/`rejectDecision`/`applyDecision` was pointed at a decision id no
   *  `SupervisorDecision` row has -- including one in another project, which reads back the same
   *  as "does not exist" from a scoped caller's side of the boundary (`message_not_found`'s rule). */
  | { readonly kind: 'decision_not_found'; readonly decisionId: string }
  /** M38 t2: the decision exists but has already left `pending` -- approved, rejected, expired,
   *  applied at birth, or failed. `status` is what it is NOW, which is the whole answer to "why
   *  can I not approve this": someone (or `expirePendingDecisions`) got there first. */
  | { readonly kind: 'decision_not_pending'; readonly decisionId: string; readonly status: string }
  /**
   * M38 t2: the Supervisor is already on this situation key (spec §1, "idempotent and quiet").
   * Either an open `pending` proposal is waiting on a human, or the last decision for the key
   * stopped being open less than `COOLDOWN_MS` ago. `untilTs` is the ISO instant after which the
   * key is free again, so a caller can say when rather than only that.
   */
  | {
      readonly kind: 'supervisor_cooldown'
      readonly situationKind: string
      readonly subjectId: string
      readonly untilTs: string
    }
  /** M38 t2: `Workspace.supervisorEnabled` is false -- the one narrowing a project may apply
   *  (spec §1). The Supervisor still REPORTS; it records no decision and applies nothing. */
  | { readonly kind: 'supervisor_disabled'; readonly workspaceId: string }
  /** M38 t2: `failTask` was pointed at a task that is not `rework` or `blocked`. Declaring work
   *  dead is only ever the exit from a park a human (or the Supervisor) has looked at; every
   *  other status either has the pipeline still moving it or is already terminal. */
  | { readonly kind: 'task_not_failable'; readonly taskId: string; readonly status: string }
  /** M40 §4: `cancelTask` was pointed at a task that is not `backlog`, `ready` or `blocked`.
   *  Cancelling is for work nobody has started; a task in the pipeline is the pipeline's own to
   *  move, `rework`/`waiting` are attempts already spent (`failTask` is their exit), and `done`,
   *  `failed` and `cancelled` are already terminal. */
  | { readonly kind: 'task_not_cancellable'; readonly taskId: string; readonly status: string }
  /** `importCatalog` with no entries at all (M42 §2): the directory has no persona in it, which is
   *  a mistyped path far more often than an empty catalog, and writing a `CatalogImport` row saying
   *  "nothing happened" would hide that. */
  | { readonly kind: 'catalog_empty'; readonly directory: string }
  /** A `--role-map` entry with an empty half. Refused rather than dropped: silently discarding part
   *  of what an operator typed is how a template ends up dispatchable as something nobody meant --
   *  `normaliseRoles`' own reasoning. */
  | { readonly kind: 'invalid_role_map'; readonly detail: string }

/**
 * The word a person reads for `live_runs`'s `entity` (M27 final review, Important finding 3).
 *
 * The refusal carries the IDENTIFIER's vocabulary -- `Workspace`, `Team`, `Slave` are what the
 * schema and the verbs are named -- and `refusalText` used to interpolate it straight into the
 * sentence, so an operator was told "team 7f3a… has 1 live run(s)". The product's own words are
 * project and department; `refusalText` is the boundary where the two vocabularies meet, so the
 * translation belongs here rather than in every caller that renders a refusal.
 */
const LIVE_RUNS_NOUN: Record<'workspace' | 'team' | 'slave', string> = {
  workspace: 'project',
  team: 'department',
  slave: 'slave',
}

export function refusalText(refusal: ControlRefusal): string {
  switch (refusal.kind) {
    case 'run_not_found':
      return `no run with id ${refusal.runId}`
    case 'wrong_status':
      return `run ${refusal.runId} is ${refusal.status}; this needs one of: ${refusal.needed.join(', ')}`
    case 'workspace_halted':
      return (
        `this workspace is halted (${refusal.reason}). Nothing will run until an operator retracts ` +
        `it with: clear-halt --workspace ${refusal.workspaceId}`
      )
    case 'workspace_archived':
      // Names the verb the way `workspace_halted` names `clear-halt`: the person reading this is
      // most often at the CLI, and "restore it first" left them to guess the spelling.
      return `project ${refusal.workspaceId} is archived; nothing runs until it is restored with: restore-workspace --workspace ${refusal.workspaceId}`
    case 'already_archived':
      return `project ${refusal.workspaceId} is already archived`
    case 'not_archived':
      return `project ${refusal.workspaceId} is not archived`
    case 'live_runs':
      return `${LIVE_RUNS_NOUN[refusal.entity]} ${refusal.id} has ${plural(refusal.runs, 'live run')}; wait for them to finish or stop them first`
    case 'no_checkpoint':
      return `run ${refusal.runId} has no checkpoint: there is nothing to resume it from`
    case 'run_still_stopping':
      return 'the run is still stopping; retry in a moment'
    case 'pause_unsignalled':
      return `the pause could not be signalled to run ${refusal.runId}: ${refusal.reason}`
    case 'provider_cannot_resume':
      return `run ${refusal.runId} is on ${refusal.provider}, which cannot continue a stopped session`
    case 'task_not_found':
      return `no task with id ${refusal.taskId}`
    case 'task_not_done':
      return `task ${refusal.taskId} is ${refusal.status}; only a done task can be confirmed integrated`
    case 'already_integrated':
      return `task ${refusal.taskId} is already integrated`
    case 'task_not_blocked':
      return `task ${refusal.taskId} is ${refusal.status}; only a blocked task can be unblocked`
    case 'task_run_active':
      return `task ${refusal.taskId} is blocked but still carries an active run (${refusal.runId}); this needs an operator's eyes before it is unblocked`
    case 'attempt_ceiling_reached':
      return (
        `task ${refusal.taskId} is at its attempt ceiling (${refusal.attempt}/${refusal.maxAttempts}); ` +
        `unblocking it as-is would only fail it again. Raise the ceiling by exactly one with: ` +
        `unblock-task --task ${refusal.taskId} --allow-another-attempt`
      )
    case 'self_dependency':
      return `task ${refusal.taskId} cannot depend on itself`
    case 'duplicate_dependency':
      return `task ${refusal.taskId} already depends on ${refusal.dependsOnTaskId}`
    case 'cross_workspace':
      return 'taskId' in refusal
        ? `task ${refusal.taskId} and ${refusal.dependsOnTaskId} are in different workspaces`
        : `run ${refusal.runId} cannot send a message to ${refusal.recipientSlaveId}: they are in a different workspace`
    case 'dependency_not_found':
      return `task ${refusal.taskId} does not depend on ${refusal.dependsOnTaskId}`
    case 'dependency_cycle':
      return `adding this dependency would create a cycle: ${refusal.dependsOnTaskId} already depends on ${refusal.taskId}`
    case 'workspace_not_found':
      return `no workspace with id ${refusal.workspaceId}`
    case 'invalid_goal':
      return 'a goal must be a non-empty text'
    case 'invalid_request':
      return 'a change request must be a non-empty text'
    case 'duplicate_request':
      return `project ${refusal.workspaceId} already recorded exactly this change request at version ${String(refusal.version)}: nothing was recorded`
    case 'goal_unchanged':
      return `the goal of project ${refusal.workspaceId} already reads exactly this at version ${String(refusal.version)}: nothing was recorded`
    case 'duplicate_name':
      return `the name "${refusal.name}" is already taken`
    case 'template_not_found':
      return `no template with id ${refusal.templateId}`
    case 'capability_not_found':
      return `there is no capability "${refusal.key}" in the taxonomy: add it with \`capabilities add\` first`
    case 'invalid_capability':
      return `that capability cannot be added: ${refusal.detail}`
    case 'runbook_adoption_unavailable':
      return `runbook ${refusal.runbookId} cannot be adopted yet: nothing in the control layer adopts a runbook`
    case 'company_not_found':
      return `no company with id ${refusal.companyId}`
    case 'company_team_not_found':
      return `no company team with id ${refusal.companyTeamId}`
    case 'company_slave_not_found':
      return `no catalog slave with id ${refusal.companySlaveId}`
    case 'invalid_name':
      return 'a name must be a non-empty text'
    case 'invalid_model':
      return 'a model must be a non-empty text'
    case 'invalid_budget':
      return 'a budget must be a non-negative amount or absent'
    case 'model_without_provider':
      return 'a model must name the provider that runs it'
    case 'invalid_provider':
      return 'a provider must be a configured kind'
    case 'unmeasurable_budget':
      return 'a budget needs a provider that reports cost'
    case 'company_already_assigned':
      return `this workspace is already run by ${refusal.companyName}`
    case 'slave_not_found':
      return `no slave with id ${refusal.slaveId}`
    case 'invalid_role':
      return 'a role must be a non-empty text'
    case 'slave_run_active':
      return `slave ${refusal.slaveId} has a live run (${refusal.runId}); change its role when the run has ended`
    case 'team_not_found':
      return `no team with id ${refusal.teamId}`
    case 'team_workspace_mismatch':
      return `department ${refusal.teamId} belongs to another project than slave ${refusal.slaveId}`
    case 'company_mismatch':
      return `department template ${refusal.companyTeamId} belongs to another company than catalog slave ${refusal.companySlaveId}`
    case 'skill_not_found':
      return `no skill with id ${refusal.skillId}`
    case 'invalid_tool':
      return 'a permission must name one of the six tools'
    case 'invalid_permission_mode':
      return 'a permission must be allow or deny'
    case 'repo_path_not_absolute':
      return `the repository path must be absolute: ${refusal.path}`
    case 'repo_not_found':
      return `no directory at ${refusal.path}`
    case 'not_a_git_repository':
      return `${refusal.path} is not a git work tree`
    case 'base_branch_not_found':
      return `branch ${refusal.branch} does not exist in ${refusal.path}`
    case 'verify_commands_empty':
      return 'at least one verify command is required: a workspace with none can never reach done'
    case 'task_not_terminal':
      return (
        `task ${refusal.taskId} is ${refusal.status}; only a done, failed or cancelled task's ` +
        'worktree can be collected'
      )
    case 'run_still_alive':
      return `run ${refusal.runId} of task ${refusal.taskId} is still alive`
    case 'nothing_to_collect':
      return `task ${refusal.taskId} has no worktree to collect`
    case 'worktree_remove_failed':
      return `could not remove the worktree at ${refusal.path}: ${refusal.reason}`
    case 'invalid_username':
      return 'a username is 2–32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit'
    case 'weak_password':
      return `a password must be at least ${refusal.minimum} characters`
    case 'user_not_found':
      return `no user named ${refusal.username}`
    case 'simulation_not_found':
      return `no simulation with id ${refusal.simulationId}`
    case 'unsupported_simulation':
      return `a ${refusal.sector} company cannot run in ${refusal.mode} mode yet; supported: ${Object.keys(sectors).join(', ')} + simulation`
    case 'simulation_not_runnable':
      return `simulation ${refusal.simulationId} is ${refusal.status}; it cannot be stepped`
    case 'stale_version':
      return `simulation ${refusal.simulationId} moved on (version ${refusal.actual}, you saw ${refusal.expected}): reload and retry`
    case 'simulation_corrupt':
      return `simulation ${refusal.simulationId} cannot be read: ${refusal.reason}`
    case 'live_simulations':
      return `company ${refusal.companyId} has ${plural(refusal.simulations, 'simulation')}; delete them first`
    case 'invalid_simulation_input':
      return `invalid simulation input: ${refusal.detail}`
    case 'llm_steps_in_daemon':
      return `simulation ${refusal.simulationId} makes its decisions with a model; its steps happen in the daemon — start auto-run`
    case 'unsupported_model_provider':
      return `model provider ${refusal.provider} is not supported for simulations: ${refusal.reason}`
    case 'not_adoptable':
      return `simulation ${refusal.simulationId} cannot be adopted: ${refusal.reason}`
    case 'invalid_recipient':
      return `invalid recipient: ${refusal.detail}`
    case 'invalid_message_body':
      return 'a message body must be a non-empty text'
    case 'message_not_found':
      return `no message with id ${refusal.messageId}`
    case 'not_message_recipient':
      return `message ${refusal.messageId} is not addressed to slave ${refusal.slaveId}`
    case 'not_a_question':
      return `message ${refusal.messageId} is a ${refusal.messageKind}, not a question: there is nobody waiting on an answer to it`
    case 'message_not_question':
      return `message ${refusal.messageId} is not a question: there is nothing to re-address`
    case 'question_answered':
      return `question ${refusal.messageId} is no longer waiting on an answer`
    case 'reassign_not_permitted':
      return `question ${refusal.messageId} cannot be re-addressed to slave ${refusal.slaveId}: ${refusal.reason}`
    case 'draft_missing':
      return `supervisor decision ${refusal.decisionId} carries no drafted answer to send`
    case 'profile_too_long':
      return `a profile may be at most ${String(refusal.limit)} characters; this one is ${String(refusal.length)}`
    case 'invalid_runtime_roles':
      return `invalid runtime roles: ${refusal.reason}`
    case 'decision_not_found':
      return `no supervisor decision with id ${refusal.decisionId}`
    case 'decision_not_pending':
      return `supervisor decision ${refusal.decisionId} is ${refusal.status}, not pending: there is nothing left to approve or reject`
    case 'supervisor_cooldown':
      return `the supervisor has already decided ${refusal.situationKind} for ${refusal.subjectId}; the next decision on it can be made after ${refusal.untilTs}`
    case 'supervisor_disabled':
      return `the supervisor is switched off for project ${refusal.workspaceId}`
    case 'task_not_failable':
      return `task ${refusal.taskId} is ${refusal.status}: only a task in rework or blocked can be failed`
    case 'task_not_cancellable':
      return `task ${refusal.taskId} is ${refusal.status}: only a task in backlog, ready or blocked can be cancelled`
    case 'catalog_empty':
      return `no persona was found under ${refusal.directory}: nothing was imported`
    case 'profile_not_structured':
      return `template ${refusal.templateId} has no structured profile to customise: import its catalog first, or edit its profile as Markdown`
    case 'invalid_profile_overrides':
      return `these profile changes cannot be stored: ${refusal.detail}`
    case 'unknown_profile_field':
      return `"${refusal.field}" is not a profile field`
    case 'invalid_role_map':
      return `--role-map is unusable: ${refusal.detail}`
  }
}
