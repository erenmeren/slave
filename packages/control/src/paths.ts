import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RunId } from '@ai-team-os/domain'

/**
 * Where the run's own files live: **outside** the worktree, under the repository's `.aiteamos`.
 *
 * The pause flag must be unique per run (spec §5.2), and whatever a provider adapter keeps for a
 * run (a settings file, a hook script, or anything else) must not sit inside the worktree either,
 * because Task 14 runs verify there and Task 11 already found `.aiteamos/` showing up as untracked
 * content. A run file in the worktree makes every verify see a dirty tree it did not create.
 *
 * `runDir` is this function's whole contribution: an empty, already-created scratch directory,
 * unique per run. What a provider adapter writes inside it -- a settings file, a hook script,
 * anything else -- is that adapter's own business (M12's Decision of Record #1: no caller outside
 * `packages/providers` may know that a provider has a settings file, a hook script, or a flag
 * file). This function used to also hand back `settingsPath` directly; it no longer does, because
 * that would be exactly the knowledge Decision 1 forbids a caller here from having.
 */
export function runFilePaths(repoPath: string, runId: RunId): { runDir: string; pauseFlagPath: string } {
  const dir = join(repoPath, '.aiteamos', 'runs', runId)
  mkdirSync(dir, { recursive: true })
  return { runDir: dir, pauseFlagPath: join(dir, 'pause.flag') }
}
