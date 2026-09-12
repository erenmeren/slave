import { mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RunId } from '@slave-of-ai/domain'

/**
 * Where the run's own files live: **outside the repository entirely** (M52 R4).
 *
 * Until this milestone this was `<repoPath>/.slaveofai/runs/<runId>` -- inside the tree the worker
 * edits. `scripts/lib/permissions.sh` recorded the consequence in its own header: "A run that
 * deletes its own permissions file disarms the matrix for its remaining tool calls." Under
 * default-deny that stops being a hole and becomes a bypass of everything, so the directory moves
 * somewhere a worker cannot see: `$SLAVEOFAI_STATE_DIR`, else `$XDG_STATE_HOME/slaveofai`, else
 * `~/.local/state/slaveofai`, then `runs/<runId>`, created 0700.
 *
 * The pause flag, the permissions file, the tool-results tap and the broker channel all move with
 * it -- every one of them is derived from `runDir` by a single helper, and none of them was ever a
 * path a caller spelled itself.
 *
 * `repoPath` stays a parameter and its `statSync` preflight stays: every caller has it,
 * `signalPause` (`pause.ts`) re-derives this same path from the same two values, and a run whose
 * repository is missing or is not a directory is a broken run whether or not its scratch directory
 * lives there. The check is now an assertion about the RUN rather than about where the directory
 * goes, and its own two tests (`paths.test.ts`) are unchanged -- which is a signal rather than a
 * convenience: the check did not change meaning, only the directory moved.
 *
 * What did NOT move, and must not be claimed to have (plan erratum E4): `<repo>/.slaveofai/worktrees`
 * (`apps/orchestrator/src/worktree.ts`) and `<repo>/.slaveofai/artifacts` (`verify.ts`, `merge.ts`).
 * A worktree is the worker's workspace and an artifact is a log a person downloads through
 * `/api/w/:id/tasks/:id/artifacts/:id`; neither is a verdict about the worker.
 *
 * A run in flight across the upgrade keeps its ORIGINAL directory and needs no migration: both
 * adapters re-derive `runDir` from `dirname(checkpoint.pauseFlagPath)`, which is an absolute path
 * recorded when the run started.
 *
 * `runDir` is this function's whole contribution: an empty, already-created scratch directory,
 * unique per run. What a provider adapter writes inside it -- a settings file, a hook script,
 * anything else -- is that adapter's own business (M12's Decision of Record #1: no caller outside
 * `packages/providers` may know that a provider has a settings file, a hook script, or a flag
 * file).
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
  const stateDir = process.env['SLAVEOFAI_STATE_DIR']
  const xdgStateHome = process.env['XDG_STATE_HOME']
  const stateRoot =
    stateDir !== undefined && stateDir !== ''
      ? stateDir
      : xdgStateHome !== undefined && xdgStateHome !== ''
        ? join(xdgStateHome, 'slaveofai')
        : join(homedir(), '.local', 'state', 'slaveofai')
  const dir = join(stateRoot, 'runs', runId)
  try {
    // 0700 on the whole chain: a run directory holds the verdict that governs a worker, and this
    // machine may have other accounts on it. It does NOT protect a run from a SIBLING run under the
    // same uid -- that is what the token on the verdict is for, and why no plaintext token is ever
    // written into this directory.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new Error(`runFilePaths: cannot create run dir ${dir}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { runDir: dir, pauseFlagPath: join(dir, 'pause.flag') }
}
