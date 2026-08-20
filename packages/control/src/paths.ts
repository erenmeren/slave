import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RunId } from '@ai-team-os/domain'

/**
 * Where the run's own files live: **outside** the worktree, under the repository's `.aiteamos`.
 *
 * The settings file must be registered by absolute path (ADR 0001 §3) and the pause flag must be
 * unique per run (spec §5.2) — but neither may sit inside the worktree, because Task 14 runs verify
 * there and Task 11 already found `.aiteamos/` showing up as untracked content. A settings file in
 * the worktree makes every verify see a dirty tree it did not create.
 */
export function runFilePaths(repoPath: string, runId: RunId): { settingsPath: string; pauseFlagPath: string } {
  const dir = join(repoPath, '.aiteamos', 'runs', runId)
  mkdirSync(dir, { recursive: true })
  return { settingsPath: join(dir, 'settings.json'), pauseFlagPath: join(dir, 'pause.flag') }
}
