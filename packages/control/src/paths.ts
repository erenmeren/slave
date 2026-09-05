import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RunId } from '@slave-of-ai/domain'

/**
 * Where the run's own files live: **outside** the worktree, under the repository's `.slaveofai`.
 *
 * The pause flag must be unique per run (spec §5.2), and whatever a provider adapter keeps for a
 * run (a settings file, a hook script, or anything else) must not sit inside the worktree either,
 * because Task 14 runs verify there and Task 11 already found `.slaveofai/` showing up as untracked
 * content. A run file in the worktree makes every verify see a dirty tree it did not create.
 *
 * `runDir` is this function's whole contribution: an empty, already-created scratch directory,
 * unique per run. What a provider adapter writes inside it -- a settings file, a hook script,
 * anything else -- is that adapter's own business (M12's Decision of Record #1: no caller outside
 * `packages/providers` may know that a provider has a settings file, a hook script, or a flag
 * file). This function used to also hand back `settingsPath` directly; it no longer does, because
 * that would be exactly the knowledge Decision 1 forbids a caller here from having.
 *
 * Preflight the root before the recursive mkdirSync: on this host a nonexistent parent under
 * a pseudo-filesystem (/proc was the recorded case — pause.test.ts) hangs recursive mkdirSync
 * FOREVER, with no error to catch. statSync answers immediately for the same inputs, so a bad
 * root becomes an actionable throw on the tick's hot path instead of a silent stall.
 */
export function runFilePaths(repoPath: string, runId: RunId): { runDir: string; pauseFlagPath: string } {
  let root
  try {
    root = statSync(repoPath)
  } catch (error) {
    throw new Error(`runFilePaths: cannot stat repo path ${repoPath} (run ${runId}): ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!root.isDirectory()) throw new Error(`runFilePaths: repo path is not a directory: ${repoPath} (run ${runId})`)
  const dir = join(repoPath, '.slaveofai', 'runs', runId)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw new Error(`runFilePaths: cannot create run dir ${dir}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { runDir: dir, pauseFlagPath: join(dir, 'pause.flag') }
}
