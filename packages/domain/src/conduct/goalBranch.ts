/**
 * The integration branch of one conducted goal version (spec R9), and the path segment of the
 * worktree the merge pass keeps checked out on it. The workspace's first eight id characters are
 * part of the name (plan D1): a workspace re-created on the same repository starts again at goal v1,
 * and a bare `slaveofai/goal-v1` left by its predecessor would make every conduct refuse.
 */
export function integrationBranchName(version: number, workspaceId: string): string {
  return `slaveofai/${integrationWorktreeKey(version, workspaceId)}`
}

export function integrationWorktreeKey(version: number, workspaceId: string): string {
  if (!Number.isInteger(version) || version <= 0) throw new Error(`goal version must be a positive integer, got ${String(version)}`)
  return `goal-v${String(version)}-${workspaceId.slice(0, 8)}`
}
