import { gitIn } from './worktree.js'

/**
 * Cuts a conducted goal version's integration branch from the base branch (spec R9), or reuses it.
 *
 * Reuse is the crash case: the branch is cut BEFORE the materialisation transaction (git is not
 * transactional), so a daemon that died between the two finds its own branch on the next tick.
 * It is reused only while it carries nothing the base branch does not -- a branch of this name with
 * commits of its own is somebody else's, and building a goal version on it would ship them.
 */
export async function ensureIntegrationBranch(
  repoPath: string,
  baseBranch: string,
  branch: string,
): Promise<{ readonly baseCommit: string }> {
  const exists = await gitIn(repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`).then(
    () => true,
    () => false,
  )
  if (!exists) {
    await gitIn(repoPath, 'branch', branch, baseBranch)
  } else {
    const onBase = await gitIn(repoPath, 'merge-base', '--is-ancestor', branch, baseBranch).then(
      () => true,
      () => false,
    )
    if (!onBase) throw new Error(`integration branch ${branch} exists and is not on ${baseBranch}'s history`)
  }
  return { baseCommit: await gitIn(repoPath, 'rev-parse', branch) }
}
