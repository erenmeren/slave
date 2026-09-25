import type { ControlRefusal } from '@slave-of-ai/control'
import { describe, expect, it } from 'vitest'
import { refusalStatus } from '../src/server/refusalStatus'

/**
 * `Record<ControlRefusal['kind'], true>` forces this object literal to carry every kind the
 * union has (M34 T1): TypeScript refuses to compile it with a kind missing, and refuses an extra
 * key that is not a kind. A sixteenth refusal kind therefore fails this file's typecheck, not
 * just its assertions, until it is added below.
 */
const ALL_KINDS: Record<ControlRefusal['kind'], true> = {
  run_not_found: true,
  wrong_status: true,
  workspace_halted: true,
  workspace_archived: true,
  already_archived: true,
  not_archived: true,
  live_runs: true,
  no_checkpoint: true,
  run_still_stopping: true,
  // H8 (fix round 1, I1): a resume into an empty purse. 409 by the suffix rule and right to be --
  // the run is there, and the request does not make sense until the budget is raised.
  budget_exhausted: true,
  pause_unsignalled: true,
  // M51 R3: the breaker's two. Neither ends in `_not_found`, so both answer 409 -- the run exists
  // and the request does not make sense against it, which is what the neighbouring run refusals
  // (`wrong_status`, `run_still_stopping`) already answer.
  run_not_steerable: true,
  breaker_not_armed: true,
  provider_cannot_resume: true,
  task_not_found: true,
  task_not_done: true,
  already_integrated: true,
  task_not_blocked: true,
  task_run_active: true,
  attempt_ceiling_reached: true,
  // E R3/R4: the three the self-running project added. None ends in `_not_found` -- the task or
  // the project exists and the request does not make sense against it -- so all three answer 409.
  task_not_failed: true,
  retry_ceiling_reached: true,
  halt_recently_cleared: true,
  // H4a: the second reset of one goal version. 409 by the suffix rule and right to be -- the
  // project is there, and asking for its planner's attempts back twice is what does not make
  // sense against what has already happened to it.
  planning_already_reset: true,
  // The final review's three, all 409 by the suffix rule and all right to be: the worker, the
  // task and the project are there, and the request does not make sense against what a person has
  // already decided about them (an operation a plan may not ask for, a `deny` somebody wrote, a
  // halt that is not the breaker's).
  invalid_task_need: true,
  permission_denied_by_operator: true,
  halt_not_breaker: true,
  self_dependency: true,
  duplicate_dependency: true,
  cross_workspace: true,
  dependency_not_found: true,
  dependency_cycle: true,
  workspace_not_found: true,
  invalid_goal: true,
  invalid_request: true,
  duplicate_request: true,
  goal_unchanged: true,
  duplicate_name: true,
  template_not_found: true,
  company_not_found: true,
  company_team_not_found: true,
  company_slave_not_found: true,
  invalid_name: true,
  invalid_model: true,
  invalid_budget: true,
  // H9 F8: a limit out of its bounds. Not `_not_found`, so 409 -- the project is there and the figure is not one it may hold.
  invalid_limit: true,
  model_without_provider: true,
  invalid_provider: true,
  unmeasurable_budget: true,
  company_already_assigned: true,
  slave_not_found: true,
  not_ephemeral: true,
  already_released: true,
  not_in_roster: true,
  invalid_role: true,
  slave_run_active: true,
  team_not_found: true,
  team_workspace_mismatch: true,
  company_mismatch: true,
  skill_not_found: true,
  invalid_tool: true,
  invalid_permission_mode: true,
  repo_path_not_absolute: true,
  // M59 R3: `setInstallationSettings`'s own kind. 409 by the suffix rule -- the installation is
  // there, the request just names a path that cannot be the repositories folder.
  invalid_repos_root: true,
  // M59 Task 4: the intake verbs' kinds and `initRepository`'s. `intake_not_found` and
  // `parent_not_found` answer 404 by the suffix rule and join the not-found list below; the rest
  // are 409 -- a conversation or a path that is there, in a state the request does not make sense
  // against.
  intake_not_found: true,
  intake_not_open: true,
  intake_not_abandonable: true,
  intake_busy: true,
  intake_already_created: true,
  intake_budget_exhausted: true,
  invalid_message: true,
  // Supervisor chat R6: the five an ATTACHMENT can be refused by. None ends in `_not_found` and
  // none should: the project and its repository are both there, and each says the request itself
  // cannot be carried out as written -- too many files, one too large, an extension nothing here
  // can read, a name that is a path, or a repository that would not take the commit. 409 each.
  too_many_attachments: true,
  attachment_too_large: true,
  attachment_kind_not_allowed: true,
  attachment_path_refused: true,
  inbox_write_failed: true,
  // Supervisor chat R2: the turn exists and is not waiting for a reply. 409, like every other
  // "the row is in the wrong state" kind.
  message_not_answering: true,
  invalid_draft: true,
  parent_not_found: true,
  path_not_empty: true,
  inside_repository: true,
  repo_init_failed: true,
  // M59 Task 4 fix round 1: a step of `acceptIntake` threw rather than returning a refusal. 409 by
  // the default rule -- the intake is there, in a state (now `failed`) the request does not fit.
  accept_step_failed: true,
  repo_not_found: true,
  not_a_git_repository: true,
  base_branch_not_found: true,
  verify_commands_empty: true,
  task_not_terminal: true,
  run_still_alive: true,
  nothing_to_collect: true,
  worktree_remove_failed: true,
  invalid_username: true,
  weak_password: true,
  user_not_found: true,
  simulation_not_found: true,
  unsupported_simulation: true,
  simulation_not_runnable: true,
  stale_version: true,
  simulation_corrupt: true,
  live_simulations: true,
  invalid_simulation_input: true,
  llm_steps_in_daemon: true,
  unsupported_model_provider: true,
  not_adoptable: true,
  invalid_recipient: true,
  invalid_message_body: true,
  message_not_found: true,
  not_message_recipient: true,
  not_a_question: true,
  message_not_question: true,
  question_answered: true,
  reassign_not_permitted: true,
  draft_missing: true,
  profile_too_long: true,
  invalid_runtime_roles: true,
  decision_not_found: true,
  decision_not_pending: true,
  supervisor_cooldown: true,
  supervisor_disabled: true,
  task_not_failable: true,
  task_not_cancellable: true,
  catalog_empty: true,
  invalid_role_map: true,
  profile_not_structured: true,
  invalid_profile_overrides: true,
  unknown_profile_field: true,
  capability_not_found: true,
  invalid_capability: true,
  // M53 R9: the staffing preference's own kind. 409 by the suffix rule, and that is the right
  // answer: the project is there and the capability is there, and a preference that names neither a
  // profile nor a model is a request that does not make sense against them.
  invalid_staffing_preference: true,
  runbook_not_found: true,
  invalid_runbook: true,
  runbook_already_adopted: true,
  memory_not_found: true,
  invalid_memory: true,
  memory_not_editable: true,
  // M52 R3 (plan erratum E5): the broker's two. `credential_not_found` answers 404 by the suffix
  // rule -- the project has no credential by that name, and a credential in another project reads
  // back the same. `broker_refused` answers 409: it carries all seven refusal reasons, and every one
  // of them is "the request does not make sense against what is here", never "this is not a thing".
  broker_refused: true,
  credential_not_found: true,
  // M54 R11: the operator's two, on the MAPPING verbs. Authentication is not here and never will be
  // -- `verifyHookDelivery` answers a `HookRefusalReason`, because `refusalStatus` maps `*_not_found`
  // to 404 and a `hook_not_found` refusal would answer a stranger the one question R1 exists to leave
  // unanswered.
  external_repository_not_found: true,
  external_repository_mapped: true,
  // M55 R8/R5 (plan erratum E5): the milestone's two. `license_unknown` answers 409 by the suffix
  // rule, which is right -- an unlicensed checkout is a STATE, not a missing id.
  // `template_duplicate_not_found` answers 404, and joins the not-found list below.
  license_unknown: true,
  template_duplicate_not_found: true,
  // M58 R14 (plan additions): the six person kinds. `person_not_found` joins the not-found list
  // below; the other five are ordinary 409s -- the person exists and the request does not make
  // sense against them (a seat that is already open, a release, a run, a taken name, a seat that
  // is not open).
  already_assigned: true,
  person_released: true,
  run_in_progress: true,
  person_name_taken: true,
  person_not_found: true,
  person_not_seated: true,
  // Catalog Person Pool Task 2: `selectPoolPerson`'s own kind, for a missing/inactive template
  // OR an exhausted pool -- one `kind` for all three, the `broker_refused` precedent
  // (`packages/control/src/refusal.ts`'s own docstring on it). It does not end in `_not_found`
  // even though a missing template is one of the three facts it can mean: the OTHER two (every
  // managed person released, or every one already seated on this workspace) are not "missing"
  // at all, and `refusalStatus` has exactly one kind per REQUEST OUTCOME, not per underlying
  // cause. 409 answers all three alike -- the id in hand (`templateId`) names something the
  // caller can act on (`template activate`, `person sync-pool`), never a stranger.
  pool_unavailable: true,
}

