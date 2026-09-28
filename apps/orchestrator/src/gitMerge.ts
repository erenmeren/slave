import { err, ok, type Result } from '@slave-of-ai/domain'
import { gitIn } from './worktree.js'

/**
 * Whether the person's primary checkout may be merged into: on `baseBranch`, nothing uncommitted.
 *
 * The primary checkout is shared with the person, so merging onto anything other than a clean base
 * branch would land work somewhere no one asked for, or lose someone's uncommitted state. One rule
 * for every merge that touches it -- a task's (merge pass, planned delivery) and a goal version's
 * (goal pass) -- so the two can never disagree about when the person's checkout is theirs.
 */
export async function primaryCheckoutReady(repoPath: string, baseBranch: string): Promise<boolean> {
  const current = await gitIn(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD')
  const status = await gitIn(repoPath, 'status', '--porcelain')
  return current === baseBranch && status === ''
}

/**
 * `git merge <args>` in `cwd`; a merge git refuses is aborted before this returns, so the checkout
 * is never left mid-merge (a half-done merge refuses every later one, and in the primary checkout it
 * is the person's tree). The error is git's own message, cut to what an event payload carries.
 */
export async function mergeOrAbort(cwd: string, args: readonly string[]): Promise<Result<void, string>> {
  try {
    await gitIn(cwd, 'merge', ...args)
    return ok(undefined)
  } catch (error) {
    await gitIn(cwd, 'merge', '--abort').catch(() => {})
    return err((error instanceof Error ? error.message : String(error)).slice(0, 2000))
  }
}
