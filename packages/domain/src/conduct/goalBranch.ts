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

/**
 * What a person does when an accepted goal version waits for them to merge it (base moved, a merge
 * git refused, `autoMerge` off): one wording, so the goal pass's waits and the Supervisor's
 * `goal_needs_human` escalation (ruling V6) cannot drift apart. The version is verified; the person
 * resolving the base-branch side is a recorded human decision (`goal_merged { by: 'human' }`).
 */
/**
 * `verifiedCommit` (final wave I2): the commit the version's passing verification checked. When it
 * is known the instruction names it rather than the branch -- a branch that moved after acceptance
 * carries commits nobody verified, and `confirm-goal-merge` refuses them. Null or absent for a
 * version accepted before verification existed (4a's wording).
 */
export function handMergeInstruction(
  integrationBranch: string,
  baseBranch: string,
  workspaceId: string,
  version: number,
  verifiedCommit?: string | null,
): string {
  const what = verifiedCommit === undefined || verifiedCommit === null ? integrationBranch : `${verifiedCommit.slice(0, 12)}, the verified tip of ${integrationBranch},`
  return `Merge ${what} into ${baseBranch} by hand, then run ` + `confirm-goal-merge --workspace ${workspaceId} --version ${String(version)}`
}
