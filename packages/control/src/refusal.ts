/**
 * Why a control operation (`requestPause`, `requestStop`, and — Task 4 — resume) declined to act.
 *
 * `workspace_halted` and `no_checkpoint` are defined here now, ahead of Task 4's resume logic that
 * will produce them, so the taxonomy is whole from the start rather than grown one refusal at a
 * time across tasks that each own a slice of it. `unmeasurable_budget` follows the same
 * convention: it is defined here (M12 Task 7) ahead of the budget admission logic (Task 9) that
 * will actually raise it.
 */
import {
  ATTACHMENT_KIND_BY_EXTENSION,
  BROKER_REFUSAL_LABEL,
  EXTERNAL_SOURCE_LABEL,
  WORKSPACE_LIMIT_RULE,
  type BrokerRefusalReason,
  type ExternalSource,
  type WorkspaceLimitField,
} from '@slave-of-ai/domain'
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
  /**
   * H8 (fix round 1, I1): `requestResume` on a workspace whose budget is spent. The same halt the
   * tick refuses a resume under (`HALTS_THAT_REFUSE_A_RESUME`), applied at the verb -- so a CLI or
   * web resume into an empty purse is refused where the person can read why, rather than recorded
   * and carried out by whichever tick next finds the budget raised. `detail` is the guardrail's
   * own sentence ("Spent $21 of $20."). Its sibling in that set, `emergency_stop`, is refused as
   * `workspace_halted` above: the durable column is what that breach is derived from.
   */
  | { readonly kind: 'budget_exhausted'; readonly workspaceId: string; readonly detail: string }
  /** `requestPause` claimed the run but `signalPause` threw; the claim was rolled back (M13 §3.4). */
  | { readonly kind: 'pause_unsignalled'; readonly runId: string; readonly reason: string }
  /**
   * M51 R3: `steerRun`/`constrainRun` were asked about a run that is not `working`. Steering a
   * paused, stopping or concluded run would queue a sentence nobody will ever read, and the
   * ladder would then believe it had spoken.
   */
  | { readonly kind: 'run_not_steerable'; readonly runId: string; readonly status: string }
  /**
   * M51 R3: `deliverBreakerSteer` was asked to resume a run the breaker never armed -- one the
   * breaker has not touched, one a person paused, or one whose steer has already been asked for.
   * A per-tick pass calls this speculatively, so this is an ordinary answer, not a fault.
   */
  | { readonly kind: 'breaker_not_armed'; readonly runId: string }
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
  /**
   * E R3: `retryTask` on a task that is not `failed`. The mirror of `task_not_blocked` for the
   * other terminal park: `unblockTask` is the exit from `blocked` and this is the exit from
   * `failed`, and neither verb touches the status the other one is for.
   */
  | { readonly kind: 'task_not_failed'; readonly taskId: string; readonly status: string }
  /**
   * E R3: `retryTask` on a task the Supervisor has already put back `RETRIES_MAX` times. Counted on
   * `Task.retries`, NOT on `Task.attempt` -- the retry resets the attempts, and the whole point of
   * the second counter is that "we have tried remedies twice" survives that reset. The third time
   * the finding is that the remedies are not working, and `escalate_to_human` is what the rules
   * offer instead (`candidates.ts`).
   */
  | { readonly kind: 'retry_ceiling_reached'; readonly taskId: string; readonly retries: number; readonly limit: number }
  /**
   * E R4: `clear_halt` inside `HALT_CLEAR_INTERVAL_MS` of the last clear -- whoever made it, the
   * Supervisor or an operator's own `clear-halt`, since both write the same stamp.
   *
   * Checked here as well as in `candidates.ts` (which does not OFFER the action inside the window)
   * because a proposal can be approved by a person an hour after it was made: the offer and the
   * apply are two moments, and the bound is on the apply.
   */
  | { readonly kind: 'halt_recently_cleared'; readonly workspaceId: string; readonly clearedAt: string }
  /**
   * H4a: `retry_planning` on a goal version whose planning cap has already been given back once.
   *
   * Checked here as well as in `candidates.ts` (which does not OFFER the action once the version
   * has a reset) for `halt_recently_cleared`'s exact reason: a proposal can be approved by a person
   * long after it was made, the offer and the apply are two moments, and the bound is on the apply.
   * Both read the same events, so the two cannot disagree.
   */
  | { readonly kind: 'planning_already_reset'; readonly workspaceId: string; readonly version: number }
  /**
   * Final review, Important 2: the grant a `retry_task` carries names an operation a plan may not
   * ask for. `TASK_NEEDS` is the bound -- `network_fetch` and `run_commands`, the two a plan can
   * know about in advance -- and `writePermissionsFile` has held the dispatch to it since Task 5.
   * The retry's grant is the OTHER door into the same room and was held to nothing but the six
   * kinds, so a decision row naming `read_secret` or `deploy_release` would have granted it.
   */
  | { readonly kind: 'invalid_task_need'; readonly permissionKind: string }
  /**
   * Final review, Important 2: `request_permission` on a worker an operator has explicitly
   * REFUSED this operation. A stored `deny` row is a person's own decision, and the Supervisor
   * points at walls rather than removing the ones somebody put up on purpose.
   *
   * The mirror of what `retryTask` does with the same fact, and the difference is what the two
   * verbs are for: a retry has work to get moving and goes out without its grant, while this
   * action IS the grant and has nothing left to do.
   */
  | { readonly kind: 'permission_denied_by_operator'; readonly slaveId: string; readonly permissionKind: string }
  /**
   * Final review, Important 4: `clear_halt` on a workspace whose stored halt is not the breaker's.
   * R4 says budget halts are never cleared by the Supervisor and erratum E11 says the same of an
   * emergency stop -- the money is gone, or a person has their hand on the switch.
   *
   * `candidates.ts` reads the reason off the situation and offers the action for `circuit_breaker`
   * alone; this reads the WORKSPACE at apply time, because a proposal can be approved long after
   * the situation it was made on, and a person may have hit the stop in between.
   */
  | { readonly kind: 'halt_not_breaker'; readonly workspaceId: string; readonly reason: string }
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
  /** M53 R9: a staffing preference that names neither a profile nor a model is a preference for
   *  nothing. 409 by `refusalStatus`'s suffix rule, which is right: the project exists and the
   *  capability exists, and the request does not make sense against them.
   *
   *  Carries the CAPABILITY and not the offered input (plan decision D18): the refusal is about the
   *  shape of the decision, the capability is what a person needs in order to fix it, and putting a
   *  `templateId` or a `model` in the payload would put a value in a sentence about their absence. */
  | { readonly kind: 'invalid_staffing_preference'; readonly capability: string }
  /** M48 R5: `adopt-runbook`, `runbooks show` and the routes all address a runbook by KEY. */
  | { readonly kind: 'runbook_not_found'; readonly key: string }
  /** M48 R5: the file `runbooks add --file` was handed is not a runbook -- a bad key, a missing
   *  name, or a stage list `parseRunbookStages` refused, whose own sentence is the detail. */
  | { readonly kind: 'invalid_runbook'; readonly detail: string }
  /** M48 final wave (Task 4 ruling): an approved `adopt_runbook` proposal reached a project that
   *  already follows a DIFFERENT runbook. Both keys, because the only useful sentence names what
   *  was proposed and what the project actually follows. */
  | { readonly kind: 'runbook_already_adopted'; readonly adopted: string; readonly proposed: string }
  /** M49 R4: every memory verb addresses a row by id, and this is the one that is not there. */
  | { readonly kind: 'memory_not_found'; readonly memoryId: string }
  /** M49 R4: a draft or an edit that cannot become a memory -- no target or two, a blank title or
   *  body, one over the cap, or a removal with no reason. */
  | { readonly kind: 'invalid_memory'; readonly detail: string }
  /** M49 R4: a superseded or removed memory is history, and history does not change. `status` is
   *  named because "it is frozen" without saying which of the two happened is not actionable. */
  | { readonly kind: 'memory_not_editable'; readonly memoryId: string; readonly status: string }
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
  /** M27 §5 raised this for a `companySlaveId` no `CompanySlave` row carried. M58 dropped that
   *  table, and this is what `carryOut` refuses a stored `materialise_company_worker` with when the
   *  action names its subject by the pre-M58 field (spec erratum E9): the roster row it names is
   *  gone and there is nothing left to resolve it to. */
  | { readonly kind: 'company_slave_not_found'; readonly companySlaveId: string }
  /** A name that is blank, or -- with `detail` -- one that has a SHAPE to meet and does not
   *  (M52 R3: a credential's `envVar` is an environment variable name, not free text). The default
   *  sentence stays exactly what the nine callers before it said; `detail` REPLACES it, so a verb
   *  with a rule of its own can state the rule rather than leave an operator guessing at it. */
  | { readonly kind: 'invalid_name'; readonly detail?: string }
  /** A model that is blank, or -- with `detail` -- one that has a SHAPE to meet and does not
   *  (M53 R9: a staffing preference names a model that is stored and read back months later, so
   *  "it is not empty" is not enough of a check to put a person's decision behind). `invalid_name`'s
   *  own precedent one line above, for the same reason and with the same rule: the default sentence
   *  stays exactly what the three callers before it said, and `detail` REPLACES it so a verb with a
   *  rule of its own states the rule rather than telling an operator that `gpt 4o` is empty. */
  | { readonly kind: 'invalid_model'; readonly detail?: string }
  /** A budget was set to something that is neither a non-negative number nor `null` (M13 §6.1). */
  | { readonly kind: 'invalid_budget' }
  /** H9 F8: a dispatch limit set outside `WORKSPACE_LIMIT_BOUNDS`, or to something that is not a
   *  whole number (of minutes, for the timeout). `field` names which, so the sentence can say the
   *  rule for that one limit -- the domain's own text, the one the Runtime panel shows before it
   *  sends anything. */
  | { readonly kind: 'invalid_limit'; readonly field: WorkspaceLimitField }
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
  /** `releaseWorker` (M50 R3): the worker is not `ephemeral`, and only a specialist brought in for
   *  ONE assignment is released. A project worker leaves by `deleteSlave` (M23) and a roster worker
   *  by leaving the roster; neither is this verb's business. 409, not 404: the worker is right
   *  there and the answer is about what it IS. */
  | { readonly kind: 'not_ephemeral'; readonly slaveId: string; readonly lifecycle: string }
  /** `releaseWorker` (M50 R3): this engagement is already over. Nothing is released twice -- the row
   *  keeps the timestamp and the sentence the first release wrote. */
  | { readonly kind: 'already_released'; readonly slaveId: string; readonly at: string }
  /** `setLifecycle` (M50 R4): `permanent` MEANS "is in a department of a company" (M58 R5), and
   *  this person belongs to none. A label a person could apply anyway would make the word a
   *  decoration. */
  | { readonly kind: 'not_in_roster'; readonly personId: string }
  /** M58 R14: `assignPerson` was asked to open a seat this person already holds on this team. Not
   *  an error a caller must avoid -- a re-assign is an ordinary double click -- but a refusal
   *  rather than a silent no-op, because the caller asked for a seat and none was opened. */
  | { readonly kind: 'already_assigned'; readonly personId: string; readonly teamId: string }
  /** M58 R14: a released person takes no new seat. Their engagement is over; un-retiring somebody
   *  is `set-lifecycle`, deliberately a separate act. */
  | { readonly kind: 'person_released'; readonly personId: string; readonly at: string }
  /** M58 R14: the ONE refusal `deletePerson` and `unassignPerson` have -- a run is going. Distinct
   *  from `live_runs`, which counts runs against one workspace/team/slave: this one names the
   *  PERSON and the run, because the person may be running on a project the caller is not looking
   *  at, and that is exactly the surprise the sentence has to prevent. */
  | { readonly kind: 'run_in_progress'; readonly personId: string; readonly runId: string }
  /** M58 R14: `Person.name` is unique across the installation -- it is the name every project sees,
   *  so two people cannot share it the way two workers on two projects once could. */
  | { readonly kind: 'person_name_taken'; readonly name: string }
  /** M58 (plan addition, see the pre-flight notes): every person verb takes a `personId` and needs
   *  a not-found of its own. `slave_not_found` names a SEAT and cannot stand in. */
  | { readonly kind: 'person_not_found'; readonly personId: string }
  /** M58 (plan addition): `unassignPerson`/`movePerson` were asked about a seat that is not open. */
  | { readonly kind: 'person_not_seated'; readonly personId: string; readonly teamId: string }
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
  /** A permission kind outside `PERMISSION_KINDS` (M14 §5.7; M52 R1 moved the vocabulary).
   *  The kind's NAME and its payload FIELD both stay `tool` (plan erratum E11) -- renaming a
   *  refusal costs three homes to rename a word no surface prints; only its sentence moved. */
  | { readonly kind: 'invalid_tool'; readonly tool: string }
  /** A permission mode that is neither `allow` nor `deny`. */
  | { readonly kind: 'invalid_permission_mode'; readonly mode: string }
  /** `createWorkspace`'s `repoPath` was not an absolute path (M23 A1, spec §2 A1). */
  | { readonly kind: 'repo_path_not_absolute'; readonly path: string }
  /** M59 R3: `setInstallationSettings` was handed a relative repositories folder. Distinct from
   *  `repo_path_not_absolute`, which is about ONE project's repository -- this is the folder every
   *  future one is created under, and naming the wrong thing would send a person to the wrong
   *  field. */
  | { readonly kind: 'invalid_repos_root'; readonly path: string }
  /** M59 R5: no `Intake` row with this id. Its `_not_found` suffix is what `refusalStatus` maps to
   *  404 -- derived from the name, never from a list (`apps/web/src/server/refusalStatus.ts`). */
  | { readonly kind: 'intake_not_found'; readonly intakeId: string }
  /** M59 R6: a message arrived for a conversation that is not waiting for one -- most often a
   *  second message sent while the first is still unanswered. */
  | { readonly kind: 'intake_not_open'; readonly intakeId: string; readonly status: string }
  /** M59 R5: `abandonIntake` on a conversation that is creating a project or has created one.
   *  Distinct from `intake_not_open` because the answer is different: one says wait, the other
   *  says there is a project now and abandoning the conversation would not remove it. */
  | { readonly kind: 'intake_not_abandonable'; readonly intakeId: string; readonly status: string }
  /** M59 R10: a second accept while the first is still running. */
  | { readonly kind: 'intake_busy'; readonly intakeId: string }
  /** M59 R10: accept on a conversation that already created its project. */
  | { readonly kind: 'intake_already_created'; readonly intakeId: string; readonly workspaceId: string }
  /** M59 R12: the conversation has used its `INTAKE_MAX_MODEL_CALLS` turns. Not an error about the
   *  person and the sentence says so -- the form is still there, pre-filled. */
  | { readonly kind: 'intake_budget_exhausted'; readonly intakeId: string; readonly calls: number }
  /** M59 R6: a blank message, or one past `INTAKE_MESSAGE_MAX_CHARS`. Supervisor chat R1 reuses it
   *  for a chat message past `CHAT_MESSAGE_MAX_CHARS` and for a blank note for the planner: it is
   *  the same fact about the same kind of input, and a new kind would cost three homes to say it. */
  | { readonly kind: 'invalid_message'; readonly reason: string }
  /**
   * Supervisor chat R6: the four ways a set of attachments is refused, decided BEFORE anything is
   * written so a request with one bad file writes none of them.
   *
   * `attachment_path_refused` is the name that is a PATH rather than a name. It is a refusal and
   * never a rename, which is the whole of the decision: a person whose upload was refused can
   * rename it, and a person whose upload was silently renamed cannot tell it happened.
   */
  | { readonly kind: 'too_many_attachments'; readonly limit: number; readonly count: number }
  | { readonly kind: 'attachment_too_large'; readonly name: string; readonly bytes: number; readonly limit: number }
  | { readonly kind: 'attachment_kind_not_allowed'; readonly name: string; readonly extension: string }
  | { readonly kind: 'attachment_path_refused'; readonly name: string }
  /** Supervisor chat R2: a reply was recorded against a turn that is not waiting for one -- a TTL
   *  reclaim that raced the call still in flight, or a second record of a settled turn. Nothing is
   *  written; the row keeps the reply it already has. */
  | { readonly kind: 'message_not_answering'; readonly messageId: string; readonly status: string }
  /** Supervisor chat R3/R6: the files were validated and the repository would not take them -- a
   *  disk that is full, a `git commit` that failed, a checkout somebody is holding. `reason` is the
   *  error's own message, because there is nothing this system can say about it that is truer. The
   *  files may be on disk and uncommitted when this is returned; `git status` is where they are. */
  | { readonly kind: 'inbox_write_failed'; readonly path: string; readonly reason: string }
  /** M59 R8/R10: the edited draft does not parse, or claims something the facts do not support. */
  | { readonly kind: 'invalid_draft'; readonly detail: string }
  /** M59 R7: `initRepository`'s parent directory does not exist. It creates ONE directory, never a
   *  tree of them: a typo in a path should not silently build the typo. */
  | { readonly kind: 'parent_not_found'; readonly path: string }
  /** M59 R7: the path exists and is not an empty directory. */
  | { readonly kind: 'path_not_empty'; readonly path: string }
  /** M59 R7: the path is inside another git work tree. A repository inside a repository is a
   *  mistake, and one this system would then provision worktrees in. */
  | { readonly kind: 'inside_repository'; readonly path: string }
  /** M59 R7: `git init`, the README write or the first commit failed. The reason is git's own. */
  | { readonly kind: 'repo_init_failed'; readonly path: string; readonly reason: string }
  /** M59 R10 (fix round 1): a step of `acceptIntake` THREW instead of returning a refusal -- a
   *  dropped connection, any exception the step's own `Result` type does not carry. Caught so the
   *  intake still lands in `failed` (resumable, abandonable) rather than stranded in `creating`
   *  forever. `step` names where it happened; `reason` is the caught error's own message. */
  | { readonly kind: 'accept_step_failed'; readonly step: string; readonly reason: string }
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
  /** M55 R8: the directory has no LICENSE file at its root, so nothing can record where its
   *  personas came from. A STATE, not a missing id -- 409 by `refusalStatus`'s suffix rule, which is
   *  the right answer: the catalog is there and readable, and what is absent is a fact about it. */
  | { readonly kind: 'license_unknown'; readonly directory: string }
  /** M55 R5, plan erratum E5: a `TemplateDuplicate` id nobody wrote. `template_not_found` would name
   *  the wrong noun and tell an operator a TEMPLATE is missing when a PAIR is, and answering `ok`
   *  for a row that does not exist is the pretending `{ changed }` exists to avoid. */
  | { readonly kind: 'template_duplicate_not_found'; readonly pairId: string }
  /** A `--role-map` entry with an empty half. Refused rather than dropped: silently discarding part
   *  of what an operator typed is how a template ends up dispatchable as something nobody meant --
   *  `normaliseRoles`' own reasoning. */
  | { readonly kind: 'invalid_role_map'; readonly detail: string }
  /**
   * M52 R3 (plan erratum E5): ONE kind carrying the broker's seven reasons, not seven kinds.
   *
   * The reasons are already a closed vocabulary in the `broker.refused` payload
   * (`BROKER_REFUSAL_REASONS`, `@slave-of-ai/domain`); spelling the same list again as union members
   * would be two lists to keep in step, and two of the names (`permission_denied`, `simulation`)
   * would sit ambiguously beside the union's existing `invalid_provider` / `unsupported_simulation`.
   *
   * 409 by `refusalStatus`'s suffix rule, which is right for all seven: the run exists and the
   * request does not make sense against it.
   */
  | { readonly kind: 'broker_refused'; readonly op: string; readonly reason: BrokerRefusalReason }
  /** M52 R3: `bindBrokerOp` named a credential this project does not have. 404 by the `_not_found`
   *  suffix rule -- and a credential in ANOTHER project reads back the same as "does not exist"
   *  from a scoped caller's side of the boundary (`message_not_found`'s rule). */
  | { readonly kind: 'credential_not_found'; readonly name: string }
  /** M54 R11: `triggers unmap` named a repository this project has no mapping for -- including one
   *  mapped to ANOTHER project, which reads back the same as "does not exist" from a scoped caller's
   *  side of the boundary (`message_not_found`'s rule). 404 by `refusalStatus`'s suffix rule.
   *
   *  Carries the SOURCE and the REPOSITORY and not the mapping's id: those two are what an operator
   *  typed and what they can retype, and the id is a uuid nobody has. */
  | { readonly kind: 'external_repository_not_found'; readonly source: ExternalSource; readonly repository: string }
  /** M54 R11: `triggers map` named a repository something already maps -- this project or another.
   *  409: both exist and the request does not make sense against them. `workspaceId` is carried
   *  because "already mapped" without saying WHERE leaves an operator with nothing to do next; the
   *  CLI resolves it to a NAME and prints that, which is that surface's own boundary. `refusalText`
   *  below never prints the id itself -- see the case there for why. */
  | {
      readonly kind: 'external_repository_mapped'
      readonly source: ExternalSource
      readonly repository: string
      readonly workspaceId: string
    }
  /**
   * Catalog Person Pool (Task 2): `selectPoolPerson` was asked for a template that does not exist
   * or is not active, or found none of that template's managed people free -- every one is
   * released, or every one already holds an open seat on the target workspace. One `kind` for all
   * three, the `broker_refused` precedent (M52 R3 erratum E5): the caller is choosing among a
   * template's managed pool and "there is nobody in it right now" is one fact regardless of which
   * of those made it true, and `templateId` is what an operator acts on -- `template activate`,
   * `person sync-pool`, or `person show` on whoever already holds the seats.
   */
  | { readonly kind: 'pool_unavailable'; readonly templateId: string }

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
    case 'budget_exhausted':
      return `this project has spent its budget (${refusal.detail}); nothing resumes until the budget is raised`
    case 'pause_unsignalled':
      return `the pause could not be signalled to run ${refusal.runId}: ${refusal.reason}`
    case 'run_not_steerable':
      return `run ${refusal.runId} is ${refusal.status}; only a working run can be steered or constrained`
    case 'breaker_not_armed':
      return `run ${refusal.runId} has no breaker steer waiting to be delivered`
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
    case 'task_not_failed':
      return `task ${refusal.taskId} is ${refusal.status}; only a failed task can be retried`
    case 'retry_ceiling_reached':
      return (
        `task ${refusal.taskId} has already been retried ${String(refusal.retries)} times ` +
        `(the limit is ${String(refusal.limit)}); two remedies that did not work is the finding, not a reason ` +
        `for a third. Take it from here by hand, or fail it with: fail-task --task ${refusal.taskId}`
      )
    case 'halt_recently_cleared':
      return (
        `this project's halt was already cleared at ${refusal.clearedAt}; it is cleared at most once an hour, ` +
        'so a second runaway inside that hour is a person’s call'
      )
    case 'planning_already_reset':
      return (
        `planning for this project's current goal (v${String(refusal.version)}) has already been given its ` +
        'attempts back once; a second time is a person’s call, because the limit exists to stop a planner ' +
        'being asked the same thing for ever'
      )
    case 'invalid_task_need':
      return (
        `a retry may not grant ‘${refusal.permissionKind}’: a remedy grants only what a plan can ask ` +
        'for on a task’s behalf (reading the web, running commands). Everything else is a decision about a ' +
        'worker, and a person makes it'
      )
    case 'permission_denied_by_operator':
      return (
        `worker ${refusal.slaveId} has been explicitly refused ‘${refusal.permissionKind}’ by a person; ` +
        'the Supervisor does not overturn that. Change the row in the worker’s permissions first if the ' +
        'refusal no longer stands'
      )
    case 'halt_not_breaker':
      return (
        `this project is halted by ${refusal.reason}, not by the circuit breaker; only a breaker halt is ` +
        'retracted without a person -- a spent budget is money and an emergency stop is somebody’s hand on ' +
        'the switch'
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
    case 'invalid_staffing_preference':
      return `a staffing preference for ${refusal.capability} must name a profile, a model, or both`
    case 'memory_not_found':
      return `no memory with id ${refusal.memoryId}`
    case 'invalid_memory':
      return `that cannot be written as a memory: ${refusal.detail}`
    case 'memory_not_editable':
      return `memory ${refusal.memoryId} is ${refusal.status} and nothing changes it; correct the one that replaced it instead`
    case 'runbook_not_found':
      return `there is no runbook "${refusal.key}": \`runbooks list\` shows the ones there are`
    case 'invalid_runbook':
      return `that runbook cannot be written: ${refusal.detail}`
    case 'runbook_already_adopted':
      return `this project already follows "${refusal.adopted}", so the proposal to adopt "${refusal.proposed}" was not carried out`
    case 'company_not_found':
      return `no company with id ${refusal.companyId}`
    case 'company_team_not_found':
      return `no company team with id ${refusal.companyTeamId}`
    case 'company_slave_not_found':
      return `no catalog slave with id ${refusal.companySlaveId}`
    case 'invalid_name':
      return refusal.detail ?? 'a name must be a non-empty text'
    case 'invalid_model':
      return refusal.detail ?? 'a model must be a non-empty text'
    case 'invalid_budget':
      return 'a budget must be a non-negative amount or absent'
    case 'invalid_limit':
      return WORKSPACE_LIMIT_RULE[refusal.field]
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
    case 'not_ephemeral':
      return `slave ${refusal.slaveId} is a ${refusal.lifecycle} worker, not a specialist brought in for one assignment; only an ephemeral worker is released`
    case 'already_released':
      return `slave ${refusal.slaveId} was already released at ${refusal.at}`
    case 'not_in_roster':
      return `slave ${refusal.personId} is in no company department, so they cannot be made permanent; put them in one first`
    case 'already_assigned':
      return `that slave already has a seat on this project; there is nothing to open`
    case 'person_released':
      return `that slave was released on ${refusal.at} and takes no new seat; put them back on a lifecycle first with: set-lifecycle --person ${refusal.personId} --lifecycle project`
    case 'run_in_progress':
      return `that slave has a run in progress (${refusal.runId}) on one of their projects; wait for it to finish or stop it first`
    case 'person_name_taken':
      return `the name "${refusal.name}" belongs to another slave; a slave's name is theirs across every project`
    case 'person_not_found':
      return `no slave with id ${refusal.personId}`
    case 'person_not_seated':
      return `that slave holds no open seat on this project`
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
      return 'a permission must name one of the six operations'
    case 'invalid_permission_mode':
      return 'a permission must be allow or deny'
    case 'repo_path_not_absolute':
      return `the repository path must be absolute: ${refusal.path}`
    case 'invalid_repos_root':
      return `the repositories folder must be an absolute path: ${refusal.path}`
    case 'intake_not_found':
      return `no conversation with id ${refusal.intakeId}`
    case 'intake_not_open':
      return `this conversation is ${refusal.status}; wait for the reply before sending another message`
    case 'intake_not_abandonable':
      return `this conversation is ${refusal.status} and cannot be abandoned; the project it created stays either way`
    case 'intake_busy':
      return 'this conversation is already creating its project; wait for it to finish'
    case 'intake_already_created':
      return `this conversation already created project ${refusal.workspaceId}`
    case 'intake_budget_exhausted':
      return `this conversation has used its ${plural(refusal.calls, 'model call')}; finish it on the form instead`
    case 'invalid_message':
      return refusal.reason
    case 'too_many_attachments':
      return `at most ${plural(refusal.limit, 'file')} can be attached to one message; this request had ${String(refusal.count)}`
    case 'attachment_too_large':
      return (
        `${refusal.name} is ${String(refusal.bytes)} bytes; an attachment may be at most ` +
        `${String(refusal.limit)}. Put it in the repository and name its path instead`
      )
    case 'attachment_kind_not_allowed':
      // The LIST, not the one extension: a person told "exe is not allowed" has to guess what is,
      // and the answer is short enough to print.
      return (
        `${refusal.name} is a ${refusal.extension === '' ? 'file with no extension' : `.${refusal.extension} file`}, ` +
        `which cannot be attached. These can be: ${Object.keys(ATTACHMENT_KIND_BY_EXTENSION).join(', ')}`
      )
    case 'attachment_path_refused':
      return `"${refusal.name}" is a path rather than a file name; rename it and attach it again`
    case 'message_not_answering':
      return `this turn is ${refusal.status}, not waiting for a reply; nothing was recorded`
    case 'inbox_write_failed':
      return `${refusal.path} could not be written to the repository: ${refusal.reason}`
    case 'invalid_draft':
      return `these project details cannot be used: ${refusal.detail}`
    case 'parent_not_found':
      return `${refusal.path}'s parent folder does not exist; create it first or name a different path`
    case 'path_not_empty':
      return `${refusal.path} already has something in it`
    case 'inside_repository':
      return `${refusal.path} is inside a git repository already`
    case 'repo_init_failed':
      return `the repository at ${refusal.path} could not be created: ${refusal.reason}`
    case 'accept_step_failed':
      return `creating this project failed at ${refusal.step}: ${refusal.reason}`
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
    case 'license_unknown':
      return (
        `${refusal.directory} has no LICENSE file at its root, so nothing can record where its personas came from: ` +
        'pass --allow-unknown-license to import it anyway'
      )
    case 'template_duplicate_not_found':
      return `no duplicate pair with id ${refusal.pairId}`
    case 'profile_not_structured':
      return `template ${refusal.templateId} has no structured profile to customise: import its catalog first, or edit its profile as Markdown`
    case 'invalid_profile_overrides':
      return `these profile changes cannot be stored: ${refusal.detail}`
    case 'unknown_profile_field':
      return `"${refusal.field}" is not a profile field`
    case 'invalid_role_map':
      return `--role-map is unusable: ${refusal.detail}`
    case 'broker_refused':
      // The reason's own sentence, from the domain's table rather than a second copy of it here,
      // with the op beside it -- an operator reading one CLI line needs to know WHICH verb was
      // refused. Lower-cased to join the house sentence style; none of the seven labels carries a
      // proper noun.
      return `${refusal.op}: ${BROKER_REFUSAL_LABEL[refusal.reason].toLowerCase()}`
    case 'credential_not_found':
      return `there is no credential "${refusal.name}" in this project: add it with \`credential add\` first`
    case 'external_repository_not_found':
      // The LABEL, never the key (`docs/ia.md` rule 3): this sentence is printed by the CLI and
      // returned by a route, and `github` is not a word.
      return `this project has no ${EXTERNAL_SOURCE_LABEL[refusal.source]} mapping for "${refusal.repository}"`
    case 'external_repository_mapped':
      // The refusal CARRIES `workspaceId` and this sentence deliberately does not PRINT it: a uuid is
      // not a word a person can act on, and `triggers map` (M54 Task 4) resolves it to the project's
      // NAME before it prints its own line -- which is what makes the union's doc comment above true.
      // This is the generic fallback every other surface reads, and it says the two things that are
      // true without a second read: something already holds this mapping, and unmapping it where it
      // lives is the way out.
      return (
        `${refusal.repository} on ${EXTERNAL_SOURCE_LABEL[refusal.source]} is already mapped to a project; ` +
        `unmap it there first with: triggers unmap --source ${refusal.source} --repository ${refusal.repository}`
      )
    case 'pool_unavailable':
      return (
        `template ${refusal.templateId} has nobody free in its pool: it may be inactive, every managed ` +
        'person may be released, or every one may already hold a seat on this project'
      )
  }
}
