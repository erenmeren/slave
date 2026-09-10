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
  pause_unsignalled: true,
  provider_cannot_resume: true,
  task_not_found: true,
  task_not_done: true,
  already_integrated: true,
  task_not_blocked: true,
  task_run_active: true,
  attempt_ceiling_reached: true,
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
  model_without_provider: true,
  invalid_provider: true,
  unmeasurable_budget: true,
  company_already_assigned: true,
  slave_not_found: true,
  invalid_role: true,
  slave_run_active: true,
  team_not_found: true,
  team_workspace_mismatch: true,
  company_mismatch: true,
  skill_not_found: true,
  invalid_tool: true,
  invalid_permission_mode: true,
  repo_path_not_absolute: true,
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
}

const ALL = Object.keys(ALL_KINDS) as ControlRefusal['kind'][]

/**
 * Pinned so a new `*_not_found` kind fails THIS list, not just slips through the suffix rule
 * silently -- the point is a human notices the taxonomy grew a not-found kind and reviews it,
 * even though `refusalStatus` itself would already map it to 404 correctly by suffix alone.
 */
const TODAYS_NOT_FOUND_KINDS = [
  'run_not_found',
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
  'decision_not_found',
  'capability_not_found',
] as const satisfies readonly ControlRefusal['kind'][]

describe('refusalStatus', () => {
  it('is 404 for exactly the eighteen kinds ending in _not_found today', () => {
    const bySuffix = ALL.filter((kind) => kind.endsWith('_not_found')).sort()
    expect(bySuffix).toEqual([...TODAYS_NOT_FOUND_KINDS].sort())
    expect(bySuffix).toHaveLength(18)
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
})
