/**
 * Why a control operation (`requestPause`, `requestStop`, and — Task 4 — resume) declined to act.
 *
 * `workspace_halted` and `no_checkpoint` are defined here now, ahead of Task 4's resume logic that
 * will produce them, so the taxonomy is whole from the start rather than grown one refusal at a
 * time across tasks that each own a slice of it. `unmeasurable_budget` follows the same
 * convention: it is defined here (M12 Task 7) ahead of the budget admission logic (Task 9) that
 * will actually raise it.
 */
export type ControlRefusal =
  | { readonly kind: 'run_not_found'; readonly runId: string }
  | {
      readonly kind: 'wrong_status'
      readonly runId: string
      readonly status: string
      readonly needed: readonly string[]
    }
  | { readonly kind: 'workspace_halted'; readonly workspaceId: string; readonly reason: string }
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
  | { readonly kind: 'self_dependency'; readonly taskId: string }
  | { readonly kind: 'duplicate_dependency'; readonly taskId: string; readonly dependsOnTaskId: string }
  | { readonly kind: 'cross_workspace'; readonly taskId: string; readonly dependsOnTaskId: string }
  | { readonly kind: 'dependency_not_found'; readonly taskId: string; readonly dependsOnTaskId: string }
  | { readonly kind: 'dependency_cycle'; readonly taskId: string; readonly dependsOnTaskId: string }
  | { readonly kind: 'workspace_not_found'; readonly workspaceId: string }
  | { readonly kind: 'invalid_goal' }
  | { readonly kind: 'duplicate_name'; readonly name: string }
  | { readonly kind: 'template_not_found'; readonly templateId: string }
  | { readonly kind: 'company_not_found'; readonly companyId: string }
  | { readonly kind: 'company_team_not_found'; readonly companyTeamId: string }
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
   * `setSlaveRole` on an slave that holds a run in a `NON_TERMINAL_RUN_STATUSES` status (M23 D1):
   * the scheduler matches `Task.requiredRole` to `Slave.role` by equality, so re-rolling an slave
   * mid-run would silently strand its dispatch decision.
   */
  | { readonly kind: 'slave_run_active'; readonly slaveId: string; readonly runId: string }
  /** `deleteSlave` on an slave that has any `SlaveRun` history at all (M23 D1) -- terminal or
   *  not: the row is kept as the anchor for its own past runs rather than cascade-deleting them. */
  | { readonly kind: 'slave_has_runs'; readonly slaveId: string; readonly runs: number }
  /** `renameTeam`/`deleteTeam` on a `teamId` no `Team` row carries (M23 D1). */
  | { readonly kind: 'team_not_found'; readonly teamId: string }
  /** `deleteTeam` on a team that still has slaves on its roster (M23 D1). */
  | { readonly kind: 'team_not_empty'; readonly teamId: string; readonly slaves: number }
  /** `moveSlave`'s target department belongs to another project than the slave (M25 §3.1). */
  | { readonly kind: 'team_workspace_mismatch'; readonly slaveId: string; readonly teamId: string }
  /** `moveCompanySlave`'s target department template belongs to another company than the catalog
   *  slave (M25 §3.1). */
  | { readonly kind: 'company_mismatch'; readonly companySlaveId: string; readonly companyTeamId: string }
  /** `deleteCompanyTeam` on a department template that still has catalog slaves on its roster
   *  (M25 §3.1) -- the template counterpart of `team_not_empty`. */
  | { readonly kind: 'company_team_not_empty'; readonly companyTeamId: string; readonly slaves: number }
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
    case 'self_dependency':
      return `task ${refusal.taskId} cannot depend on itself`
    case 'duplicate_dependency':
      return `task ${refusal.taskId} already depends on ${refusal.dependsOnTaskId}`
    case 'cross_workspace':
      return `task ${refusal.taskId} and ${refusal.dependsOnTaskId} are in different workspaces`
    case 'dependency_not_found':
      return `task ${refusal.taskId} does not depend on ${refusal.dependsOnTaskId}`
    case 'dependency_cycle':
      return `adding this dependency would create a cycle: ${refusal.dependsOnTaskId} already depends on ${refusal.taskId}`
    case 'workspace_not_found':
      return `no workspace with id ${refusal.workspaceId}`
    case 'invalid_goal':
      return 'a goal must be a non-empty text'
    case 'duplicate_name':
      return `the name "${refusal.name}" is already taken`
    case 'template_not_found':
      return `no template with id ${refusal.templateId}`
    case 'company_not_found':
      return `no company with id ${refusal.companyId}`
    case 'company_team_not_found':
      return `no company team with id ${refusal.companyTeamId}`
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
    case 'slave_has_runs':
      return `slave ${refusal.slaveId} has ${refusal.runs} run(s) in history and stays (rename it or leave it idle)`
    case 'team_not_found':
      return `no team with id ${refusal.teamId}`
    case 'team_not_empty':
      return `team ${refusal.teamId} still has ${refusal.slaves} slave(s)`
    case 'team_workspace_mismatch':
      return `department ${refusal.teamId} belongs to another project than slave ${refusal.slaveId}`
    case 'company_mismatch':
      return `department template ${refusal.companyTeamId} belongs to another company than catalog slave ${refusal.companySlaveId}`
    case 'company_team_not_empty':
      return `department template ${refusal.companyTeamId} still has ${refusal.slaves} member(s); move them first`
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
  }
}