const ALL = Object.keys(ALL_KINDS) as ControlRefusal['kind'][]

/**
 * Pinned so a new `*_not_found` kind fails THIS list, not just slips through the suffix rule
 * silently -- the point is a human notices the taxonomy grew a not-found kind and reviews it,
 * even though `refusalStatus` itself would already map it to 404 correctly by suffix alone.
 */
const TODAYS_NOT_FOUND_KINDS = [
  'run_not_found',
  'intake_not_found',
  'task_not_found',
  'dependency_not_found',
  'workspace_not_found',
  'template_not_found',
  'company_not_found',
  'company_team_not_found',
  'company_slave_not_found',
  'slave_not_found',
  'team_not_found',
  'skill_not_found',
  'repo_not_found',
  'base_branch_not_found',
  'user_not_found',
  'simulation_not_found',
  'message_not_found',
  'parent_not_found',
  'decision_not_found',
  'capability_not_found',
  'runbook_not_found',
  'memory_not_found',
  'credential_not_found',
  'external_repository_not_found',
  'template_duplicate_not_found',
  'person_not_found',
] as const satisfies readonly ControlRefusal['kind'][]

describe('refusalStatus', () => {
  it('is 404 for exactly the twenty-six kinds ending in _not_found today', () => {
    const bySuffix = ALL.filter((kind) => kind.endsWith('_not_found')).sort()
    expect(bySuffix).toEqual([...TODAYS_NOT_FOUND_KINDS].sort())
    expect(bySuffix).toHaveLength(26)
  })

  it('maps every kind in the taxonomy to 404 iff it ends in _not_found, 409 otherwise', () => {
    for (const kind of ALL) {
      expect(refusalStatus(kind)).toBe(kind.endsWith('_not_found') ? 404 : 409)
    }
  })

  // M46 (plan erratum E17): the profile-override verbs' three kinds, spelled out because the
  // routes that serve them (`PATCH …/overrides`, `DELETE …/overrides/:field`) also answer 404 for
  // a missing template -- so the pair "the template exists, the request does not make sense" has
  // to read 409 here, not 404, or a drawer would tell an operator the template is gone.
  it('answers 409 for the three profile-override refusals, whose templates were found', () => {
    for (const kind of ['profile_not_structured', 'invalid_profile_overrides', 'unknown_profile_field'] as const) {
      expect(ALL_KINDS[kind]).toBe(true)
      expect(refusalStatus(kind)).toBe(409)
    }
    expect(refusalStatus('template_not_found')).toBe(404)
  })

  // Catalog Person Pool Task 2: `pool_unavailable` answers 409 like `broker_refused` -- the
  // precedent its own docstring names -- and NOT 404, even though a missing template is one of
  // the three facts it can carry. Spelled out rather than left to the generic suffix loop above,
  // the same way the profile-override trio above is: a reviewer should not have to re-derive
  // "does this one deserve 404" from the suffix rule alone for a kind whose name could plausibly
  // read either way.
  it('answers 409 for pool_unavailable, the same as broker_refused, never 404', () => {
    expect(refusalStatus('pool_unavailable')).toBe(409)
    expect(refusalStatus('pool_unavailable')).toBe(refusalStatus('broker_refused'))
  })
})
