/**
 * Why a control operation (`requestPause`, `requestStop`, and — Task 4 — resume) declined to act.
 *
 * `workspace_halted` and `no_checkpoint` are defined here now, ahead of Task 4's resume logic that
 * will produce them, so the taxonomy is whole from the start rather than grown one refusal at a
 * time across tasks that each own a slice of it.
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
  | { readonly kind: 'task_not_found'; readonly taskId: string }
  | { readonly kind: 'self_dependency'; readonly taskId: string }
  | { readonly kind: 'duplicate_dependency'; readonly taskId: string; readonly dependsOnTaskId: string }
  | { readonly kind: 'cross_workspace'; readonly taskId: string; readonly dependsOnTaskId: string }
  | { readonly kind: 'dependency_not_found'; readonly taskId: string; readonly dependsOnTaskId: string }
  | { readonly kind: 'dependency_cycle'; readonly taskId: string; readonly dependsOnTaskId: string }
  | { readonly kind: 'workspace_not_found'; readonly workspaceId: string }
  | { readonly kind: 'invalid_goal' }

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
  }
}
